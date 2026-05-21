# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities via [GitHub private vulnerability reporting](https://github.com/mctlhq/mctl-claude-remote/security/advisories/new) rather than opening a public issue.

We aim to respond within 5 business days and will coordinate a fix before any public disclosure.

Security reports are in scope when they affect the container image, entrypoint behavior, health check behavior, published GitHub Actions workflows, or documented runtime isolation assumptions.

Please do not include live Claude credentials, tokens, private keys, or sensitive workspace data in reports.

## Intentional Design Decisions

### `--dangerously-skip-permissions`

This flag is intentional and documented. It bypasses Claude Code's interactive permission prompts so the container can run non-interactively. The security contract is:

- The container **must** run in an isolated environment (dedicated namespace, restricted network policy, no sensitive volume mounts).
- Callers are responsible for ensuring the workspace does not contain credentials or data that should not be accessible to Claude.

If you find a way to escape this isolation or exploit the flag in ways beyond its documented scope, please report it.

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
- **No autonomous merge.** v1 never merges; it escalates to a human before merge and
  after a bounded number of failed fix attempts. Protect the default branch
  (required human approval + status checks) as defense in depth.
- **Containment.** Run with the hardened, deny-by-default profile in
  `deploy/pr-steward.example.yaml`.

Report any way the automation can be made to merge without human approval, leak the
token, or act outside its configured repo scope.

## Supported Versions

Only the latest published image tag receives security fixes. Pin to a specific semver tag in production and update regularly.
