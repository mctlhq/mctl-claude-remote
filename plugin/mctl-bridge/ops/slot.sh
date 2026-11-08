#!/bin/zsh
# Test slots for the end-to-end run: interactive Claude Code on a pty (ops/slot-pty.py).
#
#   slot.sh start <slot> <repo dir> [--resume <session-id>]
#                                     start slot (at most MCTL_BRIDGE_MAX_SLOTS, default 2).
#                                     --resume resumes that earlier Claude Code conversation
#                                     (claude --resume <id>) so a restarted slot keeps its
#                                     context. The id must be a UUID; anything else is refused,
#                                     never replaced by a fresh session.
#   slot.sh session-id <slot>         print the session id of a RUNNING slot (from its hook state
#                                     file), one line; an error if unknown, never an empty line
#   slot.sh stop <slot>               end the session (the adapter unregisters)
#   slot.sh show <slot> [lines]       print the end of the slot's rendered screen
#   slot.sh prompt <slot>             JSON: is a permission prompt waiting, whole command included
#   slot.sh state <slot>              JSON: alive, seconds since last output, prompt (not heartbeat)
#   slot.sh keys <slot> <string>      type into the slot (printf escapes: \r = Enter)
#   slot.sh list                      running slots
#
# Slots run in --permission-mode default, never with --dangerously-skip-permissions.
# The bridge's own tools and a fixed list of local work (see "Permission rules" below) are
# pre-allowed; remote writes and credentials are denied (best-effort, see below); anything else prompts, and prompts are
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
# Sonnet by default: slots do real code work. Haiku was the default for the protocol-only end-to-end
# run; on 2026-11-07 a restart without MCTL_BRIDGE_SLOT_MODEL quietly put both slots back on it.
# The model is printed at start, so a restart shows which one it got.
MODEL=${MCTL_BRIDGE_SLOT_MODEL:-sonnet}
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
    # Optional --resume <session-id>. Validated before anything is written: the id is data that
    # ends up in a generated shell script, and a bad one must not fall back to a fresh session.
    resume=
    if (( $# > 2 )); then
      [[ ${3-} == --resume && $# -eq 4 ]] || { echo "usage: slot.sh start <slot> <repo dir> [--resume <session-id>]" >&2; exit 2; }
      [[ $4 =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || { echo "bad session id for --resume (expected a UUID like the one 'slot.sh session-id' prints)" >&2; exit 2; }
      resume="--resume ${(qq)4} "
    fi
    slotctx $s
    as_ test -d "$repo" || { echo "no such dir $repo (as ${U:-the operator})" >&2; exit 2; }
    if running | grep -qx "$s"; then echo "slot $s already running" >&2; exit 1; fi
    n=$(running | grep -c . || true)
    (( n < MAX )) || { echo "already $n slots running (limit $MAX)" >&2; exit 1; }
    d=$D
    sh_home=${U:+$HOME_ROOT/$U}; sh_home=${sh_home:-$HOME}
    as_ mkdir -p -m 700 "$d" "$d/log" "$d/handoff"
    # The slot's handoff directory (#127): the channel's export_handoff writes the bundle and
    # manifest there, and mctl-publish, running as the operator, reads them from there. Owned by
    # the slot user, mode 700, so no other slot can enter it. Behind the user boundary the slot
    # grants the operator, and only the operator, an ACL: search (pass through) on its home and
    # on $d, list and search on handoff/. The exporter writes files 644, so that is enough to read
    # them, and another slot still cannot reach them: it has no way through this slot's home.
    # -a before +a keeps one entry per start. A failure is reported, not fatal: publish then
    # refuses with handoff_unreadable, which is loud.
    as_ chmod 700 "$d/handoff"
    if (( BOUNDARY )); then
      op=$(/usr/bin/id -un)
      for acl in "$sh_home|$op allow search" "$d|$op allow search" "$d/handoff|$op allow list,search"; do
        as_ /bin/chmod -a "${acl#*|}" "${acl%%|*}" 2>/dev/null || true
        as_ /bin/chmod +a "${acl#*|}" "${acl%%|*}" 2>/dev/null || echo "handoff: could not grant ${acl#*|} on ${acl%%|*}; mctl-publish will not be able to read this slot's handoff" >&2
      done
    fi
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
    # Dependencies for the typecheck channel rule 14 promises. The launcher installs them here, as
    # the slot user, from the committed lockfile only: --frozen-lockfile refuses a lockfile that
    # does not match package.json, and --ignore-scripts runs no package's install scripts. The slot
    # itself still cannot install anything. A failure is reported and does not stop the start:
    # tests that need no packages still run, and the typecheck then fails visibly.
    # MCTL_BRIDGE_SLOT_DEPS=0 skips it.
    if [[ ${MCTL_BRIDGE_SLOT_DEPS:-1} != 0 ]]; then
      locks=(${(f)"$(cd / && as_ find "${repo:A}" -maxdepth 3 -name bun.lock -not -path '*/node_modules/*' 2>/dev/null || true)"})
      for lock in $locks; do
        if out=$(cd / && as_ sh -c 'cd "$1" && exec "$2" install --frozen-lockfile --ignore-scripts' sh "${lock:h}" "$bun" 2>&1); then
          echo "deps: installed in ${lock:h}"
        else
          echo "deps: bun install failed in ${lock:h}; the slot's typecheck will fail: ${out[-300,-1]}" >&2
        fi
      done
    fi
    put $d/mcp.json 600 <<JSON
{"mcpServers":{"mctl-bridge":{"command":$(json "$bun"),"args":["run","--silent","--no-env-file",$(json "--config=$H/plugin/bunfig.toml"),$(json "$H/plugin/src/channel.ts")],
 "env":{"MCTL_BRIDGE_SLOT":$(json "$s"),"MCTL_BRIDGE_TRANSPORT":"rpc","MCTL_BRIDGE_VALKEY_URL":$(json "redis://bridge_slot_$s@127.0.0.1:$port/0"),"MCTL_BRIDGE_VALKEY_PASSWORD_FILE":$(json "$d/slot.pw"),"MCTL_BRIDGE_HANDOFF_ROOT":$(json "$d/handoff")}}}}
JSON
    hook=$(json "/usr/bin/python3 ${(qq)H}/plugin/hooks/state.py")
    # Permission rules. allow = local, reversible work inside the slot's own checkout: reading,
    # searching, local git (no remote writes), editing, and the test/syntax runners. deny wins
    # over allow and covers everything that leaves the machine or touches credentials. A slot
    # has no GitHub credentials by design, so push/gh are denied rather than merely unprompted.
    # Everything not listed still prompts. Edit/Write are scoped by Claude Code to the working
    # directory; which FILES a task may touch is checked on the diff, not here.
    # Reading goes through the built-in Read/Grep/Glob tools, where the Read denies below apply.
    # Bash readers (cat, grep, rg, sed, awk, jq, diff, ...) are deliberately NOT allowed: a Read deny
    # does not bind a Bash subprocess, so allowing them would make credential reads silent. They
    # prompt; slots read with the built-in Read/Grep/Glob tools. The pipe filters head, tail, wc and
    # cut ARE allowed, so a compound command such as `git log | tail -3` does not prompt on its last
    # stage. They can also read a named file, so the Bash(*...*) denies below block commands that
    # mention a credential path. Those are best-effort command-text matches, not a boundary.
    # sort and uniq stay out: `sort -o FILE` and `uniq IN OUT` write files.
    # The denies are best-effort: a Bash rule matches the command text (git -C . push, /bin/rm and
    # sh -c are not caught), so the real boundary is the slot's own macOS user and the absence of
    # GitHub credentials. git push is also simply not allowed, so it prompts as well as being denied.
    # python3 -m unittest and bun test run repo code: they are trusted-code execution by design.
    # The bridge suite runs from the repository root as `bun test --cwd plugin/mctl-bridge`, which
    # Bash(bun test:*) already covers, so a slot needs no cd. Not `bun --cwd plugin/mctl-bridge test`: that form runs the package.json script,
    # not the test runner, and a general Bash(bun --cwd:*) would run any script in any directory.
    # cmp, cd and python3 - stay out for the reason above: they would read past the Read denies.
    # Build, typecheck and Go tests (operator decision 2026-11-07: tests, typecheck, lint and build
    # run without asking). go build/test/vet run repo code like bun test does, and may fetch modules
    # through the Go proxy (read-only, checked against go.sum). Their -exec, -toolexec and -vettool
    # flags run an arbitrary program, so those are denied. go run, go generate, go get, go mod and
    # gofmt -w stay out: they run code of the command line's choosing or rewrite files outside Edit.
    # golangci-lint run is the repository lint step (installed on the mini under mctl-slot-tools at the
    # version mctl-api CI pins). Like go vet it runs the repo's own configuration and analysers, which
    # is trusted-code execution by design. Its --fix flag rewrites files outside Edit, as gofmt -w does,
    # so any golangci-lint command containing --fix is denied; golangci-lint fmt and custom (which builds
    # a binary) are simply not allowed, so they prompt.
    # Typecheck is the exact package script, not Bash(bun run:*), which would run any script.
    # Rebasing onto origin/main is exact too: a general Bash(git rebase:*) would allow --exec/-x,
    # which runs any command. git merge stays out: mctl-publish refuses merge commits anyway.
    # GIT_EDITOR=true keeps git rebase --continue from opening an editor in a terminal nobody sees.
    # date only reads. ps is allowed in one exact form, the one channel rule 15 gives, and every
    # ps command containing an e or E is denied: -e, -E and the BSD-style e print the environment of
    # the caller's own processes, which in the trusted experiment are the operator's. The allowed
    # form has no e in it (lstart, not etime), so the deny cannot catch it.
    # kill is allowed only behind the user boundary, where the kernel limits it to the slot user's
    # own processes; in the trusted experiment the slot runs as the operator, so kill still prompts.
    # pkill and killall match by name or pattern and can hit a process the slot did not start, so
    # they are denied in both modes (channel rule 13).
    allow='"Read","Edit","Write","Glob","Grep","Bash(git status:*)","Bash(git diff:*)","Bash(git log:*)","Bash(git show:*)","Bash(git branch:*)","Bash(git rev-parse:*)","Bash(git ls-files:*)","Bash(git grep:*)","Bash(git blame:*)","Bash(git fetch origin:*)","Bash(git checkout:*)","Bash(git switch:*)","Bash(git add:*)","Bash(git commit:*)","Bash(git stash:*)","Bash(git restore:*)","Bash(git worktree:*)","Bash(ls:*)","Bash(pwd)","Bash(head:*)","Bash(tail:*)","Bash(wc:*)","Bash(cut:*)","Bash(python3 -m unittest:*)","Bash(python3 -m py_compile:*)","Bash(python3 -I -m unittest:*)","Bash(sh -n:*)","Bash(bash -n:*)","Bash(zsh -n:*)","Bash(shellcheck:*)","Bash(bun test:*)","Bash(bun run typecheck)","Bash(bun run --cwd plugin/mctl-bridge typecheck)","Bash(go build:*)","Bash(go test:*)","Bash(go vet:*)","Bash(gofmt -l:*)","Bash(gofmt -d:*)","Bash(golangci-lint run:*)","Bash(git rebase origin/main)","Bash(git rebase --continue)","Bash(git rebase --abort)","Bash(ps -o pid,ppid,stat,lstart,command -p:*)","Bash(date)","Bash(date -u)"'
    deny='"Bash(git push:*)","Bash(git remote:*)","Bash(git config:*)","Bash(git credential:*)","Bash(gh:*)","Bash(curl:*)","Bash(wget:*)","Bash(ssh:*)","Bash(scp:*)","Bash(sudo:*)","Bash(security:*)","Bash(rm -rf:*)","Bash(rm -fr:*)","Bash(rm -r -f:*)","Bash(rm -f -r:*)","Bash(open:*)","Bash(go *-exec*)","Bash(go *-toolexec*)","Bash(go *-vettool*)","Bash(golangci-lint *--fix*)","Bash(*.ssh*)","Bash(*.config/gh*)","Bash(*.aws*)","Bash(*.git-credentials*)","Bash(*.pw*)","Bash(*keychain*)","Read(~/.ssh/**)","Read(~/.config/gh/**)","Read(~/.aws/**)","Read(**/*.pw)","Bash(pkill:*)","Bash(killall:*)","Bash(ps *e*)","Bash(ps *E*)"'
    if (( BOUNDARY )); then allow+=',"Bash(kill:*)"'; fi
    put $d/settings.json 600 <<JSON
{"permissions":{"allow":[$allow],"deny":[$deny]},
 "env":{"GIT_EDITOR":"true"},
 "hooks":{"SessionStart":[{"hooks":[{"type":"command","command":$hook}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":$hook}]}],"Stop":[{"hooks":[{"type":"command","command":$hook}]}]}}
JSON
    # Remote Control name (a flag with a value, or nothing). The slot name is already restricted
    # to [a-z0-9-], and the name is zsh-quoted anyway.
    rc=; rcname=${MCTL_BRIDGE_RC_PREFIX:-mctl-slot-}${(U)s}
    [[ ${MCTL_BRIDGE_REMOTE_CONTROL:-1} == 0 ]] || rc="--remote-control ${(qq)rcname} "
    tools=mcp__mctl-bridge__ack_task,mcp__mctl-bridge__ack_reply,mcp__mctl-bridge__ask_orchestrator,mcp__mctl-bridge__report_result,mcp__mctl-bridge__export_handoff,mcp__mctl-bridge__bridge_status
    # In run.sh below the unlock goes through security's interactive mode on stdin: the password
    # never reaches argv, and without -p a plain unlock would read /dev/tty (the session's pty)
    # and wedge the slot. (No backticks in the heredoc: it is expanded when written.)
    put $d/run.sh 700 <<RUN
#!/bin/zsh
# After the system entries, so they add the test tools (bun, valkey-server) and shadow nothing.
export PATH=${(qq)sh_home}/.local/bin:/usr/local/bin:/usr/bin:/bin:${(qq)bun:h}:${(qq)H}/valkey/bin
export ENABLE_CLAUDEAI_MCP_SERVERS=false
# The hook (hooks/state.py) and the adapter (src/channel.ts) both honour this: one state dir for
# the slot in both modes, the one 'slot.sh session-id' reads (without it the trusted mode would
# write to the operator's ~/.mctl-bridge/state).
export MCTL_BRIDGE_STATE_DIR=${(qq)d}/state
# Claude Code keeps its login in the user's login keychain: unlock it for this session.
kc=${(qq)d}/keychain.pw
[[ -r \$kc ]] && printf 'unlock-keychain -p %s %s\\n' "\$(<\$kc)" ${(qq)sh_home}/Library/Keychains/login.keychain-db | security -i >/dev/null 2>&1
cd ${(qq)repo:A}
exec claude ${rc}--model ${(qq)MODEL} ${resume}--mcp-config ${(qq)d}/mcp.json --strict-mcp-config --settings ${(qq)d}/settings.json \\
  --dangerously-load-development-channels server:mctl-bridge \\
  --allowedTools $tools --permission-mode default 2>>${(qq)d}/log/slot-$s.err
RUN
    # cd to the slot's home first: the host starts in the operator's cwd, which the slot user
    # may not be allowed to enter.
    ( cd /; as_ $PY -I $PTY start $d $d/run.sh )
    echo "started slot $s in ${repo:A} on model $MODEL (pty session in $d); accept the channels prompt with: slot.sh keys $s '\\r'"
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
  session-id)  # the running slot's current session id, from the hook's state file
    s=${1:?slot}
    [[ $s =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] || { echo "bad slot name" >&2; exit 2; }
    slotctx $s
    ( cd /; as_ $PY -I $PTY ping $D ) >/dev/null 2>&1 || { echo "slot $s is not running: no session id" >&2; exit 1; }
    # The newest state file wins (an earlier run of the slot may have left an older pid file).
    # Not found, unreadable or not a UUID is an error, never an empty line.
    id=$(as_ /usr/bin/python3 -I -c '
import glob, json, os, re, sys
best = None
for f in glob.glob(os.path.join(sys.argv[1], "state", "*.json")):
    try:
        with open(f) as fh:
            r = json.load(fh)
        sid = r["session_id"]
        t = float(r["t"])
    except Exception:
        continue
    if isinstance(sid, str) and re.fullmatch(r"[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", sid) and (best is None or t > best[0]):
        best = (t, sid)
if best is None:
    sys.exit(1)
print(best[1])
' $D) || { echo "slot $s: no readable session id in $D/state (the SessionStart hook has not recorded one)" >&2; exit 1; }
    [[ -n $id ]] || { echo "slot $s: empty session id" >&2; exit 1; }
    print -r -- $id
    ;;
  uid)  # report the uid that actually owns the slot's claude process (for the isolation proof)
    s=${1:?slot}; slotctx $s
    ps -axo uid=,user=,pid=,command= | awk -v u="${U:-$USER}" -v s="bridge-slot-$s" '$2==u && ($0 ~ s || $0 ~ /claude/) {print}' | head -5 ;;
  *) sed -n '2,24p' $0; exit 2 ;;
esac
