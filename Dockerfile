FROM node:22-slim

# Pinned by default — the harness version must not float between rebuilds
# (June's relay-TLS incidents were version-specific behavior). Bump via an
# explicit commit, or override with --build-arg for a one-off (see issue #27).
ARG CLAUDE_CODE_NPM_VERSION=2.1.198

LABEL org.opencontainers.image.title="mctl-claude-remote" \
      org.opencontainers.image.description="Containerized Claude Code remote-control device for headless environments" \
      org.opencontainers.image.source="https://github.com/mctlhq/mctl-claude-remote" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
    openssl \
    util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_NPM_VERSION}"

# GitHub CLI — required by the optional pr-steward skill (gh pr list / comment /
# repo clone). Installed from GitHub's official apt repo; arch resolved via
# dpkg so the layer is portable if the build later goes multi-arch. Inert
# unless pr-steward is enabled.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY health-proxy.js /opt/health-proxy.js
COPY entrypoint.sh /entrypoint.sh
# Optional pr-steward automation assets. Inert unless PR_STEWARD_ENABLED=true.
COPY bin/ /opt/steward/bin/
COPY skills/ /opt/steward/skills/
RUN chmod +x /entrypoint.sh /opt/steward/bin/*

ENV HOME=/workspace

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/healthz" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
