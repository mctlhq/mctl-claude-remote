// Dispatch feasibility evaluator (B1, refs #146). PARTIAL: only the A1 path grammar slice is implemented.
// evaluate() and validate_report_for_consumption() are held on open design gaps (see task report).
// Pure: no host, store, clock, random, network or filesystem access.

export class PathGrammarError extends Error {
  readonly code = "bad_path_grammar" as const;
  constructor() {
    super("bad_path_grammar");
    this.name = "PathGrammarError";
  }
}

export interface NormalPattern {
  readonly kind: "exact" | "dir";
  readonly segs: readonly string[];
}

/** A1 normal form: alias step first (terminal `/**` -> `/`), then the segment grammar. */
export function normalizePattern(pattern: string): NormalPattern {
  if (typeof pattern !== "string" || pattern.length === 0) throw new PathGrammarError();
  let p = pattern;
  if (p.endsWith("/**") && p.length > 3) p = p.slice(0, -2);
  let kind: "exact" | "dir" = "exact";
  if (p.endsWith("/")) {
    kind = "dir";
    p = p.slice(0, -1);
  }
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) throw new PathGrammarError();
  const segs = p.split("/");
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") throw new PathGrammarError();
    if (/[\\*?[{\x00-\x1f]/.test(s)) throw new PathGrammarError();
  }
  return { kind, segs };
}

function isPrefix(a: readonly string[], b: readonly string[]): boolean {
  return a.length <= b.length && a.every((s, i) => s === b[i]);
}

/** Does `pattern` match the exact repo-relative `path`? */
export function patternMatches(pattern: string, path: string): boolean {
  const q = normalizePattern(path);
  if (q.kind !== "exact") throw new PathGrammarError();
  const p = normalizePattern(pattern);
  if (p.kind === "exact") return p.segs.length === q.segs.length && isPrefix(p.segs, q.segs);
  return p.segs.length < q.segs.length && isPrefix(p.segs, q.segs);
}

/** Scope intersection per the 13.1 table; exact paths are leaves. Symmetric by construction. */
export function patternsIntersect(a: string, b: string): boolean {
  const p = normalizePattern(a);
  const q = normalizePattern(b);
  if (p.kind === "exact" && q.kind === "exact") return p.segs.length === q.segs.length && isPrefix(p.segs, q.segs);
  if (p.kind === "exact") return q.segs.length < p.segs.length && isPrefix(q.segs, p.segs);
  if (q.kind === "exact") return p.segs.length < q.segs.length && isPrefix(p.segs, q.segs);
  return isPrefix(p.segs, q.segs) || isPrefix(q.segs, p.segs);
}
