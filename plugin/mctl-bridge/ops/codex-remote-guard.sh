#!/bin/sh
# Keep the Codex app-server on the Mac mini managed and reachable from the ChatGPT app.
#
# Failure this fixes (2026-11-04): after a reboot an unmanaged `codex app-server --listen
# unix://` (started by something other than the daemon, no --remote-control) won the
# socket. `codex app-server daemon start` then answered "alreadyRunning" and never started
# the managed one, so nothing connected out to OpenAI and the phone showed "Unable to
# connect". The waker kept working over the local socket, so nothing else looked wrong.
#
# Every run: if an app-server is listening on a unix socket without --remote-control and
# the waker has no wake in flight, stop it and start the managed daemon with remote
# control. Never kills while a wake is in flight (the turn would be lost), and never
# touches a server that already has --remote-control.
#
# Test seams: MCTL_GUARD_CODEX (codex binary), MCTL_GUARD_PS (command printing
# "pid command" lines), MCTL_GUARD_WAKER_LOG, MCTL_GUARD_KILL, MCTL_GUARD_SLEEP.
set -u
CODEX=${MCTL_GUARD_CODEX:-$HOME/.local/bin/codex}
WAKER_LOG=${MCTL_GUARD_WAKER_LOG:-${MCTL_BRIDGE_HOME:-$HOME/mctl-bridge}/log/waker.log}
KILL=${MCTL_GUARD_KILL:-kill}
say() { printf '%s codex-remote-guard: %s\n' "$(date -u +%FT%TZ)" "$*"; }

list() {
  if [ -n "${MCTL_GUARD_PS:-}" ]; then "$MCTL_GUARD_PS"; else ps -axo pid=,command=; fi
}

# Servers that listen on a unix socket. `app-server proxy` is a client, not a server.
servers=$(list | awk '/app-server/ && /--listen unix:\/\// && !/ proxy/ { print }')
if [ -z "$servers" ]; then
  say "no app-server running; nothing to guard"
  exit 0
fi

# A server without --remote-control. If every server has it, all is well.
bad=$(printf '%s\n' "$servers" | awk '!/--remote-control/ { print $1 }')
if [ -z "$bad" ]; then
  exit 0
fi

# Wake in flight: the newest wake event is intent/started, and the waker has not been
# restarted since (a "started" line from the process itself orphans an open wake).
# An unreadable log is unknown, not idle: do nothing.
if [ ! -r "$WAKER_LOG" ]; then
  say "waker log unreadable ($WAKER_LOG); not restarting"
  exit 0
fi
state=$(tail -n 400 "$WAKER_LOG" | awk '
  /"msg":"wake intent"/ || /"msg":"wake started"/ { s = "open" }
  /"msg":"wake completed"/ || /"msg":"wake failed"/ || /"msg":"wake no longer ours"/ { s = "idle" }
  /"msg":"started"/ { s = "idle" }
  END { print (s == "" ? "idle" : s) }')
if [ "$state" = open ]; then
  say "unmanaged app-server found but a wake is in flight; will retry next run"
  exit 0
fi

for pid in $bad; do
  say "app-server pid $pid has no --remote-control; stopping it"
  $KILL "$pid" || { say "could not stop pid $pid"; exit 1; }
done
sleep "${MCTL_GUARD_SLEEP:-3}"
say "starting the managed daemon with remote control"
"$CODEX" remote-control start >/dev/null 2>&1 || { say "codex remote-control start failed"; exit 1; }
say "done"
