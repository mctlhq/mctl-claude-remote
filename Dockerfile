FROM node:22-slim

ARG CLAUDE_CODE_NPM_VERSION=latest

LABEL org.opencontainers.image.title="mctl-claude-remote" \
      org.opencontainers.image.description="Containerized Claude Code remote-control device for headless environments" \
      org.opencontainers.image.source="https://github.com/mctlhq/mctl-claude-remote" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_NPM_VERSION}"

WORKDIR /workspace

COPY health-proxy.js /opt/health-proxy.js
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV HOME=/workspace

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/healthz" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
