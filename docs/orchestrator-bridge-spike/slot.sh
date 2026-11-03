#!/bin/zsh
# Gate-2 test slot: interactive claude with the probe channel, no claude.ai connectors.
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
export ENABLE_CLAUDEAI_MCP_SERVERS=false
S=$1
cd ~/bridge-gate2/$S
exec claude --model haiku --mcp-config ~/bridge-gate2/$S/mcp.json --strict-mcp-config \
  --settings ~/bridge-gate2/settings.json \
  --dangerously-load-development-channels server:probe \
  --allowedTools mcp__probe__ack --permission-mode default
