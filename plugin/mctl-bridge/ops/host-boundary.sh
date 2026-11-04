#!/bin/zsh
# Host boundary for slice 4b: one macOS user per slot, so that slot A's shell cannot read
# slot B's credentials, the orchestrator's credentials or the Codex control socket.
#
#   sudo zsh ops/host-boundary.sh <operator user> <slot> [<slot> ...]
#   e.g. sudo zsh ops/host-boundary.sh dmitriimashkov a b
#
# Needs root, run it yourself. It does exactly this and nothing else:
#   1. creates a hidden, non-admin macOS user `mctl-slot-<slot>` per slot with dscl (no
#      password at all: nobody logs in as it, the operator reaches it with sudo -u);
#   2. creates /Users/mctl-slot-<slot>/.mctl-bridge/ (mode 700, owned by that user) for the
#      slot's Valkey password file;
#      and a login keychain for it (Claude Code keeps its login there);
#   3. writes /etc/sudoers.d/mctl-bridge allowing <operator> to run commands AS those slot
#      users only, without a password (never as root), validated with visudo before install.
# All slot users share the primary group `staff`: isolation rests on every path being mode
# 700/600 (the probe, ops/host-boundary-probe.sh, checks exactly that). A group per slot would
# remove that dependency; it is not done here because macOS group creation needs more dscl
# state for no gain while every directory is already owner-only.
# Re-running is safe: existing mctl-slot-* users keep their sudo rule. It does not touch the operator's files, Valkey or launchd.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root: sudo zsh $0 ..." >&2; exit 1; }
OP=${1:?operator user}; shift
(( $# > 0 )) || { echo "give at least one slot name" >&2; exit 2; }
id -u "$OP" >/dev/null 2>&1 || { echo "no such user $OP" >&2; exit 2; }
[[ $OP != root ]] || { echo "operator must not be root" >&2; exit 2; }

# Slot users that already exist keep their sudo rule: the file is rebuilt from the union of
# these and the slots named on this run, so a re-run with a different list drops nobody.
users=(${(f)"$(dscl . -list /Users | grep -E '^mctl-slot-[a-z0-9-]+$' || true)"})
slot_re='^[a-z0-9][a-z0-9-]{0,30}$'
for s in "$@"; do
  [[ $s =~ $slot_re ]] || { echo "bad slot name: $s" >&2; exit 2; }
  u=mctl-slot-$s
  if ! id -u $u >/dev/null 2>&1; then
    # dscl needs no secure token and never prompts. Password `*` = no password at all:
    # nobody can log in as this user, the operator reaches it with sudo -u only.
    uid=600
    while dscl . -list /Users UniqueID | awk '{print $2}' | grep -qx $uid; do uid=$((uid + 1)); done
    dscl . -create /Users/$u
    dscl . -create /Users/$u UserShell /bin/zsh
    dscl . -create /Users/$u RealName "mctl bridge slot $s"
    dscl . -create /Users/$u UniqueID $uid
    dscl . -create /Users/$u PrimaryGroupID 20
    dscl . -create /Users/$u NFSHomeDirectory /Users/$u
    dscl . -create /Users/$u Password '*'
    dscl . -create /Users/$u IsHidden 1
    echo "created user $u (uid $uid)"
  fi
  id -u $u >/dev/null 2>&1 || { echo "could not create $u" >&2; exit 1; }
  # Nobody is an admin: make sure of it.
  dseditgroup -o edit -d $u -t user admin >/dev/null 2>&1 || true
  # Always (re)set the owner: an earlier interrupted run may have left the directory root-owned.
  mkdir -p "/Users/${u}"
  chown "${u}:staff" "/Users/${u}"
  chmod 700 "/Users/${u}"
  install -d -m 700 -o "$u" -g staff "/Users/${u}/.mctl-bridge"
  chown -R "${u}:staff" "/Users/${u}/.mctl-bridge"
  # Claude Code stores its login in the login keychain, and a hidden user has none: create
  # one (random password kept in the user's own .mctl-bridge/keychain.pw, mode 600).
  sudo -n -H -u "$u" sh -c 'cd /; umask 077; K=$HOME/Library/Keychains/login.keychain-db; P=$HOME/.mctl-bridge/keychain.pw
    [ -s $P ] || openssl rand -hex 24 > $P
    # the password goes in on stdin, never on argv, where every local user could read it
    [ -e $K ] || { cat $P; cat $P; } | security create-keychain $K >/dev/null
    security default-keychain -s $K; security list-keychains -d user -s $K; security set-keychain-settings $K'
  users+=($u)
done

users=(${(u)users:#})
rule="$OP ALL=(${(j:,:)users}) NOPASSWD: ALL"
tmp=$(mktemp /etc/sudoers.d/.mctl-bridge.XXXXXX)
print -r -- "# written by ops/host-boundary.sh: the operator may act as the bridge slot users, never as root" > $tmp
print -r -- "$rule" >> $tmp
chmod 440 $tmp
visudo -cf $tmp >/dev/null || { rm -f $tmp; echo "sudoers check failed, nothing installed" >&2; exit 1; }
mv $tmp /etc/sudoers.d/mctl-bridge
echo "done: $rule"
