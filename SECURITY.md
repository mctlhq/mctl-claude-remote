# Security Policy

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues.

Use GitHub's private vulnerability reporting feature instead:
[Report a vulnerability](https://github.com/mctlhq/mctl-claude-remote/security/advisories/new)

We will respond within 5 business days and keep you updated on the fix timeline.

## Scope

This repository contains a container image that runs `claude --remote-control` inside Kubernetes. Key security considerations:

- The container runs with `--dangerously-skip-permissions`, which bypasses Claude's interactive permission prompts. This is intentional for non-interactive cluster use but means the container should not be exposed publicly.
- `/workspace` contains OAuth session tokens. Ensure the MinIO bucket used for state persistence is not publicly accessible.
- The health-check proxy (port 8080) returns a static "OK" response and carries no sensitive data, but it should only be reachable within the cluster.
