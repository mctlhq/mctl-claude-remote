#!/bin/zsh
# Run the isolation probe as every given slot user and fail unless all attempts matched.
#   zsh ops/host-boundary-probe.sh <slot> <slot> [...]     (operator account; uses sudo -n -H -u)
# Needs the slots' slot.pw files to exist (start each slot once, or copy the password in).
set -euo pipefail
H=${MCTL_BRIDGE_HOME:-$HOME/mctl-bridge}
(( $# >= 2 )) || { echo "give at least two slots: a probe with no other slot proves nothing" >&2; exit 2; }
probe=${MCTL_BRIDGE_PROBE:-${0:A:h}/host-boundary-probe.py}
rc=0
slots=(${(u)@})   # duplicates would leave a slot with no "other" and skip its cross-slot checks
(( ${#slots} >= 2 )) || { echo "need at least two DISTINCT slots" >&2; exit 2; }
for s in $slots; do
  others=(${slots:#$s})
  (( ${#others} >= 1 )) || { echo "no other slot for $s: refusing to pass" >&2; exit 1; }
  echo "== as mctl-slot-$s =="
  sudo -n -H -u mctl-slot-$s /usr/bin/python3 -I $probe $H $HOME $s $others pid=$$ pid=1 || rc=1
done
(( rc == 0 )) && echo "ALL BOUNDARY CHECKS PASSED" || { echo "BOUNDARY CHECK FAILED" >&2; exit 1; }
