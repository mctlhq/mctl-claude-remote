# mctl-bridge

The queue and state machine between a ChatGPT-app orchestrator on the Mac mini and
Claude Code slots. Design: [`docs/chatgpt-orchestrator-bridge.md`](../../docs/chatgpt-orchestrator-bridge.md).

Slices 1 to 3: the server-side function library, the orchestrator's CLI, the slot
adapter, and the waker with the sweeper. The Mac mini launcher (slice 4) is not here yet.

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
- `src/waker.ts`: the waker. It starts a turn in the orchestrator's Codex thread when a
  question has waited unclaimed, and it runs the sweeper. It never answers a question.
- `src/appserver.ts`: a minimal client for the Codex app-server control socket
  (WebSocket over a Unix socket, JSON-RPC).
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

## Running the waker

```sh
MCTL_BRIDGE_VALKEY_URL=redis://bridge_orch@127.0.0.1:6390/0 \
MCTL_BRIDGE_VALKEY_PASSWORD_FILE=/path/to/password \
MCTL_BRIDGE_THREAD_ID=<orchestrator thread id> \
  bun run --silent --no-env-file src/waker.ts
```

Optional settings: `MCTL_BRIDGE_CODEX_SOCKET` (default
`~/.codex/app-server-control/app-server-control.sock`), `MCTL_BRIDGE_WAKE_QUIET_MS`
(30000), `MCTL_BRIDGE_WAKES_PER_HOUR` (12), `MCTL_BRIDGE_WAKES_PER_QUESTION` (2),
`MCTL_BRIDGE_TURN_TIMEOUT_MS` (900000), `MCTL_BRIDGE_RPC_TIMEOUT_MS` (30000),
`MCTL_BRIDGE_POLL_MS` (2000), `MCTL_BRIDGE_SWEEP_MS` (5000) and
`MCTL_BRIDGE_STALE_MS` (30000).

The waker wakes only an idle thread: `turn/start` on a busy Codex thread joins the
running turn instead of refusing. It sends the wake id as `clientUserMessageId` and
matches the history on that id, read through `thread/turns/list` with full items.

## CLI

```sh
export MCTL_BRIDGE_VALKEY_URL=redis://127.0.0.1:6390/0
bun run --silent --no-env-file src/cli.ts init      # load the library, report durability
bun run --silent --no-env-file src/cli.ts wait --timeout 30
bun run --silent --no-env-file src/cli.ts claim q-...
bun run --silent --no-env-file src/cli.ts reply q-... --token c-... --text "use main"
bun run --silent --no-env-file src/cli.ts errors    # delivery_unknown, wake_unknown, late evidence
bun run --silent --no-env-file src/cli.ts wakes
bun run --silent --no-env-file src/cli.ts resolve w-... --reason "no turn in the thread"
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
