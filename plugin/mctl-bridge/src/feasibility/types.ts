// Closed schemas, enums and the closed reason-code table of the dispatch-feasibility design
// (docs/dispatch-feasibility-146.md sections 3-6, 13, 14; refs #146). Types and constants only:
// no host, store, clock, random, network or filesystem access.

export type InputKind = "envelope" | "snapshot" | "clock";

export const INPUT_ERROR_CODES = [
  "bad_json",
  "bad_scalar",
  "bad_key",
  "duplicate_key",
  "forbidden_number",
  "unsafe_integer",
  "null_value",
  "too_deep",
  "unknown_key",
  "missing_key",
  "wrong_type",
  "bad_value",
  "bad_range",
  "bad_pattern",
  "unsorted_set",
  "duplicate_identity",
  "bad_path_grammar",
] as const;
export type InputErrorCode = (typeof INPUT_ERROR_CODES)[number];

/** Sanitized: only a closed input kind, a closed code and a fixed schema-path template. Never a value. */
export class FeasibilityInputError extends Error {
  readonly input: InputKind;
  readonly code: InputErrorCode;
  readonly path: string;
  constructor(input: InputKind, code: InputErrorCode, path: string) {
    super(`${input}:${code}:${path}`);
    Object.defineProperty(this, "name", { value: "FeasibilityInputError", enumerable: false });
    this.input = input;
    this.code = code;
    this.path = path;
  }
}

export const MATCHER_CONTRACT_REVISION = "mctl.matcher-contract/1";

export const SCHEMAS = Object.freeze({
  envelope: "mctl.task-envelope/1",
  snapshot: "mctl.capability-snapshot/1",
  report: "mctl.feasibility-report/1",
  consumption: "mctl.feasibility-consumption/1",
});

export const VERDICTS = ["feasible", "busy", "needs_split", "blocked_dependency", "unauthorized", "uncertain"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const CHECK_STATUSES = ["pass", "fail", "unknown", "absent", "stale"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const CHECK_ORDER = [
  "binding.schema",
  "binding.provenance",
  "binding.slot",
  "binding.epoch",
  "binding.capability_fresh",
  "binding.not_expired",
  "binding.attempt_unique",
  "authority.reference",
  "authority.paths",
  "authority.commands",
  "identity.os",
  "permission.profile",
  "matcher.compat",
  "repo.base",
  "ownership.files",
  "contract.artifact",
  "dependency.declared",
  "fixtures.data",
  "slot.idle",
  "bounds.explicit",
  "estimate.advisory",
] as const;
export type CheckId = (typeof CHECK_ORDER)[number];

export const SNAPSHOT_DERIVED_CHECKS = [
  "authority.reference",
  "authority.paths",
  "authority.commands",
  "identity.os",
  "permission.profile",
  "matcher.compat",
  "repo.base",
  "ownership.files",
  "contract.artifact",
  "dependency.declared",
  "fixtures.data",
  "slot.idle",
  "bounds.explicit",
] as const satisfies readonly CheckId[];

export const BINDING_CHECKS = CHECK_ORDER.slice(0, 7);

export const FACT_IDS = [
  "artifact_contract",
  "attempts_seen",
  "authority_decision",
  "command_decisions",
  "dependencies",
  "fixtures",
  "limits",
  "mandatory_writes",
  "matcher_attestation",
  "os_identity",
  "ownership",
  "path_policy",
  "permission_profile",
  "repo_base",
  "slot_state",
  "worktree",
] as const;
export type FactId = (typeof FACT_IDS)[number];

/** 14.6a: facts a check consults, ascending by fact id. */
export const EVIDENCE_FACTS: Readonly<Record<CheckId, readonly FactId[]>> = {
  "binding.schema": [],
  "binding.provenance": [],
  "binding.slot": [],
  "binding.epoch": [],
  "binding.capability_fresh": [],
  "binding.not_expired": [],
  "binding.attempt_unique": ["attempts_seen"],
  "authority.reference": ["authority_decision"],
  "authority.paths": ["mandatory_writes", "path_policy"],
  "authority.commands": ["command_decisions"],
  "identity.os": ["os_identity"],
  "permission.profile": ["permission_profile"],
  "matcher.compat": ["matcher_attestation", "permission_profile"],
  "repo.base": ["repo_base"],
  "ownership.files": ["ownership", "worktree"],
  "contract.artifact": ["artifact_contract"],
  "dependency.declared": ["dependencies"],
  "fixtures.data": ["fixtures"],
  "slot.idle": ["slot_state"],
  "bounds.explicit": ["limits", "mandatory_writes"],
  "estimate.advisory": [],
};

export type ReasonClass = "binding" | "unauthorized" | "blocked_dependency" | "needs_split" | "busy" | "uncertain";
export const CLASS_RANK: Readonly<Record<ReasonClass, number>> = {
  binding: 0,
  unauthorized: 1,
  blocked_dependency: 2,
  needs_split: 3,
  busy: 4,
  uncertain: 5,
};

/** KF known failure, UN unavailable evidence, TM time (stale). */
export type CodeKind = "KF" | "UN" | "TM";
export interface CodeInfo {
  readonly kind: CodeKind;
  readonly cls: ReasonClass;
  /** Status effect of an UN code when it is the sole reason: `absent` for the two *_absent codes. */
  readonly absent?: true;
}

const kf = (cls: ReasonClass): CodeInfo => ({ kind: "KF", cls });
const un: CodeInfo = { kind: "UN", cls: "uncertain" };
const unAbsent: CodeInfo = { kind: "UN", cls: "uncertain", absent: true };
const EXPANSION = { evidence_not_evaluable: un, evidence_stale: { kind: "TM", cls: "uncertain" } } as const;

/** 14.2: every code appears only under the checks listed; each code has exactly one class. */
export const CODE_TABLE: Readonly<Record<CheckId, Readonly<Record<string, CodeInfo>>>> = {
  "binding.schema": {},
  "binding.provenance": { provenance_unverified: { kind: "UN", cls: "binding" } },
  "binding.slot": { slot_mismatch: kf("binding") },
  "binding.epoch": { epoch_stale: kf("binding") },
  "binding.capability_fresh": { capability_stale: { kind: "TM", cls: "binding" } },
  "binding.not_expired": { task_expired: kf("binding") },
  "binding.attempt_unique": { attempt_duplicate: kf("binding"), attempt_unverified: { kind: "UN", cls: "binding" } },
  "authority.reference": {
    authority_denied: kf("unauthorized"),
    authority_unverified: un,
    authority_evidence_mismatch: un,
    ...EXPANSION,
  },
  "authority.paths": {
    path_forbidden: kf("unauthorized"),
    mandatory_write_outside_allowed: kf("unauthorized"),
    path_policy_unknown: un,
    mandatory_writes_unknown: un,
    ...EXPANSION,
  },
  "authority.commands": { command_denied: kf("unauthorized"), command_decision_unknown: un, ...EXPANSION },
  "identity.os": { identity_os_unknown: un, identity_os_absent: unAbsent, ...EXPANSION },
  "permission.profile": { permission_profile_unknown: un, permission_profile_absent: unAbsent, ...EXPANSION },
  "matcher.compat": { matcher_unverified: un, matcher_attestation_mismatch: un, ...EXPANSION },
  "repo.base": { base_moved: kf("blocked_dependency"), repo_base_unknown: un, ...EXPANSION },
  "ownership.files": {
    ownership_conflict: kf("blocked_dependency"),
    worktree_dirty: kf("blocked_dependency"),
    ownership_unknown: un,
    worktree_unknown: un,
    ...EXPANSION,
  },
  "contract.artifact": { artifact_contract_mismatch: kf("blocked_dependency"), artifact_evidence_unknown: un, ...EXPANSION },
  "dependency.declared": {
    dependency_unmet: kf("blocked_dependency"),
    human_step_required: kf("needs_split"),
    dependency_unknown: un,
    ...EXPANSION,
  },
  "fixtures.data": { fixture_unavailable: kf("blocked_dependency"), fixture_unknown: un, ...EXPANSION },
  "slot.idle": { slot_busy: kf("busy"), slot_idle_unknown: un, ...EXPANSION },
  "bounds.explicit": { verified_bound_exceeded: kf("needs_split"), mandatory_writes_unknown: un, limits_unknown: un, ...EXPANSION },
  "estimate.advisory": {},
};

export const ADVISORY_CODES = ["estimate_exceeds_bound", "wall_budget_exceeds_runner_limit"] as const;
export type AdvisoryCode = (typeof ADVISORY_CODES)[number];

export const NON_CLAIMS = ["not_authorization", "not_reservation", "not_os_isolation", "not_toctou_closure"] as const;

export const CONSUME_CHECK_ORDER = [
  "consume.report_schema",
  "consume.report_digest",
  "consume.report_expired",
  "consume.identity",
  "consume.task_digest",
  "consume.capability_digest",
  "consume.capability_revision",
  "consume.trust",
] as const;
export type ConsumeCheckId = (typeof CONSUME_CHECK_ORDER)[number];

export const CONSUME_CODES: Readonly<Record<ConsumeCheckId, string>> = {
  "consume.report_schema": "report_schema_invalid",
  "consume.report_digest": "report_digest_mismatch",
  "consume.report_expired": "report_expired",
  "consume.identity": "identity_mismatch",
  "consume.task_digest": "task_digest_mismatch",
  "consume.capability_digest": "capability_digest_mismatch",
  "consume.capability_revision": "capability_revision_mismatch",
  "consume.trust": "provenance_unverified",
};

// ---- data shapes (inputs are validated by evaluate.ts before use) ----

export interface Envelope {
  schema: string;
  task_id: string;
  attempt_id: string;
  slot: string;
  slot_epoch: string;
  repo: string;
  worktree_label: string;
  base: { branch: string; base_sha: string };
  allowed_files: string[];
  expected: { artifact_kind: string; branch: string; trailer: string };
  required_commands: string[];
  fixtures: string[];
  dependencies: { id: string; kind: string; step: "automatic" | "human" }[];
  bounds: { max_changed_files: number; max_wall_ms: number };
  expires_at_ms: number;
  authority_ref: { kind: "none" | "operator_decision"; id: string };
  advisory: { est_changed_files: number; est_minutes: number };
}

export type FactStatus = "known" | "unknown" | "absent";
export interface Fact<V> {
  status: FactStatus;
  observed_ms: number;
  value?: V;
}

export interface FactValues {
  os_identity: { trusted: boolean };
  permission_profile: { digest: string };
  command_decisions: { entries: { command: string; decision: "allowed" | "denied" | "unknown" }[] };
  repo_base: { sha: string };
  worktree: { clean: boolean };
  ownership: { conflict: boolean };
  dependencies: { entries: { id: string; met: boolean }[] };
  fixtures: { entries: { id: string; available: boolean }[] };
  slot_state: { idle: boolean };
  attempts_seen: { ids: string[] };
  limits: { max_changed_files: number; max_wall_ms: number };
  path_policy: { forbidden: string[] };
  mandatory_writes: { paths: string[] };
  artifact_contract: { artifact_kind: string; trailer: string };
  authority_decision: { kind: "none" | "operator_decision"; id: string; decision: "allowed" | "denied" | "not_required" };
  matcher_attestation: { profile_digest: string; matcher_revision: string; compatible: boolean };
}

export interface Snapshot {
  schema: string;
  snapshot_id: string;
  revision: number;
  slot: string;
  slot_epoch: string;
  captured_at_ms: number;
  expires_at_ms: number;
  provenance: { source_kind: string; issuer_ref: string; verified: boolean };
  facts: { [K in FactId]: Fact<FactValues[K]> };
}

export interface EvidenceRef {
  fact: FactId;
  revision: number;
}

export interface Check {
  id: CheckId;
  required: boolean;
  status: CheckStatus;
  reason_codes: string[];
  evidence: EvidenceRef[];
  retained_under_invalid_binding: boolean;
}

export interface Report {
  schema: string;
  task_digest: string;
  capability_digest: string;
  capability_revision: number;
  task_id: string;
  attempt_id: string;
  slot: string;
  slot_epoch: string;
  evaluated_at_ms: number;
  expires_at_ms: number;
  binding_valid: boolean;
  verdict: Verdict;
  checks: Check[];
  reasons: string[];
  advisory: { est_changed_files: number; est_minutes: number; advisory_codes: AdvisoryCode[] };
  non_claims: string[];
  report_digest: string;
}

export interface ConsumptionCheck {
  id: ConsumeCheckId;
  status: "pass" | "fail" | "unknown" | "stale";
  reason_codes: string[];
}

export interface ConsumptionResult {
  schema: string;
  valid: boolean;
  checks: ConsumptionCheck[];
  reasons: string[];
}
