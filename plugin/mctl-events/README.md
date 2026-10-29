# mctl-events Claude Code plugin

A TypeScript port of the Python inbound events Channel adapter in
[`events/mctl_events/`](../../events/mctl_events). It reads the
`mctl.events/v1` streams from Valkey, delivers each admitted event to a running
Claude Code session as a `notifications/claude/channel` notification, and gives
the session the `ack_event` and `event_status` tools.

The port is behaviour for behaviour: same consumer group handling, same pending
recovery and reclaim, same audit trail, same tool contract and the same
environment variables. A session can switch between the two implementations by
changing only the command that starts the MCP server. The Python adapter stays
in place and is still what runs in production until someone switches.

It has no runtime dependencies. The compiled JavaScript is committed in
`dist/`, so Claude Code runs it straight from the plugin directory with no build
or `npm install` step. CI fails when `dist/` does not match a fresh build of
`src/`.

## Requirements

- Node.js 22.18 or newer on `PATH` as `node` (the plugin's `.mcp.json` runs
  `node`).
- Claude Code with Channels support (research preview). A plugin channel that is
  not on the approved allowlist needs the development-channels flag below.
- A Valkey or Redis 7+ server holding the event streams.

## Install

From inside Claude Code:

```
/plugin marketplace add mctlhq/mctl-claude-remote
/plugin install mctl-events@mctlhq
```

Or from a shell:

```
claude plugin marketplace add mctlhq/mctl-claude-remote
claude plugin install mctl-events@mctlhq
```

The marketplace is named `mctlhq` (see `.claude-plugin/marketplace.json` at the
repository root). Auto-update is off by default for third-party marketplaces;
update explicitly with `claude plugin marketplace update mctlhq` followed by
`claude plugin update mctl-events@mctlhq`.

Start the session with the channel enabled:

```
claude --dangerously-load-development-channels plugin:mctl-events@mctlhq
```

To try a local checkout without installing it, load it with
`claude --plugin-dir plugin/mctl-events`. The MCP server and its tools load that
way (verified); the channel id a `--plugin-dir` plugin answers to under
`--dangerously-load-development-channels` has not been verified.

### Tool names under a plugin

Claude Code namespaces a plugin's MCP tools, so the tools are

- `mcp__plugin_mctl-events_mctl-events__ack_event`
- `mcp__plugin_mctl-events_mctl-events__event_status`

and not `mcp__mctl-events__ack_event` as with the server configured through
`--mcp-config`. Any `--allowedTools` list, permission rule or prompt text that
names the tools must use the plugin form.

### `--strict-mcp-config` excludes plugin servers

Verified with Claude Code 2.1.312: with `--strict-mcp-config` the plugin's MCP
server is not started at all and its tools do not exist; without the flag it
starts and both tools are listed. A session that has to keep
`--strict-mcp-config` (to keep user-scope MCP servers out) cannot use the
plugin's server; it uses the compiled adapter through `--mcp-config` instead,
as described under [Running without the plugin](#running-without-the-plugin).

## Environment

The same contract as the Python adapter. The server inherits the environment of
the `claude` process.

| Variable | Required | Meaning |
| --- | --- | --- |
| `MCTL_EVENTS_VALKEY_URL` | yes | `redis://` or `valkey://`, `[user[:password]@]host[:port][/db]`. TLS (`rediss://`) is not supported, as in the Python adapter. |
| `MCTL_EVENTS_POLICY` | yes | Path to the routing policy JSON: consumer group, consumer name, streams, admitted sources, types and subject fields. The format is the one `events/mctl_events/policy.py` validates. |
| `MCTL_EVENTS_VALKEY_PASSWORD_FILE` | no | File holding the password. It takes precedence over a password in the URL, so the secret stays out of the process environment. A trailing newline is stripped. |

A missing required variable exits with status 2 before the MCP handshake. The
server logs one JSON object per line to stderr, with the same fields as the
Python adapter.

Operating the channel (the audit trail, group state, recovery after a restart)
is described in [`docs/events-operations.md`](../../docs/events-operations.md);
none of it changes with the port.

## The Telegram worker token tool

`dist/telegram-token.js` is the port of `events/mctl_events/telegram_token.py`,
with the same subcommands, flags and exit codes (0 ok, 1 failed, 2 usage,
10 relaunch the session):

```
node dist/telegram-token.js header --seed SEED --state STATE [--served SERVED]
node dist/telegram-token.js renew  --seed SEED --state STATE [--served SERVED] --mcp-url https://... \
    [--pushgateway URL] [--instance NAME] [--recycle-before SECONDS]
```

`header` is meant for an MCP server's `headersHelper`; `renew` for the hourly
loop that keeps the worker token fresh.

## Running without the plugin

The adapter does not need the plugin machinery. Point an `--mcp-config` server
entry at the compiled file:

```json
{
  "mcpServers": {
    "mctl-events": {
      "command": "node",
      "args": ["/path/to/mctl-claude-remote/plugin/mctl-events/dist/channel.js"]
    }
  }
}
```

This keeps the server name `mctl-events`, so the tools stay
`mcp__mctl-events__ack_event` / `mcp__mctl-events__event_status`, the channel
flag stays `--dangerously-load-development-channels server:mctl-events`, and it
works with `--strict-mcp-config`.

## Migrating the Mac mini channel host

Not performed; this is the procedure for whoever switches the host. The current
launcher is `~/mctl-events/run-session.sh`, which runs the Python adapter with
uv's Python 3.12.

1. **Node.** `~/.local/bin/node` is currently a dangling symlink into a removed
   runner `externals/` directory, so `node` is not usable there today. Install
   a standalone Node 24 (for example the official tarball under
   `~/.local/node24`) and point `~/.local/bin/node` at it, or set `NODE=` to an
   absolute path in `run-session.sh`. Do not link into the Actions runner's
   `externals.*` directory: runner upgrades replace it.
2. **Code.** Either clone the repository to a fixed path, or install the plugin
   (`claude plugin marketplace add mctlhq/mctl-claude-remote` and
   `claude plugin install mctl-events@mctlhq`), which places a clone under
   `~/.claude/plugins/marketplaces/mctlhq/` and a versioned copy under
   `~/.claude/plugins/cache/mctlhq/mctl-events/<version>/`. Pin the path the
   launcher uses to one of these; prefer the clone, whose path does not change
   with the version.
3. **Server entry (recommended: keep `--strict-mcp-config`).** In the generated
   `mcp.json`, change only the `mctl-events` command:

   ```
   "mctl-events": {"command": "$NODE", "args": ["$PLUGIN/dist/channel.js"]}
   ```

   The environment (`MCTL_EVENTS_VALKEY_URL`, `MCTL_EVENTS_VALKEY_PASSWORD_FILE`,
   `MCTL_EVENTS_POLICY`) stays exactly as it is. `--strict-mcp-config`,
   `--dangerously-load-development-channels server:mctl-events` and the
   `--allowedTools "mcp__mctl-events__ack_event"` entry stay unchanged.
4. **Token tool.** Replace `$PY $TG_TOOL` with `$NODE $PLUGIN/dist/telegram-token.js`
   in both the `headersHelper` and the hourly `renew` loop; the arguments are
   unchanged and exit code 10 still means "relaunch the session".
5. **Alternative: use the plugin's own server.** Drop the `mctl-events` entry
   from `mcp.json`, drop `--strict-mcp-config` (otherwise the plugin's server
   does not start), and use
   `--dangerously-load-development-channels plugin:mctl-events@mctlhq` and
   `--allowedTools "mcp__plugin_mctl-events_mctl-events__ack_event"`. Without
   `--strict-mcp-config` the session also loads user-scope MCP servers from
   `~/.claude.json`, and any session instructions that name
   `mcp__mctl-events__ack_event` must be updated.
6. **Verify.** After the relaunch the stderr log shows
   `{"msg": "starting", ...}` followed by deliveries, and
   `XINFO GROUPS mctl:events:telegram` shows the same group and consumer as
   before: the consumer group, pending entries and per-event state keys are
   shared between the two implementations, so the switch loses and duplicates
   nothing beyond what an ordinary restart does.
7. **Rollback.** Put the `$PY -m mctl_events.channel` command (and `$PY $TG_TOOL`)
   back and relaunch. No state migration is involved in either direction.

## Differences from the Python adapter

None of these change what is delivered, acknowledged or audited for valid input.

- An envelope that is not valid JSON is rejected with the reason
  `envelope is not JSON: invalid syntax`, without Python's line and column.
- JSON numbers are IEEE doubles: `5` and `5.0` are indistinguishable (policy
  integers and the token's `exp` accept both), and integers beyond 2^53 lose
  precision. Stream entry IDs are handled as strings and BigInt, so they are
  exact.
- `tools/call` reports any unexpected error as an `isError` result; the Python
  server would crash. A failure to write a reply to stdout is logged rather than
  raised.
- The `delivery_failed` audit reason carries Node's error code (`EPIPE`,
  `ERR_STREAM_DESTROYED`) where Python wrote an exception class name.
- A Valkey error nested inside an array reply becomes a string element.
- The token tool's HTTP client does not follow redirects (Python's urllib did)
  and ignores `HTTP(S)_PROXY`; it uses Node's CA store. A non-string
  `worker_token` in the renewal reply is a clean renewal failure with metrics
  still pushed (Python failed with `AttributeError` and pushed none).
- The token tool's argument parser does not accept abbreviated flags
  (`--mcp` for `--mcp-url`), and its usage text is formatted slightly
  differently from argparse.
- RFC 3339 timestamps accept ASCII digits only.
- A lone UTF-16 surrogate in an `ack_event` note is written to the audit
  stream as U+FFFD; the Python adapter failed the audit write.
- Floats in log lines print without a trailing `.0` (`"backoff": 1`).
- An unexpected error in the consumer loop is logged as
  `consumer stopped on an unexpected error` before the server exits.

## Development

The build and test tooling lives one directory up, in `plugin/package.json`, so
that nothing in it is installed with the plugin. Its only dependencies are
`typescript` and `@types/node`, both dev-only.

```
cd plugin
npm ci
npm run typecheck
npm test            # unit tests, plus integration tests against valkey-server
npm run build       # regenerate dist/ from src/
npm run check-dist  # fail when dist/ does not match a fresh build
```

The integration tests start a throwaway `valkey-server` (or `redis-server`)
from `PATH` and are skipped when neither is installed. Tests run the compiled
`dist/` files, so run `npm run build` after changing `src/`.
