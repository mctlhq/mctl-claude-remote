// The durable profile: AOF with fsync on every write. A SIGKILL between
// transitions must leave msg, open, dedup and audit agreeing after restart.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Bridge, key, pairs } from "../src/store.ts";
import type { Result } from "../src/store.ts";
import { ValkeyServer, requiresValkey } from "./support.ts";

function must(r: Result): Record<string, any> {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Record<string, any>;
}

describe.skipIf(requiresValkey)("durability across SIGKILL", () => {
  let server: ValkeyServer;
  beforeAll(async () => {
    server = await ValkeyServer.start({ durable: true });
  });
  afterAll(async () => {
    await server.stop();
  });

  test("the durable profile is reported as durable, a default server as weak", async () => {
    const b = await server.bridge();
    expect(await b.durability()).toMatchObject({ status: "durable", appendonly: "yes", appendfsync: "always" });
    const plain = await ValkeyServer.start();
    try {
      expect((await (await plain.bridge()).durability()).status).toBe("weak");
    } finally {
      await plain.stop();
    }
  });

  test("an unreadable config is unknown, not durable", async () => {
    const admin = server.client();
    await admin.execute(["ACL", "SETUSER", "noconfig", "on", ">pw", "~*", "+@all", "-config"]);
    const { Connection, endpointFromUrl } = await import("../src/valkey.ts");
    const limited = new Connection(endpointFromUrl(server.url.replace("redis://", "redis://noconfig:pw@")));
    try {
      expect((await new Bridge(limited).durability()).status).toBe("unknown");
    } finally {
      limited.close();
      await admin.execute(["ACL", "DELUSER", "noconfig"]);
    }
  });

  test("every acknowledged transition survives, and the indexes agree", async () => {
    let b = await server.bridge();
    const reg = must(await b.register({ slot: "a", uuid: "u1", conn_id: "k1", pid: 1, pid_start: "s", cwd: "/w" }));
    const c = { slot: "a", conn_id: "k1", epoch: reg.epoch as string };
    must(await b.heartbeat(c, false));
    const t1 = must(await b.send({ slot: "a", payload: "one", idempotency_key: "idem-1" }));
    await server.crashAndRestart();

    b = new Bridge(server.client());
    await b.checkVersion(); // the function library itself is in the AOF
    expect((await b.message(t1.id)).state).toBe("queued");
    const next = must(await b.next(c));
    await server.crashAndRestart();

    b = new Bridge(server.client());
    expect((await b.message(t1.id)).state).toBe("emit_intent");
    expect((await b.slotInfo("a")).inflight).toBe(t1.id);
    must(await b.emitted(c, t1.id));
    const ack = must(await b.ackTask(c, t1.id, next.attempt_id));
    const q = must(await b.ask("a", ack.admission, "?"));
    const claim = must(await b.claim(q.question_id));
    const rep = must(await b.reply(q.question_id, claim.claim_token, "yes"));
    await server.crashAndRestart();

    b = new Bridge(server.client());
    const qm = await b.message(q.question_id);
    expect(qm).toMatchObject({ state: "reply_committed", reply_id: rep.reply_id, attempt_id: next.attempt_id });
    expect(await b.members(key.open)).toEqual([q.question_id, t1.id].sort());
    expect(await b.exec.execute(["GET", key.dedup("idem-1")])).toEqual(Buffer.from(t1.id));
    const audit = ((await b.exec.execute(["XRANGE", key.audit, "-", "+"])) as any[]).map((e) => pairs(e[1]));
    expect(audit.filter((e) => e.id === t1.id).map((e) => e.to)).toEqual(["queued", "emit_intent", "emitted", "acked"]);
    expect(audit.filter((e) => e.id === q.question_id).map((e) => e.to)).toEqual(["asked", "asked", "reply_committed"]);
    // and the reply still goes out to the same attempt
    const got = must(await b.next(c));
    expect(got).toMatchObject({ kind: "reply", reply_id: rep.reply_id, attempt_id: next.attempt_id });
  });
});
