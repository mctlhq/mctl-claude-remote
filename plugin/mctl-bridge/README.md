# mctl-bridge

The queue and state machine between a ChatGPT-app orchestrator on the Mac mini and
Claude Code slots. Design: [`docs/chatgpt-orchestrator-bridge.md`](../../docs/chatgpt-orchestrator-bridge.md).

Slices 1 and 2: the server-side function library, the orchestrator's CLI, and the slot
adapter. The waker (slice 3) and the Mac mini launcher (slice 4) are not here yet.

## Layout

- `src/bridge.lua`: the `mctl_bridge` function library. Every state transition is one
  `FCALL` that updates the message, its queues, the open indexes, dedup and audit
  together. Needs a standalone Valkey (or Redis 7+).
- `src/store.ts`: typed wrappers; rejections come back as `{ ok: false, code }`.
- `src/cli.ts`: `mctl-bridge`, the orchestrator's command line (JSON output).
- `src/channel.ts`: the slot adapter, a Claude Code Channels MCP server over stdio.
  Tools: `ack_task`, `ack_reply`, `ask_orchestrator`, `report_result`, `bridge_status`.
- `hooks/state.py`: SessionStart / UserPromptSubmit / Stop hook writing the session's
  busy/idle state to `~/.mctl-bridge/state/<claude pid>.json`. Holds no credentials.
- `src/valkey.ts`: a byte-identical copy of the `mctl-events` client (a test enforces it).

## Running a slot

The adapter takes its configuration from its own environment, set in the slot's
`--mcp-config` so the credentials never enter the session's environment. There is
deliberately no plugin `.mcp.json`.

```json
{
  "mcpServers": {
    "mctl-bridge": {
      "command": "bun",
      "args": ["run", "--silent", "--no-env-file", "--config=<plugin>/bunfig.toml", "<plugin>/src/channel.ts"],
      "env": {
        "MCTL_BRIDGE_SLOT": "a",
        "MCTL_BRIDGE_VALKEY_URL": "redis://bridge_slot_a@127.0.0.1:6390/0",
        "MCTL_BRIDGE_VALKEY_PASSWORD_FILE": "/path/to/password"
      }
    }
  }
}
```

```sh
claude --mcp-config slot-a.json --strict-mcp-config --settings hooks.json \
  --dangerously-load-development-channels server:mctl-bridge
```

where `hooks.json` wires `hooks/state.py` to `SessionStart`, `UserPromptSubmit` and
`Stop`.

## CLI

```sh
export MCTL_BRIDGE_VALKEY_URL=redis://127.0.0.1:6390/0
bun run --silent --no-env-file src/cli.ts init      # load the library, report durability
bun run --silent --no-env-file src/cli.ts wait --timeout 30
bun run --silent --no-env-file src/cli.ts claim q-...
bun run --silent --no-env-file src/cli.ts reply q-... --token c-... --text "use main"
bun run --silent --no-env-file src/cli.ts errors
```

Exit status: 0 done, 1 refused by the state machine (the JSON says why), 2 usage or
connection error. `init` reports the server's persistence as `durable` only for
`appendonly yes` with `appendfsync always`.

## Tests

```sh
bun install --frozen-lockfile
bunx tsc --noEmit
bun test                 # needs valkey-server or redis-server on PATH
python3 test/mutate.py   # every guarantee reverted in turn must fail a test
```
