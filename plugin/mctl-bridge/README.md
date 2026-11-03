# mctl-bridge

The queue and state machine between a ChatGPT-app orchestrator on the Mac mini and
Claude Code slots. Design: [`docs/chatgpt-orchestrator-bridge.md`](../../docs/chatgpt-orchestrator-bridge.md).

This release is **slice 1**: the server-side function library and the orchestrator's
CLI. The slot adapter (the Channels MCP server) arrives in slice 2, so the plugin has
nothing for Claude Code to load yet and is not in the marketplace.

## Layout

- `src/bridge.lua`: the `mctl_bridge` function library. Every state transition is one
  `FCALL` that updates the message, its queues, the open indexes, dedup and audit
  together. Needs a standalone Valkey (or Redis 7+).
- `src/store.ts`: typed wrappers; rejections come back as `{ ok: false, code }`.
- `src/cli.ts`: `mctl-bridge`, the orchestrator's command line (JSON output).
- `src/valkey.ts`: a byte-identical copy of the `mctl-events` client (a test enforces it).

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
