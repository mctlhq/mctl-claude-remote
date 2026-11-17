#!/bin/sh
# Reads changed file paths (one per line) on stdin. Exit 0 if the container image
# must be built and rolled out, 1 only if the list was read, is non-empty, and every
# path in it is known to be outside the image. The image holds exactly what the
# Dockerfile COPYs, so these patterns must follow it: a new COPY edits the Dockerfile,
# which is itself an input. An empty list, or a path git had to quote (non-ASCII or
# special characters), is not evidence of "nothing relevant", so both count as relevant.
# plugin/mctl-bridge and plugin/mctl-events are not in the image: the Mac mini installs
# them from the tag, not from the container.
n=0
while IFS= read -r p || [ -n "$p" ]; do
  [ -z "$p" ] && continue
  n=$((n + 1))
  case "$p" in
    Dockerfile | \
    .dockerignore | \
    health-proxy.js | \
    entrypoint.sh | \
    bin/* | \
    skills/* | \
    events/mctl_events/* | \
    .github/workflows/build.yml | \
    .github/scripts/image-relevant.sh | \
    .github/scripts/test-image-relevant.sh | \
    \"*)
      exit 0 ;;
  esac
done
[ "$n" -eq 0 ] && exit 0
exit 1
