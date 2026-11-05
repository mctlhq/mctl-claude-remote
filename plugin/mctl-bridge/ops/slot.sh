#!/bin/zsh
# Test slots for the end-to-end run: interactive Claude Code on a pty (ops/slot-pty.py).
#
#   slot.sh start <slot> <repo dir>   start slot (at most MCTL_BRIDGE_MAX_SLOTS, default 2)
#   slot.sh stop <slot>               end the session (the adapter unregisters)
#   slot.sh show <slot> [lines]       print the end of the slot's rendered screen
#   slot.sh prompt <slot>             JSON: is a permission prompt waiting, whole command included
#   slot.sh state <slot>              JSON: alive, seconds since last output, prompt (not heartbeat)
#   slot.sh keys <slot> <string>      type into the slot (printf escapes: \r = Enter)
#   slot.sh list                      running slots
#
# Slots run in --permission-mode default, never with --dangerously-skip-permissions.
# Only the bridge's own tools are pre-allowed; anything else prompts, and prompts are
# answered through Remote Control. Each slot has its own Valkey user and password file;
# the user can only append to its request stream and read its response stream and inbox.
# Each slot runs as its own macOS user `mctl-slot-<slot>` (created by host-boundary.sh), so
# its shell cannot read another slot's password, the orchestrator's or the admin's, and
# cannot reach the Codex control socket. The operator reaches the slot users through
# `sudo -n -H -u` (-H: the slot user's HOME, not the operator's). The slot's files, logs and
# hook state live in that user's home. If the user does not exist, start refuses, unless
# MCTL_BRIDGE_TRUSTED_EXPERIMENT=1 runs the slot under the operator's uid (no isolation).
# Each slot also starts with Remote Control, named mctl-slot-<SLOT> (upper case), so it shows up
# in the Claude app on a phone and its permission prompts can be answered there. Needs a
# claude.ai login in the slot user. MCTL_BRIDGE_REMOTE_CONTROL=0 turns it off.
set -euo pipefail
H=${MCTL_BRIDGE_HOME:-$HOME/mctl-bridge}
MAX=${MCTL_BRIDGE_MAX_SLOTS:-2}
MODEL=${MCTL_BRIDGE_SLOT_MODEL:-haiku}
cmd=${1:-}; shift || true

# A JSON string literal for $1 (escapes quotes, backslashes, control characters).
json() { /usr/bin/python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.argv[1]))' "$1"; }

PY=${MCTL_BRIDGE_PYTHON:-/usr/bin/python3}
PTY=${0:A:h}/slot-pty.py
SLOT_USER_PREFIX=${MCTL_BRIDGE_SLOT_USER_PREFIX:-mctl-slot-}
HOME_ROOT=${MCTL_BRIDGE_SLOT_HOME_ROOT:-/Users}
# Slot context. Sets U (slot user or empty), D (slot dir) and as_ (run a command as the slot).
slotctx() {
  U=${SLOT_USER_PREFIX}$1
  if id -u "$U" >/dev/null 2>&1; then
    D=$HOME_ROOT/$U/.mctl-bridge
    as_() { sudo -n -H -u "$U" "$@"; }
    BOUNDARY=1
  elif [[ ${MCTL_BRIDGE_TRUSTED_EXPERIMENT:-0} == 1 ]]; then
    U=; D=$H/slots/$1
    as_() { "$@"; }
    BOUNDARY=0
  else
    echo "no macOS user $U: run ops/host-boundary.sh first, or set MCTL_BRIDGE_TRUSTED_EXPERIMENT=1 (no isolation)" >&2
    exit 2
  fi
}
# put <file> <mode>: write stdin to a file owned by the slot user, never readable by others.
put() { as_ sh -c 'umask 077; cat > "$1" && chmod "$2" "$1"' sh "$1" "${2:-600}"; }

admin() { $H/valkey/bin/valkey-cli -p ${MCTL_BRIDGE_PORT:-6390} --user bridge_admin --pass "$(cat $H/etc/admin.pw)" --no-auth-warning "$@"; }

# Sessions are per user, so ask each known slot's own user.
running() {
  local f s
  for f in $H/etc/slot-*.pw(N); do
    s=${${f:t}#slot-}; s=${s%.pw}
    ( slotctx $s 2>/dev/null && as_ $PY -I $PTY ping $D 2>/dev/null && echo $s ) || true
  done
}

case $cmd in
  start)
    s=${1:?slot}; repo=${2:?repo dir}
    [[ $s =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] || { echo "bad slot name" >&2; exit 2; }
    slotctx $s
    as_ test -d "$repo" || { echo "no such dir $repo (as ${U:-the operator})" >&2; exit 2; }
    if running | grep -qx "$s"; then echo "slot $s already running" >&2; exit 1; fi
    n=$(running | grep -c . || true)
    (( n < MAX )) || { echo "already $n slots running (limit $MAX)" >&2; exit 1; }
    d=$D
    sh_home=${U:+$HOME_ROOT/$U}; sh_home=${sh_home:-$HOME}
    as_ mkdir -p -m 700 "$d" "$d/log"
    # The slot user reads the plugin code; it must not be able to change it (operator-owned).
    chmod -R go-w,a+rX $H/plugin
    chmod go-w,a+rx $PTY
    # Own Valkey user. Request stream: write only. Response stream and inbox: read only.
    # No FCALL, no scripting: the ingester applies requests as the orchestrator.
    pw=$H/etc/slot-$s.pw
    [[ -s $pw ]] || (umask 077; openssl rand -hex 24 > $pw)
    k=mctl:bridge:s:$s:
    admin ACL SETUSER bridge_slot_$s reset on ">$(cat $pw)" -@all +xadd +xread +xrevrange +ping \
      "%W~${k}out" "%R~${k}resp" "%R~${k}inbox" >/dev/null
    admin SADD mctl:bridge:slots-allowed $s >/dev/null
    admin ACL SAVE >/dev/null
    # The password the slot's MCP process reads lives in the slot user's own home (mode 600).
    # The operator's copy in $H/etc stays operator-only and is never readable by any slot.
    put $d/slot.pw 600 < $pw
    # Credentials reach only the MCP process, through its own env block.
    # Paths are data: every value is JSON-encoded for the JSON files and zsh-quoted
    # (${(qq)...}: single quotes, safe for sh too) where a shell reads it.
    bun=${BUN:-$HOME/.bun/bin/bun}; port=${MCTL_BRIDGE_PORT:-6390}
    put $d/mcp.json 600 <<JSON
{"mcpServers":{"mctl-bridge":{"command":$(json "$bun"),"args":["run","--silent","--no-env-file",$(json "--config=$H/plugin/bunfig.toml"),$(json "$H/plugin/src/channel.ts")],
 "env":{"MCTL_BRIDGE_SLOT":$(json "$s"),"MCTL_BRIDGE_TRANSPORT":"rpc","MCTL_BRIDGE_VALKEY_URL":$(json "redis://bridge_slot_$s@127.0.0.1:$port/0"),"MCTL_BRIDGE_VALKEY_PASSWORD_FILE":$(json "$d/slot.pw")}}}}
JSON
    hook=$(json "/usr/bin/python3 ${(qq)H}/plugin/hooks/state.py")
    put $d/settings.json 600 <<JSON
{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":$hook}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":$hook}]}],"Stop":[{"hooks":[{"type":"command","command":$hook}]}]}}
JSON
    # Remote Control name (a flag with a value, or nothing). The slot name is already restricted
    # to [a-z0-9-], and the name is zsh-quoted anyway.
    rc=; rcname=${MCTL_BRIDGE_RC_PREFIX:-mctl-slot-}${(U)s}
    [[ ${MCTL_BRIDGE_REMOTE_CONTROL:-1} == 0 ]] || rc="--remote-control ${(qq)rcname} "
    tools=mcp__mctl-bridge__ack_task,mcp__mctl-bridge__ack_reply,mcp__mctl-bridge__ask_orchestrator,mcp__mctl-bridge__report_result,mcp__mctl-bridge__bridge_status
    # In run.sh below the unlock goes through security's interactive mode on stdin: the password
    # never reaches argv, and without -p a plain unlock would read /dev/tty (the session's pty)
    # and wedge the slot. (No backticks in the heredoc: it is expanded when written.)
    put $d/run.sh 700 <<RUN
#!/bin/zsh
export PATH=${(qq)sh_home}/.local/bin:/usr/local/bin:/usr/bin:/bin
export ENABLE_CLAUDEAI_MCP_SERVERS=false
# Claude Code keeps its login in the user's login keychain: unlock it for this session.
kc=${(qq)d}/keychain.pw
[[ -r \$kc ]] && printf 'unlock-keychain -p %s %s\\n' "\$(<\$kc)" ${(qq)sh_home}/Library/Keychains/login.keychain-db | security -i >/dev/null 2>&1
cd ${(qq)repo:A}
exec claude ${rc}--model ${(qq)MODEL} --mcp-config ${(qq)d}/mcp.json --strict-mcp-config --settings ${(qq)d}/settings.json \\
  --dangerously-load-development-channels server:mctl-bridge \\
  --allowedTools $tools --permission-mode default 2>>${(qq)d}/log/slot-$s.err
RUN
    # cd to the slot's home first: the host starts in the operator's cwd, which the slot user
    # may not be allowed to enter.
    ( cd /; as_ $PY -I $PTY start $d $d/run.sh )
    echo "started slot $s in ${repo:A} (pty session in $d); accept the channels prompt with: slot.sh keys $s '\\r'"
    ;;
  stop)
    s=${1:?slot}; slotctx $s
    as_ $PY -I $PTY keys $D '/exit\r' >/dev/null 2>&1 || true
    sleep 3
    as_ $PY -I $PTY stop $D 2>/dev/null || true
    echo "stopped slot $s"
    ;;
  show)
    s=${1:?slot}; slotctx $s
    as_ $PY -I $PTY show $D ${2:-20}
    ;;
  prompt)  # JSON: is a permission prompt or dialog waiting, with the whole command/detail text
    s=${1:?slot}; slotctx $s
    as_ $PY -I $PTY prompt $D
    ;;
  state)   # JSON: alive, seconds since the last output, prompt. The adapter heartbeat is not progress.
    s=${1:?slot}; slotctx $s
    as_ $PY -I $PTY state $D
    ;;
  keys)
    s=${1:?slot}; slotctx $s; as_ $PY -I $PTY keys $D "${2:?string}"
    ;;
  list) running ;;
  uid)  # report the uid that actually owns the slot's claude process (for the isolation proof)
    s=${1:?slot}; slotctx $s
    ps -axo uid=,user=,pid=,command= | awk -v u="${U:-$USER}" -v s="bridge-slot-$s" '$2==u && ($0 ~ s || $0 ~ /claude/) {print}' | head -5 ;;
  *) sed -n '2,12p' $0; exit 2 ;;
esac
