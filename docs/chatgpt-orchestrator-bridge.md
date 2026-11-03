# ChatGPT app orchestrator for Claude Code slots on the Mac mini

Status: design for an MVP. Both gates passed on 2026-11-03 (see
[Gate results](#gate-results-2026-11-03)); the bridge itself is not written yet.
This file is the canonical plan; change the design by editing it.

## Goal

The operator works in the ChatGPT desktop app on the laptop and uses one chat as the
orchestrator of Claude Code sessions. All work and state live on the Mac mini:

- The app connects to the Mac mini over SSH (Settings → Connections, see
  <https://learn.chatgpt.com/docs/remote-connections>) and runs the Codex app server
  there. The orchestrator chat works with the Mac mini's files and commands.
- Claude Code sessions ("slots") run on the Mac mini and receive tasks through
  Claude Code Channels.
- Messages are stored in the cluster Valkey, which the Mac mini already reaches
  through the `events-valkey.mctl.ai` tunnel.

The orchestrator dispatches tasks to slots, answers their questions and collects
their results. The laptop is only the UI.

## Step 0: this document

Committed on `docs/chatgpt-orchestrator-bridge`.

## Step 1: architecture gate, waking the orchestrator

Run before any bridge code is written.

1. Install and authorise the Codex CLI on the Mac mini. Homebrew is unusable there and
   there is no Node, so use the native binary (check that an x86_64-apple-darwin build
   is published). Add the SSH connection in the app, create a remote chat in
   `~/orchestrator`, and check that it sees files, runs commands and reads
   `~/orchestrator/AGENTS.md`.
2. Wake-up without the laptop: close the app, have a script on the Mac mini start a
   turn in the orchestrator thread through the Codex app server (JSON-RPC turn on the
   thread id) with a test message, get the answer, then open the app and see that turn
   in the conversation.
3. `codex exec resume` is tested separately and is not an equivalent fallback until
   both are shown: its history is compatible with the app, and it cannot run in
   parallel with a turn started from the app.

If step 1 fails, the orchestrator architecture changes (for example an always-on
orchestrator session, with the app used only to watch it) and the queue and launcher
are not written.

## Step 2: addressing gate between two Claude slots

A one-line stdio MCP server and two test slots started with
`--plugin-dir … plugin:<name>@inline`:

- the MCP subprocess environment carries `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID`
  (verified so far only for Bash children of a session);
- after `/clear`, a SessionStart hook reports the new session id;
- an event sent to slot A never appears in slot B;
- delivery order and latency while the slot is idle, busy, waiting on a permission
  prompt, and running a subagent.

## Gate results (2026-11-03)

Measured on the Mac mini with Codex CLI 0.163.0 and Claude Code 2.1.317. The spike
scripts are in [`docs/orchestrator-bridge-spike/`](orchestrator-bridge-spike/).

### Gate 1: passed

- Setup that worked:
  - Codex installed with the official `install.sh`. A bare release binary is not
    enough: `codex app-server daemon bootstrap` needs the packaged install.
  - `codex app-server daemon bootstrap` starts a managed daemon (`backend: pid`, not
    launchd). launchd agent `com.mctl.codex-daemon` runs the idempotent
    `codex app-server daemon start` at load and every 300 s. Verified: daemon
    stopped, agent kicked, daemon back with remote control.
- The ChatGPT desktop app's SSH connection runs `codex app-server proxy`, which
  attaches to that daemon. The app does not start its own app server.
- Remote control is enabled on the daemon itself
  (`codex app-server daemon enable-remote-control`), so the phone reaches the
  Mac mini without the laptop. Enrollment returned
  `403 "Multi-factor authentication required"` until MFA was enabled on the account
  and Codex on the Mac mini signed in again.
- Re-login on the headless Mac mini, with device-code sign-in left disabled in the
  account settings: run `ssh -L 1455:localhost:1455 <mini> codex login` and open the
  printed URL in the laptop's browser. `codex login status` printed "Logged in" while
  the refresh token had expired; only the daemon log showed the 401s.
- Control protocol: WebSocket on the Unix socket
  `~/.codex/app-server-control/app-server-control.sock`, path `/rpc`, JSON-RPC text
  frames without a `jsonrpc` field. Sequence: `initialize`, then the `initialized`
  notification, then `thread/list {cwd}`, `thread/resume {threadId}`,
  `turn/start {threadId, input: [{type: "text", text}]}`, then wait for
  `turn/completed`. `codex app-server proxy` only pipes bytes to that socket.
- **Wake-up:** with every client closed (no `app-server proxy` process on the Mac
  mini), `wake.py turn <thread> <text>` ran a turn in the orchestrator thread. The
  injected message, the command it ran and the answer were all visible on the phone
  afterwards.
- The phone app does not list a project created in the desktop app; the thread is
  found through search.

### Gate 2: passed, with one design change

Two test slots (Haiku) with a probe channel (`probe.py`) and hooks (`hook.py`):

| Check | Result |
|---|---|
| Addressing | Events emitted by slot A's channel never reached slot B. |
| Identity in the channel process | `CLAUDE_CODE_SESSION_ID` is set and equals the hook's `session_id`. `CLAUDE_PID` is not set there, but the channel's parent pid is the claude pid. |
| `/clear` | Same claude pid, new `session_id` (hook `source: clear`). The channel process is **not** restarted and keeps the old id in its environment; events keep reaching the new context. |
| Idle | emit → ack 1.2–3.8 s, but only when the event text itself asks for the ack tool call. The server `instructions` alone were not enough. |
| Permission prompt open | The event waits; after approval it is handled in the same turn and acknowledged. |
| Subagent running | The main session handles the event and acknowledges it in 2.3 s. |
| **Foreground tool running** | The event surfaced **inside that tool's result**. The model treated it as prompt injection and refused to ack. |
| Unsent draft in the input box | The event is handled, the draft is kept. |
| Hooks | `UserPromptSubmit` fires for channel events as well as typed prompts; `Stop` fires at the end of a turn. |

A warning `server:<name> · no MCP server configured with that name` appears when the
channel server comes from `--mcp-config`; delivery works regardless.

### Design changes from the gates

1. **Emit only into an idle slot.** The adapter keeps a busy flag driven by hooks
   (`UserPromptSubmit` sets busy, `Stop` sets idle) and holds tasks in `queued` while
   the slot is busy. A task emitted into a busy slot can land inside a tool result
   and be rejected as injection.
2. **The ack request travels with the task.** The adapter appends an explicit
   instruction to call `ack_task` with the task id to every event.
3. **Identity follows the hook, not the environment.** The adapter takes the claude
   pid from `getppid()` and the current session id from the pid file written by the
   SessionStart hook; `CLAUDE_CODE_SESSION_ID` is only the initial value.
4. A missing ack after emit already maps to `delivery_unknown` without a resend;
   gate 2 shows that this path really happens.

## Target layout (after the gates)

```text
ChatGPT app (laptop) --SSH--> Codex app server (Mac mini), orchestrator thread
                                 | local: mctl-bridge send/wait/claim/reply
waker (launchd, Mac mini) -- starts a turn --+
      ^                                        Valkey mctl:bridge:* (cluster, tunnel)
      +-- outbox <-- ask_orchestrator / ack / result -- Claude slots (mctl-bridge adapter)
                     send --> inbox:claude:<uuid> --------------------> <channel>
```

## What already exists

- The Mac mini is a working channel host: launchd `com.mctl.events-tunnel`
  (Valkey on `127.0.0.1:6379`) and `com.mctl.events-session`
  (`claude --remote-control` with the `mctl-events` Bun adapter). A PTY driver passes
  the development-channels confirmation that appears on every launch.
- `plugin/mctl-events/src/` in this repository: `channel.ts` (XREADGROUP BLOCK,
  pending recovery and reclaim, max_inflight, audit), `valkey.ts`, `envelope.ts`,
  `policy.ts`. The bridge reuses this code.
- Valkey and its ACL in mctl-gitops:
  `platform-gitops/infra-components/data/valkey/externalsecret.yaml`, with the runbook
  `docs/runbooks/valkey-acl.md` (a `#` line inside `users.acl` aborts Valkey startup).

## Resources (measured on the Mac mini, 2026-11-03)

Intel i3-8100B, 4 cores, 8 GB RAM, 2.4 GB of swap already in use.

| Process | RSS | CPU when idle |
|---|---|---|
| Bun channel adapter (`mctl-events`) | 8.6 MB | 0.0% |
| Idle Claude session (events, Sonnet) | 138 MB | 0.2% |
| `claude self-hosted-runner` | 65 MB | 0.0% |

The channel itself is close to free. An idle measurement says nothing about active
sessions running builds and tests, so the MVP is limited to **two slots**, raised only
after measuring two active slots together with the Codex app server.

## Queue design

### Keys under `mctl:bridge:*` and retention

| Key | Type | Purpose | Retention |
|---|---|---|---|
| `msg:<id>` | hash | full payload, state, addressee `{slot, uuid, epoch}`, `expires_at` | until terminal state + 7 days |
| `inbox:claude:<uuid>` | stream of `msg_id` only | wake the slot adapter | MINID: older than 7 days and not pending |
| `outbox` | stream of `msg_id` only, one group `orchestrator` | questions, acks, results | same |
| `claim:<msg_id>` | string `{owner}` with PX | ownership of handling one message | lease TTL, renewed |
| `slot:<name>` | hash `{uuid, conn_id, epoch, pid, cwd, heartbeat}` | slot registration | while alive + 1 day |
| `dedup:<idempotency_key>` | string → `msg_id` | deduplication | 7 days |
| `audit` | stream | state transitions | MAXLEN ~ 30 days |

The payload lives in `msg:<id>` and streams carry only references, so trimming a
stream never loses an unprocessed message. Expiry is an explicit transition to
`expired` driven by `expires_at`, never a side effect of trimming.

### Handling the outbox without double answers

There is one consumer group, `orchestrator`. The right to answer a message is an
atomic claim, `SET claim:<msg_id> <owner> NX PX <lease>`, renewed by compare-and-set
on the owner for as long as the answer is being prepared. `reply` is accepted only
from the claim owner, in one Lua script that checks the claim, moves the state, adds
the reply to the slot inbox and acknowledges the outbox entry.

The interactive `wait` and the waker compete only for the claim. **The waker never
answers**: it starts an orchestrator turn when a message has sat unclaimed for N
seconds, and that turn takes the claim itself. After a reconnect, unanswered entries
are re-read from the pending list (`XAUTOCLAIM`).

### Slot fencing at every step

- Registration: a new adapter takes `epoch + 1`. Renewal and removal are Lua
  compare-and-set on `conn_id`, so an old adapter cannot renew or delete the new
  registration.
- `send` records the addressee `{uuid, epoch}` in `msg:<id>` at send time.
- Before emitting, the adapter checks atomically that its `conn_id`/`epoch` are
  current and match the task's addressee; otherwise it does not emit.
- `ack` and `result` are accepted only from the adapter whose `uuid`/`epoch` match the
  task.
- After `/clear` (new uuid, epoch + 1), an unacknowledged task is never handed to the
  new context: it moves to `delivery_unknown` and the orchestrator decides whether to
  resend.
- Two live processes on one uuid are an explicit conflict, never a random choice.

### States

`queued → emitted → acked → completed | failed`, plus `expired`, `cancelled` (before
emit only) and `delivery_unknown`.

- Channels does not acknowledge notifications: a resolved `notification()` means the
  message was written to stdio, not that the model read it. Only `ack_task` moves a
  task to `acked`.
- Nothing is resent automatically for lack of an ack.
- At most one unacknowledged task per slot.
- A hop counter (at most 4) in the envelope stops orchestrator/slot loops; the waker
  has an hourly wake-up limit.

### Code: `plugin/mctl-bridge/`

Code shared with `mctl-events` moves to `plugin/shared/`.

- `src/channel.ts`: slot adapter. Tools `ack_task`, `report_result`,
  `ask_orchestrator`, `bridge_status`; heartbeat; fencing; watches the pid file
  written by the SessionStart hook.
- `src/cli.ts`: `mctl-bridge sessions | send | wait | claim | reply | status`, JSON
  output for the orchestrator.
- `src/waker.ts`: starts orchestrator turns.
- `src/sweeper.ts`: expiry and retention (may live inside the waker).
- All Lua scripts in one module with tests; every guarantee has a test that fails when
  the guarantee is reverted.

### Mac mini

- Codex CLI and `~/orchestrator/AGENTS.md`.
- Slot launcher next to `~/mctl-events/run-session.sh`: `start|stop <slot> <repo>`,
  limit 2. A slot is stopped as idle only when it has no task in `emitted`/`acked`, no
  question waiting for an answer and no running tool (`claude agents --json` busy/idle
  plus Valkey state). Silence on the channel is not idleness.
- SessionStart hook writing `~/.claude/bridge/pid-$CLAUDE_PID.json`
  (`session_id`, `source`); `/clear` changes the session id inside the same process,
  so the adapter's spawn-time environment alone goes stale.
- launchd `com.mctl.bridge-waker`.

## Risks

- **Account and usage limits.** The Team-account hold happened while an always-on
  claude-remote session was running; that is an unconfirmed observation, not an
  established cause. The concurrency limit is justified by the Mac mini's resources
  and by the usage limits of the Claude and ChatGPT plans.
- **Prompt injection and permissions.** Only the `bridge` ACL user may write
  `mctl:bridge:*`. The channel instructions say that orchestrator tasks never widen a
  session's permissions; merge, deploy and lifecycle decisions follow the workspace
  rules. There is no permission relay in the MVP; approvals go through Remote Control.
- **Data in the cluster.** No secrets in message content; retention as above.

## Steps after the gates

3. `bridge` ACL user in mctl-gitops, following the Valkey ACL runbook including its
   render check.
4. Implement `mctl-bridge` (Lua plus tests).
5. End to end on two slots: addressing; fencing (`/clear`, adapter restart, a task read
   by the old adapter before the epoch change is not emitted); claim (`wait` and waker
   at once give one answer); autonomy (app closed, answer still produced and visible in
   the app afterwards); failures (adapter killed before and after emit gives
   `delivery_unknown`, tunnel restart, TTL, stream trim with a non-empty pending list).
6. Measure RSS/CPU with two active slots and the Codex app server. Working slots are
   added only after that.

## Acceptance

- A task reaches only the current slot (uuid and epoch).
- Acks and results are visible in the orchestrator chat.
- A slot's question gets exactly one answer, also while the app is closed, and that
  turn is visible in the app afterwards.
- Nothing is lost across reconnects; trimming streams loses nothing unprocessed.
- `delivery_unknown` is visible to the operator.
- Resource use with two active slots is measured.
