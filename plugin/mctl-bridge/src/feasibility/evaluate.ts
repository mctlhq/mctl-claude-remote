// Dispatch feasibility evaluator (B1, refs #146): pure evaluate() and validate_report_for_consumption().
// Design: docs/dispatch-feasibility-146.md sections 3-10, 13, 14 (accepted contracts; design only).
// Pure: no host, store, clock, random, network or filesystem access. The only imports are the
// canonical encoder (hash primitive) and the closed types/tables.
//
// Non-claims: a report authorizes nothing, reserves nothing, proves no OS isolation, closes no TOCTOU.
// A digest proves byte integrity only; `valid: true` from the consumption function is not authority.

import { CanonicalError, digest } from "./canonical.ts";
import {
  ADVISORY_CODES,
  BINDING_CHECKS,
  CHECK_ORDER,
  CLASS_RANK,
  CODE_TABLE,
  CONSUME_CHECK_ORDER,
  CONSUME_CODES,
  EVIDENCE_FACTS,
  FACT_IDS,
  FeasibilityInputError,
  MATCHER_CONTRACT_REVISION,
  NON_CLAIMS,
  SCHEMAS,
  SNAPSHOT_DERIVED_CHECKS,
  VERDICTS,
} from "./types.ts";
import type {
  AdvisoryCode,
  Check,
  CheckId,
  CheckStatus,
  ConsumptionCheck,
  ConsumptionResult,
  Envelope,
  EvidenceRef,
  FactId,
  InputKind,
  ReasonClass,
  Report,
  Snapshot,
  Verdict,
} from "./types.ts";

export { FeasibilityInputError } from "./types.ts";
export type { Envelope, Snapshot, Report, ConsumptionResult } from "./types.ts";

// ---------------------------------------------------------------------------------------------
// A1 path grammar (13.1, 14.11)
// ---------------------------------------------------------------------------------------------

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
    if (/[\\*?[{\x00-\x1f\x7f-\x9f]/.test(s)) throw new PathGrammarError();
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

// ---------------------------------------------------------------------------------------------
// Closed-schema validation. Throws SchemaFail internally; entry points convert to the sanitized
// FeasibilityInputError (input kind, closed code, fixed path template; never a value or input key).
// ---------------------------------------------------------------------------------------------

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_SAFE_BIG = BigInt(MAX_SAFE);
const MAX_SAFE_DIGITS = String(MAX_SAFE).length;
const utf8 = new TextEncoder();

function compareBytes(a: string, b: string): number {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

class SchemaFail extends Error {
  readonly fcode: FeasibilityInputError["code"];
  readonly fpath: string;
  constructor(code: FeasibilityInputError["code"], path: string) {
    super(code);
    this.fcode = code;
    this.fpath = path;
  }
}

function bad(code: FeasibilityInputError["code"], path: string): never {
  throw new SchemaFail(code, path);
}

type V = (v: unknown, path: string) => void;
const join = (p: string, k: string): string => (p === "" ? k : p + "." + k);

function plain(v: unknown, path: string): Record<string, unknown> {
  if (v === null) return bad("null_value", path);
  if (typeof v !== "object" || Array.isArray(v)) return bad("wrong_type", path);
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return bad("wrong_type", path);
  for (const k of Reflect.ownKeys(v)) {
    if (typeof k === "symbol") return bad("wrong_type", path);
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || d.get || d.set || !("value" in d) || d.enumerable !== true) return bad("wrong_type", path);
  }
  return v as Record<string, unknown>;
}

function dense(v: unknown, path: string): unknown[] {
  if (v === null) return bad("null_value", path);
  if (!Array.isArray(v)) return bad("wrong_type", path);
  const out: unknown[] = new Array<unknown>(v.length);
  let count = 0;
  for (const k of Reflect.ownKeys(v)) {
    if (typeof k === "symbol") return bad("wrong_type", path);
    if (k === "length") continue;
    if (!/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= v.length) return bad("wrong_type", path);
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || d.get || d.set || !("value" in d) || d.enumerable !== true) return bad("wrong_type", path);
    out[Number(k)] = d.value;
    count++;
  }
  if (count !== v.length) return bad("wrong_type", path);
  return out;
}

function closed(spec: Readonly<Record<string, V>>): V {
  return (v, path) => {
    const o = plain(v, path);
    for (const k of Object.keys(o)) if (!Object.hasOwn(spec, k)) bad("unknown_key", path);
    for (const k of Object.keys(spec)) {
      if (!Object.hasOwn(o, k)) bad("missing_key", join(path, k));
      spec[k]!(o[k], join(path, k));
    }
  };
}

const bool: V = (v, path) => {
  if (v === null) bad("null_value", path);
  if (typeof v !== "boolean") bad("wrong_type", path);
};

const int: V = (v, path) => {
  if (v === null) bad("null_value", path);
  if (typeof v !== "number") bad("wrong_type", path);
  if (!Number.isFinite(v) || !Number.isInteger(v) || Object.is(v, -0)) bad("forbidden_number", path);
  if (Math.abs(v) > MAX_SAFE) bad("unsafe_integer", path);
  if (v < 0) bad("bad_range", path);
};

function strRaw(v: unknown, path: string): string {
  if (v === null) return bad("null_value", path);
  if (typeof v !== "string") return bad("wrong_type", path);
  return v;
}

function str(re: RegExp): V {
  return (v, path) => {
    if (!re.test(strRaw(v, path))) bad("bad_pattern", path);
  };
}

function enumOf(...vals: string[]): V {
  return (v, path) => {
    if (!vals.includes(strRaw(v, path))) bad("bad_value", path);
  };
}

const constant = (c: string): V => enumOf(c);

function setOf(item: V): V {
  return (v, path) => {
    const items = dense(v, path);
    let prev: string | null = null;
    for (const it of items) {
      item(it, path);
      const s = it as string;
      if (prev !== null && compareBytes(prev, s) >= 0) bad("unsorted_set", path);
      prev = s;
    }
  };
}

/** Object-set (13.3): strictly ascending and unique by an identity key, path-specific. */
function objSet(spec: Readonly<Record<string, V>>, key: string): V {
  const entry = closed(spec);
  return (v, path) => {
    const items = dense(v, path);
    let prev: string | null = null;
    for (const it of items) {
      entry(it, path);
      const id = (it as Record<string, string>)[key]!;
      if (prev !== null) {
        const c = compareBytes(prev, id);
        if (c === 0) bad("duplicate_identity", join(path, key));
        if (c > 0) bad("unsorted_set", join(path, key));
      }
      prev = id;
    }
  };
}

function arrayOf(item: V): V {
  return (v, path) => {
    for (const it of dense(v, path)) item(it, path);
  };
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TASK_ID = new RegExp("^t-" + UUID + "$");
const ATTEMPT_ID = new RegExp("^a-" + UUID + "$");
const SLOT = /^[a-z0-9-]{1,32}$/;
const ID = /^[a-z0-9:._-]{1,64}$/;
const CMD = /^cmd:[a-z0-9._-]{1,64}$/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const epochV: V = (v, path) => {
  const s = strRaw(v, path);
  if (!/^(0|[1-9][0-9]*)$/.test(s)) bad("bad_pattern", path);
  // Implementation guard for the existing ceiling (<= 2^53-1 has at most 16 decimal digits): reject before BigInt.
  if (s.length > MAX_SAFE_DIGITS || BigInt(s) > MAX_SAFE_BIG) bad("bad_range", path);
};

const repoV: V = (v, path) => {
  const s = strRaw(v, path);
  const m = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(s);
  if (!m || m[2] === "." || m[2] === "..") bad("bad_pattern", path);
};

const branchV: V = (v, path) => {
  const s = strRaw(v, path);
  if (!/^[A-Za-z0-9._/-]{1,128}$/.test(s) || s.includes("..") || s.startsWith("/") || s.endsWith("/")) bad("bad_pattern", path);
};

const trailerV: V = str(/^[\x20-\x7e]{1,128}$/);

function pathV(exactOnly: boolean): V {
  return (v, path) => {
    const s = strRaw(v, path);
    if (LONE_SURROGATE.test(s)) bad("bad_scalar", path);
    let n;
    try {
      n = normalizePattern(s);
    } catch {
      return bad("bad_path_grammar", path);
    }
    if (exactOnly && n.kind !== "exact") bad("bad_path_grammar", path);
  };
}

const AUTH_KINDS = ["none", "operator_decision"];
function authority(withDecision: boolean): V {
  const base: Record<string, V> = { kind: enumOf(...AUTH_KINDS), id: str(ID) };
  if (withDecision) base.decision = enumOf("allowed", "denied", "not_required");
  const shape = closed(base);
  return (v, path) => {
    shape(v, path);
    const o = v as { kind: string; id: string };
    if ((o.kind === "none") !== (o.id === "none")) bad("bad_value", join(path, "id"));
  };
}

const ENVELOPE_SPEC = closed({
  schema: constant(SCHEMAS.envelope),
  task_id: str(TASK_ID),
  attempt_id: str(ATTEMPT_ID),
  slot: str(SLOT),
  slot_epoch: epochV,
  repo: repoV,
  worktree_label: str(/^[a-z0-9._-]{1,64}$/),
  base: closed({ branch: branchV, base_sha: str(HEX40) }),
  allowed_files: setOf(pathV(false)),
  expected: closed({ artifact_kind: enumOf("handoff_bundle"), branch: branchV, trailer: trailerV }),
  required_commands: setOf(str(CMD)),
  fixtures: setOf(str(ID)),
  dependencies: arrayOf(closed({ id: str(ID), kind: str(/^[a-z0-9._-]{1,32}$/), step: enumOf("automatic", "human") })),
  bounds: closed({ max_changed_files: int, max_wall_ms: int }),
  expires_at_ms: int,
  authority_ref: authority(false),
  advisory: closed({ est_changed_files: int, est_minutes: int }),
});

const FACT_VALUE_SPECS: Readonly<Record<FactId, V>> = {
  os_identity: closed({ trusted: bool }),
  permission_profile: closed({ digest: str(HEX64) }),
  command_decisions: closed({ entries: objSet({ command: str(CMD), decision: enumOf("allowed", "denied", "unknown") }, "command") }),
  repo_base: closed({ sha: str(HEX40) }),
  worktree: closed({ clean: bool }),
  ownership: closed({ conflict: bool }),
  dependencies: closed({ entries: objSet({ id: str(ID), met: bool }, "id") }),
  fixtures: closed({ entries: objSet({ id: str(ID), available: bool }, "id") }),
  slot_state: closed({ idle: bool }),
  attempts_seen: closed({ ids: setOf(str(ATTEMPT_ID)) }),
  limits: closed({ max_changed_files: int, max_wall_ms: int }),
  path_policy: closed({ forbidden: setOf(pathV(false)) }),
  mandatory_writes: closed({ paths: setOf(pathV(true)) }),
  artifact_contract: closed({ artifact_kind: enumOf("handoff_bundle"), trailer: trailerV }),
  authority_decision: authority(true),
  matcher_attestation: closed({
    profile_digest: str(HEX64),
    matcher_revision: str(/^[a-z0-9._/-]{1,64}$/),
    compatible: bool,
  }),
};

function factV(id: FactId): V {
  return (v, path) => {
    const o = plain(v, path);
    for (const k of Object.keys(o)) if (k !== "status" && k !== "observed_ms" && k !== "value") bad("unknown_key", path);
    if (!Object.hasOwn(o, "status")) bad("missing_key", join(path, "status"));
    enumOf("known", "unknown", "absent")(o.status, join(path, "status"));
    if (!Object.hasOwn(o, "observed_ms")) bad("missing_key", join(path, "observed_ms"));
    int(o.observed_ms, join(path, "observed_ms"));
    if (o.status === "known") {
      if (!Object.hasOwn(o, "value")) bad("missing_key", join(path, "value"));
      FACT_VALUE_SPECS[id](o.value, join(path, "value"));
    } else if (Object.hasOwn(o, "value")) {
      bad("bad_value", join(path, "value"));
    }
  };
}

const factsV: V = (v, path) => {
  const o = plain(v, path);
  for (const k of Object.keys(o)) if (!(FACT_IDS as readonly string[]).includes(k)) bad("unknown_key", path);
  for (const id of FACT_IDS) {
    if (!Object.hasOwn(o, id)) bad("missing_key", join(path, id));
    factV(id)(o[id], join(path, id));
  }
};

const SNAPSHOT_SPEC = closed({
  schema: constant(SCHEMAS.snapshot),
  snapshot_id: str(/^[a-z0-9._-]{1,64}$/),
  revision: int,
  slot: str(SLOT),
  slot_epoch: epochV,
  captured_at_ms: int,
  expires_at_ms: int,
  provenance: closed({
    source_kind: str(/^[a-z0-9._-]{1,32}$/),
    issuer_ref: str(/^[a-z0-9._-]{1,64}$/),
    verified: bool,
  }),
  facts: factsV,
});

function guard(input: InputKind, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof SchemaFail) throw new FeasibilityInputError(input, e.fcode, e.fpath);
    throw e;
  }
}

function validateEnvelope(v: unknown): Envelope {
  guard("envelope", () => ENVELOPE_SPEC(v, ""));
  return v as Envelope;
}

function validateSnapshot(v: unknown): Snapshot {
  guard("snapshot", () => {
    SNAPSHOT_SPEC(v, "");
    const s = v as Snapshot;
    if (s.captured_at_ms > s.expires_at_ms) bad("bad_range", "expires_at_ms");
    for (const id of FACT_IDS) if (s.facts[id].observed_ms > s.captured_at_ms) bad("bad_range", `facts.${id}.observed_ms`);
  });
  return v as Snapshot;
}

function validateClock(v: unknown): number {
  guard("clock", () => int(v, "nowMs"));
  return v as number;
}

// ---------------------------------------------------------------------------------------------
// Shared derivations (also used to check a presented report's local relations, 14.7)
// ---------------------------------------------------------------------------------------------

const REQUIRED = (id: CheckId): boolean => id !== "estimate.advisory";

/** 14.3: fail if any known failure, else stale/absent/unknown by the unavailable codes, else pass. */
function statusOf(id: CheckId, codes: readonly string[]): CheckStatus {
  if (codes.length === 0) return "pass";
  const t = CODE_TABLE[id];
  if (codes.some((c) => t[c]!.kind === "KF")) return "fail";
  if (codes.some((c) => t[c]!.kind === "TM")) return "stale";
  if (codes.every((c) => t[c]!.absent === true)) return "absent";
  return "unknown";
}

interface CheckLike {
  readonly id: CheckId;
  readonly status: CheckStatus;
  readonly reason_codes: readonly string[];
}

/** Section 6 item 4: sort key (class rank, check order, code bytewise); one entry per (check, code). */
function reasonsOf(checks: readonly CheckLike[]): string[] {
  const rows: { rank: number; idx: number; code: string; id: string }[] = [];
  for (const c of checks) {
    const idx = CHECK_ORDER.indexOf(c.id);
    for (const code of c.reason_codes) rows.push({ rank: CLASS_RANK[CODE_TABLE[c.id][code]!.cls], idx, code, id: c.id });
  }
  rows.sort((a, b) => a.rank - b.rank || a.idx - b.idx || compareBytes(a.code, b.code));
  return rows.map((r) => `${r.id}:${r.code}`);
}

const KNOWN_FAILURE_PRECEDENCE: readonly ReasonClass[] = ["unauthorized", "blocked_dependency", "needs_split", "busy"];

function verdictOf(checks: readonly CheckLike[], bindingValid: boolean): Verdict {
  if (!bindingValid) return "uncertain";
  const present = new Set<ReasonClass>();
  for (const c of checks) for (const code of c.reason_codes) {
    const info = CODE_TABLE[c.id][code]!;
    if (info.kind === "KF") present.add(info.cls);
  }
  for (const cls of KNOWN_FAILURE_PRECEDENCE) if (present.has(cls)) return cls as Verdict;
  for (const c of checks) {
    if (REQUIRED(c.id) && (c.status === "unknown" || c.status === "absent" || c.status === "stale")) return "uncertain";
  }
  return "feasible";
}

// ---------------------------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------------------------

type Facts = Snapshot["facts"];

function sortedUnique(codes: Iterable<string>): string[] {
  return [...new Set(codes)].sort(compareBytes);
}

/** Codes of one substantive check, evaluated from an individually evaluable snapshot. */
function substantive(id: CheckId, env: Envelope, f: Facts): string[] {
  const codes: string[] = [];
  switch (id) {
    case "authority.reference": {
      const fa = f.authority_decision;
      if (fa.status !== "known") return ["authority_unverified"];
      const ref = env.authority_ref;
      const ev = fa.value!;
      if (ref.kind === "none") {
        if (!(ev.kind === "none" && ev.id === "none" && ev.decision === "not_required")) codes.push("authority_evidence_mismatch");
      } else if (ev.kind !== ref.kind || ev.id !== ref.id || ev.decision === "not_required") {
        codes.push("authority_evidence_mismatch");
      } else if (ev.decision === "denied") {
        codes.push("authority_denied");
      }
      break;
    }
    case "authority.paths": {
      const pp = f.path_policy;
      if (pp.status === "known") {
        if (env.allowed_files.some((a) => pp.value!.forbidden.some((x) => patternsIntersect(a, x)))) codes.push("path_forbidden");
      } else codes.push("path_policy_unknown");
      const mw = f.mandatory_writes;
      if (mw.status === "known") {
        if (mw.value!.paths.some((p) => !env.allowed_files.some((a) => patternMatches(a, p)))) codes.push("mandatory_write_outside_allowed");
      } else codes.push("mandatory_writes_unknown");
      break;
    }
    case "authority.commands": {
      const fc = f.command_decisions;
      for (const cmd of env.required_commands) {
        const e = fc.status === "known" ? fc.value!.entries.find((x) => x.command === cmd) : undefined;
        if (e?.decision === "denied") codes.push("command_denied");
        else if (e === undefined || e.decision === "unknown") codes.push("command_decision_unknown");
      }
      break;
    }
    case "identity.os": {
      const fo = f.os_identity;
      if (fo.status === "absent") codes.push("identity_os_absent");
      else if (fo.status === "unknown" || fo.value!.trusted !== true) codes.push("identity_os_unknown");
      break;
    }
    case "permission.profile": {
      const fp = f.permission_profile;
      if (fp.status === "absent") codes.push("permission_profile_absent");
      else if (fp.status === "unknown") codes.push("permission_profile_unknown");
      break;
    }
    case "matcher.compat": {
      const fp = f.permission_profile;
      const fm = f.matcher_attestation;
      if (fp.status !== "known" || fm.status !== "known") codes.push("matcher_unverified");
      else {
        const m = fm.value!;
        if (m.profile_digest !== fp.value!.digest || m.matcher_revision !== MATCHER_CONTRACT_REVISION || m.compatible !== true) {
          codes.push("matcher_attestation_mismatch");
        }
      }
      break;
    }
    case "repo.base": {
      const fr = f.repo_base;
      if (fr.status !== "known") codes.push("repo_base_unknown");
      else if (fr.value!.sha !== env.base.base_sha) codes.push("base_moved");
      break;
    }
    case "ownership.files": {
      const w = f.worktree;
      const o = f.ownership;
      if (w.status !== "known") codes.push("worktree_unknown");
      else if (!w.value!.clean) codes.push("worktree_dirty");
      if (o.status !== "known") codes.push("ownership_unknown");
      else if (o.value!.conflict) codes.push("ownership_conflict");
      break;
    }
    case "contract.artifact": {
      const fa = f.artifact_contract;
      if (fa.status !== "known") codes.push("artifact_evidence_unknown");
      else if (fa.value!.artifact_kind !== env.expected.artifact_kind || fa.value!.trailer !== env.expected.trailer) {
        codes.push("artifact_contract_mismatch");
      }
      break;
    }
    case "dependency.declared": {
      const fd = f.dependencies;
      for (const d of env.dependencies) {
        if (d.step === "human") {
          codes.push("human_step_required");
          continue;
        }
        const e = fd.status === "known" ? fd.value!.entries.find((x) => x.id === d.id) : undefined;
        if (e === undefined) codes.push("dependency_unknown");
        else if (!e.met) codes.push("dependency_unmet");
      }
      break;
    }
    case "fixtures.data": {
      const ff = f.fixtures;
      for (const id2 of env.fixtures) {
        const e = ff.status === "known" ? ff.value!.entries.find((x) => x.id === id2) : undefined;
        if (e === undefined) codes.push("fixture_unknown");
        else if (!e.available) codes.push("fixture_unavailable");
      }
      break;
    }
    case "slot.idle": {
      const fs2 = f.slot_state;
      if (fs2.status !== "known") codes.push("slot_idle_unknown");
      else if (!fs2.value!.idle) codes.push("slot_busy");
      break;
    }
    case "bounds.explicit": {
      const mw = f.mandatory_writes;
      const lim = f.limits;
      if (mw.status === "known") {
        const n = mw.value!.paths.length;
        if (n > env.bounds.max_changed_files || (lim.status === "known" && n > lim.value!.max_changed_files)) {
          codes.push("verified_bound_exceeded");
        }
      } else codes.push("mandatory_writes_unknown");
      if (lim.status !== "known") codes.push("limits_unknown");
      break;
    }
    default:
      break;
  }
  return sortedUnique(codes);
}

function evidenceFor(id: CheckId, revision: number): EvidenceRef[] {
  return EVIDENCE_FACTS[id].map((fact) => ({ fact, revision }));
}

function task(env: Envelope): string {
  return digest("task-envelope", env);
}

/** Pure, read-only dry run. Throws a sanitized FeasibilityInputError for malformed inputs. */
export function evaluate(envelope: unknown, snapshot: unknown, nowMs: unknown): Report {
  const env = validateEnvelope(envelope);
  const snap = validateSnapshot(snapshot);
  const now = validateClock(nowMs);

  const verified = snap.provenance.verified === true;
  const sameSlot = snap.slot === env.slot;
  const sameEpoch = snap.slot_epoch === env.slot_epoch;
  const inWindow = snap.captured_at_ms <= now && now <= snap.expires_at_ms;
  const evaluable = verified && sameSlot && sameEpoch && inWindow;
  const notEvaluable = !verified || !sameSlot || !sameEpoch; // wins over stale (section 5)

  const rev = snap.revision;
  const rows = new Map<CheckId, { codes: string[]; evidence: EvidenceRef[]; evaluated: boolean }>();
  const set = (id: CheckId, codes: string[], evidence: EvidenceRef[] = [], evaluated = false): void => {
    rows.set(id, { codes, evidence, evaluated });
  };

  set("binding.schema", []);
  set("binding.provenance", verified ? [] : ["provenance_unverified"]);
  set("binding.slot", sameSlot ? [] : ["slot_mismatch"]);
  set("binding.epoch", sameEpoch ? [] : ["epoch_stale"]);
  set("binding.capability_fresh", inWindow ? [] : ["capability_stale"]);
  set("binding.not_expired", now <= env.expires_at_ms ? [] : ["task_expired"]);
  {
    const fa = snap.facts.attempts_seen;
    if (evaluable && fa.status === "known") {
      set("binding.attempt_unique", fa.value!.ids.includes(env.attempt_id) ? ["attempt_duplicate"] : [], evidenceFor("binding.attempt_unique", rev));
    } else {
      set("binding.attempt_unique", ["attempt_unverified"], evaluable ? evidenceFor("binding.attempt_unique", rev) : []);
    }
  }
  const bindingValid = BINDING_CHECKS.every((id) => rows.get(id)!.codes.length === 0);

  for (const id of SNAPSHOT_DERIVED_CHECKS) {
    if (evaluable) {
      set(id, substantive(id, env, snap.facts), evidenceFor(id, rev), true);
    } else if (notEvaluable) {
      set(id, [id === "authority.reference" && !verified ? "authority_unverified" : "evidence_not_evaluable"]);
    } else {
      set(id, ["evidence_stale"]);
    }
  }
  set("estimate.advisory", []);

  const checks: Check[] = CHECK_ORDER.map((id) => {
    const r = rows.get(id)!;
    return {
      id,
      required: REQUIRED(id),
      status: statusOf(id, r.codes),
      reason_codes: r.codes,
      evidence: r.evidence,
      retained_under_invalid_binding: r.evaluated && !bindingValid,
    };
  });

  const advisoryCodes: AdvisoryCode[] = [];
  if (
    env.advisory.est_changed_files > env.bounds.max_changed_files ||
    BigInt(env.advisory.est_minutes) * 60000n > BigInt(env.bounds.max_wall_ms)
  ) {
    advisoryCodes.push("estimate_exceeds_bound");
  }
  if (evaluable && snap.facts.limits.status === "known" && env.bounds.max_wall_ms > snap.facts.limits.value!.max_wall_ms) {
    advisoryCodes.push("wall_budget_exceeds_runner_limit");
  }

  const body = {
    schema: SCHEMAS.report,
    task_digest: task(env),
    capability_digest: digest("capability-snapshot", snap),
    capability_revision: rev,
    task_id: env.task_id,
    attempt_id: env.attempt_id,
    slot: env.slot,
    slot_epoch: env.slot_epoch,
    evaluated_at_ms: now,
    expires_at_ms: Math.min(env.expires_at_ms, snap.expires_at_ms),
    binding_valid: bindingValid,
    verdict: verdictOf(checks, bindingValid),
    checks,
    reasons: reasonsOf(checks),
    advisory: {
      est_changed_files: env.advisory.est_changed_files,
      est_minutes: env.advisory.est_minutes,
      advisory_codes: advisoryCodes,
    },
    non_claims: [...NON_CLAIMS],
  };
  return { ...body, report_digest: digest("report", body) };
}

// ---------------------------------------------------------------------------------------------
// Report schema (consumption check 1): structure plus the local relations of 14.7. Never reads
// the envelope or snapshot, and never throws: any failure is a plain `false`.
// ---------------------------------------------------------------------------------------------

const REPORT_SPEC = closed({
  schema: constant(SCHEMAS.report),
  task_digest: str(HEX64),
  capability_digest: str(HEX64),
  capability_revision: int,
  task_id: str(TASK_ID),
  attempt_id: str(ATTEMPT_ID),
  slot: str(SLOT),
  slot_epoch: epochV,
  evaluated_at_ms: int,
  expires_at_ms: int,
  binding_valid: bool,
  verdict: enumOf(...VERDICTS),
  checks: (v, path) => {
    const items = dense(v, path);
    if (items.length !== CHECK_ORDER.length) bad("bad_value", path);
    closedCheck(items);
  },
  reasons: arrayOf(str(/^[a-z]+\.[a-z_]+:[a-z_]+$/)),
  advisory: closed({
    est_changed_files: int,
    est_minutes: int,
    advisory_codes: (v, path) => {
      const items = dense(v, path);
      setOf(enumOf(...ADVISORY_CODES))(items, path);
    },
  }),
  non_claims: (v, path) => {
    const items = dense(v, path);
    if (items.length !== NON_CLAIMS.length || items.some((x, i) => x !== NON_CLAIMS[i])) bad("bad_value", path);
  },
  report_digest: str(HEX64),
});

const CHECK_SHAPE = closed({
  id: enumOf(...CHECK_ORDER),
  required: bool,
  status: enumOf("pass", "fail", "unknown", "absent", "stale"),
  reason_codes: (v, path) => {
    for (const x of dense(v, path)) strRaw(x, path);
  },
  evidence: arrayOf(closed({ fact: enumOf(...FACT_IDS), revision: int })),
  retained_under_invalid_binding: bool,
});

function closedCheck(items: unknown[]): void {
  items.forEach((c, i) => {
    CHECK_SHAPE(c, "checks");
    const ck = c as Check;
    if (ck.id !== CHECK_ORDER[i]) bad("bad_value", "checks.id");
  });
}

function reportRelations(r: Report): void {
  let allBindingPass = true;
  for (const c of r.checks) {
    if (c.required !== REQUIRED(c.id)) bad("bad_value", "checks.required");
    const table = CODE_TABLE[c.id];
    let prev: string | null = null;
    for (const code of c.reason_codes) {
      if (!Object.hasOwn(table, code)) bad("bad_value", "checks.reason_codes");
      if (prev !== null && compareBytes(prev, code) >= 0) bad("unsorted_set", "checks.reason_codes");
      prev = code;
    }
    if (c.status !== statusOf(c.id, c.reason_codes)) bad("bad_value", "checks.status");
    let pf: string | null = null;
    const allowed = EVIDENCE_FACTS[c.id] as readonly string[];
    for (const e of c.evidence) {
      if (!allowed.includes(e.fact) || e.revision !== r.capability_revision) bad("bad_value", "checks.evidence");
      if (pf !== null && compareBytes(pf, e.fact) >= 0) bad("unsorted_set", "checks.evidence");
      pf = e.fact;
    }
    // 14.6a/b: retained_under_invalid_binding is true ONLY for a substantive (13-list) check actually evaluated
    // from an individually evaluable snapshot under an invalid binding; false everywhere else. A local structural
    // relation only (no authenticity claim): evaluated rows carry their evidence refs, expansion rows never do.
    const derived = (SNAPSHOT_DERIVED_CHECKS as readonly string[]).includes(c.id);
    const expanded = c.reason_codes.some((x) => x === "evidence_not_evaluable" || x === "evidence_stale");
    if (c.retained_under_invalid_binding && r.binding_valid) bad("bad_value", "checks.retained_under_invalid_binding");
    if (c.retained_under_invalid_binding && !derived) bad("bad_value", "checks.retained_under_invalid_binding");
    if (c.retained_under_invalid_binding && expanded) bad("bad_value", "checks.retained_under_invalid_binding");
    if (c.retained_under_invalid_binding && c.evidence.length === 0) bad("bad_value", "checks.retained_under_invalid_binding");
    if (derived && !r.binding_valid && !expanded && c.evidence.length > 0 && !c.retained_under_invalid_binding) {
      bad("bad_value", "checks.retained_under_invalid_binding");
    }
    // Valid binding implies an individually evaluable snapshot: substantive rows are never expansions and always
    // carry their closed per-check evidence refs. (authority_unverified alone is legitimate here: unavailable
    // authority_decision in an evaluable snapshot.) Local shape only; no authenticity claim.
    if (derived && r.binding_valid) {
      if (expanded) bad("bad_value", "checks.reason_codes");
      if (c.evidence.length === 0) bad("bad_value", "checks.evidence");
    }
    if (c.id.startsWith("binding.") && c.status !== "pass") allBindingPass = false;
  }
  if (r.binding_valid !== allBindingPass) bad("bad_value", "binding_valid");
  const re = reasonsOf(r.checks);
  if (re.length !== r.reasons.length || re.some((x, i) => x !== r.reasons[i])) bad("bad_value", "reasons");
  if (r.verdict !== verdictOf(r.checks, r.binding_valid)) bad("bad_value", "verdict");
}

function reportSchemaOk(report: unknown): boolean {
  try {
    REPORT_SPEC(report, "");
    reportRelations(report as Report);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// validate_report_for_consumption (6.1, 13.7, 14.7). Never re-runs evaluate; never authorizes.
// ---------------------------------------------------------------------------------------------

function consumption(checks: ConsumptionCheck[]): ConsumptionResult {
  const reasons: string[] = [];
  for (const c of checks) for (const code of c.reason_codes) reasons.push(`${c.id}:${code}`);
  return { schema: SCHEMAS.consumption, valid: checks.every((c) => c.status === "pass"), checks, reasons };
}

export function validate_report_for_consumption(report: unknown, envelope: unknown, snapshot: unknown, nowMs: unknown): ConsumptionResult {
  const env = validateEnvelope(envelope);
  const snap = validateSnapshot(snapshot);
  const now = validateClock(nowMs);

  if (!reportSchemaOk(report)) {
    return consumption(
      CONSUME_CHECK_ORDER.map((id, i): ConsumptionCheck =>
        i === 0
          ? { id, status: "fail", reason_codes: [CONSUME_CODES[id]] }
          : { id, status: "unknown", reason_codes: ["report_not_evaluable"] },
      ),
    );
  }
  const r = report as Report;
  const out = (id: (typeof CONSUME_CHECK_ORDER)[number], ok: boolean, failStatus: "fail" | "unknown" | "stale"): ConsumptionCheck =>
    ok ? { id, status: "pass", reason_codes: [] } : { id, status: failStatus, reason_codes: [CONSUME_CODES[id]] };

  let digestOk: boolean;
  try {
    digestOk = digest("report", r, { exclude: ["report_digest"] }) === r.report_digest;
  } catch (e) {
    if (!(e instanceof CanonicalError)) throw e;
    digestOk = false;
  }
  return consumption([
    out("consume.report_schema", true, "fail"),
    out("consume.report_digest", digestOk, "fail"),
    out("consume.report_expired", now <= r.expires_at_ms, "stale"),
    out(
      "consume.identity",
      r.task_id === env.task_id && r.attempt_id === env.attempt_id && r.slot === env.slot && r.slot_epoch === env.slot_epoch,
      "fail",
    ),
    out("consume.task_digest", task(env) === r.task_digest, "fail"),
    out("consume.capability_digest", digest("capability-snapshot", snap) === r.capability_digest, "fail"),
    out("consume.capability_revision", snap.revision === r.capability_revision, "fail"),
    out("consume.trust", snap.provenance.verified === true, "unknown"),
  ]);
}
