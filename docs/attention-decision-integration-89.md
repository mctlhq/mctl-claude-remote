# AttentionDecision integration for the events adapter (design, #89)

Status: **design only**. Refs #89 (does not close it). Nothing here changes
runtime, policy, entrypoint, dependencies, installer, workflows or hosts. Every
"proposed" item below needs a separately scoped implementation task, and
activation needs its own operator decision (see [Gates](#gates)).

Companion fixtures: `docs/attention-decision-fixtures-89.json`.

## 1. Scope and evidence

### Local source refs (read in this checkout, base `origin/main` beae084)

| Fact | Ref |
|---|---|
| Validate, route, dedup, attempt-bound, emit run in `Adapter.handle` | `events/mctl_events/channel.py:347-431` |
| Routing is `Policy.route_for` (stream, source, type glob, subject globs) | `channel.py:365`, `policy.py:36-45,89-90` |
| Dedup/in-flight checks run under `self._lock`, including one Valkey round trip (`_was_acked`) | `channel.py:370-400` |
| Attempt counted durably just before emit; over `max_attempts` the event is marked acked and XACKed | `channel.py:403-414` |
| Emit failure: slot and attempt released, entry left pending, `DeliveryFailed` | `channel.py:419-430` |
| `ack()` writes the dedup marker, then XACKs every entry, then drops in-flight state | `channel.py:703-727` |
| `ack_event` outcome enum is `handled\|ignored\|failed`; every outcome consumes the event | `channel.py:741-753,794-799` |
| Notification is reference-only: `meta` + one content line | `channel.py:121-148` |
| Envelope is closed, string-only subject, <=12 keys, <=4096 bytes | `envelope.py:24-41,98-151` |
| A read asks for `COUNT = max_inflight - len(inflight)`; each entry is then `_dispatch`ed one by one | `channel.py:449-477` |
| `recover_pending` pages of `PENDING_BATCH`=100 (not bounded by `max_inflight`); `reclaim` pages of `RECLAIM_BATCH`=50 bounded by capacity | `channel.py:76-78,511-588` |
| Valkey keys live under `mctl:events:state:*`, per (group, event) via `_state_key` (percent-encoded parts) | `channel.py:68-74,247-255` |
| Model-facing contract text is `INSTRUCTIONS` and is mirrored by `entrypoint.sh` and a test | `channel.py:87-108` |
| The adapter has no GitHub client, and the envelope cannot carry state | `envelope.py:98-151` |
| `HYDRATION_HINTS` use subject keys `repository` and `number` for `github.pull_request*` | `channel.py:110-113` |

### External evidence (as supplied by Codex's read-only review; not fetched from this slot)

- mctl-agents `docs/spikes/757-duet-sessions.md` on main: owner verdict
  `EXTEND_DEVLOOP_SESSION`; the extension is the existing claude-remote operator
  session, not `DevLoopWorkflow` or a new session store.
- `.github` PR 221 (merged) records the owner decision and names this repo's
  #89 as the follow-up.
- AttentionDecision v1: `decision IGNORE|CONTINUE|NOTIFY|REQUIRE_APPROVAL`,
  `basis rule|model`; unchanged known digest => IGNORE without a classifier;
  unknown is never unchanged; digest is per resource only; `REQUIRE_APPROVAL` is
  a pointer to an existing `aar_` and never creates or consumes permission.
- Report finding: whole-batch refusal can hide valid notifications.
- Status: fixture evidence only. Live re-observation is unresolved. I did not
  see the external schema text and do not restate it beyond the above.

## 2. Decisions

### D1 Wake cycle = bounded delivery batch (no timer window in the first slice)

Today there is no batch: `handle` processes entries one at a time and
`read_once` merely fetches up to `max_inflight - len(inflight)` of them.
A batch is therefore **new implementation work**. Proposed definition: the
entries returned by one `XREADGROUP` in `read_once`, one `recover_pending` page,
or one `reclaim` page. These have different bounds (free capacity, 100, 50);
`max_inflight` is **not** the batch size for recovery. Proposed explicit cap:
at most `MAX_OBSERVE_PER_BATCH` (proposal 16) distinct resources observed per
batch; resources over the cap get `unknown(observation_budget)` and are
notified (never ignored).

- Within one batch the observation is memoised per resource key (one provider
  call per distinct resource).
- A burst split across two reads can wake twice. No cross-read coalescing is
  claimed. No latency numbers are claimed.
- **No network observation while holding `self._lock`.** The provider is called
  before the lock; under the lock the decision is revalidated against local
  state (section 5) and committed.

### D2 Refusal granularity = per canonical resource

- A resource is `(group, repository, number)` from the subject of a routed
  `github.pull_request*` event. A bad or unknown observation for A yields a
  decision for A only; B in the same batch is decided independently.
- A malformed envelope with no trustworthy resource key (parse failure, or a
  routed event lacking `repository`/`number`) follows the existing audited
  `rejected` + XACK path (`channel.py:358-363`) and touches no resource state.
- **Unknown/unreadable observation never means unchanged.** Chosen transition:
  a valid routed event with unknown observation is **NOTIFY with
  `attention_reason=unknown:<code>`**, `basis=rule`. The session then hydrates
  as the existing contract already requires. It is not auto-acked and not
  retried silently. Codes: `provider_error`, `timeout`, `no_provider`,
  `stale_revision`, `revision_conflict`, `expired`, `capacity`,
  `observation_budget`, `malformed_observation`.

### D3 Routing unchanged

No check-run/check-suite routes, no policy change. The fixture for a
check event uses a policy whose routes do not include those types and expects
the existing `skipped` + XACK path. It does not claim every deployment policy
rejects those types. Same-head pending->failed is modelled as a **fresh
observation of an already-routed PR event** (new digest, same head).

## 3. Contracts

### 3.1 ObservedState (injected, read-only provider)

```
class ObservationProvider(Protocol):
    def observe(self, key: ResourceKey, deadline_s: float) -> ObservedState
```
Never called under the lock. Must not mutate anything. Returns:

```
ObservedState {
  resource:  "<repo>#<number>"       # canonical, must equal the requested key
  known:     bool
  revision:  int | null              # provider-assigned, monotone per resource
  head_sha:  str | null              # bound inside digest; never ordered
  digest:    str | null              # opaque, <=64 chars, [A-Za-z0-9:._-]
  aar_ref:   str | null              # ^aar_[A-Za-z0-9_-]+$ ; pointer only
  unknown_reason: str | null         # when known=false
}
```
Anything not matching this shape (wrong resource, missing digest when known,
bad charset) is `unknown(malformed_observation)`. Which GitHub facts feed the
digest, and whether the provider can supply a monotone `revision`, are **OPEN**
(section 8). Fixtures use synthetic integers; if only timestamps exist the same
comparison rules apply.

### 3.2 ResourceKey

`group | repository(lower-cased) | number(decimal, no leading zeros)`, each part
percent-encoded exactly as `_state_key` does, so group `a`+resource `b:c` and
group `a:b`+resource `c` cannot collide. Different groups never share state.

### 3.3 AttentionDecision

```
AttentionDecision {
  decision: IGNORE | CONTINUE | NOTIFY | REQUIRE_APPROVAL
  basis:    rule | model
  resource: ResourceKey
  covered_event_ids: [str]        # every event this decision covers (coalescing)
  observation: {digest, revision, head_sha} | null
  reason:   str                   # e.g. first_state, digest_changed, unchanged, unknown:timeout
  aar_ref:  str | null
}
```
`decide()` is pure: inputs are the envelope, the observation, the authoritative
record and `now`; no I/O. First slice emits only `basis=rule`; `CONTINUE` is
reserved for a later model-basis step, which is out of scope, and **model
output is never authority** (it cannot suppress, approve or advance state;
only the deterministic rule IGNORE consumes an event without a wake).

Rule table (checked in order):

1. observation unknown/malformed -> NOTIFY `unknown:<code>` (nothing staged)
2. observation.revision < authoritative.revision -> NOTIFY `unknown:stale_revision`,
   authoritative record untouched (no regression)
3. revision equal but digest differs -> NOTIFY `unknown:revision_conflict`
4. no authoritative record (absent, expired, evicted) -> NOTIFY `first_state`
5. digest equals authoritative digest -> **IGNORE** `unchanged`
6. otherwise -> NOTIFY `digest_changed`
7. if the observation carries `aar_ref` and the result is NOTIFY -> decision
   `REQUIRE_APPROVAL` with `aar_ref` (pointer only; no permission is created,
   consumed or checked; `approvals`/`policyCheckpoint` untouched).

### 3.4 Notification (reference-only, closed envelope kept)

`notification_for` gains extra `meta` keys, all identifier-shaped, no content:
`attention_decision`, `attention_basis`, `attention_reason`,
`attention_resource` (`repo#number`), `attention_digest` (opaque),
`attention_covered` (comma-joined event ids, capped), `attention_aar`
(only for REQUIRE_APPROVAL). The envelope schema is not extended. `INSTRUCTIONS`
and the managed `CLAUDE.md` section must mention the new meta together (the
existing test ties them).

## 4. Durable state (proposed keys, all under `mctl:events:state:`)

| Key | Content | Purpose |
|---|---|---|
| `attn-ack:<resource>` | hash `digest, revision, head_sha, event_id, kind, at` | **Authoritative** last successfully acknowledged observation. Only suppression source. TTL `attention_ttl_seconds` (proposal: default `dedup_ttl_seconds`) |
| `attn-pend:<group>:<event_id>` | hash `resource, digest, revision, head_sha, covered, delivered_at` | Staged observation of a delivered notification. **Never** used to suppress. TTL refreshed on each delivery like `ATTEMPT_PREFIX` |
| `attn-index:<group>` | ZSET resource -> expiry | Bound on tracked resources (`MAX_TRACKED_RESOURCES`, proposal 1024) |

Expiry, eviction or capacity exhaustion makes the record absent, which is rule 4
(NOTIFY). Replaying an old event never revives suppression: decisions use the
*current* observation against a *live* record.

## 5. Ordering, ack and retry

### Handle flow (future)

1. parse + route (existing). Derive ResourceKey; none -> existing reject path.
2. advisory `_cached_ack`/`EXISTS` check outside the lock; skip observing
   already-acked duplicates.
3. observe (outside lock, deadline) -> ObservedState or unknown.
4. take `self._lock`; run the existing dedup/in-flight checks (`channel.py:378-400`).
5. under the lock, re-read `attn-ack` (one round trip, same precedent as
   `_was_acked`); if it differs from what step 3 assumed, re-run pure `decide`
   with the same snapshot. Do not re-observe under the lock.
6. act:
   - **IGNORE**: audit `attention_ignored`; `_mark_acked(event_id)`; XACK the
     entry. `attn-ack` is **not** modified (the known digest is retained, not
     advanced). No pending record, no emit, no attempt consumed.
   - **NOTIFY / REQUIRE_APPROVAL**: write `attn-pend` first (idempotent,
     proposal `SET ... NX EX`), then `_bump_attempt`, then emit. A failed emit
     keeps the existing release path (`channel.py:425-430`); the pending record
     is harmless because it suppresses nothing, and the old authoritative
     digest is unchanged, so retry re-decides to NOTIFY.
7. **Successful emit is not acknowledgement. The authoritative digest does not
   move at emit.**

### Advance at model acknowledgement (`ack()`)

On `ack_event`, for the delivered event:

| outcome | commit staged digest to `attn-ack`? |
|---|---|
| `handled` | yes, `kind=handled` |
| `ignored` (model) | **no** (proposal, conservative): a model "ignored" is not deterministic unchanged; a repeat identical observation notifies again. Operator may later opt to commit with `kind=model_ignored`; that is a gate |
| `failed` | no |
| unknown event / not in flight | no (existing `status:"unknown"`) |

Commit is a **compare-and-set**: write only if staged `revision` > stored
revision (or no record), so a late ack of an older event cannot regress, and an
ack of event A never touches resource B. Coalesced decisions commit once and
mark every `covered_event_ids` entry (dedup marker + XACK).

Order inside `ack()`: (a) CAS digest + dedup marker (+ index update) **atomically**;
(b) XACK entries; (c) drop in-flight. Crash analysis:

- before (a): nothing durable; entry redelivered; decides as before -> at-least-once.
- between (a) and (b): marker exists; redelivery is acked silently by the
  existing duplicate path (`channel.py:378`). The model had already reported the
  outcome, so nothing unhandled is suppressed.
- between (b) and (c): in-memory only; lost on restart.
- emit ok then crash before model ack: pending record only; authoritative
  digest old; redelivery notifies again.
- failed ack write (Valkey down): tool errors, event stays in flight, a retried
  `ack_event` completes it (existing behaviour, `channel.py:714-716`).

Atomicity needs: **Lua (EVAL) or WATCH/MULTI/EXEC** for the CAS+marker+index
write. Whether the adapter's ACL user may run `EVAL`/`MULTI` is **unknown**; I
did not inspect it and propose no ACL change. Fallback without scripting:
CAS-less ordered writes (digest, then marker, then XACK); the only extra window
is a concurrent same-group consumer racing two acks on the same resource, which
degrades to one extra wake, never to a lost one, provided commits only move
revision forward at read-check time. The implementation task must pick one after
confirming ACL.

### Multi-instance

Keys are group-scoped. Two consumers in one group (reclaim path) may both
decide NOTIFY for the same resource: two wakes, accepted (at-least-once). The
revision CAS keeps the authoritative record monotone. Separate groups are fully
independent.

## 6. Caps and TTL

- Pending records: at most one per in-flight event, bounded by
  `max_inflight` x `MAX_ENTRIES_PER_EVENT`; TTL proposal = `dedup_ttl_seconds`,
  refreshed on redelivery.
- Tracked resources: `MAX_TRACKED_RESOURCES` per group via `attn-index`
  eviction of the oldest expiry; evicted = absent = NOTIFY (never "unchanged").
- Provider calls: `MAX_OBSERVE_PER_BATCH`; provider deadline value is OPEN.
- `attention_ttl_seconds` default may equal `dedup_ttl_seconds` (86400, `policy.py:59`);
  a new policy field would be needed, so it is a future `policy.py` change.

## 7. Smallest future allowlist (provisional, authorizes nothing now)

Runtime: `events/mctl_events/attention.py` (new, pure `decide` + types),
`channel.py` (insertion in `handle`, `ack`, `notification_for`, `INSTRUCTIONS`),
`policy.py` (`attention_ttl_seconds`, enable flag).
Contract mirror: `entrypoint.sh` managed contract section and
`tests/test_entrypoint_events_contract.py` if the instructions text changes.
Tests: `events/tests/test_attention.py` (new), `events/tests/test_channel.py`.
No installer, workflow, dependency or host change is implied.

## 8. Gates (open, not decided here)

1. **ObservedState source/authorization/freshness**: producer field, separate
   stream, or adapter-side fetch is undecided; the envelope stays closed. Any
   GitHub read needs credentials this repo does not hold; none requested. Needs
   independent agreement on source, authz, timeout, freshness and error
   contract. With no provider configured every event is
   `unknown:no_provider` -> NOTIFY (today's behaviour), so a deployment without
   a source is functionally the status quo but **not ready** for attention.
2. Digest field set and whether a monotone `revision` exists.
3. ACL: `EVAL`/`MULTI` permission for the adapter user.
4. TOCTOU: the observation is a snapshot; IGNORE means "unchanged versus the
   last acknowledged observation", never "the PR is unchanged now". Claude still
   hydrates from the source of record for every notification.
5. Operator choice on model-`ignored` commit semantics.
6. Activation (default off flag, rollout) is a separate operator decision.

## 9. Verification performed for this doc

- `python3 -m unittest discover -s events/tests -p "test_*.py"`: 251 tests ran
  (about 166 s), `FAILED (errors=1)`. The one error is
  `test_telegram_token.RenewTest.test_an_unreadable_error_body_is_a_failed_renewal`
  (`mock.patch.object` KeyError on `tempfile` wrapper under system Python 3.9,
  unrelated to the channel code). I did not count skips; Valkey-backed channel
  tests produced adapter logs, so they executed in this environment.
- Fixture file validated with `python3 -m json.tool`.
- Not done: no live hydration, network, GitHub, credentials, external-doc fetch,
  or ACL inspection. Fixture expectations are derived from the agreed rules
  above, not from an implementation (none exists).
