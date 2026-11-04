// The slot's side of the request/response protocol (docs/chatgpt-orchestrator-bridge.md,
// slice 4b). A slot credential reaches three keys only: it appends requests to
// `s:<slot>:out`, reads answers from `s:<slot>:resp`, and reads `s:<slot>:inbox`.
// It cannot call a function, so it cannot change canonical state itself: the
// orchestrator-side ingester (src/ingest.ts) applies each request on its behalf.
//
// A request carries a stable id. Whatever happens to the transport, a retry with
// the same id returns the answer stored the first time, never a second effect.

import { key, newId, pairs, text } from "./store.ts";
import type { Admission, Result, SlotApi, SlotConn } from "./store.ts";
import type { Executor, Reply } from "./valkey.ts";

export interface LinkOptions {
  /** How long to wait for one attempt's answer before sending the same request again. */
  attemptMs?: number;
  /** Attempts per call; the call then fails with an error (the effect may or may not have happened). */
  attempts?: number;
}

export class LinkTimeout extends Error {}

export class SlotLink implements SlotApi {
  private readonly exec: Executor;
  private readonly slot: string;
  private readonly attemptMs: number;
  private readonly attempts: number;
  private cursor: string | null = null;

  constructor(exec: Executor, slot: string, o: LinkOptions = {}) {
    this.exec = exec;
    this.slot = slot;
    this.attemptMs = o.attemptMs ?? 4000;
    this.attempts = o.attempts ?? 3;
  }

  /** Requests are queued under `rid`; answers carry it back. Exposed for tests. */
  async rpc(fn: string, args: readonly string[], rid: string = newId("x")): Promise<Result> {
    const argsJson = JSON.stringify(args);
    if (this.cursor === null) {
      const last = await this.exec.execute(["XREVRANGE", key.resp(this.slot), "+", "-", "COUNT", 1]);
      this.cursor = Array.isArray(last) && last.length > 0 ? text((last[0] as Reply[])[0]!) : "0-0";
    }
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      await this.exec.execute(["XADD", key.out(this.slot), "*", "rid", rid, "fn", fn, "args", argsJson]);
      const deadline = Date.now() + this.attemptMs;
      while (Date.now() < deadline) {
        const wait = Math.max(1, deadline - Date.now());
        const reply = await this.exec.execute(
          ["XREAD", "COUNT", 100, "BLOCK", wait, "STREAMS", key.resp(this.slot), this.cursor],
          { timeout: wait / 1000 + 10 },
        );
        if (!Array.isArray(reply) || reply.length === 0) continue;
        for (const e of (reply[0] as Reply[])[1] as Reply[]) {
          const [id, fields] = e as Reply[];
          this.cursor = text(id!);
          const f = pairs(fields!);
          if (f.rid === rid) return JSON.parse(f.resp!) as Result;
        }
      }
    }
    throw new LinkTimeout(`no answer to ${fn} ${rid}`);
  }

  register(o: { slot: string; uuid: string; conn_id: string; pid: number | string; pid_start: string; cwd: string; stale_ms?: number }) {
    return this.rpc("register", [o.uuid, o.conn_id, String(o.pid), o.pid_start, o.cwd, String(o.stale_ms ?? 30000)]);
  }

  heartbeat(c: SlotConn, busy: boolean) {
    return this.rpc("heartbeat", [c.conn_id, c.epoch, busy ? "1" : "0"]);
  }

  unregister(c: SlotConn) {
    return this.rpc("unregister", [c.conn_id, c.epoch]);
  }

  next(c: SlotConn, attemptId: string = newId("a")) {
    return this.rpc("next", [c.conn_id, c.epoch, attemptId]);
  }

  emitted(c: SlotConn, id: string) {
    return this.rpc("emitted", [c.conn_id, c.epoch, id]);
  }

  emitLost(c: SlotConn) {
    return this.rpc("emit_lost", [c.conn_id, c.epoch]);
  }

  ackTask(c: SlotConn, taskId: string, attemptId: string) {
    return this.rpc("ack_task", [c.conn_id, c.epoch, taskId, attemptId]);
  }

  ackReply(c: SlotConn, questionId: string, replyId: string) {
    return this.rpc("ack_reply", [c.conn_id, c.epoch, questionId, replyId]);
  }

  result(_slot: string, a: Admission, status: "completed" | "failed", payload: string) {
    return this.rpc("result", [a.task_id, a.attempt_id, a.uuid, a.epoch, a.conn_id, status, payload]);
  }

  ask(_slot: string, a: Admission, payload: string, o: { question_id?: string; ttl_ms?: number } = {}) {
    return this.rpc("ask", [
      a.task_id, a.attempt_id, a.uuid, a.epoch, a.conn_id, o.question_id ?? newId("q"), payload, String(o.ttl_ms ?? 0),
    ]);
  }

  async slotInfo(_slot: string): Promise<Record<string, string>> {
    const r = await this.rpc("status", []);
    if (!r.ok) return {};
    const { ok: _ok, ...rest } = r as Record<string, unknown>;
    return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, String(v)]));
  }
}
