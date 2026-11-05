#!/bin/sh
# Table test for bridge-mutation-relevant.sh: 0 = run mutation, 1 = skip.
S="$(dirname "$0")/bridge-mutation-relevant.sh"
fail=0
check() { # name expected input
  printf '%s' "$3" | sh "$S"; got=$?
  if [ "$got" -ne "$2" ]; then echo "FAIL $1: want $2 got $got"; fail=1; else echo "ok   $1"; fi
}
check docs-only 1 'README.md
docs/a.md
plugin/mctl-events/src/x.ts
plugin/mctl-bridge/README.md
'
check src 0 'README.md
plugin/mctl-bridge/src/channel.ts
'
check test 0 'plugin/mctl-bridge/test/mutate.py
'
check lockfile 0 'plugin/mctl-bridge/bun.lock
'
check workflow 0 '.github/workflows/pr-checks.yml
'
check script-itself 0 '.github/scripts/bridge-mutation-relevant.sh
'
check empty-list 0 ''
check quoted-path 0 '"docs/\303\251.md"
'
check no-trailing-newline 0 'plugin/mctl-bridge/ops/slot.sh'
exit $fail
