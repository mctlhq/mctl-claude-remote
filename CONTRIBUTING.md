# Contributing

Contributions are welcome. Please read this guide before opening a pull request.

## Development setup

Requirements: Docker, git.

```sh
git clone https://github.com/mctlhq/mctl-claude-remote.git
cd mctl-claude-remote
docker build -t claude-remote:dev .
```

## Making changes

1. Fork the repository and create a branch:
   ```sh
   git checkout -b feat/your-feature
   ```

2. Make your changes. Keep the following constraints in mind:
   - `entrypoint.sh` must remain POSIX-compatible (`#!/bin/sh`, not bash)
   - `health-proxy.js` must remain zero-dependency (no `require()` of npm packages)
   - `Dockerfile` base image is `node:22-slim` — avoid adding heavy apt packages

3. Test locally with `docker build` before pushing.

4. Commit using [Conventional Commits](https://www.conventionalcommits.org/):
   ```
   feat: add support for custom HOME directory
   fix: restore exec bit after MinIO restore
   chore: bump node base image to 22.4
   ```

5. Open a pull request against `main`. The title should follow the same convention.

## Release process

Releases are tag-driven. Maintainers create a semver tag (no `v` prefix) and push it:

```sh
git tag 1.2.3
git push origin 1.2.3
```

GitHub Actions builds and publishes `ghcr.io/mctlhq/claude-remote:1.2.3` automatically.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Please be respectful.
