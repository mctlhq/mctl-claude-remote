# Dispatch feasibility report: design (B1), refs #146

Status: **accepted design contracts, not implemented**. The operator accepted every choice proposed in section
13 (A1–A6 and the object-set rule); they are now the normative **design** of this document. Acceptance of a
design contract is **not** authorization to implement it. The evaluator, the consumption function and schema
validation are **not implemented**; the only merged code is the canonical encoder/strict parser/digest
(`canonical.ts`, #169, see the legend). Nothing here is measured or probed. This document adds no
runtime code, no dispatch/reservation/launch/ack change, and no enforcement. The companion file
[dispatch-feasibility-fixtures-146.json](dispatch-feasibility-fixtures-146.json) holds *illustrative
design expectations* for the accepted contracts; they are not executable feature tests, not a conformance
measurement and not evidence of readiness.

**Residual-contract amendment (docs-only, this PR).** Section 14 closes eleven residual design items (R1–R11)
left open after A1–A6. The operator **accepted the overall approach** of all eleven and made five explicit
choices (matcher attestation as an injected fact; `trusted:false` is `unknown`; no fact-age limit in B1;
closed reason vocabulary; per-reason classification). The **concrete new limits, field tables, ranges,
constants and codes** written in section 14 and threaded through the sections below were **not previously
presented to the operator** and stay **NEW PROPOSED, pending operator review on this PR**; the one review table
is section 14.12. Nothing here is implemented, no runtime work is resumed, and merging this document authorizes none.

**Status legend (read this first).** Five kinds of statement appear in this document and must not be confused:

| Label | Meaning |
|---|---|
| **IMPLEMENTED (#169)** | A fact about merged code: only `plugin/mctl-bridge/src/feasibility/canonical.ts` (MCTL-CJ1 encoder, strict parser, digest). Nothing else (no evaluator, no consumption function, no schema validator) exists. |
| **ACCEPTED DESIGN CONTRACT** | Normative design text: the original design commitments plus A1–A6 and the object-set rule, accepted by the operator (section 13). Design only: nothing here is implemented, and acceptance or merge of this document authorizes no implementation. |
| **NEW PROPOSED (pending operator review)** | A concrete value, limit, field, table, constant or code first written in section 14 (or the sections it amends) whose *approach* the operator accepted but whose *exact value* has not been shown to them. Listed in the review table 14.12. Not an accepted fact and not an invented source fact. |
| **NOT SELECTED (historical alternative)** | An alternative that was proposed and not chosen (listed in section 13 for provenance). It is not a pending default and does not describe behavior. |
| **OPEN / FUTURE APPROVAL** | Decisions that still do not exist: gate G8 (owner decision to start the B1 evaluator implementation, and separately B2), and the unresolved provider/matcher/isolation gates G1–G7. All runtime work is held. |

Index of accepted contracts: A1 path grammar (13.1), A2 closed fact schemas and key-presence semantics (13.2),
object-set rule (13.3), A3 artifact and worktree evidence (13.4), A4 authority evidence (13.5), A5 input error
behavior (13.6), A6 malformed-report consumption (13.7), consequential updates (13.8). Residual contracts R1–R11 (section 14): closed reason vocabulary, identity,
matcher attestation, mixed outcomes, fact age, report/consumption shapes, advisory, formats, revision,
consumption relations, A1 clarifications.

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
| `task_id`, `attempt_id` | string | ids shaped like the store's `t-<uuid>` / `a-<uuid>`; exact formats in 14.9 |
| `slot` | string | `[a-z0-9-]` like the store's slot names; exact format in 14.9 |
| `slot_epoch` | string | canonical decimal string, as the store keeps epochs as strings; exact format in 14.9 |
| `repo` | string | `owner/name`; syntax only, existence is never proven (14.9) |
| `worktree_label` | string | opaque label, never a filesystem path (14.9) |
| `base` | object | `branch`, `base_sha` (40 lowercase hex) |
| `allowed_files` | **set** of strings | repo-relative path patterns: a permission *scope* (what output may touch), never a count of required writes. Pattern grammar: A1 (13.1): exact path, directory prefix `d/`, or terminal `d/**` alias |
| `expected` | object | `artifact_kind`, `branch`, `trailer` (constraints in 13.2/13.4) |
| `required_commands` | **set** of strings | logical command ids (`cmd:...`), not shell text |
| `fixtures` | **set** of strings | logical fixture/test-data ids |
| `dependencies` | array of objects | each `{id, kind, step}`; `step` in `automatic` \| `human` |
| `bounds` | object | verified-intent limits: `max_changed_files`, `max_wall_ms` (integers in `[0, 2^53-1]`, 0 allowed; 14.8) |
| `expires_at_ms` | integer | envelope validity end, `[0, 2^53-1]`; the envelope is usable while `nowMs <= expires_at_ms` (inclusive) |
| `authority_ref` | object | `{kind, id}`; `kind` is `none` (with `id` `none`) when no authority applies; see A4 (13.5) |
| `advisory` | object | `est_changed_files`, `est_minutes` — heuristic integers in `[0, 2^53-1]`, 0 allowed; see sections 8 and 14.8 |

### 3.2 CapabilitySnapshot v1 (future, injected; B1 never collects)

| Key | Notes |
|---|---|
| `schema`, `snapshot_id`, `revision` | `revision` is an integer in `[0, 2^53-1]` (0 allowed, 14.10); monotonic **per source policy**, which one snapshot and a pure function cannot prove; any change in facts changes the digest |
| `slot`, `slot_epoch` | what the snapshot describes |
| `captured_at_ms`, `expires_at_ms` | freshness window; the snapshot is usable iff `captured_at_ms <= nowMs <= expires_at_ms` (14.6); every fact's `observed_ms <= captured_at_ms` |
| `provenance` | `{source_kind, issuer_ref, verified}`; `verified` is a boolean set only by a future trust gate |
| `facts` | one entry per fact id (below); each `{status, value, observed_ms}`, `status` in `known` \| `unknown` \| `absent`. The closed `value` schema per fact, the rule that `value` exists only when `status` is `known`, the key-presence semantics, and the two extra facts `artifact_contract` / `authority_decision` are accepted contracts A2/A3/A4 (13.2, 13.4, 13.5); `facts` therefore has exactly **sixteen** keys after the matcher attestation of 14.4 (fifteen before it) |

Fact ids (the thirteen below plus `artifact_contract` (A3), `authority_decision` (A4) and
`matcher_attestation` (14.4)): `os_identity`, `permission_profile`, `command_decisions` (per required command: `allowed` \|
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
   bytewise UTF-8 with no duplicates; otherwise the input is *rejected* with a `FeasibilityInputError` (A5,
   13.6; no report exists). Arrays of objects with an identity key (`command_decisions.entries`,
   `dependencies.entries`, `fixtures.entries`) follow the accepted object-set rule (13.3). Nothing is
   silently sorted or de-duplicated, and there is no global array sort or dedup. Report `reasons`,
   `checks` and `advisory_codes` are **ordered arrays**, not sets: their order is semantic and defined in
   section 6 (reasons) and section 5 (checks); `advisory_codes` is ascending by bytewise UTF-8 by that
   field's own rule, still without any encoder-side sorting.

   *Implementation fact (#169):* `canonical.ts` takes an optional `setFields` set of object **key names**
   and requires every array under a matching key name, at any depth, to be a strictly ascending string set
   (`unsorted_set` / `wrong_type`). It has no path awareness and no notion of arrays of objects with an
   identity key. The "snapshot fact value sets" wording above is therefore an accepted design contract that
   the current code does **not** implement as path-specific validation. The accepted object-set rule (13.3)
   requires path-specific schema validation outside the encoder; any change to `canonical.ts` or a future
   schema validator requires separate implementation approval (G8).
7. Digest = lowercase-hex SHA-256 over `domain || 0x0A || canonical_bytes`. `domain` is an ASCII string with
   no LF, fixed per object type: `mctl.feasibility/1/task-envelope`, `.../capability-snapshot`,
   `.../report`, `.../test-vector`. The LF frames the domain, so two object types cannot collide.

### Design vectors (not conformance results)

Two byte strings were hashed once with a local `shasum -a 256` while writing this document, to give
implementers a starting reference. They are design vectors, not a cross-language equivalence claim.

Vector A — encoding rules (domain `mctl.feasibility/1/test-vector`, body 37 bytes, input 68 bytes; unchanged by the accepted contracts):

```
{"a":"é\"\u0001","b":[2,1],"c":true}
sha256 = cf21d3e7ed6c38229e8e4158b19a7c8d0bb0352e7c0a225b3c205ebc35ac3fc9
```

(`é` is two UTF-8 bytes `c3 a9`; `b` is an ordered array and keeps `[2,1]`.)

Vector B — a synthetic TaskEnvelope (domain `mctl.feasibility/1/task-envelope`, body 747 bytes, input 780 bytes
= 32-byte domain + LF + body). The follow-up review edits and the acceptance of A1–A6 did not change this
canonical body (the envelope is valid under the accepted schemas); A and B were re-hashed independently from
freshly written byte files and match the values below:

```
{"advisory":{"est_changed_files":2,"est_minutes":20},"allowed_files":["docs/example-146.md"],"attempt_id":"a-00000000-0000-4000-8000-000000000002","authority_ref":{"id":"decision-0001","kind":"operator_decision"},"base":{"base_sha":"0123456789abcdef0123456789abcdef01234567","branch":"main"},"bounds":{"max_changed_files":3,"max_wall_ms":3600000},"dependencies":[],"expected":{"artifact_kind":"handoff_bundle","branch":"docs/example-146","trailer":"Agent: claude"},"expires_at_ms":1790000000000,"fixtures":["fixture:synthetic-a"],"repo":"example-org/example-repo","required_commands":["cmd:git-diff-check"],"schema":"mctl.task-envelope/1","slot":"slot-x","slot_epoch":"7","task_id":"t-00000000-0000-4000-8000-000000000001","worktree_label":"wt-1"}
sha256 = 43e77d4fafa97cc56fe831d1bdcb145468f821b940bdf1519a074157c9527880
```

Unresolved serialization gate: an independent second implementation (another language) must reproduce
vectors A and B and a rejection corpus (duplicate keys, lone surrogates, floats, unsorted sets) before any
claim of cross-language equivalence. Until then none is made. Fixtures in the JSON file use symbolic digest
labels (`digest:env-A`), not real hashes, except where they cite vector B. The accepted-schema snapshot
differs in body from the legacy illustrative snapshot summary, so its digest is symbolic and never claimed
equal to a legacy one.

## 5. Checks

Each check has `id`, `required` (bool), `status` in `pass|fail|unknown|absent|stale`, `reason_codes` (an
ordered array, ascending bytewise by code within the check), `evidence` = a list of `{fact, revision}`
references (never raw values that could be sensitive) and `retained_under_invalid_binding` (bool). The exact
closed field table, the per-check evidence lists and the closed code table (every code with its evidence kind,
status effect and verdict class) are in 14.2 and 14.6a; the rule "check `fail` if any known-failure code, else
`unknown`/`absent`/`stale` if any unavailable code, else `pass`" is in 14.3. Fixed evaluation/output order of the pure
`evaluate(envelope, snapshot, nowMs)`:

**Binding gate** (evaluated first; seven checks, all computable from the two inputs and the clock):
`binding.schema`, `binding.provenance`, `binding.slot`, `binding.epoch`, `binding.capability_fresh`,
`binding.not_expired`, `binding.attempt_unique`.

`binding.attempt_unique` reads `attempts_seen` (R1, 14.1): `known` and containing this `attempt_id` -> `fail`
`attempt_duplicate`; `known` without it -> `pass`; the fact `unknown`/`absent`, **or the snapshot not
individually evaluable** (unverified provenance, other slot/epoch, outside its usability window) -> `unknown`
`attempt_unverified`. An unverified attempt is never a duplicate and never a pass; the check is a binding check
(not in the thirteen-entry expansion) and, being non-pass, makes `binding_valid` false. Under a non-evaluable
snapshot it therefore adds one `binding.attempt_unique:attempt_unverified` entry (class `binding`) after the
other binding entries.

*Role of `binding.schema` (accepted A5, 13.6):* malformed inputs are rejected by throwing a sanitized
`FeasibilityInputError` before any report exists, so `binding.schema` is `pass` in **every returned report**.
The check stays listed to keep a fixed check order; its `schema_invalid` code is unreachable and is never
emitted.

`binding.not_expired` is about the **envelope** `expires_at_ms` only (code `task_expired`).
`binding.capability_fresh` is about the **snapshot** window `captured_at_ms..expires_at_ms` only (code
`capability_stale`), inclusive on both ends: usable iff `captured_at_ms <= nowMs <= expires_at_ms`. A
well-formed snapshot captured in the future of the injected clock is therefore `stale` (unusable), not an input
error (14.6). The two can fail independently or together.

There is deliberately **no** `binding.task_digest` in `evaluate`: it takes no prior report, so there is no
bound digest to compare. Comparing a prior report with a presented task and snapshot is the separate
consumption validation of section 6.1.

**Substantive checks:**
`authority.reference`, `authority.paths`, `authority.commands`, `identity.os`, `permission.profile`,
`matcher.compat`, `repo.base`, `ownership.files`, `contract.artifact`, `dependency.declared`,
`fixtures.data`, `slot.idle`, `bounds.explicit`, and the non-required `estimate.advisory`.

Mapping to verdict classes:

The class belongs to the **reason code**, not to the check (R4, 14.3): every closed code has one fixed class in
the table of 14.2. A check with several codes can therefore carry reasons of different classes. Summary of
which known-failure codes feed each class:

| Class | Known-failure codes (check) |
|---|---|
| unauthorized | `authority_denied` (`authority.reference`); `path_forbidden`, `mandatory_write_outside_allowed` (`authority.paths`); `command_denied` (`authority.commands`) |
| blocked_dependency | `dependency_unmet` (`dependency.declared`); `fixture_unavailable` (`fixtures.data`); `ownership_conflict`, `worktree_dirty` (`ownership.files`); `artifact_contract_mismatch` (`contract.artifact`); `base_moved` (`repo.base`) |
| needs_split | `verified_bound_exceeded` (`bounds.explicit`, a *verified, independent* lower bound of mandatory writes exceeds a bound); `human_step_required` (`dependency.declared`, `step: human`) |
| busy | `slot_busy` (`slot.idle`) |
| uncertain | every unavailable-evidence code of a required check (`unknown`/`absent`/`stale`); any binding failure is class `binding` and forces `uncertain` |

`authority.paths` is evaluated against `path_policy` and `mandatory_writes` from the snapshot (14.3):
an intersection with a `known` policy is a `fail`; unavailable evidence is `unknown` and never a pass. A mandatory write is never allowed to widen
authority: if `mandatory_writes` (known) contains a path not matched by `allowed_files`, `authority.paths`
fails with `mandatory_write_outside_allowed` (unauthorized); `allowed_files` is not extended to cover it.
Unavailable `mandatory_writes` evidence **prevents** a path pass even when the forbidden list is empty
(`authority.paths` `unknown` `mandatory_writes_unknown`, explicitly allowed under this check, 14.1); an
independent known failure stays retained beside it.

**Evidence states under an invalid binding.** Each snapshot-derived check takes one of two non-pass states
when the snapshot cannot be used. The accepted list has exactly **thirteen** members, in check order
(`authority.reference` first, `contract.artifact` after `ownership.files`; also the fixtures'
`meta.snapshot_derived_checks`): `authority.reference`, `authority.paths`, `authority.commands`,
`identity.os`, `permission.profile`, `matcher.compat`, `repo.base`, `ownership.files`, `contract.artifact`,
`dependency.declared`, `fixtures.data`, `slot.idle`, `bounds.explicit`. The seven `binding.*` checks and
`estimate.advisory` are never in it (13.8). The two states carry distinct codes: `unknown` +
`evidence_not_evaluable` when the snapshot is untrusted or is not about this task (provenance unverified,
other slot, other epoch; a schema-invalid snapshot never reaches this point because it is an input error,
A5); `stale` + `evidence_stale` when it is well-formed, verified and for the same slot/epoch but outside its
freshness window. Not-evaluable wins when both apply. Such a check never reports `pass`, never `fail`, so
wrong-slot, wrong-epoch, stale or untrusted evidence can never remain a pass or pose as a proven denial.
**Special case `authority.reference`:** when provenance is unverified it is `unknown` +
`authority_unverified` (its own code, which wins over `evidence_not_evaluable`); with verified provenance and
another slot/epoch it is `unknown` + `evidence_not_evaluable`; well-formed, verified, same slot/epoch but
outside the window it is `stale` + `evidence_stale`. These expansion entries are produced **once per check, in
place**: an explicit reason for the same check (for example `authority.commands:evidence_stale` or
`authority.reference:authority_unverified`) *is* that check's entry and is not repeated.

## 6. Verdict, precedence, binding validity

Verdicts are exactly: `feasible | busy | needs_split | blocked_dependency | unauthorized | uncertain`.
Binding validation is an evaluation **gate**, not a seventh verdict.

1. **Binding.** `binding_valid` is true only if all seven binding checks `pass`.
2. **If `binding_valid` is false:** verdict is `uncertain`, `binding_valid=false`, and binding reason codes
   list the failed binding checks (`slot_mismatch`, `epoch_stale`, `capability_stale`, `task_expired`,
   `attempt_duplicate`, `attempt_unverified`, `provenance_unverified`; `schema_invalid` is unreachable under A5 and never emitted).
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
   - a known-failure class applies if **any known-failure reason of that class** exists in any check (R4,
     14.3), not merely if some check of that class is `fail`: the verdict uses **all** known-failure classes
     present and takes the highest by this precedence, never the first code listed nor an arbitrary check's
     class. `uncertain` applies if any *required* check is `unknown`/`absent`/`stale`;
   - **Same check, two fail classes** (for example `dependency.declared` with an unmet automatic dependency
     *and* a `human` step): the check is `fail`, both reasons are retained with their own classes, and the
     verdict is the higher class by precedence (`blocked_dependency` over `needs_split`). A human step needs a
     split (`needs_split`), an unmet automatic dependency is `blocked_dependency`, a known denial is
     `unauthorized`; none hides another;
   - a known failure **and** an unavailable-evidence reason in one check are both retained: the check is `fail`
     (known failure wins the status) and the unavailable reason keeps class `uncertain` in `reasons`;
   - `feasible` only if **every required check is `pass`** and binding is valid.
4. **All findings are retained, in an ordered `reasons` array** (an *ordered array*, never a set, section 4).
   Each entry is the string `check_id:code`, one per (check, code) with a non-pass status, including the
   `stale`/`unknown` entries of non-evaluable checks. The order is total and fully specified by this sort
   key, compared left to right:
   1. **class rank**: `binding` (0) first, then `unauthorized` (1), `blocked_dependency` (2), `needs_split`
      (3), `busy` (4), `uncertain` (5). A reason's class is the fixed class of its **code** in the closed table
      of 14.2 (each code has exactly one class; there is no dependence on the check status); every `binding.*`
      entry is class `binding`;
   2. **check order**: the index in the fixed section 5 list (`check_order` in the fixtures);
   3. **code**: ascending bytewise UTF-8 of the reason code.
   **Per-reason class (A3 for `ownership.files`, generalized by R4, 14.3):** the A3 acceptance classed each
   `ownership.files` reason on its own (`ownership_conflict`, `worktree_dirty` = `blocked_dependency`;
   `ownership_unknown`, `worktree_unknown` = `uncertain`) although the check status can be `fail`. The same
   per-reason classification now applies to every check with mixed outcomes (`dependency.declared`,
   `authority.commands`, `authority.paths`, `bounds.explicit` and the rest): each closed code carries its own
   class and evidence kind (14.2), the check status is `fail` if any of its reasons is a known failure, else
   `unknown`/`absent`/`stale` if any is unavailable, else `pass`.
   There is no other sort and no deduplication: the key is a total order on distinct (check, code) pairs, and
   each pair appears at most once. The order is *not* ascending by the whole string, so a `busy` verdict
   still lists `slot.idle:slot_busy` before `identity.os:identity_os_unknown`; the verdict is the highest
   class, not the only finding. Retained-under-invalid-binding entries follow the same key (they fall into
   their class after all `binding` entries).

An **unusable snapshot can never deny**: when the snapshot is not individually evaluable (unverified, other
slot/epoch, outside its window), none of the 13 checks reads it (they are `unknown`/`stale`, section 5), so no
reason from it can be a known failure. Known failures can be *retained* under an invalid binding only from
an individually evaluable snapshot (for example a duplicate attempt with fresh verified evidence); the verdict
is still `uncertain` (G5) and the report authorizes nothing.

Required checks (everything except `estimate.advisory`): trusted identity (`identity.os`, trusted `true`; a
present `trusted: false` is `unknown`, R2, 14.5), permission
profile (`permission.profile`), `matcher.compat` (needs a bound matcher attestation, 14.4), repo/base (`repo.base`), artifact/commit contract
(`contract.artifact`), ownership (`ownership.files`), capability freshness (`binding.capability_fresh`),
plus all others above. A missing OS identity, permission profile or base can produce at best `uncertain`.

### FeasibilityReport v1 shape

`schema` (`mctl.feasibility-report/1`), `task_digest`, `capability_digest`, `capability_revision` (the
snapshot's `revision`), `task_id`, `attempt_id`, `slot`, `slot_epoch`,
`evaluated_at_ms` (the **injected** clock value; the function never reads time), `expires_at_ms`
(= min of envelope and snapshot expiry; it may be earlier than `evaluated_at_ms` when an input is already expired, and that is a valid report, not an input error), `binding_valid`, `verdict`, `checks[]` (ordered, section 5),
`reasons[]` (ordered, rule in item 4), `advisory` (section 8), `non_claims` (constant list:
`not_authorization`, `not_reservation`, `not_os_isolation`, `not_toctou_closure`), and `report_digest`
(domain `.../report`, over the canonical bytes of every other field; the field itself is excluded, see 6.1).
Output is MCTL-CJ1 bytes; identical inputs give byte-identical output. **The closed field table of every
member, with types, requiredness and constants, is 14.6b (NEW PROPOSED); this paragraph is its summary.**

### 6.1 Report consumption validation (separate contract)

`evaluate(envelope, snapshot, nowMs)` is pure over those three inputs and has no old report. A consumer that
holds a *prior* report and later wants to know whether it still describes the inputs in front of it calls a
second pure function:

`validate_report_for_consumption(report, envelope, snapshot, nowMs)` → `ConsumptionResult`
`{schema, valid, checks[], reasons[]}` (closed shape in 14.7), `valid` true only if every check passes. Same
encoding, same privacy rules, same ordered-`reasons` rule (class `consumption` sorts first, then check order,
then code). It never re-runs `evaluate`, never re-derives the verdict from the envelope and snapshot, and
**never authorizes**: `valid: true` means only "the presented report is structurally well-formed and locally
self-consistent (14.7), its digest matches its own bytes, its bound identity, task digest, capability digest
and revision equal the presented ones, the presented snapshot claims verified provenance, and the report has
not expired". It does **not** mean the evaluator computed the report faithfully, that the report is authentic,
that anyone has permission, or that TOCTOU is closed (a digest proves byte integrity only, never who produced
the bytes). Its checks, in order:

| Check | Pass condition | Non-pass |
|---|---|---|
| `consume.report_schema` | report parses under MCTL-CJ1, closed schema and the local relations of 14.7 hold (structure, enums, formats, constants, check identities/order/required flags, local times) | `fail` `report_schema_invalid`; the other seven checks are then fixed to `unknown` `report_not_evaluable` (accepted A6, 13.7) |
| `consume.report_digest` | recompute the digest over the report's canonical bytes **with the `report_digest` member removed** (self-field exclusion) under domain `.../report`; equals the stored value | `fail` `report_digest_mismatch` |
| `consume.report_expired` | `nowMs <= report.expires_at_ms` | `stale` `report_expired` |
| `consume.identity` | report `task_id`, `attempt_id`, `slot`, `slot_epoch` equal the presented envelope's | `fail` `identity_mismatch` |
| `consume.task_digest` | digest of the presented envelope (domain `.../task-envelope`) equals `report.task_digest` | `fail` `task_digest_mismatch` |
| `consume.capability_digest` | digest of the presented snapshot (domain `.../capability-snapshot`) equals `report.capability_digest` | `fail` `capability_digest_mismatch` |
| `consume.capability_revision` | presented snapshot `revision` equals `report.capability_revision` | `fail` `capability_revision_mismatch` |
| `consume.trust` | presented snapshot `provenance.verified` is true (the same trust gate as `binding.provenance`); a digest match does not substitute. A malformed presented envelope/snapshot/clock is not a check result: it throws `FeasibilityInputError` (A5/A6) | `unknown` `provenance_unverified` |

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
  Any identifier failing its pattern is **not** echoed: under accepted A5 the evaluator throws a closed,
  sanitized `FeasibilityInputError` (fixed code and schema-path template only) and no report exists (13.6).
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
(`mandatory_writes_unknown` / `limits_unknown`), not `fail`; a known failure (`verified_bound_exceeded` from
the envelope's own bound needs only `mandatory_writes` known) stays retained beside such a code (14.3).
The advisory object shape, the exact `estimate_exceeds_bound` and `wall_budget_exceeds_runner_limit` conditions,
BigInt comparison and input ranges are in 14.8. Using required writes never broadens authority:
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
| G1 | Snapshot collector (provider): who builds it, what it may read. Unresolved. |
| G2 | Authentication/trust of snapshots and authority references (`provenance.verified`, `authority.reference`). |
| G3 | Freshness policy (window lengths, clock source). **Remains open**: B1 imposes no maximum fact age and no host time (14.6). |
| G4 | A matcher-faithful command decision source and the real provider of the matcher attestation; until then `matcher.compat` is `unknown`. No real-machine PASS is claimed (14.4). |
| G5 | Whether a trusted fresh denial surfaces as `unauthorized` under an unrelated invalid binding. |
| G6 | Cross-language equivalence of MCTL-CJ1 (second implementation, rejection corpus). |
| G7 | Where the declared `Agent: claude` trailer expectation is verified. The publisher (`publish.ts`) is in this repo but validates actual commits only after the fact and today refuses `Co-Authored-By` lines, not a missing `Agent:` trailer; whether and where a presence check belongs, and what pre-dispatch fact would carry it, is undecided. |
| G8 | Owner decision to proceed to B1 implementation (evaluator, consumption function, schema validator, fixtures-as-tests), and separately to B2. **Not started and not given**: G9 acceptance and the merge of this document do not authorize it. B2 stays separately gated (section 11). |
| G9 | **RESOLVED (design only).** The operator accepted every proposed choice in section 13 (A1–A6 and the object-set rule); the stated alternatives were not selected. This resolves design contracts only; it implies nothing about G1–G8. |

## 13. ACCEPTED design contracts (A1–A6 and object-set rule)

**Decision provenance.** These contracts were first written as proposals in PR #170 (refs #146), each with a
concrete alternative. The operator then explicitly accepted **all** proposed choices, relayed through the
bridge task of this follow-up (2026-11-09): A1 exact/`dir/`/terminal-`/**` grammar and intersection table; A2
closed fact schemas with a missing-key input error; object sets ascending UTF-8 with unique identity; A3
artifact/worktree evidence including per-reason `ownership.files` classes; A4 bound authority decision
including verified `not_required` for `none`; A5 sanitized `FeasibilityInputError`; A6 fixed malformed-report
output (`valid=false`, schema `fail`, seven `unknown`). G9 is resolved by that acceptance.

**What acceptance means and does not mean.** Everything in this section is now the **ACCEPTED DESIGN
CONTRACT**: it is normative for the design and for the fixtures' illustrative expectations. It is **not
implemented** and acceptance (or merging this document) is **not** authorization to implement the evaluator,
the consumption function, the schema validator or any collector: gate G8 stays separate and not started, B2
stays separately gated, and the provider, matcher-faithful decision source, authentication/freshness and
isolation gates (G1–G4, G6, G7, #106/#108) remain unresolved. All facts and evidence below are **injected
synthetic claims for pure tests**, not runtime grants. The six verdicts and their precedence are unchanged;
no seventh verdict exists. Illustrative cases live in the fixtures file under `proposals` (the key name is
kept only for traceability; their status is ACCEPTED DESIGN, not implemented, no conformance measurement).

Each subsection ends with the alternative that was **not selected**. These are historical provenance only,
not pending defaults, and nothing elsewhere in this document depends on them.

| ID | Subject | Section | Not-selected alternative, in one line |
|---|---|---|---|
| A1 | Path/scope grammar and matching | 13.1 | exact/directory-only without `/**` (alt-1), or `unknown` for unsupported patterns (alt-2) |
| A2 | Closed fact value schemas and key presence | 13.2 | defer shapes: only envelope statuses plus opaque digests |
| OS | Object-set ordering/uniqueness | 13.3 | defer; ordered arrays plus explicit uniqueness check |
| A3 | Artifact contract and worktree evidence | 13.4 | leave capability `unknown` until a provider exists; or per-check-status class rule |
| A4 | Authority decision evidence | 13.5 | `none` stays `unknown` until an applicability policy is approved |
| A5 | Malformed input behavior | 13.6 | sanitized schema-failure report with a separately designed sentinel policy |
| A6 | Malformed report consumption | 13.7 | throw a sanitized error instead of returning a result |

### 13.1 A1 path grammar (ACCEPTED)

Applies to `allowed_files`, `path_policy.forbidden`, and `mandatory_writes`.

- **Grammar, in this order.** (1) *Alias step:* if the final segment of the pattern is exactly `**`
  (pattern ends in `/**` and has at least one segment before it), remove that `/**` and treat the rest as a
  directory prefix `d/`. This happens **before** step 2, so the `*` ban below never sees the alias. Any other
  `*` (including `**` not final, `***`, a bare `**`) is left in place for step 2 to reject. (2) *Segment
  grammar:* what remains is exactly one of an *exact path* (repo-relative, no trailing `/`) or a *directory
  prefix* ending in `/`. Segments are separated by `/`, are non-empty, are not `.` or `..`, contain no `\`, no
  `*`, `?`, `[`, `{`, no NUL/control characters, and the whole pattern does not start with `/` or a drive
  prefix. `mandatory_writes` entries and the paths being tested are exact paths only.
- **Normal form.** After the alias step every pattern is a pair (kind, segs): kind is `exact` or `dir`, segs is
  the non-empty list of its segments (`a/b/` and `a/b/**` are both (`dir`, [a, b]); `a/b` is (`exact`,
  [a, b])). Everything below works on this pair only.
- **Rejection.** Anything else (absolute path, traversal, dot or empty segment, backslash, any other glob) is an
  **input error** (13.6), never a permission result. Invalid grammar is not `fail` and not `pass`.
  **Clarifications (R11, 14.11):** the **empty pattern** is rejected (`bad_path_grammar`; non-empty segments
  were already required); a **leading ASCII drive prefix** is rejected, tested as `^[A-Za-z]:` on the **raw
  pattern start before the alias step** (so `C:`, `C:/x`, `C:relative`, `c:x` and `C:/**` are rejected). A
  colon anywhere else is **not** forbidden by this grammar (`docs/a:b` is a valid exact path; `ab:c` is valid
  because its colon is not at index 1); a ban on every colon is a narrower, not-approved alternative. The alias
  `/**` is recognized first and the exact-leaf intersection table above is unchanged.
- **Membership.** An exact path matches only itself. A directory prefix `d/` matches a path whose segments
  have `d`'s segments as a **proper** prefix (the path has at least one more segment). So `a/` matches `a/b`
  but **not** the exact path `a`, and `a/` does not match `ab/x` (segment boundary: `docs/` does not match
  `docs-x/a`). Matching is bytewise on UTF-8 with no normalization or case folding.
- **Scope intersection** (used by `authority.paths`, `ownership.files`). Two patterns intersect iff some path
  is a member of both. In normal form, for P = (kP, sP) and Q = (kQ, sQ), with "proper prefix" meaning
  strictly shorter and equal on the leading segments:

  | P kind | Q kind | P and Q intersect iff |
  |---|---|---|
  | exact | exact | sP equals sQ |
  | exact | dir | sQ is a **proper** prefix of sP (the exact path lies inside the directory) |
  | dir | exact | sP is a **proper** prefix of sQ (mirror of the row above) |
  | dir | dir | sP is a prefix of sQ **or** sQ is a prefix of sP (equal counts) |

  The relation is symmetric by construction: swapping P and Q swaps the two mixed rows and leaves the others
  unchanged, so a result never depends on argument order. An exact path is a **leaf**, never a prefix of
  anything: exact `a` does not intersect exact `a/b`, and exact `a` and directory `a/` are **disjoint**
  (equal segments, but `a/` contains only paths below `a`, not `a` itself). A generic "one segment sequence is
  a prefix of the other" reading is **not** the rule and must not override the leaf semantics above.
  Examples (each also checked in reverse order, same result; see fixtures `proposals.a1_path_grammar.intersection`):

  | P | Q | intersect | why |
  |---|---|---|---|
  | exact `a/b` | exact `a/b` | yes | equal exact paths |
  | exact `a/b` | exact `a/c` | no | different leaves |
  | exact `a` | exact `a/b` | no | `a` is a leaf, not a prefix of `a/b` |
  | exact `a` | dir `a/` | no | equal segments: `a/` excludes `a` itself |
  | exact `a/b` | dir `a/` | yes | `a/b` is a member of `a/` |
  | dir `a/` | dir `a/` (or `a/**`) | yes | equal directories |
  | dir `a/` | dir `a/b/` | yes | ancestor contains descendant |
  | dir `a/` | dir `ab/` | no | segment boundary |
  | exact `ab` | dir `a/` | no | segment boundary |

  `authority.paths` fails `path_forbidden` iff some `allowed_files` pattern intersects some
  `path_policy.forbidden` pattern; the accepted example (`allowed: docs/`, `forbidden: docs/secret/`) is the
  dir/dir row. The scope is then not usable as a whole. (Not narrowing: B1 never computes a reduced
  allowlist.)
- **Non-goal.** No emulation of Claude Code's proprietary command matcher; this grammar covers repo paths only.
- **Not selected, A1-alt-1 (narrower):** drop `dir/**`; only exact paths and `dir/` prefixes (mirrors the
  publisher's `allowed()`, `publish.ts:281`). Tradeoff: fewer spellings, no alias ambiguity, but task authors
  used to `**` get an input error.
- **Not selected, A1-alt-2 (defer):** grammar is not defined; any pattern beyond exact paths makes
  `authority.paths` `unknown` (`path_pattern_unsupported`). Fail-closed consequence: every directory-scoped
  task is at best `uncertain`. The code `path_pattern_unsupported` is therefore **not** part of the accepted
  reason-code set.

### 13.2 A2 closed fact schemas (ACCEPTED)

Each `facts.<id>` is exactly `{status, observed_ms}` plus `value` **only when `status` is `known`**. For
`unknown`/`absent`, `value` must be missing (present value is an input error). `observed_ms` is a required
integer in `[0, 2^53-1]` and, in addition, `observed_ms <= captured_at_ms` of the snapshot (14.6; a violation
is `bad_range`, path `facts.<id>.observed_ms`). `facts` has exactly the **sixteen** keys below (the thirteen original facts plus
`artifact_contract` (A3), `authority_decision` (A4) and `matcher_attestation` (R3, 14.4; NEW PROPOSED, adds the
sixteenth key to the previously accepted fifteen)).

**Missing key versus unknown status (three distinct situations, never conflated):**

1. **Fact KEY missing from `facts`** (or an unknown fact key present): the snapshot is malformed, an input
   error under A5 (`missing_key` / `unknown_key`, path `facts.<id>`). No report exists. The evaluator does not
   normalize an omitted fact into `unknown`, and never invents a timestamp, digest or value for it. (The
   fixed path template drops the offending key for `unknown_key`; for `missing_key` the id is the schema's own
   fixed key, never input text.)
2. **Key present with `status` `unknown` or `absent` and no `value`:** well-formed *evidence-unavailable*
   data. The dependent checks are `unknown` with their existing unavailable-evidence codes (A3/A4/section 5).
3. **Key present, `status` `known`, but a required command/dependency/fixture ENTRY missing inside the value**
   (13.2 "Missing semantics" below): the check is `unknown`, not an input error.

Value objects are closed (exact keys, no extras):

| Fact | `value` (exact) | Constraints |
|---|---|---|
| `os_identity` | `{trusted: bool}` | `trusted: false` is well-formed and means `unknown` identity (R2, 14.5), never a schema error |
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
| `artifact_contract` (A3, 13.4) | `{artifact_kind, trailer}` | `artifact_kind` string in the closed enum `handoff_bundle`; `trailer` string of 1-128 printable ASCII characters (U+0020..U+007E) |
| `authority_decision` (A4, 13.5) | `{kind, id, decision}` | `kind` string in `none`\|`operator_decision`; `id` string `[a-z0-9:._-]{1,64}`, and `id` is the literal `none` when `kind` is `none`; `decision` string in `allowed`\|`denied`\|`not_required` |
| `matcher_attestation` (R3, 14.4; NEW PROPOSED) | `{profile_digest, matcher_revision, compatible}` | `profile_digest` 64 lowercase hex; `matcher_revision` string `[a-z0-9._/-]{1,64}`; `compatible` bool |

The envelope's `expected.artifact_kind` uses the same enum and `expected.trailer` the same character rule;
`authority_ref.kind` / `authority_ref.id` use the same `kind` enum and `id` pattern (`kind` `none` requires
`id` `none`). `expected.branch` is syntax-checked only (13.4). All of these constraints are accepted contracts (A2/A3/A4);
a violation is an input error (A5, `bad_value`/`bad_pattern`), never a check result.

Missing semantics (situation 3 above, inside a **known** fact only): a required command with **no** entry in `command_decisions`, a declared dependency with no
`dependencies` entry, or a required fixture with no `fixtures` entry is `unknown` (never an implicit pass,
never implicit denial), with codes `command_decision_unknown`, `dependency_unknown` and
`fixture_unknown`. An entry whose id is not required by the envelope is ignored for verdicts but still
schema-checked. These are claims injected for tests; the schemas give them shape, not trust.

- **Not selected, A2-alt (narrower/deferred):** define no per-fact value schema yet. Facts carry only
  `{status, observed_ms}` plus an opaque `value_digest`; checks beyond `unknown` cannot be computed, so every
  fact-dependent check is `unknown` until value shapes are approved. Tradeoff: nothing wrongly shaped is
  frozen, but the evaluator can never return anything but `uncertain` (or binding-driven results). A2-alt is
  a different, deferred policy that did not adopt the key-presence rule above. It was not selected; the
  accepted rule is that an omitted fact key is an input error, and nothing normalizes omitted facts into
  invented timestamps or digests.

### 13.3 Object-set ordering and uniqueness (ACCEPTED, tied to A2)

- The encoder **preserves supplied array order** and never sorts or de-duplicates (as in section 4).
- A **schema validator** (not the encoder) checks, per explicit schema path, that an array of objects is
  strictly ascending and unique by UTF-8 identity key: `command_decisions.entries` by `command`;
  `dependencies.entries` and `fixtures.entries` by `id`. Two members with the same identity are rejected even
  when their other fields differ (`duplicate_identity`); an out-of-order list is `unsorted_set`. Order is
  bytewise UTF-8 over identifiers that already satisfy their 13.2 grammar: `cmd:a` < `cmd:z`, and a shorter
  prefix sorts first (`cmd:a` < `cmd:a-b`). The command grammar stays lowercase (`cmd:[a-z0-9._-]{1,64}`), so
  uppercase is never an ordering example: `cmd:Z` is a **grammar** error (`bad_pattern`), not a valid member
  that merely sorts early. Ordering and grammar are separate failures with separate fixtures.
- It is path- and schema-specific, never global property-name matching. Ordinary ordered arrays stay ordered;
  `TaskEnvelope.dependencies` (array of `{id,kind,step}`) **stays an ordered array**: its reclassification as
  an object-set is not part of the accepted rule and would need a separate proposal.
- *Implementation fact:* `canonical.ts`'s `setFields` (key-name, string-set) does **not** implement this.
  Implementing it needs a separate, approved change (G8).
- **Not selected, OS-alt (defer):** no object-set schema. Entry arrays stay ordered arrays; evaluator-side
  explicit uniqueness validation rejects duplicate ids but accepts any order. Tradeoff: two producers can
  emit the same abstract entry set in different orders, giving different bytes and therefore different
  capability digests (equal abstract sets, unequal digests), so producers must emit a stable order by
  convention. Scope: this affects **object-entry** arrays only. `unsorted_set` stays valid for **string** sets
  (`attempts_seen.ids`, `path_policy.forbidden`, `mandatory_writes.paths`, envelope string sets) under OS-alt
  too; only the object-entry (`command`/`id` keyed) ordering check, and its `unsorted_set` use, disappears.

### 13.4 A3 artifact contract and worktree evidence (ACCEPTED)

The original design already forbids treating the envelope's `expected.trailer` as a verified pass. A3 adds:

- **Fact `artifact_contract`:** `value` = `{artifact_kind, trailer}`; exact value types and constraints are in
  the 13.2 table (`artifact_kind` in the closed enum `handoff_bundle`; `trailer` printable ASCII U+0020..U+007E,
  1-128 characters). It attests what the artifact
  pipeline supports, compared by exact string equality with the envelope's `expected.artifact_kind` and
  `expected.trailer`. `expected.branch` is **syntax-checked only** (`[A-Za-z0-9._/-]{1,128}`, no `..`, no
  leading or trailing `/`) and is never compared with evidence.
- **Check `contract.artifact`:** fact key present with status `unknown`/`absent` (no value) -> `unknown`
  `artifact_evidence_unknown`; known and equal -> `pass`; known and contradicting -> `fail`
  `artifact_contract_mismatch`, class `blocked_dependency` (an existing class; no unauthorized path). A fact
  **key missing** from `facts` is not a check outcome: it is a snapshot input error (A2/A5, 13.2 situation 1).
- **Accepted reason codes (A3):** `artifact_evidence_unknown`, `artifact_contract_mismatch`,
  `worktree_dirty`, `worktree_unknown`, `ownership_unknown`.
- **`ownership.files` from two facts (`ownership` and `worktree`), fully specified.** Per fact, evidence is
  *known failure* (`worktree.clean == false`; `ownership.conflict == true`), *known ok*
  (`clean == true`; `conflict == false`) or *unavailable* (status `unknown` or `absent`; both map to the same
  `*_unknown` code and neither is a pass). Key-missing is an input error, not unavailable (13.2).
  - any known failure -> check status `fail`, class `blocked_dependency` (the check status is fixed to `fail`
    whatever the other fact says);
  - else any unavailable -> check status `unknown`;
  - else (both known ok) -> `pass`.
  - Reason codes: `worktree_dirty`, `ownership_conflict` (known failures); `worktree_unknown`,
    `ownership_unknown` (unavailable). Every applicable code is retained, in the check's `reason_codes`
    ascending bytewise; a known failure never hides unavailable evidence, and unavailable evidence never
    softens a known failure. A dirty tree and another owner's conflict are distinct reasons.
  - **Per-reason class (ACCEPTED, the stated exception to the check-level rule).** The general rule
    (section 6 item 4) classes a reason by its check's status, which would label an unavailable-evidence reason
    of a `fail` check as `blocked_dependency`. Accepted instead: for `ownership.files` each reason carries its own class:
    `worktree_dirty`/`ownership_conflict` -> `blocked_dependency`; `worktree_unknown`/`ownership_unknown` ->
    `uncertain`, **even though the check status is `fail`**. The `reasons[]` sort key is unchanged (class
    rank, check order, code), so the known failure precedes the unavailable one. The verdict is still the
    highest class (`blocked_dependency`), and the unavailable reason is retained in `reasons[]`. The
    verdict-class rule "uncertain if a required check is `unknown`/`absent`/`stale`" is untouched (a `fail`
    check does not trigger it; the `uncertain` class affects only the order of its reason).
  - Illustrative cases of the accepted contract (not implemented; fixtures `proposals.a3_artifact_and_worktree`):

    | worktree | ownership | check | `reasons[]` in order | verdict |
    |---|---|---|---|---|
    | clean | no conflict | `pass` | (none) | feasible if all else passes |
    | clean | unknown | `unknown` | `ownership.files:ownership_unknown` | uncertain |
    | unknown | no conflict | `unknown` | `ownership.files:worktree_unknown` | uncertain |
    | unknown | unknown | `unknown` | `ownership.files:ownership_unknown`, `ownership.files:worktree_unknown` | uncertain |
    | dirty | unknown | `fail` | `ownership.files:worktree_dirty` (blocked_dependency), `ownership.files:ownership_unknown` (uncertain) | blocked_dependency |
    | unknown | conflict | `fail` | `ownership.files:ownership_conflict` (blocked_dependency), `ownership.files:worktree_unknown` (uncertain) | blocked_dependency |
    | dirty | conflict | `fail` | `ownership.files:ownership_conflict`, `ownership.files:worktree_dirty` (both blocked_dependency, by code) | blocked_dependency |

    (Both-unavailable lists `ownership_unknown` before `worktree_unknown`: same class, code ascending.)
  - **Not selected, A3-alt-owner (keep the class rule strictly per check status):** the check is still `fail`
    with all applicable codes, but every reason of a `fail` check takes the check's class
    (`blocked_dependency`), so unavailable-evidence reasons rank with the failures and are ordered only by
    code (dirty+unknown: `ownership_unknown`, `worktree_dirty`; conflict+unknown: `ownership_conflict`,
    `worktree_unknown`). Tradeoff: no change to section 6 item 4, but an unavailable-evidence reason is
    labeled as a dependency block, blurring "known failure" and "could not evaluate". Another variant
    (rejected as lossy, listed for completeness): list only the known-failure reasons and drop the
    unavailable ones, which hides missing evidence.
- **Limits.** This proves nothing about future commits and does not show the publisher enforces an `Agent`
  trailer (G7 stays open).
- **Not selected, A3-alt:** add no artifact/worktree facts; `contract.artifact` stays `unknown` and the worktree
  fact stays outside any verdict until a provider exists. Tradeoff: no invented verified evidence and a
  smaller schema, but feasibility can never be reached for tasks needing those checks (they stay required).

### 13.5 A4 authority decision evidence (ACCEPTED)

- **Reason-code vocabulary closed** (no verdict or precedence change): `authority.reference` codes are
  `authority_unverified`, `authority_evidence_mismatch`, `authority_denied`; all other codes in this document
  are the complete set, any new code requires a design edit.
- **Envelope `authority_ref`:** `{kind, id}`; `kind` in `none`\|`operator_decision`; `kind == none` requires `id`
  equal to the literal `none`; `id` otherwise matches `[a-z0-9:._-]{1,64}` (13.2).
- **Fact `authority_decision`:** `value` = `{kind, id, decision}`, exact types in the 13.2 table, with
  `decision` in `allowed`\|`denied`\|`not_required`; "verified" means the snapshot `provenance.verified` is true (a declaration for pure tests).
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
| any | `authority_decision` key present with status `unknown`/`absent` (no value), or provenance unverified | `unknown` `authority_unverified` |
| any | `authority_decision` key **missing** from `facts` | not a check row: snapshot input error (A2/A5, `missing_key`, path `facts.authority_decision`) |

Caller `authority_ref.kind == none` is neither a pass nor a denial; only the verified `not_required` row passes
it. Only a verified explicit denial is `unauthorized`. A2 provenance and A4 evidence are declarations for pure
tests, not runtime grants.

- **Not selected, A4-alt:** `none` stays `unknown` (`authority_applicability_unknown`) until an authority
  applicability policy is approved; `not_required` is not a valid decision. Tradeoff: avoids letting any
  injected fact waive authority, but tasks with no authority reference can never be `feasible`.

### 13.6 A5 input error behavior (ACCEPTED)

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
- **Not selected, A5-alt:** return a sanitized schema-failure report. This would need an explicit, separately
  designed sentinel/binding policy (what `task_id`, digests and slot to carry when none can be trusted, how it
  avoids being mistaken for a bound report); none exists. Tradeoff: callers get a uniform
  return type but must trust or invent identity fields from malformed input.

### 13.7 A6 malformed-report consumption (ACCEPTED)

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
- **Not selected, A6-alt:** throw a sanitized `FeasibilityInputError` for malformed reports
  (`consume.report_schema` would never be reported as `fail`; callers would lose a uniform return type and the
  fixed eight-check output).
- The code `report_not_evaluable` is accepted for the seven fixed `unknown` checks, and is distinct from every
  `*_mismatch` code (measured different inputs) and from `report_expired` (time passed).

### 13.8 Consequential updates (ACCEPTED; applied throughout this document)

- **Exact snapshot-derived list: thirteen**, in check order (section 5, fixtures
  `meta.snapshot_derived_checks`): `authority.reference`, `authority.paths`, `authority.commands`,
  `identity.os`, `permission.profile`, `matcher.compat`, `repo.base`, `ownership.files`, `contract.artifact`,
  `dependency.declared`, `fixtures.data`, `slot.idle`, `bounds.explicit`. History for provenance: the
  pre-acceptance list had eleven entries (these thirteen minus `authority.reference` and `contract.artifact`,
  audited entry by entry); A4 added `authority.reference` first and A3 added `contract.artifact` after
  `ownership.files`. Never in the list: the seven `binding.*` checks (computed from the inputs and clock) and
  `estimate.advisory` (envelope only, not required). The required checks are every check in the fixed list
  except `estimate.advisory`.
- **`authority.reference` when the snapshot cannot be used:** provenance unverified -> `unknown`
  `authority_unverified` (its own code, wins over `evidence_not_evaluable`); other slot/epoch with verified
  provenance -> `unknown` `evidence_not_evaluable`; well-formed, verified, same slot/epoch but outside the
  window -> `stale` `evidence_stale`. `contract.artifact` uses the generic codes (`evidence_not_evaluable`,
  `evidence_stale`). A schema-invalid snapshot is not an expansion case: it is an input error (A5).
- **Invalid-binding expansion** applies to each of the thirteen, once per check, in place: an explicit reason
  for the same check (for example `authority.reference:authority_unverified`) is that check's entry and is not
  repeated, so no finding is duplicated. Wrong-slot/untrusted/wrong-epoch/stale evidence is never `pass` and
  never a proven denial. Full expected arrays are in the fixtures (legacy case ids carry the 13-entry
  expansion; `proposals.snapshot_derived_expansion` gives the accepted-baseline examples).
- **Report/consumption distinctions** (consumed inputs): `evaluate` consumes (envelope, snapshot, `nowMs`);
  `validate_report_for_consumption` additionally consumes a prior report. Digest mismatch, revision mismatch
  (both `fail`, different inputs), expiry (`stale`, time passed), untrusted provenance (`unknown`) and
  `report_not_evaluable` (`unknown`, malformed report) are separate outcomes with separate codes.
- **Closed reason-code set** (every code that appears in this document and the fixtures; a new code requires a
  design edit). Binding: `slot_mismatch`, `epoch_stale`, `capability_stale`, `task_expired`,
  `attempt_duplicate`, `provenance_unverified` (`schema_invalid` reserved, unreachable). Generic expansion:
  `evidence_not_evaluable`, `evidence_stale`. Per check: `authority.reference`: `authority_unverified`,
  `authority_evidence_mismatch`, `authority_denied`; `authority.paths`: `path_forbidden`,
  `mandatory_write_outside_allowed`; `authority.commands`: `command_denied`, `command_decision_unknown`;
  `identity.os`: `identity_os_unknown`, `identity_os_absent`; `permission.profile`: `permission_profile_absent`,
  `permission_profile_unknown` (R1);
  `matcher.compat`: `matcher_unverified`, `matcher_attestation_mismatch` (R3); `repo.base`: `base_moved`, `repo_base_unknown`; `ownership.files`:
  `ownership_conflict`, `worktree_dirty`, `ownership_unknown`, `worktree_unknown`; `contract.artifact`:
  `artifact_evidence_unknown`, `artifact_contract_mismatch`; `dependency.declared`: `dependency_unmet`,
  `human_step_required`, `dependency_unknown`; `fixtures.data`: `fixture_unavailable`, `fixture_unknown`;
  `slot.idle`: `slot_busy`, `slot_idle_unknown` (R1); `bounds.explicit`: `verified_bound_exceeded`,
  `mandatory_writes_unknown`, `limits_unknown`; also `authority.paths`: `path_policy_unknown` and
  `mandatory_writes_unknown` (R1); `binding.attempt_unique`: `attempt_duplicate`, `attempt_unverified` (R1).
  Consumption: `report_schema_invalid`, `report_digest_mismatch`, `report_expired`,
  `identity_mismatch`, `task_digest_mismatch`, `capability_digest_mismatch`, `capability_revision_mismatch`,
  `provenance_unverified`, `report_not_evaluable`. Advisory: `wall_budget_exceeds_runner_limit`,
  `estimate_exceeds_bound`. **The vocabulary is now complete for every status of every check** (R1): every
  unavailable-evidence case has an explicit code, the per-code class/evidence kind/status table is 14.2, and no
  "code needs future design" hole remains for the cases enumerated there. Any further code still needs a design
  edit. Codes added by R1/R3 are NEW PROPOSED names (14.12); the generic `evidence_unavailable` code was the
  not-selected alternative.
- **Per-check evidence dependencies:** `authority.paths` <- `path_policy`, `mandatory_writes`, A1;
  `authority.commands` <- `command_decisions`; `identity.os` <- `os_identity`; `permission.profile` <-
  `permission_profile`; `matcher.compat` <- `permission_profile`, `matcher_attestation` (R3; no longer
  `command_decisions`, whose decisions are consumed only by `authority.commands`); `repo.base` <-
  `repo_base`; `ownership.files` <- `ownership`, plus `worktree` (A3); `contract.artifact` <-
  `artifact_contract` (A3); `authority.reference` <- `authority_decision` (A4); `dependency.declared` <-
  `dependencies`; `fixtures.data` <- `fixtures`; `slot.idle` <- `slot_state`; `bounds.explicit` <- `limits`,
  `mandatory_writes`. `binding.attempt_unique` <- `attempts_seen` (a binding check, not in the thirteen-entry expansion, but
  `attempt_unverified` under a non-evaluable snapshot, section 5). `authority.paths` <- `mandatory_writes`
  and `path_policy` (both needed for a pass).
- **Unchanged:** the six verdicts, precedence, required status, and published design vectors A and B (their
  bytes and digests). Fixtures keep their stable legacy case ids for traceability; the legacy summary-shaped
  baseline is **not** executable under the accepted schemas (its facts are prose summaries, not closed value
  objects, and lack `artifact_contract`/`authority_decision`); the accepted-schema baseline is a separate
  entry (`proposals.proposed_schema_baseline`). Accepted design contracts remain unimplemented; G8 is not started. The accepted closed baseline is now **sixteen**
  facts (the matcher attestation is NEW PROPOSED, 14.4); the legacy envelope bytes and vectors A/B are unaffected
  (14.13).

## 14. Residual contracts R1–R11 (approach ACCEPTED; exact values NEW PROPOSED, pending operator review)

**Provenance and labels.** The operator accepted the overall recommendation for all eleven residual items and
chose explicitly: R3 (matcher attestation is an external injected fact bound to the permission-profile digest
and the matcher contract revision; an empty `required_commands` set does not waive it), R2 (`trusted:false` is
`unknown` / `identity_os_unknown`, never feasible and never unauthorized), R5 (no fact-age limit in B1; only
`observed_ms <= captured_at_ms <= expires_at_ms`; G3 stays open). The operator has **not** seen the exact
field tables, ranges, patterns, constants and code names below. Every value is labeled:

- **[SRC]** existing source fact with its pin (checked by reading source only; nothing was run);
- **[DES]** design choice already accepted (A1–A6, object-set rule, the five explicit choices above);
- **[NEW]** new proposed limit / field detail / constant / code, **awaiting operator review on this PR**, each
  listed with its main alternative in 14.12. A [NEW] value is not an accepted fact and not a source fact.

Source facts relied on: MCTL-CJ1 integer ceiling 2^53−1 and `MAX_DEPTH` 64 (`canonical.ts:44-45`, #169); the store
keeps `epoch` and task/attempt ids as plain strings (`store.ts:22-34`; no format validator appears **in those
lines**, which is all of `store.ts` that was read for this point). Existing validators that were read, with their
exact pins: `bridge.lua:72-74` `valid_id` (string, 1-128 bytes, only `[%w%-_:.]`), `bridge.lua:76-78` `valid_slot`
(string, 1-32 bytes, only `[a-z0-9-]`; used at call sites such as `bridge.lua:281,359,503`), `bridge.lua:745`
`valid_entry` (`^%d+%-%d+$`, stream entry ids, unrelated to our ids), and `publish.ts:39-41,269-276` (manifest
`SHA` `^[0-9a-f]{40}$`; `TASK` `^[A-Za-z0-9._-]{1,100}$` applied to manifest `task_id` and `attempt_id`; `BRANCH`
`^(feat|fix|ci|docs|chore|refactor|test)/[A-Za-z0-9._/-]{1,100}$` plus rejection of `..`, `//` and a trailing `.lock`,
`/` or `.`; `sha256` `^[0-9a-f]{64}$`; `publish.ts:281` path `allowed()`). Only these lines were read; this document
does **not** claim they are the only validators in `bridge.lua`, `store.ts` or `publish.ts`, and no other file was
inspected for this point. No new numeric cap below is a source fact.

### 14.1 R1 — complete reason vocabulary

Added codes (all [NEW] names, approach [DES]): `permission_profile_unknown` (`permission.profile`, fact status
`unknown`; **unknown is not absent**: absent keeps `permission_profile_absent`), `slot_idle_unknown`
(`slot.idle`), `path_policy_unknown` (`authority.paths`), `attempt_unverified` (`binding.attempt_unique`; an
unverified attempt is **not** a duplicate). Reused, not renamed: `repo_base_unknown` (also for an `absent`
base), `dependency_unknown`, `fixture_unknown`, `command_decision_unknown`, `limits_unknown`,
`mandatory_writes_unknown`; the last is also **explicitly allowed under `authority.paths`**: unavailable
mandatory-write evidence prevents an `authority.paths` pass even when the forbidden list is empty, while an
independent known failure (for example `path_forbidden`) stays retained. Not selected: one generic
`evidence_unavailable` code (kept only as history). The full table is 14.2.

### 14.2 Closed code table (per check, per code: evidence kind, check status effect, class)

Evidence kind: **KF** known failure (evaluated from known evidence, requirement not met); **UN** unavailable
(fact `unknown`/`absent`, a missing entry inside a known fact, `trusted:false`, or an unbound attestation);
**TM** time (`stale`); **GT** gate code. Check-status effect: KF -> `fail`; UN -> `unknown` (or `absent`
where noted); TM -> `stale`; GT as stated. Class is the verdict class of the code and the `reasons[]` rank key.

| Check | Code | Kind | Status effect | Class |
|---|---|---|---|---|
| `binding.schema` | `schema_invalid` (reserved, unreachable, never emitted) | – | – | binding |
| `binding.provenance` | `provenance_unverified` | UN | `unknown` | binding |
| `binding.slot` | `slot_mismatch` | KF | `fail` | binding |
| `binding.epoch` | `epoch_stale` | KF | `fail` | binding |
| `binding.capability_fresh` | `capability_stale` | TM | `stale` | binding |
| `binding.not_expired` | `task_expired` | KF | `fail` | binding |
| `binding.attempt_unique` | `attempt_duplicate` | KF | `fail` | binding |
| `binding.attempt_unique` | `attempt_unverified` | UN | `unknown` | binding |
| `authority.reference` | `authority_denied` | KF | `fail` | unauthorized |
| `authority.reference` | `authority_unverified`, `authority_evidence_mismatch` | UN | `unknown` | uncertain |
| `authority.paths` | `path_forbidden`, `mandatory_write_outside_allowed` | KF | `fail` | unauthorized |
| `authority.paths` | `path_policy_unknown`, `mandatory_writes_unknown` | UN | `unknown` | uncertain |
| `authority.commands` | `command_denied` | KF | `fail` | unauthorized |
| `authority.commands` | `command_decision_unknown` | UN | `unknown` | uncertain |
| `identity.os` | `identity_os_unknown` (fact `unknown`, or known `trusted:false`) | UN | `unknown` | uncertain |
| `identity.os` | `identity_os_absent` (fact `absent`) | UN | `absent` | uncertain |
| `permission.profile` | `permission_profile_unknown` | UN | `unknown` | uncertain |
| `permission.profile` | `permission_profile_absent` | UN | `absent` | uncertain |
| `matcher.compat` | `matcher_unverified`, `matcher_attestation_mismatch` | UN | `unknown` | uncertain |
| `repo.base` | `base_moved` | KF | `fail` | blocked_dependency |
| `repo.base` | `repo_base_unknown` (fact `unknown` or `absent`) | UN | `unknown` | uncertain |
| `ownership.files` | `ownership_conflict`, `worktree_dirty` | KF | `fail` | blocked_dependency |
| `ownership.files` | `ownership_unknown`, `worktree_unknown` | UN | `unknown` | uncertain |
| `contract.artifact` | `artifact_contract_mismatch` | KF | `fail` | blocked_dependency |
| `contract.artifact` | `artifact_evidence_unknown` | UN | `unknown` | uncertain |
| `dependency.declared` | `dependency_unmet` | KF | `fail` | blocked_dependency |
| `dependency.declared` | `human_step_required` | KF | `fail` | needs_split |
| `dependency.declared` | `dependency_unknown` | UN | `unknown` | uncertain |
| `fixtures.data` | `fixture_unavailable` | KF | `fail` | blocked_dependency |
| `fixtures.data` | `fixture_unknown` | UN | `unknown` | uncertain |
| `slot.idle` | `slot_busy` | KF | `fail` | busy |
| `slot.idle` | `slot_idle_unknown` | UN | `unknown` | uncertain |
| `bounds.explicit` | `verified_bound_exceeded` | KF | `fail` | needs_split |
| `bounds.explicit` | `mandatory_writes_unknown`, `limits_unknown` | UN | `unknown` | uncertain |
| each of the 13 snapshot-derived checks | `evidence_not_evaluable` | UN | `unknown` | uncertain |
| each of the 13 snapshot-derived checks | `evidence_stale` | TM | `stale` | uncertain |
| `estimate.advisory` | none (always `pass`, never a reason) | – | – | – |

Every code appears under exactly the checks listed; a code under another check is a schema error in a report
(14.7). `authority.reference:authority_unverified` replaces the generic expansion entry (5). The code
`matcher_unverified` is also the unavailable-attestation reason; "unknown/mismatched attestation" always yields
status `unknown`, never `fail` and never `pass`.

### 14.3 R4 — mixed outcomes, per-check rules

General rule for every check, retained from A3 and generalized: **status = `fail` if any reason is a known
failure, else `absent` (only `identity.os`/`permission.profile` when the sole reason is the `*_absent` code),
else `unknown`/`stale` if any reason is unavailable/time, else `pass`.** Known failures and unavailable
reasons are **both retained**, `reason_codes` ascending bytewise within the check, `reasons[]` ordered
(class rank, check order, code). The verdict uses **all** known-failure classes present (section 6 item 3):
highest precedence wins, other findings stay listed. Invalid evidence (unusable snapshot) never yields a known
failure.

Per-check rules (inputs are the envelope field and the listed facts; "empty required set" means the envelope
set is empty):

- `authority.reference`: A4 table (13.5), unchanged.
- `authority.paths`: `path_forbidden` iff some `allowed_files` pattern intersects some forbidden pattern of a
  **known** `path_policy` (13.1); `mandatory_write_outside_allowed` iff a **known** `mandatory_writes` path is a
  member of no `allowed_files` pattern; `path_policy_unknown` iff `path_policy` is unavailable;
  `mandatory_writes_unknown` iff `mandatory_writes` is unavailable. `pass` only with both known and neither
  failure. (An empty forbidden list with unavailable `mandatory_writes` is `unknown`, not `pass`.)
- `authority.commands`: per required command: entry `denied` -> `command_denied`; entry `unknown`, no entry,
  or the fact unavailable -> `command_decision_unknown`; all `allowed` -> `pass`. **Empty required set -> `pass`**
  (nothing to decide) irrespective of the fact. A denial is a known failure even when the matcher attestation
  is unknown: attestation gaps never waive or hide a denial.
- `identity.os`, `permission.profile`, `matcher.compat`: 14.4/14.5.
- `repo.base`: `base_moved` iff known `sha` != `base.base_sha`; unavailable (`unknown` or `absent`) ->
  `repo_base_unknown`.
- `ownership.files`, `contract.artifact`: A3 (13.4), unchanged.
- `dependency.declared`: each envelope dependency with `step: human` -> `human_step_required` (known from the
  envelope; its `met` flag and entry are irrelevant); each `automatic` dependency with a known entry `met:false`
  -> `dependency_unmet`; with no entry, or the fact unavailable -> `dependency_unknown`. **No declared
  dependencies -> `pass`** irrespective of the fact. **Two fail classes in one check** (human step plus unmet
  automatic): status `fail`, both codes retained, `dependency_unmet` (blocked_dependency, rank 2) sorts before
  `human_step_required` (needs_split, rank 3), verdict `blocked_dependency`.
- `fixtures.data`: required fixture entry `available:false` -> `fixture_unavailable`; no entry or unavailable
  fact -> `fixture_unknown`. **Empty required set -> `pass`**.
- `slot.idle`: `idle:false` -> `slot_busy`; unavailable -> `slot_idle_unknown`.
- `bounds.explicit`: with `mandatory_writes` known: `verified_bound_exceeded` iff its size exceeds the envelope's
  `bounds.max_changed_files` **or** a known `limits.max_changed_files`; `mandatory_writes` unavailable ->
  `mandatory_writes_unknown`; `limits` unavailable -> `limits_unknown`; `pass` needs both known and no excess.
  The wall budget never produces a code here (14.8).
- `binding.*`: section 5/14.2.

The consequence that **mandatory-write and limits evidence is now required for `feasible`** (via
`authority.paths` and `bounds.explicit`) is intended; it is why the accepted baseline snapshot carries both.
Not selected: first-code or arbitrary-check-class verdicts; a seventh verdict.

### 14.4 R3 — matcher attestation (fact `matcher_attestation`)

[DES] approach (operator-accepted): an **externally injected** compatibility attestation, bound to the
permission-profile digest and a matcher contract revision. [NEW] concrete details:

- value `{profile_digest, matcher_revision, compatible}`; `profile_digest` 64 lowercase hex (same pattern as
  `permission_profile.value.digest`); `matcher_revision` string `[a-z0-9._/-]{1,64}`; `compatible` bool.
  Standard A2 envelope: `{status, observed_ms}` plus `value` only when `known`; trust and freshness come from the
  snapshot (`provenance.verified`, usability window), exactly like every other fact. The snapshot's closed baseline therefore
  has **sixteen** facts.
- The library holds one constant, the accepted matcher contract revision `mctl.matcher-contract/1` ([NEW]
  constant; the revision is a design label, not a software version).
- `matcher.compat` (evidence `permission_profile`, `matcher_attestation`, nothing else): `pass` iff
  `permission_profile` known **and** `matcher_attestation` known **and** `profile_digest` equals the permission
  profile digest **and** `matcher_revision` equals the constant **and** `compatible` is `true`. Unavailable
  profile or attestation -> `unknown` `matcher_unverified`. Known attestation with a different digest or
  revision, or `compatible:false` -> `unknown` `matcher_attestation_mismatch`. Never `fail`, never `pass` on a
  mismatch.
- Covered required commands may still be `allowed` or `denied` by `command_decisions`; denial is handled by
  `authority.commands`. An **empty `required_commands` set never waives** `matcher.compat`: the attestation is
  required for `feasible` regardless.
- **Non-claims.** The library verifies the claim's **structure and binding only**. It does not run, reproduce
  or validate the proprietary matcher or a real provider. G4 (a real provider) stays unresolved and **no
  real-machine PASS is claimed**. A feasible report with an attestation is not matcher evidence.
- Not selected: reusing `command_decisions` as the compatibility signal (the previous wording); an envelope
  field carrying the revision; one code for both unavailable and mismatch (14.12).

### 14.5 R2 — identity `trusted:false`

`os_identity` known with `trusted:true` -> `pass`. Known with `trusted:false` -> `unknown`
`identity_os_unknown` (blocks `feasible`; **never** `fail`, never `unauthorized`). Fact `unknown` -> the same
code; fact `absent` -> `absent` `identity_os_absent`. Three situations stay distinct: **present false**
(well-formed value, check `unknown`), **schema-malformed** (e.g. `trusted` not a bool, an input error under A5,
no report), and **untrusted snapshot** (`provenance.verified` false: `binding.provenance` gate plus
`evidence_not_evaluable`, the check never reads the value).

### 14.6 R5 — fact age (14.6a evidence rule and 14.6b report table follow)

R5 (operator-accepted): B1 sets **no maximum fact age and no host time source**. Schema rules (input errors,
A5): every timestamp is a safe integer in `[0, 2^53-1]`; `observed_ms <= captured_at_ms <= expires_at_ms`
(`bad_range` otherwise; paths `facts.<id>.observed_ms` and `expires_at_ms`). Usability is **inclusive** and uses
only the injected clock: usable iff `captured_at_ms <= nowMs <= expires_at_ms`. Consequences: a well-formed
snapshot captured in the future of `nowMs` is **stale/unusable** (`binding.capability_fresh` `stale`
`capability_stale`; then all 13 checks `evidence_stale`), whereas a *fact* observed in the future of
`captured_at_ms` is a **schema error**. `observed_ms <= nowMs` needs no separate rule because
`observed_ms <= captured_at_ms <= nowMs` follows from usability. Facts inside a usable snapshot carry **no age
guarantee**: an old `observed_ms` is well-formed and is not rejected, and the snapshot window says nothing about
how recently a fact was observed. Timestamps bind bytes; snapshot freshness is **not** proof of recent
observation. Gate G3 (window lengths, clock source) stays open.

**14.6a Evidence reference rule.** A check's `evidence` lists `{fact, revision}` for each fact the check
consulted, ascending by `fact`, only when the check was evaluated from an individually evaluable snapshot;
otherwise `[]`. Per check: `authority.reference` `authority_decision`; `authority.paths` `mandatory_writes`,
`path_policy`; `authority.commands` `command_decisions`; `identity.os` `os_identity`; `permission.profile`
`permission_profile`; `matcher.compat` `matcher_attestation`, `permission_profile`; `repo.base` `repo_base`;
`ownership.files` `ownership`, `worktree`; `contract.artifact` `artifact_contract`; `dependency.declared`
`dependencies`; `fixtures.data` `fixtures`; `slot.idle` `slot_state`; `bounds.explicit` `limits`,
`mandatory_writes`; `binding.attempt_unique` `attempts_seen` (only when evaluable); every other check `[]`.
`revision` is the snapshot's `revision` (all references in a report carry the report's `capability_revision`).
`retained_under_invalid_binding` is `true` **only** for a substantive (13-list) check that was actually
evaluated from an individually evaluable snapshot while `binding_valid` is false; it is `false` everywhere else
(including every check of a valid-binding report). It is never `true` for a non-evaluable (expanded) check.

**14.6b FeasibilityReport v1 closed table** (R6; all [NEW] exact names and constants, `schema` constant [NEW]).
Key order is MCTL-CJ1; no key is optional; no `null`; no extra key.

| Field | Type | Constraint |
|---|---|---|
| `schema` | string | constant `mctl.feasibility-report/1` |
| `task_digest`, `capability_digest`, `report_digest` | string | 64 lowercase hex |
| `capability_revision` | integer | `[0, 2^53-1]` (14.10) |
| `task_id`, `attempt_id`, `slot`, `slot_epoch` | string | formats of 14.9 |
| `evaluated_at_ms`, `expires_at_ms` | integer | each `[0, 2^53-1]`; **no ordering relation between them**: `expires_at_ms` is the min of the envelope and snapshot expiries (section 6) and a well-formed expired input (`evaluated_at_ms` after an expiry) yields a valid `uncertain` report whose `expires_at_ms < evaluated_at_ms`; such a report is schema-valid and is rejected at consumption only through `consume.report_expired` (14.7) |
| `binding_valid` | bool | true iff the seven `binding.*` checks are all `pass` |
| `verdict` | string | the six verdicts |
| `checks` | array of Check | exactly 21 entries, ids and order of the fixed check list |
| `reasons` | array of string | `check_id:code`, ordered by (class, check order, code), distinct |
| `advisory` | object | `{est_changed_files, est_minutes, advisory_codes}` (14.8) |
| `non_claims` | array of string | exactly `["not_authorization","not_reservation","not_os_isolation","not_toctou_closure"]` in that order |

Check `{id, required, status, reason_codes, evidence, retained_under_invalid_binding}`: `id` one of the 21 fixed
ids (enum); `required` bool, constant by id (`false` only for `estimate.advisory`); `status` in
`pass|fail|unknown|absent|stale`; `reason_codes` array of strings, ascending bytewise, distinct, each a code of
that check in 14.2 (empty iff `pass`); `evidence` array of Evidence `{fact, revision}` (`fact` one of the 16
fact ids, `revision` integer `[0,2^53-1]`) per 14.6a; `retained_under_invalid_binding` bool per 14.6a.

**Class representation.** The class of a reason is **derived from the closed table 14.2** (code -> class); it is
not serialized. `reasons[]` holds only `check_id:code` strings. Not selected (14.12): serializing a class per
reason entry, or optional/tagged fields. The check status/codes serialize exactly as above; nothing else
(no prose, no raw values, no unsafe identifiers, no error text) is ever serialized.

### 14.7 R6/R10 — consumption shape and local relations

`ConsumptionResult` `{schema, valid, checks, reasons}` closed [NEW]: `schema` constant
`mctl.feasibility-consumption/1`; `valid` bool, true iff all eight checks `pass`; `checks` array of exactly
eight `ConsumptionCheck` `{id, status, reason_codes}` in the fixed `consume.*` order (`id` enum; `status` in
`pass|fail|unknown|stale`; `reason_codes` array of 0 or 1 string from the 8-check table in 6.1/13.7, `[]` iff
`pass`); `reasons` array of `check_id:code`, class `consumption`, then check order, then code. There is **no**
`required`, `evidence` or retained field (not a blind copy of the evaluator check shape). Only the existing
eight checks exist: **no re-evaluation and no ninth authenticity check.**

**`consume.report_schema` checks only structure and local relations** of the presented report (failure ->
`report_schema_invalid`, then A6 fixed output, nothing read from the report):

- Structural (schema): closed keys and types of 14.6b; enums; digest formats (64 lowercase hex); formats of 14.9;
  integers in range; `schema` constant; `non_claims` constant list.
- Local relations (still schema-level, evaluated on the report alone, never against the envelope/snapshot):
  `checks` has exactly the 21 fixed ids in order; each `required` matches its id; each `reason_codes` is
  ascending, distinct, a subset of that check's codes in 14.2, empty iff `pass`, and consistent with `status`
  (14.2 status effects); evidence references use allowed facts for the check (14.6a) and `revision ==
  capability_revision`; the two timestamps are checked only as safe integers: there is **no**
  `evaluated_at_ms <= expires_at_ms` relation (an expired-input report is schema-valid, section 6; expiry is the
  separate `consume.report_expired` check, status `stale`, and no new freshness policy or fact-age limit is
  added); [NEW, listed 14.12] `binding_valid` equals "all seven
  binding checks `pass`", `reasons` equals the ordered rule of section 6 applied to the report's own `checks`,
  and `verdict` equals the section 6 derivation from the report's own `checks` and `binding_valid`.
- **Not** performed (semantic, outside the consumption function): that the evaluator produced these checks
  from true inputs, that facts hold, that provenance is genuine, and re-running `evaluate`. A report whose
  *reasons order* or *verdict* violates the local relations is `report_schema_invalid`; a report that is
  locally consistent but untrue is **not detectable here** and `valid:true` does not claim otherwise (see 6.1). Not selected: semantic recomputation.

### 14.8 R7 — advisory

`advisory` = `{est_changed_files, est_minutes, advisory_codes}` [NEW shape]; `est_*` echo the envelope's
declared integers; `advisory_codes` array of strings, ascending bytewise, distinct, each in
`estimate_exceeds_bound|wall_budget_exceeds_runner_limit`. `estimate.advisory` is a non-required check that is
always `pass` with no reason codes; advisory codes live **only** in `advisory.advisory_codes`, never in
`reasons`, and never influence the verdict.

- `estimate_exceeds_bound` iff `est_changed_files > bounds.max_changed_files` **or**
  `est_minutes * 60000 > bounds.max_wall_ms`. Compared exactly with BigInt (no rounding, no float, no overflow:
  `est_minutes * 60000` can exceed 2^53 and is computed in BigInt). Computed from the envelope alone.
- `wall_budget_exceeds_runner_limit` iff the snapshot is individually evaluable and `limits` is `known` and
  `bounds.max_wall_ms > limits.max_wall_ms`. An unavailable `limits` or an unusable snapshot never emits it
  (only a known verified limit counts).
- Ranges [NEW]: `est_changed_files`, `est_minutes`, `bounds.max_changed_files`, `bounds.max_wall_ms`,
  `limits.max_changed_files`, `limits.max_wall_ms` are integers in `[0, 2^53-1]` and `0` is allowed
  everywhere (these are the existing MCTL-CJ1 integer ceiling [SRC] plus a floor of 0; no smaller cap is
  proposed). The base `est_minutes` range equals the schema's integer range; there is no separate bound.
- No hard verdict ever comes from an estimate. Not selected: an echo-only advisory with no codes in the object.

### 14.9 R8 — format table (anchored, case-sensitive, ASCII, no normalization)

Every pattern below is matched against the **whole** string (no multiline, no trailing newline), without
case folding or Unicode normalization. A violation is an input error (A5): `bad_pattern` for string patterns,
`bad_value` for enums/constants, `bad_range` for ranges, `wrong_type` for types; the path is the fixed schema path.

| Field | Format | Notes / provenance |
|---|---|---|
| `task_id` | `t-` + lowercase UUID text `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}` (38 chars) | [DES] shape `t-<uuid>` (3.1); lowercase 8-4-4-4-12 hex form [NEW]; no version/variant check |
| `attempt_id` | same with prefix `a-` | as above; also the `attempts_seen.ids` member format (13.2) |
| `slot` | `[a-z0-9-]{1,64}` | character set [DES] (3.1) and equal to the Lua `valid_slot` set [SRC `bridge.lua:77`]; length bound 64 [NEW] **differs from the source limit of 32** (`bridge.lua:77`), so a 33-64 byte slot would pass B1 but not the Lua `valid_slot`; flagged for operator review (14.12 row 21) |
| `slot_epoch` | canonical decimal: `0` or `[1-9][0-9]*`, value <= 2^53−1 (compared as BigInt) | store keeps epochs as strings [SRC `store.ts:26,33`]; ceiling = MCTL-CJ1 integer ceiling [SRC]; **no 16-digit or other invented cap**; leading zeros rejected [NEW] |
| `repo` | `<owner>/<name>`; owner `[A-Za-z0-9-]{1,39}`, name `[A-Za-z0-9._-]{1,100}` and name not `.`/`..` | syntax only; existence of the repo is **never** proven by the regex; the 39/100 lengths [NEW] |
| `worktree_label` | `[a-z0-9._-]{1,64}` | opaque label, no `/`; never a path; length [NEW] |
| `base.branch`, `expected.branch` | `[A-Za-z0-9._/-]{1,128}`, no `..`, no leading or trailing `/` | accepted syntax of 13.4 [DES] applied to `base.branch` too [NEW application]; **not** full git ref-format validation (e.g. `a//b`, trailing `.lock` are not rejected here) |
| `base.base_sha`, `repo_base.sha` | `[0-9a-f]{40}` | [DES] (3.1, 13.2) |
| digests (`permission_profile.digest`, `matcher_attestation.profile_digest`, report/task/capability digests) | `[0-9a-f]{64}` | [DES] (13.2) |
| fixture / dependency `id`; `fixtures` (envelope set) members | `[a-z0-9:._-]{1,64}` | [DES] (13.2) |
| `dependencies[].kind` | `[a-z0-9._-]{1,32}` | [NEW] |
| `dependencies[].step` | enum `automatic`\|`human` | [DES] |
| `required_commands` members, `command_decisions.entries.command` | `cmd:[a-z0-9._-]{1,64}` | [DES] (13.2) |
| `snapshot_id` | `[a-z0-9._-]{1,64}` | [NEW] |
| `provenance.source_kind` | `[a-z0-9._-]{1,32}` | [NEW] |
| `provenance.issuer_ref` | `[a-z0-9._-]{1,64}` | [NEW] |
| `authority_ref`/`authority_decision` `id` | `[a-z0-9:._-]{1,64}`, literal `none` iff kind `none` | [DES] (13.2) |
| `expected.trailer`, `artifact_contract.trailer` | printable ASCII U+0020..U+007E, 1-128 chars | [DES] (13.2) |
| schema constants | `mctl.task-envelope/1`, `mctl.capability-snapshot/1`, `mctl.feasibility-report/1`, `mctl.feasibility-consumption/1` | first two [DES] (3.1, 3.2); last two [NEW] |
| path patterns | A1 grammar (13.1, 14.11) | [DES] plus 14.11 clarifications |
| every integer | safe integer in `[0, 2^53-1]` | [SRC] ceiling (`canonical.ts:45`); floor 0 for all timestamps, counts, budgets, revisions [NEW application] |

**Review against the validators that were read (the pins at the start of section 14; not a complete audit):** `slot`'s character
set equals `valid_slot` (`bridge.lua:77`) but its proposed length 64 exceeds the source 32; the `t-`/`a-` UUID
shapes are stricter than `valid_id` (`bridge.lua:73`, 1-128 of `[%w%-_:.]`) and than the publisher manifest `TASK`
(`publish.ts:41`, 1-100 of `[A-Za-z0-9._-]`, which has no `:`); `base_sha`/`repo_base.sha` equal the publisher `SHA`
(`publish.ts:39`); the proposed branch grammar is **looser** than the publisher `BRANCH` check (`publish.ts:40,274`:
required type prefix, `//` and trailing `.lock`, `/` or `.` rejected). For `repo`, `worktree_label`, the owner/name
lengths, `dependencies[].kind`, `snapshot_id`, `source_kind` and `issuer_ref` no matching validator was found in the
lines read; that is not a claim that none exists elsewhere. The 64/128/39/100/32 lengths remain proposals, listed
individually in 14.12 with alternatives; none is claimed to match production data. **No element-count or total-size cap** on set arrays, paths or the envelope is
proposed here (the open alternative is a count cap); `canonical.ts` `MAX_DEPTH` 64 [SRC] is the only structural
limit. No credential or host fact was read to choose any of these values.

### 14.10 R9 — revision

`revision` is a safe integer in `[0, 2^53-1]`; **0 is allowed** (a first synthetic revision). That it increases
per source is a **source-policy** property that a single snapshot passed to a pure function cannot prove; the
function never claims it. Not selected: `>= 1` plus a bootstrap rule. All timestamps, budgets and estimates are
non-negative safe integers; ranges already in 14.8/14.9.

### 14.11 R11 — A1 clarifications

Reject (input error `bad_path_grammar`): the **empty pattern**; any pattern with a **leading ASCII drive
prefix**, tested as `^[A-Za-z]:` on the raw pattern **before** the alias step; plus the previously listed
absolute, UNC (`//`, a leading `/` is absolute), backslash and traversal forms. The alias `/**` is recognized
first (a bare `**` and `C:/**` are still rejected), and the exact-leaf intersection table is unchanged. A colon
elsewhere is not forbidden. Boundary examples:

| Pattern | Result |
|---|---|
| `` (empty) | input error (empty) |
| `C:`, `C:/x`, `C:relative`, `c:x`, `C:/**` | input error (leading drive prefix) |
| `a:b` | input error (index-1 colon matches `^[A-Za-z]:`) |
| `docs/a:b` | valid exact path (non-leading colon is not implicitly forbidden) |
| `ab:c` | valid exact path (colon at index 2, not a drive prefix) |
| `docs/**` | valid alias of `docs/` |

Not selected: banning every colon (narrower, not approved).

### 14.12 Review table: every NEW PROPOSED value and its main alternative

All rows are **NEW PROPOSED, awaiting operator review on this PR**, though the approach of the item is accepted.

| # | Item | Proposed value | Main alternative |
|---|---|---|---|
| 1 | R1 new codes | `permission_profile_unknown`, `slot_idle_unknown`, `path_policy_unknown`, `attempt_unverified` | generic `evidence_unavailable` (history) |
| 2 | R1 `mandatory_writes_unknown` under `authority.paths` | allowed; blocks the path pass | keep only under `bounds.explicit` |
| 3 | R1/14.3 empty required set | `authority.commands`, `dependency.declared`, `fixtures.data` pass on empty set; `matcher.compat` never waived | fact must be known even for empty sets |
| 4 | `binding.attempt_unique` unavailable / non-evaluable snapshot | `unknown` `attempt_unverified`, class binding, added after other binding entries | stay `pass` when the snapshot is not evaluable |
| 5 | R3 fact name and value | `matcher_attestation` `{profile_digest, matcher_revision, compatible}` (16th fact) | revision carried in the envelope; or a boolean without a revision |
| 6 | R3 field formats | digest `[0-9a-f]{64}`; revision `[a-z0-9._/-]{1,64}` | narrower revision charset |
| 7 | R3 revision constant | `mctl.matcher-contract/1` | caller-supplied expected revision |
| 8 | R3 mismatch code | `matcher_attestation_mismatch` (status `unknown`) | reuse `matcher_unverified` for mismatch |
| 9 | R3 dependency change | `matcher.compat` reads `permission_profile`+`matcher_attestation`, no longer `command_decisions` | keep `command_decisions` as an input |
| 10 | R2 | present `trusted:false` -> `unknown` (**operator-chosen**; code `identity_os_unknown` reused) | n/a (explicit choice) |
| 11 | R5 | no max age (**operator-chosen**); inclusive usability; observed <= captured <= expires as `bad_range` | a maximum fact age (rejected for B1) |
| 12 | R5 path templates | `facts.<id>.observed_ms`, `expires_at_ms` | other path spellings |
| 13 | R6 schema constants | `mctl.feasibility-report/1`, `mctl.feasibility-consumption/1` | other names |
| 14 | R6 Check/Evidence/Report tables | 14.6b: 21 checks always, evidence rule 14.6a, retained flag rule | optional/tagged fields; omit non-evaluated checks |
| 15 | R6 class representation | derived from the closed code table, not serialized | serialize class per reason |
| 16 | R10 ConsumptionCheck | `{id, status, reason_codes(0..1)}` | copy the evaluator Check shape |
| 17 | R10 extra local relations | `binding_valid`, `reasons`, `verdict` consistency with the report's own checks; **no** `evaluated_at_ms <= expires_at_ms` relation (expired-input reports are schema-valid) | omit the verdict/reasons relations (structure and ranges only) |
| 18 | R7 advisory object | `{est_changed_files, est_minutes, advisory_codes}`; codes only there | echo-only, no codes |
| 19 | R7 conditions and ranges | BigInt `est_minutes*60000`; all counts/budgets/estimates `[0, 2^53-1]`, 0 allowed | smaller caps (e.g. a minutes cap) |
| 20 | R8 `task_id`/`attempt_id` | `t-`/`a-` + lowercase 8-4-4-4-12 hex UUID, no version check | UUIDv4-only |
| 21 | R8 `slot` length | `[a-z0-9-]{1,64}` (exceeds the source `valid_slot` limit 32, `bridge.lua:77`) | 1-32 (equals the source limit; the evaluator would then never accept a slot the Lua validator rejects) |
| 22 | R8 `slot_epoch` | canonical decimal, no leading zeros, value <= 2^53-1, no digit cap | 16-digit cap or unbounded decimal |
| 23 | R8 `repo` | owner `{1,39}`, name `{1,100}`, syntax only | looser `[^/]+/[^/]+` |
| 24 | R8 `worktree_label` | `[a-z0-9._-]{1,64}` | 1-32 |
| 25 | R8 branches | 13.4 syntax applied to `base.branch` as well; not full ref-format | full git ref validation |
| 26 | R8 `dependencies[].kind`, `snapshot_id`, `source_kind`, `issuer_ref` | `[a-z0-9._-]{1,32/64/32/64}` | other lengths |
| 27 | R8 no count/size caps | none proposed | a count cap per set |
| 28 | R9 | revision `[0, 2^53-1]`, 0 allowed | `>= 1` with a bootstrap |
| 29 | R11 | `^[A-Za-z]:` on raw start; empty pattern rejected; other colons allowed | ban every colon |
| 30 | Baseline | 16 facts, symbolic digest `digest:cap-P-rev-1` for the new snapshot body | keep 15 and fold the attestation elsewhere |

### 14.13 What did not change

The six verdicts and their precedence, the 13 snapshot-derived checks (the matcher attestation is a fact, not a
new check), all of A1–A6 and the object-set rule (A1 only clarified), the published design vectors A and B
(vector B's envelope bytes and digest are unchanged: every field of that envelope stays valid under the ranges
and formats above; the snapshot body is new and its digest stays symbolic, never claimed equal to any legacy
digest), the non-claims, and the unresolved gates (G1–G8; G3 and G4 explicitly still open). No runtime
conformance or machine PASS is claimed, and nothing in this section is evidence of readiness.

Related analogues (agents #997/#1032) are not a second DevLoop and add no write scope here; their
excerpts were not needed.
