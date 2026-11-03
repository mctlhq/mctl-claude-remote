// The CLI as the orchestrator runs it: a separate process per command.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Bridge, newId } from "../src/store.ts";
import type { Result } from "../src/store.ts";
import { ValkeyServer, requiresValkey } from "./support.ts";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
let server: ValkeyServer;

function cli(args: string[], input?: string): { code: number; out: any } {
  const r = spawnSync(process.execPath, ["run", "--silent", "--no-env-file", CLI, ...args], {
    env: { ...process.env, MCTL_BRIDGE_VALKEY_URL: server.url },
    input,
    encoding: "utf8",
  });
  return { code: r.status ?? -1, out: JSON.parse(r.stdout.trim().split("\n").at(-1)!) };
}

function must(r: Result): Record<string, any> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Record<string, any>;
}

describe.skipIf(requiresValkey)("mctl-bridge CLI", () => {
  beforeAll(async () => {
    server = await ValkeyServer.start();
  });
  afterAll(async () => {
    await server.stop();
  });

  test("a question goes from wait to claim to reply, and a refusal exits 1", async () => {
    expect(cli(["init"])).toMatchObject({ code: 0, out: { ok: true, durability: { status: "weak" } } });
    const b = new Bridge(server.client());
    const reg = must(await b.register({ slot: "a", uuid: "u", conn_id: "k", pid: 1, pid_start: "s", cwd: "/w" }));
    const c = { slot: "a", conn_id: "k", epoch: reg.epoch };
    must(await b.heartbeat(c, false));

    const sent = cli(["send", "--slot", "a", "--text", "-"], "fix the build");
    expect(sent.code).toBe(0);
    const next = must(await b.next(c));
    expect(next.payload).toBe("fix the build");
    must(await b.emitted(c, next.id));
    const ack = must(await b.ackTask(c, next.id, next.attempt_id));
    const q = must(await b.ask("a", ack.admission, "which branch?"));

    const waited = cli(["wait", "--timeout", "1"]);
    expect(waited.out.questions.map((x: any) => x.id)).toEqual([q.question_id]);
    expect(waited.out.events.map((e: any) => e.event)).toContain("asked");
    // the cursor moved: the same events are not returned twice
    expect(cli(["wait", "--timeout", "0"]).out.events).toEqual([]);

    const claim = cli(["claim", q.question_id]);
    expect(claim.code).toBe(0);
    expect(cli(["claim", q.question_id])).toMatchObject({ code: 1, out: { ok: false, code: "claimed" } });
    expect(cli(["wait", "--timeout", "0"]).out.questions).toEqual([]);
    expect(cli(["reply", q.question_id, "--token", claim.out.claim_token, "--text", "main"]).code).toBe(0);
    expect(cli(["status", q.question_id]).out.message.state).toBe("reply_committed");
  });

  test("errors lists delivery_unknown with its reason and late evidence", async () => {
    const b = new Bridge(server.client());
    const reg = must(await b.register({ slot: "e", uuid: "u", conn_id: "k1", pid: 7, pid_start: "s", cwd: "/w" }));
    const c = { slot: "e", conn_id: "k1", epoch: reg.epoch };
    must(await b.heartbeat(c, false));
    const sent = must(await b.send({ slot: "e", payload: "x" }));
    const next = must(await b.next(c));
    must(await b.emitted(c, sent.id));
    const ack = must(await b.ackTask(c, sent.id, next.attempt_id));
    must(await b.register({ slot: "e", uuid: "u2", conn_id: newId("k"), pid: 7, pid_start: "s", cwd: "/w" }));
    await b.result("e", ack.admission, "completed", "done anyway");
    const errors = cli(["errors"]).out;
    expect(errors.unknown.find((m: any) => m.id === sent.id)).toMatchObject({ state: "delivery_unknown", reason: "epoch_changed" });
    expect(errors.late[sent.id][0]).toMatchObject({ kind: "result", reason: "fenced", payload: "done anyway" });
    expect(cli(["resolve", sent.id, "--as", "completed", "--reason", "late result shows it ran", "--author", "op"]).code).toBe(0);
    expect(cli(["status", sent.id]).out.message.state).toBe("completed");
  });

  test("a wake_unknown shows in errors and wakes, and resolve closes it", async () => {
    const b = new Bridge(server.client());
    const reg = must(await b.register({ slot: "w", uuid: "u", conn_id: "kw", pid: 9, pid_start: "s", cwd: "/w" }));
    const c = { slot: "w", conn_id: "kw", epoch: reg.epoch };
    must(await b.heartbeat(c, false));
    const sent = must(await b.send({ slot: "w", payload: "x" }));
    const next = must(await b.next(c));
    must(await b.emitted(c, sent.id));
    const ack = must(await b.ackTask(c, sent.id, next.attempt_id));
    const q = must(await b.ask("w", ack.admission, "which?"));
    const wake = must(await b.wakeBegin({ question_id: q.question_id, thread_id: "thread-cli", lock_ms: 60_000, per_hour: 10, quiet_ms: 0 }));
    must(await b.wakeFinish(wake.wake_id, "wake_unknown", "history_matches_0"));
    expect(cli(["errors"]).out.wakes.find((w: any) => w.id === wake.wake_id)).toMatchObject({ state: "wake_unknown", reason: "history_matches_0" });
    expect(cli(["wakes"]).out.wakes.map((w: any) => w.id)).toContain(wake.wake_id);
    expect(cli(["resolve", wake.wake_id, "--author", "op"]).code).toBe(2); // a reason is required
    expect(cli(["resolve", wake.wake_id, "--reason", "no turn in the thread", "--author", "op"]).code).toBe(0);
    expect(cli(["wakes"]).out.wakes.map((w: any) => w.id)).not.toContain(wake.wake_id);
  });

  test("usage errors exit 2", () => {
    expect(cli(["send"]).code).toBe(2);
    expect(cli(["nope"]).code).toBe(2);
  });
});
