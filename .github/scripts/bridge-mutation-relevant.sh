#!/bin/sh
# Reads changed file paths (one per line) on stdin. Exit 0 if any path is an
# input of the bridge mutation run, 1 if none is. The same list is stated in
# the PR that introduced this script, with the reason for each entry.
while IFS= read -r p; do
  case "$p" in
    plugin/mctl-bridge/src/* | \
    plugin/mctl-bridge/ops/* | \
    plugin/mctl-bridge/test/* | \
    plugin/mctl-bridge/hooks/* | \
    plugin/mctl-bridge/package.json | \
    plugin/mctl-bridge/bun.lock* | \
    plugin/mctl-bridge/bunfig.toml | \
    plugin/mctl-bridge/tsconfig.json | \
    .github/workflows/pr-checks.yml | \
    .github/scripts/bridge-mutation-relevant.sh)
      exit 0 ;;
  esac
done
exit 1
