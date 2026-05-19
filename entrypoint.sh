#!/bin/sh
set -e

export HOME=/workspace
mkdir -p /workspace/.claude

# Minimal HTTP health server on :8080 for Kubernetes probes.
# claude --remote-control does not open a local port — the session is
# brokered through Anthropic's cloud. The session URL is printed to stdout
# on startup; retrieve it via mctl_get_service_logs.
node /opt/health-proxy.js &

exec claude --remote-control
