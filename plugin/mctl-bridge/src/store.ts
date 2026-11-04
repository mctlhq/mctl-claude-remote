// Typed access to the mctl_bridge function library (src/bridge.lua).
//
// Every state transition is one FCALL; this module only builds arguments and
// parses the JSON each function returns. Rejections come back as
// `{ ok: false, code }` values, never as exceptions: a fenced or late caller is
// an expected event that the caller must handle.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ValkeyError } from "./valkey.ts";
import type { Arg, Executor, Reply } from "./valkey.ts";

export const PREFIX = "mctl:bridge:";
export const LIBRARY_VERSION = "4";
export const LIBRARY_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "bridge.lua");
export const MAX_PAYLOAD = 16384;

export type Result = { ok: true; [key: string]: unknown } | { ok: false; code: string; [key: string]: unknown };

export interface Admission {
  task_id: string;
  attempt_id: string;
  uuid: string;
  epoch: string;
  conn_id: string;
}

export interface SlotConn {
  slot: string;
  conn_id: string;
  epoch: string;
}

/**
 * What the slot adapter needs from the bridge. `Bridge` implements it by calling
 * the functions directly (tests, trusted setups); `SlotLink` implements it over the
 * slot's own request and response streams, which is all a slot credential can reach.
 */
export interface SlotApi {
  register(o: { slot: string; uuid: string; conn_id: string; pid: number | string; pid_start: string; cwd: string; stale_ms?: number }): Promise<Result>;
  heartbeat(c: SlotConn, busy: boolean): Promise<Result>;
  unregister(c: SlotConn): Promise<Result>;
  next(c: SlotConn, attemptId?: string): Promise<Result>;
  emitted(c: SlotConn, id: string): Promise<Result>;
  emitLost(c: SlotConn): Promise<Result>;
  ackTask(c: SlotConn, taskId: string, attemptId: string): Promise<Result>;
  ackReply(c: SlotConn, questionId: string, replyId: string): Promise<Result>;
  result(slot: string, a: Admission, status: "completed" | "failed", payload: string): Promise<Result>;
  ask(slot: string, a: Admission, payload: string, o?: { question_id?: string; ttl_ms?: number }): Promise<Result>;
  slotInfo(slot: string): Promise<Record<string, string>>;
}

export const key = {
  orch: `${PREFIX}orch`,
  open: `${PREFIX}open`,
  asked: `${PREFIX}asked`,
  audit: `${PREFIX}audit`,
  feed: `${PREFIX}outbox`,
  slots: `${PREFIX}slots`,
  msg: (id: string) => `${PREFIX}msg:${id}`,
  slot: (slot: string) => `${PREFIX}s:${slot}:slot`,
  ready: (slot: string) => `${PREFIX}s:${slot}:ready`,
  inbox: (slot: string) => `${PREFIX}s:${slot}:inbox`,
  slotOpen: (slot: string) => `${PREFIX}s:${slot}:open`,
  out: (slot: string) => `${PREFIX}s:${slot}:out`,
  resp: (slot: string) => `${PREFIX}s:${slot}:resp`,
  checkpoint: (slot: string) => `${PREFIX}ingest:${slot}`,
  rejected: (slot: string) => `${PREFIX}rejected:${slot}`,
  allowed: `${PREFIX}slots-allowed`,
  claim: (id: string) => `${PREFIX}claim:${id}`,
  dedup: (k: string) => `${PREFIX}dedup:${k}`,
  late: (id: string) => `${PREFIX}late:${id}`,
  msgAudit: (id: string) => `${PREFIX}audit:${id}`,
  wakes: `${PREFIX}wakes`,
  wake: (id: string) => `${PREFIX}wake:${id}`,
  wakelock: (thread: string) => `${PREFIX}wakelock:${thread}`,
};

export function newId(kind: "t" | "q" | "r" | "a" | "c" | "k" | "w" | "x"): string {
  return `${kind}-${crypto.randomUUID()}`;
}

export function text(reply: Reply): string {
  if (Buffer.isBuffer(reply)) return reply.toString("utf8");
  if (typeof reply === "string") return reply;
  throw new Error(`unexpected reply: ${String(reply)}`);
}

/** Flat [k, v, k, v] reply to an object. */
export function pairs(reply: Reply): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(reply)) return out;
  for (let i = 0; i + 1 < reply.length; i += 2) out[text(reply[i]!)] = text(reply[i + 1]!);
  return out;
}

/** Load or replace the library. Needs a user allowed to run FUNCTION LOAD. */
export async function loadLibrary(exec: Executor): Promise<void> {
  await exec.execute(["FUNCTION", "LOAD", "REPLACE", fs.readFileSync(LIBRARY_PATH, "utf8")]);
}

export class Bridge implements SlotApi {
  readonly exec: Executor;

  constructor(exec: Executor) {
    this.exec = exec;
  }

  async call(fn: string, firstKey: string, args: readonly Arg[]): Promise<Result> {
    for (const arg of args) {
      if (typeof arg === "string" && Buffer.byteLength(arg) > MAX_PAYLOAD + 1024) {
        return { ok: false, code: "bad_request" };
      }
    }
    const reply = await this.exec.execute(["FCALL", fn, 1, firstKey, ...args]);
    return JSON.parse(text(reply)) as Result;
  }

  /** Fails loudly when the server runs another version of the library, or none. */
  async checkVersion(): Promise<void> {
    let found: string;
    try {
      found = text(await this.exec.execute(["FCALL_RO", "bridge_version", 0]));
    } catch (err) {
      if (err instanceof ValkeyError) throw new Error(`mctl_bridge library not loaded: ${err.message}`);
      throw err;
    }
    if (found !== LIBRARY_VERSION) {
      throw new Error(`mctl_bridge library version ${found}, this client needs ${LIBRARY_VERSION}`);
    }
  }

  /**
   * The server's persistence, as the bridge needs it: AOF with fsync on every
   * write. A SIGKILL test cannot tell `always` from `everysec` (the page cache
   * survives a killed process), so this is checked on the live server instead.
   * A config the caller may not read is `unknown`, never `durable`.
   */
  async durability(): Promise<{ status: "durable" | "weak" | "unknown"; appendonly?: string; appendfsync?: string; error?: string }> {
    try {
      const aof = pairs(await this.exec.execute(["CONFIG", "GET", "appendonly"])).appendonly;
      const fsync = pairs(await this.exec.execute(["CONFIG", "GET", "appendfsync"])).appendfsync;
      if (aof === undefined || fsync === undefined) return { status: "unknown", error: "config not returned" };
      return { status: aof === "yes" && fsync === "always" ? "durable" : "weak", appendonly: aof, appendfsync: fsync };
    } catch (err) {
      return { status: "unknown", error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---- slot role ----------------------------------------------------------

  register(o: { slot: string; uuid: string; conn_id: string; pid: number | string; pid_start: string; cwd: string; stale_ms?: number }) {
    return this.call("bridge_register", key.slot(o.slot), [
      o.slot, o.uuid, o.conn_id, String(o.pid), o.pid_start, o.cwd, String(o.stale_ms ?? 30000),
    ]);
  }

  heartbeat(c: SlotConn, busy: boolean) {
    return this.call("bridge_heartbeat", key.slot(c.slot), [c.slot, c.conn_id, c.epoch, busy ? "1" : "0"]);
  }

  unregister(c: SlotConn) {
    return this.call("bridge_unregister", key.slot(c.slot), [c.slot, c.conn_id, c.epoch]);
  }

  /** emit_intent: the next message this slot may receive now, if any. */
  next(c: SlotConn, attemptId: string = newId("a")) {
    return this.call("bridge_next", key.slot(c.slot), [c.slot, c.conn_id, c.epoch, attemptId]);
  }

  emitted(c: SlotConn, id: string) {
    return this.call("bridge_emitted", key.slot(c.slot), [c.slot, c.conn_id, c.epoch, id]);
  }

  /** The reply to `next` was lost: settle what this connection may have left in emit_intent. */
  emitLost(c: SlotConn) {
    return this.call("bridge_emit_lost", key.slot(c.slot), [c.slot, c.conn_id, c.epoch]);
  }

  ackTask(c: SlotConn, taskId: string, attemptId: string) {
    return this.call("bridge_ack_task", key.slot(c.slot), [c.slot, c.conn_id, c.epoch, taskId, attemptId]);
  }

  ackReply(c: SlotConn, questionId: string, replyId: string) {
    return this.call("bridge_ack_reply", key.slot(c.slot), [c.slot, c.conn_id, c.epoch, questionId, replyId]);
  }

  private admissionArgs(slot: string, a: Admission): string[] {
    return [slot, a.task_id, a.attempt_id, a.uuid, a.epoch, a.conn_id];
  }

  result(slot: string, a: Admission, status: "completed" | "failed", payload: string) {
    return this.call("bridge_result", key.slot(slot), [...this.admissionArgs(slot, a), status, payload]);
  }

  ask(slot: string, a: Admission, payload: string, o: { question_id?: string; ttl_ms?: number } = {}) {
    return this.call("bridge_ask", key.slot(slot), [
      ...this.admissionArgs(slot, a), o.question_id ?? newId("q"), payload, String(o.ttl_ms ?? 0),
    ]);
  }

  // ---- orchestrator role --------------------------------------------------

  send(o: { slot: string; payload: string; id?: string; hop?: number; ttl_ms?: number; idempotency_key?: string }) {
    return this.call("bridge_send", key.orch, [
      o.id ?? newId("t"), o.slot, o.payload, String(o.hop ?? 0), String(o.ttl_ms ?? 0), o.idempotency_key ?? "",
    ]);
  }

  claim(questionId: string, o: { token?: string; lease_ms?: number } = {}) {
    return this.call("bridge_claim", key.orch, [questionId, o.token ?? newId("c"), String(o.lease_ms ?? 120000)]);
  }

  renew(questionId: string, token: string, leaseMs = 120000) {
    return this.call("bridge_renew", key.orch, [questionId, token, String(leaseMs)]);
  }

  reply(questionId: string, token: string, payload: string, replyId: string = newId("r")) {
    return this.call("bridge_reply", key.orch, [questionId, token, replyId, payload]);
  }

  /** `force` requeues even though late evidence shows an earlier attempt acted. */
  resolve(id: string, as: string, reason: string, author: string, force = false) {
    return this.call("bridge_resolve", key.orch, [id, as, reason, author, force ? "1" : "0"]);
  }

  expire(id: string) {
    return this.call("bridge_expire", key.orch, [id]);
  }

  slotStale(slot: string, staleMs: number) {
    return this.call("bridge_slot_stale", key.orch, [slot, String(staleMs)]);
  }

  repair(id: string) {
    return this.call("bridge_repair", key.orch, [id]);
  }

  // ---- wakes (orchestrator role) ---------------------------------------------

  wakeBegin(o: { question_id: string; thread_id: string; wake_id?: string; lock_ms: number; per_hour: number; quiet_ms: number; per_question?: number }) {
    return this.call("bridge_wake_begin", key.orch, [
      o.question_id, o.thread_id, o.wake_id ?? newId("w"), String(o.lock_ms), String(o.per_hour),
      String(o.quiet_ms), String(o.per_question ?? 2),
    ]);
  }

  wakeStarted(id: string, turnId: string) {
    return this.call("bridge_wake_started", key.orch, [id, turnId]);
  }

  wakeFinish(id: string, outcome: "completed" | "failed" | "wake_unknown", reason = "") {
    return this.call("bridge_wake_finish", key.orch, [id, outcome, reason]);
  }

  wakeResolve(id: string, reason: string, author: string) {
    return this.call("bridge_wake_resolve", key.orch, [id, reason, author]);
  }

  async wake(id: string): Promise<Record<string, string>> {
    return pairs(await this.exec.execute(["HGETALL", key.wake(id)]));
  }

  /** Wakes not yet settled: intent, started and wake_unknown. */
  async openWakes(): Promise<Array<Record<string, string>>> {
    const out = [];
    for (const id of await this.members(key.wakes)) out.push({ id, ...(await this.wake(id)) });
    return out;
  }

  // ---- reads ----------------------------------------------------------------

  async message(id: string): Promise<Record<string, string>> {
    return pairs(await this.exec.execute(["HGETALL", key.msg(id)]));
  }

  async slotInfo(slot: string): Promise<Record<string, string>> {
    return pairs(await this.exec.execute(["HGETALL", key.slot(slot)]));
  }

  async members(setKey: string): Promise<string[]> {
    const reply = await this.exec.execute(["SMEMBERS", setKey]);
    return Array.isArray(reply) ? reply.map(text).sort() : [];
  }

  async openMessages(): Promise<Array<Record<string, string>>> {
    const out = [];
    for (const id of await this.members(key.open)) out.push({ id, ...(await this.message(id)) });
    return out;
  }

  /** Questions waiting for a reply, with whether a live claim holds them. */
  async askedQuestions(): Promise<Array<Record<string, string>>> {
    const reply = await this.exec.execute(["ZRANGE", key.asked, 0, -1]);
    const out = [];
    for (const id of Array.isArray(reply) ? reply.map(text) : []) {
      const claimed = (await this.exec.execute(["EXISTS", key.claim(id)])) === 1;
      out.push({ id, claimed: claimed ? "1" : "0", ...(await this.message(id)) });
    }
    return out;
  }

  /** One message's own bounded trail; never scans the global audit stream. */
  async auditTrail(id: string): Promise<Array<Record<string, string>>> {
    const reply = await this.exec.execute(["XRANGE", key.msgAudit(id), "-", "+"]);
    return Array.isArray(reply) ? reply.map((e) => ({ entry: text((e as Reply[])[0]!), ...pairs((e as Reply[])[1]!) })) : [];
  }

  async late(taskId: string): Promise<Array<Record<string, string>>> {
    const reply = await this.exec.execute(["XRANGE", key.late(taskId), "-", "+"]);
    return Array.isArray(reply) ? reply.map((e) => ({ entry: text((e as Reply[])[0]!), ...pairs((e as Reply[])[1]!) })) : [];
  }

  /**
   * Sweep: expiry, stale slots, then recovery over the open index. Runs from
   * the open set, never from streams, so a trimmed or lost stream changes
   * nothing.
   */
  async sweep(staleMs: number): Promise<{ expired: string[]; stale: string[]; repaired: string[]; dropped: string[] }> {
    const out = { expired: [] as string[], stale: [] as string[], repaired: [] as string[], dropped: [] as string[] };
    for (const slot of await this.members(key.slots)) {
      const r = await this.slotStale(slot, staleMs);
      if (r.ok && r.stale) out.stale.push(slot);
    }
    for (const id of await this.members(key.open)) {
      const e = await this.expire(id);
      if (e.ok && e.expired) {
        out.expired.push(id);
        continue;
      }
      const r = await this.repair(id);
      if (r.ok && r.action === "requeued") out.repaired.push(id);
      if (r.ok && r.action === "dropped") out.dropped.push(id);
    }
    return out;
  }
}
