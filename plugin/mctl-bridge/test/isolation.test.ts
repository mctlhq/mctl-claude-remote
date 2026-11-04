// Slice 4b: slot credentials reach their own streams and nothing else; the
// orchestrator-side ingester applies every request. Two adversarial slots, a real
// server with real ACLs.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Adapter } from "../src/channel.ts";
import type { Config } from "../src/channel.ts";
import { Ingester } from "../src/ingest.ts";
import { SlotLink } from "../src/slotlink.ts";
import { Bridge, key, newId, pairs, text } from "../src/store.ts";
import type { Admission, Result } from "../src/store.ts";
import { ValkeyError } from "../src/valkey.ts";
import type { Connection, Reply } from "../src/valkey.ts";
import { FakeClaude, SERVER_LIMITS, ValkeyServer, requiresValkey, sleep } from "./support.ts";

let server: ValkeyServer;
let b: Bridge; // the orchestrator role
let ingester: Ingester;
let raw: Connection; // full access, for looking at what happened
type Slot = Awaited<ReturnType<ValkeyServer["addSlot"]>>;
let A: Slot;
let B: Slot;

const must = (r: Result): Record<string, any> => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Record<string, any>;
};

let pumping: Promise<void> | null = null;

/** Wait until the background ingester has consumed every request staged so far. */
async function settle(): Promise<number> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const left = await Promise.all(["a", "b"].map((s) => raw.execute(["XLEN", key.out(s)])));
    if (left.every((n) => n === 0)) return 0;
    if (Date.now() > deadline) throw new Error("ingester did not drain the request streams");
    await sleep(10);
  }
}

async function denied(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ValkeyError);
    expect((err as Error).message).toMatch(/NOPERM|permission/i);
    return;
  }
  throw new Error("expected NOPERM, the command was allowed");
}

async function responses(slot: string): Promise<Array<Record<string, string>>> {
  const r = await raw.execute(["XRANGE", key.resp(slot), "-", "+"]);
  return (r as Reply[]).map((e) => pairs((e as Reply[])[1]!));
}

/** A request put on the stream by hand, the way a hostile adapter would. */
function submit(slot: Slot, f: Record<string, string>, extra: Array<string | number> = []) {
  return slot.client().execute(["XADD", key.out(slot.user.replace("bridge_slot_", "")), ...extra, "*", ...Object.entries(f).flat()]);
}

async function register(slot: string, uuid = `u-${slot}`): Promise<{ conn_id: string; epoch: string }> {
  const conn_id = newId("k");
  const r = must(await new SlotLink(slot === "a" ? A.client() : B.client(), slot).register({
    slot, uuid, conn_id, pid: 1, pid_start: "t", cwd: "/tmp",
  }));
  await settle();
  return { conn_id, epoch: String(r.epoch) };
}

describe.skipIf(requiresValkey)("slot isolation", () => {
  beforeAll(async () => {
    server = await ValkeyServer.start();
  });
  afterAll(async () => {
    await server.stop();
  });
  beforeEach(async () => {
    raw = server.client();
    await raw.execute(["FLUSHALL"]);
    await raw.execute(["ACL", "DELUSER", "bridge_slot_a", "bridge_slot_b"]);
    b = await server.bridge();
    A = await server.addSlot("a");
    B = await server.addSlot("b");
    ingester = new Ingester(b);
    pumping = ingester.run(50);
  });
  afterEach(async () => {
    ingester.stop();
    await pumping;
  });

  test("a slot credential reaches its own streams and nothing else", async () => {
    const a = A.client();
    expect(await a.execute(["PING"])).toBe("PONG");
    await a.execute(["XADD", key.out("a"), "*", "rid", "x-1", "fn", "status", "args", "[]"]);
    await a.execute(["XREAD", "COUNT", 1, "STREAMS", key.resp("a"), "0-0"]);
    await a.execute(["XREAD", "COUNT", 1, "STREAMS", key.inbox("a"), "0-0"]);

    await denied(a.execute(["FCALL", "bridge_register", 1, key.slot("a"), "a", "u", "k", "1", "t", "/", "30000"]));
    await denied(a.execute(["FCALL_RO", "bridge_version", 0]));
    await denied(a.execute(["EVAL", "return 1", 0]));
    await denied(a.execute(["FUNCTION", "LIST"]));
    await denied(a.execute(["GET", key.msg("t-1")]));
    await denied(a.execute(["HGETALL", key.slot("a")])); // its own registration is not readable either
    await denied(a.execute(["XADD", key.out("b"), "*", "rid", "x", "fn", "status", "args", "[]"])); // B's requests
    await denied(a.execute(["XADD", key.resp("a"), "*", "rid", "x-1", "resp", '{"ok":true}'])); // forge an answer
    await denied(a.execute(["XADD", key.inbox("a"), "*", "id", "t-1"])); // forge a delivery
    await denied(a.execute(["XREAD", "COUNT", 1, "STREAMS", key.resp("b"), "0-0"])); // B's answers
    await denied(a.execute(["XREAD", "COUNT", 1, "STREAMS", key.audit, "0-0"]));
    await denied(a.execute(["DEL", key.out("a")]));
    await denied(a.execute(["KEYS", "*"]));
    await denied(a.execute(["CONFIG", "GET", "appendfsync"]));
    await denied(a.execute(["ACL", "LIST"]));
    await denied(a.execute(["SADD", key.allowed, "zz"]));
  });

  test("refused attempts change nothing: registration, epoch, inflight, task", async () => {
    const a = await register("a");
    const t = must(await b.send({ slot: "a", payload: "work" }));
    const snapshot = async () => ({
      slot: await b.slotInfo("a"),
      task: await b.message(t.id),
      open: await b.members(key.open),
      audit: await raw.execute(["XLEN", key.audit]),
      resp: await raw.execute(["XLEN", key.resp("a")]),
    });
    const before = await snapshot();
    const c = A.client();
    await denied(c.execute(["FCALL", "bridge_register", 1, key.slot("a"), "a", "u-evil", "k-evil", "1", "t", "/", "30000"]));
    await denied(c.execute(["FCALL", "bridge_ack_task", 1, key.slot("a"), "a", a.conn_id, a.epoch, t.id, "a-x"]));
    await denied(c.execute(["HSET", key.slot("a"), "epoch", "99", "inflight", t.id]));
    await denied(c.execute(["HSET", key.msg(t.id), "state", "completed"]));
    expect(await snapshot()).toEqual(before);
    expect(before.slot.epoch).toBe(a.epoch);
  });

  test("a request naming another slot cannot touch it: identity comes from the stream", async () => {
    const regA = await register("a");
    const regB = await register("b");
    const t = must(await b.send({ slot: "b", payload: "B's work" }));
    // B takes the task and acknowledges it through the legitimate path.
    must(await b.heartbeat({ slot: "b", ...regB }, false));
    const attempt = newId("a");
    must(await b.next({ slot: "b", ...regB }, attempt));
    const ack = must(await b.ackTask({ slot: "b", ...regB }, t.id, attempt));
    const adm = ack.admission as Admission;

    // A knows everything about B's admission and tries to finish B's task from its own stream.
    await submit(A, {
      rid: "x-forged", fn: "result", slot: "b", from: "b",
      args: JSON.stringify([adm.task_id, adm.attempt_id, adm.uuid, adm.epoch, adm.conn_id, "completed", "forged"]),
    });
    // And to register as B, and to heartbeat B's connection.
    await submit(A, { rid: "x-forged-2", fn: "heartbeat", slot: "b", args: JSON.stringify([regB.conn_id, regB.epoch, "0"]) });
    await settle();

    expect((await b.message(t.id)).state).toBe("acked");
    expect((await b.message(t.id)).result).toBeUndefined();
    const answers = Object.fromEntries((await responses("a")).map((r) => [r.rid, JSON.parse(r.resp!)]));
    expect(answers["x-forged"]).toMatchObject({ ok: false, code: "unknown_task" });
    expect(answers["x-forged-2"]).toMatchObject({ ok: false, code: "fenced" }); // A's slot has another conn_id
    expect((await responses("b")).filter((r) => r.rid.startsWith("x-forged"))).toEqual([]); // nothing was answered to B
    expect((await b.slotInfo("b")).conn_id).toBe(regB.conn_id);
    expect(regA.epoch).toBe("1");
  });

  test("a retried request id returns the stored answer and applies nothing twice", async () => {
    const link = new SlotLink(A.client(), "a");
    const reg = ["u-1", newId("k"), "7", "t0", "/tmp", "30000"];
    const first = must(await link.rpc("register", reg, "x-reg"));
    const again = must(await link.rpc("register", reg, "x-reg"));
    expect(again).toEqual(first);
    expect((await b.slotInfo("a")).epoch).toBe("1"); // not 2
  });

  test("a lost ack_task answer is recovered: same grant, one acknowledgement", async () => {
    const reg = await register("a");
    const t = must(await b.send({ slot: "a", payload: "work" }));
    const link = new SlotLink(A.client(), "a");
    must(await link.heartbeat({ slot: "a", ...reg }, false));
    const attempt = newId("a");
    must(await link.next({ slot: "a", ...reg }, attempt));
    const args = [reg.conn_id, reg.epoch, t.id, attempt];

    // The request reaches the ingester; the adapter never sees the answer.
    await submit(A, { rid: "x-ack", fn: "ack_task", args: JSON.stringify(args) });
    await settle();
    const lost = (await responses("a")).filter((r) => r.rid === "x-ack");
    expect(lost.length).toBe(1);

    // It asks again with the same id.
    const grant = must(await link.rpc("ack_task", args, "x-ack"));
    expect(grant.admission).toMatchObject({ task_id: t.id, attempt_id: attempt, epoch: reg.epoch, conn_id: reg.conn_id });
    expect(JSON.parse(lost[0]!.resp!)).toEqual(grant);
    const trail = (await b.auditTrail(t.id)).filter((e) => e.to === "acked");
    expect(trail.length).toBe(1);
  });

  test("a request delayed across an epoch change grants nothing", async () => {
    const old = await register("a", "u-old");
    const t = must(await b.send({ slot: "a", payload: "work" }));
    const link = new SlotLink(A.client(), "a");
    must(await link.heartbeat({ slot: "a", ...old }, false));
    const attempt = newId("a");
    must(await link.next({ slot: "a", ...old }, attempt));

    // A new adapter registers; the old adapter's ack_task only reaches the orchestrator afterwards.
    const fresh = await register("a", "u-new");
    expect(Number(fresh.epoch)).toBe(Number(old.epoch) + 1);
    await submit(A, { rid: "x-late", fn: "ack_task", args: JSON.stringify([old.conn_id, old.epoch, t.id, attempt]) });
    await settle();
    const late = (await responses("a")).find((r) => r.rid === "x-late");
    expect(JSON.parse(late!.resp!)).toMatchObject({ ok: false, code: "fenced" });
    expect((await b.message(t.id)).state).not.toBe("acked");
  });

  test("an invalid entry is rejected once and does not block a valid one with the same request id", async () => {
    await submit(A, { rid: "x-dup", fn: "no_such_function", args: "[]" });
    await submit(A, { rid: "x-dup", fn: "status", args: "[]" });
    await submit(A, { fn: "status", args: "[]" }); // no request id at all
    await submit(A, { rid: "x-bad", fn: "status", args: "not json" });
    await submit(A, { rid: "x-nested", fn: "status", args: '[["a"]]' });
    await submit(A, { rid: "x-huge", fn: "status", args: JSON.stringify(["z".repeat(50000)]) });
    await settle();
    const rejected = (await raw.execute(["XRANGE", key.rejected("a"), "-", "+"])) as Reply[];
    expect(rejected.map((e) => pairs((e as Reply[])[1]!).reason)).toEqual([
      "unknown_fn", "bad_rid", "bad_args", "bad_args", "too_large",
    ]);
    const answers = Object.fromEntries((await responses("a")).map((r) => [r.rid, JSON.parse(r.resp!)]));
    expect(answers["x-dup"]).toMatchObject({ ok: true }); // the later valid one, not the rejection
    expect(await raw.execute(["GET", key.checkpoint("a")])).not.toBeNull();
    // Another slot keeps working.
    const bb = must(await new SlotLink(B.client(), "b").rpc("status", []));
    await settle();
    expect(bb.ok).toBe(true);
  });

  test("the same request id for a different request is refused", async () => {
    const link = new SlotLink(A.client(), "a");
    must(await link.rpc("status", [], "x-1"));
    await submit(A, { rid: "x-1", fn: "heartbeat", args: JSON.stringify(["k", "1", "0"]) });
    await settle();
    const reasons = ((await raw.execute(["XRANGE", key.rejected("a"), "-", "+"])) as Reply[]).map(
      (e) => pairs((e as Reply[])[1]!).reason,
    );
    expect(reasons).toEqual(["rid_conflict"]);
  });

  test("replaying an entry, or restarting the consumer, applies nothing twice", async () => {
    const reg = await register("a");
    const before = await raw.execute(["XLEN", key.audit]);
    const entries = (await raw.execute(["XRANGE", key.resp("a"), "-", "+"])) as Reply[];
    expect(entries.length).toBeGreaterThan(0);
    // A new consumer starts from the stored checkpoint.
    ingester.stop();
    await pumping;
    const restarted = new Ingester(b);
    expect(await restarted.step()).toBe(0);
    // The same entry id handed to the function again is skipped.
    const cp = text((await raw.execute(["GET", key.checkpoint("a")]))!);
    const r = JSON.parse(
      text((await raw.execute(["FCALL", "bridge_ingest", 1, key.orch, "a", cp, "x-replay", "status", "[]"]))!),
    );
    expect(r).toMatchObject({ ok: true, skipped: true });
    expect(await raw.execute(["XLEN", key.audit])).toBe(before);
    expect((await b.slotInfo("a")).epoch).toBe(reg.epoch);
  });

  test("a trimmed request has no receipt and is retried; an answered one stays recoverable", async () => {
    const link = new SlotLink(A.client(), "a", { attemptMs: 300, attempts: 4 });
    const reg = ["u-1", newId("k"), "7", "t0", "/tmp", "30000"];
    // The request is staged and trimmed away by its own sender before ingestion.
    await submit(A, { rid: "x-trim", fn: "register", args: JSON.stringify(reg) }, ["MAXLEN", 0]);
    await submit(A, { rid: "x-trim-2", fn: "register", args: JSON.stringify(reg) }, ["MINID", `${Date.now() + 3_600_000}-0`]);
    await sleep(150);
    expect(await responses("a")).toEqual([]); // no success without ingestion
    expect((await b.slotInfo("a")).epoch).toBeUndefined();

    const r = must(await link.rpc("register", reg, "x-trim"));
    expect(r.epoch).toBe("1");

    // Once answered, the payload lives in a key the slot cannot trim.
    await submit(A, { rid: "x-wipe", fn: "status", args: "[]" }, ["MAXLEN", 0]);
    expect(text((await raw.execute(["HGET", "mctl:bridge:rpc:a:x-trim", "args"]))!)).toBe(JSON.stringify(reg));
  });

  test("a poison entry is recorded and skipped instead of blocking the slot", async () => {
    await submit(A, { rid: "x-1", fn: "status", args: "[]" });
    const bad = text(
      (await raw.execute(["XADD", key.out("a"), "*", "rid", "x-2", "fn", "status", "args", "[]"]))!,
    );
    const r = JSON.parse(text((await raw.execute(["FCALL", "bridge_ingest_poison", 1, key.orch, "a", bad, "handler_error"]))!));
    expect(r.ok).toBe(true);
    expect(text((await raw.execute(["GET", key.checkpoint("a")]))!)).toBe(bad);
    const rej = (await raw.execute(["XRANGE", key.rejected("a"), "-", "+"])) as Reply[];
    expect(pairs((rej[0] as Reply[])[1]!).reason).toBe("handler_error");
  });

  test("a request whose handler raises is answered once and never reruns on retry", async () => {
    // A string where the slot hash should be makes the handler raise WRONGTYPE.
    await raw.execute(["SET", "mctl:bridge:s:a:slot", "not a hash"]);
    await submit(A, { rid: "x-boom", fn: "status", args: "[]" });
    await settle();
    const first = (await responses("a")).filter((r) => r.rid === "x-boom");
    expect(first.length).toBe(1);
    expect(JSON.parse(first[0]!.resp!)).toMatchObject({ ok: false, code: "rejected", reason: "handler_error" });
    expect(text((await raw.execute(["HGET", "mctl:bridge:rpc:a:x-boom", "fn"]))!)).toBe("status");

    // The fault is gone, the slot retries the same id: the stored answer comes back and
    // the handler does not run (a rerun would now succeed).
    await raw.execute(["DEL", "mctl:bridge:s:a:slot"]);
    await submit(A, { rid: "x-boom", fn: "status", args: "[]" });
    await settle();
    const again = (await responses("a")).filter((r) => r.rid === "x-boom");
    expect(again.length).toBe(2);
    expect(again[1]!.resp).toBe(first[0]!.resp);

    // Another request under the same id is still a conflict, and a new id works.
    await submit(A, { rid: "x-boom", fn: "heartbeat", args: "[]" });
    await submit(A, { rid: "x-fresh", fn: "status", args: "[]" });
    await settle();
    const all = await responses("a");
    expect(JSON.parse(all.filter((r) => r.rid === "x-boom")[2]!.resp!)).toMatchObject({ code: "rejected", reason: "rid_conflict" });
    expect(JSON.parse(all.find((r) => r.rid === "x-fresh")!.resp!)).toMatchObject({ ok: true });
  });

  test("the server refuses an oversize request from a slot and changes nothing", async () => {
    const before = await raw.execute(["XLEN", key.out("a")]);
    const dbsize = await raw.execute(["DBSIZE"]);
    let refused = false;
    try {
      await submit(A, { rid: "x-big", fn: "status", args: JSON.stringify(["z".repeat(2 * 1024 * 1024)]) });
    } catch {
      refused = true; // an error reply or a closed connection: both are a refusal
    }
    expect(refused).toBe(true);
    expect(await raw.execute(["XLEN", key.out("a")])).toBe(before);
    expect(await raw.execute(["DBSIZE"])).toBe(dbsize);
    // The server and the slot's credentials are fine afterwards.
    must(await new SlotLink(A.client(), "a").rpc("status", []));
  });

  test("ops/install.sh writes the same server limits the tests run with", () => {
    const conf = fs.readFileSync(path.join(import.meta.dir, "../ops/install.sh"), "utf8");
    for (const [k, v] of SERVER_LIMITS) expect(conf).toContain(`\n${k} ${v}\n`);
  });
});

// ---- the adapter over the request streams -------------------------------------

describe.skipIf(requiresValkey)("slot adapter over rpc", () => {
  let stateDir: string;
  let pwFile: string;
  const clients: FakeClaude[] = [];
  let pump: Promise<void>;

  beforeAll(async () => {
    server = await ValkeyServer.start();
  });
  afterAll(async () => {
    await server.stop();
  });
  beforeEach(async () => {
    raw = server.client();
    await raw.execute(["FLUSHALL"]);
    await raw.execute(["ACL", "DELUSER", "bridge_slot_a"]);
    b = await server.bridge();
    A = await server.addSlot("a");
    ingester = new Ingester(b);
    pump = ingester.run(50);
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-"));
    pwFile = path.join(stateDir, "slot.pw");
    fs.writeFileSync(pwFile, A.password, { mode: 0o600 });
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.kill();
    ingester.stop();
    await pump;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test("acceptance: task, question, reply, result with a credential that cannot call functions", async () => {
    const c = new FakeClaude(A.url, "a", {
      stateDir,
      env: { MCTL_BRIDGE_TRANSPORT: "rpc", MCTL_BRIDGE_VALKEY_PASSWORD_FILE: pwFile },
    });
    clients.push(c);
    c.hook("idle", "s-1");
    await c.handshake();
    for (let i = 0; i < 200 && (await b.slotInfo("a")).busy !== "0"; i++) await sleep(25);
    expect((await b.slotInfo("a")).uuid).toBe("s-1");

    const t = must(await b.send({ slot: "a", payload: "rename the module" }));
    const ev = await c.notification();
    expect(ev.params.meta).toMatchObject({ kind: "task", task_id: t.id });
    const attempt = ev.params.meta.attempt_id;
    c.hook("busy", "s-1");
    expect((await c.call("ack_task", { task_id: t.id, attempt_id: attempt })).isError).toBe(false);
    const asked = await c.call("ask_orchestrator", { task_id: t.id, question: "keep the alias?" });
    expect(asked.isError).toBe(false);
    c.hook("idle", "s-1");

    const claim = must(await b.claim(asked.body.question_id));
    const rep = must(await b.reply(asked.body.question_id, claim.claim_token, "yes, for one release"));
    const replyEv = await c.notification();
    expect(replyEv.params.meta).toMatchObject({ kind: "reply", reply_id: rep.reply_id, attempt_id: attempt });
    c.hook("busy", "s-1");
    expect((await c.call("ack_reply", { question_id: asked.body.question_id, reply_id: rep.reply_id })).isError).toBe(false);
    expect((await c.call("report_result", { task_id: t.id, status: "completed", summary: "done" })).isError).toBe(false);
    expect(await b.message(t.id)).toMatchObject({ state: "completed", attempt_id: attempt, result: "done" });
    expect((await b.message(asked.body.question_id)).state).toBe("reply_acknowledged");
  });
});

// ---- the grant belongs to one registration ---------------------------------------

describe.skipIf(requiresValkey)("admission grant", () => {
  beforeAll(async () => {
    server = await ValkeyServer.start();
  });
  afterAll(async () => {
    await server.stop();
  });

  test("a grant from an earlier registration starts no work", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-"));
    try {
      await server.client().execute(["FLUSHALL"]);
      const bridge = await server.bridge();
      const pid = 424242;
      fs.writeFileSync(path.join(stateDir, `${pid}.json`), JSON.stringify({ session_id: "s-1", state: "idle", t: Date.now() / 1000 }));
      // A link that answers ack_task with a grant minted for another connection.
      class Replay extends Bridge {
        override async ackTask(c: Parameters<Bridge["ackTask"]>[0], taskId: string, attemptId: string): Promise<Result> {
          const real = must(await super.ackTask(c, taskId, attemptId));
          return { ...real, ok: true, admission: { ...(real.admission as Admission), conn_id: "k-an-earlier-session" } } as unknown as Result;
        }
      }
      const link = new Replay(server.client());
      const cfg: Config = {
        slot: "a", stateDir, claudePid: pid, pollMs: 10, heartbeatMs: 1000, graceMs: 0,
        emitHoldMs: 5000, initialSessionId: "s-1", cwd: "/tmp",
      };
      const sent: unknown[] = [];
      const adapter = new Adapter(link, cfg, async (m) => void sent.push(m));
      await adapter.tick(); // registers
      must(await bridge.send({ slot: "a", payload: "work" }));
      await adapter.tick(); // heartbeat idle
      await adapter.tick(); // next -> notification
      expect(sent.length).toBe(1);
      const meta = (sent[0] as any).params.meta;
      const r: any = await adapter.call("ack_task", { task_id: meta.task_id, attempt_id: meta.attempt_id });
      expect(r).toMatchObject({ ok: false, code: "stale_grant" });
      await expect(adapter.call("report_result", { task_id: meta.task_id, status: "completed", summary: "x" })).rejects.toThrow(
        /no admission/,
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("a grant whose connection was replaced meanwhile starts no work", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-"));
    try {
      await server.client().execute(["FLUSHALL"]);
      const bridge = await server.bridge();
      const pid = 424243;
      fs.writeFileSync(path.join(stateDir, `${pid}.json`), JSON.stringify({ session_id: "s-1", state: "idle", t: Date.now() / 1000 }));
      let swap: (() => void) | null = null;
      class Swap extends Bridge {
        override async ackTask(c: Parameters<Bridge["ackTask"]>[0], taskId: string, attemptId: string): Promise<Result> {
          const real = await super.ackTask(c, taskId, attemptId);
          swap?.(); // the adapter re-registered while the answer was on its way
          return real;
        }
      }
      const cfg: Config = {
        slot: "a", stateDir, claudePid: pid, pollMs: 10, heartbeatMs: 1000, graceMs: 0,
        emitHoldMs: 5000, initialSessionId: "s-1", cwd: "/tmp",
      };
      const sent: unknown[] = [];
      const adapter = new Adapter(new Swap(server.client()), cfg, async (m) => void sent.push(m));
      swap = () => void ((adapter as any).conn = { ...(adapter as any).conn });
      await adapter.tick();
      must(await bridge.send({ slot: "a", payload: "work" }));
      await adapter.tick();
      await adapter.tick();
      const meta = (sent[0] as any).params.meta;
      const r: any = await adapter.call("ack_task", { task_id: meta.task_id, attempt_id: meta.attempt_id });
      expect(r).toMatchObject({ ok: false, code: "stale_grant" });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(requiresValkey)("rpc retries", () => {
  beforeAll(async () => {
    server = await ValkeyServer.start();
  });
  afterAll(async () => {
    await server.stop();
  });

  test("an unanswered request is repeated under the same id and applied once", async () => {
    const raw2 = server.client();
    await raw2.execute(["FLUSHALL"]);
    const bridge = await server.bridge();
    const c = await server.addSlot("c");
    await raw2.execute(["SREM", key.allowed, "c"]); // not served yet
    const ing = new Ingester(bridge);
    const pump = ing.run(50);
    try {
      const link = new SlotLink(c.client(), "c", { attemptMs: 300, attempts: 6 });
      setTimeout(() => void raw2.execute(["SADD", key.allowed, "c"]), 450);
      const reg = ["u-1", newId("k"), "7", "t0", "/tmp", "30000"];
      const r = must(await link.rpc("register", reg, "x-retry"));
      expect(r.epoch).toBe("1");
      expect((await bridge.slotInfo("c")).epoch).toBe("1"); // however many copies were queued
      await sleep(300);
      const memos = (await raw2.execute(["KEYS", "mctl:bridge:rpc:c:*"])) as Reply[];
      expect(memos.map((k) => text(k!))).toEqual(["mctl:bridge:rpc:c:x-retry"]); // every copy carried the same id
    } finally {
      ing.stop();
      await pump;
    }
  });
});
