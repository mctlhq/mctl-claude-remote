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

## Supported Versions

Only the latest published image tag receives security fixes. Pin to a specific semver tag in production and update regularly.
