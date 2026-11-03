#!/usr/bin/env bun
// mctl-bridge: the orchestrator's command line. Every command prints one JSON
// object. Exit status: 0 done, 1 refused by the state machine (the JSON says
// why), 2 usage or connection error.
//
// Environment: MCTL_BRIDGE_VALKEY_URL (redis://user@host:port/db) and,
// optionally, MCTL_BRIDGE_VALKEY_PASSWORD_FILE.

import fs from "node:fs";
import { parseArgs } from "node:util";

import { Bridge, key, loadLibrary, pairs, text } from "./store.ts";
import type { Result } from "./store.ts";
import { Connection, endpointFromUrl } from "./valkey.ts";
import type { Reply } from "./valkey.ts";

const USAGE = `usage: mctl-bridge <command> [options]

  init                                   load the function library, report durability
  send --slot S (--text T | --text -)    queue a task for a slot
       [--idem KEY] [--ttl MS] [--hop N]
  wait [--timeout SEC]                   unclaimed questions and new events
  claim QID [--lease MS]                 take the right to reply
  renew QID --token T [--lease MS]
  reply QID --token T (--text T | --text -)
  resolve ID --as completed|failed|cancelled|closed|requeue --reason R [--author A] [--force]
  resolve WAKE_ID --reason R [--author A]   close a wake (w-...) after looking at the thread
  sessions                               registered slots
  tasks                                  every open message
  status ID                              one message with its audit trail and late evidence
  errors                                 delivery_unknown, wake_unknown and late evidence
  wakes                                  wakes not yet settled (intent, started, wake_unknown)
  sweep [--stale-ms MS]                  expiry, stale slots and recovery
`;

class Usage extends Error {}

function connect(): Connection {
  const url = process.env.MCTL_BRIDGE_VALKEY_URL;
  if (!url) throw new Usage("MCTL_BRIDGE_VALKEY_URL is not set");
  const pwFile = process.env.MCTL_BRIDGE_VALKEY_PASSWORD_FILE;
  const password = pwFile ? fs.readFileSync(pwFile, "utf8").trim() : null;
  return new Connection(endpointFromUrl(url, password));
}

function readText(value: string | undefined): string {
  if (value === undefined) throw new Usage("--text is required");
  return value === "-" ? fs.readFileSync(0, "utf8") : value;
}

function positional(args: string[], name: string): string {
  const v = args[0];
  if (!v) throw new Usage(`${name} is required`);
  return v;
}

function num(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Usage(`${name} must be a non-negative integer`);
  return n;
}

function entries(reply: Reply): Array<Record<string, string>> {
  if (!Array.isArray(reply)) return [];
  return reply.map((e) => {
    const [id, fields] = e as Reply[];
    return { entry: text(id!), ...pairs(fields!) };
  });
}

async function lateKeys(b: Bridge): Promise<string[]> {
  const out = new Set<string>(); // SCAN may return a key more than once
  let cursor = "0";
  do {
    const [next, batch] = (await b.exec.execute(["SCAN", cursor, "MATCH", `${key.late("")}*`, "COUNT", 500])) as Reply[];
    cursor = text(next!);
    for (const k of batch as Reply[]) out.add(text(k));
  } while (cursor !== "0");
  return [...out].sort();
}

export async function run(argv: string[], b: Bridge): Promise<{ code: number; out: unknown }> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      slot: { type: "string" },
      text: { type: "string" },
      idem: { type: "string" },
      ttl: { type: "string" },
      hop: { type: "string" },
      timeout: { type: "string" },
      lease: { type: "string" },
      token: { type: "string" },
      as: { type: "string" },
      reason: { type: "string" },
      author: { type: "string" },
      "stale-ms": { type: "string" },
      force: { type: "boolean" },
    },
  });
  const result = (r: Result) => ({ code: r.ok ? 0 : 1, out: r });

  switch (command) {
    case "init": {
      await loadLibrary(b.exec);
      await b.checkVersion();
      return { code: 0, out: { ok: true, durability: await b.durability() } };
    }
    case "send": {
      if (!values.slot) throw new Usage("--slot is required");
      return result(await b.send({
        slot: values.slot,
        payload: readText(values.text),
        idempotency_key: values.idem,
        ttl_ms: num(values.ttl, 0, "--ttl"),
        hop: num(values.hop, 0, "--hop"),
      }));
    }
    case "wait": {
      const timeoutMs = num(values.timeout, 30, "--timeout") * 1000;
      const cursor = pairs(await b.exec.execute(["HGETALL", key.orch])).cursor ?? "0-0";
      let unclaimed = (await b.askedQuestions()).filter((q) => q.claimed === "0");
      let events: Array<Record<string, string>> = entries(await b.exec.execute(["XRANGE", key.feed, `(${cursor}`, "+", "COUNT", 100]));
      if (unclaimed.length === 0 && events.length === 0 && timeoutMs > 0) {
        const reply = await b.exec.execute(
          ["XREAD", "COUNT", 100, "BLOCK", Math.max(1, Math.round(timeoutMs)), "STREAMS", key.feed, cursor],
          { timeout: timeoutMs / 1000 + 10 },
        );
        if (Array.isArray(reply) && reply.length > 0) events = entries((reply[0] as Reply[])[1]!);
        unclaimed = (await b.askedQuestions()).filter((q) => q.claimed === "0");
      }
      const last = events.at(-1);
      if (last) await b.exec.execute(["HSET", key.orch, "cursor", last.entry!]);
      return { code: 0, out: { ok: true, questions: unclaimed, events } };
    }
    case "claim":
      return result(await b.claim(positional(positionals, "QID"), { lease_ms: num(values.lease, 120000, "--lease") }));
    case "renew":
      if (!values.token) throw new Usage("--token is required");
      return result(await b.renew(positional(positionals, "QID"), values.token, num(values.lease, 120000, "--lease")));
    case "reply":
      if (!values.token) throw new Usage("--token is required");
      return result(await b.reply(positional(positionals, "QID"), values.token, readText(values.text)));
    case "resolve": {
      const id = positional(positionals, "ID");
      const author = values.author || process.env.USER || "";
      if (!author) throw new Usage("--author is required when USER is not set");
      if (id.startsWith("w-")) {
        if (!values.reason) throw new Usage("--reason is required");
        return result(await b.wakeResolve(id, values.reason, author));
      }
      if (!values.as || !values.reason) throw new Usage("--as and --reason are required");
      return result(await b.resolve(id, values.as, values.reason, author, values.force === true));
    }
    case "sessions": {
      const now = Date.now();
      const slots = [];
      for (const slot of await b.members(key.slots)) {
        const s = await b.slotInfo(slot);
        slots.push({ ...s, heartbeat_age_ms: s.heartbeat ? now - Number(s.heartbeat) : null, live: Boolean(s.conn_id) });
      }
      return { code: 0, out: { ok: true, slots } };
    }
    case "tasks":
      return { code: 0, out: { ok: true, open: await b.openMessages() } };
    case "status": {
      const id = positional(positionals, "ID");
      const message = await b.message(id);
      if (!message.state) return { code: 1, out: { ok: false, code: "unknown" } };
      return { code: 0, out: { ok: true, id, message, audit: await b.auditTrail(id), late: await b.late(id) } };
    }
    case "errors": {
      const open = await b.openMessages();
      const unknown = open.filter((m) => m.state === "delivery_unknown");
      const wakes = (await b.openWakes()).filter((w) => w.state === "wake_unknown");
      const late: Record<string, unknown> = {};
      for (const k of await lateKeys(b)) {
        const id = k.slice(key.late("").length);
        late[id] = await b.late(id);
      }
      return { code: 0, out: { ok: true, unknown, wakes, late } };
    }
    case "wakes":
      return { code: 0, out: { ok: true, wakes: await b.openWakes() } };
    case "sweep":
      return { code: 0, out: { ok: true, ...(await b.sweep(num(values["stale-ms"], 30000, "--stale-ms"))) } };
    default:
      throw new Usage(command ? `unknown command: ${command}` : "no command");
  }
}

if (import.meta.main) {
  let conn: Connection | null = null;
  try {
    conn = connect();
    const { code, out } = await run(process.argv.slice(2), new Bridge(conn));
    process.stdout.write(JSON.stringify(out) + "\n");
    process.exitCode = code;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({ ok: false, code: err instanceof Usage ? "usage" : "error", error: message }) + "\n");
    if (err instanceof Usage) process.stderr.write(USAGE);
    process.exitCode = 2;
  } finally {
    conn?.close();
  }
}
