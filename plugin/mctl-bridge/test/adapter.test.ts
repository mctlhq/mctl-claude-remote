// The slot adapter as Claude Code runs it: a spawned MCP server over stdio,
// driven by a fake client that also plays the hooks.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Bridge, key } from "../src/store.ts";
import type { Result } from "../src/store.ts";
import { FakeClaude, ValkeyServer, requiresValkey, sleep } from "./support.ts";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "state.py");

let server: ValkeyServer;
let b: Bridge;
let stateDir: string;
const clients: FakeClaude[] = [];

function must(r: Result): Record<string, any> {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Record<string, any>;
}

async function start(slot = "a", session = "s-1", o: { pid?: number } = {}): Promise<FakeClaude> {
  const c = new FakeClaude(server.url, slot, { stateDir, pid: o.pid });
  clients.push(c);
  c.hook("idle", session); // SessionStart
  const init = await c.handshake();
  expect(init.result.capabilities.experimental["claude/channel"]).toEqual({});
  await until(async () => (await b.slotInfo(slot)).uuid === session && (await b.slotInfo(slot)).busy === "0");
  return c;
}

async function until(cond: () => Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await sleep(20);
  }
}

describe.skipIf(requiresValkey)("slot adapter over MCP", () => {
  beforeAll(async () => {
    server = await ValkeyServer.start();
  });
  afterAll(async () => {
    await server.stop();
  });
  beforeEach(async () => {
    await server.client().execute(["FLUSHALL"]);
    b = await server.bridge();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-"));
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.kill();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test("acceptance: task, question, reply while in flight, result under the same attempt", async () => {
    const c = await start();
    const t1 = must(await b.send({ slot: "a", payload: "rename the module" }));
    const ev = await c.notification();
    expect(ev.params.meta).toMatchObject({ kind: "task", task_id: t1.id });
    expect(ev.params.content).toContain("rename the module");
    expect(ev.params.content).toContain("ack_task");
    const attempt = ev.params.meta.attempt_id;
    c.hook("busy", "s-1"); // UserPromptSubmit for the channel event

    const ack = await c.call("ack_task", { task_id: t1.id, attempt_id: attempt });
    expect(ack.isError).toBe(false);
    const t2 = must(await b.send({ slot: "a", payload: "unrelated second task" }));
    const asked = await c.call("ask_orchestrator", { task_id: t1.id, question: "keep the old name as an alias?" });
    expect(asked.isError).toBe(false);
    expect(asked.body.next).toContain("End your turn");
    c.hook("idle", "s-1"); // Stop: the turn ended after asking

    // The slot is idle with t1 in flight: the second task must wait.
    await c.noNotification(0.5);
    expect((await b.message(t2.id)).state).toBe("queued");

    const claim = must(await b.claim(asked.body.question_id));
    const rep = must(await b.reply(asked.body.question_id, claim.claim_token, "yes, for one release"));
    const replyEv = await c.notification();
    expect(replyEv.params.meta).toEqual({
      kind: "reply", question_id: asked.body.question_id, reply_id: rep.reply_id, task_id: t1.id, attempt_id: attempt,
    });
    expect(replyEv.params.content).toContain("yes, for one release");
    c.hook("busy", "s-1");
    expect((await c.call("ack_reply", { question_id: asked.body.question_id, reply_id: rep.reply_id })).isError).toBe(false);
    expect((await b.message(t2.id)).state).toBe("queued");

    const res = await c.call("report_result", { task_id: t1.id, status: "completed", summary: "renamed, alias kept" });
    expect(res.isError).toBe(false);
    expect(await b.message(t1.id)).toMatchObject({ state: "completed", attempt_id: attempt, result: "renamed, alias kept" });
    expect((await b.message(asked.body.question_id)).state).toBe("reply_acknowledged");
    c.hook("idle", "s-1");

    // only now does the second task go out
    const ev2 = await c.notification();
    expect(ev2.params.meta.task_id).toBe(t2.id);
  });

  test("nothing is emitted while the hooks say busy", async () => {
    const c = await start();
    c.hook("busy", "s-1");
    await until(async () => (await b.slotInfo("a")).busy === "1");
    const t = must(await b.send({ slot: "a", payload: "x" }));
    await c.noNotification(0.4);
    expect((await b.message(t.id)).state).toBe("queued");
    c.hook("idle", "s-1");
    expect((await c.notification()).params.meta.task_id).toBe(t.id);
  });

  test("after an emit the slot stays busy until the hooks report again", async () => {
    const c = await start();
    must(await b.send({ slot: "a", payload: "one" }));
    await c.notification();
    // no hook update yet: the reply-free second task must not follow at once
    // (inflight blocks it anyway); a reply to nothing cannot arrive; check the
    // adapter reports busy to the server
    await until(async () => (await b.slotInfo("a")).busy === "1");
  });

  test("/clear: an unacknowledged task becomes delivery_unknown and is never re-emitted", async () => {
    const c = await start();
    const t = must(await b.send({ slot: "a", payload: "x" }));
    await c.notification();
    c.hook("idle", "s-2"); // SessionStart source=clear: new session id, same process
    await until(async () => (await b.message(t.id)).state === "delivery_unknown");
    expect((await b.slotInfo("a")).uuid).toBe("s-2");
    await c.noNotification(0.4);
    const t2 = must(await b.send({ slot: "a", payload: "for the new context" }));
    expect((await c.notification()).params.meta.task_id).toBe(t2.id);
  });

  test("a result after /clear is refused and kept as late evidence", async () => {
    const c = await start();
    const t = must(await b.send({ slot: "a", payload: "x" }));
    const ev = await c.notification();
    c.hook("busy", "s-1");
    expect((await c.call("ack_task", { task_id: t.id, attempt_id: ev.params.meta.attempt_id })).isError).toBe(false);
    c.hook("idle", "s-2");
    await until(async () => (await b.slotInfo("a")).uuid === "s-2");
    const res = await c.call("report_result", { task_id: t.id, status: "completed", summary: "pushed anyway" });
    expect(res.isError).toBe(true);
    expect(res.body).toMatchObject({ ok: false, late: true });
    expect(await b.late(t.id)).toHaveLength(1);
    expect((await b.message(t.id)).state).toBe("delivery_unknown");
  });

  test("work without ack_task is refused", async () => {
    const c = await start();
    const t = must(await b.send({ slot: "a", payload: "x" }));
    await c.notification();
    const res = await c.call("report_result", { task_id: t.id, status: "completed", summary: "skipped the ack" });
    expect(res.isError).toBe(true);
    expect(String(res.body)).toContain("call ack_task first");
    expect((await c.call("ask_orchestrator", { task_id: t.id, question: "?" })).isError).toBe(true);
  });

  test("an adapter restart takes epoch + 1 and turns its emit into delivery_unknown", async () => {
    const c1 = await start();
    const epoch1 = (await b.slotInfo("a")).epoch;
    const t = must(await b.send({ slot: "a", payload: "x" }));
    await c1.notification();
    await c1.kill();
    const c2 = new FakeClaude(server.url, "a", { stateDir });
    clients.push(c2);
    await c2.handshake();
    await until(async () => (await b.slotInfo("a")).epoch === String(Number(epoch1) + 1));
    expect((await b.message(t.id)).state).toBe("delivery_unknown");
    await c2.noNotification(0.3);
  });

  test("closing stdin unregisters and releases what the slot held", async () => {
    const c = await start();
    const t = must(await b.send({ slot: "a", payload: "x" }));
    await c.notification();
    await c.close();
    expect(await b.slotInfo("a")).toMatchObject({ conn_id: "", inflight: "" });
    expect(await b.message(t.id)).toMatchObject({ state: "delivery_unknown", reason: "unregistered" });
  });

  test("a dropped Valkey connection keeps the registration, the task in flight and the queue", async () => {
    const c = await start();
    const epoch = (await b.slotInfo("a")).epoch;
    const t1 = must(await b.send({ slot: "a", payload: "long task" }));
    const ev = await c.notification();
    c.hook("busy", "s-1");
    expect((await c.call("ack_task", { task_id: t1.id, attempt_id: ev.params.meta.attempt_id })).isError).toBe(false);
    const t2 = must(await b.send({ slot: "a", payload: "queued behind it" }));
    const killer = server.client();
    for (let i = 0; i < 3; i++) {
      await killer.execute(["CLIENT", "KILL", "TYPE", "normal", "SKIPME", "yes"]);
      await sleep(60);
    }
    b = new Bridge(server.client()); // the test's own connection was killed too
    const killedAt = Date.now();
    await until(async () => c.stderr.join("").includes("tick failed"));
    // the adapter recovers on its own, on the same registration
    await until(async () => Number((await b.slotInfo("a")).heartbeat) > killedAt);
    expect((await b.slotInfo("a")).epoch).toBe(epoch);
    expect((await b.message(t1.id)).state).toBe("acked");
    expect((await b.message(t2.id)).state).toBe("queued");
    const res = await c.call("report_result", { task_id: t1.id, status: "completed", summary: "done across the blip" });
    expect(res.isError).toBe(false);
    expect(await b.message(t1.id)).toMatchObject({ state: "completed", attempt_id: ev.params.meta.attempt_id });
  });

  test("stopping while register is in flight still unregisters", async () => {
    const c = new FakeClaude(server.url, "a", { stateDir });
    clients.push(c);
    await c.handshake(); // no state file yet: nothing to register as
    await sleep(150);
    const admin = server.client();
    await admin.execute(["CLIENT", "PAUSE", 800, "WRITE"]); // register (a write function) now blocks
    c.hook("idle", "s-1");
    await sleep(150); // the tick is inside register()
    await c.close(); // stdin closes while register is still pending
    expect(await c.exited).toBe(0);
    expect(c.stderr.join("")).toContain("registered");
    expect((await b.slotInfo("a")).conn_id).toBe("");
  });

  test("two slots never see each other's tasks", async () => {
    const ca = await start("a", "sa");
    const cb = await start("b", "sb", { pid: process.pid + 100000 });
    must(await b.send({ slot: "b", payload: "for b" }));
    expect((await cb.notification()).params.content).toContain("for b");
    await ca.noNotification(0.3);
  });
});

describe("state hook", () => {
  function run(event: Record<string, unknown>, dir: string, pid = "4242"): number {
    const r = spawnSync("python3", [HOOK], {
      input: JSON.stringify(event),
      env: { ...process.env, MCTL_BRIDGE_STATE_DIR: dir, CLAUDE_PID: pid },
    });
    return r.status ?? -1;
  }

  test("SessionStart, UserPromptSubmit and Stop write the state atomically", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-hook-"));
    try {
      const file = path.join(dir, "4242.json");
      expect(run({ hook_event_name: "SessionStart", session_id: "s1", source: "startup" }, dir)).toBe(0);
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ session_id: "s1", state: "idle", source: "startup" });
      run({ hook_event_name: "UserPromptSubmit", session_id: "s1" }, dir);
      expect(JSON.parse(fs.readFileSync(file, "utf8")).state).toBe("busy");
      run({ hook_event_name: "SubagentStop", session_id: "s1" }, dir);
      expect(JSON.parse(fs.readFileSync(file, "utf8")).state).toBe("busy");
      run({ hook_event_name: "Stop", session_id: "s1" }, dir);
      expect(JSON.parse(fs.readFileSync(file, "utf8")).state).toBe("idle");
      run({ hook_event_name: "SessionStart", session_id: "s2", source: "clear" }, dir);
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ session_id: "s2", source: "clear" });
      expect(fs.readdirSync(dir)).toEqual(["4242.json"]); // no temp files left
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a broken input never fails the session", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-hook-"));
    try {
      const r = spawnSync("python3", [HOOK], { input: "not json", env: { ...process.env, MCTL_BRIDGE_STATE_DIR: dir } });
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
