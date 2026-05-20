#!/bin/sh
set -e

echo "[entrypoint] start $(date -u +%FT%TZ)"

export HOME=/workspace
mkdir -p /workspace/.claude
echo "[entrypoint] HOME=$HOME"

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
  "autoUpdates": true,
  "projects": {
    "/workspace": { "hasTrustDialogAccepted": true }
  }
}
JSON
fi

# Always ensure settings.json suppresses the bypass-permissions warning dialog.
# Without skipDangerousModePermissionPrompt, --dangerously-skip-permissions
# blocks at a "Yes, I accept" prompt that we can't answer non-interactively.
if [ ! -f /workspace/.claude/settings.json ] || \
   ! grep -q '"skipDangerousModePermissionPrompt"[[:space:]]*:[[:space:]]*true' /workspace/.claude/settings.json; then
  cat > /workspace/.claude/settings.json <<'JSON'
{
  "permissions": { "defaultMode": "auto", "allow_bypass_permissions": true },
  "skipDangerousModePermissionPrompt": true,
  "skipAutoPermissionPrompt": true
}
JSON
fi

DEVICE_NAME="${CLAUDE_DEVICE_NAME:-claude-remote}"
echo "[entrypoint] device=$DEVICE_NAME config_seeded"

# Install or refresh the native claude binary in $HOME/.local/bin. The
# native build can auto-update without sudo (the npm-global install in
# /usr/local cannot — `claude doctor` warns about it). Persisted to
# MinIO via the s3-sync sidecar, so the update survives pod restarts.
# `--force` overwrites whatever the MinIO restore brought back.
# Restoring an exec bit MinIO drops POSIX permissions on objects.
echo "[entrypoint] installing/refreshing native claude binary"
claude install latest --force 2>&1 | tail -8 || echo "[entrypoint] WARN native install failed; falling back to npm-global"
chmod +x /workspace/.local/bin/claude 2>/dev/null || true
if [ -x /workspace/.local/bin/claude ]; then
  export PATH="/workspace/.local/bin:$PATH"
  echo "[entrypoint] using native claude: $(/workspace/.local/bin/claude --version 2>&1 | head -1)"
else
  echo "[entrypoint] using npm-global claude: $(claude --version 2>&1 | head -1)"
fi

# Health proxy for kubelet probes.
node /opt/health-proxy.js &
echo "[entrypoint] health-proxy pid=$!"

# `claude --remote-control` needs a PTY (script wrapper),
# a device name, and skip-permissions to run non-interactively.
# Reference: ~/Library/LaunchAgents/com.user.claude-remote-control.plist on Mac.
#
# Typescript file is /dev/stdout (NOT /dev/null) so claude's PTY output
# reaches the container stdout pipe and shows up in kubelet/Loki logs.
# /dev/null swallowed the welcome banner and any registration errors
# silently, leaving us blind in 0.1.5.
echo "[entrypoint] exec claude --remote-control"
exec script -qfc "claude --remote-control ${DEVICE_NAME} --dangerously-skip-permissions 2>&1" /dev/stdout
