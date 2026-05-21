# mctl-claude-remote

Containerized [Claude Code](https://claude.ai/code) running in `--remote-control` mode for headless and isolated environments such as Kubernetes pods or remote VMs.

The container connects to Anthropic's relay, registers a named device, and accepts remote sessions from the Claude desktop app or any Claude Code client — no inbound ports required.

## Security Warning

**This image runs with `--dangerously-skip-permissions`, which bypasses all tool-use permission prompts.**

- Run only inside an isolated container or dedicated workspace.
- Do not mount directories containing credentials, SSH keys, or other sensitive data.
- Store Claude authentication config only in a controlled, ephemeral volume.
- Never expose the health port (8080) to the public internet.

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
| `CLAUDE_DEVICE_NAME` | `claude-remote` | Device name shown in the Claude remote session list |
| `PORT` | `8080` | Port the health proxy listens on |

## Health Check

`GET /healthz` (served by the bundled Node.js health proxy):

| Status | Meaning |
|---|---|
| `200 OK` | Claude process is running **and** has an established outbound TLS connection |
| `503 Service Unavailable` | Either check failed (starting up, or relay disconnected) |

Designed for Kubernetes readiness/liveness probes, but usable with any HTTP health check.

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
