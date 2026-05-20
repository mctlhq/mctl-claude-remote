# mctl-claude-remote Development Rules

## Commit Conventions
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`
- Subject line under 72 characters

## Versioning & Tags
- Semantic versioning: MAJOR.MINOR.PATCH
- Tags use NO `v` prefix: `1.2.0`, not `v1.2.0`
- Tag triggers the GHCR build — no manual image push needed

## Code Constraints
- `entrypoint.sh`: must stay POSIX-compatible (`#!/bin/sh`, not bash)
- `health-proxy.js`: zero npm dependencies — only Node.js built-ins
- `Dockerfile`: keep the image lean; avoid adding apt packages without a clear reason

## PR Review Flow
- Non-trivial changes: trigger `@claude review` after opening the PR
- Docs-only or single-line config changes: merge immediately
