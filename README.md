# mctl-claude-remote

[![Build](https://github.com/mctlhq/mctl-claude-remote/actions/workflows/build.yml/badge.svg)](https://github.com/mctlhq/mctl-claude-remote/actions/workflows/build.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

A Docker image that runs `claude --remote-control` as a persistent device inside Kubernetes. Pod restarts are survivable: the Claude binary, session state, and configuration are persisted to an S3-compatible object store (MinIO) via a sidecar, so the device remains registered across restarts.

## How it works

```
kubelet liveness/readiness probe
        |
        v
health-proxy.js  (port 8080, zero-dep Node.js HTTP server)

entrypoint.sh
  ├── seeds .claude.json + settings.json (non-interactive defaults)
  ├── installs/refreshes native claude binary → persisted to MinIO
  └── exec script -qfc "claude --remote-control <name> --dangerously-skip-permissions"
                              PTY wrapper (required for kubelet compatibility)

MinIO sidecar (s3-sync)
  └── syncs /workspace ↔ s3://bucket/prefix on start and shutdown
```

The native Claude binary is installed into `$HOME/.local/bin` on first start and persisted to MinIO so subsequent pod starts skip the download. The `--force` flag on reinstall handles the case where MinIO restores a binary with its exec bit stripped.

## Quick start

### Pull the image

```sh
docker pull ghcr.io/mctlhq/claude-remote:latest
```

### Run locally (without persistence)

Authenticate first by running `claude setup-token` in a temporary container to obtain an OAuth token, then mount it:

```sh
docker run --rm -it \
  -e CLAUDE_DEVICE_NAME=my-device \
  ghcr.io/mctlhq/claude-remote:latest
```

The container will block at `claude --remote-control` until the device is authorized via the Claude web UI at [claude.ai/settings/connections](https://claude.ai/settings/connections).

### Kubernetes deployment

A minimal deployment with a MinIO s3-sync sidecar:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: claude-remote
spec:
  replicas: 1
  selector:
    matchLabels:
      app: claude-remote
  template:
    metadata:
      labels:
        app: claude-remote
    spec:
      volumes:
        - name: workspace
          emptyDir: {}
      initContainers:
        # Restore /workspace from MinIO before Claude starts
        - name: s3-restore
          image: minio/mc:latest
          command:
            - sh
            - -c
            - mc alias set minio $MINIO_ENDPOINT $MINIO_ACCESS_KEY $MINIO_SECRET_KEY &&
              mc mirror --overwrite minio/$MINIO_BUCKET/$DEVICE_NAME /workspace || true
          env:
            - name: MINIO_ENDPOINT
              valueFrom:
                secretKeyRef:
                  name: claude-remote-secrets
                  key: minio-endpoint
            - name: MINIO_ACCESS_KEY
              valueFrom:
                secretKeyRef:
                  name: claude-remote-secrets
                  key: minio-access-key
            - name: MINIO_SECRET_KEY
              valueFrom:
                secretKeyRef:
                  name: claude-remote-secrets
                  key: minio-secret-key
            - name: MINIO_BUCKET
              value: claude-remote
            - name: DEVICE_NAME
              value: my-device
          volumeMounts:
            - name: workspace
              mountPath: /workspace
      containers:
        - name: claude-remote
          image: ghcr.io/mctlhq/claude-remote:0.1.6
          env:
            - name: CLAUDE_DEVICE_NAME
              value: my-device
          volumeMounts:
            - name: workspace
              mountPath: /workspace
          livenessProbe:
            httpGet:
              path: /
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
        # Sync /workspace back to MinIO on shutdown (preStop hook)
        - name: s3-sync
          image: minio/mc:latest
          command: ["sh", "-c", "while true; do sleep 60; done"]
          lifecycle:
            preStop:
              exec:
                command:
                  - sh
                  - -c
                  - mc alias set minio $MINIO_ENDPOINT $MINIO_ACCESS_KEY $MINIO_SECRET_KEY &&
                    mc mirror --overwrite /workspace minio/$MINIO_BUCKET/$DEVICE_NAME
          # (same env vars as initContainer)
          volumeMounts:
            - name: workspace
              mountPath: /workspace
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_DEVICE_NAME` | `claude-remote` | Device name shown in Claude's connected devices list |
| `PORT` | `8080` | Port the health-check proxy listens on |
| `HOME` | `/workspace` | Directory for Claude config, binary, and session state |

## Authentication

On first start the device will not be authorized. To register it:

1. Exec into the running pod (or check container logs) to find the authorization URL printed by `claude --remote-control`.
2. Open the URL in a browser and approve the device under your Claude account.
3. The session token is written to `/workspace` and persisted to MinIO — subsequent restarts authenticate automatically.

To force re-authentication, delete the session files from MinIO and restart the pod.

## Building

The image is built automatically on semver tag push:

```sh
git tag 1.2.3
git push origin 1.2.3
```

GitHub Actions builds and pushes `ghcr.io/mctlhq/claude-remote:1.2.3` to GHCR.

To build locally:

```sh
docker build -t claude-remote:dev .
```

## Repository layout

```
Dockerfile         Container image definition (node:22-slim base)
entrypoint.sh      Container init: config seeding, binary install, process exec
health-proxy.js    Zero-dependency Node.js HTTP server for kubelet probes
.github/
  workflows/
    build.yml      Tag-triggered multi-platform GHCR build
```

## License

Apache 2.0 — see [LICENSE](LICENSE).
