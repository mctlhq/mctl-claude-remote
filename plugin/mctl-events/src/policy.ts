// Routing policy: which events this session is allowed to be woken by.
//
// A session subscribes to streams and, within each, to event types and
// subject values. Anything outside the policy is acknowledged and audited as
// `skipped`, never delivered: a Claude session must not be woken for an
// account or a repository it does not own, even if the producer and the
// stream share it. Deny by default -- an empty route list delivers nothing.
//
// Ported from events/mctl_events/policy.py; the policy.json format is the same.

import { readFileSync } from "node:fs";

import type { Envelope } from "./envelope.ts";
import { fnmatchcase } from "./fnmatch.ts";
import { compareCodePoints, isObject, pyListRepr } from "./util.ts";

const STREAM = /^mctl:events:[a-z0-9][a-z0-9_-]{0,62}$/;
const STREAM_PATTERN = "^mctl:events:[a-z0-9][a-z0-9_-]{0,62}$";
// Streams the adapter itself writes to. Subscribing to one would feed the
// adapter its own output: every audit entry has no envelope, so each would be
// rejected and audited again, forever.
export const RESERVED_STREAMS: ReadonlySet<string> = new Set(["mctl:events:audit", "mctl:events:state"]);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";

export class PolicyError extends Error {
  override name = "PolicyError";
}

export class Route {
  readonly stream: string;
  readonly sources: readonly string[];
  readonly types: readonly string[];
  readonly subject: Readonly<Record<string, readonly string[]>>;

  constructor(
    stream: string,
    sources: readonly string[],
    types: readonly string[],
    subject: Readonly<Record<string, readonly string[]>> = {},
  ) {
    this.stream = stream;
    this.sources = sources;
    this.types = types;
    this.subject = subject;
  }

  matches(stream: string, envelope: Envelope): boolean {
    if (stream !== this.stream || !this.sources.includes(envelope.source)) return false;
    if (!this.types.some((pattern) => fnmatchcase(envelope.type, pattern))) return false;
    for (const [key, patterns] of Object.entries(this.subject)) {
      const value = Object.hasOwn(envelope.subject, key) ? envelope.subject[key] : undefined;
      if (value === undefined || !patterns.some((p) => fnmatchcase(value, p))) return false;
    }
    return true;
  }
}

export interface Policy {
  readonly group: string;
  readonly consumer: string;
  readonly routes: readonly Route[];
  readonly max_inflight: number;
  readonly block_ms: number;
  // How long an acknowledged event id is remembered in Valkey, so a producer
  // retry that arrives after a restart is acknowledged instead of waking the
  // session again. Producers republish from an outbox within minutes; a day
  // covers that with room to spare and costs one small key per event.
  readonly dedup_ttl_seconds: number;
  // An event unacknowledged for at least this long is delivered again with
  // the next attempt number: this consumer's own in-flight events are pushed
  // to the session once more, and an entry pending on *another* consumer is
  // taken over (XCLAIM). Generous on purpose: a session that is simply slow
  // to answer is told to check for an earlier side effect, not undercut.
  readonly reclaim_min_idle_ms: number;
  // Delay between the client's last handshake message (`initialized`, then
  // `tools/list`) and the first delivery. Claude Code registers its channel
  // handler only after the server's capabilities have propagated through its
  // UI state, and a notification pushed before that is dropped by the client
  // without a trace, so the adapter waits for the handshake to go quiet.
  readonly startup_grace_ms: number;
  // Deliveries of one entry before it is rejected: a poison event that Claude
  // never acknowledges must not be reclaimed forever.
  readonly max_attempts: number;
  // Where a consumer group starts when the adapter creates it for the first
  // time: "$" = only events published from now on; "0" = replay the retained
  // stream. Once created, the group's position lives in Valkey.
  readonly group_start: "$" | "0";
  readonly streams: readonly string[];
}

export function routeFor(policy: Policy, stream: string, envelope: Envelope): Route | undefined {
  return policy.routes.find((route) => route.matches(stream, envelope));
}

function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || !value.length || !value.every((v) => typeof v === "string" && v)) {
    throw new PolicyError(`${where} must be a non-empty list of strings`);
  }
  return [...(value as string[])];
}

function positive(doc: Record<string, unknown>, key: string, fallback: number): number {
  const value = Object.hasOwn(doc, key) ? doc[key] : fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new PolicyError(`${key} must be a positive integer`);
  }
  return value;
}

function groupStart(value: unknown): "$" | "0" {
  if (value !== "$" && value !== "0") throw new PolicyError('group_start must be "$" or "0"');
  return value;
}

const ALLOWED = new Set([
  "group", "consumer", "routes", "max_inflight", "block_ms", "group_start",
  "dedup_ttl_seconds", "reclaim_min_idle_ms", "max_attempts", "startup_grace_ms",
]);
const ROUTE_KEYS = new Set(["stream", "sources", "types", "subject"]);

export function fromDict(doc: unknown): Policy {
  if (!isObject(doc)) throw new PolicyError("policy must be an object");
  // Only knobs this adapter honours: accepting any other field would let an
  // operator believe a setting is in effect when nothing reads it.
  const unknown = Object.keys(doc).filter((k) => !ALLOWED.has(k)).sort(compareCodePoints);
  if (unknown.length) throw new PolicyError(`unknown policy fields: ${pyListRepr(unknown)}`);
  for (const key of ["group", "consumer"]) {
    const value = doc[key];
    if (typeof value !== "string" || !NAME.test(value)) throw new PolicyError(`${key} must match ${NAME_PATTERN}`);
  }
  const routesDoc = doc.routes;
  if (!Array.isArray(routesDoc)) throw new PolicyError("routes must be a list");
  const routes: Route[] = [];
  routesDoc.forEach((item: unknown, index) => {
    const where = `routes[${index}]`;
    if (!isObject(item) || Object.keys(item).some((k) => !ROUTE_KEYS.has(k))) {
      throw new PolicyError(`${where} must be an object with stream, sources, types and optional subject`);
    }
    const stream = item.stream;
    if (typeof stream !== "string" || !STREAM.test(stream)) {
      throw new PolicyError(`${where}.stream must match ${STREAM_PATTERN}`);
    }
    if (RESERVED_STREAMS.has(stream)) {
      throw new PolicyError(`${where}.stream ${stream} is reserved for the adapter's own output`);
    }
    const subjectDoc = Object.hasOwn(item, "subject") ? item.subject : {};
    if (!isObject(subjectDoc)) throw new PolicyError(`${where}.subject must be an object`);
    const sources = strings(item.sources, `${where}.sources`);
    const types = strings(item.types, `${where}.types`);
    const subject: Record<string, string[]> = {};
    for (const key of Object.keys(subjectDoc).sort(compareCodePoints)) {
      subject[key] = strings(subjectDoc[key], `${where}.subject.${key}`);
    }
    routes.push(new Route(stream, sources, types, subject));
  });
  const policy = {
    group: doc.group as string,
    consumer: doc.consumer as string,
    routes,
    max_inflight: positive(doc, "max_inflight", 5),
    block_ms: positive(doc, "block_ms", 5000),
    group_start: groupStart(Object.hasOwn(doc, "group_start") ? doc.group_start : "$"),
    dedup_ttl_seconds: positive(doc, "dedup_ttl_seconds", 86400),
    reclaim_min_idle_ms: positive(doc, "reclaim_min_idle_ms", 300000),
    max_attempts: positive(doc, "max_attempts", 5),
    startup_grace_ms: positive(doc, "startup_grace_ms", 3000),
    streams: [...new Set(routes.map((route) => route.stream))].sort(compareCodePoints),
  };
  return Object.freeze(policy);
}

export function load(path: string): Policy {
  return fromDict(JSON.parse(readFileSync(path, "utf8")));
}
