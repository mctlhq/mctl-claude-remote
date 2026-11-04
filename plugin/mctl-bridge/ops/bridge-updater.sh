#!/bin/sh
# Keep the Mac mini on the release the repository declares.
#
# Desired state, in order:
#   1. $H/etc/pin, if it holds a tag: stay on exactly that release (operator hold, also
#      the way to roll back). Delete the file to follow releases again.
#   2. otherwise the highest release tag (MAJOR.MINOR.PATCH, no "v") whose commit is an
#      ancestor of origin main. main is protected and every change reaches it through a
#      reviewed PR, so a tag on any other commit never deploys.
# Installed state: $H/VERSION ("<tag> <commit>"), written by this script and only after
# install.sh exits 0. On a difference the tagged tree is exported with git archive and
# ops/install.sh is run from that copy. Without a pin the updater never goes backwards:
# a tag that sorts below the installed one is reported, not installed (a tag pushed on an
# old main commit cannot roll the mini back; only the operator's pin can).
#
# Safety:
#  - "could not observe" is never "up to date": a failed fetch, an unreadable waker log or
#    a missing thread id is reported and nothing is installed.
#  - no install while a wake is in flight (install restarts the waker and Valkey).
#  - a release that failed to install is not retried until a newer release or a pin
#    appears ($H/etc/updater-failed), so a broken tag does not restart services every run.
#  - runs under launchd; install.sh must not bootout this job (MCTL_BRIDGE_FROM_UPDATER).
#  - all code is in main(), called on the last line, so replacing this file while it runs
#    cannot change what the running shell executes (install.sh also swaps it by rename).
#
# Test seams: MCTL_UPDATER_REPO (any git URL or path), MCTL_UPDATER_ZSH, MCTL_BRIDGE_HOME.
set -u
H=${MCTL_BRIDGE_HOME:-$HOME/mctl-bridge}
REPO=${MCTL_UPDATER_REPO:-https://github.com/mctlhq/mctl-claude-remote.git}
ZSH=${MCTL_UPDATER_ZSH:-zsh}
SUB=plugin/mctl-bridge
say() { printf '%s bridge-updater: %s\n' "$(date -u +%FT%TZ)" "$*"; }

main() {
  HERE=$(dirname "$0")
  . "$HERE/wake-state.sh" || { say "cannot read $HERE/wake-state.sh"; return 1; }

  thread=$(cat "$H/etc/thread-id" 2>/dev/null) || thread=
  if [ -z "$thread" ]; then
    say "no $H/etc/thread-id: run ops/install.sh <thread id> once by hand; not updating"
    return 0
  fi

  # One run at a time. A lock whose pid is gone is stale.
  mkdir -p "$H/run" "$H/updater" || return 1
  lock=$H/run/updater.lock
  if ! mkdir "$lock" 2>/dev/null; then
    other=$(cat "$lock/pid" 2>/dev/null || true)
    if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
      say "another run (pid $other) is active"
      return 0
    fi
    rm -rf "$lock"
    mkdir "$lock" || return 1
  fi
  echo $$ > "$lock/pid"
  tmp=
  # In POSIX sh a signal handler returns into the script: exit explicitly, and let the
  # EXIT trap release the lock.
  trap 'rm -rf "$lock" "$tmp"' EXIT
  trap 'exit 1' INT TERM

  git_dir=$H/updater/repo.git
  [ -d "$git_dir" ] || git init -q --bare "$git_dir" || return 1
  if ! git --git-dir="$git_dir" fetch -q --prune --force "$REPO" '+refs/heads/main:refs/heads/main' '+refs/tags/*:refs/tags/*' 2>&1; then
    say "could not fetch $REPO; not updating (unknown is not up to date)"
    return 1
  fi
  g() { git --git-dir="$git_dir" "$@"; }

  # A tag counts only if it is a release tag and its commit is on main.
  releasable() {
    case "$1" in ''|*[!0-9.]*|.*|*.|*..*) return 1 ;; esac
    [ "$(printf '%s' "$1" | tr -cd . | wc -c | tr -d ' ')" = 2 ] || return 1
    c=$(g rev-parse -q --verify "refs/tags/$1^{commit}") || return 1
    g merge-base --is-ancestor "$c" refs/heads/main
  }

  pin=$(tr -d ' \t\r\n' < "$H/etc/pin" 2>/dev/null || true)
  if [ -n "$pin" ]; then
    releasable "$pin" || { say "pinned tag '$pin' is not a release tag on main; not updating"; return 1; }
    want=$pin
  else
    want=
    for t in $(g tag -l | sort -t. -k1,1nr -k2,2nr -k3,3nr); do
      if releasable "$t"; then want=$t; break; fi
    done
    [ -n "$want" ] || { say "no release tag on main; not updating"; return 0; }
  fi
  sha=$(g rev-parse "refs/tags/$want^{commit}")

  have=$(cat "$H/VERSION" 2>/dev/null || true)
  if [ "$have" = "$want $sha" ]; then
    return 0
  fi
  if [ -z "$pin" ] && [ -n "$have" ]; then
    # newest of the two by MAJOR.MINOR.PATCH; the installed one wins a tie
    top=$(printf '%s\n%s\n' "${have%% *}" "$want" | sort -t. -k1,1nr -k2,2nr -k3,3nr | head -n 1)
    if [ "${have%% *}" != "$want" ] && [ "$top" = "${have%% *}" ]; then
      say "$want is older than the installed ${have%% *}; refusing to go back without etc/pin"
      return 0
    fi
  fi
  if [ -z "$pin" ] && [ "$(cat "$H/etc/updater-failed" 2>/dev/null || true)" = "$want $sha" ]; then
    say "$want ($sha) failed to install earlier; waiting for a newer release or a pin"
    return 0
  fi

  log=$H/log/waker.log
  if [ ! -r "$log" ]; then
    say "waker log unreadable ($log); not updating"
    return 0
  fi
  if [ "$(waker_state "$log")" = open ]; then
    say "update to $want pending but a wake is in flight; will retry next run"
    return 0
  fi

  say "updating from '${have:-none}' to $want ($sha)"
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/bridge-update.XXXXXX") || return 1
  if ! g archive "refs/tags/$want" "$SUB" | tar -x -C "$tmp"; then
    say "could not export $want"
    echo "$want $sha" > "$H/etc/updater-failed"
    return 1
  fi
  if MCTL_BRIDGE_HOME=$H MCTL_BRIDGE_FROM_UPDATER=1 \
      "$ZSH" "$tmp/$SUB/ops/install.sh" "$thread"; then
    rm -f "$H/etc/updater-failed"
    printf '%s\n' "$want $sha" > "$H/VERSION" || { say "installed $want but could not write $H/VERSION"; return 1; }
    say "now on $want ($sha)"
    return 0
  fi
  echo "$want $sha" > "$H/etc/updater-failed"
  say "install of $want failed; $H/VERSION unchanged ('${have:-none}')"
  return 1
}

main "$@"; exit $?
