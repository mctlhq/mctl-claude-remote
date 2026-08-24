#!/bin/sh
set -e

echo "[entrypoint] start $(date -u +%FT%TZ)"

export HOME=/workspace
mkdir -p /workspace/.claude
echo "[entrypoint] HOME=$HOME"

# kubectl resolves a kubeconfig (env var, then $HOME/.kube/config) BEFORE
# falling back to in-cluster auto-detection. Since $HOME is the persistent
# workspace, a kubeconfig written there by a previous interactive session
# (e.g. someone running `kubectl config set-cluster` to point at an external
# cluster) would silently persist across restarts and permanently override
# the in-cluster ServiceAccount identity/RBAC. An inherited env var alone
# isn't enough to fix — a leftover $HOME/.kube/config file would still win.
# Point KUBECONFIG at /dev/null instead: an empty/unreadable explicit
# kubeconfig makes kubectl's config loader find no usable context, and it
# falls through to in-cluster auto-detection (the standard technique for
# forcing in-cluster auth regardless of what's on disk).
export KUBECONFIG=/dev/null
if [ -f "$HOME/.kube/config" ]; then
  echo "[entrypoint] WARN \$HOME/.kube/config exists but KUBECONFIG=/dev/null forces in-cluster auto-detection" >&2
fi

FULLSCREEN_UPSELL_THRESHOLD=3   # Ges in the pinned binary; the dialog stops at >=
# Atomic config write: temp file in the SAME directory as the destination, then mv.
# A plain `> file` truncates to 0 bytes before the new content lands, and the s3-sync
# sidecar mirrors /workspace on a 60 s timer, so a tick sampling inside that window
# uploads an empty config to MinIO — which restore-state then hands back on the next
# restart. mv within one directory is atomic, so a reader sees only the old or the new
# file. Same reasoning covers a pod killed mid-write.
#
# mktemp (not "$1.$$.<stamp>"): it creates the file O_EXCL with an unguessable name and
# mode 600, so there is no window for a pre-created symlink and no reliance on $$ — which
# is always 1 here, since this script is the container's PID 1. The template keeps the
# .tmp SUFFIX because the sidecar's mirror passes `--exclude '*.tmp'` and that glob only
# matches a trailing extension; a mirror tick inside the write window would otherwise
# upload the temp file to MinIO as a permanent stray object.
write_json_atomic() {  # $1 = destination, stdin = content; leaves $1 alone on failure
  _wja_dst="$1"
  # A directory at the destination would make `mv` move the temp file INTO it and
  # exit 0, so the caller would believe it had written a config that does not
  # exist. Callers are expected to move a directory aside first; refuse here too.
  if [ -d "$_wja_dst" ]; then
    echo "[entrypoint] WARN $_wja_dst is a directory; refusing to write" >&2
    return 1
  fi
  _wja_tmp=$(mktemp "$_wja_dst.XXXXXX.tmp" 2>/dev/null) || return 1
  # mv replaces the destination inode, so the new file would otherwise keep mktemp's
  # 600 instead of whatever the destination had. Copy the mode across when the
  # destination exists; a freshly seeded file keeps mktemp's restrictive default.
  _wja_mode=$(stat -c '%a' "$_wja_dst" 2>/dev/null || echo 600)
  if cat > "$_wja_tmp" && [ -s "$_wja_tmp" ] \
     && chmod "$_wja_mode" "$_wja_tmp" && mv -f "$_wja_tmp" "$_wja_dst"; then
    return 0
  fi
  rm -f "$_wja_tmp"
  return 1
}

# Ensure a config file has the keys we require, WITHOUT destroying anything else
# in it. Three cases, in order:
#   absent      -> seed from the template on stdin
#   unparseable -> keep a .corrupt.<epoch> copy, then seed (this is the
#                  crash-repair case the old grep check was really catching)
#   present+valid -> merge the required keys with jq; every other key survives
#
# The previous shape decided all of this with a line-oriented `grep` for one key
# and, on a miss, overwrote the WHOLE file from the template. A key explicitly set
# to false was enough to wipe `projects` trust state and every operator-added
# setting. See issue #39.
ensure_json() {  # $1 dst, $2 jq program -> "ok"/"no", $3 jq merge filter; stdin = seed
  _ej_dst="$1"; _ej_ok="$2"; _ej_merge="$3"
  _ej_seed=$(cat)
  if [ -f "$_ej_dst" ] && jq -e . "$_ej_dst" >/dev/null 2>&1; then
    if [ "$(jq -r "$_ej_ok" "$_ej_dst" 2>/dev/null || echo no)" = "ok" ]; then
      return 0
    fi
    if _ej_merged=$(jq "$_ej_merge" "$_ej_dst" 2>/dev/null) && [ -n "$_ej_merged" ] \
       && printf '%s\n' "$_ej_merged" | write_json_atomic "$_ej_dst"; then
      echo "[entrypoint] merged required keys into $_ej_dst (existing settings preserved)"
      return 0
    fi
    # Valid JSON, but the merge could not be applied — e.g. the root is an array,
    # or a key's parent is the wrong type (`.projects` a string, `.permissions`
    # false), which makes jq exit with a type error. Leaving the file as-is would
    # start the agent without the dialog suppressors and wedge it headlessly, and
    # the grep-based predecessor DID overwrite this case. Fall through to
    # preserve-and-seed rather than regress on it.
    echo "[entrypoint] WARN $_ej_dst has an incompatible structure; preserving it and re-seeding" >&2
  fi
  # Anything still at the destination that we could not merge into — unparseable,
  # structurally incompatible, or a DIRECTORY (mv would otherwise move the temp
  # file INTO it and report success) — is set aside, never discarded.
  if [ -e "$_ej_dst" ]; then
    _ej_bak="$_ej_dst.corrupt.$(date -u +%s)"
    if mv -f "$_ej_dst" "$_ej_bak" 2>/dev/null; then
      echo "[entrypoint] WARN kept the previous $_ej_dst as $_ej_bak" >&2
    else
      # Could not set it aside; do NOT overwrite it blind — that would destroy the
      # very thing this branch exists to keep. A same-directory rename failing
      # means the directory is not writable, so the seed below would fail anyway.
      echo "[entrypoint] WARN could not preserve $_ej_dst; refusing to overwrite it" >&2
      return 1
    fi
  fi
  if printf '%s\n' "$_ej_seed" | write_json_atomic "$_ej_dst"; then
    echo "[entrypoint] seeded $_ej_dst"
    return 0
  fi
  echo "[entrypoint] WARN could not seed $_ej_dst" >&2
  return 1
}

# Seed first-run config if onboarding hasn't been completed yet. Required
# because no human is here to press keys at the theme/trust prompts.
# We re-seed when a persisted workspace restore brought back a partial config
# written before a previous crash.
ensure_json /workspace/.claude.json \
  'if (.hasCompletedOnboarding == true
       and (.projects["/workspace"].hasTrustDialogAccepted? == true))
   then "ok" else "no" end' \
  '.hasCompletedOnboarding = true
   | .projects["/workspace"].hasTrustDialogAccepted = true' <<'JSON' || true
{
  "theme": "dark",
  "hasCompletedOnboarding": true,
  "fullscreenUpsellSeenCount": 3,
  "autoUpdates": true,
  "projects": {
    "/workspace": { "hasTrustDialogAccepted": true }
  }
}
JSON

# Always ensure settings.json suppresses the bypass-permissions warning dialog and renderer prompts.
# Without skipDangerousModePermissionPrompt, --dangerously-skip-permissions
# blocks at a "Yes, I accept" prompt that we can't answer non-interactively.
# resumeReturnDismissed is a belt-and-suspenders modal suppressor: it persists
# the "don't ask me again" choice for the resume-from-summary modal, so a headless
# (stdin=/dev/null) --remote-control bridge never wedges on it even if a future
# Claude Code update renames the CLAUDE_CODE_RESUME_* env-var gate.
#
# "tui" is what actually suppresses the "Try the new fullscreen renderer?" dialog.
# Its gate reads, verified in the pinned 2.1.198 binary:
#   if (kr().tui !== void 0) return false;                        <- settings.json
#   if ((Ot().fullscreenUpsellSeenCount ?? 0) >= 3) return false; <- .claude.json
# The schema is tui: enum(["default","fullscreen"]).optional(), so "default" is the
# only value that pins the current renderer. Both the needs-fix guard and the repair
# test against that enum rather than mere presence: a presence check (.tui != null)
# would report "already correct" for tui:false or a bogus tui:"standard" while the
# repair one block below would happily have fixed it — the guard and the repair must
# never disagree, which is the same desync class as the duplicated threshold above. An earlier attempt at this fix wrote
# hasDismissedFullscreenRendererPrompt / preferredRenderer / useFullscreenRenderer;
# none of those three strings occur anywhere in the binary, so the dialog kept firing
# and parked the headless session (deployed 0.10.1 wedged on it in labs on 2026-08-23).
# Grep the shipped binary before changing these keys again.
ensure_json /workspace/.claude/settings.json \
  'if (.skipDangerousModePermissionPrompt == true
       and .skipAutoPermissionPrompt == true
       and .permissions.defaultMode? == "auto"
       and .permissions.allow_bypass_permissions? == true)
   then "ok" else "no" end' \
  '.skipDangerousModePermissionPrompt = true
   | .skipAutoPermissionPrompt = true
   | .permissions.defaultMode = "auto"
   | .permissions.allow_bypass_permissions = true' <<'JSON' || true
{
  "permissions": { "defaultMode": "auto", "allow_bypass_permissions": true },
  "skipDangerousModePermissionPrompt": true,
  "skipAutoPermissionPrompt": true,
  "tui": "default",
  "resumeReturnDismissed": true
}
JSON

# Idempotently FORCE the modal suppressors on a settings.json / .claude.json that
# already exists from an earlier image or was restored from S3 storage (the heredocs
# above only seed fresh installs). We check the actual values, not just key presence:
# a persisted "false" — e.g. Claude writing its default before this image runs — must
# be flipped, otherwise the modal stays enabled for exactly the existing-workspace case
# these blocks exist to repair. Skipping the write when nothing changes keeps the
# s3-sync sidecar from re-uploading the file on every restart. jq set preserves any
# operator-added keys. Also drop the three no-op keys a previous fix wrote, so a
# workspace restored from MinIO stops carrying settings Claude Code does not read.
#
# Writes go through a temp file + mv. `> file` truncates to 0 bytes before the new
# content lands, and the s3-sync sidecar mirrors /workspace on a 60 s timer, so a
# tick that samples inside that window would upload an empty config over the good
# one in MinIO — and restore-state would hand it back on the next restart. mv within
# the same directory is atomic, so a reader only ever sees the old or the new file.
# Same reasoning covers a pod killed mid-write.
if [ -f /workspace/.claude/settings.json ]; then
  needs_fix=$(jq -r 'if (.resumeReturnDismissed == true
                         and (.tui == "default" or .tui == "fullscreen")
                         and has("hasDismissedFullscreenRendererPrompt") == false
                         and has("preferredRenderer") == false
                         and has("useFullscreenRenderer") == false)
                     then "no" else "yes" end' /workspace/.claude/settings.json 2>/dev/null || echo "yes")
  if [ "$needs_fix" = "yes" ]; then
    if merged=$(jq '.resumeReturnDismissed = true
                    | .tui = (if (.tui == "default" or .tui == "fullscreen") then .tui else "default" end)
                    | del(.hasDismissedFullscreenRendererPrompt, .preferredRenderer, .useFullscreenRenderer)' \
                  /workspace/.claude/settings.json 2>/dev/null) && [ -n "$merged" ]; then
      if printf '%s\n' "$merged" | write_json_atomic /workspace/.claude/settings.json; then
        echo "[entrypoint] settings: resumeReturnDismissed=true, tui pinned, stale renderer keys removed"
      else
        echo "[entrypoint] WARN could not rewrite settings.json; left as-is" >&2
      fi
    fi
  fi
fi

# Belt-and-suspenders for the same dialog via its other gate: the seen-count in the
# global config. The threshold lives in FULLSCREEN_UPSELL_THRESHOLD above (Ges in the
# binary) and is passed to both jq programs, so the needs-fix check and the repair can
# never disagree; max() so a real count that already reached it is never lowered.
if [ -f /workspace/.claude.json ]; then
  needs_fix=$(jq -r --argjson t "$FULLSCREEN_UPSELL_THRESHOLD" 'if ((.fullscreenUpsellSeenCount // 0) >= $t
                         and has("hasDismissedFullscreenRendererPrompt") == false
                         and has("preferredRenderer") == false
                         and has("useFullscreenRenderer") == false)
                     then "no" else "yes" end' /workspace/.claude.json 2>/dev/null || echo "yes")
  if [ "$needs_fix" = "yes" ]; then
    if merged=$(jq --argjson t "$FULLSCREEN_UPSELL_THRESHOLD" '.fullscreenUpsellSeenCount = ([(.fullscreenUpsellSeenCount // 0), $t] | max)
                    | del(.hasDismissedFullscreenRendererPrompt, .preferredRenderer, .useFullscreenRenderer)' \
                  /workspace/.claude.json 2>/dev/null) && [ -n "$merged" ]; then
      if printf '%s\n' "$merged" | write_json_atomic /workspace/.claude.json; then
        echo "[entrypoint] config: fullscreenUpsellSeenCount pinned, stale renderer keys removed"
      else
        echo "[entrypoint] WARN could not rewrite .claude.json; left as-is" >&2
      fi
    fi
  fi
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

## Cluster access (if granted)

`kubectl` is installed. Whether it can actually reach the API server depends
on how this pod was deployed:

- Needs `automountServiceAccountToken` NOT disabled on the pod spec — the
  reference `deploy/pr-steward.example.yaml` disables it by default (no
  cluster access out of the box). If it's off, every kubectl call fails with
  `Unauthorized`.
- Needs RBAC bound to this pod's ServiceAccount — without a
  ClusterRole/RoleBinding, an authenticated call still gets `Forbidden`.
- When both are present, kubectl needs no kubeconfig: it auto-detects the
  in-cluster config from the mounted ServiceAccount token. Run
  `kubectl auth can-i --list` to see exactly what's actually granted, rather
  than assuming.
- The entrypoint forces `KUBECONFIG=/dev/null` on every start, so kubectl
  always uses in-cluster auto-detection regardless of any kubeconfig left in
  `$HOME/.kube/config` by a prior session — that file, if present, is inert
  and ignored, not a way to point kubectl elsewhere from inside a session.

Use this for diagnostics the mctl control plane doesn't cover directly — e.g.
a tenant onboarding workflow that reached the cluster (namespace/quota
created) but never finished registering, or checking real Argo Workflow /
Application status.
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
  # Install the bundled (pinned) version, not `latest` — otherwise the runtime
  # harness floats past the image pin on every restart. Fall back to latest
  # only when the bundled version cannot be determined.
  TARGET_VER=$(printf '%s' "$BUNDLED_VER" | awk '{print $1}')
  echo "[entrypoint] installing/refreshing native claude binary (${TARGET_VER:-latest})"
  claude install "${TARGET_VER:-latest}" --force 2>&1 | tail -8 || echo "[entrypoint] WARN native install failed; falling back to npm-global"
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

# ── Session rotation + resume resolution ─────────────────────────────────────
# A persistent operator device must keep its memory across restarts (resume the
# same session) without the session growing unbounded into the "Resume from
# summary?" modal that wedges a headless (stdin=/dev/null) bridge. We manage the
# session id ourselves in a state file and rotate to a fresh session once the
# transcript crosses a size cap — the same scheme the Mac launchd bridges use.
#   SESSION_ROTATE_MAX_MB    transcript size (MB) at which we mint a new session.
#   SESSION_RETENTION_KEEP   how many newest transcripts to keep on disk (the
#                            rest are pruned so the persistent volume / MinIO
#                            mirror does not grow forever). Default 4 = current
#                            session + 3 prior.
# Normalize a numeric env var to a positive integer, falling back to a default
# with a warning. A bad operator value must not brick the device (a non-integer
# in `$(( ))` aborts dash under set -e) nor silently break a feature (0 == always
# rotate / keep nothing). Mirrors the PR_STEWARD_TICK_TIMEOUT normalization above.
norm_posint() {  # $1 = var name, $2 = default
  eval "_v=\"\${$1}\""
  case "$_v" in
    '' | *[!0-9]* | 0)
      echo "[entrypoint] WARN $1='$_v' is not a positive integer; using default $2"
      eval "$1=$2" ;;
  esac
}

SESSION_ROTATE_MAX_MB="${SESSION_ROTATE_MAX_MB:-20}"
SESSION_RETENTION_KEEP="${SESSION_RETENTION_KEEP:-4}"
norm_posint SESSION_ROTATE_MAX_MB 20
norm_posint SESSION_RETENTION_KEEP 4
SESSION_STATE_DIR="/workspace/.claude/remote-control-state"
SESSION_STATE_FILE="$SESSION_STATE_DIR/${DEVICE_NAME}.session"
PROJECTS_DIR="/workspace/.claude/projects"
mkdir -p "$SESSION_STATE_DIR"

# Strict canonical-UUID check (NOT a glob): the id is interpolated into the
# `script -qfc "..."` command and re-evaluated by the inner shell, so a loose
# pattern admitting shell metacharacters would be a command-injection path.
valid_uuid() {
  printf '%s' "$1" | grep -qE '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
}

# Generate a lowercase UUID. /proc is always present on Linux; uuidgen (util-linux)
# is the fallback. We mint the id ourselves so the state file can track it exactly.
gen_uuid() {
  if [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  else
    uuidgen | tr 'A-Z' 'a-z'
  fi
}

# Path of the transcript for a given (validated) session id, or empty.
find_jsonl() {
  ls "$PROJECTS_DIR"/*/"$1".jsonl 2>/dev/null | head -1
}

# Keep only the SESSION_RETENTION_KEEP newest transcripts; never delete the
# active session's transcript (passed in, may not exist yet right after a mint).
prune_transcripts() {
  active="$1"
  ls -t "$PROJECTS_DIR"/*/*.jsonl 2>/dev/null | tail -n +"$((SESSION_RETENTION_KEEP + 1))" | while read -r f; do
    [ "$(basename "$f" .jsonl)" = "$active" ] && continue
    rm -f "$f" && echo "[entrypoint] pruned old transcript $(basename "$f")"
  done
  return 0   # never let a prune failure trip the caller's set -e
}

# Mint a fresh managed session: new uuid, recorded in the state file, launched
# with --session-id (creates the session with that exact id).
mint_fresh_session() {
  RESUME_UUID=$(gen_uuid)
  printf '%s %s\n' "$RESUME_UUID" "$(date +%s)" > "$SESSION_STATE_FILE"
  RESUME_FLAG="--session-id $RESUME_UUID"
  echo "[entrypoint] starting fresh managed session $RESUME_UUID"
}

# Resolve which session to launch and set RESUME_FLAG + RESUME_UUID. Called
# before EVERY (re)launch. Precedence (an explicit operator choice always wins
# over the managed/backstop machinery):
#   RESUME_SESSION=false      -> mint fresh (escape hatch for a bad transcript)
#   RESUME_SESSION_ID=<uuid>  -> resume that exact session, NO rotation, and
#                               clear any stale force-fresh sentinel so a pinned
#                               session is never abandoned (keeps a deploy a
#                               no-op while the pin remains set)
#   force-fresh sentinel      -> mint fresh (set by the startup-wedge backstop;
#                               only reached in managed mode, never under a pin)
#   else (managed)            -> state-file session, rotating on size; if there is
#                               no state file yet, adopt the newest transcript on
#                               disk so an existing pinned session is preserved.
resolve_resume() {
  RESUME_FLAG=""
  RESUME_UUID=""

  if [ "${RESUME_SESSION:-true}" = "false" ]; then
    echo "[entrypoint] RESUME_SESSION=false; starting fresh session"
    mint_fresh_session
    prune_transcripts "$RESUME_UUID"
    return 0
  fi

  # Explicit operator pin: resume exactly this session, no managed rotation. This
  # is checked BEFORE the force-fresh sentinel so the startup-wedge backstop can
  # never rotate away an operator-pinned session (the no-op-until-gitops case).
  if [ -n "${RESUME_SESSION_ID:-}" ]; then
    if valid_uuid "$RESUME_SESSION_ID"; then
      rm -f "$FORCE_FRESH_SENTINEL"   # a pin must not be overridden by a stale sentinel
      RESUME_UUID="$RESUME_SESSION_ID"
      RESUME_FLAG="--resume $RESUME_UUID"
      echo "[entrypoint] resuming pinned session $RESUME_UUID (RESUME_SESSION_ID set; rotation disabled)"
    else
      echo "[entrypoint] RESUME_SESSION_ID '$RESUME_SESSION_ID' is not a valid UUID; falling back to managed session"
    fi
    [ -n "$RESUME_UUID" ] && return 0
  fi

  if [ -f "$FORCE_FRESH_SENTINEL" ]; then
    rm -f "$FORCE_FRESH_SENTINEL"
    echo "[entrypoint] force-fresh sentinel present; rotating to a new session"
    mint_fresh_session
    prune_transcripts "$RESUME_UUID"
    return 0
  fi

  # Managed path: read the state file. Only the session id is needed at resume
  # time — the recorded epoch is the second field (kept for the on-disk format /
  # future age policy) and is intentionally ignored here (rotation is size-based).
  STATE_UUID=""
  [ -f "$SESSION_STATE_FILE" ] && read -r STATE_UUID _ < "$SESSION_STATE_FILE" || true

  if [ -n "$STATE_UUID" ] && valid_uuid "$STATE_UUID"; then
    JSONL=$(find_jsonl "$STATE_UUID")
    if [ -n "$JSONL" ] && [ -f "$JSONL" ]; then
      SZ_MB=$(( $(stat -c %s "$JSONL" 2>/dev/null || echo 0) / 1048576 ))
      if [ "$SZ_MB" -lt "$SESSION_ROTATE_MAX_MB" ]; then
        RESUME_UUID="$STATE_UUID"
        RESUME_FLAG="--resume $RESUME_UUID"
        echo "[entrypoint] resuming managed session $RESUME_UUID (${SZ_MB}MB < ${SESSION_ROTATE_MAX_MB}MB)"
        prune_transcripts "$RESUME_UUID"
        return 0
      fi
      echo "[entrypoint] managed session $STATE_UUID is ${SZ_MB}MB >= ${SESSION_ROTATE_MAX_MB}MB; rotating"
      mint_fresh_session
      prune_transcripts "$RESUME_UUID"
      return 0
    fi
    # State file points at a session with no transcript on disk yet (e.g. minted
    # but the container stopped before claude wrote the .jsonl, or the transcript
    # was pruned). A transcript IS the session, so --resume would fail / loop on
    # "session not found"; relaunch with --session-id to (re)create it with the
    # same managed id, preserving continuity of the tracked id.
    RESUME_UUID="$STATE_UUID"
    RESUME_FLAG="--session-id $RESUME_UUID"
    echo "[entrypoint] managed session $RESUME_UUID has no transcript yet; launching with --session-id"
    return 0
  fi

  # No usable state file. Adopt the newest transcript on disk so a previously
  # pinned/auto session is preserved when first switching to managed mode; only
  # mint a brand-new session if the device has no transcripts at all.
  NEWEST=$(ls -t "$PROJECTS_DIR"/*/*.jsonl 2>/dev/null | head -1 || true)
  if [ -n "$NEWEST" ]; then
    ADOPT=$(basename "$NEWEST" .jsonl)
    if valid_uuid "$ADOPT"; then
      MTIME=$(stat -c %Y "$NEWEST" 2>/dev/null || date +%s)
      printf '%s %s\n' "$ADOPT" "$MTIME" > "$SESSION_STATE_FILE"
      RESUME_UUID="$ADOPT"
      RESUME_FLAG="--resume $RESUME_UUID"
      echo "[entrypoint] adopting newest transcript $RESUME_UUID into managed state"
      prune_transcripts "$RESUME_UUID"
      return 0
    fi
  fi
  echo "[entrypoint] no transcript found; starting fresh managed session"
  mint_fresh_session
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
#
# A second, distinct failure mode lives here too: the relay's outbound :443
# connection can disappear outright (not wedged-with-backlog, just gone) and
# never reconnect on its own. Measured in prod (2026-06-30): an idle managed
# session loses its last ESTABLISHED :443 socket on a near-exact ~10min cadence
# (almost certainly a network-path idle timeout upstream of the relay, not a
# claude crash — the process stays alive and responsive), and 3/3 observed
# cycles took the kubelet liveness path (health-proxy TLS_GRACE_MS=60s, then
# the failureThreshold budget) ~210-235s after the socket vanished to kill and
# fully recreate the pod (native-binary reinstall, steward rebootstrap, etc.).
# TLS_DEAD_SECONDS catches this in-pod, well inside that budget, so we get the
# cheap --resume relaunch instead of a full pod recreate.
WATCHDOG_ENABLED="${WATCHDOG_ENABLED:-true}"
WATCHDOG_INTERVAL_SECONDS="${WATCHDOG_INTERVAL_SECONDS:-15}"
WATCHDOG_STALL_SECONDS="${WATCHDOG_STALL_SECONDS:-120}"
TLS_DEAD_SECONDS="${TLS_DEAD_SECONDS:-75}"

# True (exit 0) if any ESTABLISHED outbound :443 socket has a non-zero rx_queue.
# /proc/net/tcp{,6}: col 4 = state (01=ESTABLISHED), col 3 = rem addr (port 443
# = hex 01BB), col 5 = tx_queue:rx_queue (hex). String compare avoids gawk
# strtonum (absent in the slim image's awk).
relay_has_backlog() {
  awk 'FNR>1 && $4=="01" && $3 ~ /:01BB$/ { split($5,q,":"); if (q[2] !~ /^0+$/) f=1 } END { exit (f?0:1) }' \
    /proc/net/tcp /proc/net/tcp6 2>/dev/null
}

# True (exit 0) if there is at least one ESTABLISHED outbound :443 socket.
# Mirrors health-proxy.js's hasOutboundTls() check.
relay_tls_established() {
  awk 'FNR>1 && $4=="01" && $3 ~ /:01BB$/ { f=1 } END { exit (f?0:1) }' \
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

# Kill the remote-control claude leaf (TERM, then KILL if it survives 5s) so the
# supervisor loop relaunches it with --resume in-pod. $1 is a log-only reason.
kill_claude_leaf() {
  cpid=$(find_claude_pid || true)
  if [ -n "$cpid" ]; then
    echo "[watchdog] $1; killing claude pid=$cpid for in-pod relaunch"
    kill -TERM "$cpid" 2>/dev/null || true
    sleep 5
    if kill -0 "$cpid" 2>/dev/null; then
      echo "[watchdog] claude pid=$cpid alive after TERM; SIGKILL"
      kill -KILL "$cpid" 2>/dev/null || true
    fi
  else
    echo "[watchdog] $1 but no claude leaf found (mid-relaunch?)"
  fi
}

if [ "$WATCHDOG_ENABLED" = "true" ]; then
  (
    stall_start=0
    tls_dead_since=0
    last_pid=""
    while true; do
      sleep "$WATCHDOG_INTERVAL_SECONDS"
      now=$(date +%s)

      # A launch can exit for reasons unrelated to this watchdog (a crash, the
      # supervisor's own relaunch, or startup_wedge_probe killing a first
      # no-connect attempt at its 75s grace mark). If the claude leaf's pid
      # changed since the last tick, any backlog/TLS-down streak we were
      # timing belonged to the PREVIOUS process — carrying it over would let a
      # brand-new launch inherit an already-expired timer and get killed
      # within one poll interval, before it has had any chance to connect,
      # short-circuiting startup_wedge_probe's own grace window and 2-strike
      # same-session-then-rotate logic.
      cur_pid=$(find_claude_pid || true)
      if [ "$cur_pid" != "$last_pid" ]; then
        stall_start=0
        tls_dead_since=0
        last_pid="$cur_pid"
      fi

      if relay_has_backlog; then
        if [ "$stall_start" -eq 0 ]; then stall_start="$now"; fi
        if [ $((now - stall_start)) -ge "$WATCHDOG_STALL_SECONDS" ]; then
          kill_claude_leaf "relay rx stalled >=${WATCHDOG_STALL_SECONDS}s"
          stall_start=0
          tls_dead_since=0
          continue
        fi
      else
        stall_start=0
      fi

      if relay_tls_established; then
        tls_dead_since=0
      else
        if [ "$tls_dead_since" -eq 0 ]; then tls_dead_since="$now"; fi
        if [ $((now - tls_dead_since)) -ge "$TLS_DEAD_SECONDS" ]; then
          kill_claude_leaf "relay TLS connection gone >=${TLS_DEAD_SECONDS}s"
          tls_dead_since=0
          stall_start=0
        fi
      fi
    done
  ) &
  echo "[entrypoint] wedge watchdog pid=$! stall=${WATCHDOG_STALL_SECONDS}s tls_dead=${TLS_DEAD_SECONDS}s interval=${WATCHDOG_INTERVAL_SECONDS}s"
fi

# ── Startup-wedge backstop ───────────────────────────────────────────────────
# The rx-backlog watchdog above catches a session that connected and then
# stalled. It CANNOT catch the resume-from-summary modal: that blocks startup
# *before* the relay connects, so there is no :443 socket to inspect — the device
# silently never registers ("Remote Control failed to connect: /login"). The
# CLAUDE_CODE_RESUME_* env vars + resumeReturnDismissed setting suppress that
# modal today, but a future Claude Code auto-update could rename the gate and
# re-expose it. This backstop is the safety net: after each launch, if the relay
# has not come up within the grace window (health-proxy /healthz != 200) while
# claude is still alive, we relaunch the SAME session once (covers a transient
# relay/network blip); if the SAME session fails to connect a second time we set
# a force-fresh sentinel (resolve_resume rotates to a new session, escaping a bad
# transcript / modal) and fire a Telegram alert so a wedge becomes auto-recover +
# ping instead of a silent hang.
STARTUP_WEDGE_ENABLED="${STARTUP_WEDGE_ENABLED:-true}"
STARTUP_WEDGE_GRACE_SECONDS="${STARTUP_WEDGE_GRACE_SECONDS:-75}"
norm_posint STARTUP_WEDGE_GRACE_SECONDS 75
FORCE_FRESH_SENTINEL="/workspace/.claude/.force-fresh-next"
WEDGE_ATTEMPTS_FILE="/workspace/.claude/.wedge-attempts"

# HTTP status of the local health proxy (200 = relay up). curl is in the image.
healthz_code() {
  curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:${PORT:-8080}/healthz" 2>/dev/null || echo 000
}

# Best-effort Telegram alert. Gated on TELEGRAM_BOT_TOKEN + STARTUP_WEDGE_ALERT_CHAT_ID;
# logs loudly and returns 0 when unconfigured so the recovery path never blocks.
send_wedge_alert() {
  code="$1"; uuid="$2"
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${STARTUP_WEDGE_ALERT_CHAT_ID:-}" ]; then
    echo "[startup-wedge] TELEGRAM_BOT_TOKEN/STARTUP_WEDGE_ALERT_CHAT_ID not set; skipping alert"
    return 0
  fi
  text="[$DEVICE_NAME] startup wedge: relay never came up (healthz=$code) for session $uuid — forced a FRESH session. Resume-modal suppression may have broken (Claude Code update?); check CLAUDE_CODE_RESUME_* env."
  curl -s -m 10 -o /dev/null \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${STARTUP_WEDGE_ALERT_CHAT_ID}" \
    --data-urlencode "text=${text}" \
    && echo "[startup-wedge] alert sent to chat ${STARTUP_WEDGE_ALERT_CHAT_ID}" \
    || echo "[startup-wedge] alert send failed"
}

# One-shot per-launch probe. Args: <claude_child_pid> <session_uuid>.
startup_wedge_probe() {
  child="$1"; uuid="$2"
  sleep "$STARTUP_WEDGE_GRACE_SECONDS"
  kill -0 "$child" 2>/dev/null || return 0          # already exited; supervisor handles it
  code=$(healthz_code)
  if [ "$code" = "200" ]; then
    rm -f "$WEDGE_ATTEMPTS_FILE" 2>/dev/null || true  # connected — clear any streak
    return 0
  fi
  # Relay not up and claude still alive → wedge candidate. Use a per-uuid streak
  # counter so a transient blip only costs one relaunch of the same session.
  prev_uuid=""; prev_n=0
  [ -f "$WEDGE_ATTEMPTS_FILE" ] && read -r prev_uuid prev_n < "$WEDGE_ATTEMPTS_FILE" || true
  if [ "$prev_uuid" = "$uuid" ] && [ "${prev_n:-0}" -ge 1 ]; then
    # Second consecutive failure of the same session.
    rm -f "$WEDGE_ATTEMPTS_FILE" 2>/dev/null || true
    if [ -n "${RESUME_SESSION_ID:-}" ]; then
      # Operator pin: never abandon it — relaunch the SAME pinned session and do
      # not write the force-fresh sentinel (resolve_resume would honor the pin
      # anyway, but skipping the write keeps the no-op-until-gitops guarantee and
      # avoids alert spam during a real relay/network outage).
      echo "[startup-wedge] pinned session $uuid failed to connect $((prev_n + 1))x (healthz=$code); RESUME_SESSION_ID set — relaunching same, NOT rotating"
    else
      echo "[startup-wedge] session $uuid failed to connect $((prev_n + 1))x (healthz=$code); forcing FRESH session + alert"
      : > "$FORCE_FRESH_SENTINEL"
      send_wedge_alert "$code" "$uuid"
    fi
  else
    if [ "$prev_uuid" = "$uuid" ]; then n=$((prev_n + 1)); else n=1; fi
    printf '%s %s\n' "$uuid" "$n" > "$WEDGE_ATTEMPTS_FILE"
    echo "[startup-wedge] session $uuid not connected (healthz=$code), attempt $n; relaunching same session (transient guard)"
  fi
  kill -TERM "$child" 2>/dev/null || true
}

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
WEDGE_PROBE_PID="" # PID of the per-launch startup-wedge probe, if any
on_term() {
  echo "[entrypoint] received SIGTERM/INT; stopping claude"
  [ -n "$WEDGE_PROBE_PID" ] && kill "$WEDGE_PROBE_PID" 2>/dev/null || true
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
  # Per-launch startup-wedge backstop: detects a relay that never comes up (e.g.
  # a resume modal blocking startup) and rotates to a fresh session + alerts.
  WEDGE_PROBE_PID=""
  if [ "$STARTUP_WEDGE_ENABLED" = "true" ] && [ -n "$RESUME_UUID" ]; then
    startup_wedge_probe "$CLAUDE_CHILD" "$RESUME_UUID" &
    WEDGE_PROBE_PID=$!
  fi
  wait "$CLAUDE_CHILD"
  rc=$?
  set -e
  # The probe is one-shot; stop it if claude exited on its own before the grace
  # window elapsed, so a stale probe can't kill the NEXT launch.
  [ -n "$WEDGE_PROBE_PID" ] && kill "$WEDGE_PROBE_PID" 2>/dev/null || true
  WEDGE_PROBE_PID=""
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
