# mctl-claude-remote

Containerized [Claude Code](https://claude.ai/code) running in `--remote-control` mode for headless and isolated environments such as Kubernetes pods or remote VMs.

The container connects to Anthropic's relay, registers a named device, and accepts remote sessions from the Claude desktop app or any Claude Code client — no inbound ports required.

## What This Provides

- A single container image that starts Claude Code in remote-control mode.
- First-run Claude config seeding for non-interactive environments.
- A local `/healthz` endpoint for container and Kubernetes probes.
- Optional persistence of Claude authentication state via `/workspace`.

This image does not provide workspace isolation by itself. Isolation is the responsibility of the runtime environment.

## Security Warning

**This image runs with `--dangerously-skip-permissions`, which bypasses all tool-use permission prompts.**

- Run only inside an isolated container or dedicated workspace.
- Do not mount directories containing credentials, SSH keys, or other sensitive data.
- Store Claude authentication config only in a controlled, ephemeral volume.
- Never expose the health port (8080) to the public internet.
- Treat every mounted workspace file as readable and writable by Claude Code.

## Docker Image

```
ghcr.io/mctlhq/mctl-claude-remote:<version>
```

Tags follow semver without a `v` prefix (e.g. `0.1.8`).

```sh
docker pull ghcr.io/mctlhq/mctl-claude-remote:0.1.8
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_DEVICE_NAME` | `claude-remote` | Device name shown in the Claude remote session list. Allowed characters: letters, numbers, `.`, `_`, `-`; must not start with `-` |
| `PORT` | `8080` | Port the health proxy listens on |

## Health Check

`GET /healthz` (served by the bundled Node.js health proxy):

| Status | Meaning |
|---|---|
| `200 OK` | Claude process is running **and** has an established outbound TLS connection |
| `503 Service Unavailable` | Either check failed (starting up, or relay disconnected) |

Designed for Kubernetes readiness/liveness probes, but usable with any HTTP health check.

Example Kubernetes probes:

```yaml
readinessProbe:
  httpGet:
    path: /healthz
    port: 8080
  initialDelaySeconds: 10
  periodSeconds: 10
livenessProbe:
  httpGet:
    path: /healthz
    port: 8080
  initialDelaySeconds: 30
  periodSeconds: 30
```

## Quick Start

```sh
docker run --rm \
  -e CLAUDE_DEVICE_NAME=my-remote \
  -p 8080:8080 \
  ghcr.io/mctlhq/mctl-claude-remote:0.1.8
```

The container writes its Claude configuration to `/workspace` (set as `HOME`). Mount a persistent volume there to preserve authentication across restarts:

```sh
docker run --rm \
  -e CLAUDE_DEVICE_NAME=my-remote \
  -p 8080:8080 \
  -v claude-workspace:/workspace \
  ghcr.io/mctlhq/mctl-claude-remote:0.1.8
```

Anything persisted under `/workspace` should be treated as sensitive because it can contain Claude authentication state and workspace data.

## Optional: pr-steward automation

The image ships an **optional, off-by-default** automation that turns the
persistent session into a pull-request steward: it watches PRs for a code-review
bot (`claude[bot]` / `chatgpt-codex-connector[bot]`), applies fixes for P1/P2
findings, re-triggers the review, and **escalates to a human before any merge and
after N failed fix attempts**. It never merges on its own.

It is fully generic — every target repo, filter, threshold and the escalation
channel come from a config file. The driver is your own scheduler (e.g. a Claude
RemoteTrigger routine) firing the prompt `Run the pr-steward skill.` per tick.

**Kill switch:** the automation is inert unless `PR_STEWARD_ENABLED=true`. Set it
to anything else (or leave it unset) and the container is a plain remote-control
device. The skill itself re-checks the flag on every tick.

| Variable | Default | Description |
|---|---|---|
| `PR_STEWARD_ENABLED` | `false` | Master switch. Must be exactly `true` to activate. |
| `PR_STEWARD_CONFIG` | `/workspace/pr-steward.config.json` | Path to the steward config (see `pr-steward.config.example.json`). |
| `PR_STEWARD_SKILLS_DIR` | _(unset)_ | Optional dir of overlay skills to install (e.g. your `codex-watch` skill). |
| `GH_APP_ID` | — | GitHub App ID. |
| `GH_APP_INSTALLATION_ID` | — | App installation ID for the target repos. |
| `GH_APP_PRIVATE_KEY_FILE` | — | Path to the App private key (PEM). Mount on **tmpfs, group-readable (mode 0440 + fsGroup)** so the non-root process can read it. |
| `GH_APP_TOKEN_FILE` | `/run/steward/gh-token` | Where the entrypoint writes the short-lived installation token. |

**GitHub App (no PAT).** Create a GitHub App with fine-grained permissions
**Contents: RW, Pull requests: RW, Issues: RW, Checks: read, Metadata: read** — no
admin. Install it only on the repos you want stewarded. The entrypoint runs a
background loop that mints a ~1h installation token every ~45 min via
`bin/gh-app-token` and writes it to `GH_APP_TOKEN_FILE`. A push made by a GitHub
App *does* re-fire `on: synchronize` workflows, so your review action re-runs after
each steward fix.

**Secret hygiene.** The installation token is never printed and never embedded in a
git remote URL (the skill uses `gh auth setup-git`). Mount the App private key from
a secret manager (e.g. an ExternalSecret) onto tmpfs, not via an env var.

**Hardening & network.** See `deploy/pr-steward.example.yaml` for a reference
manifest: non-root, read-only root filesystem, all capabilities dropped,
`RuntimeDefault` seccomp, tmpfs token volume, and a deny-by-default NetworkPolicy
(egress should be tightened to your GitHub / Anthropic / escalation endpoints).

**Branch protection prerequisite.** Because the steward pushes fix commits, protect
the default branch: require a PR, **require human approval**, and require status
checks — so even though v1 never calls merge, the App is structurally unable to land
code without a human.

## Build Model

The Dockerfile defaults to installing the latest `@anthropic-ai/claude-code` npm package at image build time, then refreshes the native Claude binary on container startup when possible. To build against a specific npm package version:

```sh
docker build \
  --build-arg CLAUDE_CODE_NPM_VERSION=<version> \
  -t mctl-claude-remote:local .
```

## Local Validation

```sh
# Syntax checks
sh -n entrypoint.sh
node --check health-proxy.js

# Build
docker build -t mctl-claude-remote:local .

# Smoke test — without a real Claude relay the health check must return 503
docker run --rm -d --name cr-test -p 8080:8080 \
  -e CLAUDE_DEVICE_NAME=test-device \
  mctl-claude-remote:local

curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/healthz
# Expected: 503

docker stop cr-test
```

## License

[MIT](LICENSE)
