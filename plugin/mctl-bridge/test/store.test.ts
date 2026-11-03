// Every guarantee of docs/chatgpt-orchestrator-bridge.md that slice 1 implements
// has a test here, run against a real server.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { Bridge, key, newId, pairs, text } from "../src/store.ts";
import type { Admission, Result, SlotConn } from "../src/store.ts";
import { ValkeyServer, requiresValkey, sleep } from "./support.ts";

let server: ValkeyServer;
let b: Bridge;

function must(r: Result): Record<string, any> {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Record<string, any>;
}

async function register(slot: string, o: { pid?: number; pid_start?: string; uuid?: string } = {}): Promise<SlotConn & { uuid: string }> {
  const uuid = o.uuid ?? crypto.randomUUID();
  const conn_id = newId("k");
  const r = must(await b.register({ slot, uuid, conn_id, pid: o.pid ?? 100, pid_start: o.pid_start ?? "s1", cwd: "/w" }));
  const c = { slot, conn_id, epoch: r.epoch as string, uuid };
  must(await b.heartbeat(c, false));
  return c;
}

/** send → next → emitted → ack: a task in flight with its admission. */
async function admitted(c: SlotConn, payload = "do it"): Promise<{ id: string; admission: Admission }> {
  const sent = must(await b.send({ slot: c.slot, payload }));
  const next = must(await b.next(c));
  expect(next.id).toBe(sent.id);
  must(await b.emitted(c, sent.id));
  const ack = must(await b.ackTask(c, sent.id, next.attempt_id));
  return { id: sent.id, admission: ack.admission };
}

async function state(id: string): Promise<string | undefined> {
  return (await b.message(id)).state;
}

async function auditFor(id: string): Promise<Array<Record<string, string>>> {
  const reply = await b.exec.execute(["XRANGE", key.audit, "-", "+"]);
  return (reply as any[]).map((e) => pairs(e[1])).filter((e) => e.id === id);
}

describe.skipIf(requiresValkey)("bridge state machine", () => {
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

  test("a task reaches only its addressee", async () => {
    const a = await register("a");
    const bb = await register("b");
    must(await b.send({ slot: "a", payload: "for a" }));
    expect((await b.next(bb)).ok).toBe(false);
    const got = must(await b.next(a));
    expect(got.payload).toBe("for a");
  });

  test("nothing is emitted into a busy slot", async () => {
    const a = await register("a");
    must(await b.heartbeat(a, true));
    must(await b.send({ slot: "a", payload: "x" }));
    expect(await b.next(a)).toMatchObject({ ok: false, code: "busy" });
    must(await b.heartbeat(a, false));
    must(await b.next(a));
  });

  test("an old epoch cannot emit, mark or ack", async () => {
    const a1 = await register("a");
    must(await b.send({ slot: "a", payload: "x" }));
    const next = must(await b.next(a1));
    const a2 = await register("a"); // same process (pid and start time): /clear
    expect(a2.epoch).toBe(String(Number(a1.epoch) + 1));
    expect(await b.emitted(a1, next.id)).toMatchObject({ ok: false, code: "fenced" });
    expect(await b.ackTask(a1, next.id, next.attempt_id)).toMatchObject({ ok: false, code: "fenced" });
    expect(await b.next(a1)).toMatchObject({ ok: false, code: "fenced" });
    expect(await b.heartbeat(a1, false)).toMatchObject({ ok: false, code: "fenced" });
  });

  test("an epoch change turns an unacknowledged emit into delivery_unknown, never a resend", async () => {
    const a1 = await register("a");
    const sent = must(await b.send({ slot: "a", payload: "x" }));
    must(await b.next(a1)); // emit_intent; stdio write outcome unknown
    const a2 = await register("a");
    expect(await state(sent.id)).toBe("delivery_unknown");
    expect((await b.message(sent.id)).reason).toBe("epoch_changed");
    expect(await b.next(a2)).toMatchObject({ ok: false, code: "empty" });
    expect(await b.members(key.open)).toContain(sent.id);
  });

  test("a task queued for an old context is cancelled, not handed to the new one", async () => {
    await register("a");
    const sent = must(await b.send({ slot: "a", payload: "x" }));
    const a2 = await register("a");
    expect(await state(sent.id)).toBe("cancelled");
    expect((await b.message(sent.id)).reason).toBe("addressee_changed");
    expect(await b.next(a2)).toMatchObject({ ok: false, code: "empty" });
  });

  test("a second live process on the slot is a conflict", async () => {
    await register("a", { pid: 100, pid_start: "s1" });
    const r = await b.register({ slot: "a", uuid: "u2", conn_id: "k2", pid: 100, pid_start: "s2", cwd: "/w" });
    expect(r).toMatchObject({ ok: false, code: "slot_live" });
  });

  test("an admission with any one field changed is rejected", async () => {
    const a = await register("a");
    const { admission } = await admitted(a);
    for (const field of ["task_id", "attempt_id", "uuid", "epoch", "conn_id"] as const) {
      const bad = { ...admission, [field]: admission[field] + "x" };
      const r = await b.result("a", bad, "completed", "done");
      expect(r.ok).toBe(false);
    }
    expect(await state(admission.task_id)).toBe("acked");
    must(await b.result("a", admission, "completed", "done"));
    expect(await state(admission.task_id)).toBe("completed");
  });

  test("a late result is recorded as evidence and changes no state", async () => {
    const a1 = await register("a");
    const { admission } = await admitted(a1);
    await register("a"); // /clear while the external tool runs
    expect(await state(admission.task_id)).toBe("delivery_unknown");
    const r = await b.result("a", admission, "completed", "pushed the branch");
    expect(r).toMatchObject({ ok: false, code: "fenced", late: true });
    expect(await state(admission.task_id)).toBe("delivery_unknown");
    const late = await b.late(admission.task_id);
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ kind: "result", attempt_id: admission.attempt_id, epoch: admission.epoch, conn_id: admission.conn_id, reason: "fenced", payload: "pushed the branch" });
  });

  test("two claims give one committed reply; the second reply is refused", async () => {
    const a = await register("a");
    const { admission } = await admitted(a);
    const q = must(await b.ask("a", admission, "which branch?"));
    const c1 = must(await b.claim(q.question_id));
    expect(await b.claim(q.question_id)).toMatchObject({ ok: false, code: "claimed" });
    must(await b.reply(q.question_id, c1.claim_token, "main"));
    expect(await b.reply(q.question_id, c1.claim_token, "other")).toMatchObject({ ok: false });
    expect((await b.message(q.question_id)).reply).toBe("main");
  });

  test("a stale claim token of the same owner is rejected after a re-claim", async () => {
    const a = await register("a");
    const { admission } = await admitted(a);
    const q = must(await b.ask("a", admission, "?"));
    const first = must(await b.claim(q.question_id, { lease_ms: 50 }));
    await sleep(80);
    const second = must(await b.claim(q.question_id));
    expect(second.claim_token).not.toBe(first.claim_token);
    expect(await b.reply(q.question_id, first.claim_token, "old")).toMatchObject({ ok: false, code: "not_owner" });
    expect(await b.renew(q.question_id, first.claim_token)).toMatchObject({ ok: false, code: "not_owner" });
    must(await b.reply(q.question_id, second.claim_token, "new"));
  });

  test("while a task is in flight only its own reply passes, with the attempt kept", async () => {
    const a = await register("a");
    const { admission } = await admitted(a);
    const other = must(await b.send({ slot: "a", payload: "unrelated" }));
    const q = must(await b.ask("a", admission, "which branch?"));
    expect(await b.next(a)).toMatchObject({ ok: false, code: "empty" }); // no reply yet, unrelated waits
    const c = must(await b.claim(q.question_id));
    const committed = must(await b.reply(q.question_id, c.claim_token, "main"));
    const before = await b.slotInfo("a");
    const got = must(await b.next(a));
    expect(got).toMatchObject({ kind: "reply", id: q.question_id, reply_id: committed.reply_id, attempt_id: admission.attempt_id, task_id: admission.task_id });
    const after = await b.slotInfo("a");
    expect(after.inflight).toBe(before.inflight);
    expect(after.inflight_attempt).toBe(admission.attempt_id);
    must(await b.emitted(a, q.question_id));
    must(await b.ackReply(a, q.question_id, committed.reply_id));
    expect(await state(q.question_id)).toBe("reply_acknowledged");
    expect(await state(other.id)).toBe("queued");
    // The same attempt finishes the task; only then does the unrelated task go out.
    must(await b.result("a", admission, "completed", "merged into main"));
    expect(must(await b.next(a)).id).toBe(other.id);
  });

  test("a committed reply survives a lost inbox stream and goes out with its reply_id", async () => {
    const a = await register("a");
    const { admission } = await admitted(a);
    const q = must(await b.ask("a", admission, "?"));
    const c = must(await b.claim(q.question_id));
    const committed = must(await b.reply(q.question_id, c.claim_token, "yes"));
    await b.exec.execute(["DEL", key.inbox("a")]); // the doorbell is gone before the adapter read it
    const swept = await b.sweep(60_000);
    expect(swept.dropped).toEqual([]);
    const got = must(await b.next(a));
    expect(got.reply_id).toBe(committed.reply_id);
  });

  test("a reply whose emit outcome is unknown is never resent", async () => {
    const a = await register("a");
    const { admission } = await admitted(a);
    const q = must(await b.ask("a", admission, "?"));
    const c = must(await b.claim(q.question_id));
    must(await b.reply(q.question_id, c.claim_token, "yes"));
    must(await b.next(a)); // reply_emit_intent, then the adapter dies
    await sleep(30);
    const swept = await b.sweep(10);
    expect(swept.stale).toEqual(["a"]);
    expect(await state(q.question_id)).toBe("delivery_unknown");
    await b.sweep(10);
    const a2 = await register("a");
    expect(await b.next(a2)).toMatchObject({ ok: false, code: "empty" });
    expect(await state(q.question_id)).toBe("delivery_unknown");
  });

  test("recovery requeues from the open index when a queue entry is lost", async () => {
    const a = await register("a");
    const sent = must(await b.send({ slot: "a", payload: "x" }));
    await b.exec.execute(["ZREM", key.ready("a"), sent.id]);
    await b.exec.execute(["DEL", key.inbox("a")]);
    expect(await b.next(a)).toMatchObject({ ok: false, code: "empty" });
    const swept = await b.sweep(60_000);
    expect(swept.repaired).toEqual([sent.id]);
    expect(must(await b.next(a)).id).toBe(sent.id);
  });

  test("trimming the streams loses nothing still open", async () => {
    const a = await register("a");
    const sent = must(await b.send({ slot: "a", payload: "x" }));
    await b.exec.execute(["XTRIM", key.inbox("a"), "MAXLEN", 0]);
    await b.exec.execute(["XTRIM", key.feed, "MAXLEN", 0]);
    expect(must(await b.next(a)).id).toBe(sent.id);
  });

  test("expiry applies only to messages no slot has seen, and they never return", async () => {
    const a = await register("a");
    const old = must(await b.send({ slot: "a", payload: "stale", ttl_ms: 20 }));
    await sleep(40);
    const swept = await b.sweep(60_000);
    expect(swept.expired).toEqual([old.id]);
    expect(await state(old.id)).toBe("expired");
    expect(await b.members(key.open)).not.toContain(old.id);
    expect(await b.next(a)).toMatchObject({ ok: false, code: "empty" });

    const live = must(await b.send({ slot: "a", payload: "seen", ttl_ms: 20 }));
    must(await b.next(a));
    await sleep(40);
    await b.sweep(60_000);
    expect(await state(live.id)).toBe("emit_intent");
  });

  test("delivery_unknown and cancelled leave only through resolve, which records its author", async () => {
    await register("a");
    const sent = must(await b.send({ slot: "a", payload: "x" }));
    const a2 = await register("a");
    expect(await state(sent.id)).toBe("cancelled");
    expect(await b.resolve(sent.id, "requeue", "", "op")).toMatchObject({ ok: false, code: "bad_request" });
    must(await b.resolve(sent.id, "requeue", "context was reset before emit", "operator"));
    const got = must(await b.next(a2));
    expect(got.id).toBe(sent.id);
    const last = (await auditFor(sent.id)).find((e) => e.to === "queued" && e.actor.startsWith("resolve:"));
    expect(last).toMatchObject({ actor: "resolve:operator", reason: "context was reset before emit" });
  });

  test("dedup holds while the outcome is open, then for the retention window", async () => {
    const a = await register("a");
    const first = must(await b.send({ slot: "a", payload: "x", idempotency_key: "k-1" }));
    expect(await b.exec.execute(["PTTL", key.dedup("k-1")])).toBe(-1);
    const again = must(await b.send({ slot: "a", payload: "x", idempotency_key: "k-1" }));
    expect(again).toMatchObject({ id: first.id, dedup: true });
    const next = must(await b.next(a));
    must(await b.emitted(a, first.id));
    const ack = must(await b.ackTask(a, first.id, next.attempt_id));
    must(await b.result("a", ack.admission, "completed", "ok"));
    const ttl = (await b.exec.execute(["PTTL", key.dedup("k-1")])) as number;
    expect(ttl).toBeGreaterThan(6 * 24 * 3600 * 1000);
    expect(must(await b.send({ slot: "a", payload: "x", idempotency_key: "k-1" })).id).toBe(first.id);
  });

  test("the hop limit holds for sends and questions", async () => {
    const a = await register("a");
    expect(await b.send({ slot: "a", payload: "x", hop: 5 })).toMatchObject({ ok: false, code: "hop_limit" });
    const sent = must(await b.send({ slot: "a", payload: "x", hop: 4 }));
    const next = must(await b.next(a));
    must(await b.emitted(a, sent.id));
    const ack = must(await b.ackTask(a, sent.id, next.attempt_id));
    expect(await b.ask("a", ack.admission, "?")).toMatchObject({ ok: false, code: "hop_limit" });
  });

  test("a slot cannot reply to a question", async () => {
    // The role boundary itself is an ACL concern (slice 5); here the function
    // refuses without the claim token only the orchestrator holds.
    const a = await register("a");
    const { admission } = await admitted(a);
    const q = must(await b.ask("a", admission, "?"));
    expect(await b.reply(q.question_id, "c-guess", "self-answer")).toMatchObject({ ok: false, code: "not_owner" });
  });

  test("every transition leaves an audit entry", async () => {
    const a = await register("a");
    const { id, admission } = await admitted(a);
    must(await b.result("a", admission, "completed", "ok"));
    expect((await auditFor(id)).map((e) => e.to)).toEqual(["queued", "emit_intent", "emitted", "acked", "completed"]);
  });

  test("an expired question gets a system reply, so the waiting task can go on", async () => {
    const a = await register("a");
    const { admission } = await admitted(a);
    const other = must(await b.send({ slot: "a", payload: "unrelated" }));
    const q = must(await b.ask("a", admission, "?", { ttl_ms: 20 }));
    await sleep(40);
    const swept = await b.sweep(60_000);
    expect(swept.expired).toEqual([q.question_id]);
    expect((await b.askedQuestions()).map((x) => x.id)).not.toContain(q.question_id);
    expect(await b.claim(q.question_id)).toMatchObject({ ok: false, code: "not_asked" });
    const got = must(await b.next(a));
    expect(got).toMatchObject({ kind: "reply", id: q.question_id, attempt_id: admission.attempt_id });
    expect((await b.message(q.question_id)).reply_by).toBe("system");
    must(await b.emitted(a, q.question_id));
    must(await b.ackReply(a, q.question_id, got.reply_id));
    must(await b.result("a", admission, "failed", "no answer"));
    expect(must(await b.next(a)).id).toBe(other.id);
    const feed = (await b.exec.execute(["XRANGE", key.feed, "-", "+"])) as any[];
    expect(feed.map((e) => pairs(e[1])).some((e) => e.id === q.question_id && e.event === "question_expired")).toBe(true);
  });

  test("a stale slot takes its open questions to delivery_unknown", async () => {
    const a = await register("a");
    const { admission } = await admitted(a);
    const asked = must(await b.ask("a", admission, "first?"));
    must(await b.claim(asked.question_id));
    await sleep(30);
    expect((await b.sweep(10)).stale).toEqual(["a"]);
    expect(await b.message(asked.question_id)).toMatchObject({ state: "delivery_unknown", reason: "asker_heartbeat_lost" });
    expect(await b.askedQuestions()).toEqual([]);
    expect(await b.exec.execute(["EXISTS", key.claim(asked.question_id)])).toBe(0);
    expect(await b.exec.execute(["ZRANGE", key.ready("a"), 0, -1])).toEqual([]);
  });

  test("a stale slot takes a committed, undelivered reply to delivery_unknown", async () => {
    const a = await register("a");
    const { admission } = await admitted(a);
    const q = must(await b.ask("a", admission, "?"));
    const c = must(await b.claim(q.question_id));
    must(await b.reply(q.question_id, c.claim_token, "yes"));
    await sleep(30);
    await b.sweep(10);
    expect(await state(q.question_id)).toBe("delivery_unknown");
    const ready = await b.exec.execute(["ZRANGE", key.ready("a"), 0, -1]);
    expect(ready).toEqual([]);
  });

  test("a task that finishes or is resolved closes its open question", async () => {
    const a = await register("a");
    const first = await admitted(a);
    const q1 = must(await b.ask("a", first.admission, "?"));
    must(await b.result("a", first.admission, "completed", "figured it out"));
    expect(await b.message(q1.question_id)).toMatchObject({ state: "closed", reason: "task_finished" });
    expect(await b.claim(q1.question_id)).toMatchObject({ ok: false, code: "not_asked" });

    const second = await admitted(a);
    const q2 = must(await b.ask("a", second.admission, "?"));
    const c = must(await b.claim(q2.question_id));
    must(await b.resolve(second.id, "cancelled", "operator stopped it", "op"));
    expect(await b.message(q2.question_id)).toMatchObject({ state: "closed", reason: "task_resolved" });
    expect(await b.reply(q2.question_id, c.claim_token, "too late")).toMatchObject({ ok: false });
    expect((await b.slotInfo("a")).inflight).toBe("");
  });

  test("a question cannot be closed while its attempt waits for it, and the attempt goes on", async () => {
    const a = await register("a");
    const { admission } = await admitted(a);
    const q = must(await b.ask("a", admission, "?"));
    const refused = await b.resolve(q.question_id, "closed", "no longer needed", "op");
    expect(refused).toMatchObject({ ok: false, code: "task_waiting", task_id: admission.task_id });
    expect(String((refused as any).hint)).toContain(`resolve ${admission.task_id}`);
    expect(await state(q.question_id)).toBe("asked");

    const c = must(await b.claim(q.question_id));
    const committed = must(await b.reply(q.question_id, c.claim_token, "main"));
    expect(await b.resolve(q.question_id, "closed", "no longer needed", "op")).toMatchObject({ ok: false, code: "task_waiting" });
    expect(await state(q.question_id)).toBe("reply_committed");

    // the committed reply is still delivered and the same attempt finishes
    const got = must(await b.next(a));
    expect(got).toMatchObject({ reply_id: committed.reply_id, attempt_id: admission.attempt_id });
    must(await b.emitted(a, q.question_id));
    must(await b.ackReply(a, q.question_id, committed.reply_id));
    must(await b.result("a", admission, "completed", "done"));
  });

  test("a question whose asker is gone can be closed", async () => {
    const a = await register("a");
    const { admission } = await admitted(a);
    const q = must(await b.ask("a", admission, "?"));
    await register("a");
    expect(await state(q.question_id)).toBe("delivery_unknown");
    must(await b.resolve(q.question_id, "closed", "asker reset", "op"));
    expect(await state(q.question_id)).toBe("closed");
  });

  test("requeue is refused while late evidence exists, unless forced", async () => {
    const a1 = await register("a");
    const { admission } = await admitted(a1);
    await register("a");
    await b.result("a", admission, "completed", "already pushed");
    expect(await b.resolve(admission.task_id, "requeue", "retry", "op")).toMatchObject({ ok: false, code: "late_evidence", late_count: 1 });
    must(await b.resolve(admission.task_id, "requeue", "retry after reading late evidence", "op", true));
    expect(await state(admission.task_id)).toBe("queued");
  });

  test("audit and late trails expire with their message, not before", async () => {
    const a1 = await register("a");
    const { admission } = await admitted(a1);
    await register("a");
    await b.result("a", admission, "completed", "late");
    const id = admission.task_id;
    expect(await b.exec.execute(["PTTL", key.late(id)])).toBe(-1);
    expect(await b.exec.execute(["PTTL", key.msgAudit(id)])).toBe(-1);
    must(await b.resolve(id, "failed", "ran twice", "op"));
    for (const k of [key.late(id), key.msgAudit(id), key.msg(id)]) {
      expect((await b.exec.execute(["PTTL", k])) as number).toBeGreaterThan(6 * 24 * 3600 * 1000);
    }
    expect((await b.auditTrail(id)).map((e) => e.to)).toEqual(["queued", "emit_intent", "emitted", "acked", "delivery_unknown", "delivery_unknown", "failed"]);
  });

  test("a malformed ttl is a bad request, not a script error", async () => {
    const a = await register("a");
    const { admission } = await admitted(a);
    const r = JSON.parse(text(await b.exec.execute(["FCALL", "bridge_ask", 1, key.slot("a"), "a", admission.task_id, admission.attempt_id, admission.uuid, admission.epoch, admission.conn_id, "q-x", "?", "soon"])));
    expect(r).toMatchObject({ ok: false, code: "bad_request" });
  });

  test("unregister fences first: an old adapter cannot touch the new registration", async () => {
    const a1 = await register("a");
    const a2 = await register("a");
    const sent = must(await b.send({ slot: "a", payload: "for the new context" }));
    must(await b.next(a2));
    const before = await b.slotInfo("a");
    expect(await b.unregister(a1)).toMatchObject({ ok: false, code: "fenced" });
    expect(await b.slotInfo("a")).toEqual(before);
    expect(await state(sent.id)).toBe("emit_intent");
  });

  test("unregister moves what the adapter held to delivery_unknown and frees inflight", async () => {
    const a = await register("a");
    const { admission } = await admitted(a);
    const q = must(await b.ask("a", admission, "?"));
    must(await b.claim(q.question_id));
    const queued = must(await b.send({ slot: "a", payload: "later" }));
    must(await b.unregister(a));
    expect(await b.message(admission.task_id)).toMatchObject({ state: "delivery_unknown", reason: "unregistered" });
    expect(await b.message(q.question_id)).toMatchObject({ state: "delivery_unknown", reason: "asker_unregistered" });
    expect(await b.exec.execute(["EXISTS", key.claim(q.question_id)])).toBe(0);
    expect(await state(queued.id)).toBe("queued");
    expect(await b.slotInfo("a")).toMatchObject({ conn_id: "", inflight: "", inflight_attempt: "" });
  });

  test("register with a malformed stale_ms is a bad request and changes nothing", async () => {
    const a = await register("a");
    const before = await b.slotInfo("a");
    const r = JSON.parse(text(await b.exec.execute(["FCALL", "bridge_register", 1, key.slot("a"), "a", "u9", "k9", "100", "s1", "/w", "soon"])));
    expect(r).toMatchObject({ ok: false, code: "bad_request" });
    expect(await b.slotInfo("a")).toEqual(before);
    expect(a.epoch).toBe(before.epoch);
  });

  test("functions reject a first key that is not the caller's role key", async () => {
    const a = await register("a");
    const r = JSON.parse(text(await b.exec.execute(["FCALL", "bridge_heartbeat", 1, key.slot("b"), "a", a.conn_id, a.epoch, "0"])));
    expect(r).toMatchObject({ ok: false, code: "bad_request" });
  });
});
