// Issue #108, deterministic routing slice: a message addressed to one slot can never be
// delivered to, or answered for, the other slot. Only the bridge's routing layer is
// exercised (src/store.ts and the Lua functions it calls) on a throwaway server.
//
// Hostile setup on purpose: slots "a" and "b" register with the SAME conn_id (both start at
// epoch 1), so the connection and epoch checks cannot be what separates them. Only the
// routing checks on the slot itself can. A test that passes with the slot checks removed
// would prove nothing.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { Ingester } from "../src/ingest.ts";
import { SlotLink } from "../src/slotlink.ts";
import { Bridge, key, newId, pairs, text } from "../src/store.ts";
import type { Admission, Result, SlotConn } from "../src/store.ts";
import { ValkeyError } from "../src/valkey.ts";
import type { Reply } from "../src/valkey.ts";
import { ValkeyServer, requiresValkey } from "./support.ts";

let server: ValkeyServer;
let b: Bridge;

function must(r: Result): Record<string, any> {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Record<string, any>;
}

type Reg = SlotConn & { uuid: string };

async function register(slot: string, conn_id: string = newId("k")): Promise<Reg> {
  const uuid = `u-${slot}`;
  const r = must(await b.register({ slot, uuid, conn_id, pid: 100, pid_start: "s1", cwd: "/w" }));
  const c = { slot, conn_id, epoch: r.epoch as string, uuid };
  must(await b.heartbeat(c, false));
  return c;
}

/** send -> next -> emitted -> ack: a task in flight with its admission. */
async function admitted(c: Reg, payload = "work"): Promise<{ id: string; attempt: string; admission: Admission }> {
  const sent = must(await b.send({ slot: c.slot, payload }));
  const next = must(await b.next(c));
  expect(next.id).toBe(sent.id);
  must(await b.emitted(c, sent.id));
  const ack = must(await b.ackTask(c, sent.id, next.attempt_id));
  return { id: sent.id, attempt: next.attempt_id, admission: ack.admission };
}

/** Everything routing could touch: both slot hashes, every message, the queues. */
async function snapshot(ids: string[]): Promise<unknown> {
  const x = (cmd: Array<string | number>) => b.exec.execute(cmd);
  return {
    a: await b.slotInfo("a"),
    b: await b.slotInfo("b"),
    msgs: await Promise.all(ids.map((id) => b.message(id))),
    open: await b.members(key.open),
    readyA: await x(["ZRANGE", key.ready("a"), 0, -1, "WITHSCORES"]),
    readyB: await x(["ZRANGE", key.ready("b"), 0, -1, "WITHSCORES"]),
    inboxA: await x(["XLEN", key.inbox("a")]),
    inboxB: await x(["XLEN", key.inbox("b")]),
    audit: await x(["XLEN", key.audit]),
  };
}

const zrange = (r: Reply): string[] => (Array.isArray(r) ? r.map((x) => text(x!)) : []);
/** A reply flattened to readable text (replies hold Buffers, which JSON.stringify turns into byte arrays). */
const flat = (r: unknown): string =>
  Buffer.isBuffer(r) ? r.toString("utf8") : Array.isArray(r) ? r.map(flat).join(" ") : String(r);
const NOT_A_SUCCESS = (r: Result) => expect(r.ok).toBe(false);

describe.skipIf(requiresValkey)("routing isolation between slots", () => {
  let A: Reg;
  let B: Reg;

  beforeAll(async () => {
    server = await ValkeyServer.start();
  });
  afterAll(async () => {
    await server.stop();
  });
  beforeEach(async () => {
    await server.client().execute(["FLUSHALL"]);
    b = await server.bridge();
    const shared = newId("k"); // the same connection id in both slots, deliberately
    A = await register("a", shared);
    B = await register("b", shared);
    expect(A.conn_id).toBe(B.conn_id);
    expect(A.epoch).toBe(B.epoch);
  });

  // (a) ------------------------------------------------------------------------------

  test("A cannot acknowledge, mark or report on a task addressed to B", async () => {
    const queued = must(await b.send({ slot: "b", payload: "B only" }));
    const next = must(await b.next(B));
    const attempt = next.attempt_id as string;
    const before = await snapshot([queued.id]);

    // B's task is in emit_intent. A holds a valid connection and B's real attempt id.
    expect(await b.ackTask(A, queued.id, attempt)).toMatchObject({ ok: false, code: "unknown_task" });
    expect(await b.emitted(A, queued.id)).toMatchObject({ ok: false, code: "not_mine" });
    expect(await snapshot([queued.id])).toEqual(before);

    // B acknowledges legitimately; now A knows the full admission and presents it.
    must(await b.emitted(B, queued.id));
    const adm = must(await b.ackTask(B, queued.id, attempt)).admission as Admission;
    const afterAck = await snapshot([queued.id]);
    expect(await b.result("a", adm, "completed", "forged by A")).toMatchObject({ ok: false, code: "unknown_task" });
    expect(await b.result("a", adm, "failed", "forged by A")).toMatchObject({ ok: false, code: "unknown_task" });
    expect(await b.ask("a", adm, "forged question by A")).toMatchObject({ ok: false, code: "unknown_task" });
    expect(await snapshot([queued.id])).toEqual(afterAck);
    expect(await b.late(queued.id)).toEqual([]); // not even recorded as late evidence on B's task
    expect((await b.message(queued.id)).state).toBe("acked");
    expect((await b.message(queued.id)).result).toBeUndefined();

    // and the other direction: B cannot spend A's admission
    const mine = await admitted(A, "A only");
    const beforeB = await snapshot([queued.id, mine.id]);
    expect(await b.result("b", mine.admission, "completed", "forged by B")).toMatchObject({ ok: false, code: "unknown_task" });
    expect(await b.ackTask(B, mine.id, mine.attempt)).toMatchObject({ ok: false, code: "unknown_task" });
    expect(await snapshot([queued.id, mine.id])).toEqual(beforeB);

    // B's legitimate result still works, so nothing above was a side effect of a broken setup.
    must(await b.result("b", adm, "completed", "B's own result"));
    expect((await b.message(queued.id)).result).toBe("B's own result");
  });

  // (b) ------------------------------------------------------------------------------

  test("a reply to B's question is never queued, offered or acknowledged for A", async () => {
    const task = await admitted(B, "B asks");
    const q = must(await b.ask("b", task.admission, "B's question"));
    const claim = must(await b.claim(q.question_id));
    const committed = must(await b.reply(q.question_id, claim.claim_token, "answer for B"));

    // Nothing for A anywhere: queue, doorbell, and what next() offers.
    expect(zrange(await b.exec.execute(["ZRANGE", key.ready("a"), 0, -1]))).toEqual([]);
    const aDoorbell = (await b.exec.execute(["XRANGE", key.inbox("a"), "-", "+"])) as Reply[];
    expect(aDoorbell.map((e) => pairs((e as Reply[])[1]!).id)).not.toContain(q.question_id);
    expect(await b.members(`mctl:bridge:s:a:open`)).not.toContain(q.question_id);
    expect(await b.next(A)).toMatchObject({ ok: false, code: "empty" });
    expect(zrange(await b.exec.execute(["ZRANGE", key.ready("b"), 0, -1]))).toEqual([q.question_id]);

    // B gets exactly that reply.
    const got = must(await b.next(B));
    expect(got).toMatchObject({ kind: "reply", id: q.question_id, reply_id: committed.reply_id, payload: "answer for B" });

    // A, with a valid connection and the real reply id, can neither mark nor acknowledge it.
    const before = await snapshot([q.question_id, task.id]);
    expect(await b.emitted(A, q.question_id)).toMatchObject({ ok: false, code: "not_mine" });
    expect(await b.ackReply(A, q.question_id, committed.reply_id)).toMatchObject({ ok: false, code: "unknown_question" });
    expect(await snapshot([q.question_id, task.id])).toEqual(before);
    expect((await b.message(q.question_id)).state).toBe("reply_emit_intent");

    must(await b.emitted(B, q.question_id));
    must(await b.ackReply(B, q.question_id, committed.reply_id));
    expect((await b.message(q.question_id)).state).toBe("reply_acknowledged");
  });

  // (c) ------------------------------------------------------------------------------

  test("a stale conn_id with the current epoch, or a stale epoch, cannot emit, ack, report or settle", async () => {
    const task = await b.send({ slot: "a", payload: "x" }).then(must);
    const next = must(await b.next(A));
    must(await b.emitted(A, task.id));
    const adm = must(await b.ackTask(A, task.id, next.attempt_id)).admission as Admission;
    const q = must(await b.ask("a", adm, "q?"));
    const claim = must(await b.claim(q.question_id));
    const committed = must(await b.reply(q.question_id, claim.claim_token, "yes"));
    const offered = must(await b.next(A)); // reply_emit_intent on A's connection
    expect(offered.reply_id).toBe(committed.reply_id);
    const ids = [task.id, q.question_id];
    const before = await snapshot(ids);

    const wrongConn: SlotConn = { slot: "a", conn_id: newId("k"), epoch: A.epoch };
    const wrongEpoch: SlotConn = { slot: "a", conn_id: A.conn_id, epoch: String(Number(A.epoch) + 7) };
    for (const c of [wrongConn, wrongEpoch]) {
      NOT_A_SUCCESS(await b.heartbeat(c, false));
      expect(await b.next(c)).toMatchObject({ ok: false, code: "fenced" });
      expect(await b.emitted(c, q.question_id)).toMatchObject({ ok: false, code: "fenced" });
      expect(await b.emitted(c, task.id)).toMatchObject({ ok: false, code: "fenced" });
      expect(await b.ackTask(c, task.id, next.attempt_id)).toMatchObject({ ok: false, code: "fenced" });
      expect(await b.ackReply(c, q.question_id, committed.reply_id)).toMatchObject({ ok: false, code: "fenced" });
      expect(await b.emitLost(c)).toMatchObject({ ok: false, code: "fenced" });
      expect(await b.unregister(c)).toMatchObject({ ok: false, code: "fenced" });
      // report: the admission carries the stale field
      const forged = { ...adm, conn_id: c.conn_id, epoch: c.epoch };
      expect(await b.result("a", forged, "completed", "stale")).toMatchObject({ ok: false, code: "fenced" });
      expect(await b.ask("a", forged, "stale?")).toMatchObject({ ok: false, code: "fenced" });
    }
    // Only late evidence changed (it is recorded, never applied); no state, queue or slot field did.
    const after = (await snapshot(ids)) as any;
    const was = before as any;
    expect(after.a).toEqual(was.a);
    expect(after.b).toEqual(was.b);
    expect(after.msgs.map((m: any) => m.state)).toEqual(was.msgs.map((m: any) => m.state));
    expect(after.readyA).toEqual(was.readyA);
    expect((await b.message(task.id)).result).toBeUndefined();

    // The current connection still works.
    must(await b.emitted(A, q.question_id));
    must(await b.ackReply(A, q.question_id, committed.reply_id));
    must(await b.result("a", adm, "completed", "current"));
  });

  // (d) ------------------------------------------------------------------------------

  test("replaying a terminal task id changes nothing and cannot be reused", async () => {
    const t = await admitted(A);
    must(await b.result("a", t.admission, "completed", "first"));
    const frozen = async () => {
      const m = await b.message(t.id);
      return { state: m.state, result: m.result, reason: m.reason, attempt_id: m.attempt_id, slot: await b.slotInfo("a"), open: await b.members(key.open) };
    };
    const before = await frozen();
    expect(before.state).toBe("completed");

    // the very same calls again, in every shape a duplicate could take
    expect((await b.result("a", t.admission, "completed", "first")).ok).toBe(false);
    expect((await b.result("a", t.admission, "failed", "second")).ok).toBe(false);
    expect((await b.ask("a", t.admission, "late question")).ok).toBe(false);
    expect(await b.ackTask(A, t.id, t.attempt)).toMatchObject({ ok: false, code: "wrong_state" });
    expect(await b.emitted(A, t.id)).toMatchObject({ ok: false, code: "wrong_state" });
    expect(await frozen()).toEqual(before);
    expect(await b.next(A)).toMatchObject({ ok: false, code: "empty" });

    // the id cannot be minted again, not even to resurrect it, for another slot either
    expect(await b.send({ slot: "a", payload: "again", id: t.id })).toMatchObject({ ok: false, code: "duplicate_id" });
    expect(await b.send({ slot: "b", payload: "again", id: t.id })).toMatchObject({ ok: false, code: "duplicate_id" });
    expect(await frozen()).toEqual(before);
    expect((await b.message(t.id)).payload).toBe("work");

    // same for a cancelled task (queued, then the addressee context was replaced)
    const gone = must(await b.send({ slot: "b", payload: "never delivered" }));
    await register("b"); // epoch + 1 cancels it
    expect((await b.message(gone.id)).state).toBe("cancelled");
    expect(await b.send({ slot: "b", payload: "x", id: gone.id })).toMatchObject({ ok: false, code: "duplicate_id" });
    expect((await b.message(gone.id)).state).toBe("cancelled");
  });

  // (e) ------------------------------------------------------------------------------

  test("a call whose slot argument and slot key disagree is rejected, not rerouted", async () => {
    const mine = await admitted(A, "A's task in flight");
    const bQueued = must(await b.send({ slot: "b", payload: "B waits" }));
    const before = await snapshot([mine.id, bQueued.id]);
    const adm = mine.admission;

    const calls = (slot: string): Array<[string, string[]]> => [
      ["bridge_heartbeat", [slot, A.conn_id, A.epoch, "0"]],
      ["bridge_unregister", [slot, A.conn_id, A.epoch]],
      ["bridge_next", [slot, A.conn_id, A.epoch, newId("a")]],
      ["bridge_emitted", [slot, A.conn_id, A.epoch, mine.id]],
      ["bridge_emit_lost", [slot, A.conn_id, A.epoch]],
      ["bridge_ack_task", [slot, A.conn_id, A.epoch, mine.id, mine.attempt]],
      ["bridge_ack_reply", [slot, A.conn_id, A.epoch, "q-x", "r-x"]],
      ["bridge_result", [slot, adm.task_id, adm.attempt_id, adm.uuid, adm.epoch, adm.conn_id, "completed", "rerouted"]],
      ["bridge_ask", [slot, adm.task_id, adm.attempt_id, adm.uuid, adm.epoch, adm.conn_id, "q-rerouted", "?", "0"]],
    ];
    // slot argument "a" under B's key, and slot argument "b" under A's key
    for (const [argSlot, keySlot] of [["a", "b"], ["b", "a"]] as const) {
      for (const [fn, args] of calls(argSlot)) {
        const r = await b.call(fn, key.slot(keySlot), args);
        expect({ fn, argSlot, keySlot, r }).toMatchObject({ r: { ok: false, code: "bad_request" } });
      }
    }
    expect(await snapshot([mine.id, bQueued.id])).toEqual(before);
    expect(await b.message("q-rerouted")).toEqual({});

    // sends: an unregistered or malformed destination creates nothing and lands in nobody's queue
    expect(await b.send({ slot: "c", payload: "x", id: "t-nowhere" })).toMatchObject({ ok: false, code: "slot_not_registered" });
    for (const slot of ["A", "a:slot", "a b", "", "a/../b"]) {
      expect(await b.send({ slot, payload: "x", id: "t-malformed" })).toMatchObject({ ok: false, code: "bad_request" });
    }
    expect(await b.message("t-nowhere")).toEqual({});
    expect(await b.message("t-malformed")).toEqual({});
    expect(await snapshot([mine.id, bQueued.id])).toEqual(before);
  });

  // (f) ------------------------------------------------------------------------------

  test("canaries sent to A never appear in anything B's credentials can read", async () => {
    const CANARY = `CANARY-${crypto.randomUUID()}`;
    const raw = server.client();
    await raw.execute(["ACL", "DELUSER", "bridge_slot_a", "bridge_slot_b"]);
    const slotA = await server.addSlot("a");
    const slotB = await server.addSlot("b");
    const ingester = new Ingester(b);
    const pump = ingester.run(25);
    try {
      // Both slots do real work through their own request streams.
      const linkA = new SlotLink(slotA.client(), "a");
      const linkB = new SlotLink(slotB.client(), "b");
      // A and B are already registered (beforeEach); their links use those connections.
      const ca: SlotConn = A;
      const cb: SlotConn = B;
      must(await linkA.heartbeat(ca, false));
      must(await linkB.heartbeat(cb, false));

      must(await b.send({ slot: "b", payload: "innocent work for B" }));
      must(await b.send({ slot: "a", payload: `task ${CANARY}-task` }));
      const got = must(await linkA.next(ca));
      expect(got.payload).toContain(CANARY);
      must(await linkA.emitted(ca, got.id));
      const adm = must(await linkA.ackTask(ca, got.id, got.attempt_id)).admission as Admission;
      const q = must(await linkA.ask("a", adm, `question ${CANARY}-question`));
      const claim = must(await b.claim(q.question_id));
      const rep = must(await b.reply(q.question_id, claim.claim_token, `reply ${CANARY}-reply`));
      must(await linkA.emitted(ca, q.question_id).then(async (r) => (r.ok ? r : (await linkA.next(ca), linkA.emitted(ca, q.question_id)))));
      must(await linkA.ackReply(ca, q.question_id, rep.reply_id));
      must(await linkA.result("a", adm, "completed", `result ${CANARY}-result`));
      // A's own answers do contain the canary (the setup is not vacuous)...
      const own = await raw.execute(["XRANGE", key.resp("a"), "-", "+"]);
      expect(flat(own)).toContain(CANARY);

      // ...and B's credentials read nothing of it, by any route.
      const c = slotB.client();
      const seen: string[] = [];
      const attempt = async (cmd: Array<string | number>) => {
        try {
          seen.push(flat(await c.execute(cmd)));
        } catch (err) {
          expect(err).toBeInstanceOf(ValkeyError);
          seen.push((err as Error).message);
        }
      };
      const stream = (k: string) => ["XRANGE", k, "-", "+"];
      // its own readable streams
      await attempt(["XREAD", "COUNT", 1000, "STREAMS", key.resp("b"), key.inbox("b"), "0-0", "0-0"]);
      await attempt(["XREVRANGE", key.resp("b"), "+", "-"]);
      await attempt(["XREVRANGE", key.inbox("b"), "+", "-"]);
      // everything of A's, and the shared keys that hold A's text
      const ids = [got.id, q.question_id];
      const targets = [
        key.resp("a"), key.inbox("a"), key.out("a"), key.ready("a"), key.slotOpen("a"), key.slot("a"),
        key.audit, key.feed, key.asked, key.open, key.rejected("a"), key.checkpoint("a"),
        ...ids.flatMap((id) => [key.msg(id), key.msgAudit(id), key.late(id), key.claim(id), `mctl:bridge:rpc:a:${id}`]),
      ];
      for (const k of targets) {
        for (const cmd of [["GET", k], ["HGETALL", k], ["SMEMBERS", k], ["ZRANGE", k, 0, -1], stream(k), ["DUMP", k]]) {
          await attempt(cmd);
        }
        await attempt(["XREVRANGE", k, "+", "-"]);
        await attempt(["XREAD", "COUNT", 1000, "STREAMS", k, "0-0"]);
      }
      await attempt(["KEYS", "*"]);
      await attempt(["SCAN", 0]);
      await attempt(["FCALL_RO", "bridge_version", 0]);
      await attempt(["EVAL", "return redis.call('GET', KEYS[1])", 1, key.msg(got.id)]);

      expect(seen.length).toBeGreaterThan(targets.length);
      for (const s of seen) expect(s).not.toContain(CANARY);
      // B's own answers carry only B's request ids and nothing of A's.
      expect(flat(await raw.execute(["XRANGE", key.resp("b"), "-", "+"]))).not.toContain(CANARY);
      expect(flat(await raw.execute(["XRANGE", key.inbox("b"), "-", "+"]))).not.toContain(CANARY);
      expect(text((await raw.execute(["HGET", key.msg(got.id), "slot"]))!)).toBe("a");
    } finally {
      ingester.stop();
      await pump;
    }
  });
});
