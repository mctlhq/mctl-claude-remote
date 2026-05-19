#!/bin/sh
set -e

export HOME=/workspace
mkdir -p /workspace/.claude

# Health proxy on :8080 — serves /healthz and tunnels everything else to claude on :3000
node /opt/health-proxy.js &

exec claude --remote-control --port 3000
