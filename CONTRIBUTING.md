# Contributing

## Workflow

1. Fork the repository and create a branch: `feat/description` or `fix/description`.
2. Make your changes. Keep commits atomic and focused.
3. Open a pull request against `main`.

## Commit Style

[Conventional commits](https://www.conventionalcommits.org/):

```
feat: add multi-arch image build
fix: health proxy false-positive on loopback connections
chore: bump node base image to 22.4
```

- Subject line under 72 characters.
- Body explains WHY, not WHAT.
- No emoji unless explicitly requested.

## PR Review

Non-trivial PRs are reviewed automatically by Claude via the `claude-review.yml` workflow. Address all P1/P2 findings before requesting a merge. P3 nits can be deferred.

## Versioning

Tags use semver **without** a `v` prefix: `0.1.8`, not `v0.1.8`.

- Patch: bug fixes, dependency bumps with no behavior change.
- Minor: new features, new env vars.
- Major: breaking changes to the container interface.
