# Dispatch feasibility report: design (B1), refs #146

Status: **design only**. Nothing in this document is implemented, measured or probed. It adds no
runtime code, no dispatch/reservation/launch/ack change, and no enforcement. The companion file
[dispatch-feasibility-fixtures-146.json](dispatch-feasibility-fixtures-146.json) holds *illustrative
design expectations*; they are not executable feature tests and not evidence of readiness.

**Status legend (read this first).** Four kinds of statement appear in this document and must not be confused:

| Label | Meaning |
|---|---|
| **IMPLEMENTED (#169)** | A fact about merged code: only `plugin/mctl-bridge/src/feasibility/canonical.ts` (MCTL-CJ1 encoder, strict parser, digest). Nothing else (no evaluator, no consumption function, no schema validator) exists. |
| **DESIGN COMMITMENT** | Text of this design as already reviewed and merged before this amendment. Still design only, not implemented. |
| **PROPOSED / PENDING OWNER DECISION** | New contracts A1–A6 and the object-set rule, collected in section 13, each with a concrete alternative. Not approved. Authoring or merging this document is **not** operator approval to implement them. Where a legacy sentence is affected, it carries a `[PENDING A#]` marker pointing to section 13. |
| **FUTURE APPROVAL** | Operator decisions that do not exist yet (gate G8/G9): approval of the proposals, then of any implementation. All runtime work is held. |

Pending-rule index: A1 path grammar (13.1), A2 closed fact schemas (13.2), object-set rule (13.3), A3 artifact
and worktree evidence (13.4), A4 authority evidence (13.5), A5 input error behavior (13.6), A6 malformed-report
consumption (13.7), consequential list updates (13.8).

Refs #146 (not "closes"). Order of work stays: **B1** design / dry-run / report, then a separate owner
decision, then **B2** atomic dispatch enforcement (section 11). The report contracts here are independent
of the handoff (#127), context (#107) and operator-attention (#130) contracts, and a preflight PASS is
never OS-isolation evidence (#106/#108 are separate).

## 1. Goal and non-claims

Before a future dispatch, a deterministic, read-only function maps
`(TaskEnvelope, CapabilitySnapshot, injected clock value)` to a `FeasibilityReport`.

A report (and any digest in it) does **not**:

- grant permission or authorize dispatch, send or ack (a send/ack is not feasibility or authorization);
- reserve the slot or any capacity (dispatch-time preflight reserves nothing);
- prove OS isolation or a permission profile is enforced;
- solve TOCTOU: ownership, base and epoch can change the instant after the read. Hashes bind inputs; they
  do not freeze the world. See section 11.

Every report carries these non-claims as constant fields (`non_claims`, section 6).

## 2. What exists today (source facts) vs. future prerequisites

Read from source only; no host command was run. Paths: `bridge.lua` is `plugin/mctl-bridge/src/bridge.lua`,
`store.ts`/`handoff.ts`/`publish.ts` are under `plugin/mctl-bridge/src/`, `slot.sh` is
`plugin/mctl-bridge/ops/slot.sh`.

| Fact | Today (source) | Status for this design |
|---|---|---|
| Task content | `send()` takes an opaque `payload` string, max 16384 bytes, plus `hop`, `ttl_ms`, idempotency key (`bridge.lua:516`, `MAX_PAYLOAD` `bridge.lua:29`, `store.ts:18`). No schema. | Envelope is new; prose is never a verdict input. |
| Slot identity at send | `send()` rejects an unregistered slot and copies `uuid` and `epoch` from the slot hash (`bridge.lua:527-532`). | Epoch/slot are today's only binding facts. |
| Slot busy/inflight | Slot hash holds `busy`, `inflight`, `inflight_attempt`; `bridge_status` returns them (`bridge.lua:501-507`). | Source of a future `slot.idle` fact; B1 does not read a live store. |
| No reservation | `send()` queues and returns; nothing is held (`bridge.lua:530-540`). | Why TOCTOU stays open. |
| Duplicate ids | `send()` returns the existing id with `dedup` on a known idempotency key (`bridge.lua:522-525`) and `duplicate_id` on a reused message id (`bridge.lua:529`). | Analogue for `attempt_unique`; the store has no per-attempt feasibility record. |
| Permission rules | `ops/slot.sh` writes `settings.json` with allow/deny command-prefix rules (`slot.sh:199-215`) and launches `claude` in `--permission-mode default` with a fixed `--allowedTools` list (`slot.sh:221-240`). | Rules are matched by Claude Code's proprietary matcher. A textual prefix comparison is **not** faithful (deny globs such as `Bash(*.ssh*)`, `Bash(go *-exec*)`). Compatibility is `unknown` unless a future provider supplies a decision. |
| Handoff inputs | `ExportInput` has repo, `baseSha`, `headSha`, `branch` (`handoff.ts:55-67`); `ExportResult` has `changed_files` (`handoff.ts:92-106`). | Shape analogue for the artifact contract; it is evidence only after the fact. |
| Commit trailer / publisher | The publisher **is in this repo**: `plugin/mctl-bridge/src/publish.ts`. After the commits exist it validates the actual range (`publish.ts:391-427`): base on `origin/main`, no merge commits, no `Co-Authored-By` line in any commit (`co_authored_by`, `publish.ts:406-411`), changed files equal the manifest, every touched path inside the allow list (`allowed()`: exact entry or directory entry ending in `/`, `publish.ts:281`), no workflow or special files. It does **not** check that an `Agent: claude` trailer is present; that requirement exists only as slot instructions (`channel.ts:80`). | The envelope's `expected.trailer` is a *declared expectation before dispatch*, `unknown` until a snapshot supplies a verified fact. Post-commit publisher validation is evidence after the fact, not a feasibility input, and no pre-dispatch check may claim the publisher enforces the trailer. |
| Base SHA, worktree state, OS identity, permission profile digest, ownership claims | **Not in the store.** | Future injected snapshot facts only. |
| Capability provider | **Does not exist.** | Not invented here. |

Future prerequisites (each a separate, not-yet-approved gate, section 12): a snapshot collector, its
authentication and trust model, freshness policy, and a matcher-faithful command decision source. This
design does not authorize or describe collecting any host fact.

## 3. Inputs

Both inputs are declarative claims. Provenance and authority must be *verified* (check ids
`binding.provenance`, `authority.reference`); a matching hash or an orchestrator-authored claim alone
establishes no right. Unverified provenance/authorization is `unknown`, never `pass`.

Free-text task prose, tool output and question text are untrusted and are never serialized into a report
or used by a check. Credentials, private filesystem paths and question text are never evidence fields.

### 3.1 TaskEnvelope v1

Fixed ASCII keys, all required (absence of a feature is expressed with an empty set/array, never `null`):

| Key | Type | Notes |
|---|---|---|
| `schema` | string | `mctl.task-envelope/1` |
| `task_id`, `attempt_id` | string | ids shaped like the store's `t-<uuid>` / `a-<uuid>` |
| `slot` | string | `[a-z0-9-]` like the store's slot names |
| `slot_epoch` | string | decimal, as the store keeps epochs as strings |
| `repo` | string | `owner/name` |
| `worktree_label` | string | opaque label, never a filesystem path |
| `base` | object | `branch`, `base_sha` (40 lowercase hex) |
| `allowed_files` | **set** of strings | repo-relative path patterns: a permission *scope* (what output may touch), never a count of required writes. The pattern grammar is undefined in the committed design; **[PENDING A1]** (13.1) |
| `expected` | object | `artifact_kind`, `branch`, `trailer` |
| `required_commands` | **set** of strings | logical command ids (`cmd:...`), not shell text |
| `fixtures` | **set** of strings | logical fixture/test-data ids |
| `dependencies` | array of objects | each `{id, kind, step}`; `step` in `automatic` \| `human` |
| `bounds` | object | verified-intent limits: `max_changed_files`, `max_wall_ms` (integers) |
| `expires_at_ms` | integer | envelope validity end |
| `authority_ref` | object | `{kind, id}`; `kind` is `none` when no authority applies |
| `advisory` | object | `est_changed_files`, `est_minutes` — heuristic, see section 8 |

### 3.2 CapabilitySnapshot v1 (future, injected; B1 never collects)

| Key | Notes |
|---|---|
| `schema`, `snapshot_id`, `revision` | `revision` is a monotonic integer; any change in facts changes the digest |
| `slot`, `slot_epoch` | what the snapshot describes |
| `captured_at_ms`, `expires_at_ms` | freshness window |
| `provenance` | `{source_kind, issuer_ref, verified}`; `verified` is a boolean set only by a future trust gate |
| `facts` | one entry per fact id (below); each `{status, value, observed_ms}`, `status` in `known` \| `unknown` \| `absent`. The committed design fixes only this envelope; the exact `value` schema per fact, whether `value` is present for non-known, and the two extra facts `artifact_contract` / `authority_decision` are **[PENDING A2/A3/A4]** (13.2, 13.4, 13.5) |

Fact ids: `os_identity`, `permission_profile`, `command_decisions` (per required command: `allowed` \|
`denied` \| `unknown`, produced by the real matcher, never by B1), `repo_base`, `worktree`, `ownership`,
`dependencies`, `fixtures`, `slot_state`, `attempts_seen`, `limits` (verified hard bounds, if any),
`path_policy` (verified forbidden path patterns), `mandatory_writes` (a *set* of repo-relative paths that an
independent verified source says any correct result must write: a lower bound on required artifacts; it
is never derived from `allowed_files`, `bounds` or `advisory`).

### 3.3 Three different "no value" states

- **`absent`** — the source says the thing does not exist (e.g. no permission profile is configured).
- **`unknown`** — it could not be determined or faithfully evaluated (e.g. matcher not reproducible).
- **`false`/`fail`** — the thing was evaluated from evidence and the requirement is not met.

`stale` is a check status for evidence outside its freshness window. None of `absent`, `unknown`, `stale`
can be read as `pass` or as `fail`.

## 4. Canonical encoding and digests

This is **not** RFC 8785 (JCS). It is a restricted deterministic profile named **MCTL-CJ1**, defined
exactly:

1. Input is a JSON value tree from the closed schema. Reject (do not repair) any unknown key, duplicate key,
   `null`, float, exponent, non-finite number or non-schema type.
2. Objects: `{` then members in **ascending bytewise order of the UTF-8 key** (keys are ASCII), `"key":value`
   joined by `,`, then `}`. No whitespace anywhere.
3. Strings: valid Unicode scalar values only (reject lone surrogates). No Unicode normalization. Output
   `"`, then each scalar: `"` → `\"`, `\` → `\\`, U+0000–U+001F → `\u00xx` (lowercase hex), everything
   else (including U+007F and non-ASCII) as raw UTF-8 bytes; then `"`. No other escapes (`\n`, `\/` etc.
   are never emitted).
4. Integers: base-10, no `+`, no leading zeros, no `-0`, magnitude at most 2^53 − 1.
5. Booleans `true` / `false`.
6. Arrays: `[` elements joined by `,` `]`. **Ordered arrays** keep their order and duplicates; the encoder
   never reorders them. Fields declared **set-valued** in the schema (`allowed_files`, `required_commands`,
   `fixtures`, `mandatory_writes`, plus snapshot fact value sets) must already be strictly ascending by
   bytewise UTF-8 with no duplicates; otherwise the input is *rejected* (`binding.schema` fails). Nothing is
   silently sorted or de-duplicated, and there is no global array sort or dedup. Report `reasons`,
   `checks` and `advisory_codes` are **ordered arrays**, not sets: their order is semantic and defined in
   section 6 (reasons) and section 5 (checks); `advisory_codes` is ascending by bytewise UTF-8 by that
   field's own rule, still without any encoder-side sorting.

   *Implementation fact (#169):* `canonical.ts` takes an optional `setFields` set of object **key names**
   and requires every array under a matching key name, at any depth, to be a strictly ascending string set
   (`unsorted_set` / `wrong_type`). It has no path awareness and no notion of arrays of objects with an
   identity key. The "snapshot fact value sets" wording above is therefore a design commitment that the
   current code does **not** implement as path-specific validation. **[PENDING object-set rule]** (13.3)
   proposes path-specific object-set validation; any change to `canonical.ts` or a future schema validator
   requires separate approval.
7. Digest = lowercase-hex SHA-256 over `domain || 0x0A || canonical_bytes`. `domain` is an ASCII string with
   no LF, fixed per object type: `mctl.feasibility/1/task-envelope`, `.../capability-snapshot`,
   `.../report`, `.../test-vector`. The LF frames the domain, so two object types cannot collide.

### Design vectors (not conformance results)

Two byte strings were hashed once with a local `shasum -a 256` while writing this document, to give
implementers a starting reference. They are design vectors, not a cross-language equivalence claim.

Vector A — encoding rules (domain `mctl.feasibility/1/test-vector`, body 37 bytes, input 68 bytes):

```
{"a":"é\"\u0001","b":[2,1],"c":true}
sha256 = cf21d3e7ed6c38229e8e4158b19a7c8d0bb0352e7c0a225b3c205ebc35ac3fc9
```

(`é` is two UTF-8 bytes `c3 a9`; `b` is an ordered array and keeps `[2,1]`.)

Vector B — a synthetic TaskEnvelope (domain `mctl.feasibility/1/task-envelope`, body 747 bytes, input 780 bytes
= 32-byte domain + LF + body). The follow-up review edits did not change this canonical body; A and B were
re-hashed independently from freshly written byte files and match the values below:

```
{"advisory":{"est_changed_files":2,"est_minutes":20},"allowed_files":["docs/example-146.md"],"attempt_id":"a-00000000-0000-4000-8000-000000000002","authority_ref":{"id":"decision-0001","kind":"operator_decision"},"base":{"base_sha":"0123456789abcdef0123456789abcdef01234567","branch":"main"},"bounds":{"max_changed_files":3,"max_wall_ms":3600000},"dependencies":[],"expected":{"artifact_kind":"handoff_bundle","branch":"docs/example-146","trailer":"Agent: claude"},"expires_at_ms":1790000000000,"fixtures":["fixture:synthetic-a"],"repo":"example-org/example-repo","required_commands":["cmd:git-diff-check"],"schema":"mctl.task-envelope/1","slot":"slot-x","slot_epoch":"7","task_id":"t-00000000-0000-4000-8000-000000000001","worktree_label":"wt-1"}
sha256 = 43e77d4fafa97cc56fe831d1bdcb145468f821b940bdf1519a074157c9527880
```

Unresolved serialization gate: an independent second implementation (another language) must reproduce
vectors A and B and a rejection corpus (duplicate keys, lone surrogates, floats, unsorted sets) before any
claim of cross-language equivalence. Until then none is made. Fixtures in the JSON file use symbolic digest
labels (`digest:env-A`), not real hashes, except where they cite vector B.

## 5. Checks

Each check has `id`, `required` (bool), `status` in `pass|fail|unknown|absent|stale`, `reason_codes` (an
ordered array, ascending bytewise by code within the check), and `evidence` = a list of `{fact, revision}`
references (never raw values that could be sensitive). Fixed evaluation/output order of the pure
`evaluate(envelope, snapshot, nowMs)`:

**Binding gate** (evaluated first; seven checks, all computable from the two inputs and the clock):
`binding.schema`, `binding.provenance`, `binding.slot`, `binding.epoch`, `binding.capability_fresh`,
`binding.not_expired`, `binding.attempt_unique`.

*Role of `binding.schema` [PENDING A5]:* the committed text lets `binding.schema` fail inside a returned
report. Proposal A5 (13.6) instead rejects malformed inputs by throwing before any report exists; then
`binding.schema` is `pass` in every returned report. Alternative in 13.6. Until the owner decides, both
readings are unapproved and the check list keeps the entry.

`binding.not_expired` is about the **envelope** `expires_at_ms` only (code `task_expired`).
`binding.capability_fresh` is about the **snapshot** window `captured_at_ms..expires_at_ms` only (code
`capability_stale`). The two can fail independently or together.

There is deliberately **no** `binding.task_digest` in `evaluate`: it takes no prior report, so there is no
bound digest to compare. Comparing a prior report with a presented task and snapshot is the separate
consumption validation of section 6.1.

**Substantive checks:**
`authority.reference`, `authority.paths`, `authority.commands`, `identity.os`, `permission.profile`,
`matcher.compat`, `repo.base`, `ownership.files`, `contract.artifact`, `dependency.declared`,
`fixtures.data`, `slot.idle`, `bounds.explicit`, and the non-required `estimate.advisory`.

Mapping to verdict classes:

| Class | Checks that can fail it |
|---|---|
| unauthorized | `authority.reference`, `authority.paths` (path matches a verified forbidden pattern, or a verified mandatory write lies outside `allowed_files`), `authority.commands` (a required command has verified decision `denied`) |
| blocked_dependency | `dependency.declared` (automatic dependency unmet), `fixtures.data` (test data unavailable), `ownership.files` (another owner holds overlapping files), `repo.base` (base moved from the bound SHA) |
| needs_split | `bounds.explicit` (a *verified, independent* lower bound of mandatory writes exceeds a verified limit), `dependency.declared` with `step: human` |
| busy | `slot.idle` |
| uncertain | any required check `unknown`/`absent`/`stale`; any binding failure |

`authority.paths` is evaluated against `path_policy` from the snapshot; `allowed_files` ⊄ policy is
`fail` only when that policy is `known`; otherwise `unknown`. A mandatory write is never allowed to widen
authority: if `mandatory_writes` (known) contains a path not matched by `allowed_files`, `authority.paths`
fails with `mandatory_write_outside_allowed` (unauthorized); `allowed_files` is not extended to cover it.

**Evidence states under an invalid binding.** Each snapshot-derived check (the eleven in the fixtures'
`snapshot_derived_checks`; **[PENDING A3/A4]** that list grows to twelve or thirteen if `contract.artifact`
and/or `authority.reference` become evidence-derived, see 13.8) takes one of two non-pass states when the snapshot cannot be used, with distinct
codes: `unknown` + `evidence_not_evaluable` when the snapshot is untrusted or is not about this task
(schema invalid, provenance unverified, other slot, other epoch); `stale` + `evidence_stale` when it is
well-formed, verified and for the same slot/epoch but outside its freshness window. Not-evaluable wins
when both apply. Such a check never reports `pass`, never `fail`. `authority.reference` is not
snapshot-derived: it is `unknown` + `authority_unverified` only when provenance is unverified. These
expansion entries are produced **once per check, in place**: an explicit reason for the same check (for
example `authority.commands:evidence_stale`) *is* that check's entry and is not repeated.

## 6. Verdict, precedence, binding validity

Verdicts are exactly: `feasible | busy | needs_split | blocked_dependency | unauthorized | uncertain`.
Binding validation is an evaluation **gate**, not a seventh verdict.

1. **Binding.** `binding_valid` is true only if all seven binding checks `pass`.
2. **If `binding_valid` is false:** verdict is `uncertain`, `binding_valid=false`, and binding reason codes
   list the failed binding checks (`slot_mismatch`, `epoch_stale`, `capability_stale`, `task_expired`,
   `attempt_duplicate`, `provenance_unverified`, `schema_invalid`).
   Substantive checks are still evaluated **only on evidence that is individually evaluable** (schema valid,
   provenance verified, fresh, and for the same slot). Those results are retained and marked
   `retained_under_invalid_binding: true`; they can never make the report feasible and the report authorizes
   nothing. Evidence that is stale/untrusted/for another slot yields `stale`/`unknown` (section 5), so it
   cannot pose as a proven denial. Note that one clock value can invalidate both windows: an
   `evaluated_at_ms` after the snapshot's `expires_at_ms` makes `binding.capability_fresh` `stale`
   *and*, if also after the envelope's `expires_at_ms`, `binding.not_expired` `fail`; the report lists both
   and every snapshot-derived check is then `stale`. A task-only expiry needs a snapshot that is still fresh
   at that clock value. (Open gate G5: whether a trusted, fresh denial should be surfaced as top-level
   `unauthorized` despite an unrelated binding failure. Default here: no, verdict stays `uncertain`.)
3. **If `binding_valid` is true:** first match in this precedence wins the verdict:
   `unauthorized` > `blocked_dependency` > `needs_split` > `busy` > `uncertain` > `feasible`.
   - a class applies if any of its checks is `fail` (or, for `uncertain`, any *required* check is
     `unknown`/`absent`/`stale`);
   - `feasible` only if **every required check is `pass`** and binding is valid.
4. **All findings are retained, in an ordered `reasons` array** (an *ordered array*, never a set, section 4).
   Each entry is the string `check_id:code`, one per (check, code) with a non-pass status, including the
   `stale`/`unknown` entries of non-evaluable checks. The order is total and fully specified by this sort
   key, compared left to right:
   1. **class rank**: `binding` (0) first, then `unauthorized` (1), `blocked_dependency` (2), `needs_split`
      (3), `busy` (4), `uncertain` (5). A reason's class is the section 5 class of its check when the
      check status is `fail`; any `unknown`/`absent`/`stale` entry is class `uncertain`; every
      `binding.*` entry is class `binding`;
   2. **check order**: the index in the fixed section 5 list (`check_order` in the fixtures);
   3. **code**: ascending bytewise UTF-8 of the reason code.
   There is no other sort and no deduplication: the key is a total order on distinct (check, code) pairs, and
   each pair appears at most once. The order is *not* ascending by the whole string, so a `busy` verdict
   still lists `slot.idle:slot_busy` before `identity.os:identity_os_unknown`; the verdict is the highest
   class, not the only finding. Retained-under-invalid-binding entries follow the same key (they fall into
   their class after all `binding` entries).

Required checks (everything except `estimate.advisory`): trusted identity (`identity.os`), permission
profile (`permission.profile`), `matcher.compat`, repo/base (`repo.base`), artifact/commit contract
(`contract.artifact`), ownership (`ownership.files`), capability freshness (`binding.capability_fresh`),
plus all others above. A missing OS identity, permission profile or base can produce at best `uncertain`.

### FeasibilityReport v1 shape

`schema`, `task_digest`, `capability_digest`, `capability_revision` (the snapshot's `revision`), `task_id`,
`attempt_id`, `slot`, `slot_epoch`,
`evaluated_at_ms` (the **injected** clock value; the function never reads time), `expires_at_ms`
(= min of envelope and snapshot expiry), `binding_valid`, `verdict`, `checks[]` (ordered, section 5),
`reasons[]` (ordered, rule in item 4), `advisory` (section 8), `non_claims` (constant list:
`not_authorization`, `not_reservation`, `not_os_isolation`, `not_toctou_closure`), and `report_digest`
(domain `.../report`, over the canonical bytes of every other field; the field itself is excluded, see 6.1).
Output is MCTL-CJ1 bytes; identical inputs give byte-identical output.

### 6.1 Report consumption validation (separate contract)

`evaluate(envelope, snapshot, nowMs)` is pure over those three inputs and has no old report. A consumer that
holds a *prior* report and later wants to know whether it still describes the inputs in front of it calls a
second pure function:

`validate_report_for_consumption(report, envelope, snapshot, nowMs)` → `ConsumptionResult`
`{schema, valid, checks[], reasons[]}`, `valid` true only if every check passes. Same encoding, same
privacy rules, same ordered-`reasons` rule (class `consumption` sorts first, then check order, then code).
It never re-derives the verdict and **never authorizes**: `valid: true` means "this report was computed from
exactly these inputs and has not expired", nothing more. Its checks, in order:

| Check | Pass condition | Non-pass |
|---|---|---|
| `consume.report_schema` | report parses under MCTL-CJ1, closed schema, constant `non_claims` present | `fail` `report_schema_invalid`. **[PENDING A6]** the behavior of the other seven checks after this failure is unspecified in the committed design; 13.7 proposes it |
| `consume.report_digest` | recompute the digest over the report's canonical bytes **with the `report_digest` member removed** (self-field exclusion) under domain `.../report`; equals the stored value | `fail` `report_digest_mismatch` |
| `consume.report_expired` | `nowMs <= report.expires_at_ms` | `stale` `report_expired` |
| `consume.identity` | report `task_id`, `attempt_id`, `slot`, `slot_epoch` equal the presented envelope's | `fail` `identity_mismatch` |
| `consume.task_digest` | digest of the presented envelope (domain `.../task-envelope`) equals `report.task_digest` | `fail` `task_digest_mismatch` |
| `consume.capability_digest` | digest of the presented snapshot (domain `.../capability-snapshot`) equals `report.capability_digest` | `fail` `capability_digest_mismatch` |
| `consume.capability_revision` | presented snapshot `revision` equals `report.capability_revision` | `fail` `capability_revision_mismatch` |
| `consume.trust` | presented snapshot is schema-valid and `provenance.verified` is true (the same trust gate as `binding.provenance`); a digest match does not substitute | `unknown` `provenance_unverified` |

Distinctions: **stale/expired** (`consume.report_expired`, status `stale`) means time has passed; a
**mismatched digest or revision** (status `fail`) means the report describes *different inputs*. They never
share a code. The key case: the task is unchanged, but a different, still-fresh snapshot of the same slot and
epoch has been taken. Then `consume.task_digest` passes, the report is unexpired, yet
`consume.capability_digest` and `consume.capability_revision` fail, so the old report is not consumable;
a fresh evaluation is required. Hashes bind inputs only. A hash match is never authority, never proof the
facts still hold, and does not close TOCTOU (section 11).

## 7. Privacy and sanitized output

- Evidence is by reference (`fact` id + `revision` + digest), not by value.
- Never serialized: credentials, tokens, absolute/private filesystem paths, host names, question or
  message text, tool output, free-text prose.
- Strings in the report come from closed enums (verdicts, statuses, reason codes, check ids) or are echoed
  from schema-validated identifiers (`task_id`, `attempt_id`, `slot`, `repo`, repo-relative patterns).
  Any identifier failing its pattern is **not** echoed. Committed text: it makes `binding.schema` fail in the
  report. **[PENDING A5]** proposed: it makes the evaluator throw a closed `FeasibilityInputError` and no
  report exists (13.6). Never-echo holds under both.
- Output must be stable: fixed key order (MCTL-CJ1), fixed check order, sorted reason codes.

## 8. Advisory estimates

`advisory.est_*` are heuristics declared by the task author. They never produce `feasible`, never
override a trusted check, and never alone produce a hard denial.

`allowed_files` is permission scope, not a list of mandatory writes. A wide allowlist, a large upper
budget (`bounds`), or a pessimistic estimate can never by itself establish impossibility: a task may be
allowed to touch four paths and need one, and a wall budget above a runner maximum does not show the task
cannot finish sooner. `needs_split` therefore requires one of:

- an **independently verified lower bound of mandatory writes** (`mandatory_writes` fact `known`, from a source
  that is neither the envelope author's `allowed_files`/`bounds`/`advisory` nor a heuristic) whose size
  exceeds a verified limit (`limits.max_changed_files`) or the envelope's own `bounds.max_changed_files`
  (`bounds.explicit` `fail`, `verified_bound_exceeded`); or
- a declared dependency whose `step` is `human` (a real intermediate human step).

If `mandatory_writes` or `limits` is `unknown`/`absent`, `bounds.explicit` is `unknown`
(`mandatory_writes_unknown` / `limits_unknown`), not `fail`. Using required writes never broadens authority:
the actual output must stay inside `allowed_files` (see `authority.paths` in section 5). An upper wall
budget above a verified runner maximum, or an estimate above a bound, only adds an advisory code
(`wall_budget_exceeds_runner_limit`, `estimate_exceeds_bound`), ascending bytewise in `advisory_codes`, and
leaves the verdict to the trusted checks. Measured/declared facts and estimates are separate sections of the
report.

## 9. Side effects

The dry run is a pure function of its three inputs. It performs no store write, send, ack, reservation,
commit, push, PR, worktree write, subprocess or network call (strategy in section 10.2).

## 10. Proposed B1 implementation and test allowlist (not approved here)

### 10.1 Allowlist for a future B1 implementation PR

Source (new files only, nothing existing modified except where listed):

- `plugin/mctl-bridge/src/feasibility/canonical.ts` — MCTL-CJ1 encoder/validator, digest.
- `plugin/mctl-bridge/src/feasibility/types.ts` — schemas and closed enums.
- `plugin/mctl-bridge/src/feasibility/evaluate.ts` — pure `evaluate(envelope, snapshot, nowMs)` and the
  separate pure `validate_report_for_consumption(report, envelope, snapshot, nowMs)` (section 6.1).
- `plugin/mctl-bridge/test/feasibility-canonical.test.ts`
- `plugin/mctl-bridge/test/feasibility-evaluate.test.ts`
- `plugin/mctl-bridge/test/feasibility-purity.test.ts`
- `plugin/mctl-bridge/test/fixtures/feasibility/` — executable fixtures derived from, and reviewed against,
  `docs/dispatch-feasibility-fixtures-146.json`.
- `plugin/mctl-bridge/docs/feasibility.md` — operator-facing short description (optional).

Explicitly **not** in B1: `bridge.lua`, `store.ts`, `channel.ts`, `cli.ts` send/ack paths, `ops/slot.sh`,
settings/credentials/identity/worktree code, any snapshot collector, any CLI subcommand that reads a live
store or host.

### 10.2 Zero-side-effect test strategy

- `evaluate` takes plain objects and an integer clock; imports no `node:fs`, `node:child_process`,
  `node:net`, `valkey.ts` or `store.ts` (an import-graph test asserts this).
- Purity test runs under a harness that replaces `fs`, `child_process`, `net`, `fetch`, `Date.now` and
  `crypto.randomUUID` with throwing stubs, evaluates every fixture, and asserts no stub was called.
- Determinism: evaluate each fixture twice, plus with permuted object key insertion order, and assert
  byte-identical output and digest.
- Mutation test: change one snapshot fact (still fresh, same epoch); assert `capability_digest` and
  `report_digest` change, and that `validate_report_for_consumption` (a second pure function, section 6.1)
  rejects the old report with `capability_digest_mismatch` and `capability_revision_mismatch` while
  `consume.task_digest` and `consume.report_expired` pass. Digest/revision mismatch and expiry are
  distinguished by code.
- Inputs are synthetic only. Existing slots, live bridge state and host facts are never fixtures.

## 11. B2: separately approved atomic enforcement

B2 is a different decision and a different change. Prerequisites and obligations:

1. An owner decision after reviewing B1 reports. A report never substitutes for it.
2. **Atomic revalidation at admission.** B2 must revalidate, inside the same atomic step that creates the
   queued task (a single `FCALL` like `send()`, `bridge.lua:516`), the bound task digest, capability
   revision, slot uuid/epoch, slot idle state, ownership claim and authority reference. A client-side
   dry-run result alone is insufficient; hashes cannot solve TOCTOU, only atomic compare-and-set against
   live state can.
3. **Reservation** semantics (which today do not exist) with expiry, so ownership/base/epoch cannot change
   between check and queue.
4. **Idempotency:** the idempotency key must bind to `(task_digest, attempt_id)`; same key with different
   digest is rejected (analogue of `rid_conflict` in `ingest`, `bridge.lua:782-787`).
5. **Cancel/retry/rollback:** a failed admission leaves no reservation; a cancelled task releases it; a
   retry re-runs the report on fresh facts (new attempt id) and never reuses an old report; a crash between
   reserve and queue is repaired by expiry (analogous to the sweeper/repair paths).
6. **Host isolation prerequisites** (#106/#108): a feasible report is not isolation evidence; enforcement
   of the permission profile and OS user boundary must be proven by those separate efforts first.
7. No live probe or release is part of this design.

## 12. Unresolved gates (not decided or implemented here)

| Gate | Question |
|---|---|
| G1 | Snapshot collector: who builds it, what it may read. |
| G2 | Authentication/trust of snapshots and authority references (`provenance.verified`, `authority.reference`). |
| G3 | Freshness policy (window lengths, clock source). |
| G4 | A matcher-faithful command decision source; until then `matcher.compat` is `unknown`. |
| G5 | Whether a trusted fresh denial surfaces as `unauthorized` under an unrelated invalid binding. |
| G6 | Cross-language equivalence of MCTL-CJ1 (second implementation, rejection corpus). |
| G7 | Where the declared `Agent: claude` trailer expectation is verified. The publisher (`publish.ts`) is in this repo but validates actual commits only after the fact and today refuses `Co-Authored-By` lines, not a missing `Agent:` trailer; whether and where a presence check belongs, and what pre-dispatch fact would carry it, is undecided. |
| G8 | Owner decision to proceed to B1 implementation, and later to B2. |
| G9 | Owner decision on each proposal in section 13 (A1–A6, object-set rule): accept, take the stated alternative, or reject. Precedes G8 for any evaluator work. Unanswered today. |

## 13. PROPOSED contracts, PENDING OWNER DECISION (A1–A6 and object-set rule)

Everything in this section is **PROPOSED / PENDING OWNER DECISION** (gate G9). None of it is implemented,
approved, or executable. Each proposal lists its alternative with behavior and tradeoff. Illustrative cases
live in the fixtures file under `proposals` (`status: PENDING`, never readiness proof, symbolic digests only).
All facts and evidence below are **injected synthetic claims for pure tests**, not runtime grants: provider
authentication, freshness, identity and the proprietary command matcher stay unresolved gates (G1–G4). The
six verdicts and their precedence are unchanged; no seventh verdict is introduced by any proposal.

| ID | Subject | Section | Alternative in one line |
|---|---|---|---|
| A1 | Path/scope grammar and matching | 13.1 | exact/directory-only without `/**`, or `unknown` for unsupported patterns |
| A2 | Closed fact value schemas | 13.2 | defer shapes: only envelope statuses plus opaque digests |
| OS | Object-set ordering/uniqueness | 13.3 | defer; ordered arrays plus explicit uniqueness check |
| A3 | Artifact contract and worktree evidence | 13.4 | leave capability `unknown` until a provider exists |
| A4 | Authority decision evidence | 13.5 | `none` stays `unknown` until an applicability policy is approved |
| A5 | Malformed input behavior | 13.6 | sanitized schema-failure report with a separately designed sentinel policy |
| A6 | Malformed report consumption | 13.7 | throw a sanitized error instead of returning a result |

### 13.1 A1 path grammar (PROPOSED)

Applies to `allowed_files`, `path_policy.forbidden`, and `mandatory_writes`.

- **Grammar.** A pattern is exactly one of: an *exact path* (repo-relative, no trailing `/`); a *directory
  prefix* ending in `/`; or the terminal alias `dir/**` (identical in meaning to `dir/`, only as the final
  segment). Segments are separated by `/`, are non-empty, are not `.` or `..`, contain no `\`, no `*`, `?`,
  `[`, `{`, no NUL/control characters, and the whole pattern does not start with `/` or a drive prefix.
  `mandatory_writes` entries and the paths being tested are exact paths only.
- **Rejection.** Anything else (absolute path, traversal, dot or empty segment, backslash, any other glob) is an
  **input error** (13.6), never a permission result. Invalid grammar is not `fail` and not `pass`.
- **Membership.** An exact path matches itself. A directory prefix `d/` matches a path whose leading segments
  equal `d`'s segments (segment boundary: `docs/` does not match `docs-x/a`). Matching is bytewise on UTF-8
  with no normalization or case folding.
- **Scope intersection** (used by `authority.paths`, `ownership.files`): two patterns intersect iff one's
  segment sequence is a prefix of the other's (exact path counts as a leaf). Symmetric. A forbidden pattern
  that is a descendant of an allowed directory (`allowed: docs/`, `forbidden: docs/secret/`) **blocks**: the
  scope is not usable as a whole, so `authority.paths` fails `path_forbidden`. (Not narrowing: B1 never
  computes a reduced allowlist.)
- **Non-goal.** No emulation of Claude Code's proprietary command matcher; this grammar covers repo paths only.
- **Alternative A1-alt-1 (narrower):** drop `dir/**`; only exact paths and `dir/` prefixes (mirrors the
  publisher's `allowed()`, `publish.ts:281`). Tradeoff: fewer spellings, no alias ambiguity, but task authors
  used to `**` get an input error.
- **Alternative A1-alt-2 (defer):** grammar is not defined; any pattern beyond exact paths makes
  `authority.paths` `unknown` (`path_pattern_unsupported`). Fail-closed consequence: every directory-scoped
  task is at best `uncertain` until the grammar is approved; no false `feasible`, but low usefulness.

### 13.2 A2 closed fact schemas (PROPOSED)

Each `facts.<id>` is exactly `{status, observed_ms}` plus `value` **only when `status` is `known`**. For
`unknown`/`absent`, `value` must be missing (present value is an input error). `observed_ms` is a required
integer in `[0, 2^53-1]`. `facts` has exactly the keys below (A3/A4 add two); unknown or missing fact ids are
input errors. Value objects are closed (exact keys, no extras):

| Fact | `value` (exact) | Constraints |
|---|---|---|
| `os_identity` | `{trusted: bool}` | |
| `permission_profile` | `{digest: string}` | 64 lowercase hex |
| `command_decisions` | `{entries: [{command, decision}]}` | `command` matches `cmd:[a-z0-9._-]{1,64}`; `decision` in `allowed`\|`denied`\|`unknown`; object-set keyed by `command` (13.3) |
| `repo_base` | `{sha: string}` | 40 lowercase hex |
| `worktree` | `{clean: bool}` | |
| `ownership` | `{conflict: bool}` | |
| `dependencies` | `{entries: [{id, met}]}` | `id` string `[a-z0-9:._-]{1,64}`, `met` bool; object-set keyed by `id` |
| `fixtures` | `{entries: [{id, available}]}` | `id` same pattern, `available` bool; object-set keyed by `id` |
| `slot_state` | `{idle: bool}` | |
| `attempts_seen` | `{ids: [string]}` | each `a-<uuid>`; string **set** strictly ascending |
| `limits` | `{max_changed_files, max_wall_ms}` | integers `>= 0` |
| `path_policy` | `{forbidden: [string]}` | A1 patterns; string **set** |
| `mandatory_writes` | `{paths: [string]}` | A1 exact paths; string **set** |

Missing semantics: a required command with **no** entry in `command_decisions`, a declared dependency with no
`dependencies` entry, or a required fixture with no `fixtures` entry is `unknown` (never an implicit pass,
never implicit denial), with codes `command_decision_unknown` (existing), `dependency_unknown` and
`fixture_unknown` (both PROPOSED here). An entry whose id is not required by the envelope is ignored for verdicts but still
schema-checked. These are claims injected for tests; the schemas give them shape, not trust.

- **Alternative A2-alt (narrower/deferred):** define no per-fact value schema yet. Facts carry only
  `{status, observed_ms}` plus an opaque `value_digest`; checks beyond `unknown` cannot be computed, so every
  fact-dependent check is `unknown` until value shapes are approved. Tradeoff: nothing wrongly shaped is
  frozen, but the evaluator can never return anything but `uncertain` (or binding-driven results).

### 13.3 Object-set ordering and uniqueness (PROPOSED, tied to A2)

- The encoder **preserves supplied array order** and never sorts or de-duplicates (as in section 4).
- A **schema validator** (not the encoder) checks, per explicit schema path, that an array of objects is
  strictly ascending and unique by UTF-8 identity key: `command_decisions.entries` by `command`;
  `dependencies.entries` and `fixtures.entries` by `id`. Two members with the same identity are rejected even
  when their other fields differ (`duplicate_identity`); an out-of-order list is `unsorted_set`. Order is
  bytewise UTF-8 (so `cmd:Z` < `cmd:a`, and a shorter prefix sorts first).
- It is path- and schema-specific, never global property-name matching. Ordinary ordered arrays stay ordered;
  `TaskEnvelope.dependencies` (array of `{id,kind,step}`) **stays an ordered array**: its reclassification as
  an object-set would be a separate proposal and is not made here.
- *Implementation fact:* `canonical.ts`'s `setFields` (key-name, string-set) does **not** implement this.
  Implementing it needs a separate, approved change.
- **Alternative OS-alt (defer):** no object-set schema. Entry arrays stay ordered arrays; evaluator-side
  explicit uniqueness validation rejects duplicate ids but accepts any order. Tradeoff: permuting the same
  entries produces a different capability digest and revision-compat semantics (same facts, different bytes), so
  producers must emit a stable order by convention, and digest equality no longer implies set equality.

### 13.4 A3 artifact contract and worktree evidence (PROPOSED)

The committed design already forbids treating the envelope's `expected.trailer` as a verified pass. A3 adds:

- **Fact `artifact_contract`:** `value` = `{artifact_kind, trailer}`; `artifact_kind` in the closed enum
  `handoff_bundle`; `trailer` a printable-ASCII string of 1–128 characters. It attests what the artifact
  pipeline supports, compared by exact string equality with the envelope's `expected.artifact_kind` and
  `expected.trailer`. `expected.branch` is **syntax-checked only** (`[A-Za-z0-9._/-]{1,128}`, no `..`, no
  leading or trailing `/`) and is never compared with evidence.
- **Check `contract.artifact`:** fact missing/`unknown`/`absent` -> `unknown` `artifact_evidence_unknown`;
  known and equal -> `pass`; known and contradicting -> `fail` `artifact_contract_mismatch`, class
  `blocked_dependency` (an existing class; no unauthorized path).
- **Worktree.** `worktree.clean == false` makes `ownership.files` `fail` with code `worktree_dirty` (class
  `blocked_dependency`); `ownership.conflict == true` makes it `fail` `ownership_conflict`; both together list
  both codes (ascending). `worktree` `unknown`/`absent` -> required `ownership.files` is `unknown`
  (`worktree_unknown`) unless a known conflict already makes it `fail`. A dirty tree and another owner's
  conflict are distinct reasons.
- **Limits.** This proves nothing about future commits and does not show the publisher enforces an `Agent`
  trailer (G7 stays open).
- **Alternative A3-alt:** add no artifact/worktree facts; `contract.artifact` stays `unknown` and the worktree
  fact stays outside any verdict until a provider exists. Tradeoff: no invented verified evidence and a
  smaller schema, but feasibility can never be reached for tasks needing those checks (they stay required).

### 13.5 A4 authority decision evidence (PROPOSED)

- **Reason-code vocabulary closed** (no verdict or precedence change): `authority.reference` codes are
  `authority_unverified`, `authority_evidence_mismatch`, `authority_denied`; all other codes in this document
  are the complete set, any new code requires a design edit.
- **Envelope `authority_ref`:** `{kind, id}`; `kind` in `none`\|`operator_decision`; `kind == none` requires `id`
  equal to the literal `none`.
- **Fact `authority_decision`:** `value` = `{kind, id, decision}` with `decision` in `allowed`\|`denied`\|
  `not_required`; "verified" means the snapshot `provenance.verified` is true (a declaration for pure tests).
- **Binding rule:** `allowed`/`denied` apply only if evidence `{kind,id}` equals the envelope ref exactly and
  the ref kind is not `none`; `not_required` applies only if the ref kind **is** `none` and the evidence
  `{kind,id}` is `{none, none}`.

| Envelope ref | Evidence | `authority.reference` |
|---|---|---|
| non-none | verified, bound, `allowed` | `pass` |
| non-none | verified, bound, `denied` | `fail` `authority_denied` (class `unauthorized`) |
| non-none | `not_required`, or unbound `{kind,id}` | `unknown` `authority_evidence_mismatch` |
| `none` | verified `not_required` bound as above | `pass` |
| `none` | `allowed`/`denied` or any mismatch | `unknown` `authority_evidence_mismatch` |
| any | missing/`unknown`/`absent` fact, or provenance unverified | `unknown` `authority_unverified` |

Caller `authority_ref.kind == none` is neither a pass nor a denial; only the verified `not_required` row passes
it. Only a verified explicit denial is `unauthorized`. A2 provenance and A4 evidence are declarations for pure
tests, not runtime grants.

- **Alternative A4-alt:** `none` stays `unknown` (`authority_applicability_unknown`) until an authority
  applicability policy is approved; `not_required` is not a valid decision. Tradeoff: avoids letting any
  injected fact waive authority, but tasks with no authority reference can never be `feasible`.

### 13.6 A5 input error behavior (PROPOSED)

Three layers stay separate: **strict lexical parsing** (`parseStrict`, #169; throws `CanonicalError` with a
closed code), **type/schema validation** (A1/A2/object-set rules, plus clock integer range), and
**evaluation**.

- Malformed raw text, schema, closed-set violation, out-of-range integer (e.g. `captured_at_ms >
  expires_at_ms`, negative values) or a non-integer clock makes the evaluator **throw `FeasibilityInputError`**
  with exactly `{input: envelope|snapshot|clock, code, path}`. `code` is from a closed set (`bad_json`,
  `bad_scalar`, `bad_key`, `duplicate_key`, `forbidden_number`, `unsafe_integer`, `null_value`, `too_deep`,
  `unknown_key`, `missing_key`, `wrong_type`, `bad_value`, `bad_range`, `bad_pattern`, `unsorted_set`,
  `duplicate_identity`, `bad_path_grammar`). `path` is a **fixed schema path template** (for example
  `facts.command_decisions.value.entries.command`; array indices dropped), never an offending value or an
  arbitrary input key. No sentinel ids, digests or report are produced.
- **Valid but stale/wrong-slot/wrong-epoch/untrusted** inputs are not errors: they yield the specified
  `uncertain` report (section 6). Staleness is a fact about well-formed data; malformation is not.
- **`binding.schema`** is `pass` in every returned report (a report exists only after validation). The check
  stays listed to keep a fixed check order; its `schema_invalid` code is unreachable under A5.
- **Alternative A5-alt:** return a sanitized schema-failure report. This needs an explicit, separately designed
  sentinel/binding policy (what `task_id`, digests and slot to carry when none can be trusted, how it avoids
  being mistaken for a bound report); this document does **not** choose one. Tradeoff: callers get a uniform
  return type but must trust or invent identity fields from malformed input.

### 13.7 A6 malformed-report consumption (PROPOSED)

- Malformed **envelope, snapshot or clock** presented to `validate_report_for_consumption` use A5 (throw).
- A **schema-invalid report** returns a `ConsumptionResult` with `valid: false` and exactly eight checks in the
  fixed order: `consume.report_schema` `fail` `report_schema_invalid`, then the remaining seven
  (`report_digest`, `report_expired`, `identity`, `task_digest`, `capability_digest`, `capability_revision`,
  `trust`) each `unknown` `report_not_evaluable`. `reasons` are the eight `check:code` entries in that order.
  No report field is read to produce a digest pass, an identity pass or any output string; no untrusted
  identifier is echoed.
- A **schema-valid** report runs all eight checks as in 6.1. Digest/revision mismatch (`fail`) stays distinct
  from expiry (`stale`). There is no automatic replacement or re-evaluation.
- Non-evaluable is **not** a measured mismatch: no `*_mismatch` code is produced for it.
- **Why not partial evaluation:** fields of a malformed report (digest, ids, expiry) are untrusted structure;
  computing digest or identity checks from them would let attacker-shaped input steer outcomes and echo its text.
- **Alternative A6-alt:** throw a sanitized `FeasibilityInputError` for malformed reports. Explicit change from
  the 6.1 wording (`consume.report_schema` would never be reported as `fail`); callers lose a uniform return
  type and the fixed eight-check output.

### 13.8 Consequential updates if proposals are accepted

- **Snapshot-derived check list** (section 5, fixtures `snapshot_derived_checks`): not a hard-coded eleven.
  Baseline (none accepted): the eleven committed checks. A3 adds `contract.artifact` (twelve); A4 adds
  `authority.reference` (thirteen with A3). Under A4, `authority.reference` with untrusted evidence is
  `unknown` `authority_unverified` (keeps its own code), and with stale evidence `stale` `evidence_stale`.
  With A4 not accepted, its committed behavior (section 5) is unchanged.
- **Invalid-binding expansion** applies to each check in the adopted list, once per check, in place.
- **Per-check evidence dependencies:** `authority.paths` <- `path_policy`, `mandatory_writes`, A1; `authority.commands` <-
  `command_decisions`; `matcher.compat`/`permission.profile` <- `permission_profile`, `command_decisions`;
  `ownership.files` <- `ownership`, plus `worktree` (A3); `contract.artifact` <- `artifact_contract` (A3);
  `authority.reference` <- `authority_decision` (A4); `bounds.explicit` <- `limits`, `mandatory_writes`.
- **Unchanged:** the six verdicts, precedence, required status, and published design vectors A and B (their
  bytes and digests). Fixtures keep their old case ids; proposal cases are new, separate entries.

Related analogues (agents #997/#1032) are not a second DevLoop and add no write scope here; their
excerpts were not needed.
