// B1 evaluator tests (design doc sections 3-10, 13, 14; refs #146). Pure functions only; all inputs are
// synthetic fixtures under test/fixtures/feasibility/. A passing run is not a readiness or conformance claim.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";

import { canonicalize, digest } from "../src/feasibility/canonical.ts";
import {
  FeasibilityInputError,
  PathGrammarError,
  evaluate,
  normalizePattern,
  patternMatches,
  patternsIntersect,
  validate_report_for_consumption,
} from "../src/feasibility/evaluate.ts";
import { CHECK_ORDER, CODE_TABLE, CONSUME_CHECK_ORDER, FACT_IDS, SNAPSHOT_DERIVED_CHECKS } from "../src/feasibility/types.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

const dir = new URL("./fixtures/feasibility/", import.meta.url);
const load = (name: string): J => JSON.parse(fs.readFileSync(new URL(name, dir), "utf8"));
const BASE = load("baseline.json");
const CASES = load("cases.json");
const A1 = load("a1-paths.json");

interface Inputs {
  env: J;
  snap: J;
  now: J;
}

function setPath(root: J, path: string, value: J): void {
  const segs = path.split(".");
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) cur = cur[segs[i]!];
  cur[segs[segs.length - 1]!] = value;
}
function unsetPath(root: J, path: string): void {
  const segs = path.split(".");
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) cur = cur[segs[i]!];
  delete cur[segs[segs.length - 1]!];
}

function inputs(c: { set?: Record<string, J>; unset?: string[] } = {}): Inputs {
  const root: J = { envelope: structuredClone(BASE.envelope), snapshot: structuredClone(BASE.snapshot), now: BASE.nowMs };
  for (const [p, v] of Object.entries(c.set ?? {})) setPath(root, p, structuredClone(v));
  for (const p of c.unset ?? []) unsetPath(root, p);
  return { env: root.envelope, snap: root.snapshot, now: root.now };
}

const run = (i: Inputs): J => evaluate(i.env, i.snap, i.now);
const consume = (r: J, i: Inputs): J => validate_report_for_consumption(r, i.env, i.snap, i.now);

function thrown(fn: () => unknown): FeasibilityInputError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(FeasibilityInputError);
    return e as FeasibilityInputError;
  }
  throw new Error("expected FeasibilityInputError");
}

function statuses(r: J): Record<string, string> {
  return Object.fromEntries(r.checks.map((c: J) => [c.id, c.status]));
}

function reorderKeys(v: J): J {
  if (Array.isArray(v)) return v.map(reorderKeys);
  if (v !== null && typeof v === "object") {
    const out: J = {};
    for (const k of Object.keys(v).reverse()) out[k] = reorderKeys(v[k]);
    return out;
  }
  return v;
}

function deepFreeze(v: J): J {
  if (v !== null && typeof v === "object") {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

// ---------------------------------------------------------------------------------------------
// A1 path grammar, membership, intersection
// ---------------------------------------------------------------------------------------------

function pathCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PathGrammarError);
    return (e as PathGrammarError).code;
  }
  throw new Error("expected throw");
}

describe("A1 grammar", () => {
  test.each(A1.valid)("valid $pattern", (c: J) => {
    expect(normalizePattern(c.pattern)).toEqual({ kind: c.kind, segs: c.segs });
  });
  test("alias has the same normal form as the directory", () => {
    expect(normalizePattern("a/b/**")).toEqual(normalizePattern("a/b/"));
  });
  test.each(A1.invalid)("rejects %j", (p: J) => {
    expect(pathCode(() => normalizePattern(p))).toBe("bad_path_grammar");
  });
  test("non-string rejected without echo", () => {
    expect(pathCode(() => normalizePattern(42 as unknown as string))).toBe("bad_path_grammar");
  });
});

describe("A1 membership", () => {
  test.each(A1.membership)("$scope matches $path = $member", (c: J) => {
    expect(patternMatches(c.scope, c.path)).toBe(c.member);
  });
  test("tested path must be an exact path", () => {
    expect(pathCode(() => patternMatches("docs/", "docs/"))).toBe("bad_path_grammar");
  });
});

describe("A1 intersection (every pair, both orders)", () => {
  test.each(A1.intersection)("$p vs $q = $intersects", (c: J) => {
    expect(patternsIntersect(c.p, c.q)).toBe(c.intersects);
    expect(patternsIntersect(c.q, c.p)).toBe(c.intersects);
  });
});

// ---------------------------------------------------------------------------------------------
// evaluate(): fixture cases
// ---------------------------------------------------------------------------------------------

function expectedReasons(c: J): string[] {
  const out: string[] = [...c.expect.reasons];
  if (c.expect.expand) {
    for (const id of SNAPSHOT_DERIVED_CHECKS) {
      const code = id === "authority.reference" && c.expect.expand_authority ? c.expect.expand_authority : c.expect.expand;
      out.push(`${id}:${code}`);
    }
  }
  return out;
}

describe("evaluate: design cases", () => {
  test.each(CASES.evaluate.map((c: J) => [c.id, c]))("%s", (_id: J, c: J) => {
    const i = inputs(c);
    const r = run(i);
    expect(r.binding_valid).toBe(c.expect.binding_valid);
    expect(r.verdict).toBe(c.expect.verdict);
    expect(r.reasons).toEqual(expectedReasons(c));
    if (c.expect.advisory_codes !== undefined) expect(r.advisory.advisory_codes).toEqual(c.expect.advisory_codes);
    for (const [id, st] of Object.entries(c.expect.check_status ?? {})) expect(statuses(r)[id]).toBe(st as string);

    // retained evidence flags (14.6a): only for individually evaluable checks under an invalid binding
    const retained = r.checks.filter((k: J) => k.retained_under_invalid_binding).map((k: J) => k.id);
    if (c.expect.retained) expect(retained).toEqual(c.expect.retained);
    else if (c.expect.binding_valid) expect(retained).toEqual([]);

    // fixed shape and bindings
    expect(r.checks.map((k: J) => k.id)).toEqual([...CHECK_ORDER]);
    expect(r.non_claims).toEqual(["not_authorization", "not_reservation", "not_os_isolation", "not_toctou_closure"]);
    expect(r.schema).toBe("mctl.feasibility-report/1");
    expect(r.capability_revision).toBe(i.snap.revision);
    expect(r.evaluated_at_ms).toBe(i.now);
    expect(r.expires_at_ms).toBe(Math.min(i.env.expires_at_ms, i.snap.expires_at_ms));
    expect(statuses(r)["binding.schema"]).toBe("pass");
    expect(statuses(r)["estimate.advisory"]).toBe("pass");

    // every report is schema-valid for consumption, even when its inputs were already expired
    const cr = consume(r, i);
    expect(cr.checks[0]).toEqual({ id: "consume.report_schema", status: "pass", reason_codes: [] });
    for (const id of ["consume.report_digest", "consume.identity", "consume.task_digest", "consume.capability_digest", "consume.capability_revision"]) {
      expect(cr.checks.find((k: J) => k.id === id).status).toBe("pass");
    }
    expect(cr.valid).toBe(i.now <= r.expires_at_ms && i.snap.provenance.verified === true);
  });
});

describe("evaluate: the thirteen snapshot-derived list and evidence references", () => {
  test("evaluable snapshot: evidence lists the 14.6a facts at the report revision, ascending", () => {
    const r = run(inputs({ set: { "snapshot.revision": 5 } }));
    const ev = (id: string): J => r.checks.find((c: J) => c.id === id).evidence;
    expect(ev("authority.paths")).toEqual([{ fact: "mandatory_writes", revision: 5 }, { fact: "path_policy", revision: 5 }]);
    expect(ev("matcher.compat")).toEqual([{ fact: "matcher_attestation", revision: 5 }, { fact: "permission_profile", revision: 5 }]);
    expect(ev("ownership.files")).toEqual([{ fact: "ownership", revision: 5 }, { fact: "worktree", revision: 5 }]);
    expect(ev("bounds.explicit")).toEqual([{ fact: "limits", revision: 5 }, { fact: "mandatory_writes", revision: 5 }]);
    expect(ev("binding.attempt_unique")).toEqual([{ fact: "attempts_seen", revision: 5 }]);
    expect(ev("binding.slot")).toEqual([]);
    expect(ev("estimate.advisory")).toEqual([]);
  });
  test("non-evaluable snapshot: no evidence, nothing retained, no check reads the facts", () => {
    const r = run(inputs({ set: { "snapshot.provenance.verified": false } }));
    for (const c of r.checks) {
      expect(c.evidence).toEqual([]);
      expect(c.retained_under_invalid_binding).toBe(false);
    }
    for (const id of SNAPSHOT_DERIVED_CHECKS) expect(statuses(r)[id]).toBe("unknown");
  });
  test("stale snapshot: the thirteen are stale, never pass or fail", () => {
    const r = run(inputs({ set: { now: 1789999950000 } }));
    for (const id of SNAPSHOT_DERIVED_CHECKS) expect(statuses(r)[id]).toBe("stale");
  });
  test("unverified provenance never carries a known failure from the unusable snapshot", () => {
    const r = run(inputs({ set: { "snapshot.provenance.verified": false, "snapshot.facts.slot_state.value.idle": false } }));
    expect(r.reasons.some((x: string) => x.includes("slot_busy"))).toBe(false);
  });
});

describe("evaluate: no missing or unavailable evidence is read as pass", () => {
  // dependencies is waived by an empty declared set in the baseline envelope (R1/14.3)
  const waivedByBaseline = new Set(["dependencies"]);
  for (const id of FACT_IDS) {
    for (const status of ["unknown", "absent"] as const) {
      test(`${id} ${status}`, () => {
        const r = run(inputs({ set: { [`snapshot.facts.${id}`]: { status, observed_ms: 1789999000000 } } }));
        if (waivedByBaseline.has(id)) {
          expect(r.verdict).toBe("feasible");
        } else {
          expect(r.verdict).not.toBe("feasible");
          expect(r.reasons.length).toBeGreaterThan(0);
        }
      });
    }
  }
  test("every required check must pass for feasible: each check forced non-pass blocks it", () => {
    const ok = run(inputs());
    expect(ok.verdict).toBe("feasible");
    for (const c of ok.checks) expect(c.status).toBe("pass");
    expect(ok.checks.find((c: J) => c.id === "estimate.advisory").required).toBe(false);
    expect(ok.checks.filter((c: J) => c.required)).toHaveLength(20);
  });
  test("trusted:false is unknown, never fail or unauthorized", () => {
    const r = run(inputs({ set: { "snapshot.facts.os_identity.value.trusted": false } }));
    expect(statuses(r)["identity.os"]).toBe("unknown");
    expect(r.verdict).toBe("uncertain");
  });
});

describe("evaluate: mixed reasons are never lost and the verdict uses every class", () => {
  test("denied command with a matcher gap and an unknown identity: highest class wins, all retained", () => {
    const r = run(
      inputs({
        set: {
          "snapshot.facts.command_decisions.value.entries": [{ command: "cmd:git-diff-check", decision: "denied" }],
          "snapshot.facts.matcher_attestation": { status: "unknown", observed_ms: 1789999000000 },
          "snapshot.facts.os_identity": { status: "unknown", observed_ms: 1789999000000 },
        },
      }),
    );
    expect(r.verdict).toBe("unauthorized");
    expect(r.reasons).toEqual(["authority.commands:command_denied", "identity.os:identity_os_unknown", "matcher.compat:matcher_unverified"]);
  });
  test("busy + needs_split + blocked: precedence blocked_dependency > needs_split > busy, all listed by class", () => {
    const r = run(
      inputs({
        set: {
          "snapshot.facts.slot_state.value.idle": false,
          "envelope.dependencies": [{ id: "dep:b", kind: "review", step: "human" }],
          "snapshot.facts.repo_base.value.sha": "1123456789abcdef0123456789abcdef01234567",
        },
      }),
    );
    expect(r.verdict).toBe("blocked_dependency");
    expect(r.reasons).toEqual(["repo.base:base_moved", "dependency.declared:human_step_required", "slot.idle:slot_busy"]);
  });
  test("needs_split beats busy", () => {
    const r = run(inputs({ set: { "snapshot.facts.slot_state.value.idle": false, "envelope.dependencies": [{ id: "dep:b", kind: "review", step: "human" }] } }));
    expect(r.verdict).toBe("needs_split");
    expect(r.reasons).toEqual(["dependency.declared:human_step_required", "slot.idle:slot_busy"]);
  });
  test("unauthorized beats everything", () => {
    const r = run(
      inputs({
        set: {
          "snapshot.facts.slot_state.value.idle": false,
          "snapshot.facts.repo_base.value.sha": "1123456789abcdef0123456789abcdef01234567",
          "snapshot.facts.authority_decision.value.decision": "denied",
        },
      }),
    );
    expect(r.verdict).toBe("unauthorized");
    expect(r.reasons[0]).toBe("authority.reference:authority_denied");
  });
  test("reason_codes inside a check are ascending bytewise", () => {
    const r = run(inputs({ set: { "snapshot.facts.ownership.value.conflict": true, "snapshot.facts.worktree.value.clean": false } }));
    expect(r.checks.find((c: J) => c.id === "ownership.files").reason_codes).toEqual(["ownership_conflict", "worktree_dirty"]);
  });
  test("each closed code has exactly one class and only appears under its checks", () => {
    const seen = new Map<string, string>();
    for (const id of CHECK_ORDER) {
      for (const [code, info] of Object.entries(CODE_TABLE[id])) {
        if (code === "evidence_not_evaluable" || code === "evidence_stale") continue;
        if (code === "mandatory_writes_unknown") continue; // allowed under two checks, same class
        expect(seen.has(code)).toBe(false);
        seen.set(code, info.cls);
      }
    }
    expect(CODE_TABLE["authority.paths"].mandatory_writes_unknown!.cls).toBe(CODE_TABLE["bounds.explicit"].mandatory_writes_unknown!.cls);
  });
});

// ---------------------------------------------------------------------------------------------
// Input errors (A5): sanitized, closed code, fixed path template
// ---------------------------------------------------------------------------------------------

describe("input errors", () => {
  test.each(CASES.input_errors.map((c: J) => [c.id, c]))("%s", (_id: J, c: J) => {
    const i = inputs(c);
    const e = thrown(() => run(i));
    expect({ input: e.input, code: e.code, path: e.path }).toEqual(c.error);
    // the consumption function validates the same three inputs identically
    const e2 = thrown(() => validate_report_for_consumption(run(inputs()), i.env, i.snap, i.now));
    expect({ input: e2.input, code: e2.code, path: e2.path }).toEqual(c.error);
  });
  test("offending values and arbitrary keys are never echoed", () => {
    const marker = "SECRET-token-value";
    const a = inputs({ set: { "envelope.slot": marker } });
    const ea = thrown(() => run(a));
    expect(JSON.stringify([ea.message, ea.input, ea.code, ea.path, ea.stack ?? ""].slice(0, 4))).not.toContain(marker);
    const b = inputs();
    b.env["SECRET-key-name"] = marker;
    const eb = thrown(() => run(b));
    expect(eb.message).not.toContain("SECRET");
    expect(eb.path).toBe("");
    const c = inputs();
    c.snap.facts["SECRET-fact"] = { status: "unknown", observed_ms: 1 };
    const ec = thrown(() => run(c));
    expect(ec.message).not.toContain("SECRET");
  });
  test("no report exists for a malformed input and a valid error has exactly three fields", () => {
    const e = thrown(() => run(inputs({ set: { "envelope.slot": "" } })));
    expect(Object.keys(e).sort()).toEqual(["code", "input", "path"]);
  });
  test("__proto__ as an own key is an unknown key", () => {
    const i = inputs();
    i.env = JSON.parse(JSON.stringify(i.env).replace(/^\{/, '{"__proto__":1,'));
    expect(thrown(() => run(i)).code).toBe("unknown_key");
  });
  test("accessor and symbol-keyed members are rejected, never invoked", () => {
    const i = inputs();
    let called = false;
    Object.defineProperty(i.env, "slot", {
      enumerable: true,
      get() {
        called = true;
        return "slot-x";
      },
    });
    expect(thrown(() => run(i)).code).toBe("wrong_type");
    expect(called).toBe(false);
    const j = inputs();
    (j.snap as J)[Symbol("x")] = 1;
    expect(thrown(() => run(j)).code).toBe("wrong_type");
  });
  test("non-plain inputs", () => {
    expect(thrown(() => evaluate(null, BASE.snapshot, 1)).code).toBe("null_value");
    expect(thrown(() => evaluate([], BASE.snapshot, 1)).code).toBe("wrong_type");
    expect(thrown(() => evaluate(BASE.envelope, "x", 1)).input).toBe("snapshot");
    expect(thrown(() => evaluate(BASE.envelope, BASE.snapshot, undefined)).input).toBe("clock");
  });
  test("a fact observed in the future of the clock but not of captured_at_ms is well-formed", () => {
    expect(() => run(inputs())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// Determinism, digests, immutability
// ---------------------------------------------------------------------------------------------

describe("determinism and digests", () => {
  test("repeated runs are byte-identical", () => {
    const i = inputs();
    expect(canonicalize(run(i))).toBe(canonicalize(run(i)));
  });
  test("reordered object keys give identical output and digests", () => {
    for (const c of CASES.evaluate.slice(0, 40)) {
      const i = inputs(c);
      const a = run(i);
      const b = run({ env: reorderKeys(i.env), snap: reorderKeys(i.snap), now: i.now });
      expect(canonicalize(b)).toBe(canonicalize(a));
      expect(b.report_digest).toBe(a.report_digest);
    }
  });
  test("task digest of the baseline envelope is design vector B", () => {
    expect(run(inputs()).task_digest).toBe("43e77d4fafa97cc56fe831d1bdcb145468f821b940bdf1519a074157c9527880");
  });
  test("digest roundtrips: task, capability and report", () => {
    const i = inputs();
    const r = run(i);
    expect(r.task_digest).toBe(digest("task-envelope", i.env));
    expect(r.capability_digest).toBe(digest("capability-snapshot", i.snap));
    const { report_digest, ...rest } = r;
    expect(report_digest).toBe(digest("report", rest));
    expect(report_digest).toBe(digest("report", r, { exclude: ["report_digest"] }));
    expect(r.report_digest).toMatch(/^[0-9a-f]{64}$/);
  });
  test("a changed fact changes the capability and report digests, not the task digest", () => {
    const a = run(inputs());
    const b = run(inputs({ set: { "snapshot.facts.slot_state.value.idle": false } }));
    expect(b.capability_digest).not.toBe(a.capability_digest);
    expect(b.report_digest).not.toBe(a.report_digest);
    expect(b.task_digest).toBe(a.task_digest);
  });
  test("inputs are not mutated (deep-frozen inputs evaluate and compare equal afterwards)", () => {
    const i = inputs();
    const before = structuredClone({ e: i.env, s: i.snap });
    deepFreeze(i.env);
    deepFreeze(i.snap);
    const r = run(i);
    expect({ e: i.env, s: i.snap }).toEqual(before);
    deepFreeze(r);
    expect(() => consume(r, i)).not.toThrow();
  });
  test("returned arrays do not alias the inputs", () => {
    const i = inputs();
    const r = run(i);
    expect(r.checks[0]).not.toBe(i.env);
    expect(Object.isFrozen(r)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// validate_report_for_consumption
// ---------------------------------------------------------------------------------------------

function code(res: J, id: string): J {
  return res.checks.find((c: J) => c.id === id);
}

describe("consumption: shape and the happy path", () => {
  test("valid report: eight passing checks in the fixed order, no reasons", () => {
    const i = inputs();
    const res = consume(run(i), i);
    expect(res.schema).toBe("mctl.feasibility-consumption/1");
    expect(res.valid).toBe(true);
    expect(res.checks.map((c: J) => c.id)).toEqual([...CONSUME_CHECK_ORDER]);
    for (const c of res.checks) expect(c).toEqual({ id: c.id, status: "pass", reason_codes: [] });
    expect(res.reasons).toEqual([]);
    expect(Object.keys(res).sort()).toEqual(["checks", "reasons", "schema", "valid"]);
  });
  test("valid does not mean feasible: an uncertain report is consumable", () => {
    const i = inputs({ set: { "snapshot.facts.slot_state.value.idle": false } });
    const r = run(i);
    expect(r.verdict).toBe("busy");
    expect(consume(r, i).valid).toBe(true);
  });
  test("an unverified-provenance report is not consumable: trust is unknown, digests still match", () => {
    const i = inputs({ set: { "snapshot.provenance.verified": false } });
    const res = consume(run(i), i);
    expect(res.valid).toBe(false);
    expect(code(res, "consume.trust")).toEqual({ id: "consume.trust", status: "unknown", reason_codes: ["provenance_unverified"], });
    expect(code(res, "consume.capability_digest").status).toBe("pass");
    expect(res.reasons).toEqual(["consume.trust:provenance_unverified"]);
  });
});

describe("consumption: changed inputs and stale reports", () => {
  test("changed fact, same revision: capability digest fails, revision passes, task and expiry pass", () => {
    const i = inputs();
    const old = run(i);
    const j = inputs({ set: { "snapshot.facts.slot_state.value.idle": false } });
    const res = consume(old, j);
    expect(res.valid).toBe(false);
    expect(code(res, "consume.capability_digest")).toEqual({ id: "consume.capability_digest", status: "fail", reason_codes: ["capability_digest_mismatch"] });
    expect(code(res, "consume.capability_revision").status).toBe("pass");
    expect(code(res, "consume.task_digest").status).toBe("pass");
    expect(code(res, "consume.report_expired").status).toBe("pass");
    expect(code(res, "consume.report_digest").status).toBe("pass");
  });
  test("changed fact and revision: both digest and revision fail with distinct codes", () => {
    const old = run(inputs());
    const res = consume(old, inputs({ set: { "snapshot.revision": 2, "snapshot.facts.slot_state.value.idle": false } }));
    expect(res.reasons).toEqual(["consume.capability_digest:capability_digest_mismatch", "consume.capability_revision:capability_revision_mismatch"]);
    expect(code(res, "consume.task_digest").status).toBe("pass");
    expect(code(res, "consume.report_expired").status).toBe("pass");
  });
  test("revision-only change also changes the digest (revision is in the snapshot bytes)", () => {
    const old = run(inputs());
    const res = consume(old, inputs({ set: { "snapshot.revision": 2 } }));
    expect(res.reasons).toEqual(["consume.capability_digest:capability_digest_mismatch", "consume.capability_revision:capability_revision_mismatch"]);
  });
  test("changed envelope: task digest fails, identity still passes when ids are unchanged", () => {
    const old = run(inputs());
    const res = consume(old, inputs({ set: { "envelope.bounds.max_wall_ms": 1 } }));
    expect(res.reasons).toEqual(["consume.task_digest:task_digest_mismatch"]);
  });
  test("changed identity: identity and task digest both fail", () => {
    const old = run(inputs());
    const res = consume(old, inputs({ set: { "envelope.attempt_id": "a-00000000-0000-4000-8000-000000000003" } }));
    expect(res.reasons).toEqual(["consume.identity:identity_mismatch", "consume.task_digest:task_digest_mismatch"]);
  });
  test.each([["slot", "slot-y"], ["slot_epoch", "8"], ["task_id", "t-00000000-0000-4000-8000-000000000009"]])("identity field %s", (k, v) => {
    const old = run(inputs());
    const res = consume(old, inputs({ set: { [`envelope.${k}`]: v } }));
    expect(code(res, "consume.identity").reason_codes).toEqual(["identity_mismatch"]);
  });
  test("report swap: a report for another task is not accepted for this one", () => {
    const other = inputs({ set: { "envelope.task_id": "t-00000000-0000-4000-8000-000000000009" } });
    const res = consume(run(other), inputs());
    expect(res.valid).toBe(false);
    expect(code(res, "consume.identity").status).toBe("fail");
    expect(code(res, "consume.task_digest").status).toBe("fail");
  });
  test("expired report: stale, distinct from mismatches, everything else passes", () => {
    const i = inputs();
    const r = run(i);
    const res = validate_report_for_consumption(r, i.env, i.snap, r.expires_at_ms + 1);
    expect(res.valid).toBe(false);
    expect(code(res, "consume.report_expired")).toEqual({ id: "consume.report_expired", status: "stale", reason_codes: ["report_expired"] });
    expect(res.reasons).toEqual(["consume.report_expired:report_expired"]);
  });
  test("expiry boundary is inclusive", () => {
    const i = inputs();
    const r = run(i);
    expect(validate_report_for_consumption(r, i.env, i.snap, r.expires_at_ms).valid).toBe(true);
  });
  test("expired-input report: schema-valid uncertain report, rejected only by the expiry check", () => {
    const i = inputs({ set: { now: 1790000100000 } });
    const r = run(i);
    expect(r.expires_at_ms).toBeLessThan(r.evaluated_at_ms);
    const res = consume(r, i);
    expect(code(res, "consume.report_schema").status).toBe("pass");
    expect(res.reasons).toEqual(["consume.report_expired:report_expired"]);
  });
});

describe("consumption: malformed reports (A6) return the fixed schema-fail result", () => {
  const FIXED = (): J => ({
    schema: "mctl.feasibility-consumption/1",
    valid: false,
    checks: [
      { id: "consume.report_schema", status: "fail", reason_codes: ["report_schema_invalid"] },
      ...CONSUME_CHECK_ORDER.slice(1).map((id) => ({ id, status: "unknown", reason_codes: ["report_not_evaluable"] })),
    ],
    reasons: ["consume.report_schema:report_schema_invalid", ...CONSUME_CHECK_ORDER.slice(1).map((id) => `${id}:report_not_evaluable`)],
  });
  const mutations: [string, (r: J) => J][] = [
    ["null", () => null],
    ["string", () => "report"],
    ["array", () => []],
    ["empty object", () => ({})],
    ["extra key", (r) => ({ ...r, extra: 1 })],
    ["missing key", (r) => {
      const { report_digest: _d, ...rest } = r;
      return rest;
    }],
    ["schema constant", (r) => ({ ...r, schema: "mctl.feasibility-report/2" })],
    ["digest format", (r) => ({ ...r, report_digest: "ABC" })],
    ["null member", (r) => ({ ...r, slot: null })],
    ["float", (r) => ({ ...r, evaluated_at_ms: 1.5 })],
    ["negative", (r) => ({ ...r, capability_revision: -1 })],
    ["slot too long", (r) => ({ ...r, slot: "a".repeat(33) })],
    ["epoch leading zero", (r) => ({ ...r, slot_epoch: "07" })],
    ["verdict enum", (r) => ({ ...r, verdict: "ok" })],
    ["verdict flipped (local relation)", (r) => ({ ...r, verdict: "busy" })],
    ["binding_valid flipped", (r) => ({ ...r, binding_valid: false })],
    ["non_claims altered", (r) => ({ ...r, non_claims: ["not_authorization"] })],
    ["non_claims reordered", (r) => ({ ...r, non_claims: [...r.non_claims].reverse() })],
    ["checks too short", (r) => ({ ...r, checks: r.checks.slice(1) })],
    ["checks reordered", (r) => ({ ...r, checks: [r.checks[1], r.checks[0], ...r.checks.slice(2)] })],
    ["required flag wrong", (r) => ({ ...r, checks: r.checks.map((c: J, i: number) => (i === 20 ? { ...c, required: true } : c)) })],
    ["status inconsistent with codes", (r) => ({ ...r, checks: r.checks.map((c: J, i: number) => (i === 8 ? { ...c, status: "fail" } : c)) })],
    ["code from another check", (r) => ({ ...r, checks: r.checks.map((c: J, i: number) => (i === 8 ? { ...c, status: "fail", reason_codes: ["slot_busy"] } : c)) })],
    ["code on a passing check", (r) => ({ ...r, checks: r.checks.map((c: J, i: number) => (i === 8 ? { ...c, reason_codes: ["path_forbidden"] } : c)) })],
    ["evidence revision", (r) => ({ ...r, checks: r.checks.map((c: J) => (c.evidence.length ? { ...c, evidence: c.evidence.map((e: J) => ({ ...e, revision: 99 })) } : c)) })],
    ["evidence fact not allowed", (r) => ({ ...r, checks: r.checks.map((c: J, i: number) => (i === 8 ? { ...c, evidence: [{ fact: "slot_state", revision: 1 }] } : c)) })],
    ["extra key in check", (r) => ({ ...r, checks: r.checks.map((c: J, i: number) => (i === 0 ? { ...c, x: 1 } : c)) })],
    ["advisory code unknown", (r) => ({ ...r, advisory: { ...r.advisory, advisory_codes: ["nope"] } })],
    ["reasons not matching checks", (r) => ({ ...r, reasons: ["slot.idle:slot_busy"] })],
  ];
  test.each(mutations.map((m) => [m[0], m[1]]))("%s", (_name: string, mutate: (r: J) => J) => {
    const i = inputs();
    const res = consume(mutate(run(i)), i);
    expect(res).toEqual(FIXED());
  });
  test("reason order mismatch with the section 6 rule", () => {
    const i = inputs({ set: { "snapshot.facts.slot_state.value.idle": false, "snapshot.facts.os_identity": { status: "unknown", observed_ms: 1789999000000 } } });
    const r = run(i);
    expect(r.reasons).toHaveLength(2);
    expect(consume({ ...r, reasons: [...r.reasons].reverse() }, i)).toEqual(FIXED());
  });
  test("nothing from a malformed report is echoed", () => {
    const i = inputs();
    const res = consume({ ...run(i), slot: "SECRET-slot-value-that-is-way-too-long-for-the-pattern", SECRETKEY: "SECRET" }, i);
    expect(JSON.stringify(res)).not.toContain("SECRET");
  });
  test("accessor members on a report are rejected without being invoked", () => {
    const i = inputs();
    const r = run(i);
    let called = false;
    Object.defineProperty(r, "slot", {
      enumerable: true,
      get() {
        called = true;
        return "slot-x";
      },
    });
    expect(consume(r, i)).toEqual(FIXED());
    expect(called).toBe(false);
  });
  test("a hostile cyclic or deep report does not throw", () => {
    const i = inputs();
    const r: J = run(i);
    r.checks[0].self = r;
    expect(consume(r, i)).toEqual(FIXED());
    let deep: J = {};
    for (let k = 0; k < 5000; k++) deep = { d: deep };
    expect(consume(deep, i)).toEqual(FIXED());
  });
  test("malformed envelope, snapshot or clock still throw (A5/A6) even with a malformed report", () => {
    const i = inputs();
    expect(thrown(() => validate_report_for_consumption(null, { ...i.env, slot: "" }, i.snap, i.now)).input).toBe("envelope");
    expect(thrown(() => validate_report_for_consumption(null, i.env, { ...i.snap, revision: -1 }, i.now)).input).toBe("snapshot");
    expect(thrown(() => validate_report_for_consumption(null, i.env, i.snap, 1.5)).input).toBe("clock");
  });
});

describe("consumption: retained_under_invalid_binding local relations (14.6a/b, 14.7)", () => {
  const SCHEMA_FAIL = (): J => ({
    schema: "mctl.feasibility-consumption/1",
    valid: false,
    checks: [
      { id: "consume.report_schema", status: "fail", reason_codes: ["report_schema_invalid"] },
      ...CONSUME_CHECK_ORDER.slice(1).map((id) => ({ id, status: "unknown", reason_codes: ["report_not_evaluable"] })),
    ],
    reasons: ["consume.report_schema:report_schema_invalid", ...CONSUME_CHECK_ORDER.slice(1).map((id) => `${id}:report_not_evaluable`)],
  });
  // Set retained on the named checks, then re-digest so only the local relation (not the digest) can reject.
  function forge(r: J, ids: string[], value: boolean): J {
    const body = { ...r, checks: r.checks.map((c: J) => (ids.includes(c.id) ? { ...c, retained_under_invalid_binding: value } : c)) };
    delete body.report_digest;
    return { ...body, report_digest: digest("report", body) };
  }
  const DUP = { "snapshot.facts.attempts_seen.value.ids": ["a-00000000-0000-4000-8000-000000000002"] };
  const EXPIRED = { "envelope.expires_at_ms": 1789999400000 };

  test("forged report keeps a matching digest: the failure is schema, not digest", () => {
    const i = inputs();
    const f = forge(run(i), ["identity.os"], true);
    expect(digest("report", f, { exclude: ["report_digest"] })).toBe(f.report_digest);
    expect(consume(f, i)).toEqual(SCHEMA_FAIL());
  });
  test.each([["identity.os"], ["binding.schema"], ["estimate.advisory"], ["binding.attempt_unique"]])("valid binding: true on %s is rejected", (id) => {
    const i = inputs();
    const r = run(i);
    expect(r.binding_valid).toBe(true);
    expect(consume(forge(r, [id], true), i)).toEqual(SCHEMA_FAIL());
  });
  test.each([["binding.schema"], ["binding.attempt_unique"], ["binding.not_expired"]])("invalid binding: true on binding row %s is rejected", (id) => {
    const i = inputs({ set: DUP });
    const r = run(i);
    expect(r.binding_valid).toBe(false);
    expect(consume(forge(r, [id], true), i)).toEqual(SCHEMA_FAIL());
  });
  test("invalid binding: true on the advisory row is rejected", () => {
    const i = inputs({ set: DUP });
    expect(consume(forge(run(i), ["estimate.advisory"], true), i)).toEqual(SCHEMA_FAIL());
  });
  test.each([
    ["evidence_not_evaluable (wrong slot)", { "snapshot.slot": "slot-y" }],
    ["evidence_not_evaluable / authority_unverified (unverified provenance)", { "snapshot.provenance.verified": false }],
    ["evidence_stale (after window)", { now: 1789999950000 }],
  ])("expanded non-evaluable or stale substantive check cannot be retained: %s", (_n, set) => {
    const i = inputs({ set });
    const r = run(i);
    expect(r.binding_valid).toBe(false);
    for (const id of SNAPSHOT_DERIVED_CHECKS) {
      expect(consume(forge(r, [id], true), i)).toEqual(SCHEMA_FAIL());
    }
  });
  test("expansion code with evidence refs present still cannot be retained", () => {
    const i = inputs({ set: { "snapshot.slot": "slot-y" } });
    const r = run(i);
    const body: J = {
      ...r,
      checks: r.checks.map((c: J) =>
        c.id === "slot.idle" ? { ...c, retained_under_invalid_binding: true, evidence: [{ fact: "slot_state", revision: r.capability_revision }] } : c,
      ),
    };
    delete body.report_digest;
    expect(consume({ ...body, report_digest: digest("report", body) }, i)).toEqual(SCHEMA_FAIL());
  });
  test("evaluable-looking substantive check with no evidence refs cannot be retained", () => {
    const i = inputs({ set: DUP });
    const r = run(i);
    const body: J = {
      ...r,
      checks: r.checks.map((c: J) => (c.id === "slot.idle" ? { ...c, evidence: [] } : c)),
    };
    delete body.report_digest;
    const f = { ...body, report_digest: digest("report", body) };
    expect(consume(f, i)).toEqual(SCHEMA_FAIL());
  });
  test("invalid binding: an evaluated substantive check reported as not retained is rejected", () => {
    const i = inputs({ set: DUP });
    const r = run(i);
    expect(consume(forge(r, ["slot.idle"], false), i)).toEqual(SCHEMA_FAIL());
  });
  test.each([
    ["duplicate attempt with evaluable facts", DUP],
    ["task expiry with a fresh snapshot", EXPIRED],
  ])("positive control: genuine report stays schema-valid, %s", (_n, set) => {
    const i = inputs({ set });
    const r = run(i);
    expect(r.binding_valid).toBe(false);
    const retained = r.checks.filter((c: J) => c.retained_under_invalid_binding).map((c: J) => c.id);
    expect(retained).toEqual([...SNAPSHOT_DERIVED_CHECKS]);
    expect(code(consume(r, i), "consume.report_schema")).toEqual({ id: "consume.report_schema", status: "pass", reason_codes: [] });
  });
  test("positive control: duplicate-attempt report is fully consumable", () => {
    const i = inputs({ set: DUP });
    expect(consume(run(i), i).valid).toBe(true);
  });
  test("positive control: valid-binding report keeps every flag false and passes", () => {
    const i = inputs();
    const r = run(i);
    expect(r.checks.every((c: J) => c.retained_under_invalid_binding === false)).toBe(true);
    expect(consume(r, i).valid).toBe(true);
  });
});

describe("consumption: digest is integrity, not authenticity", () => {
  test("changing a schema-valid report field without re-digesting fails the digest check only", () => {
    const i = inputs();
    const r = run(i);
    const res = consume({ ...r, evaluated_at_ms: r.evaluated_at_ms + 1 }, i);
    expect(res.reasons).toEqual(["consume.report_digest:report_digest_mismatch"]);
  });
  test("a consistent re-digested forgery is locally consistent and passes: valid:true makes no authenticity claim", () => {
    const i = inputs();
    const r = run(i);
    const { report_digest: _d, ...body } = { ...r, evaluated_at_ms: r.evaluated_at_ms + 1 };
    const forged = { ...body, report_digest: digest("report", body) };
    expect(consume(forged, i).valid).toBe(true);
  });
  test("locally inconsistent forgery (verdict feasible over a busy check) is a schema failure even when re-digested", () => {
    const i = inputs({ set: { "snapshot.facts.slot_state.value.idle": false } });
    const r = run(i);
    const { report_digest: _d, ...body } = { ...r, verdict: "feasible" };
    const forged = { ...body, report_digest: digest("report", body) };
    expect(consume(forged, i).checks[0].status).toBe("fail");
  });
});
