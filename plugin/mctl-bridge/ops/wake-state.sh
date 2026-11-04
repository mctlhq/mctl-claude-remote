# Sourced by codex-remote-guard.sh and bridge-updater.sh (POSIX sh).
#
# waker_state <waker.log>  prints "open" if a wake is in flight, else "idle".
# The newest wake event decides: intent/started is open, completed/failed/no longer ours
# is idle, and a "started" line from the waker process itself orphans an open wake. Only
# wake and start events are read, so a chatty log cannot push an open wake out of a
# fixed-size window. The caller must check the log is readable first: an unreadable log
# is unknown, not idle.
waker_state() {
  grep -E '"msg":"(wake (intent|started|completed|failed|no longer ours)|started)"' "$1" | tail -n 50 | awk '
    /"msg":"wake intent"/ || /"msg":"wake started"/ { s = "open" }
    /"msg":"wake completed"/ || /"msg":"wake failed"/ || /"msg":"wake no longer ours"/ { s = "idle" }
    /"msg":"started"/ { s = "idle" }
    END { print (s == "" ? "idle" : s) }'
}
