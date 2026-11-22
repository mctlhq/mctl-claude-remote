# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities via [GitHub private vulnerability reporting](https://github.com/mctlhq/mctl-claude-remote/security/advisories/new) rather than opening a public issue.

We aim to respond within 5 business days and will coordinate a fix before any public disclosure.

Security reports are in scope when they affect the container image, entrypoint behavior, health check behavior, published GitHub Actions workflows, or documented runtime isolation assumptions.

Please do not include live Claude credentials, tokens, private keys, or sensitive workspace data in reports.

## Intentional Design Decisions

### Permission mode `dontAsk` (was `--dangerously-skip-permissions`)

The session runs unattended in `--permission-mode dontAsk`: a tool call that is
not in `permissions.allow` is denied, and bypass mode is disabled in settings
(`permissions.disableBypassPermissionsMode`), so a restored workspace cannot
re-enable it. The allowlist and its extension points are in the README
("Permissions"). The security contract is:

- The container **must** still run in an isolated environment (dedicated namespace, restricted network policy, no sensitive volume mounts).
- The allowlist reduces what an unlisted call can reach; it does not stop a session that has already been subverted through a listed tool. For the PR steward tick this is effectively an unrestricted shell: `Bash(git:*)` and `Bash(gh:*)` together with `Write` allow a git alias, `core.pager`, a written `.git/hooks` file or `gh alias set --shell` to run arbitrary commands, and `gh auth token` prints the token. Narrowing those rules to the subcommands the skill uses is a follow-up.
- Inbound DM events wake the session only for senders on the policy's `sender_allowlist`; an unreadable or missing list allows nobody.
- The unattended `pr-steward` tick runs under the same mode with a fixed tool list. Its GitHub token is exported into the tick's environment by the scheduler shell (the tick may not read the token file or export variables), and a missing token stops the tick with a logged `auth_error` instead of letting it run unauthenticated.

If you find a way to run an unlisted tool, re-enable bypass mode, or get a non-allowlisted sender delivered, please report it.

### Optional `pr-steward` automation

The `pr-steward` automation is **disabled by default** (`PR_STEWARD_ENABLED=false`)
and acts on GitHub on the operator's behalf. Its security contract:

- **App-only auth.** Authenticate with a dedicated GitHub App, never a personal
  access token. Grant the minimum fine-grained permissions (Contents/PRs/Issues RW,
  Checks/Metadata read) and install only on the intended repos.
- **Token handling.** The installation token is short-lived (~1h), refreshed in the
  background, written to a tmpfs file (mode 0400), never logged, and never embedded
  in a git remote URL. The App private key must be mounted from a secret manager on
  tmpfs, not passed via an environment variable.
- **Gated merge.** Merging is controlled by `merge_mode`. The default `"never"`
  escalates to a human and never calls `gh pr merge`. The opt-in `"when-green"` mode
  auto-merges, but only when a head-SHA-anchored gate holds: no P1/P2 findings, CI
  green, the PR is mergeable, **and** an approving review exists at the current head
  (`reviewDecision==APPROVED`). The steward never bypasses branch protection — it
  waits for the review bot's approval, so the App's merge is structurally impossible
  until a clean review approves the exact reviewed SHA.
- **Bounded fixes.** Fix commits are constrained by a safety envelope
  (`max_files_changed`, `max_diff_lines`, `forbidden_paths`, no scope expansion, no
  force-push); a finding that can only be fixed outside that envelope is escalated,
  not pushed.
- **Containment.** Run with the hardened, deny-by-default profile in
  `deploy/pr-steward.example.yaml`.

Report any way the automation can be made to merge outside the `when-green` gate
(unapproved, with P1/P2 open, or with red CI), leak the token, or act outside its
configured repo scope.

## Supported Versions

Only the latest published image tag receives security fixes. Pin to a specific semver tag in production and update regularly.
