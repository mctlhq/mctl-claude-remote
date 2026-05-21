#!/bin/sh
set -e

echo "[entrypoint] start $(date -u +%FT%TZ)"

export HOME=/workspace
mkdir -p /workspace/.claude
echo "[entrypoint] HOME=$HOME"

# Seed first-run config if onboarding hasn't been completed yet. Required
# because no human is here to press keys at the theme/trust prompts.
# We re-seed when a persisted workspace restore brought back a partial config
# written before a previous crash.
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
case "$DEVICE_NAME" in
  -* | *[!A-Za-z0-9_.-]* | "")
    echo "[entrypoint] ERROR CLAUDE_DEVICE_NAME must not start with '-' and may contain only letters, numbers, dot, underscore, and hyphen" >&2
    exit 2
    ;;
esac
echo "[entrypoint] device=$DEVICE_NAME config_seeded"

# Health proxy for container readiness/liveness probes. Start it before the
# native installer so /healthz can return 503 instead of refusing connections
# during slow first-start refreshes.
node /opt/health-proxy.js &
echo "[entrypoint] health-proxy pid=$!"

# Install or refresh the native claude binary in $HOME/.local/bin. The
# native build can auto-update without sudo (the npm-global install in
# /usr/local cannot — `claude doctor` warns about it). Persisted to a
# volume or external storage if configured, so the update can survive
# container restarts. `--force` overwrites whatever the workspace restore
# brought back. Some volume/restore mechanisms drop the exec bit;
# chmod ensures it's set.
echo "[entrypoint] installing/refreshing native claude binary"
claude install latest --force 2>&1 | tail -8 || echo "[entrypoint] WARN native install failed; falling back to npm-global"
chmod +x /workspace/.local/bin/claude 2>/dev/null || true
if [ -x /workspace/.local/bin/claude ]; then
  export PATH="/workspace/.local/bin:$PATH"
  echo "[entrypoint] using native claude: $(/workspace/.local/bin/claude --version 2>&1 | head -1)"
else
  echo "[entrypoint] using npm-global claude: $(claude --version 2>&1 | head -1)"
fi

# `claude --remote-control` needs a PTY (script wrapper),
# a device name, and skip-permissions to run non-interactively.
#
# Typescript file is /dev/stdout (NOT /dev/null) so claude's PTY output
# reaches the container stdout pipe and shows up in container logs.
# /dev/null swallows the welcome banner and registration errors silently.
echo "[entrypoint] exec claude --remote-control"
exec script -qfc "claude --remote-control ${DEVICE_NAME} --dangerously-skip-permissions 2>&1" /dev/stdout
