// operator-notify: tell the operator that a Codex question has waited too long.
//
// OFF by default and not wired into the waker, a service or an installer. reconcile.ts
// still only journals permission prompts; this is a separate, opt-in tool. Nothing here
// holds credentials or opens a network connection: the sender is injected, and the
// optional CLI below only appends to a local outbox file.
//
// What it does, per pass (`runOnce`):
//   1. read the questions through an injected source (CodexThread.questions from
//      codexctl.ts satisfies it; question recognition and the rule that wake/lead
//      messages are not operator answers are NOT reimplemented here);
//   2. remember, durably, when each question was first seen;
//   3. once one has waited at least the threshold, send ONE generic notification and
//      record the delivery only after the sender confirmed it;
//   4. on a failure, retry with a bounded backoff and a bounded number of attempts.
//
// Privacy boundary. A notification carries only: fixed generic wording, a validated
// thread id, a validated turn id, a link built here from an operator-configured https
// base and the validated thread id, and the age in minutes. The question text, commands,
// transcript and tool output are never copied into a notification or into the state file,
// and no URL from the source is ever used. The ids are checked against a strict pattern,
// not "cleaned": an id that does not match is rejected and nothing is sent for it.
// Redaction is a filter, not a proof, and it is deliberately not relied on here.
//
// Time. The source gives no message timestamp, so the age counts from the first pass
// that saw the question (`first_seen`). It can only understate the real wait, by up to
// the interval between passes (and by the whole downtime if the tool was not running).
//
// Identity. A question is `<turn id>#<n>`: n is its position among the marked messages of
// that turn, oldest first. Turns only grow at the end, so n is stable, and two questions
// in one turn stay distinct without keeping any text.
//
// Delivery guarantees. This is at-least-once, not exactly-once. The attempt is recorded
// BEFORE the send (so a crash loop cannot send without bound) and the delivery AFTER it.
// A crash, or a failed state write, between a successful send and the recording makes the
// next pass send it again: that window is real and is not closed here. A sender that
// reports failure although the message arrived causes the same duplicate.
//
// Unknown is not "nothing waiting". A source that throws leaves the state untouched. When
// the source says older turns could not be ruled out (`older_unknown`), no remembered
// question is forgotten. A remembered question is forgotten only when the source read fine,
// older_unknown is false, and the question is no longer listed (the operator answered it).
//
// A state file that is not exactly what this tool wrote is an error (StateCorrupt): it is
// never read as "empty", because that would resend everything or hide a delivery.
//
// One instance at a time per state file; there is no lock, two concurrent passes can both
// send.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexThread, Unreadable } from "./codexctl.ts";
import type { Questions } from "./codexctl.ts";

export const DEFAULT_THRESHOLD_MS = 5 * 60_000;
const MIN_THRESHOLD_MS = 1_000;
const MAX_THRESHOLD_MS = 7 * 24 * 3_600_000;
export const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_ATTEMPTS_LIMIT = 20;
export const DEFAULT_BACKOFF_MS = 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;
const MAX_ITEMS = 500;

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const KEY_RE = /^([A-Za-z0-9_-]{1,128})#([0-9]{1,4})$/;

export class ConfigError extends Error {}
/** The durable state is not what this tool wrote. Nothing is sent. */
export class StateCorrupt extends Error {}

export type QuestionSource = { questions(window: number): Promise<Questions> };
/** Resolve true only when the message is known to be delivered. false or a throw is a failure. */
export type Sender = (n: Notification) => Promise<boolean>;
export type Notification = { text: string; thread: string; turn: string; link: string | null; age_min: number };

export type Options = {
  /** Off unless true. When off, runOnce reads and writes nothing. */
  enabled: boolean;
  threadId: string;
  statePath: string;
  source: QuestionSource;
  sender: Sender;
  clock: () => number;
  thresholdMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
  window?: number;
  /** https base; the link is base + the validated thread id. Omit for no link. */
  linkBase?: string;
};

type Item = { first_seen: number; attempts: number; next_attempt: number; delivered_at: number | null };
type State = { version: 1; thread: string; items: Record<string, Item> };

export type RunResult =
  | { status: "disabled" }
  | { status: "unreadable"; detail: string }
  | { status: "ok"; waiting: number; sent: number; failed: number; deferred: number; gave_up: number; rejected: number; older_unknown: boolean };

function intIn(v: unknown, lo: number, hi: number, name: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < lo || v > hi) throw new ConfigError(`${name} must be an integer from ${lo} to ${hi}`);
  return v;
}

export function validId(v: unknown): v is string {
  return typeof v === "string" && ID_RE.test(v);
}

function link(base: string | undefined, thread: string): string | null {
  if (base === undefined) return null;
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new ConfigError("linkBase is not a URL");
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) throw new ConfigError("linkBase must be a plain https URL");
  return `${base.endsWith("/") ? base : `${base}/`}${thread}`;
}

export function emptyState(thread: string): State {
  return { version: 1, thread, items: {} };
}

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export function parseState(raw: string, thread: string): State {
  let d: any;
  try {
    d = JSON.parse(raw);
  } catch {
    throw new StateCorrupt("state is not JSON");
  }
  const bad = (why: string): never => {
    throw new StateCorrupt(why);
  };
  const exact = (o: any, keys: string[], what: string): void => {
    if (o === null || typeof o !== "object" || Array.isArray(o)) bad(`${what} is not an object`);
    const have = Object.keys(o).sort().join(",");
    if (have !== [...keys].sort().join(",")) bad(`${what} has unexpected fields`);
  };
  exact(d, ["version", "thread", "items"], "state");
  if (d.version !== 1) bad("unknown state version");
  if (d.thread !== thread) bad("state belongs to another thread");
  if (d.items === null || typeof d.items !== "object" || Array.isArray(d.items)) bad("items is not an object");
  const keys = Object.keys(d.items);
  if (keys.length > MAX_ITEMS) bad("too many items");
  const items: Record<string, Item> = Object.create(null);
  for (const k of keys) {
    if (!KEY_RE.test(k)) bad("bad item key");
    const it = d.items[k];
    exact(it, ["first_seen", "attempts", "next_attempt", "delivered_at"], "item");
    if (!isTime(it.first_seen) || !isTime(it.next_attempt)) bad("bad item time");
    if (!Number.isSafeInteger(it.attempts) || it.attempts < 0 || it.attempts > 1000) bad("bad attempts");
    if (it.delivered_at !== null && !isTime(it.delivered_at)) bad("bad delivered_at");
    items[k] = { first_seen: it.first_seen, attempts: it.attempts, next_attempt: it.next_attempt, delivered_at: it.delivered_at };
  }
  return { version: 1, thread, items };
}

function load(p: string, thread: string): State {
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return emptyState(thread);
    throw new StateCorrupt(`state cannot be read: ${err?.code ?? "error"}`);
  }
  return parseState(raw, thread);
}

/** Write to a temp file, flush it, then rename: a crash leaves the old or the new file, never half. */
function save(p: string, s: State): void {
  const tmp = `${p}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(s));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
}

const backoff = (base: number, attempts: number): number => Math.min(BACKOFF_CAP_MS, base * 2 ** (attempts - 1));

/** The only place a notification is made. Everything in it is a constant or a validated id. */
export function buildNotification(thread: string, turn: string, linkBase: string | undefined, ageMs: number): Notification {
  if (!validId(thread) || !validId(turn)) throw new ConfigError("refusing to build a notification from an unvalidated id");
  const age_min = Math.max(0, Math.floor(ageMs / 60_000));
  const l = link(linkBase, thread);
  const text = `An operator question has been waiting for about ${age_min} min. Thread ${thread}, turn ${turn}.${l ? ` ${l}` : ""}`;
  return { text, thread, turn, link: l, age_min };
}

export async function runOnce(o: Options): Promise<RunResult> {
  if (o.enabled !== true) return { status: "disabled" };
  const thresholdMs = intIn(o.thresholdMs ?? DEFAULT_THRESHOLD_MS, MIN_THRESHOLD_MS, MAX_THRESHOLD_MS, "thresholdMs");
  const maxAttempts = intIn(o.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 1, MAX_ATTEMPTS_LIMIT, "maxAttempts");
  const backoffMs = intIn(o.backoffMs ?? DEFAULT_BACKOFF_MS, 1_000, BACKOFF_CAP_MS, "backoffMs");
  const window = intIn(o.window ?? 20, 1, 200, "window");
  if (!validId(o.threadId)) throw new ConfigError("threadId is not a plain id");
  link(o.linkBase, o.threadId);

  const state = load(o.statePath, o.threadId);

  let q: Questions;
  try {
    q = await o.source.questions(window);
  } catch (err) {
    // Unknown: keep every remembered question exactly as it is.
    return { status: "unreadable", detail: err instanceof Error ? err.message.slice(0, 200) : "unreadable" };
  }
  if (!q || !Array.isArray(q.waiting) || typeof q.older_unknown !== "boolean") {
    return { status: "unreadable", detail: "the source returned something that is not a question list" };
  }

  const now = o.clock();
  const listed = new Set<string>();
  const perTurn = new Map<string, number>();
  let rejected = 0;
  for (const m of q.waiting) {
    const turn = (m as { turn?: unknown } | null)?.turn;
    if (!validId(turn)) {
      rejected++;
      continue;
    }
    const n = perTurn.get(turn) ?? 0;
    perTurn.set(turn, n + 1);
    const key = `${turn}#${n}`;
    if (n > 9999) {
      rejected++;
      continue;
    }
    listed.add(key);
    if (!state.items[key]) {
      if (Object.keys(state.items).length >= MAX_ITEMS) {
        rejected++;
        continue;
      }
      state.items[key] = { first_seen: now, attempts: 0, next_attempt: 0, delivered_at: null };
    }
  }
  // An invalid id can shift the numbering only inside its own (rejected) turn, never another's.
  if (!q.older_unknown) {
    for (const k of Object.keys(state.items)) if (!listed.has(k)) delete state.items[k];
  }
  save(o.statePath, state);

  let sent = 0, failed = 0, deferred = 0, gaveUp = 0;
  for (const key of [...listed].sort()) {
    const it = state.items[key];
    if (!it || it.delivered_at !== null) continue;
    if (now - it.first_seen < thresholdMs) continue;
    if (it.attempts >= maxAttempts) {
      gaveUp++;
      continue;
    }
    if (now < it.next_attempt) {
      deferred++;
      continue;
    }
    const turn = KEY_RE.exec(key)![1]!;
    it.attempts++;
    it.next_attempt = now + backoff(backoffMs, it.attempts);
    save(o.statePath, state); // the attempt is recorded before the send: see the crash window above
    let ok = false;
    try {
      ok = (await o.sender(buildNotification(o.threadId, turn, o.linkBase, o.clock() - it.first_seen))) === true;
    } catch {
      ok = false;
    }
    if (ok) {
      it.delivered_at = o.clock();
      save(o.statePath, state);
      sent++;
    } else {
      failed++;
    }
  }
  return { status: "ok", waiting: listed.size, sent, failed, deferred, gave_up: gaveUp, rejected, older_unknown: q.older_unknown };
}

// ---- optional CLI: reads the real thread, appends notifications to a local outbox ----

const USAGE = `usage: bun src/operator-notify.ts run --state FILE --outbox FILE [--threshold-min N] [--max-attempts N] [--link-base URL]

Off unless MCTL_OPERATOR_NOTIFY=1. Reads the thread like mctl-codex questions (same environment:
MCTL_BRIDGE_THREAD_ID, MCTL_BRIDGE_CODEX_SOCKET, MCTL_BRIDGE_HOME). A notification counts as
delivered once it is appended and flushed to the outbox file; no network transport exists here.
Exit: 0 ok, 1 usage or config, 2 source unreadable or state corrupt, 3 some delivery failed or was
rejected.`;

class UsageError extends Error {}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined) throw new UsageError(`${name} needs a value`);
  return v;
}

function outboxSender(file: string): Sender {
  return async (n) => {
    const fd = fs.openSync(file, "a", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(n) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  };
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  if (cmd !== "run") {
    console.error(USAGE);
    return 1;
  }
  for (let i = 0; i < args.length; i++) {
    if (["--state", "--outbox", "--threshold-min", "--max-attempts", "--link-base"].includes(args[i]!)) i++;
    else throw new UsageError(`unknown argument ${args[i]}`);
  }
  const enabled = process.env.MCTL_OPERATOR_NOTIFY === "1";
  if (!enabled) {
    console.log(JSON.stringify({ status: "disabled" }));
    return 0;
  }
  const state = flag(args, "--state");
  const outbox = flag(args, "--outbox");
  if (!state || !outbox) throw new UsageError("--state and --outbox are required");
  const num = (name: string, fallback: number): number => {
    const v = flag(args, name);
    if (v === undefined) return fallback;
    if (!/^[1-9][0-9]*$/.test(v)) throw new UsageError(`${name} must be a positive integer`);
    return Number(v);
  };
  const home = process.env.MCTL_BRIDGE_HOME ?? path.join(os.homedir(), "mctl-bridge");
  const threadId = (process.env.MCTL_BRIDGE_THREAD_ID ?? fs.readFileSync(path.join(home, "etc", "thread-id"), "utf8")).trim();
  const source = new CodexThread({
    threadId,
    socketPath: process.env.MCTL_BRIDGE_CODEX_SOCKET ?? path.join(os.homedir(), ".codex", "app-server-control", "app-server-control.sock"),
    sendLog: path.join(home, "log", "lead-sends.jsonl"), // questions() never writes it
    rpcTimeoutMs: 30_000,
  });
  const r = await runOnce({
    enabled,
    threadId,
    statePath: state,
    source,
    sender: outboxSender(outbox),
    clock: Date.now,
    thresholdMs: num("--threshold-min", DEFAULT_THRESHOLD_MS / 60_000) * 60_000,
    maxAttempts: num("--max-attempts", DEFAULT_MAX_ATTEMPTS),
    linkBase: flag(args, "--link-base"),
  });
  console.log(JSON.stringify(r));
  if (r.status === "unreadable") return 2;
  return r.status === "ok" && (r.failed > 0 || r.rejected > 0 || r.gave_up > 0) ? 3 : 0;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (err) {
    if (err instanceof UsageError || err instanceof ConfigError) {
      console.error(`${err.message}\n\n${USAGE}`);
      process.exit(1);
    }
    console.log(JSON.stringify({ status: "error", detail: err instanceof StateCorrupt || err instanceof Unreadable ? err.message : "failed" }));
    process.exit(2);
  }
}
