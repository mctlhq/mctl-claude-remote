---
name: pr-steward
description: Autonomous pull-request steward for a persistent Claude Code remote-control session. Each invocation runs ONE tick - it discovers in-scope PRs, waits for a code-review bot (claude[bot] / chatgpt-codex-connector[bot]) via the codex-watch skill, applies fixes for P1/P2 findings, re-triggers the review, and either escalates to a human (merge_mode=never) or auto-merges once the review is clean+approved and CI is green (merge_mode=when-green). All target repos, filters, thresholds, the merge mode and the escalation channel come from a config file - nothing org-specific is baked in. Invoke when the operator (or a scheduled RemoteTrigger routine) says "run the pr-steward skill" / "run a steward tick".
---

# pr-steward — autonomous PR review/fix loop (one tick per invocation)

This skill turns the persistent remote-control session into a stand-in operator for
review-driven PRs. It is **off by default**. Merging is gated by `merge_mode`:
`never` (escalate to a human, the conservative default) or `when-green` (auto-merge
once the review is clean and **approved** and CI is green — see §8). Even in
`when-green` it never merges anything that fails the head-SHA-anchored
clean+approved+green gate or the `head_prefix` ownership gate.

It is *stateless per tick*: all durable state is reconstructed from GitHub (PR labels
+ PR JSON + the `codex-watch` result file). A pod restart loses nothing.

## 0. Gate — refuse to run unless explicitly enabled

```sh
[ "${PR_STEWARD_ENABLED:-false}" = "true" ] || { echo "pr-steward: disabled (PR_STEWARD_ENABLED!=true); no-op"; exit 0; }
```

If `PR_STEWARD_ENABLED` is not exactly `true`, **stop immediately**. Do not list PRs,
do not touch GitHub. This is the kill switch.

## 1. Load config

Config path: `${PR_STEWARD_CONFIG:-/workspace/pr-steward.config.json}`. Read it once.
Keys (see `pr-steward.config.example.json`):

| Key | Meaning |
|---|---|
| `merge_mode` | `"never"` (default — escalate ready-to-merge to a human, no merge call) or `"when-green"` (auto-merge once the §8 gate holds). Any unrecognized value → treat as `"never"` and log a warning. **Per-repo override:** a `repos[]` entry MAY set its own `merge_mode`; the effective mode for a PR is `repo.merge_mode ?? merge_mode ?? "never"` — so different repos can run different modes (e.g. one repo `when-green`, the rest `never`). |
| `merge_method` | Merge style for `when-green`: `"merge"` (default), `"squash"`, or `"rebase"`. Default `"merge"` — keep the feature branch visible in the graph unless a repo opts out. **Per-repo override:** a `repos[]` entry MAY set its own `merge_method`; the effective method is `repo.merge_method ?? merge_method ?? "merge"`. |
| `max_attempts` | Max fix iterations per PR before escalating (default 3). |
| `max_update_attempts` | Max `gh pr update-branch` attempts on a `BEHIND` PR before terminal escalation (default 5). Bounds the update→re-check→behind-again race on a high-velocity base branch: after this many auto-updates without a merge, the PR can't keep up with `main` churn → escalate for a human (§8.2). |
| `auto_resolve_bot_threads` | `true` (default) → on a `when-green` PR that is `BLOCKED` **solely** by unresolved review threads where every unresolved thread is authored by a `review_bots[]` login and carries no P1/P2, the steward resolves those threads so `required_conversation_resolution` branch protection doesn't wedge an approved PR on the bot's own non-blocking nits (§8.3). NEVER resolves a human-authored thread or a P1/P2 thread — those escalate. `false` → always escalate on `BLOCKED`. |
| `max_files_changed` | Per-fix-attempt cap: if a fix would touch more than this many files, escalate instead of pushing (default 10). |
| `max_diff_lines` | Per-fix-attempt cap on total added+removed lines; exceed → escalate, no push (default 300). |
| `forbidden_paths[]` | Glob paths a fix must never touch (default `[".github/workflows/**", "**/secrets/**", "deploy/**", "**/values.yaml", "**/values.yaml.tpl"]`). A finding that can only be fixed by editing one of these → escalate (out of scope). |
| `stuck_hours` | Escalate an owned PR with no head-SHA progress after this many hours. |
| `tick_lock_stale_minutes` | Lockfile staleness window. |
| `label_prefix` | Label namespace (default `steward`). |
| `review_trigger` | Comment text that triggers the review bot (e.g. `@claude review`). |
| `review_bots[]` | Bot logins codex-watch should match. v1 pilots are Claude-only: `["claude[bot]"]`. Add `"chatgpt-codex-connector[bot]"` only once dual-bot gating is supported. |
| `repos[]` | `{ name: "owner/repo", pr_filter: { head_prefix?, author?, labels[]? }, merge_mode?, merge_method? }`. All filter keys optional; see §4. `merge_mode`/`merge_method` are optional per-repo overrides of the top-level defaults (above). |
| `github_app.token_file` | Path the refresh loop writes the installation token to. |
| `gitops` | Optional `{ repo, agents_state_path, branch_prefix }` for the best-effort `.status.yaml` write-back after a `when-green` merge (see §8.1). Omit to skip write-back. |
| `escalation` | `{ channel, ... }` — how to ping a human. |
| `logging.file` | Path for the structured log (also echoed to stdout). |

Compute `LP="${label_prefix}"` for label names below.

## 2. Authenticate as the GitHub App (no token ever on a command line)

The entrypoint refresh loop keeps a fresh installation token in
`github_app.token_file`. `gh` and `git` need it via two different paths — do NOT
rely on `gh auth setup-git`, which fails when no host has been authenticated via
`gh auth login` (a fresh steward workspace has none):

```sh
HOST="${GH_HOST:-github.com}"
# gh CLI (pr list / comment / repo clone): env token, no persisted auth state.
case "$HOST" in
  github.com|*.ghe.com) export GH_TOKEN="$(cat "$TOKEN_FILE")" ;;   # github.com / GHEC
  *)                    export GH_ENTERPRISE_TOKEN="$(cat "$TOKEN_FILE")" ;;  # GHES host
esac
# git push/clone: a credential helper that re-reads the token file on every call
# (so a background-rotated token is picked up) and never embeds it in a URL.
git config --global "credential.https://${HOST}.helper" \
  '!f() { echo username=x-access-token; echo "password=$(cat '"$TOKEN_FILE"')"; }; f'
```

- Never `echo`/log the token. Never build a `https://x-access-token:...@github.com` URL.
- On any GitHub `HTTP 401`: re-read the token file once (the refresh loop may have just
  rotated it) and retry. If still 401, log `result=auth_error reason=token_invalid`
  and end the tick (do **not** burn a fix attempt — this is transient).

## 3. Acquire the tick lock

```
LOCK=/workspace/.steward.lock
```
If `$LOCK` exists and its `started_at` is younger than `tick_lock_stale_minutes`,
log `action=skip reason=locked` and exit 0. Otherwise write
`{tick_id, started_at, pid}` (mode 0600) and remove it at the end of the tick
(including on error).

`tick_id` = UTC timestamp (e.g. `20260521T101500Z`). Use it in every log line.

## 4. Discover in-scope PRs

For each repo in `repos[]`:

```sh
gh pr list -R "$REPO" --state open --limit 200 --json number,headRefName,headRefOid,author,labels,isDraft,mergeStateStatus,reviewDecision,url \
  --search "<filter>"
```

**Do NOT request `statusCheckRollup` in this list query.** `gh pr list` resolves through
GitHub's GraphQL **search** API, and a GitHub App installation token is denied there with
`Resource not accessible by integration` on `search.nodes[].status` — which fails or empties
the whole list and wedges the tick. Check status is only needed per-PR; fetch it in §5 via
the single-PR node + REST fallback, both of which App tokens can read.

Build the server-side search from every `pr_filter` key that maps to a GitHub search
qualifier — push as much filtering server-side as possible so the result set is small
and pagination-safe:
- `author` → `author:<login>`
- each `labels[]` entry → `label:<name>`
- `head_prefix` → `head:<prefix>` — GitHub's `head:` qualifier matches **by branch-name
  prefix** (e.g. `head:feat/agents-` matches `feat/agents-foo` but not `fix/...`), so the
  prefix discriminator belongs in the search, not just client-side.

Pass `--limit 200` (above the 30 default) so that even a permissive filter on a busy
repo does not silently drop in-scope PRs past the first page. Skip drafts
(`isDraft=true` → `action=wait reason=draft`).

**`head_prefix` is still re-checked client-side as a hard gate** (defense-in-depth):
after listing, **drop any PR whose `headRefName` does not start with
`pr_filter.head_prefix`** (string prefix, case-sensitive). The `head:` search qualifier
is case-insensitive and could in principle widen on edge cases, so the client-side
exact-prefix check is the authoritative gate. `head_prefix` is the primary discriminator
when an automated author opens PRs under the same identity as humans (e.g. an implementer
that pushes `feat/agents-<slug>` branches via a shared token): the branch prefix is what
separates steward-owned PRs from human PRs, so when `head_prefix` is set it is a hard
gate — a PR that fails it is never owned, even if `author`/`labels` would match.

If `pr_filter` has no keys at all, the steward would match every open PR in the repo;
treat an empty filter as a misconfiguration and `action=skip reason=empty-pr-filter`
rather than touching unfiltered PRs.

On first pickup of a PR (one that passed every filter), add label `${LP}:owned`. Treat
any PR carrying `${LP}:owned` as in scope even if the filter would otherwise miss it
(so we keep finishing a PR whose branch/labels change mid-flight) — but a PR that fails
`head_prefix` and does **not** already carry `${LP}:owned` is out of scope.

## 5. Per-PR decision (mirror of run_shepherd.py `decide()`)

For each in-scope, non-draft PR compute:
- `effective_merge_mode` = the PR's repo entry `merge_mode` if set, else top-level
  `merge_mode`, else `"never"`. An unrecognized value → treat as `"never"` + log a warning
  (same rule as §1). `effective_merge_method` = repo entry `merge_method` ?? top-level
  `merge_method` ?? `"merge"`. Everywhere below, "`merge_mode`" / "`merge_method`" mean
  these per-PR **effective** values — so the merge gate is decided per repo, not globally.
- `head = headRefOid`
- `checks_green` = every required check is SUCCESS/NEUTRAL/SKIPPED, from the check status
  fetched per the **App-token-safe procedure below** (the §4 list no longer carries it)
- `mergeable` = `mergeStateStatus` ∈ {`CLEAN`,`HAS_HOOKS`,`UNSTABLE`}
- `behind` = `mergeStateStatus == "BEHIND"` — head is out of date with base. Under strict
  branch protection (`require branches to be up to date`) this is **auto-fixable** via §8.2
  (`gh pr update-branch`); it is NOT a conflict and must NOT be terminally escalated.
- `blocked` = `mergeStateStatus == "BLOCKED"` — a branch-protection rule is unmet (often
  `required_conversation_resolution` with unresolved review threads). May be auto-fixable
  via §8.3 when the only blockers are the review bot's own non-blocking threads.
- `dirty` = `mergeStateStatus == "DIRTY"` — a real merge conflict. Needs a human → §9.
- `approved` = `reviewDecision == "APPROVED"` — branch protection's required-review
  verdict. The review bot's APPROVED review (e.g. `claude-review.yml` approving when
  it finds no P1/P2) is what flips this. This is the merge gate that lets the App
  land code without weakening branch protection (the App never bypasses required
  reviews — it waits for the bot's approval).
- `attempt` = highest N from any `${LP}:attempt-N` label (0 if none)
- review state — via §6 (codex-watch)

**Fetching check status (App-token safe — never hang).** The §4 list omits
`statusCheckRollup` because the search API denies it to App tokens. Resolve it per-PR with a
fallback chain, and if it cannot be determined, escalate rather than block:
1. `gh pr view <N> -R "$REPO" --json statusCheckRollup` — the single-PR node IS readable by
   App installation tokens (unlike `search.nodes[].status`).
2. On error (`Resource not accessible by integration`, or any failure) fall back to REST,
   which only needs Checks:read / commit-status:read:
   ```sh
   # MUST paginate: check-runs returns 30 per page by default, so a failing run on a
   # later page would be silently missed and could let a bad PR merge in when-green.
   gh api --paginate "repos/$REPO/commits/$head/check-runs?per_page=100" \
     --jq '.check_runs[].conclusion'
   gh api "repos/$REPO/commits/$head/status" --jq '.state'
   ```
   Evaluate the **full paginated set** of check-run conclusions (`.state` from
   `/status` is a server-side rollup over all legacy statuses, so it needs no
   pagination — use it only as a failure signal, never as a green requirement, since
   a repo with no legacy statuses reports `pending`):
   - **Failed** (not green → §9 build-failure path): any conclusion in
     {`failure`,`cancelled`,`timed_out`,`action_required`,`startup_failure`}, or
     `.state == "failure"`.
   - **Not green yet** (`action=wait reason=awaiting-checks`): any conclusion is
     `null` (a run still executing reports `conclusion: null`) or `stale`, or the
     check-run set is empty with `.state == "pending"`.
   - **`checks_green = true`** only when **every** conclusion ∈
     {`success`,`neutral`,`skipped`} (none `null`/`stale`) **and** `.state ≠ failure`.
     Treat any conclusion outside that allow-list as not-green — never default an
     unrecognized or in-progress conclusion to green.
3. If BOTH the node query and REST fail, treat checks as **unknown** — do NOT retry in a loop
   and do NOT hang: `action=escalate reason=checks-unavailable`, send ONE §9 non-review
   escalation, stop for this PR. (`merge_mode=when-green` must never merge on unknown checks.)

Apply, in order:

| Condition | Action |
|---|---|
| PR merged or closed externally | remove all `${LP}:*` labels; `action=drop` |
| review bot has not responded for current `head` yet | `action=wait reason=awaiting-review` |
| **P1/P2 findings at current `head`** | if `attempt >= max_attempts` → **escalate (max-attempt)**, add `${LP}:escalated`, stop. Else → **§7 apply fix** |
| no P1/P2, `mergeable`, `checks_green`, `approved`, **`effective_merge_mode=when-green`** | **§8 merge** — re-verify at head, then `gh pr merge`. |
| no P1/P2, `mergeable`, `checks_green` (and either `effective_merge_mode=never` or not yet `approved`) | **§8 ready-to-merge escalation** — add `${LP}:ready-to-merge`, ping once, **DO NOT MERGE** |
| no P1/P2, `checks_green`, `approved`, `effective_merge_mode=when-green`, in-scope, **`behind`** (and not `dirty`) | **§8.2 bring branch up to date** — `gh pr update-branch`; do NOT merge this tick |
| no P1/P2, `checks_green`, `effective_merge_mode=when-green`, **`blocked`**, and `auto_resolve_bot_threads` is true | **§8.3 evaluate blocking threads** — §8.3 classifies the unresolved threads, resolves them if all are bot-only nits, else escalates; do NOT merge this tick |
| no P1/P2, **`behind` or `blocked`** in a repo whose `effective_merge_mode` is **not** `when-green` | **§9 ready-to-merge / non-review escalation** — the steward does not auto-advance branches it will not merge; a human merges (and updates the branch). Treat like the `never` ready-to-merge path. |
| no P1/P2 findings but `dirty` (real conflict) / checks not green / build failure NOT from review / `blocked` for any other (non-thread) reason | **§9 non-review escalation** |
| watcher timed out | §6 timeout handling |

Only ever match findings **at the current head SHA**. codex-watch's trigger-timestamp
baseline already enforces this — never reuse a pre-fixup review. `approved` is likewise
head-anchored: a fix push (a `synchronize`) re-runs `claude-review.yml`, and with
"dismiss stale approvals on push" enabled the prior approval is cleared until the bot
re-approves the new head — so `approved` cannot be satisfied by an approval of older code.

## 6. Reading the review — delegate to the `codex-watch` skill

codex-watch is the eyes: a detached watcher that polls `review_bots`, filters by the
latest `review_trigger` comment timestamp, parses P1/P2/P3 badges, and writes
`/tmp/codex-watch-<repo-stem>-<N>.result`.

Per PR, per tick:
1. Ensure a fresh review baseline exists for the **current head**. If there is no
   `review_trigger` comment newer than the last head push, post one
   (`gh pr comment <N> -R $REPO --body "<review_trigger>"`). This re-triggers a
   comment-driven reviewer (e.g. codex) and gives codex-watch a fresh baseline
   timestamp. Note: an Action-based reviewer such as `claude-review.yml` fires on
   `pull_request` events — i.e. the fix **push** in §7 (a `synchronize`), NOT on the
   comment — so never rely on the comment alone to schedule a new Action run.
2. If no watcher result file exists for this PR+baseline, launch a watcher (see the
   `codex-watch` skill's "Launch a watcher" section) and `action=wait reason=watcher-launched`.
3. If a result file exists:
   - `status=responded` → parse the `---comments---`/`---reviews---` sections, extract
     `P1`/`P2` badge tokens. Beware the **claude[bot] progress-checklist false-clean**
     caveat (a `- [ ]` / "View job run" body means the review is still running → treat
     as `awaiting-review`).
   - `status=timeout` → the reviewer never responded. For a comment-driven reviewer
     and if `${LP}:reposted` is absent: re-post `review_trigger`, relaunch the watcher,
     add `${LP}:reposted`, `action=wait reason=review-timeout-reposted`. For an
     Action-based reviewer a repost will NOT schedule a run (only a new push does), so a
     persistent timeout means investigate. If `${LP}:reposted` is already present (or the
     reviewer is Action-based with no new push pending): **§9 escalate** (bot silent twice).

## 7. Apply a fix (P1/P2 findings present, attempt < max)

1. Add `${LP}:fixing`.
2. Clone/refresh into a temp dir and check out the PR branch:
   `gh repo clone $REPO /tmp/steward-<repo-stem>-<N> -- --branch <headRefName>` (or
   `git fetch origin <branch> && git checkout <branch>` if already cloned).
3. Address each P1/P2 finding in the worktree. Keep edits minimal and scoped to the
   finding — no opportunistic refactors.
4. **Safety envelope — verify BEFORE committing; if any check fails, abort the fix,
   add `${LP}:escalated`, send a `non-review` escalation (reason `scope-guard`), and
   stop acting on this PR. Never push a fix that violates these:**
   - `git diff --name-only` count ≤ `max_files_changed`.
   - `git diff --numstat` total added+removed lines ≤ `max_diff_lines`.
   - No changed path matches any `forbidden_paths[]` glob (workflows, secrets, deploy
     manifests, `values.yaml`). A finding only fixable by editing those is out of
     scope for the steward — escalate, don't push.
   - No dependency-manifest version changes (`package.json`/`go.mod`/lockfiles) unless
     a P1/P2 finding explicitly calls for the bump.
   - **Scope expansion**: if the fix touches files outside the set the original PR
     diff already changed, treat it as scope expansion → escalate. The steward fixes
     review findings on the PR's own surface; it does not grow the change.
   - Only ever push to the PR's own `feat/agents-*` head branch; **never force-push**
     (no `git push --force`/`+ref`). A non-fast-forward push means someone else moved
     the branch — abort and re-evaluate next tick.
5. Commit (`fix: address review findings`) and `git push` (App identity via the
   credential helper from §2).
6. Re-post `review_trigger` and relaunch the watcher for the new head.
7. Bump the attempt label: remove `${LP}:attempt-{n}`, add `${LP}:attempt-{n+1}`.
   Remove `${LP}:fixing` and `${LP}:reposted`.
8. **Attempt accounting** (mirror run_shepherd.py:1146-1202):
   - *transient* push failure (auth/network) → do NOT bump the attempt; leave state for
     next tick; `result=transient_fail`.
   - *deterministic* outcome (no commits produced, or branch missing on origin) → DO
     bump the attempt; if it reaches `max_attempts`, escalate (max-attempt).
9. `action=address-review result=pushed attempt=<n+1>`.

## 8. Clean + green: merge (when-green) or escalate (never)

A PR reaches this section when it has no P1/P2 at head, is `mergeable`, and
`checks_green`.

### effective_merge_mode = never (default) — escalate, do not merge
- Add `${LP}:ready-to-merge` (idempotent — if already present, do nothing and do NOT
  ping again).
- Send ONE escalation (§10, template `ready-to-merge`).
- **Do not run `gh pr merge`.** A human merges.

### effective_merge_mode = when-green — gated auto-merge
Only proceed if **`approved`** is also true (§5). If not approved yet, fall back to the
`never` branch above (escalate ready-to-merge / wait for the bot's approval) — the
steward never bypasses branch protection.

1. **Re-verify at head.** Re-fetch the PR JSON
   (`gh pr view <N> -R $REPO --json headRefOid,mergeStateStatus,statusCheckRollup,reviewDecision`).
   `gh pr view` is a single-PR node, so `statusCheckRollup` is App-readable here; if it still
   errors, use the §5 REST fallback. If checks come back **unknown** (both the node query
   and the REST fallback fail at re-verify), do **not** merge and do **not** loop on `wait`
   — a silent `wait` here recreates the exact hang this design avoids. Instead
   `action=escalate reason=checks-unavailable`, send ONE §9 non-review escalation, and stop
   for this PR (same as §5 step 3). Never merge on unknown.
   If `headRefOid` differs from the `head` you evaluated, a push landed mid-tick →
   `action=wait reason=head-moved`, next tick re-evaluates. Re-confirm `mergeable`,
   `checks_green`, `approved` on the fresh JSON.
2. **Merge the exact reviewed SHA:**
   ```sh
   gh pr merge <N> -R "$REPO" --"${effective_merge_method:-merge}" --delete-branch --match-head-commit "$head"
   ```
   `--match-head-commit` makes GitHub reject the merge if the head moved since step 1,
   so a race can never smuggle unreviewed code through. On mismatch/error →
   `action=wait`, next tick re-evaluates (do NOT retry-loop within the tick).
3. On success: add `${LP}:merged`, remove `${LP}:ready-to-merge`/`${LP}:owned`, run the
   best-effort status write-back (§8.1), send ONE `merged` notification (§10).
4. `action=merge result=merged head_sha=<head>`.

### 8.1 Best-effort `.status.yaml` write-back (when-green only)

The merged PR is the source of truth; this write-back is reconciliation/audit and is
**non-blocking — a failure NEVER rolls back the merge.** Skip entirely if `gitops` is
not configured.

Derive the proposal from the PR branch: `service` = repo stem (e.g. `mctl-design`),
`slug` = `headRefName` with the `gitops.branch_prefix` (`feat/agents-`) stripped.
Target file: `<gitops.agents_state_path>/<service>/proposals/<slug>/.status.yaml`.

1. Clone/refresh `gitops.repo` shallow into a temp dir (App credential helper from §2).
2. Update the file: `status: merged`, `merged_at: <iso>`, `merge_commit: <sha>`,
   `pr: <url>`, `updated_by: mctl-claude-remote[bot]`. Preserve all other keys.
3. Commit `chore(agents-state): mark <service>/<slug> merged (#<N>)` and push to the
   default branch with **pull --rebase retry** (up to 3 times — the file is tiny and
   contention on the gitops mutex is low).
4. If the file does not exist (hand-written PR with no proposal) → log
   `result=status_skip reason=no-proposal`, do nothing else.
5. If the push still fails after retries → log `result=status_write_failed`, send ONE
   `non-review` escalation (reason `status-writeback`), and leave the proposal as-is.
   The read-only reconciler in mctl-agents will repair the drift later. Do not retry
   destructively.

## 8.2 Bring a BEHIND branch up to date (when-green only)

A PR reaches this section when it has **no P1/P2 at head, `checks_green`, `approved`,
`effective_merge_mode=when-green`, passed the ownership gate, and `behind`** (head out of
date with base) — but is otherwise mergeable. This is the common case under strict branch
protection on a high-velocity base branch: `main` advanced between approval and this tick.
The steward brings the branch current rather than merging stale code or escalating — it
**never weakens the gate**, it makes the branch satisfy it.

`update_attempt` = highest N from any `${LP}:update-attempt-N` label (0 if none).

1. **Cap check FIRST** (before any de-escalation — order matters). If
   `update_attempt >= max_update_attempts`, do NOT update again: the PR keeps losing the race
   to base churn → `action=escalate reason=behind-max-update-attempts`. Add `${LP}:escalated`
   **idempotently** — if it is already present, do NOT remove-then-re-add it and do NOT re-ping
   (the §9 dedupe pings only on the transition *into* escalated). Stop for this PR. Doing the
   cap check before de-escalation is what prevents a flip-flop (de-escalate → immediately
   re-escalate) that would re-ping the human every tick once the cap is hit.
2. **De-escalate (only reached when under the cap).** If the PR carries `${LP}:escalated` from
   a prior tick that escalated this same BEHIND state (now auto-fixable), remove it — the PR is
   no longer human-stuck. Keep `${LP}:owned`.
3. **Update the branch — merge base into head, never rebase/force:**
   ```sh
   gh pr update-branch <N> -R "$REPO"
   ```
   This creates a merge commit of base into the PR head via the GitHub API (App
   `contents:write`). It is a `synchronize` event: with "dismiss stale approvals on push",
   the bot approval is dropped and `claude-review.yml` + required checks re-run on the new
   head. **Do NOT merge this tick** — the head just changed and is unreviewed/unchecked
   until the bot re-approves and checks go green. A later tick re-evaluates the refreshed
   head and merges via §8 when clean+green+approved+`CLEAN`.
4. On success: bump the attempt label (remove `${LP}:update-attempt-{n}`, add
   `${LP}:update-attempt-{n+1}`), keep `${LP}:owned`,
   `action=update-branch result=updated attempt=<n+1>`.
5. On failure:
   - "merge conflict" / the API reports the branch is actually `DIRTY` → this is a real
     conflict, not a stale branch → §9 escalate (reason `conflict`).
   - "already up to date" / not behind → the head moved since §5 → `action=wait reason=head-moved`,
     next tick re-evaluates. Do NOT loop within the tick.
   - `HTTP 401` → re-read the token once and retry per §2; if still failing, `auth_error`.
   - any other error → `action=escalate reason=update-branch-failed`, ONE §9 escalation.

## 8.3 Resolve bot-only blocking threads (when-green only)

A PR reaches this section when `effective_merge_mode=when-green`, no P1/P2 at head,
`checks_green`, and `blocked` (and `auto_resolve_bot_threads` is true). `BLOCKED` under
`required_conversation_resolution` means an unresolved review thread is wedging an approved
PR — typically the review bot's own non-blocking nit (e.g. a P3 it left while approving).

1. **Fetch ALL review threads — paginate; never decide on a partial set.** A `first:50`
   snapshot can hide a human/P1-P2 thread past position 50, which would let the steward
   resolve bot nits and loop forever without ever seeing (or escalating) the real blocker.
   Page through `reviewThreads` via `pageInfo.endCursor` until `hasNextPage == false`,
   accumulating every node. Fetch **all** comments per thread (paginate `comments` too if a
   thread has `>100`), because a thread can start as a bot nit and gain a human reply or a
   P1/P2 follow-up — classification must see the whole thread, not just the opening comment.
   ```sh
   gh api graphql -f query='
     query($owner:String!,$repo:String!,$num:Int!,$cursor:String){
       repository(owner:$owner,name:$repo){ pullRequest(number:$num){
         reviewThreads(first:100, after:$cursor){
           pageInfo{ hasNextPage endCursor }
           nodes{ id isResolved
             comments(first:100){ nodes{ author{login} body } } } } } } }' \
     -F owner=<owner> -F repo=<repo> -F num=<N> -F cursor=<endCursor-or-omit>
   ```
   If pagination cannot complete (an API error mid-paging) → do NOT auto-resolve on the
   partial set: `action=escalate reason=threads-unenumerable`, §9, stop for this PR.
2. Consider only `isResolved == false` threads. Classify each across **every** comment in it:
   - **needs-human** if **any** comment in the thread has an author login NOT in
     `review_bots[]`, OR **any** comment carries a P1/P2 marker (`![P1`/`![P2` badge or
     `P1 —`/`P2 —` lead). Human involvement or a P1/P2 anywhere in the thread → human.
   - **bot-nit** otherwise = every comment is from a `review_bots[]` login and none carries
     a P1/P2 marker.
3. **Decision:**
   - If there are unresolved threads and **every** one is a bot-nit → resolve each:
     ```sh
     gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<threadId>
     ```
     De-escalate if `${LP}:escalated` is present (remove it, as in §8.2 step 2). Keep `${LP}:owned`.
     **Do NOT merge this tick** — re-evaluate next tick (the PR should become `CLEAN`, or
     `behind` → §8.2). `action=resolve-threads result=resolved count=<n>`.
   - If **any** unresolved thread is needs-human → `action=escalate reason=unresolved-threads`,
     add `${LP}:escalated`, ONE §9 escalation. A human resolves P1/P2 / human threads.
   - If `blocked` but there are **no** unresolved threads (blocked for some other reason —
     missing required check, etc.) → `action=escalate reason=blocked-other`, §9.

## 9. Non-review / stuck escalation

For: CI/build failure not originating from a review finding, a real merge conflict
(`mergeStateStatus=DIRTY`), bot silent twice, or an owned PR with no head progress for
`> stuck_hours`. **`BEHIND` is NOT a §9 escalation — it is auto-advanced in §8.2; a
`BLOCKED` PR whose only blockers are the review bot's own non-blocking threads is
auto-advanced in §8.3.** A `BEHIND`/`BLOCKED` PR only reaches §9 when §8.2/§8.3 explicitly
route here (a real conflict, `max_update_attempts` exhausted, an unresolved human/P1-P2
thread, or a block for some other reason):
- Add `${LP}:escalated` (idempotent — ping only on the transition into this state).
- Send ONE escalation (§10, template `non-review` or `max-attempt` as appropriate).
- Stop acting on this PR until a human removes `${LP}:escalated`.

## 10. Escalation channel (config-driven)

Read `escalation`. For `channel: "telegram"`, send the message to the configured peer
using the Telegram MCP send tool available in this session. Keep one ping per state
transition (the `${LP}:ready-to-merge` / `${LP}:escalated` labels are the dedupe).

Templates (`{...}` from PR context):
- **ready-to-merge:** `✅ {repo}#{pr} clean & green ({p1}P1/{p2}P2). Ready to merge — your call. {url}`
- **merged:** `🚀 {repo}#{pr} auto-merged (clean + approved + green). Deploy rolling out. {url}`
- **max-attempt:** `⛔ {repo}#{pr} stuck after {attempts} fix attempts; P1/P2 persist: {summaries}. Human triage needed. {url}`
- **non-review:** `⚠️ {repo}#{pr} {failure_type} (not a review finding): {detail}. Out of steward scope. {url}`

The `merged` template is a notification, not a "your call" ping — it tells the operator
a merge already happened. Only used in `merge_mode=when-green`.

## 11. Structured logging

One JSON line per PR action, appended to `logging.file` and echoed to stdout:

```json
{"ts":"<iso>","tick_id":"<id>","repo":"owner/repo","pr":123,"head_sha":"<sha>","attempt":1,"action":"address-review","result":"pushed","reason":"","p1":1,"p2":0,"p3":2}
```

NEVER include a token, JWT, or any `ghs_`/`sk-ant-` string. If a value might contain
one, redact it to `***`.

## 12. End of tick

Release the lock (`rm -f $LOCK`). Summarize counts to stdout
(`tick <id>: <waited> waited, <fixed> fixed, <ready> ready-to-merge, <escalated> escalated`).
Do not loop — one tick per invocation. The RemoteTrigger routine fires the next tick.

## Anti-patterns (do not regress)

1. **Ungated merging.** Only merge when the PR's `effective_merge_mode` (per-repo override
   or top-level default — §5) is `when-green` AND the full head-SHA-anchored gate holds: no
   P1/P2, `mergeable`, `checks_green`, `approved` (`reviewDecision==APPROVED`), and the PR
   passed the `head_prefix` ownership gate. With `effective_merge_mode=never`, escalate and
   never call `gh pr merge`. Never bypass branch protection — wait for the bot's approval
   rather than merging unapproved code.
2. **Token leakage.** No token on a command line, in a remote URL, or in any log.
3. **Matching a stale review.** Always key findings to the current head SHA via the
   codex-watch trigger baseline.
4. **Burning an attempt on a transient failure.** Only deterministic outcomes count.
5. **Re-pinging on every tick.** Escalations are gated by labels; one ping per transition.
6. **Running while disabled.** Honor `PR_STEWARD_ENABLED` and the lockfile.
7. **Terminally escalating a transient `BEHIND` / bot-thread block.** A `BEHIND` PR is
   brought current with `gh pr update-branch` (§8.2); a `BLOCKED` PR wedged only by the
   review bot's own non-blocking threads has them resolved (§8.3). Only a real conflict
   (`DIRTY`), exhausted `max_update_attempts`, an unresolved human/P1-P2 thread, or another
   block reason gets the terminal `${LP}:escalated`. Auto-advance states keep `${LP}:owned`
   (non-terminal) so the precheck keeps surfacing them across ticks until they merge.
8. **Merging in the same tick as an update-branch or thread-resolve.** Both change the
   mergeability inputs (a new head dismisses approval + re-runs checks; resolving a thread
   needs GitHub to recompute `mergeStateStatus`). Always defer the merge to a later tick
   that re-verifies the fresh head against the full §8 gate. Never weaken the gate to merge
   sooner — bring the branch into compliance instead.
