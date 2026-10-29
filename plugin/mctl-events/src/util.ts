// Small helpers that keep messages, keys and logs identical to the Python
// adapter (events/mctl_events/), which this plugin replaces.

/** Python's `repr()` of a list of strings, e.g. `['a', 'b']`. */
export function pyListRepr(items: readonly string[]): string {
  return "[" + items.map(pyStrRepr).join(", ") + "]";
}

/** Python's `repr()` of a str: single quotes unless the text holds one and no double quote. */
export function pyStrRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of text) {
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch < " " || ch === "\x7f") out += "\\x" + ch.charCodeAt(0).toString(16).padStart(2, "0");
    else out += ch;
  }
  return quote + out + quote;
}

/** `urllib.parse.quote(text, safe="")`: everything but `A-Za-z0-9_.-~` is percent-encoded. */
export function pyQuote(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Python truthiness for a JSON value (`x or default`). */
export function pyFalsy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isObject(value)) return Object.keys(value).length === 0;
  return false;
}

/** A JSON object: what Python's `isinstance(x, dict)` accepts after `json.loads`. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Slice by code points, as Python's `text[:n]` does. */
export function pySlice(text: string, n: number): string {
  let out = "";
  let count = 0;
  for (const ch of text) {
    if (count++ >= n) break;
    out += ch;
  }
  return out;
}

/** Code point length, as Python's `len(text)`. */
export function pyLen(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** `time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(seconds))`. Throws RangeError out of range. */
export function isoSeconds(seconds: number): string {
  const date = new Date(Math.floor(seconds) * 1000);
  if (Number.isNaN(date.getTime())) throw new RangeError(`timestamp out of range: ${seconds}`);
  const year = date.getUTCFullYear();
  if (year < 1 || year > 9999) throw new RangeError(`year ${year} is out of range`);
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface PyJsonOptions {
  /** `sort_keys=True`. */
  sortKeys?: boolean;
  /** `separators=(",", ":")` instead of Python's default `(", ", ": ")`. */
  compact?: boolean;
}

/**
 * `json.dumps(value)` as Python writes it: `ensure_ascii` (everything outside
 * printable ASCII escaped as `\uXXXX`), Python's default separators unless
 * `compact`, and insertion order unless `sortKeys`.
 */
export function pyJson(value: unknown, options: PyJsonOptions = {}): string {
  const item = options.compact ? "," : ", ";
  const pair = options.compact ? ":" : ": ";
  const encode = (v: unknown): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "string") return asciiString(v);
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : v > 0 ? "Infinity" : v < 0 ? "-Infinity" : "NaN";
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "boolean") return v ? "true" : "false";
    if (Array.isArray(v)) return "[" + v.map(encode).join(item) + "]";
    if (isObject(v)) {
      const keys = Object.keys(v);
      if (options.sortKeys) keys.sort(compareCodePoints);
      return "{" + keys.map((k) => asciiString(k) + pair + encode(v[k])).join(item) + "}";
    }
    return asciiString(String(v));
  };
  return encode(value);
}

function asciiString(text: string): string {
  // JSON.stringify already escapes controls as Python does (\n, \u001f, and a
  // lone surrogate as \udXXX); what is left above printable ASCII is escaped
  // one UTF-16 unit at a time, which is how Python writes astral characters too.
  return JSON.stringify(text).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** JSON with keys sorted at every level, compact separators (`sort_keys=True, separators=(",", ":")`). */
export function canonicalJson(value: unknown): string {
  return pyJson(value, { sortKeys: true, compact: true });
}

/** Python's str ordering (by code point), not JavaScript's UTF-16 unit ordering. */
export function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const na = ia.next();
    const nb = ib.next();
    if (na.done || nb.done) return na.done && nb.done ? 0 : na.done ? -1 : 1;
    const ca = na.value.codePointAt(0)!;
    const cb = nb.value.codePointAt(0)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
}

// A broken stderr pipe is reported as an 'error' event, not thrown from
// write(); without a listener it would crash the process before the audit
// queue is flushed.
process.stderr.on("error", () => undefined);

/** A structured log line on stderr, as `channel._log` writes it. */
export function log(message: string, fields: Record<string, unknown> = {}): void {
  const now = new Date();
  const record = { ts: now.toISOString().replace(/\.\d{3}Z$/, "Z"), msg: message, ...fields };
  try {
    process.stderr.write(pyJson(record, { sortKeys: true }) + "\n");
  } catch {
    // stderr gone: nothing left to tell.
  }
}

/** A promise that resolves after `ms`, or at once when `signal` fires. */
export class StopSignal {
  private stopped = false;
  private waiters = new Set<() => void>();

  get isSet(): boolean {
    return this.stopped;
  }

  set(): void {
    this.stopped = true;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  /** Resolves true when stopped, false on timeout. */
  wait(ms: number): Promise<boolean> {
    if (this.stopped) return Promise.resolve(true);
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(this.stopped);
      };
      const timer = setTimeout(wake, Math.max(ms, 0));
      this.waiters.add(wake);
    });
  }
}
