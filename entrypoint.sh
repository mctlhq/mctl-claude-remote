#!/bin/sh
set -e

export HOME=/workspace
mkdir -p /workspace/.claude

# Seed first-run config if onboarding hasn't been completed yet. Required
# because no human is here to press keys at the theme/trust prompts.
# We re-seed when the MinIO restore brought back a partial config written
# by an earlier pod that crashed mid-onboarding.
if [ ! -f /workspace/.claude.json ] || \
   ! grep -q '"hasCompletedOnboarding"[[:space:]]*:[[:space:]]*true' /workspace/.claude.json; then
  cat > /workspace/.claude.json <<'JSON'
{
  "theme": "dark",
  "hasCompletedOnboarding": true,
  "autoUpdates": false,
  "projects": {
    "/workspace": { "hasTrustDialogAccepted": true }
  }
}
JSON
fi

DEVICE_NAME="${CLAUDE_DEVICE_NAME:-claude-remote}"

# Health proxy for kubelet probes.
node /opt/health-proxy.js &

# `claude --remote-control` needs a PTY (script wrapper),
# a device name, and skip-permissions to run non-interactively.
# Reference: ~/Library/LaunchAgents/com.user.claude-remote-control.plist on Mac.
exec script -qfc "claude --remote-control ${DEVICE_NAME} --dangerously-skip-permissions" /dev/null
