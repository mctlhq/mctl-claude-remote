# mctl-bridge

The queue and state machine between a ChatGPT-app orchestrator on the Mac mini and
Claude Code slots. Design: [`docs/chatgpt-orchestrator-bridge.md`](../../docs/chatgpt-orchestrator-bridge.md).

Slices 1 to 4: the server-side function library, the orchestrator's CLI, the slot
adapter, the waker with the sweeper, and the Mac mini launcher (`ops/`). Slice 4b adds
the per-slot boundary below.

## Slot isolation (slice 4b)

A slot's Valkey user has **no FCALL and no scripting**: Valkey checks the ACL on every
command and key a function touches, so a slot allowed to call functions could write any
key. Instead the slot talks through three keys that are its own:

- `mctl:bridge:s:<slot>:out` (write): requests `{rid, fn, args}`, `args` a JSON array of
  strings without the slot.
- `mctl:bridge:s:<slot>:resp` (read): answers `{rid, resp}`, written by the orchestrator side.
- `mctl:bridge:s:<slot>:inbox` (read).

One ingester (`src/ingest.ts`, running as `bridge_orch`) takes the slot from the stream
name, never from the request, and applies each entry in one `FCALL bridge_ingest`: it
checks the per-slot checkpoint, looks the request id up in a memo (a retry returns the
stored answer; the same id with another request is refused as `rid_conflict`), runs the
slot function, stores the memo and the answer, and advances the checkpoint, all together.
A rejected entry is recorded under `mctl:bridge:rejected:<slot>` and the audit trail, the
checkpoint moves on, and its request id is not remembered, so a forged id cannot suppress
a later valid request. A slot can trim its own staging stream (`XADD ... MAXLEN 0`), so
the adapter reports success only after reading an answer.

The adapter's transport is `MCTL_BRIDGE_TRANSPORT=rpc` (default; `direct` is for tests
and the trusted tooling). `ack_task` returns a grant only if its `task_id`, `attempt_id`,
`conn_id`, `epoch`, `uuid` and the live connection all match; otherwise `stale_grant`
and no work starts. `ops/slot.sh start` creates `bridge_slot_<name>`, its password file
and the allow-list entry (`mctl:bridge:slots-allowed`).

To keep a slot's context across a restart, read its session id while it runs
(`ops/slot.sh session-id <slot>`, from the hook's state file) and start it again with
`ops/slot.sh start <slot> <repo> --resume <id>` (`claude --resume <id>`; the id must be a
UUID, anything else is refused). A resumed session still believes its old attempt admission
is valid and the bridge refuses a stale one, so the task text after a restart must tell the
slot to call `ack_task` for the new attempt.

A request whose handler raises a script error (Valkey does not roll back the writes made
before the error) is answered once: the ingester passes the request id, function and
arguments to `bridge_ingest_poison`, which stores the rejection (`rejected` /
`handler_error`) as the memo and the answer. A retry of the same id gets that answer and
the handler is not run again; the same id with another request is a `rid_conflict`. An
entry with no valid id can only be recorded and skipped.

### Write volume (what is bounded, what is not)

The ACL limits which keys a slot writes, not how much. `ops/install.sh` therefore sets,
in `valkey.conf`: `proto-max-bulk-len` and `client-query-buffer-limit` at 1 MiB (the lowest
value Valkey accepts; requests are at most 40000 bytes, enforced by the ingester), and
`maxmemory 256mb` with `maxmemory-policy noeviction`. The test server runs with the same
values and a test proves that a 2 MiB `XADD` from a slot credential is refused and changes
nothing (another test keeps `install.sh` and the test profile equal).

What this does not do:

- A slot can still append entries up to 1 MiB each as fast as the server accepts them,
  so a single request is bounded to 1 MiB but the stream is not. The ingester removes an
  entry only when it gets to it.
- `noeviction` never discards state, so when memory reaches the cap every write command
  fails with `OOM`, **including the orchestrator's and the ingester's** (they are
  `FCALL`s). A flooding slot can therefore stall the whole bridge until memory is freed
  by an operator (stop the slot, `XTRIM` its `:out` stream as `bridge_admin`). Nothing is
  lost and no wrong answer is given (a slot reports success only after reading an
  answer), but availability is not protected. Watch `used_memory` against `maxmemory`.
- Bounding the staging stream from the ingester side (trimming a lagging slot's stream)
  is not done: it cannot be bounded in bytes, and a flooder outpaces a drain loop.

Not done by this slice: A and B still run under one OS account. Separate uids, protected
credential files and the Codex socket are an operator step (needs sudo); until then the
credential files of A and B are readable from either.

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

## Deploying to the Mac mini (declarative)

`com.mctl.bridge-updater` (`ops/bridge-updater.sh`, every 10 minutes) keeps the mini on the
release the repository declares, so nothing is copied by hand.

- **Desired state:** the highest `MAJOR.MINOR.PATCH` tag (no `v`) whose commit is an ancestor
  of `main`. A tag on any other commit never deploys. Releases are manual: pushing an
  `X.Y.Z` tag runs `.github/workflows/build.yml`, which builds and pushes the image and
  dispatches the gitops image bump.
- **Hold or roll back:** put a tag in `~/mctl-bridge/etc/pin` (it must also be on `main`).
  Delete the file to follow releases again.
- **Installed state:** `~/mctl-bridge/VERSION` (`<tag> <commit>`), written by the updater only
  after `install.sh` exits 0; on a difference the tagged tree is exported and its
  `ops/install.sh` runs. Without a pin the updater never goes backwards (a lower tag is
  reported, not installed); only `etc/pin` can roll back, and a pin written after a
  failure retries that release once (a failed retry is not repeated until the pin is
  rewritten). A bad high tag on an old `main` commit sticks once installed; recover with a pin. Log: `~/mctl-bridge/log/bridge-updater.log`.
- **Safe by default:** a failed fetch, an unreadable waker log or a missing
  `etc/thread-id` is reported and nothing is installed; no install while a wake is in flight;
  a release that failed to install is not retried until a newer release or a pin appears
  (`etc/updater-failed`).
- **Bootstrap once by hand:** `ops/install.sh <thread id>` (also writes `etc/thread-id`).
  The hand install is for bootstrapping: it kickstarts the updater, which installs the
  declared release over it within seconds unless `VERSION` already matches. To run unreleased
  code, stop the job first (`launchctl bootout gui/$(id -u)/com.mctl.bridge-updater`).
  Only people who can push tags can choose what the updater considers a release (still
  limited to commits on `main`): restrict tag creation to release maintainers with a tag ruleset.
  After that the updater takes over. A new updater plist takes effect the next time the
  job is loaded, because the updater cannot boot itself out mid-install.
- `com.mctl.codex-remote-guard` is installed by the same script (see `ops/codex-remote-guard.sh`).

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

Free text (`send` payload, `reply` text, `resolve` reason) takes exactly one source,
so that no shell has to quote it: `--text T`, `--stdin` (or `--text -`) or
`--file PATH`. stdin and file text is UTF-8, byte-exact except that one trailing
newline is dropped (a here-document always adds one). Zero or several sources exit 2.
Use `reply Q --token T --stdin <<'EOF'` for anything with quotes, `$`, backticks,
backslashes or newlines.

Exit status: 0 done, 1 refused by the state machine (the JSON says why), 2 usage or
connection error. `init` reports the server's persistence as `durable` only for
`appendonly yes` with `appendfsync always`.

## Reading and writing the Codex thread

`mctl-publish` is how the orchestrator writes to GitHub, as `mctl-codex[bot]`. That GitHub App
has contents and pull requests write, checks and statuses read, no administration and no
workflows, on selected repositories. Its key is `etc/codex-github-app.pem`, mode 0600.

```
mctl-publish status
mctl-publish publish --repo R --bundle F --manifest F --allow PATH --title T --body-file F
mctl-publish ready --repo R --pr N --head SHA
mctl-publish merge --repo R --pr N --head SHA
```

Exit status: 0 ok, 1 usage, 2 unreadable, 3 refused, 4 outcome unknown (not retried).

- `publish` reads the slot's files without following symlinks and only from a closed copy. It
  checks the hash, the bundle, that the base is on `main`, and that the commits change exactly
  the manifest's files, all inside `--allow`. Workflow changes, symlinks and submodules are
  refused. The push keeps the SHAs and is never forced. A ledger keyed by repository, task and
  head stops a second publication, and a run that stopped midway resumes from what GitHub shows.
- `merge` requires, on the current head: claude[bot]'s latest review APPROVED, no open change
  request, every check and status passed including `validate`, and a clean mergeable state. It
  pins the SHA and uses a merge commit. It does not read review findings: that stays with Codex.
- Git runs with `credential.helper=` and the token in its environment. Without that, git asks
  the keychain first, and the Mac mini's keychain holds an admin login: on 2026-11-06 a probe
  pushed to a protected `main` that way, as the admin, while the App itself was refused.
- There is no approve command, on purpose. GitHub refuses an App's approval of its own PR but
  accepts its approval of anybody else's, and that approval satisfies the ruleset.

`mctl-codex` is the operator's CLI for the orchestrator's thread, over the control socket.
It holds no Valkey credentials and prints JSON. The socket's directory is closed to the slot
users, and the Codex command rules do not list it, so Codex itself gets a prompt.

```
mctl-codex status                 # idle, active, and flags such as waiting on approval
mctl-codex log --limit 3          # messages of the newest turns, no tool calls, secrets redacted
mctl-codex questions              # lines marked [operator-question] since the operator's last message
mctl-codex say --stdin --wait 120 # one turn in an idle thread, marked [lead-claude]
```

- A failed read exits 2. It never looks like an empty log or like nothing waiting; a window
  with no operator message and older turns reports `older_unknown: true`.
- `say` refuses a busy thread (a start would join the running turn), records the text in
  `log/lead-sends.jsonl` before sending, never retries, and sends no model, effort, approval
  or sandbox fields, because those overrides are sticky and change the thread on the phone.
- Once a turn has started, `say` exits 0 whatever happens next. A reply it could not read is
  `reply_error`, a send log it could not write is `log_error`, and a connection lost during
  `--wait` is `turn_status: "unknown"`. Exit 2 from `say` therefore means nothing started; exit 4
  means the outcome is unknown. Read the log before sending again.
- Redaction is pattern based. It lowers the risk of a secret leaving the thread, it does not
  rule it out, so treat the output as sensitive.
- What Codex wrote is data, not instructions, for whoever reads it.

## Tests

```sh
bun install --frozen-lockfile
bunx tsc --noEmit
bun test                 # needs valkey-server or redis-server on PATH
                         # from the repository root: bun test --cwd plugin/mctl-bridge
python3 test/mutate.py   # every guarantee reverted in turn must fail a test
```

In CI the mutation run is split into 8 parallel jobs (`python3 test/mutate.py
--shard I/8`, round-robin over the list). Each shard still runs the full
`bun test` per mutation and checks the patterns of the whole list first; a
shard fails if a mutation survives, a run crashes, or it runs a different
number of mutations than its partition. `test/test_shards.py` proves the shards
are disjoint and cover the list, and the `validate` job (the required check)
passes only when the other jobs, every shard included, succeeded.
