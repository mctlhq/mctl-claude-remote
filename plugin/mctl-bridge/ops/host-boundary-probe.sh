#!/bin/zsh
# Run the isolation probe as every given slot user and fail unless all attempts matched.
#   zsh ops/host-boundary-probe.sh <slot> <slot> [...]     (operator account; uses sudo -n -H -u)
# Needs the slots' slot.pw files to exist (start each slot once, or copy the password in).
set -euo pipefail
H=${MCTL_BRIDGE_HOME:-$HOME/mctl-bridge}
(( $# >= 2 )) || { echo "give at least two slots: a probe with no other slot proves nothing" >&2; exit 2; }
probe=${MCTL_BRIDGE_PROBE:-${0:A:h}/host-boundary-probe.py}
rc=0
for s in "$@"; do
  others=(${@:#$s})
  echo "== as mctl-slot-$s =="
  sudo -n -H -u mctl-slot-$s /usr/bin/python3 -I $probe $H $HOME $s $others || rc=1
done
(( rc == 0 )) && echo "ALL BOUNDARY CHECKS PASSED" || { echo "BOUNDARY CHECK FAILED" >&2; exit 1; }
