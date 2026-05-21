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
