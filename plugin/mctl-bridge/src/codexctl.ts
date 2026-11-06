// mctl-codex: the operator's window onto the orchestrator's Codex thread, over the
// control socket. It holds no Valkey credentials and is not reachable from a slot:
// the socket's directory is closed to the slot users (see host-boundary-probe.py).
//
//   status            is the thread idle, busy, or waiting on an approval
//   log               the latest messages, without tool-call noise, secrets redacted
//   questions         messages from Codex that wait for the operator
//   say               start one turn in an idle thread, recorded before it is sent
//
// A read that fails is an error with a non-zero exit, never an empty answer. Whether
// anything waits for the operator can be unknown, and is then reported as unknown.
//
// `say` follows the waker's rules (see waker.ts for the live protocol): it only writes
// to an idle thread, because turn/start on a busy thread joins the running turn; it
// never retries, because clientUserMessageId is not deduplicated; and it sends no
// model, effort, approval or sandbox fields, because those overrides are sticky and
// would change the thread the operator sees on the phone.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AppClient, ConnectionLost, RpcError } from "./appserver.ts";
import type { Note } from "./appserver.ts";

export const VERSION = "0.1.0";
/** Every `say` carries this, so the thread shows who wrote it. */
export const LEAD_PREFIX = "[lead-claude] ";
/** Codex starts a line with this to ask the operator (ops/orchestrator-AGENTS.md). */
export const QUESTION_MARKER = "[operator-question]";
const MAX_SAY_BYTES = 32 * 1024;
const TURN_PAGE = 20;

const REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "[REDACTED:private-key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED:github]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED:github]"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "[REDACTED:api-key]"],
  [/\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED:slack]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:aws]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[REDACTED:jwt]"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, "[REDACTED:telegram]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, "$1 [REDACTED]"],
  [/:\/\/([^\s\/:@]+):[^\s\/@]+@/g, "://$1:[REDACTED]@"],
  [/\b([A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_-]*)(["']?\s*[=:]\s*["']?)[^\s"',;&]+/gi, "$1$2[REDACTED]"],
];

/** Hide what looks like a credential. A filter, not a proof: see the CLI's stated limits. */
export function redact(text: string): string {
  let out = text;
  for (const [re, to] of REDACTIONS) out = out.replace(re, to);
  return out;
}

/** The thread or its history could not be read: never to be taken for "nothing there". */
export class Unreadable extends Error {}

export type Config = { threadId: string; socketPath: string; sendLog: string; rpcTimeoutMs: number };
export type Message = { turn: string; turn_status: string | null; role: "user" | "codex"; client_id: string | null; text: string };
export type Status = { status: string; flags: string[] };
export type Questions = { waiting: Message[]; scanned_turns: number; older_unknown: boolean };
export type SayResult =
  | { ok: true; id: string; turn: string; turn_status?: string; reply?: string[]; reply_error?: string; log_error?: string }
  | { ok: false; code: string; id?: string; detail?: string };

function turnMessages(t: any): Message[] {
  if (typeof t?.id !== "string" || !Array.isArray(t.items)) throw new Unreadable("a turn came back without its items");
  const out: Message[] = [];
  const status = typeof t.status === "string" ? t.status : null;
  for (const i of t.items) {
    if (i?.type === "userMessage") {
      if (!Array.isArray(i.content)) throw new Unreadable(`user message in ${t.id} has no content`);
      const text = i.content.map((c: any) => (typeof c?.text === "string" ? c.text : `<${String(c?.type)}>`)).join(" ");
      out.push({ turn: t.id, turn_status: status, role: "user", client_id: typeof i.clientId === "string" ? i.clientId : null, text });
    } else if (i?.type === "agentMessage") {
      if (typeof i.text !== "string") throw new Unreadable(`agent message in ${t.id} has no text`);
      out.push({ turn: t.id, turn_status: status, role: "codex", client_id: null, text: i.text });
    }
  }
  return out;
}

/** A turn the waker or this tool started is not the operator answering. */
function fromOperator(m: Message): boolean {
  return m.role === "user" && !(m.client_id?.startsWith("w-") || m.client_id?.startsWith("lead-"));
}

const shown = (m: Message): Message => ({ ...m, text: redact(m.text) });

export class CodexThread {
  private readonly cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  private async session(): Promise<AppClient> {
    const c = await AppClient.connect(this.cfg.socketPath, this.cfg.rpcTimeoutMs);
    try {
      await c.request("initialize", { clientInfo: { name: "mctl_codex", version: VERSION } }, this.cfg.rpcTimeoutMs);
      c.notify("initialized");
      await c.request("thread/resume", { threadId: this.cfg.threadId, excludeTurns: true }, this.cfg.rpcTimeoutMs);
      return c;
    } catch (err) {
      c.close();
      throw err;
    }
  }

  private async readStatus(c: AppClient): Promise<Status> {
    const r = await c.request("thread/read", { threadId: this.cfg.threadId }, this.cfg.rpcTimeoutMs);
    const s = r?.thread?.status;
    if (typeof s?.type !== "string") throw new Unreadable("thread/read returned no status");
    return { status: s.type, flags: Array.isArray(s.activeFlags) ? s.activeFlags.map(String) : [] };
  }

  /** The newest `limit` turns, newest first, and whether older ones exist. */
  private async turns(c: AppClient, limit: number): Promise<{ turns: any[]; more: boolean }> {
    const turns: any[] = [];
    let cursor: string | null = null;
    for (;;) {
      const r: any = await c.request("thread/turns/list", {
        threadId: this.cfg.threadId, itemsView: "full", sortDirection: "desc",
        limit: Math.min(limit - turns.length, TURN_PAGE), cursor,
      }, this.cfg.rpcTimeoutMs);
      if (!Array.isArray(r?.data)) throw new Unreadable("thread/turns/list returned no data");
      turns.push(...r.data);
      const next = r.nextCursor ?? null;
      if (next !== null && typeof next !== "string") throw new Unreadable("thread/turns/list returned a bad cursor");
      if (next !== null && r.data.length === 0) throw new Unreadable("thread/turns/list returned an empty page with a cursor");
      if (next === null) return { turns, more: false };
      if (turns.length >= limit) return { turns, more: true };
      cursor = next;
    }
  }

  async status(): Promise<Status> {
    const c = await this.session();
    try {
      return await this.readStatus(c);
    } finally {
      c.close();
    }
  }

  /** The messages of the newest `limit` turns, oldest first. */
  async log(limit: number): Promise<Message[]> {
    const c = await this.session();
    try {
      const { turns } = await this.turns(c, limit);
      return [...turns].reverse().flatMap(turnMessages).map(shown);
    } finally {
      c.close();
    }
  }

  /**
   * Marked messages newer than the operator's last message. If the window holds no
   * operator message and older turns exist, older questions cannot be ruled out.
   */
  async questions(window: number): Promise<Questions> {
    const c = await this.session();
    try {
      const { turns, more } = await this.turns(c, window);
      const waiting: Message[] = [];
      for (const t of turns) {
        for (const m of turnMessages(t).reverse()) {
          if (fromOperator(m)) return { waiting: waiting.reverse().map(shown), scanned_turns: turns.length, older_unknown: false };
          if (m.role === "codex" && m.text.split("\n").some((l) => l.startsWith(QUESTION_MARKER))) waiting.push(m);
        }
      }
      return { waiting: waiting.reverse().map(shown), scanned_turns: turns.length, older_unknown: more };
    } finally {
      c.close();
    }
  }

  private record(entry: Record<string, unknown>): void {
    fs.appendFileSync(this.cfg.sendLog, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
  }

  /** After the intent: a record that fails must not read as "nothing was sent". */
  private recordAfterIntent(entry: Record<string, unknown>): string | undefined {
    try {
      this.record(entry);
      return undefined;
    } catch (err) {
      return String(err);
    }
  }

  /** Start one turn. Never retried: a lost start is settled from the history or stays unknown. */
  async say(text: string, waitMs = 0): Promise<SayResult> {
    const body = text.trim();
    if (body === "") return { ok: false, code: "empty" };
    if (Buffer.byteLength(body) > MAX_SAY_BYTES) return { ok: false, code: "too_long" };
    const full = body.startsWith(LEAD_PREFIX) ? body : LEAD_PREFIX + body;

    const c = await this.session();
    const ended = new Map<string, string>();
    const off = c.onNote((n: Note) => {
      if (n.method !== "turn/completed") return;
      const p = n.params ?? {};
      if (p.threadId === this.cfg.threadId && typeof p.turn?.id === "string") ended.set(p.turn.id, String(p.turn.status ?? ""));
    });
    try {
      const st = await this.readStatus(c);
      if (st.status !== "idle") return { ok: false, code: "thread_not_idle", detail: [st.status, ...st.flags].join(" ") };

      const id = `lead-${crypto.randomUUID()}`;
      try {
        this.record({ id, state: "intent", text: full });
      } catch (err) {
        return { ok: false, code: "send_log_unwritable", detail: String(err) };
      }

      let turn: string | null = null;
      try {
        const r = await c.request("turn/start", {
          threadId: this.cfg.threadId,
          clientUserMessageId: id,
          input: [{ type: "text", text: full }],
        }, this.cfg.rpcTimeoutMs);
        turn = typeof r?.turn?.id === "string" ? r.turn.id : null;
      } catch (err) {
        if (err instanceof RpcError) {
          const log_error = this.recordAfterIntent({ id, state: "refused", detail: err.message });
          return { ok: false, code: "refused", id, detail: log_error ? `${err.message}; send log: ${log_error}` : err.message };
        }
      }
      if (turn === null) {
        turn = await this.settle(id);
        if (turn === null) {
          this.recordAfterIntent({ id, state: "unknown" });
          return { ok: false, code: "outcome_unknown", id, detail: "the start was not confirmed; not retried, read the log first" };
        }
      }
      // The turn is running from here on: nothing below may look like a failed send.
      const log_error = this.recordAfterIntent({ id, state: "started", turn });
      const sent = { ok: true as const, id, turn, ...(log_error ? { log_error } : {}) };
      if (waitMs <= 0) return sent;

      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline && !ended.has(turn) && !c.isClosed) await Bun.sleep(50);
      const status = ended.get(turn);
      if (status === undefined) return { ...sent, turn_status: c.isClosed ? "unknown" : "still_running" };
      const end_error = this.recordAfterIntent({ id, state: "ended", turn, status });
      const done = { ...sent, turn_status: status, ...(end_error ? { log_error: end_error } : {}) };
      try {
        const { turns } = await this.turns(c, 5);
        const mine = turns.find((t) => t.id === turn);
        if (!mine) throw new Unreadable(`turn ${turn} is not in the history`);
        return { ...done, reply: turnMessages(mine).filter((m) => m.role === "codex").map((m) => redact(m.text)) };
      } catch (err) {
        return { ...done, reply_error: err instanceof Error ? err.message : String(err) };
      }
    } finally {
      off();
      c.close();
    }
  }

  /** Exactly one turn holding the client id means it started; anything else is unknown. */
  private async settle(id: string): Promise<string | null> {
    let c: AppClient | null = null;
    try {
      c = await this.session();
      const { turns } = await this.turns(c, 10);
      const hits = turns.filter((t) => turnMessages(t).some((m) => m.client_id === id));
      return hits.length === 1 ? hits[0].id : null;
    } catch {
      return null;
    } finally {
      c?.close();
    }
  }
}

const USAGE = `mctl-codex: read and write the orchestrator's Codex thread (prints JSON)

  status                      idle, active, and any flags such as waiting on approval
  log [--limit N]             messages of the newest N turns (default 3), secrets redacted
  questions [--window N]      messages marked ${QUESTION_MARKER} since the operator's last message
  say (--stdin | --file P) [--wait SECONDS]
                              start one turn in an idle thread, marked ${LEAD_PREFIX.trim()}

Exit: 0 ok, 1 usage, 2 unreadable, 3 refused, nothing sent, 4 outcome unknown.
Once a turn has started, say exits 0: a reply it could not read is reply_error, never a failure.
Redaction is pattern based: it lowers the risk of a secret leaving the thread, it does not rule it out.`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined) throw new UsageError(`${name} needs a value`);
  return v;
}

class UsageError extends Error {}

function positive(v: string | undefined, fallback: number, name: string): number {
  if (v === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(v)) throw new UsageError(`${name} must be a positive integer`);
  return Number(v);
}

function config(): Config {
  const home = process.env.MCTL_BRIDGE_HOME ?? path.join(os.homedir(), "mctl-bridge");
  const threadId = (process.env.MCTL_BRIDGE_THREAD_ID ?? fs.readFileSync(path.join(home, "etc", "thread-id"), "utf8")).trim();
  if (threadId === "") throw new Unreadable("the thread id is empty");
  return {
    threadId,
    socketPath: process.env.MCTL_BRIDGE_CODEX_SOCKET ?? path.join(os.homedir(), ".codex", "app-server-control", "app-server-control.sock"),
    sendLog: process.env.MCTL_CODEX_SEND_LOG ?? path.join(home, "log", "lead-sends.jsonl"),
    rpcTimeoutMs: positive(process.env.MCTL_CODEX_RPC_TIMEOUT_MS, 30_000, "MCTL_CODEX_RPC_TIMEOUT_MS"),
  };
}

/** A mistyped flag must not silently fall back to a default, such as a narrower window. */
function known(args: string[], valued: string[], bare: string[] = []): void {
  for (let i = 0; i < args.length; i++) {
    if (valued.includes(args[i]!)) i++;
    else if (!bare.includes(args[i]!)) throw new UsageError(`unknown argument ${args[i]}`);
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  const print = (v: unknown): void => console.log(JSON.stringify(v));
  switch (cmd) {
    case "status":
      known(args, []);
      print({ ok: true, ...(await new CodexThread(config()).status()) });
      return 0;
    case "log":
      known(args, ["--limit"]);
      print({ ok: true, messages: await new CodexThread(config()).log(positive(flag(args, "--limit"), 3, "--limit")) });
      return 0;
    case "questions":
      known(args, ["--window"]);
      print({ ok: true, ...(await new CodexThread(config()).questions(positive(flag(args, "--window"), 20, "--window"))) });
      return 0;
    case "say": {
      known(args, ["--file", "--wait"], ["--stdin"]);
      const file = flag(args, "--file");
      if ((file !== undefined) === args.includes("--stdin")) throw new UsageError("give exactly one of --stdin, --file");
      const text = fs.readFileSync(file ?? 0, "utf8");
      const r = await new CodexThread(config()).say(text, positive(flag(args, "--wait"), 0, "--wait") * 1000 || 0);
      print(r);
      if (r.ok) return 0;
      return r.code === "outcome_unknown" ? 4 : 3;
    }
    default:
      console.error(USAGE);
      return 1;
  }
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${USAGE}`);
      process.exit(1);
    }
    const known = err instanceof Unreadable || err instanceof ConnectionLost || err instanceof RpcError;
    console.log(JSON.stringify({ ok: false, code: "unreadable", detail: known ? err.message : String(err) }));
    process.exit(2);
  }
}
