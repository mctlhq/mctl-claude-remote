#!/bin/sh
# Table test for image-relevant.sh: 0 = build the image, 1 = skip.
S="$(dirname "$0")/image-relevant.sh"
fail=0
check() { # name expected input
  printf '%s' "$3" | sh "$S"; got=$?
  if [ "$got" -ne "$2" ]; then echo "FAIL $1: want $2 got $got"; fail=1; else echo "ok   $1"; fi
}
check bridge-only 1 'plugin/mctl-bridge/src/publish.ts
plugin/mctl-bridge/test/publish.test.ts
plugin/mctl-bridge/ops/orchestrator-AGENTS.md
plugin/mctl-bridge/README.md
'
check events-plugin-only 1 'plugin/mctl-events/src/policy.ts
'
check docs-and-ci-only 1 'README.md
docs/a.md
.github/workflows/pr-checks.yml
events/tests/test_x.py
'
check dockerfile 0 'Dockerfile
'
check dockerignore 0 '.dockerignore
'
check health-proxy 0 'health-proxy.js
'
check entrypoint 0 'entrypoint.sh
'
check bin 0 'bin/claude-pty-launch
'
check skills 0 'skills/pr-steward/SKILL.md
'
check events-package 0 'events/mctl_events/adapter.py
'
check mixed-bridge-and-image 0 'plugin/mctl-bridge/src/publish.ts
bin/gh-app-token
'
check build-workflow 0 '.github/workflows/build.yml
'
check script-itself 0 '.github/scripts/image-relevant.sh
'
check empty-list 0 ''
check blank-line-only 0 '
'
check quoted-path 0 '"docs/\303\251.md"
'
check blank-lines-then-bridge 1 '

plugin/mctl-bridge/README.md
'
check no-trailing-newline-image 0 'README.md
skills/x/SKILL.md'
check no-trailing-newline-bridge 1 'README.md'
exit $fail
