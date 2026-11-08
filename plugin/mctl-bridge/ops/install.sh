#!/bin/zsh
# Install or update mctl-bridge on the Mac mini for the end-to-end run (slice 4).
#
#   ops/install.sh <orchestrator thread id>
#
# Run from a checkout (or `git archive` copy) of plugin/mctl-bridge. Idempotent: it
# keeps existing passwords and data, and replaces code, config and launchd jobs.
#
# MODE (slice 4b): per-slot Valkey users. A slot user (`bridge_slot_<name>`, created by
# slot.sh) has no FCALL at all: it may append to its own request stream and read its own
# response stream and inbox, nothing else. Valkey checks ACLs on every command and key a
# function touches, so a slot allowed to FCALL could write any key; the single ingester
# (com.mctl.bridge-ingest, running as bridge_orch) applies the requests instead.
# Host-level separation of slots from the operator's uid is a separate operator step and
# is NOT done here: until it is, slot credential files are readable by the same uid.
set -euo pipefail

THREAD_ID=${1:?usage: install.sh <orchestrator thread id>}
SRC=${0:A:h:h}
H=${MCTL_BRIDGE_HOME:-$HOME/mctl-bridge}
V=$H/valkey/bin
PORT=${MCTL_BRIDGE_PORT:-6390}
BUN=${BUN:-$HOME/.bun/bin/bun}
LA=$HOME/Library/LaunchAgents
UID_=$(id -u)

[[ -x $V/valkey-server ]] || { echo "no valkey-server in $V (build it first, see ops/README.md)" >&2; exit 1; }
[[ -x $BUN ]] || { echo "no bun at $BUN" >&2; exit 1; }

umask 077
mkdir -p $LA $H/etc $H/valkey/data $H/log $H/slots $H/plugin
for u in admin orch; do
  [[ -s $H/etc/$u.pw ]] || openssl rand -hex 24 > $H/etc/$u.pw
done
hash() { printf %s "$(cat $H/etc/$1.pw)" | shasum -a 256 | cut -d' ' -f1; }

# ACL file: no comment lines (a `#` line aborts startup); `#<sha256>` sets a password.
# Only bridge_admin may load or delete the library (FUNCTION LOAD/DELETE/FLUSH are not
# in @dangerous, so @scripting is removed and only FCALL and FUNCTION LIST are added).
# Slot users are created by slot.sh and saved into this file with ACL SAVE: keep them.
KEEP=$(grep '^user bridge_slot_' $H/etc/users.acl 2>/dev/null || true)
cat > $H/etc/users.acl <<ACL
user default off resetchannels -@all
user bridge_admin on #$(hash admin) ~* &* +@all
user bridge_orch on #$(hash orch) resetchannels ~mctl:bridge:* +@all -@admin -@dangerous -@scripting +fcall +fcall_ro +function|list +config|get
ACL
[[ -z $KEEP ]] || print -r -- "$KEEP" >> $H/etc/users.acl

cat > $H/etc/valkey.conf <<CONF
bind 127.0.0.1
port $PORT
protected-mode yes
dir $H/valkey/data
aclfile $H/etc/users.acl
appendonly yes
appendfsync always
save ""
# Write volume. A slot may XADD to its own request stream, and the ACL cannot cap how
# much. These bound ONE request (1 MiB is the floor Valkey accepts; requests are <= 40000
# bytes) and the whole dataset; they do not stop a flood of valid-sized entries.
proto-max-bulk-len 1048576
client-query-buffer-limit 1048576
maxmemory 256mb
maxmemory-policy noeviction
logfile $H/log/valkey.log
CONF

# Code: only what runs. No runtime dependencies.
rsync -a --delete --exclude node_modules --exclude test --exclude ops "$SRC/" $H/plugin/
cp $SRC/ops/mctl-bridge $SRC/ops/mctl-codex $SRC/ops/mctl-publish $SRC/ops/mctl-devloop $SRC/ops/slot.sh $SRC/ops/slot-pty.py $SRC/ops/watch.sh $SRC/ops/host-boundary-probe.sh $SRC/ops/host-boundary-probe.py $H/
chmod 755 $H/mctl-bridge $H/mctl-codex $H/mctl-publish $H/mctl-devloop $H/slot.sh $H/watch.sh
# Scripts launchd runs on a timer: swap by rename, never overwrite in place, so a run that
# is executing right now (the updater runs this very script) keeps its old file intact.
for f in codex-remote-guard.sh bridge-updater.sh wake-state.sh; do
  cp $SRC/ops/$f $H/$f.new && chmod 755 $H/$f.new && mv -f $H/$f.new $H/$f
done
# What the updater needs: the thread to wake. It records the installed release in
# $H/VERSION itself, only after this script exits 0.
print -r -- "$THREAD_ID" > $H/etc/thread-id
mkdir -p $HOME/.local/bin
ln -sfn $H/mctl-bridge $HOME/.local/bin/mctl-bridge
ln -sfn $H/mctl-codex $HOME/.local/bin/mctl-codex
ln -sfn $H/mctl-publish $HOME/.local/bin/mctl-publish
ln -sfn $H/mctl-devloop $HOME/.local/bin/mctl-devloop

# The orchestrator thread may run the bridge CLI without a prompt (see the rules file).
mkdir -p $HOME/.codex/rules
cp $SRC/ops/codex-mctl-bridge.rules $HOME/.codex/rules/mctl-bridge.rules
chmod 600 $HOME/.codex/rules/mctl-bridge.rules

render() {
  sed -e "s|@HOME@|$HOME|g" -e "s|@H@|$H|g" -e "s|@BUN@|$BUN|g" -e "s|@THREAD@|$THREAD_ID|g" -e "s|@PORT@|$PORT|g" "$1"
}
for job in valkey ingest waker; do
  label=com.mctl.bridge-$job
  render $SRC/ops/$label.plist > $LA/$label.plist
  chmod 644 $LA/$label.plist
  launchctl bootout gui/$UID_/$label 2>/dev/null || true
  # bootout is asynchronous: a bootstrap before it finishes fails with error 5.
  for i in {1..50}; do launchctl print gui/$UID_/$label >/dev/null 2>&1 || break; sleep 0.2; done
done
launchctl bootstrap gui/$UID_ $LA/com.mctl.bridge-valkey.plist
# RunAtLoad does not fire for a job bootstrapped from an ssh session: start it.
launchctl kickstart gui/$UID_/com.mctl.bridge-valkey
# valkey-cli exits 0 on an error reply too (a loading server answers PING with -LOADING), so
# readiness is the PONG itself, never the exit status.
cli() { $V/valkey-cli -p $PORT --user bridge_admin --pass "$(cat $H/etc/admin.pw)" --no-auth-warning "$@"; }
valkey_up() {
  local i
  for i in {1..${MCTL_BRIDGE_READY_TRIES:-100}}; do
    [[ $(cli PING 2>/dev/null) == PONG ]] && return 0
    sleep 0.2
  done
  return 1
}
# From here on the old daemons are already booted out. A failure below must not leave the
# bridge half installed and silent: remember it, still bring every job back up (ingest and
# waker wait for the server on their own and launchd keeps restarting them), and end with a
# loud non-zero exit so the updater records the release as failed.
fail=""
if ! valkey_up; then
  fail="valkey did not become ready on :$PORT (see $H/log/valkey.err)"
elif ! MCTL_BRIDGE_VALKEY_URL=redis://bridge_admin@127.0.0.1:$PORT/0 MCTL_BRIDGE_VALKEY_PASSWORD_FILE=$H/etc/admin.pw     $BUN run --silent --no-env-file --config=$H/plugin/bunfig.toml $H/plugin/src/cli.ts init; then
  fail="mctl-bridge init failed: the function library is not loaded"
fi

launchctl bootstrap gui/$UID_ $LA/com.mctl.bridge-ingest.plist
launchctl kickstart gui/$UID_/com.mctl.bridge-ingest
launchctl bootstrap gui/$UID_ $LA/com.mctl.bridge-waker.plist
launchctl kickstart gui/$UID_/com.mctl.bridge-waker
# Keeps the Codex app-server managed and reachable from the ChatGPT app (see the script).
guard=com.mctl.codex-remote-guard
render $SRC/ops/$guard.plist > $LA/$guard.plist
chmod 644 $LA/$guard.plist
launchctl bootout gui/$UID_/$guard 2>/dev/null || true
for i in {1..50}; do launchctl print gui/$UID_/$guard >/dev/null 2>&1 || break; sleep 0.2; done
launchctl bootstrap gui/$UID_ $LA/$guard.plist
launchctl kickstart gui/$UID_/$guard
# Pulls the release the repository declares (see the script). When this install was started
# BY the updater, do not bootout its job: launchd would kill the install half way. The new
# plist takes effect the next time the job is loaded.
upd=com.mctl.bridge-updater
render $SRC/ops/$upd.plist > $LA/$upd.plist
chmod 644 $LA/$upd.plist
if [[ -z ${MCTL_BRIDGE_FROM_UPDATER:-} ]]; then
  launchctl bootout gui/$UID_/$upd 2>/dev/null || true
  for i in {1..50}; do launchctl print gui/$UID_/$upd >/dev/null 2>&1 || break; sleep 0.2; done
  launchctl bootstrap gui/$UID_ $LA/$upd.plist
  launchctl kickstart gui/$UID_/$upd
fi
if [[ -n $fail ]]; then
  echo "INSTALL FAILED: $fail. Ingester and waker were started anyway and keep retrying; see $H/log." >&2
  exit 1
fi
echo "installed: valkey :$PORT, ingester, waker on thread $THREAD_ID, CLI ~/.local/bin/mctl-bridge"
