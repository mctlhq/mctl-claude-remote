// MCTL-CJ1: the restricted deterministic JSON profile of the dispatch-feasibility design
// (docs/dispatch-feasibility-146.md section 4, refs #146). Pure: no host, store, clock, random,
// network or filesystem access. The only import is a hash primitive.
//
// This is NOT RFC 8785 and makes no cross-language equivalence claim (gate G6).
// Errors carry a closed code only, never an offending value or an arbitrary input key.

import { createHash } from "node:crypto";

export type CanonicalCode =
  | "bad_json" // malformed JSON text
  | "bad_key" // object key outside the ASCII key rule
  | "bad_domain" // digest domain outside the closed set
  | "bad_scalar" // lone surrogate
  | "duplicate_key"
  | "forbidden_number" // float, exponent, non-finite, -0, leading zero, plus sign, ...
  | "null_value"
  | "too_deep"
  | "unsafe_integer"
  | "unsorted_set" // set-valued field not strictly ascending by UTF-8 bytes
  | "wrong_type";

export class CanonicalError extends Error {
  readonly code: CanonicalCode;
  constructor(code: CanonicalCode) {
    super(code);
    this.name = "CanonicalError";
    this.code = code;
  }
}

function fail(code: CanonicalCode): never {
  throw new CanonicalError(code);
}

export const DOMAINS = Object.freeze({
  "task-envelope": "mctl.feasibility/1/task-envelope",
  "capability-snapshot": "mctl.feasibility/1/capability-snapshot",
  report: "mctl.feasibility/1/report",
  "test-vector": "mctl.feasibility/1/test-vector",
});
export type DomainName = keyof typeof DOMAINS;

export const MAX_DEPTH = 64;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_SAFE_BIG = BigInt(MAX_SAFE);
const utf8 = new TextEncoder();

export interface CanonicalOptions {
  /** Object key names whose array value is a set: must be strict ascending UTF-8 byte order, no duplicates. */
  readonly setFields?: ReadonlySet<string>;
  /** Top-level member names left out of the bytes (self-field exclusion, e.g. report_digest). */
  readonly exclude?: readonly string[];
}

function compareBytes(a: string, b: string): number {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

const HEX = "0123456789abcdef";

function encodeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d < 0xdc00 || d > 0xdfff) fail("bad_scalar");
      out += s[i]! + s[i + 1]!;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      fail("bad_scalar");
    } else if (c === 0x22) {
      out += '\\"';
    } else if (c === 0x5c) {
      out += "\\\\";
    } else if (c < 0x20) {
      out += "\\u00" + HEX[c >> 4]! + HEX[c & 15]!;
    } else {
      out += s[i]!;
    }
  }
  return out + '"';
}

function encodeInteger(n: number): string {
  if (!Number.isFinite(n) || !Number.isInteger(n) || Object.is(n, -0)) fail("forbidden_number");
  if (Math.abs(n) > MAX_SAFE) fail("unsafe_integer");
  return String(n);
}

/**
 * Validate an array's own properties from descriptors only and return its element values.
 * Rejects (wrong_type) any Symbol key, any non-index string key other than "length", accessor
 * or non-enumerable indices, and sparse arrays. No element getter is ever invoked.
 */
function readDenseArray(v: unknown[]): unknown[] {
  const keys = Reflect.ownKeys(v);
  const len = v.length;
  const items: unknown[] = new Array<unknown>(len);
  let count = 0;
  for (const k of keys) {
    if (typeof k === "symbol") fail("wrong_type");
  }
  for (const k of keys as string[]) {
    if (k === "length") continue;
    if (!/^(0|[1-9][0-9]*)$/.test(k)) fail("wrong_type");
    const i = Number(k);
    if (i >= len || i >= 4294967295) fail("wrong_type");
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || d.get || d.set || !("value" in d) || d.enumerable !== true) fail("wrong_type");
    items[i] = d.value;
    count++;
  }
  if (count !== len) fail("wrong_type"); // sparse
  return items;
}

function encodeValue(v: unknown, depth: number, seen: Set<object>, opts: CanonicalOptions, field: string | null): string {
  if (depth > MAX_DEPTH) fail("too_deep");
  switch (typeof v) {
    case "string":
      if (field !== null && opts.setFields?.has(field)) fail("wrong_type");
      return encodeString(v);
    case "boolean":
      if (field !== null && opts.setFields?.has(field)) fail("wrong_type");
      return v ? "true" : "false";
    case "number":
      if (field !== null && opts.setFields?.has(field)) fail("wrong_type");
      return encodeInteger(v);
    case "object":
      break;
    default:
      return fail("wrong_type"); // undefined, bigint, function, symbol
  }
  if (v === null) return fail("null_value");
  if (seen.has(v)) return fail("too_deep");
  const isSet = field !== null && opts.setFields?.has(field) === true;
  seen.add(v);
  try {
    if (Array.isArray(v)) {
      const items = readDenseArray(v);
      const parts: string[] = [];
      let prev: string | null = null;
      for (let i = 0; i < items.length; i++) {
        const item: unknown = items[i];
        if (isSet) {
          if (typeof item !== "string") fail("wrong_type");
          encodeString(item); // scalar check before ordering
          if (prev !== null && compareBytes(prev, item) >= 0) fail("unsorted_set");
          prev = item;
        }
        parts.push(encodeValue(item, depth + 1, seen, opts, null));
      }
      return "[" + parts.join(",") + "]";
    }
    if (isSet) fail("wrong_type");
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) fail("wrong_type");
    if (Object.getOwnPropertySymbols(v).length > 0) fail("wrong_type");
    const record = v as Record<string, unknown>;
    const skip = depth === 0 ? (opts.exclude ?? []) : [];
    const keys = Object.keys(record).filter((k) => !skip.includes(k));
    for (const k of keys) {
      // ASCII keys only (design section 4 rule 2); this also rejects lone surrogates in keys.
      if (!/^[\x00-\x7f]*$/.test(k)) fail("bad_key");
      const d = Object.getOwnPropertyDescriptor(record, k);
      if (!d || d.get || d.set) fail("wrong_type");
    }
    keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // ASCII: code-unit order == UTF-8 byte order
    return "{" + keys.map((k) => encodeString(k) + ":" + encodeValue(record[k], depth + 1, seen, opts, k)).join(",") + "}";
  } finally {
    seen.delete(v);
  }
}

/** Canonical MCTL-CJ1 body for a JSON value tree. Throws CanonicalError (closed code only). */
export function canonicalize(value: unknown, opts: CanonicalOptions = {}): string {
  return encodeValue(value, 0, new Set(), opts, null);
}

/** The exact bytes hashed: domain || 0x0A || canonical body. */
export function digestInput(domain: DomainName, body: string): Uint8Array {
  if (!Object.hasOwn(DOMAINS, domain)) fail("bad_domain");
  return utf8.encode(DOMAINS[domain] + "\n" + body);
}

/** Lowercase-hex SHA-256 of the domain-separated canonical bytes. */
export function digest(domain: DomainName, value: unknown, opts: CanonicalOptions = {}): string {
  return createHash("sha256").update(digestInput(domain, canonicalize(value, opts))).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Strict raw-text parser. JSON.parse silently keeps the last duplicate key and collapses 1.0, 1e3
// and -0 into ordinary numbers, so those must be detected on the text before any value exists.
// ---------------------------------------------------------------------------------------------

const INT_RE = /^-?(0|[1-9][0-9]*)$/;
const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

/** Parse JSON text into a value tree in the closed MCTL-CJ1 subset, or throw CanonicalError. */
export function parseStrict(text: string): unknown {
  if (typeof text !== "string") fail("wrong_type");
  let pos = 0;
  const n = text.length;

  const skip = (): void => {
    while (pos < n && WS.has(text.charCodeAt(pos))) pos++;
  };

  const hex4 = (): number => {
    if (pos + 4 > n) fail("bad_json");
    const h = text.slice(pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) fail("bad_json");
    pos += 4;
    return parseInt(h, 16);
  };

  const parseString = (): string => {
    pos++; // opening quote
    let out = "";
    for (;;) {
      if (pos >= n) fail("bad_json");
      const c = text.charCodeAt(pos);
      if (c === 0x22) {
        pos++;
        return out;
      }
      if (c < 0x20) fail("bad_json");
      if (c === 0x5c) {
        pos++;
        if (pos >= n) fail("bad_json");
        const e = text[pos++]!;
        switch (e) {
          case '"': out += '"'; break;
          case "\\": out += "\\"; break;
          case "/": out += "/"; break;
          case "b": out += "\b"; break;
          case "f": out += "\f"; break;
          case "n": out += "\n"; break;
          case "r": out += "\r"; break;
          case "t": out += "\t"; break;
          case "u": {
            const u = hex4();
            if (u >= 0xdc00 && u <= 0xdfff) fail("bad_scalar");
            if (u >= 0xd800 && u <= 0xdbff) {
              if (text[pos] !== "\\" || text[pos + 1] !== "u") fail("bad_scalar");
              pos += 2;
              const lo = hex4();
              if (lo < 0xdc00 || lo > 0xdfff) fail("bad_scalar");
              out += String.fromCharCode(u, lo);
            } else {
              out += String.fromCharCode(u);
            }
            break;
          }
          default:
            fail("bad_json");
        }
        continue;
      }
      if (c >= 0xd800 && c <= 0xdbff) {
        const d = pos + 1 < n ? text.charCodeAt(pos + 1) : 0;
        if (d < 0xdc00 || d > 0xdfff) fail("bad_scalar");
        out += text[pos]! + text[pos + 1]!;
        pos += 2;
        continue;
      }
      if (c >= 0xdc00 && c <= 0xdfff) fail("bad_scalar");
      out += text[pos++]!;
    }
  };

  const parseNumber = (): number => {
    const start = pos;
    while (pos < n && /[0-9A-Za-z.+\-]/.test(text[pos]!)) pos++;
    const tok = text.slice(start, pos);
    if (!/[0-9]/.test(tok)) fail("bad_json");
    if (!INT_RE.test(tok)) fail("forbidden_number");
    if (tok === "-0") fail("forbidden_number");
    const big = BigInt(tok);
    if (big > MAX_SAFE_BIG || big < -MAX_SAFE_BIG) fail("unsafe_integer");
    return Number(big);
  };

  const parseValue = (depth: number): unknown => {
    skip();
    if (pos >= n) fail("bad_json");
    const c = text[pos]!;
    if (c === "{") {
      if (depth >= MAX_DEPTH) fail("too_deep");
      pos++;
      const obj: Record<string, unknown> = {};
      const keys = new Set<string>();
      skip();
      if (text[pos] === "}") {
        pos++;
        return obj;
      }
      for (;;) {
        skip();
        if (text[pos] !== '"') fail("bad_json");
        const k = parseString();
        if (keys.has(k)) fail("duplicate_key");
        keys.add(k);
        skip();
        if (text[pos] !== ":") fail("bad_json");
        pos++;
        const val = parseValue(depth + 1);
        Object.defineProperty(obj, k, { value: val, enumerable: true, writable: true, configurable: true });
        skip();
        if (text[pos] === ",") {
          pos++;
          continue;
        }
        if (text[pos] === "}") {
          pos++;
          return obj;
        }
        fail("bad_json");
      }
    }
    if (c === "[") {
      if (depth >= MAX_DEPTH) fail("too_deep");
      pos++;
      const arr: unknown[] = [];
      skip();
      if (text[pos] === "]") {
        pos++;
        return arr;
      }
      for (;;) {
        arr.push(parseValue(depth + 1));
        skip();
        if (text[pos] === ",") {
          pos++;
          continue;
        }
        if (text[pos] === "]") {
          pos++;
          return arr;
        }
        fail("bad_json");
      }
    }
    if (c === '"') return parseString();
    if (c === "-" && text[pos + 1] === "I") fail("forbidden_number");
    if (c === "-" || c === "+" || c === "." || (c >= "0" && c <= "9")) return parseNumber();
    if (/[A-Za-z]/.test(c)) {
      const start = pos;
      while (pos < n && /[A-Za-z]/.test(text[pos]!)) pos++;
      const word = text.slice(start, pos);
      if (word === "true") return true;
      if (word === "false") return false;
      if (word === "null") return fail("null_value");
      if (word === "NaN" || word === "Infinity") return fail("forbidden_number");
    }
    return fail("bad_json");
  };

  const result = parseValue(0);
  skip();
  if (pos < n) fail("bad_json");
  return result;
}
