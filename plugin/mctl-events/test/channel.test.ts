// Integration tests against a real valkey-server, skipped when none is
// installed. Ported from events/tests/test_channel.py.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { Adapter, AUDIT_STREAM, PENDING_BATCH } from "../src/channel.ts";
import type { Message as ChannelMessage } from "../src/channel.ts";
import * as policyMod from "../src/policy.ts";
import { pyJson } from "../src/util.ts";
import { ValkeyConnectionError } from "../src/valkey.ts";
import type { Arg, Connection, ExecuteOptions, Reply } from "../src/valkey.ts";
import { envelope, FakeClaude, POLICY, requiresValkey, sleep, str, ValkeyServer } from "./support.ts";

const STREAM = "mctl:events:telegram";
const json = (value: unknown): string => pyJson(value);

function pairs(flat: Reply): Map<string, string> {
  const items = flat as Reply[];
  const out = new Map<string, string>();
  for (let i = 0; i + 1 < items.length; i += 2) out.set(str(items[i]!), str(items[i + 1]!));
  return out;
}

async function pendingCount(db: Connection): Promise<number> {
  return ((await db.execute(["XPENDING", STREAM, "claude-remote"])) as Reply[])[0] as number;
}

describe("walking skeleton", { skip: requiresValkey }, () => {
  let valkey: ValkeyServer;
  let db: Connection;
  let claude: FakeClaude;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    valkey = await ValkeyServer.start();
    db = valkey.client();
    claude = new FakeClaude(valkey.url, POLICY);
  });

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
    await claude.close();
    await valkey.stop();
  });

  function spawnClaude(policy: Record<string, unknown>): FakeClaude {
    const replacement = new FakeClaude(valkey.url, policy);
    cleanups.push(() => replacement.close());
    return replacement;
  }

  async function publish(doc: unknown): Promise<string> {
    return str(await db.execute(["XADD", STREAM, "*", "envelope", json(doc)]));
  }

  async function waitForGroup(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await db.execute(["EXISTS", STREAM])) {
        const groups = (await db.execute(["XINFO", "GROUPS", STREAM])) as Reply[];
        if (groups.length) return;
      }
      await sleep(50);
    }
    throw new Error("consumer group never created");
  }

  /** Audit writes are asynchronous: poll until the expected stages land. */
  async function auditStages(eventId: string, expect?: string[]): Promise<string[]> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const stages: string[] = [];
      for (const entry of ((await db.execute(["XRANGE", AUDIT_STREAM, "-", "+"])) as Reply[]) ?? []) {
        const fields = pairs((entry as Reply[])[1]!);
        if (fields.get("event_id") === eventId) stages.push(fields.get("stage")!);
      }
      if (expect === undefined || JSON.stringify(stages) === JSON.stringify(expect) || Date.now() > deadline) {
        return stages;
      }
      await sleep(50);
    }
  }

  test("declares the channel capability", async () => {
    const init = await claude.handshake();
    assert.deepEqual(init.result.capabilities.experimental["claude/channel"], {});
    const tools = (await claude.request("tools/list", {})).result.tools as { name: string }[];
    assert.deepEqual(tools.map((t) => t.name).sort(), ["ack_event", "event_status"]);
  });

  test("an event reaches the session and is acked only by Claude", async () => {
    await claude.handshake();
    await waitForGroup();
    const doc = envelope();
    await publish(doc);

    const pushed = (await claude.notification()).params;
    const meta = pushed.meta;
    assert.equal(meta.event_id, doc.id);
    assert.equal(meta.correlation_id, doc.correlation_id);
    assert.equal(meta.attempt, "1");
    assert.equal(meta.subject_peer, "user:42");
    assert.ok(Object.keys(meta).every((k) => /^[A-Za-z0-9]+$/.test(k.replaceAll("_", ""))), JSON.stringify(meta));
    assert.ok(pushed.content.includes("get_messages(peer=user:42, before_id=1002, limit=1)"));

    // Delivered is not acknowledged: the entry stays pending until Claude says so.
    assert.equal(await pendingCount(db), 1);
    assert.equal((await claude.call("event_status", { event_id: doc.id })).body.status, "in_flight");

    const ack = await claude.call("ack_event", { event_id: doc.id, outcome: "handled", note: "get_messages user:42" });
    assert.equal(ack.body.status, "acknowledged");
    assert.equal(await pendingCount(db), 0);
    const expected = ["received", "delivered", "acked"];
    assert.deepEqual(await auditStages(doc.id, expected), expected);
  });

  test("the notification carries references, not content", async () => {
    await claude.handshake();
    await waitForGroup();
    await publish(envelope());
    const pushed = (await claude.notification()).params;
    assert.ok(!("text" in pushed.meta));
    assert.ok(!JSON.stringify(pushed).includes("body"));
  });

  test("an envelope carrying a body is rejected and never delivered", async () => {
    await claude.handshake();
    await waitForGroup();
    const smuggled = envelope("telegram:evt:v1:7:42:1002", { body: "the secret message text" });
    await publish(smuggled);
    const nested = envelope("telegram:evt:v1:7:42:1003");
    nested.subject.text = { value: "the secret message text" };
    await publish(nested);
    await claude.noNotification(1.5);
    assert.equal(await pendingCount(db), 0);
  });

  test("an out-of-policy event is skipped and acknowledged", async () => {
    await claude.handshake();
    await waitForGroup();
    const foreign = envelope("telegram:evt:v1:8:42:1001");
    foreign.subject.account_id = "8";
    await publish(foreign);
    await claude.noNotification(1.5);
    assert.equal(await pendingCount(db), 0);
    assert.deepEqual(await auditStages(foreign.id, ["skipped"]), ["skipped"]);
  });

  test("an ack for an unknown event changes nothing", async () => {
    await claude.handshake();
    const result = await claude.call("ack_event", { event_id: "telegram:evt:v1:7:42:9", outcome: "handled" });
    assert.equal(result.body.status, "unknown");
    const bad = await claude.call("ack_event", { event_id: "x", outcome: "done" });
    assert.ok(bad.isError);
  });

  test("a duplicate entry in flight wakes the session once", async () => {
    await claude.handshake();
    await waitForGroup();
    const doc = envelope();
    await publish(doc);
    await claude.notification();
    await publish(doc); // a producer retry publishes the same envelope again
    await claude.noNotification(1.0);
    assert.equal(await pendingCount(db), 2);
    assert.equal((await claude.call("event_status", { event_id: doc.id })).body.entries, 2);
    await claude.call("ack_event", { event_id: doc.id, outcome: "handled" });
    assert.equal(await pendingCount(db), 0);
    const expected = ["received", "delivered", "duplicate", "acked"];
    assert.deepEqual(await auditStages(doc.id, expected), expected);
  });

  test("a duplicate after the ack is acknowledged silently", async () => {
    await claude.handshake();
    await waitForGroup();
    const doc = envelope("telegram:evt:v1:7:42:4001");
    await publish(doc);
    await claude.notification();
    await claude.call("ack_event", { event_id: doc.id, outcome: "handled" });
    await publish(doc); // a late producer retry
    await claude.noNotification(1.5);
    assert.equal(await pendingCount(db), 0);
    const expected = ["received", "delivered", "acked", "duplicate"];
    assert.deepEqual(await auditStages(doc.id, expected), expected);
  });

  test("in-flight is bounded by max_inflight", async () => {
    await claude.close();
    const bounded = spawnClaude({ ...POLICY, max_inflight: 1 });
    await bounded.handshake();
    await waitForGroup();
    const first = envelope("telegram:evt:v1:7:42:2001");
    const second = envelope("telegram:evt:v1:7:42:2002");
    await publish(first);
    await publish(second);
    assert.equal((await bounded.notification()).params.meta.event_id, first.id);
    await bounded.noNotification(1.5);
    await bounded.call("ack_event", { event_id: first.id, outcome: "handled" });
    assert.equal((await bounded.notification()).params.meta.event_id, second.id);
  });

  test("the consumer recovers after Valkey restarts", async () => {
    await claude.handshake();
    await waitForGroup();
    await valkey.restart(); // empty server: stream and group are gone too
    db = valkey.client();
    await waitForGroup(); // the adapter reconnects and recreates its group
    const doc = envelope("telegram:evt:v1:7:42:3001");
    await publish(doc);
    assert.equal((await claude.notification(40)).params.meta.event_id, doc.id);
  });

  test("an unacknowledged event is delivered again after the adapter restarts", async () => {
    await claude.handshake();
    await waitForGroup();
    const doc = envelope("telegram:evt:v1:7:42:4001");
    await publish(doc);
    assert.equal((await claude.notification()).params.meta.event_id, doc.id);
    await claude.kill(); // crash before ack_event: the entry stays pending
    assert.equal(await pendingCount(db), 1);

    const replacement = spawnClaude(POLICY);
    await replacement.handshake();
    const pushed = (await replacement.notification()).params.meta;
    assert.equal(pushed.event_id, doc.id);
    // Delivered before, so Claude is told to check for an earlier side effect.
    assert.equal(pushed.attempt, "2");
    assert.equal((await replacement.call("ack_event", { event_id: doc.id, outcome: "handled" })).body.status, "acknowledged");
    assert.equal(await pendingCount(db), 0);
    await replacement.noNotification(0.5);
  });

  /** Deliver an event and crash the adapter before it is acknowledged. */
  async function leaveOnePending(eventId: string): Promise<ReturnType<typeof envelope>> {
    await claude.handshake();
    await waitForGroup();
    const doc = envelope(eventId);
    await publish(doc);
    assert.equal((await claude.notification()).params.meta.event_id, doc.id);
    await claude.kill();
    assert.equal(await pendingCount(db), 1);
    return doc;
  }

  test("the first push waits for the handshake to settle", async () => {
    const doc = await leaveOnePending("telegram:evt:v1:7:42:8001");
    const replacement = spawnClaude({ ...POLICY, startup_grace_ms: 1500 });
    await replacement.handshake();
    await replacement.noNotification(0.9);
    const pushed = (await replacement.notification(5)).params.meta;
    assert.deepEqual([pushed.event_id, pushed.attempt], [doc.id, "2"]);
  });

  test("tools/list restarts the settle countdown", async () => {
    await leaveOnePending("telegram:evt:v1:7:42:8002");
    const replacement = spawnClaude({ ...POLICY, startup_grace_ms: 1500 });
    await replacement.handshake();
    await sleep(1000);
    await replacement.request("tools/list", {});
    await replacement.noNotification(0.9); // 1.9 s after initialized: still waiting
    await replacement.notification(5);
  });

  test("a duplicate after a restart is acknowledged without waking the session", async () => {
    await claude.handshake();
    await waitForGroup();
    const doc = envelope("telegram:evt:v1:7:42:6001");
    await publish(doc);
    await claude.notification();
    await claude.call("ack_event", { event_id: doc.id, outcome: "handled" });
    await claude.kill(); // the in-memory set of acked ids dies with it

    const replacement = spawnClaude(POLICY);
    await replacement.handshake();
    await publish(doc); // the producer republishes from its outbox
    await replacement.noNotification(2.0);
    assert.equal(await pendingCount(db), 0);
    // Killing the first adapter can lose its queued audit records, so what
    // matters here is the last stage.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !(await auditStages(doc.id)).includes("duplicate")) await sleep(50);
    assert.equal((await auditStages(doc.id)).at(-1), "duplicate");
  });

  test("closing stdin shuts the adapter down cleanly", async () => {
    await claude.handshake();
    await waitForGroup();
    claude.proc.stdin!.end();
    const timer = setTimeout(() => claude.proc.kill("SIGKILL"), 10_000);
    const started = Date.now();
    assert.equal(await claude.exited, 0);
    clearTimeout(timer);
    assert.ok(Date.now() - started < 7000, `exit took ${Date.now() - started} ms`);
  });

  test("the Valkey password and ACL user are sent with AUTH", async () => {
    await claude.close();
    await db.execute(["ACL", "SETUSER", "claude-remote", "on", ">s3cret pw", "~mctl:events:*", "+@all"]);
    const fs = await import("node:fs");
    const path = await import("node:path");
    const file = path.join(valkey.dir, "password");
    fs.writeFileSync(file, "s3cret pw\n");
    const url = valkey.url.replace("redis://", "redis://claude-remote@");
    const authed = new FakeClaude(url, POLICY, { MCTL_EVENTS_VALKEY_PASSWORD_FILE: file });
    cleanups.push(() => authed.close());
    await authed.handshake();
    await waitForGroup();
    await publish(envelope("telegram:evt:v1:7:42:9901"));
    assert.equal((await authed.notification()).params.meta.event_id, "telegram:evt:v1:7:42:9901");
    const clients = str(await db.execute(["CLIENT", "LIST"]));
    assert.match(clients, /user=claude-remote/);
  });

  test("a missing environment exits 2", async () => {
    await claude.close();
    const bare = new FakeClaude("", POLICY);
    cleanups.push(() => bare.close());
    assert.equal(await bare.exited, 2);
  });
});

/** Commands connection whose first XACK fails as if Valkey dropped the link. */
class FailFirstXack {
  failed = false;
  readonly conn: Connection;
  constructor(conn: Connection) {
    this.conn = conn;
  }
  execute(args: readonly Arg[], options?: ExecuteOptions): Promise<Reply> {
    if (args[0] === "XACK" && !this.failed) {
      this.failed = true;
      return Promise.reject(new ValkeyConnectionError("simulated disconnect"));
    }
    return this.conn.execute(args, options);
  }
}

describe("in-process adapter", { skip: requiresValkey }, () => {
  let valkey: ValkeyServer;
  let db: Connection;
  let basePolicy: policyMod.Policy;
  const adapters: Adapter[] = [];

  beforeEach(async () => {
    valkey = await ValkeyServer.start();
    db = valkey.client();
    basePolicy = policyMod.fromDict({ ...POLICY, block_ms: 5000 });
  });

  afterEach(async () => {
    for (const adapter of adapters.splice(0)) await adapter.close(1);
    await valkey.stop();
  });

  async function makeAdapter(
    options: { commands?: Adapter["commands"]; policy?: policyMod.Policy; emit?: (m: ChannelMessage) => void } = {},
  ): Promise<Adapter> {
    const adapter = new Adapter(
      options.policy ?? basePolicy,
      options.commands ?? valkey.client(),
      valkey.client(),
      options.emit ?? (() => undefined),
    );
    adapters.push(adapter);
    await adapter.ensureGroups();
    return adapter;
  }

  async function auditStages(): Promise<string[]> {
    const entries = ((await db.execute(["XRANGE", AUDIT_STREAM, "-", "+"])) as Reply[]) ?? [];
    return entries.map((entry) => pairs((entry as Reply[])[1]!).get("stage")!);
  }

  const policy = (overrides: Record<string, unknown>) => policyMod.fromDict({ ...POLICY, ...overrides });
  const attempts = (pushed: ChannelMessage[]) => pushed.map((m) => (m.params as any).meta.attempt as string);
  const xadd = (doc: unknown) => db.execute(["XADD", STREAM, "*", "envelope", json(doc)]);

  /** Deliver an event on a consumer that is then abandoned mid-flight. */
  async function claimAsGhost(doc: unknown, overrides: Record<string, unknown> = {}): Promise<Adapter> {
    const ghost = await makeAdapter({ policy: policy({ consumer: "ghost-consumer", ...overrides }) });
    await xadd(doc);
    assert.equal(await ghost.readOnce(100), 1); // delivered, never acked
    return ghost;
  }

  test("an entry abandoned by another consumer is reclaimed with a higher attempt", async () => {
    const pushed: ChannelMessage[] = [];
    const adapter = await makeAdapter({ policy: policy({ reclaim_min_idle_ms: 1 }), emit: (m) => void pushed.push(m) });
    const doc = envelope("telegram:evt:v1:7:42:7001");
    await claimAsGhost(doc);
    await sleep(50); // let it idle past reclaim_min_idle_ms

    assert.equal(await adapter.reclaim(), 1);
    assert.equal((pushed[0]!.params as any).meta.event_id, doc.id);
    // The abandoned consumer already delivered it once: the count is kept in
    // Valkey, so the takeover continues it instead of starting over.
    assert.equal((pushed[0]!.params as any).meta.attempt, "2");
    assert.equal((await adapter.ack(doc.id, "handled", "")).status, "acknowledged");
    assert.equal(await pendingCount(db), 0);
  });

  test("reclaim leaves this consumer's own pending entries alone", async () => {
    const adapter = await makeAdapter({ policy: policy({ reclaim_min_idle_ms: 1 }) });
    await xadd(envelope("telegram:evt:v1:7:42:7002"));
    assert.equal(await adapter.readOnce(100), 1);
    await sleep(50);
    assert.equal(await adapter.reclaim(), 0);
    assert.equal(adapter.inflight.get("telegram:evt:v1:7:42:7002")!.attempt, 1);
  });

  test("an event never acknowledged is rejected after max_attempts", async () => {
    const pushed: ChannelMessage[] = [];
    const adapter = await makeAdapter({
      policy: policy({ reclaim_min_idle_ms: 1, max_attempts: 1 }),
      emit: (m) => void pushed.push(m),
    });
    await claimAsGhost(envelope("telegram:evt:v1:7:42:7003"));
    await sleep(50);
    assert.equal(await adapter.reclaim(), 1);
    assert.deepEqual(pushed, []); // attempt 2 is past the cap: not delivered again
    assert.equal(await pendingCount(db), 0);
    await adapter.flushAudit();
    assert.ok((await auditStages()).includes("rejected"));
  });

  test("a rejected event is not started over by a producer retry", async () => {
    const pushed: ChannelMessage[] = [];
    const adapter = await makeAdapter({
      policy: policy({ reclaim_min_idle_ms: 1, max_attempts: 1 }),
      emit: (m) => void pushed.push(m),
    });
    const doc = envelope("telegram:evt:v1:7:42:7004");
    await claimAsGhost(doc);
    await sleep(50);
    assert.equal(await adapter.reclaim(), 1);

    await xadd(doc); // outbox retry
    assert.equal(await adapter.readOnce(100), 1);
    assert.deepEqual(pushed, []); // rejected once, not delivered again at attempt 1
    assert.equal(await pendingCount(db), 0);
  });

  test("restarting the same consumer still reaches max_attempts", async () => {
    const pushed: ChannelMessage[] = [];
    const capped = policy({ max_attempts: 2 });
    const first = await makeAdapter({ policy: capped, emit: (m) => void pushed.push(m) });
    await xadd(envelope("telegram:evt:v1:7:42:7005"));
    assert.equal(await first.readOnce(100), 1); // attempt 1, never acked

    // Every restart re-reads this consumer's own pending list.
    for (let i = 0; i < 3; i++) await (await makeAdapter({ policy: capped, emit: (m) => void pushed.push(m) })).recoverPending();
    assert.deepEqual(attempts(pushed), ["1", "2"]); // the third re-read is past the cap
    assert.equal(await pendingCount(db), 0);
  });

  test("an own unacknowledged event is pushed again after reclaim_min_idle", async () => {
    const pushed: ChannelMessage[] = [];
    const adapter = await makeAdapter({ policy: policy({ reclaim_min_idle_ms: 50 }), emit: (m) => void pushed.push(m) });
    const doc = envelope("telegram:evt:v1:7:42:7101");
    await xadd(doc);
    assert.equal(await adapter.readOnce(100), 1);
    assert.equal(await adapter.redeliverStale(), 0); // not idle yet
    await sleep(60);

    assert.equal(await adapter.redeliverStale(), 1);
    assert.deepEqual(attempts(pushed), ["1", "2"]);
    assert.equal(adapter.inflight.get(doc.id)!.attempt, 2);
    assert.equal(await adapter.redeliverStale(), 0); // the idle clock restarted with the push
    assert.equal((await adapter.ack(doc.id, "handled", "")).status, "acknowledged");
    assert.equal(await pendingCount(db), 0);
    await adapter.flushAudit();
    assert.deepEqual(await auditStages(), ["received", "delivered", "delivered", "acked"]);
  });

  test("redelivery of an own event stops at max_attempts", async () => {
    const pushed: ChannelMessage[] = [];
    const adapter = await makeAdapter({
      policy: policy({ reclaim_min_idle_ms: 50, max_attempts: 1 }),
      emit: (m) => void pushed.push(m),
    });
    await xadd(envelope("telegram:evt:v1:7:42:7102"));
    assert.equal(await adapter.readOnce(100), 1);
    await sleep(60);

    assert.equal(await adapter.redeliverStale(), 0);
    assert.equal(pushed.length, 1); // attempt 2 is past the cap: not pushed again
    assert.equal(adapter.inflight.size, 0); // the slot is free for newer events
    assert.equal(await pendingCount(db), 0);
    await adapter.flushAudit();
    assert.equal((await auditStages()).at(-1), "rejected");
  });

  test("a redelivery that never reached Claude keeps the slot and the attempt", async () => {
    const pushed: ChannelMessage[] = [];
    let broken = false;
    const emit = (m: ChannelMessage): void => {
      if (broken) throw Object.assign(new Error("stdout is gone"), { code: "EPIPE" });
      pushed.push(m);
    };
    const adapter = await makeAdapter({ policy: policy({ reclaim_min_idle_ms: 50 }), emit });
    const doc = envelope("telegram:evt:v1:7:42:7103");
    await xadd(doc);
    assert.equal(await adapter.readOnce(100), 1);
    broken = true;
    await sleep(60);

    assert.equal(await adapter.redeliverStale(), 0);
    assert.equal(adapter.inflight.get(doc.id)!.attempt, 1); // refunded, still in flight
    assert.equal(str(await db.execute(["GET", "mctl:events:state:attempt:claude-remote:telegram%3Aevt%3Av1%3A7%3A42%3A7103"])), "1");
    broken = false;
    assert.equal(await adapter.redeliverStale(), 1); // still idle: tried again at once
    assert.deepEqual(attempts(pushed), ["1", "2"]);
  });

  test("the run loop pushes a stuck event again without a restart", async () => {
    const pushed: ChannelMessage[] = [];
    let wake: (() => void) | null = null;
    const next = async (timeoutMs: number): Promise<ChannelMessage> => {
      const deadline = Date.now() + timeoutMs;
      while (!pushed.length) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("timed out");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remaining);
          wake = () => (clearTimeout(timer), resolve());
        });
      }
      return pushed.shift()!;
    };
    const adapter = await makeAdapter({
      policy: policy({ block_ms: 200, reclaim_min_idle_ms: 300 }),
      emit: (m) => {
        pushed.push(m);
        wake?.();
      },
    });
    const consumer = adapter.run();
    try {
      const doc = envelope("telegram:evt:v1:7:42:7104");
      await xadd(doc);
      const first = ((await next(5000)).params as any).meta;
      const second = ((await next(5000)).params as any).meta;
      assert.deepEqual(
        [first, second].map((m) => [m.event_id, m.attempt]),
        [[doc.id, "1"], [doc.id, "2"]],
      );
      await adapter.ack(doc.id, "handled", "");
      await assert.rejects(next(700), /timed out/); // acknowledged: nothing more to retry
    } finally {
      adapter.stop();
      await consumer;
    }
  });

  test("a notification that never reached Claude does not spend an attempt", async () => {
    const pushed: ChannelMessage[] = [];
    let broken = true;
    const emit = (m: ChannelMessage): void => {
      if (broken) throw Object.assign(new Error("stdout is gone"), { code: "EPIPE" });
      pushed.push(m);
    };
    const capped = policy({ max_attempts: 1 });
    const adapter = await makeAdapter({ policy: capped, emit });
    await xadd(envelope("telegram:evt:v1:7:42:7007"));
    assert.equal(await adapter.readOnce(100), 1);
    assert.equal(adapter.inflight.size, 0); // the slot was released with the attempt
    assert.equal(str(await db.execute(["GET", "mctl:events:state:attempt:claude-remote:telegram%3Aevt%3Av1%3A7%3A42%3A7007"])), "0");

    broken = false;
    assert.equal(await (await makeAdapter({ policy: capped, emit })).recoverPending(), 1);
    // Still attempt 1 under a cap of 1: the failed notification was refunded.
    assert.deepEqual(attempts(pushed), ["1"]);
  });

  test("reclaim looks past a page full of this consumer's own entries", async () => {
    const pushed: ChannelMessage[] = [];
    let broken = true;
    const emit = (m: ChannelMessage): void => {
      if (broken) throw Object.assign(new Error("stdout is gone"), { code: "EPIPE" });
      pushed.push(m);
    };
    const adapter = await makeAdapter({ policy: policy({ reclaim_min_idle_ms: 1 }), emit });
    // A stdio outage leaves entries pending while capacity stays free, so this
    // consumer's own backlog grows past one XPENDING page.
    for (let index = 0; index < PENDING_BATCH + 1; index++) {
      await xadd(envelope(`telegram:evt:v1:7:42:9${String(index).padStart(3, "0")}`));
    }
    while (await adapter.readOnce(100));
    assert.ok((await pendingCount(db)) > PENDING_BATCH);

    await claimAsGhost(envelope("telegram:evt:v1:7:42:7008")); // newest, so last in id order
    await sleep(50);
    broken = false;

    assert.equal(await adapter.reclaim(), 1);
    assert.deepEqual(pushed.map((m) => (m.params as any).meta.event_id), ["telegram:evt:v1:7:42:7008"]);
  });

  test("reclaim survives an entry trimmed out of the stream", async () => {
    const adapter = await makeAdapter({ policy: policy({ reclaim_min_idle_ms: 1 }) });
    await claimAsGhost(envelope("telegram:evt:v1:7:42:7006"));
    const entry = str(((await db.execute(["XRANGE", STREAM, "-", "+"])) as Reply[][])[0]![0]!);
    await db.execute(["XDEL", STREAM, entry]);
    await sleep(50);

    assert.equal(await adapter.reclaim(), 0); // nothing to deliver, and no crash
    // Valkey drops a deleted entry from the pending list as XCLAIM touches it.
    assert.equal(await pendingCount(db), 0);
  });

  test("a failed automatic ack is retried from the pending list", async () => {
    const adapter = await makeAdapter({ commands: new FailFirstXack(valkey.client()) });
    await db.execute(["XADD", STREAM, "*", "envelope", "not json"]);
    await assert.rejects(adapter.readOnce(100), ValkeyConnectionError);
    assert.equal(await pendingCount(db), 1);
    assert.equal(await adapter.recoverPending(), 1);
    assert.equal(await pendingCount(db), 0);
  });

  test("a reconnect does not duplicate an in-flight entry", async () => {
    const adapter = await makeAdapter();
    await xadd(envelope("telegram:evt:v1:7:42:5001"));
    assert.equal(await adapter.readOnce(100), 1);
    await adapter.recoverPending();
    assert.equal(adapter.inflight.get("telegram:evt:v1:7:42:5001")!.entries.length, 1);
  });

  test("stop interrupts a blocked read", async () => {
    const adapter = await makeAdapter();
    const consumer = adapter.run();
    await sleep(300); // let it block in XREADGROUP for up to 5 s
    const started = Date.now();
    adapter.stop();
    await consumer;
    assert.ok(Date.now() - started < 2000, `stop took ${Date.now() - started} ms`);
  });

  test("audit records land in the audit stream with sorted fields", async () => {
    const adapter = await makeAdapter();
    adapter.audit("acked", "telegram:evt:1", "corr-1", { note: "x", attempt: 2 });
    await adapter.flushAudit();
    const [entry] = (await db.execute(["XRANGE", AUDIT_STREAM, "-", "+"])) as Reply[][];
    const flat = (entry![1] as Reply[]).map(str);
    assert.deepEqual(flat.filter((_, i) => i % 2 === 0), [
      "attempt", "component", "consumer", "correlation_id", "event_id", "group", "note", "stage",
    ]);
    assert.equal(pairs(entry![1]!).get("attempt"), "2");
  });
});
