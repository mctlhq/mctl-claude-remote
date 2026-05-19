#!/bin/sh
set -e

export HOME=/workspace
mkdir -p /workspace/.claude

# Minimal HTTP health server on :8080 for Kubernetes probes.
node /opt/health-proxy.js &

# claude --remote-control requires a PTY — allocate one via `script`.
# Session URL is printed to stdout on startup; retrieve with mctl_get_service_logs.
exec script -qfc "claude --remote-control" /dev/null
