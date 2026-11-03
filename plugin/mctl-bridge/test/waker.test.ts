// The waker against a fake Codex app server on a Unix socket.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import net from "node:net";
import path from "node:path";

import { AppClient } from "../src/appserver.ts";
import { Bridge, key, newId } from "../src/store.ts";
import type { Result, SlotConn } from "../src/store.ts";
import { Waker, marker } from "../src/waker.ts";
import type { WakerConfig } from "../src/waker.ts";
import { FakeApp } from "./fakeapp.ts";
import { ValkeyConnectionError } from "../src/valkey.ts";
import type { Arg, ExecuteOptions, Executor, Reply } from "../src/valkey.ts";
import { ValkeyServer, requiresValkey, sleep } from "./support.ts";

/** Fails one named FCALL before it reaches the server, as a dropped connection would. */
class FailOnce implements Executor {
  armed: string | null = null;
  private readonly inner: Executor;
  constructor(inner: Executor) {
    this.inner = inner;
  }
  async execute(args: readonly Arg[], options?: ExecuteOptions): Promise<Reply> {
    if (this.armed !== null && args[0] === "FCALL" && args[1] === this.armed) {
      this.armed = null;
      throw new ValkeyConnectionError("connection reset");
    }
    return this.inner.execute(args, options);
  }
}

let server: ValkeyServer;
let b: Bridge;
let app: FakeApp;

function must(r: Result): Record<string, any> {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Record<string, any>;
}

/** A slot whose in-flight task has asked a question: the question waits in `asked`. */
async function question(slot = "a", text = "rename or alias?"): Promise<string> {
  const conn_id = newId("k");
  const r = must(await b.register({ slot, uuid: crypto.randomUUID(), conn_id, pid: 100, pid_start: "s1", cwd: "/w" }));
  const c: SlotConn = { slot, conn_id, epoch: String(r.epoch) };
  must(await b.heartbeat(c, false));
  const sent = must(await b.send({ slot, payload: "do it" }));
  const next = must(await b.next(c));
  must(await b.emitted(c, sent.id));
  const ack = must(await b.ackTask(c, sent.id, next.attempt_id));
  return must(await b.ask(slot, ack.admission, text)).question_id;
}

function waker(o: Partial<WakerConfig> = {}, exec: Executor = server.client()): Waker {
  return new Waker(new Bridge(exec), {
    threadId: app.threadId, socketPath: app.path, quietMs: 0, perHour: 10, perQuestion: 2,
    turnTimeoutMs: 3000, rpcTimeoutMs: 1000, pollMs: 20, staleMs: 30_000, ...o,
  });
}

/** The one wake the test made, whatever state it ended in. */
async function onlyWake(): Promise<Record<string, string>> {
  const ids = await server.client().execute(["KEYS", key.wake("*")]);
  expect(Array.isArray(ids) && ids.length).toBe(1);
  const id = String((ids as Buffer[])[0]).slice(key.wake("").length);
  return { id, ...(await b.wake(id)) };
}

describe.skipIf(requiresValkey)("waker", () => {
  beforeAll(async () => {
    server = await ValkeyServer.start();
  });
  afterAll(async () => {
    await server.stop();
  });
  beforeEach(async () => {
    await server.client().execute(["FLUSHALL"]);
    b = await server.bridge();
    app = new FakeApp().start();
  });
  afterEach(() => {
    app.stop();
  });

  test("a foreign turn/completed is ignored; the wake ends on its own turn and never answers", async () => {
    const qid = await question("a", "SECRET-PAYLOAD");
    app.completeAfterMs = null;
    const w = waker();
    const running = w.tick();
    let wake: Record<string, string> = {};
    for (let i = 0; i < 100 && wake.state !== "started"; i++) {
      await sleep(20);
      const ids = (await b.openWakes()).map((x) => x.id);
      if (ids.length) wake = { id: ids[0]!, ...(await b.wake(ids[0]!)) };
    }
    expect(wake.state).toBe("started");
    await sleep(200); // the two foreign turn/completed notes have arrived by now
    expect((await b.wake(wake.id!)).state).toBe("started");
    app.complete(wake.turn_id!);
    expect(await running).toBe(wake.id!);
    expect(await b.wake(wake.id!)).toMatchObject({ state: "completed", reason: "completed" });
    expect(app.starts).toHaveLength(1);
    const text = app.starts[0].input[0].text as string;
    expect(text).toContain(marker(wake.id!));
    expect(text).toContain(`mctl-bridge claim ${qid}`);
    expect(text).not.toContain("SECRET-PAYLOAD"); // slot input stays out of the turn text
    expect((await b.message(qid)).state).toBe("asked"); // the waker never answers
    expect(await server.client().execute(["EXISTS", key.wakelock(app.threadId)])).toBe(0);
  });

  test("a lost turn/start reply resolves through the marker in the history", async () => {
    await question();
    app.mode = "drop";
    expect(await waker().tick()).not.toBeNull();
    const w = await onlyWake();
    expect(w).toMatchObject({ state: "completed", turn_id: "turn-0" });
    expect(app.starts).toHaveLength(1);
  });

  test("an ambiguous history gives wake_unknown and no second turn", async () => {
    const qid = await question();
    app.mode = "drop";
    app.completeAfterMs = null;
    // The operator pasted the same marker into a manual turn: two matches.
    const id = newId("w");
    app.manualTurn(`${marker(id)} copied by hand`);
    const w = waker();
    // Drive the wake with a known id so the copy matches it.
    must(await b.wakeBegin({ question_id: qid, thread_id: app.threadId, wake_id: id, lock_ms: 60_000, per_hour: 10, quiet_ms: 0 }));
    await w.run(id, { id: qid, slot: "a", task_id: "t" });
    expect(await b.wake(id)).toMatchObject({ state: "wake_unknown", reason: "history_matches_2" });
    // An unknown wake keeps the thread: its turn may still be running.
    expect(await server.client().execute(["EXISTS", key.wakelock(app.threadId)])).toBe(1);
    expect(await w.tick()).toBeNull(); // no automatic restart while unresolved
    expect(app.starts).toHaveLength(1);
    expect((await b.openWakes()).map((x) => x.id)).toEqual([id]); // stays open
  });

  test("no marker in the history gives wake_unknown too", async () => {
    await question();
    app.mode = "drop-unrecorded";
    await waker().tick();
    expect(await onlyWake()).toMatchObject({ state: "wake_unknown", reason: "history_matches_0" });
  });

  test("an unreadable history is unknown, not absent", async () => {
    await question();
    app.mode = "drop-unrecorded";
    app.brokenRead = true;
    await waker().tick();
    const w = await onlyWake();
    expect(w.state).toBe("wake_unknown");
    expect(w.reason).toStartWith("history_unreadable");
  });

  test("a refused turn/start is failed, frees the thread and may be woken again", async () => {
    await question();
    app.mode = "error";
    const w = waker();
    await w.tick();
    const first = await onlyWake();
    expect(first.state).toBe("failed");
    expect(await server.client().execute(["EXISTS", key.wakelock(app.threadId)])).toBe(0);
    app.mode = "ok";
    expect(await w.tick()).not.toBeNull();
    expect(app.starts).toHaveLength(2);
    expect(await w.tick()).toBeNull(); // per_question = 2
  });

  test("two wakers at once produce one wake", async () => {
    await question();
    app.completeAfterMs = 200;
    const [x, y] = await Promise.all([waker().tick(), waker().tick()]);
    expect([x, y].filter((v) => v !== null)).toHaveLength(1);
    expect(app.starts).toHaveLength(1);
  });

  test("the hourly limit holds across questions", async () => {
    await question("a");
    await question("b");
    const w = waker({ perHour: 1 });
    expect(await w.tick()).not.toBeNull();
    expect(await w.tick()).toBeNull();
    expect(app.starts).toHaveLength(1);
  });

  test("a claimed or too recent question is not woken", async () => {
    const qid = await question();
    expect(await waker({ quietMs: 60_000 }).tick()).toBeNull();
    must(await b.claim(qid));
    expect(await waker().tick()).toBeNull();
    expect(app.starts).toHaveLength(0);
  });

  test("a connection lost after the start is followed through the history", async () => {
    await question();
    app.completeAfterMs = null;
    app.foreignFirst = false;
    const w = waker();
    const running = w.tick();
    let started: Record<string, string> = {};
    for (let i = 0; i < 100 && started.state !== "started"; i++) {
      await sleep(20);
      const open = await b.openWakes();
      if (open.length) started = open[0]!;
    }
    app.dropClients();
    await sleep(100);
    app.complete(started.turn_id!, "interrupted", false); // visible only in the history
    await running;
    expect(await b.wake(started.id!)).toMatchObject({ state: "completed", reason: "interrupted" });
  });

  test("a turn that never ends becomes wake_unknown at the timeout", async () => {
    await question();
    app.completeAfterMs = null;
    await waker({ turnTimeoutMs: 300 }).tick();
    expect(await onlyWake()).toMatchObject({ state: "wake_unknown", reason: "turn_timeout" });
  });

  test("recovery on start settles intents a previous waker left behind", async () => {
    const q1 = await question("a");
    const q2 = await question("b");
    const found = newId("w");
    const lost = newId("w");
    must(await b.wakeBegin({ question_id: q1, thread_id: app.threadId, wake_id: found, lock_ms: 60_000, per_hour: 10, quiet_ms: 0 }));
    app.manualTurn(`${marker(found)} started before the crash`);
    await server.client().execute(["DEL", key.wakelock(app.threadId)]);
    must(await b.wakeBegin({ question_id: q2, thread_id: app.threadId, wake_id: lost, lock_ms: 60_000, per_hour: 10, quiet_ms: 0 }));
    await waker().recover();
    expect(await b.wake(found)).toMatchObject({ state: "completed", turn_id: "turn-manual-0" });
    expect(await b.wake(lost)).toMatchObject({ state: "wake_unknown", reason: "history_matches_0" });
    expect(app.starts).toHaveLength(0); // recovery never starts a turn
  });

  test("recovery after the turn timeout still reads the thread once", async () => {
    const q1 = await question("a");
    const q2 = await question("b");
    const done = newId("w");
    const running = newId("w");
    const base = { thread_id: app.threadId, lock_ms: 60_000, per_hour: 10, quiet_ms: 0 };
    must(await b.wakeBegin({ ...base, question_id: q1, wake_id: done }));
    app.manualTurn(`${marker(done)} first`, "completed");
    must(await b.wakeStarted(done, "turn-manual-0"));
    await server.client().execute(["DEL", key.wakelock(app.threadId)]);
    must(await b.wakeBegin({ ...base, question_id: q2, wake_id: running }));
    app.manualTurn(`${marker(running)} second`, "inProgress");
    must(await b.wakeStarted(running, "turn-manual-1"));
    // The waker was down for longer than the turn timeout.
    for (const id of [done, running]) await server.client().execute(["HSET", key.wake(id), "created_ms", "0"]);
    await waker().recover();
    expect(await b.wake(done)).toMatchObject({ state: "completed", reason: "completed" });
    expect(await b.wake(running)).toMatchObject({ state: "wake_unknown", reason: "turn_timeout" });
    expect(app.reads).toBe(2);
  });

  test("a turn without a status is not taken as finished", async () => {
    const qid = await question();
    const id = newId("w");
    must(await b.wakeBegin({ question_id: qid, thread_id: app.threadId, wake_id: id, lock_ms: 60_000, per_hour: 10, quiet_ms: 0 }));
    app.manualTurn(`${marker(id)} odd shape`, null);
    await server.client().execute(["HSET", key.wake(id), "created_ms", "0"]);
    await waker().recover(); // intent: one match, then followed
    expect(await b.wake(id)).toMatchObject({ state: "wake_unknown", reason: "turn_timeout" });
  });

  for (const [fn, leftIn] of [["bridge_wake_started", "intent"], ["bridge_wake_finish", "started"]] as const) {
    test(`a Valkey failure in ${fn} is recovered by the next pass, with one turn/start, and the question still gets its answer`, async () => {
      const qid = await question();
      await server.client().execute(["HSET", key.msg(qid), "updated_ms", "0"]);
      const flaky = new FailOnce(server.client());
      // per-question 2 and a quiet period: a second wake would be allowed by the limit,
      // so only the recovery and the quiet period keep it from starting another turn.
      const w = waker({ perQuestion: 2, quietMs: 60_000 }, flaky);
      flaky.armed = fn;
      await expect(w.step()).rejects.toThrow("connection reset");
      const left = await onlyWake();
      expect(left.state).toBe(leftIn);
      expect(await w.step()).toBeNull(); // recovery runs again; no process restart
      expect(await b.wake(left.id!)).toMatchObject({ state: "completed", reason: "completed" });
      expect(await b.openWakes()).toEqual([]);
      expect(await server.client().execute(["EXISTS", key.wakelock(app.threadId)])).toBe(0);
      expect(await w.step()).toBeNull(); // and no second wake within the quiet period
      expect(app.starts).toHaveLength(1);
      // The woken orchestrator answers: claim and reply go through as usual.
      const claim = must(await b.claim(qid));
      must(await b.reply(qid, claim.claim_token, "yes"));
      expect((await b.message(qid)).state).toBe("reply_committed");
    });
  }

  test("the quiet period also runs from the last wake", async () => {
    const qid = await question();
    await server.client().execute(["HSET", key.msg(qid), "updated_ms", "0"]);
    const base = { question_id: qid, thread_id: app.threadId, lock_ms: 60_000, per_hour: 10, quiet_ms: 60_000 };
    const first = must(await b.wakeBegin(base)).wake_id;
    must(await b.wakeStarted(first, "turn-x"));
    must(await b.wakeFinish(first, "completed", "completed"));
    expect(await b.wakeBegin(base)).toMatchObject({ ok: false, code: "too_early" });
    expect(await b.wakeBegin({ ...base, quiet_ms: 0 })).toMatchObject({ ok: true });
  });

  test("a socket closed during the handshake fails at once", async () => {
    const sock = path.join(app.dir, "closing.sock");
    const srv = net.createServer((c) => c.end()).listen(sock);
    await new Promise((r) => srv.once("listening", r));
    const t0 = Date.now();
    await expect(AppClient.connect(sock, 5000)).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(1000);
    srv.close();
  });

  test("resolve closes a wake_unknown and frees the thread", async () => {
    await question();
    app.mode = "hang";
    app.completeAfterMs = null;
    await waker({ rpcTimeoutMs: 200 }).tick(); // hang: no reply, one marker -> started; never ends
    const w = await onlyWake();
    expect(w.state).toBe("wake_unknown");
    expect(await b.wakeResolve(w.id!, "", "dm")).toMatchObject({ ok: false, code: "bad_request" });
    must(await b.wakeResolve(w.id!, "checked the thread", "dm"));
    expect((await b.wake(w.id!)).state).toBe("resolved");
    expect(await b.openWakes()).toEqual([]);
    expect(await server.client().execute(["EXISTS", key.wakelock(app.threadId)])).toBe(0);
  });

  test("wake_begin refuses a busy thread, a duplicate and a bad request", async () => {
    const q1 = await question("a");
    const q2 = await question("b");
    const id = newId("w");
    const base = { thread_id: app.threadId, lock_ms: 60_000, per_hour: 10, quiet_ms: 0 };
    must(await b.wakeBegin({ ...base, question_id: q1, wake_id: id }));
    expect(await b.wakeBegin({ ...base, question_id: q2 })).toMatchObject({ ok: false, code: "thread_busy", wake_id: id });
    expect(await b.wakeBegin({ ...base, question_id: q1, thread_id: "other" })).toMatchObject({ ok: false, code: "woken" });
    expect(await b.wakeBegin({ ...base, question_id: q2, lock_ms: 0 })).toMatchObject({ ok: false, code: "bad_request" });
    // A claim taken between the waker's listing and its wake_begin still wins.
    must(await b.claim(q2));
    await server.client().execute(["DEL", key.wakelock(app.threadId)]);
    expect(await b.wakeBegin({ ...base, question_id: q2 })).toMatchObject({ ok: false, code: "claimed" });
    expect(await b.wakeStarted(id, "turn-x")).toMatchObject({ ok: true });
    expect(await b.wakeFinish(id, "failed", "late")).toMatchObject({ ok: false, code: "wrong_state" });
  });
});

