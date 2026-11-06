#!/bin/sh
# Reads changed file paths (one per line) on stdin. Exit 0 if the bridge
# mutation run must happen, 1 only if the list was read, is non-empty, and
# every path in it is known to be outside the run's inputs. An empty list, or
# a path git had to quote (non-ASCII or special characters), is not evidence
# of "nothing relevant", so both count as relevant.
n=0
# "|| [ -n ... ]" keeps a last line with no newline; blank lines are not paths,
# so `printf '%s\n' ""` from an empty diff still counts as an empty list.
while IFS= read -r p || [ -n "$p" ]; do
  [ -z "$p" ] && continue
  n=$((n + 1))
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
    .github/scripts/bridge-mutation-relevant.sh | \
    .github/scripts/test-bridge-mutation-relevant.sh | \
    \"*)
      exit 0 ;;
  esac
done
[ "$n" -eq 0 ] && exit 0
exit 1
