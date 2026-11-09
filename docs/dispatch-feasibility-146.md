# Dispatch feasibility report: design (B1), refs #146

Status: **design only**. Nothing in this document is implemented, measured or probed. It adds no
runtime code, no dispatch/reservation/launch/ack change, and no enforcement. The companion file
[dispatch-feasibility-fixtures-146.json](dispatch-feasibility-fixtures-146.json) holds *illustrative
design expectations*; they are not executable feature tests and not evidence of readiness.

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

Read from source only; no host command was run.

| Fact | Today (source) | Status for this design |
|---|---|---|
| Task content | `send()` takes an opaque `payload` string, max 16384 bytes, plus `hop`, `ttl_ms`, idempotency key (`bridge.lua:516`, `MAX_PAYLOAD` `bridge.lua:29`, `store.ts:18`). No schema. | Envelope is new; prose is never a verdict input. |
| Slot identity at send | `send()` copies `uuid` and `epoch` from the slot hash and rejects an unregistered slot (`bridge.lua:527-533`). | Epoch/slot are today's only binding facts. |
| Slot busy/inflight | Slot hash holds `busy`, `inflight`, `inflight_attempt`; `bridge_status` returns them (`bridge.lua:501-507`). | Source of a future `slot.idle` fact; B1 does not read a live store. |
| No reservation | `send()` queues and returns; nothing is held (`bridge.lua:530-540`). | Why TOCTOU stays open. |
| Duplicate ids | `send()` returns `duplicate_id` / dedup on idempotency key (`bridge.lua:522-529`). | Analogue for `attempt_unique`; the store has no per-attempt feasibility record. |
| Permission rules | `ops/slot.sh` writes `settings.json` with allow/deny command-prefix rules (`slot.sh:199-215`) and launches `claude` in `--permission-mode default` with a fixed `--allowedTools` list (`slot.sh:221-240`). | Rules are matched by Claude Code's proprietary matcher. A textual prefix comparison is **not** faithful (deny globs such as `Bash(*.ssh*)`, `Bash(go *-exec*)`). Compatibility is `unknown` unless a future provider supplies a decision. |
| Handoff inputs | `ExportInput` has repo, `baseSha`, `headSha`, `branch` (`handoff.ts:55-67`); `ExportResult` has `changed_files` (`handoff.ts:92-106`). | Shape analogue for the artifact contract; it is evidence only after the fact. |
| Commit trailer | Not enforced in this repo's source. Only the slot rules (MCP channel instructions) require `Agent: claude`; the publisher refuses otherwise. | Treated as a declared expectation, `unknown` until a snapshot supplies it. |
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
| `allowed_files` | **set** of strings | repo-relative path patterns |
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
| `facts` | one entry per fact id (below); each `{status, value, observed_ms}`, `status` in `known` \| `unknown` \| `absent` |

Fact ids: `os_identity`, `permission_profile`, `command_decisions` (per required command: `allowed` \|
`denied` \| `unknown`, produced by the real matcher, never by B1), `repo_base`, `worktree`, `ownership`,
`dependencies`, `fixtures`, `slot_state`, `attempts_seen`, `limits` (verified hard bounds, if any),
`path_policy` (verified forbidden path patterns).

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
6. Arrays: `[` elements joined by `,` `]`. **Ordered arrays** keep their order and duplicates. Fields declared
   **set-valued** in the schema (`allowed_files`, `required_commands`, `fixtures`, `reasons`, plus
   snapshot fact value sets) must already be strictly ascending by bytewise UTF-8 with no duplicates;
   otherwise the input is *rejected* (`binding.schema` fails). Nothing is silently sorted or de-duplicated.
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

Vector B — a synthetic TaskEnvelope (domain `mctl.feasibility/1/task-envelope`, input 780 bytes):

```
{"advisory":{"est_changed_files":2,"est_minutes":20},"allowed_files":["docs/example-146.md"],"attempt_id":"a-00000000-0000-4000-8000-000000000002","authority_ref":{"id":"decision-0001","kind":"operator_decision"},"base":{"base_sha":"0123456789abcdef0123456789abcdef01234567","branch":"main"},"bounds":{"max_changed_files":3,"max_wall_ms":3600000},"dependencies":[],"expected":{"artifact_kind":"handoff_bundle","branch":"docs/example-146","trailer":"Agent: claude"},"expires_at_ms":1790000000000,"fixtures":["fixture:synthetic-a"],"repo":"example-org/example-repo","required_commands":["cmd:git-diff-check"],"schema":"mctl.task-envelope/1","slot":"slot-x","slot_epoch":"7","task_id":"t-00000000-0000-4000-8000-000000000001","worktree_label":"wt-1"}
sha256 = 43e77d4fafa97cc56fe831d1bdcb145468f821b940bdf1519a074157c9527880
```

Unresolved serialization gate: an independent second implementation (another language) must reproduce
vectors A and B and a rejection corpus (duplicate keys, lone surrogates, floats, unsorted sets) before any
claim of cross-language equivalence. Until then none is made. Fixtures in the JSON file use symbolic digest
labels (`digest:env-A`), not real hashes, except where they cite vector B.

## 5. Checks

Each check has `id`, `required` (bool), `status` in `pass|fail|unknown|absent|stale`, sorted
`reason_codes`, and `evidence` = a list of `{fact, revision}` references (never raw values that could be
sensitive). Fixed evaluation/output order:

**Binding gate** (evaluated first):
`binding.schema`, `binding.provenance`, `binding.slot`, `binding.epoch`, `binding.capability_fresh`,
`binding.not_expired`, `binding.task_digest`, `binding.attempt_unique`.

**Substantive checks:**
`authority.reference`, `authority.paths`, `authority.commands`, `identity.os`, `permission.profile`,
`matcher.compat`, `repo.base`, `ownership.files`, `contract.artifact`, `dependency.declared`,
`fixtures.data`, `slot.idle`, `bounds.explicit`, and the non-required `estimate.advisory`.

Mapping to verdict classes:

| Class | Checks that can fail it |
|---|---|
| unauthorized | `authority.reference`, `authority.paths` (path matches a verified forbidden pattern), `authority.commands` (a required command has verified decision `denied`) |
| blocked_dependency | `dependency.declared` (automatic dependency unmet), `fixtures.data` (test data unavailable), `ownership.files` (another owner holds overlapping files), `repo.base` (base moved from the bound SHA) |
| needs_split | `bounds.explicit` (a *verified* limit makes the task impossible), `dependency.declared` with `step: human` |
| busy | `slot.idle` |
| uncertain | any required check `unknown`/`absent`/`stale`; any binding failure |

`authority.paths` is evaluated against `path_policy` from the snapshot; `allowed_files` ⊄ policy is
`fail` only when that policy is `known`; otherwise `unknown`.

## 6. Verdict, precedence, binding validity

Verdicts are exactly: `feasible | busy | needs_split | blocked_dependency | unauthorized | uncertain`.
Binding validation is an evaluation **gate**, not a seventh verdict.

1. **Binding.** `binding_valid` is true only if all eight binding checks `pass`.
2. **If `binding_valid` is false:** verdict is `uncertain`, `binding_valid=false`, and `invalid_binding`
   reason codes list the failed binding checks (e.g. `slot_mismatch`, `epoch_stale`, `capability_stale`,
   `report_expired`, `task_digest_drift`, `attempt_duplicate`, `provenance_unverified`, `schema_invalid`).
   Substantive checks are still evaluated **only on evidence that is individually evaluable** (schema valid,
   provenance verified, fresh, and for the same slot). Those results are retained and marked
   `retained_under_invalid_binding: true`; they can never make the report feasible and the report authorizes
   nothing. Evidence that is stale/untrusted/for another slot yields `stale`/`unknown`, so it cannot pose
   as a proven denial. (Open gate G5: whether a trusted, fresh denial should be surfaced as top-level
   `unauthorized` despite an unrelated binding failure. Default here: no, verdict stays `uncertain`.)
3. **If `binding_valid` is true:** first match in this precedence wins the verdict:
   `unauthorized` > `blocked_dependency` > `needs_split` > `busy` > `uncertain` > `feasible`.
   - a class applies if any of its checks is `fail` (or, for `uncertain`, any *required* check is
     `unknown`/`absent`/`stale`);
   - `feasible` only if **every required check is `pass`** and binding is valid.
4. **All findings are retained.** `reasons` lists every non-pass reason from every evaluable check, ordered
   by (class precedence, check order, reason code). A `busy` verdict therefore still lists
   `identity_os_unknown`; the verdict is the highest class, not the only finding.

Required checks (everything except `estimate.advisory`): trusted identity (`identity.os`), permission
profile (`permission.profile`), `matcher.compat`, repo/base (`repo.base`), artifact/commit contract
(`contract.artifact`), ownership (`ownership.files`), capability freshness (`binding.capability_fresh`),
plus all others above. A missing OS identity, permission profile or base can produce at best `uncertain`.

### FeasibilityReport v1 shape

`schema`, `task_digest`, `capability_digest`, `task_id`, `attempt_id`, `slot`, `slot_epoch`,
`evaluated_at_ms` (the **injected** clock value; the function never reads time), `expires_at_ms`
(= min of envelope and snapshot expiry), `binding_valid`, `verdict`, `checks[]` (fixed order, section 5),
`reasons[]`, `advisory` (section 8), `non_claims` (constant list: `not_authorization`, `not_reservation`,
`not_os_isolation`, `not_toctou_closure`), and `report_digest` (domain `.../report`, over every other
field). Output is MCTL-CJ1 bytes; identical inputs give byte-identical output.

## 7. Privacy and sanitized output

- Evidence is by reference (`fact` id + `revision` + digest), not by value.
- Never serialized: credentials, tokens, absolute/private filesystem paths, host names, question or
  message text, tool output, free-text prose.
- Strings in the report come from closed enums (verdicts, statuses, reason codes, check ids) or are echoed
  from schema-validated identifiers (`task_id`, `attempt_id`, `slot`, `repo`, repo-relative patterns).
  Any identifier failing its pattern makes `binding.schema` fail and is **not** echoed.
- Output must be stable: fixed key order (MCTL-CJ1), fixed check order, sorted reason codes.

## 8. Advisory estimates

`advisory.est_*` are heuristics declared by the task author. They never produce `feasible`, never
override a trusted check, and never alone produce a hard denial. `needs_split` requires either a verified
limit proven impossible (`limits` fact `known` and `allowed_files` count or the `bounds` exceeds it) or a
declared dependency whose `step` is `human`. A pessimistic estimate over a bound only adds the advisory
code `estimate_exceeds_bound` and leaves the verdict to the trusted checks. Measured/declared facts and
estimates are separate sections of the report.

## 9. Side effects

The dry run is a pure function of its three inputs. It performs no store write, send, ack, reservation,
commit, push, PR, worktree write, subprocess or network call (strategy in section 10.2).

## 10. Proposed B1 implementation and test allowlist (not approved here)

### 10.1 Allowlist for a future B1 implementation PR

Source (new files only, nothing existing modified except where listed):

- `plugin/mctl-bridge/src/feasibility/canonical.ts` — MCTL-CJ1 encoder/validator, digest.
- `plugin/mctl-bridge/src/feasibility/types.ts` — schemas and closed enums.
- `plugin/mctl-bridge/src/feasibility/evaluate.ts` — pure `evaluate(envelope, snapshot, nowMs)`.
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
- Mutation test: change one snapshot fact; assert `capability_digest` and `report_digest` change and a
  report bound to the old digest is not accepted (`task_digest_drift` / `capability_stale`).
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
| G7 | Where the commit-trailer contract is verified (publisher is outside this repo's source). |
| G8 | Owner decision to proceed to B1 implementation, and later to B2. |

Related analogues (agents #997/#1032) are not a second DevLoop and add no write scope here; their
excerpts were not needed.
