---
name: pr-steward
description: Autonomous pull-request steward for a persistent Claude Code remote-control session. Each invocation runs ONE tick - it discovers in-scope PRs, waits for a code-review bot (claude[bot] / chatgpt-codex-connector[bot]) via the codex-watch skill, applies fixes for P1/P2 findings, re-triggers the review, and escalates to a human before any merge and after N failed fix attempts. Never merges on its own. All target repos, filters, thresholds and the escalation channel come from a config file - nothing org-specific is baked in. Invoke when the operator (or a scheduled RemoteTrigger routine) says "run the pr-steward skill" / "run a steward tick".
---

# pr-steward — autonomous PR review/fix loop (one tick per invocation)

This skill turns the persistent remote-control session into a stand-in operator for
review-driven PRs. It is **off by default** and **never merges autonomously**.

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
| `merge_mode` | Must be `"never"` in v1. If anything else, treat as `"never"` and log a warning — there is no autonomous merge path. |
| `max_attempts` | Max fix iterations per PR before escalating (default 3). |
| `stuck_hours` | Escalate an owned PR with no head-SHA progress after this many hours. |
| `tick_lock_stale_minutes` | Lockfile staleness window. |
| `label_prefix` | Label namespace (default `steward`). |
| `review_trigger` | Comment text that triggers the review bot (e.g. `@claude review`). |
| `review_bots[]` | Bot logins codex-watch should match. |
| `repos[]` | `{ name: "owner/repo", pr_filter: { head_prefix?, author?, labels[]? } }`. All filter keys optional; see §4. |
| `github_app.token_file` | Path the refresh loop writes the installation token to. |
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
gh pr list -R "$REPO" --state open --limit 200 --json number,headRefName,headRefOid,author,labels,isDraft,mergeStateStatus,statusCheckRollup,url \
  --search "<filter>"
```

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
- `head = headRefOid`
- `checks_green` = every required check in `statusCheckRollup` is SUCCESS/NEUTRAL/SKIPPED
- `mergeable` = `mergeStateStatus` ∈ {`CLEAN`,`HAS_HOOKS`,`UNSTABLE`}
- `attempt` = highest N from any `${LP}:attempt-N` label (0 if none)
- review state — via §6 (codex-watch)

Apply, in order:

| Condition | Action |
|---|---|
| PR merged or closed externally | remove all `${LP}:*` labels; `action=drop` |
| review bot has not responded for current `head` yet | `action=wait reason=awaiting-review` |
| **P1/P2 findings at current `head`** | if `attempt >= max_attempts` → **escalate (max-attempt)**, add `${LP}:escalated`, stop. Else → **§7 apply fix** |
| no P1/P2 findings, `mergeable`, `checks_green` | **§8 ready-to-merge escalation** — add `${LP}:ready-to-merge`, ping once, **DO NOT MERGE** |
| no P1/P2 findings but not mergeable / checks not green / build failure NOT from review | **§9 non-review escalation** |
| watcher timed out | §6 timeout handling |

Only ever match findings **at the current head SHA**. codex-watch's trigger-timestamp
baseline already enforces this — never reuse a pre-fixup review.

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
4. Commit (`fix: address review findings`) and `git push` (App identity via the
   credential helper from §2).
5. Re-post `review_trigger` and relaunch the watcher for the new head.
6. Bump the attempt label: remove `${LP}:attempt-{n}`, add `${LP}:attempt-{n+1}`.
   Remove `${LP}:fixing` and `${LP}:reposted`.
7. **Attempt accounting** (mirror run_shepherd.py:1146-1202):
   - *transient* push failure (auth/network) → do NOT bump the attempt; leave state for
     next tick; `result=transient_fail`.
   - *deterministic* outcome (no commits produced, or branch missing on origin) → DO
     bump the attempt; if it reaches `max_attempts`, escalate (max-attempt).
8. `action=address-review result=pushed attempt=<n+1>`.

## 8. Ready-to-merge — escalate, never merge

When a PR is clean (no P1/P2 at head), `mergeable`, and `checks_green`:
- Add `${LP}:ready-to-merge` (idempotent — if already present, do nothing and do NOT
  ping again).
- Send ONE escalation (§10, template `ready-to-merge`).
- **Do not run `gh pr merge`.** A human merges. (Gated `/merge` is a v2 enhancement.)

## 9. Non-review / stuck escalation

For: CI/build failure not originating from a review finding, merge conflict
(`mergeStateStatus=DIRTY`/`BEHIND`), bot silent twice, or an owned PR with no head
progress for `> stuck_hours`:
- Add `${LP}:escalated` (idempotent — ping only on the transition into this state).
- Send ONE escalation (§10, template `non-review` or `max-attempt` as appropriate).
- Stop acting on this PR until a human removes `${LP}:escalated`.

## 10. Escalation channel (config-driven)

Read `escalation`. For `channel: "telegram"`, send the message to the configured peer
using the Telegram MCP send tool available in this session. Keep one ping per state
transition (the `${LP}:ready-to-merge` / `${LP}:escalated` labels are the dedupe).

Templates (`{...}` from PR context):
- **ready-to-merge:** `✅ {repo}#{pr} clean & green ({p1}P1/{p2}P2). Ready to merge — your call. {url}`
- **max-attempt:** `⛔ {repo}#{pr} stuck after {attempts} fix attempts; P1/P2 persist: {summaries}. Human triage needed. {url}`
- **non-review:** `⚠️ {repo}#{pr} {failure_type} (not a review finding): {detail}. Out of steward scope. {url}`

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

1. **Auto-merging.** v1 never calls `gh pr merge`. Escalate before merge, always.
2. **Token leakage.** No token on a command line, in a remote URL, or in any log.
3. **Matching a stale review.** Always key findings to the current head SHA via the
   codex-watch trigger baseline.
4. **Burning an attempt on a transient failure.** Only deterministic outcomes count.
5. **Re-pinging on every tick.** Escalations are gated by labels; one ping per transition.
6. **Running while disabled.** Honor `PR_STEWARD_ENABLED` and the lockfile.
