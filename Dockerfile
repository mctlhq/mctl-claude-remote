FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code@latest

WORKDIR /workspace

COPY health-proxy.js /opt/health-proxy.js
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV HOME=/workspace

ENTRYPOINT ["/entrypoint.sh"]
