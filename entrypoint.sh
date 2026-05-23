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

## Stay responsive — never block the event loop

Remote Control is a live connection that must keep being serviced. If your turn
blocks on a long-running foreground command, the relay stops getting heartbeats
and the session is dropped ("Remote Control disconnected" while the process is
still alive) — and recovering it requires a restart.

- Do NOT run long foreground `sleep`s or blocking poll loops (e.g. a
  `while ...; do ...; sleep N; done` that waits minutes for a PR comment, a
  workflow, or a file to appear).
- To wait for something, prefer a short background poll that returns promptly,
  then check back on a later turn — or just stop and report, letting the
  operator (or a scheduled tick) resume the wait.
- Keep individual tool calls bounded; if a command might run long, cap it with
  `timeout` and return rather than waiting open-endedly.

## Session continuity

Conversation history IS preserved across container restarts: the workspace
(including `.claude/projects/*.jsonl` transcripts) is synced to persistent
storage, and on restart the entrypoint resumes the prior session via
`--resume` (controlled by `RESUME_SESSION` / `RESUME_SESSION_ID`). Set
`RESUME_SESSION=false` to force a fresh session if a transcript is corrupt.
A long-lived workspace file like `/workspace/session-notes.md` is still a good
durable scratchpad, since it survives even a fresh (non-resumed) start.
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
  # Guard against a misconfigured value: `timeout 0` kills the tick instantly
  # and a negative value errors out, silently breaking every tick.
  printf '%s' "$STEWARD_TICK_TIMEOUT" | grep -qE '^[1-9][0-9]*$' || STEWARD_TICK_TIMEOUT=1800
  (
    while true; do
      sleep "${PR_STEWARD_SCHEDULE_SECONDS}"
      if [ -x "$STEWARD_PRECHECK" ] && "$STEWARD_PRECHECK" >>"$STEWARD_SCHED_LOG" 2>&1; then
        echo "[scheduler $(date -u +%FT%TZ)] work found; firing tick" >>"$STEWARD_SCHED_LOG"
        # --no-session-persistence: headless steward ticks must NOT write their
        # own transcript into /workspace/.claude/projects, or the resume-on-restart
        # "newest on disk" heuristic would resolve to a steward tick instead of the
        # operator's interactive remote-control session, silently defeating resume.
        timeout "$STEWARD_TICK_TIMEOUT" "$STEWARD_CLAUDE_BIN" -p "Run the pr-steward skill" \
          --no-session-persistence --dangerously-skip-permissions >>"$STEWARD_SCHED_LOG" 2>&1 \
          || echo "[scheduler $(date -u +%FT%TZ)] tick exited non-zero (timeout/error)" >>"$STEWARD_SCHED_LOG"
      fi
    done
  ) &
  echo "[entrypoint] pr-steward scheduler pid=$! interval=${PR_STEWARD_SCHEDULE_SECONDS}s gate=precheck"
fi

# ── Resume resolution ────────────────────────────────────────────────────────
# Resolve which session to resume and set RESUME_FLAG. Called before EVERY
# (re)launch so an in-pod relaunch (watchdog/supervisor below) picks up the
# session that was active. Precedence:
#   RESUME_SESSION=false      -> fresh session (escape hatch for a bad transcript)
#   RESUME_SESSION_ID=<uuid>  -> resume that exact session (explicit pin)
#   else                      -> resume the newest transcript on disk
# A fresh restart creates a *newer* blank session, so RESUME_SESSION_ID is the
# safe way to pin a known-good session; newest-on-disk is only the default.
resolve_resume() {
  RESUME_FLAG=""
  if [ "${RESUME_SESSION:-true}" = "false" ]; then
    echo "[entrypoint] RESUME_SESSION=false; starting fresh session"
    return 0
  fi
  RESUME_ID="${RESUME_SESSION_ID:-}"
  if [ -z "$RESUME_ID" ]; then
    NEWEST=$(ls -t /workspace/.claude/projects/*/*.jsonl 2>/dev/null | head -1 || true)
    if [ -n "$NEWEST" ]; then RESUME_ID=$(basename "$NEWEST" .jsonl); fi
  fi
  # Strict canonical-UUID check (NOT a glob): RESUME_ID is interpolated into the
  # `script -qfc "..."` command and re-evaluated by the inner shell, so a loose
  # pattern admitting shell metacharacters would be a command-injection path.
  if printf '%s' "$RESUME_ID" | grep -qE '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'; then
    RESUME_FLAG="--resume $RESUME_ID"
    echo "[entrypoint] resuming session $RESUME_ID"
  elif [ -z "$RESUME_ID" ]; then
    echo "[entrypoint] no transcript found; starting fresh session"
  else
    echo "[entrypoint] resolved session id '$RESUME_ID' is not a valid UUID; starting fresh session"
  fi
  return 0
}

# ── Wedge watchdog (in-pod) ──────────────────────────────────────────────────
# The remote-control event loop can stall (e.g. a blocking poll loop): the
# process stays alive but stops draining its relay socket, so the websocket dies
# while the TCP conn lingers ESTABLISHED. We detect the same idle-safe signal the
# health proxy uses — unread bytes in a :443 socket receive queue (a healthy
# device, idle or busy, drains instantly) — and once it has been stuck for
# WATCHDOG_STALL_SECONDS we kill the wedged claude leaf so the supervisor
# relaunches it WITH --resume in-pod. That is faster than waiting for the kubelet
# liveness backstop (health-proxy 503 -> pod recreate); the backstop still covers
# the case where the in-pod relaunch can't recover. Gated by WATCHDOG_ENABLED.
WATCHDOG_ENABLED="${WATCHDOG_ENABLED:-true}"
WATCHDOG_INTERVAL_SECONDS="${WATCHDOG_INTERVAL_SECONDS:-15}"
WATCHDOG_STALL_SECONDS="${WATCHDOG_STALL_SECONDS:-120}"

# True (exit 0) if any ESTABLISHED outbound :443 socket has a non-zero rx_queue.
# /proc/net/tcp{,6}: col 4 = state (01=ESTABLISHED), col 3 = rem addr (port 443
# = hex 01BB), col 5 = tx_queue:rx_queue (hex). String compare avoids gawk
# strtonum (absent in the slim image's awk).
relay_has_backlog() {
  awk 'NR>1 && $4=="01" && $3 ~ /:01BB$/ { split($5,q,":"); if (q[2] !~ /^0+$/) f=1 } END { exit (f?0:1) }' \
    /proc/net/tcp /proc/net/tcp6 2>/dev/null
}

# Echo the PID of the remote-control claude leaf — cmdline has --remote-control
# and is not a script/sh wrapper (nor a `claude -p` steward tick, which has no
# --remote-control).
find_claude_pid() {
  for p in /proc/[0-9]*; do
    [ -r "$p/cmdline" ] || continue
    cmd=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)
    case "$cmd" in *--remote-control*) ;; *) continue ;; esac
    first=${cmd%% *}
    case "${first##*/}" in script|sh|bash|dash|env) continue ;; esac
    echo "${p#/proc/}"; return 0
  done
  return 1
}

if [ "$WATCHDOG_ENABLED" = "true" ]; then
  (
    stall_start=0
    while true; do
      sleep "$WATCHDOG_INTERVAL_SECONDS"
      if relay_has_backlog; then
        now=$(date +%s)
        if [ "$stall_start" -eq 0 ]; then stall_start="$now"; fi
        if [ $((now - stall_start)) -ge "$WATCHDOG_STALL_SECONDS" ]; then
          cpid=$(find_claude_pid || true)
          if [ -n "$cpid" ]; then
            echo "[watchdog] relay rx stalled >=${WATCHDOG_STALL_SECONDS}s; killing wedged claude pid=$cpid for in-pod relaunch"
            kill -TERM "$cpid" 2>/dev/null || true
            sleep 5
            if kill -0 "$cpid" 2>/dev/null; then
              echo "[watchdog] claude pid=$cpid alive after TERM; SIGKILL"
              kill -KILL "$cpid" 2>/dev/null || true
            fi
          fi
          stall_start=0
        fi
      else
        stall_start=0
      fi
    done
  ) &
  echo "[entrypoint] wedge watchdog pid=$! stall=${WATCHDOG_STALL_SECONDS}s interval=${WATCHDOG_INTERVAL_SECONDS}s"
fi

# ── Supervisor loop ──────────────────────────────────────────────────────────
# `claude --remote-control` needs a PTY (the `script` wrapper). Rather than
# exec'ing it (any exit would kill the container), we supervise: on exit — a
# crash, or the watchdog killing a wedge — we relaunch in-pod with a freshly
# resolved --resume, skipping the full pod-recreate + MinIO restore cycle.
# A SIGTERM trap forwards shutdown to claude and exits (lets s3-sync flush on
# pod termination). A rapid-crash cap avoids masking a hard failure: if claude
# exits too many times in a short window, exit so the kubelet recreates the pod.
# Typescript target is /dev/stdout (NOT /dev/null) so claude's PTY output reaches
# the container logs.
RELAUNCH_BACKOFF_SECONDS="${RELAUNCH_BACKOFF_SECONDS:-3}"
RAPID_CRASH_MAX="${RAPID_CRASH_MAX:-5}"
RAPID_CRASH_WINDOW_SECONDS="${RAPID_CRASH_WINDOW_SECONDS:-60}"

CLAUDE_CHILD=""   # PID of the `script` wrapper currently running claude
on_term() {
  echo "[entrypoint] received SIGTERM/INT; stopping claude"
  [ -n "$CLAUDE_CHILD" ] && kill -TERM "$CLAUDE_CHILD" 2>/dev/null || true
  exit 0
}
trap on_term TERM INT

crash_window_start=$(date +%s)
crash_count=0
while true; do
  resolve_resume
  echo "[entrypoint] launching claude --remote-control (${RESUME_FLAG:-fresh})"
  set +e
  script -qfc "claude --remote-control ${DEVICE_NAME} ${RESUME_FLAG} --dangerously-skip-permissions 2>&1" /dev/stdout &
  CLAUDE_CHILD=$!
  wait "$CLAUDE_CHILD"
  rc=$?
  set -e
  CLAUDE_CHILD=""
  echo "[entrypoint] claude exited (rc=$rc)"

  now=$(date +%s)
  if [ $((now - crash_window_start)) -ge "$RAPID_CRASH_WINDOW_SECONDS" ]; then
    crash_window_start="$now"; crash_count=0
  fi
  crash_count=$((crash_count + 1))
  if [ "$crash_count" -ge "$RAPID_CRASH_MAX" ]; then
    echo "[entrypoint] claude exited ${crash_count}x within ${RAPID_CRASH_WINDOW_SECONDS}s — exiting so kubelet recreates the pod (not masking a hard failure)"
    exit 1
  fi
  echo "[entrypoint] relaunching in ${RELAUNCH_BACKOFF_SECONDS}s"
  sleep "$RELAUNCH_BACKOFF_SECONDS"
done
