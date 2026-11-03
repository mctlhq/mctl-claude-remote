#!/bin/zsh
# Test slots for the end-to-end run: interactive Claude Code in GNU screen.
#
#   slot.sh start <slot> <repo dir>   start slot (at most MCTL_BRIDGE_MAX_SLOTS, default 2)
#   slot.sh stop <slot>               end the session (the adapter unregisters)
#   slot.sh show <slot> [lines]       print the end of the slot's screen
#   slot.sh keys <slot> <string>      type into the slot (printf escapes: \r = Enter)
#   slot.sh list                      running slots
#
# Slots run in --permission-mode default, never with --dangerously-skip-permissions.
# Only the bridge's own tools are pre-allowed; anything else prompts, and prompts are
# answered through Remote Control. TRUSTED EXPERIMENT: all slots share the
# bridge_slot Valkey user and the operator's uid (see install.sh).
set -euo pipefail
H=${MCTL_BRIDGE_HOME:-$HOME/mctl-bridge}
MAX=${MCTL_BRIDGE_MAX_SLOTS:-2}
MODEL=${MCTL_BRIDGE_SLOT_MODEL:-haiku}
cmd=${1:-}; shift || true

running() { screen -ls 2>/dev/null | grep -oE '[0-9]+\.bridge-slot-[a-z0-9-]+' | sed 's/.*bridge-slot-//' || true; }

case $cmd in
  start)
    s=${1:?slot}; repo=${2:?repo dir}
    [[ $s =~ '^[a-z0-9][a-z0-9-]{0,30}$' ]] || { echo "bad slot name" >&2; exit 2; }
    [[ -d $repo ]] || { echo "no such dir $repo" >&2; exit 2; }
    if running | grep -qx "$s"; then echo "slot $s already running" >&2; exit 1; fi
    n=$(running | grep -c . || true)
    (( n < MAX )) || { echo "already $n slots running (limit $MAX)" >&2; exit 1; }
    d=$H/slots/$s
    mkdir -p $d
    # Credentials reach only the MCP process, through its own env block.
    cat > $d/mcp.json <<JSON
{"mcpServers":{"mctl-bridge":{"command":"$HOME/.bun/bin/bun","args":["run","--silent","--no-env-file","--config=$H/plugin/bunfig.toml","$H/plugin/src/channel.ts"],
 "env":{"MCTL_BRIDGE_SLOT":"$s","MCTL_BRIDGE_VALKEY_URL":"redis://bridge_slot@127.0.0.1:${MCTL_BRIDGE_PORT:-6390}/0","MCTL_BRIDGE_VALKEY_PASSWORD_FILE":"$H/etc/slot.pw"}}}}
JSON
    hook="/usr/bin/python3 $H/plugin/hooks/state.py"
    cat > $d/settings.json <<JSON
{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"$hook"}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"$hook"}]}],"Stop":[{"hooks":[{"type":"command","command":"$hook"}]}]}}
JSON
    tools=mcp__mctl-bridge__ack_task,mcp__mctl-bridge__ack_reply,mcp__mctl-bridge__ask_orchestrator,mcp__mctl-bridge__report_result,mcp__mctl-bridge__bridge_status
    cat > $d/run.sh <<RUN
#!/bin/zsh
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
export ENABLE_CLAUDEAI_MCP_SERVERS=false
cd ${repo:A}
exec claude --model $MODEL --mcp-config $d/mcp.json --strict-mcp-config --settings $d/settings.json \\
  --dangerously-load-development-channels server:mctl-bridge \\
  --allowedTools $tools --permission-mode default 2>>$H/log/slot-$s.err
RUN
    chmod 700 $d/run.sh
    screen -dmS bridge-slot-$s $d/run.sh
    echo "started slot $s in ${repo:A} (screen bridge-slot-$s); accept the channels prompt with: slot.sh keys $s '\\r'"
    ;;
  stop)
    s=${1:?slot}
    screen -S bridge-slot-$s -p 0 -X stuff $'/exit\r' 2>/dev/null || true
    sleep 3
    screen -S bridge-slot-$s -X quit 2>/dev/null || true
    echo "stopped slot $s"
    ;;
  show)
    s=${1:?slot}; f=$H/log/slot-$s.hardcopy
    screen -S bridge-slot-$s -p 0 -X hardcopy -h $f
    sleep 0.5
    LC_ALL=C tr -cd '[:print:]\n' < $f | grep -v '^\s*$' | tail -${2:-20}
    ;;
  keys)
    s=${1:?slot}; screen -S bridge-slot-$s -p 0 -X stuff "$(printf "${2:?string}")"
    ;;
  list) running ;;
  *) sed -n '2,10p' $0; exit 2 ;;
esac
