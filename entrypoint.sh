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

# Seed a CLAUDE.md if the workspace doesn't have one yet. This gives Claude
# context about its environment on every new session. Users can override by
# writing their own CLAUDE.md to the persistent volume.
if [ ! -f /workspace/CLAUDE.md ]; then
  cat > /workspace/CLAUDE.md <<'MD'
# Remote Worker Environment

You are running inside a container as a Claude Code remote worker.

- Workspace: `/workspace` (persisted across restarts via external storage)
- Mode: `--remote-control` with `--dangerously-skip-permissions`
- All file operations work under `/workspace`; git is available

## Session continuity

Conversation history is not preserved across container restarts.
Before a planned restart, ask Claude to write a summary to a file in
`/workspace`, e.g. `/workspace/session-notes.md` — that file is synced to
persistent storage and will be available after the container comes back up.
MD
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

# Optional pr-steward automation. Default-off: when PR_STEWARD_ENABLED is not
# exactly "true" this whole block is a no-op and the container behaves as a
# plain remote-control device. Runs before the (potentially slow) native binary
# refresh because skill install and token minting do not depend on it. When
# enabled we (1) install the bundled steward skill (and any operator-supplied
# overlay skills, e.g. codex-watch) into the workspace skill dir, and (2) start
# a background loop that keeps a fresh GitHub App installation token on tmpfs.
# The token never reaches stdout.
if [ "${PR_STEWARD_ENABLED:-false}" = "true" ]; then
  echo "[entrypoint] pr-steward enabled"

  mkdir -p /workspace/.claude/skills
  if [ -d /opt/steward/skills ]; then
    cp -R /opt/steward/skills/. /workspace/.claude/skills/ 2>/dev/null || true
    echo "[entrypoint] installed bundled steward skills"
  fi
  # Operator overlay skills (private layer) — e.g. codex-watch. Optional.
  if [ -n "${PR_STEWARD_SKILLS_DIR:-}" ] && [ -d "${PR_STEWARD_SKILLS_DIR}" ]; then
    cp -R "${PR_STEWARD_SKILLS_DIR}/." /workspace/.claude/skills/ 2>/dev/null || true
    echo "[entrypoint] installed overlay skills from ${PR_STEWARD_SKILLS_DIR}"
  fi

  if [ -x /opt/steward/bin/gh-app-token ]; then
    (
      while true; do
        if /opt/steward/bin/gh-app-token; then
          sleep 2700   # ~45 min; token is valid ~60 min
        else
          echo "[token-refresh] mint failed; retry in 60s"
          sleep 60
        fi
      done
    ) &
    echo "[entrypoint] token-refresh pid=$!"
  else
    echo "[entrypoint] WARN pr-steward enabled but /opt/steward/bin/gh-app-token missing"
  fi
fi

# Install or refresh the native claude binary in $HOME/.local/bin. The
# native build can auto-update without sudo (the npm-global install in
# /usr/local cannot — `claude doctor` warns about it). Persisted to a
# volume or external storage if configured, so the update can survive
# container restarts.
#
# Skip re-download when the binary restored from MinIO is already at the
# same version as the bundled npm package; saves 30–60 s on normal restarts.
# Some volume/restore mechanisms drop the exec bit, so chmod always runs.
NATIVE_CLAUDE="/workspace/.local/bin/claude"
chmod +x "$NATIVE_CLAUDE" 2>/dev/null || true
BUNDLED_VER=$(claude --version 2>/dev/null | head -1)
NATIVE_VER=$("$NATIVE_CLAUDE" --version 2>/dev/null | head -1)
if [ -x "$NATIVE_CLAUDE" ] && [ -n "$NATIVE_VER" ] && [ "$NATIVE_VER" = "$BUNDLED_VER" ]; then
  echo "[entrypoint] native claude already current ($NATIVE_VER); skipping install"
else
  echo "[entrypoint] installing/refreshing native claude binary"
  claude install latest --force 2>&1 | tail -8 || echo "[entrypoint] WARN native install failed; falling back to npm-global"
  chmod +x "$NATIVE_CLAUDE" 2>/dev/null || true
fi
if [ -x "$NATIVE_CLAUDE" ]; then
  export PATH="/workspace/.local/bin:$PATH"
  echo "[entrypoint] using native claude: $($NATIVE_CLAUDE --version 2>&1 | head -1)"
else
  echo "[entrypoint] using npm-global claude: $(claude --version 2>&1 | head -1)"
fi

# Optional pr-steward scheduler. Fires a headless `claude -p` tick on a cadence
# so the steward runs without a human prompting the live session. Off unless
# pr-steward is enabled AND PR_STEWARD_SCHEDULE_SECONDS is a positive integer.
# Placed after the native-binary refresh so `claude` resolves to the updated
# build. A cheap GitHub pre-check gates each tick: we only spawn the (Claude-
# usage-costly) model run when an in-scope PR actually needs attention, so idle
# cadences cost one GitHub API call, not Claude usage. Each tick is wrapped in
# `timeout` so a stuck turn can't wedge the loop (the live session had no such
# guard). Runs alongside the remote-control session, sharing HOME/skills/creds.
if [ "${PR_STEWARD_ENABLED:-false}" = "true" ] && \
   printf '%s' "${PR_STEWARD_SCHEDULE_SECONDS:-0}" | grep -qE '^[1-9][0-9]*$'; then
  STEWARD_LOG_DIR=/var/log/steward
  [ -d "$STEWARD_LOG_DIR" ] || STEWARD_LOG_DIR=/tmp
  STEWARD_SCHED_LOG="$STEWARD_LOG_DIR/scheduler.log"
  STEWARD_CLAUDE_BIN="$(command -v claude)"
  STEWARD_PRECHECK=/opt/steward/bin/pr-steward-precheck
  STEWARD_TICK_TIMEOUT="${PR_STEWARD_TICK_TIMEOUT_SECONDS:-1800}"
  (
    while true; do
      sleep "${PR_STEWARD_SCHEDULE_SECONDS}"
      if [ -x "$STEWARD_PRECHECK" ] && "$STEWARD_PRECHECK" >>"$STEWARD_SCHED_LOG" 2>&1; then
        echo "[scheduler $(date -u +%FT%TZ)] work found; firing tick" >>"$STEWARD_SCHED_LOG"
        timeout "$STEWARD_TICK_TIMEOUT" "$STEWARD_CLAUDE_BIN" -p "Run the pr-steward skill" \
          --dangerously-skip-permissions >>"$STEWARD_SCHED_LOG" 2>&1 \
          || echo "[scheduler $(date -u +%FT%TZ)] tick exited non-zero (timeout/error)" >>"$STEWARD_SCHED_LOG"
      fi
    done
  ) &
  echo "[entrypoint] pr-steward scheduler pid=$! interval=${PR_STEWARD_SCHEDULE_SECONDS}s gate=precheck"
fi

# `claude --remote-control` needs a PTY (script wrapper),
# a device name, and skip-permissions to run non-interactively.
#
# Typescript file is /dev/stdout (NOT /dev/null) so claude's PTY output
# reaches the container stdout pipe and shows up in container logs.
# /dev/null swallows the welcome banner and registration errors silently.
echo "[entrypoint] exec claude --remote-control"
exec script -qfc "claude --remote-control ${DEVICE_NAME} --dangerously-skip-permissions 2>&1" /dev/stdout
