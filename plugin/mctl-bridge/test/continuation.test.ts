// Continuing a slot after a planned restart (see "Continuing a slot after a planned
// restart" in ops/orchestrator-AGENTS.md): one idempotent `continue` task, a new
// attempt, and an old admission that can never be used again.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Bridge, newId } from "../src/store.ts";
import type { Admission, Result, SlotConn } from "../src/store.ts";
import { ValkeyServer, requiresValkey } from "./support.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "src", "cli.ts");
const AGENTS = path.join(HERE, "..", "ops", "orchestrator-AGENTS.md");
let server: ValkeyServer;
let b: Bridge;

function cli(args: string[]): { code: number; out: any } {
  const r = spawnSync(process.execPath, ["run", "--silent", "--no-env-file", CLI, ...args], {
    env: { ...process.env, MCTL_BRIDGE_VALKEY_URL: server.url },
    encoding: "utf8",
  });
  return { code: r.status ?? -1, out: JSON.parse(r.stdout.trim().split("\n").at(-1)!) };
}

function must(r: Result): Record<string, any> {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Record<string, any>;
}

async function register(slot: string, pid: number): Promise<SlotConn & { uuid: string }> {
  const uuid = crypto.randomUUID();
  const conn_id = newId("k");
  const r = must(await b.register({ slot, uuid, conn_id, pid, pid_start: `s${pid}`, cwd: "/w" }));
  const c = { slot, conn_id, epoch: r.epoch as string, uuid };
  must(await b.heartbeat(c, false));
  return c;
}

async function admit(c: SlotConn, id: string, attempt: string): Promise<Admission> {
  must(await b.emitted(c, id));
  return must(await b.ackTask(c, id, attempt)).admission;
}

describe.skipIf(requiresValkey)("continuation after a planned restart", () => {
  beforeAll(async () => {
    server = await ValkeyServer.start();
  });
  afterAll(async () => {
    await server.stop();
  });
  beforeEach(async () => {
    await server.client().execute(["FLUSHALL"]);
    b = await server.bridge();
    await b.checkVersion();
  });

  test("two sends with the same --idem key make one task and put one message in the slot's queue", async () => {
    const c = await register("a", 100);
    const key = "continue-t-old-2";
    const first = cli(["send", "--slot", "a", "--idem", key, "--text", "continue the work"]);
    const second = cli(["send", "--slot", "a", "--idem", key, "--text", "continue the work"]);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(second.out.id).toBe(first.out.id);
    expect(second.out.dedup).toBe(true);
    const next = must(await b.next(c));
    expect(next.id).toBe(first.out.id);
    const att = await admit(c, next.id, next.attempt_id);
    must(await b.result("a", att, "completed", "done"));
    // nothing else was queued behind it
    expect(await b.next(c)).toMatchObject({ ok: false, code: "empty" });
  });

  test("a restart gives a new epoch and the old connection can neither ack nor report", async () => {
    // covered in depth by store.test.ts "an old epoch cannot emit, mark or ack" and "a late
    // result is recorded as evidence"; this pins the restart shape used by the continuation
    const old = await register("a", 100);
    const sent = must(await b.send({ slot: "a", payload: "x" }));
    const n = must(await b.next(old));
    const adm = await admit(old, sent.id, n.attempt_id);
    must(await b.unregister(old)); // the old claude process exited
    const fresh = await register("a", 200); // slot.sh start --resume
    expect(Number(fresh.epoch)).toBeGreaterThan(Number(old.epoch));
    expect(await b.ackTask(old, sent.id, n.attempt_id)).toMatchObject({ ok: false });
    expect(await b.result("a", adm, "completed", "late")).toMatchObject({ ok: false });
  });

  test("a task is not emitted while another one holds the slot, and goes out once it ends", async () => {
    const c = await register("a", 100);
    const first = must(await b.send({ slot: "a", payload: "one" }));
    const n1 = must(await b.next(c));
    const adm = await admit(c, first.id, n1.attempt_id);
    must(await b.heartbeat(c, false)); // idle by the hooks, but the task is still acked
    const second = must(await b.send({ slot: "a", payload: "two" }));
    expect((await b.next(c)).ok).toBe(false);
    expect((await b.message(second.id)).state).toBe("queued");
    must(await b.result("a", adm, "completed", "ok"));
    expect(must(await b.next(c)).id).toBe(second.id);
  });

  test("the old admission is refused after the restart and kept as late evidence; the new attempt works", async () => {
    const old = await register("a", 100);
    const t1 = must(await b.send({ slot: "a", payload: "original" }));
    const n1 = must(await b.next(old));
    const oldAdm = await admit(old, t1.id, n1.attempt_id);
    must(await b.unregister(old));
    const fresh = await register("a", 200);
    expect((await b.message(t1.id)).state).toBe("delivery_unknown");

    const t2 = must(await b.send({ slot: "a", payload: `Resume ${t1.id}`, idempotency_key: `continue-${t1.id}-${fresh.epoch}` }));
    expect(t2.id).not.toBe(t1.id);
    const n2 = must(await b.next(fresh));
    expect(n2.attempt_id).not.toBe(n1.attempt_id);

    // the resumed session still holds the old grant: every use of it is refused
    expect(await b.result("a", oldAdm, "completed", "from the old attempt")).toMatchObject({ ok: false, late: true });
    expect(await b.ask("a", oldAdm, "old question?")).toMatchObject({ ok: false });
    expect((await b.message(t1.id)).state).toBe("delivery_unknown");
    const late = await b.late(t1.id);
    expect(late.map((l) => l.kind).sort()).toEqual(["question", "result"]);
    for (const l of late) expect(l).toMatchObject({ attempt_id: n1.attempt_id, epoch: oldAdm.epoch, conn_id: oldAdm.conn_id });
    // old ids against the new task are refused too
    expect(await b.ackTask(fresh, t2.id, n1.attempt_id)).toMatchObject({ ok: false });
    expect((await b.message(t2.id)).state).toBe("emit_intent");

    const newAdm = await admit(fresh, t2.id, n2.attempt_id);
    must(await b.result("a", newAdm, "completed", "continued"));
    expect((await b.message(t2.id)).state).toBe("completed");
  });

  test("ops/orchestrator-AGENTS.md pins the continuation template and its key rules", () => {
    const md = fs.readFileSync(AGENTS, "utf8");
    const at = md.indexOf("## Continuing a slot after a planned restart");
    expect(at).toBeGreaterThan(0);
    const sec = md.slice(at).replace(/\s+/g, " ");
    const template =
      "Resume the previously interrupted task <ORIGINAL_TASK_ID> using the existing session context and local working tree. The previous execution attempt has been cancelled. Its admission grant is no longer valid. Treat this as a new execution attempt. Call ack_task for this new task and attempt before performing any work. Preserve existing commits and uncommitted changes. Do not repeat completed operations or reapply already committed changes. Inspect the current repository state with git status and git diff, identify unfinished work, and continue from the last verified checkpoint. Report the final result through MCTL Bridge with report_result.";
    expect(sec).toContain(template);
    for (const rule of [
      "The standing ban on resending tasks stays.",
      "Never run `slot.sh stop` or `slot.sh start`",
      "`mctl-bridge sessions` shows the slot with a NEW registration",
      "Send exactly ONE new task",
      "--idem continue-<old task id>-<new epoch>",
      "Never resend blind.",
      "The slot must call `ack_task` for the new attempt before any work.",
      "must never be used",
      "report to the operator. Do not start a new session and do not restart the slot.",
      "no GitHub push, merge, deploy or lifecycle actions",
    ])
      expect(sec).toContain(rule);
    // the interim publishing rule for slot PRs stays explicit until the handoff protocol exists
    expect(md.replace(/\s+/g, " ")).toContain("INTERIM: publishing the PR is done by the lead session until the handoff protocol in issue #127");
    // the marker line the orchestrator answers with is untouched
    expect(md).toContain("ORCH-AGENTS-BRIDGE-2026-11-04.");
  });
});
