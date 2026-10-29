// Event envelope v1 -- a signal that something happened, never a copy of it.
//
// The envelope carries identity and references only. The content an event
// refers to (a Telegram message body, a pull request) stays in its system of
// record and is hydrated by Claude through that system's MCP tools, under that
// system's own authorization. That is why the envelope is closed: an unknown
// top-level field is rejected rather than passed along, so a producer cannot
// start smuggling bodies through the transport by adding a key.
//
// Canonical JSON Schema: mctlhq/.github events/schemas/event-envelope.v1.schema.json.
// This module is the consumer-side enforcement of the same contract, ported
// from events/mctl_events/envelope.py.

import { canonicalJson, isObject, pyLen, pyListRepr } from "./util.ts";

export const SPEC_VERSION = "mctl.events/v1";

const FIELDS = ["specversion", "id", "type", "source", "occurred_at", "correlation_id", "subject"] as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._/@#-]{0,255}$/;
const TYPE = /^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$/;
const SOURCE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SUBJECT_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const RFC3339 =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;
const KIND = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
// A subject value is an identifier (a number, `user:42`, `owner/repo`, a SHA),
// never prose: no whitespace, quotes or brackets, so a free-text sentence
// cannot travel in a reference-shaped key such as `subject.text`.
const SUBJECT_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/@#+=-]*$/;
export const MAX_KIND = 64;
export const MAX_SUBJECT_KEYS = 12;
export const MAX_SUBJECT_VALUE = 256;
export const MAX_ENVELOPE_BYTES = 4096;

export class InvalidEnvelope extends Error {
  override name = "InvalidEnvelope";
}

export interface Envelope {
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly occurred_at: string;
  readonly correlation_id: string;
  readonly subject: Readonly<Record<string, string>>;
}

export function toJson(env: Envelope): string {
  return canonicalJson({
    specversion: SPEC_VERSION,
    id: env.id,
    type: env.type,
    source: env.source,
    occurred_at: env.occurred_at,
    correlation_id: env.correlation_id,
    subject: env.subject,
  });
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function parse(raw: string | Uint8Array): Envelope {
  let text: string;
  if (typeof raw !== "string") {
    if (raw.byteLength > MAX_ENVELOPE_BYTES) throw new InvalidEnvelope(`envelope exceeds ${MAX_ENVELOPE_BYTES} bytes`);
    try {
      text = utf8.decode(raw);
    } catch {
      throw new InvalidEnvelope("envelope is not UTF-8");
    }
  } else {
    text = raw;
  }
  // A string can hold a lone surrogate that no UTF-8 byte input could.
  if (!text.isWellFormed()) throw new InvalidEnvelope("envelope is not UTF-8");
  if (Buffer.byteLength(text, "utf8") > MAX_ENVELOPE_BYTES) {
    throw new InvalidEnvelope(`envelope exceeds ${MAX_ENVELOPE_BYTES} bytes`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (exc) {
    if (exc instanceof RangeError) throw new InvalidEnvelope("envelope nests too deeply");
    // V8's message quotes the input; the reason must never echo it.
    throw new InvalidEnvelope("envelope is not JSON: invalid syntax");
  }
  return fromDict(doc);
}

export function fromDict(doc: unknown): Envelope {
  // Rejection reasons reach stderr and the audit stream: they name the field,
  // never echo the untrusted value.
  if (!isObject(doc)) throw new InvalidEnvelope("envelope must be an object");
  const keys = Object.keys(doc);
  const unknown = keys.filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (unknown.length) throw new InvalidEnvelope(`${unknown.length} unknown envelope field(s)`);
  const missing = FIELDS.filter((k) => !keys.includes(k)).sort();
  if (missing.length) throw new InvalidEnvelope(`missing envelope fields: ${pyListRepr(missing)}`);
  if (doc.specversion !== SPEC_VERSION) throw new InvalidEnvelope("unsupported specversion");
  for (const [name, pattern] of [["id", ID], ["type", TYPE], ["source", SOURCE], ["correlation_id", ID]] as const) {
    const value = doc[name];
    if (typeof value !== "string" || !pattern.test(value)) throw new InvalidEnvelope(`invalid ${name}`);
  }
  const occurredAt = doc.occurred_at;
  if (typeof occurredAt !== "string" || !validTimestamp(occurredAt)) throw new InvalidEnvelope("invalid occurred_at");

  const subject = doc.subject;
  if (!isObject(subject) || !Object.hasOwn(subject, "kind")) {
    throw new InvalidEnvelope("subject must be an object with a kind");
  }
  const kind = subject.kind;
  if (typeof kind !== "string" || pyLen(kind) > MAX_KIND || !KIND.test(kind)) {
    throw new InvalidEnvelope("invalid subject.kind");
  }
  const entries = Object.entries(subject);
  if (entries.length > MAX_SUBJECT_KEYS) throw new InvalidEnvelope(`subject has more than ${MAX_SUBJECT_KEYS} keys`);
  const normalized: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!SUBJECT_KEY.test(key)) throw new InvalidEnvelope("invalid subject key");
    // References are bounded strings. A nested object, list or unbounded
    // number is how content (or an oversized value) would sneak in.
    if (typeof value !== "string") throw new InvalidEnvelope(`subject.${key} must be a string`);
    if (!value || pyLen(value) > MAX_SUBJECT_VALUE) {
      throw new InvalidEnvelope(`subject.${key} must be 1..${MAX_SUBJECT_VALUE} characters`);
    }
    if (!SUBJECT_VALUE.test(value)) throw new InvalidEnvelope(`subject.${key} must be an identifier, not free text`);
    normalized[key] = value;
  }
  return {
    id: doc.id as string,
    type: doc.type as string,
    source: doc.source as string,
    occurred_at: occurredAt,
    correlation_id: doc.correlation_id as string,
    subject: normalized,
  };
}

/** The RFC 3339 shape plus a real calendar date, as `datetime.fromisoformat` checks it. */
function validTimestamp(value: string): boolean {
  const match = RFC3339.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= days;
}
