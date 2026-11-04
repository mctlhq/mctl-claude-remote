# ChatGPT app orchestrator for Claude Code slots on the Mac mini

Status: design for an MVP. Both gates passed on 2026-11-03 (see
[Gate results](#gate-results-2026-11-03)) and a second design review was folded in
(see [Design review 2](#design-review-2-2026-11-03)); the bridge itself is not written
yet. Implementation proceeds in [slices](#implementation-slices).
This file is the canonical plan; change the design by editing it.

## Goal

The operator works in the ChatGPT desktop app on the laptop and uses one chat as the
orchestrator of Claude Code sessions. All work and state live on the Mac mini:

- The app connects to the Mac mini over SSH (Settings → Connections, see
  <https://learn.chatgpt.com/docs/remote-connections>) and runs the Codex app server
  there. The orchestrator chat works with the Mac mini's files and commands.
- Claude Code sessions ("slots") run on the Mac mini and receive tasks through
  Claude Code Channels.
- Messages are stored in Valkey: an isolated local instance on the Mac mini until the
  end-to-end tests pass, then the cluster Valkey, which the Mac mini already reaches
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

## Design review 2 (2026-11-03)

An independent review of this document after the gates found five P1 gaps. All of
them share one shape: a process can die **between recording an intent in Valkey and
acting on an external system** (the Codex app server, a slot's stdio), and the design
must say what state that leaves behind. The fixes are folded into the sections below,
slice by slice, so that each slice can be implemented from its own section:

| Gap | Where it is fixed |
|---|---|
| P1-a The waker trusts the first `turn/completed` and may lose the `turn/start` reply | [Slice 3](#slice-3-waker-and-sweeper) |
| P1-b Fencing check and stdio write are two steps | [Emit protocol](#emit-protocol-and-admission), [Slice 2](#slice-2-slot-adapter) |
| P1-c Recovery depends on stream references; dedup expires while the outcome is unknown | [Recovery and retention](#recovery-and-retention) |
| P1-d `reply` closes the question before the slot has the answer; a waiting slot can deadlock | [Questions and replies](#questions-and-replies), [Slice 2](#slice-2-slot-adapter) |
| P1-e A slot's shell may reach the orchestrator's credentials or the Codex socket | [Permission boundary](#permission-boundary) |

## Target layout

```text
ChatGPT app (laptop/phone) --remote--> Codex app server (Mac mini), orchestrator thread
                                         | local: mctl-bridge send/wait/claim/reply/resolve
waker + sweeper (launchd, Mac mini) -- starts a turn --+
      ^                                                 Valkey mctl:bridge:*
      |                                                 (isolated local Valkey first,
      |                                                  cluster after end-to-end tests)
      +-- outbox <-- ask_orchestrator / ack / result -- Claude slots (mctl-bridge adapter)
                     send/reply --> s:<slot>:ready (+ inbox doorbell) ------> <channel>
```

**Who orchestrates.** The orchestrator is a thread of the Codex app server on the Mac
mini. Its model is whatever model is selected for that thread in the ChatGPT app; its
history lives in `~/.codex/sessions` on the Mac mini. The laptop and phone apps are
clients only. The waker logs the model parameters it can actually observe for each
turn it starts (from `thread/resume` and `turn/started`), not the ones it assumes.

**What "exactly one answer" means.** For a question, at most one authoritative reply
can be committed. Whether a specific slot received it is confirmed separately, by that
slot's `ack` of the reply id. The design never claims more than this.

## What already exists

- The Mac mini is a working channel host: launchd `com.mctl.events-tunnel`
  (Valkey on `127.0.0.1:6379`) and `com.mctl.events-session`
  (`claude --remote-control` with the `mctl-events` Bun adapter). A PTY driver passes
  the development-channels confirmation that appears on every launch.
- `plugin/mctl-events/src/` in this repository: `channel.ts` (XREADGROUP BLOCK,
  pending recovery and reclaim, max_inflight, audit), `valkey.ts` (dependency-free
  RESP2 client), `envelope.ts`, `policy.ts`; `test/support.ts` starts a throwaway
  `valkey-server`/`redis-server` and a fake Claude Code client. CI installs
  `redis-server` and Bun 1.3.14.
- `docs/orchestrator-bridge-spike/wake.py`: the working Codex app-server protocol.
- Valkey and its ACL in mctl-gitops:
  `platform-gitops/infra-components/data/valkey/externalsecret.yaml`, with the runbook
  `docs/runbooks/valkey-acl.md` (a `#` line inside `users.acl` aborts Valkey startup).

A plugin is installed from its own directory (`${CLAUDE_PLUGIN_ROOT}`), so a shared
`plugin/shared/` would not ship with it. `mctl-bridge` carries a copy of
`mctl-events/src/valkey.ts`, and a test fails if the copy and the original differ.

## Resources (measured on the Mac mini, 2026-11-03)

Intel i3-8100B, 4 cores, 8 GB RAM, 2.4 GB of swap already in use.

| Process | RSS | CPU when idle |
|---|---|---|
| Bun channel adapter (`mctl-events`) | 8.6 MB | 0.0% |
| Idle Claude session (events, Sonnet) | 138 MB | 0.2% |
| `claude self-hosted-runner` | 65 MB | 0.0% |
| Codex app-server daemon | ~60 MB | ~0% |

The channel itself is close to free. An idle measurement says nothing about active
sessions running builds and tests, so the MVP is limited to **two slots**. The limit is
raised only after measuring memory pressure, swap and CPU (not only RSS) with two
active slots, the Codex app server and the waker.

## Queue design

### Keys under `mctl:bridge:*`

| Key | Type | Purpose |
|---|---|---|
| `msg:<id>` | hash | authoritative record: payload, state, addressee `{slot, uuid, epoch}`, `attempt_id`, `expires_at`, history of the last transition |
| `open` | set of `msg_id` | every message not yet in a terminal state; the recovery index |
| `slots` | set of slot names | every slot that ever registered |
| `s:<slot>:slot` | hash `{uuid, conn_id, epoch, pid, pid_start, cwd, heartbeat, busy, inflight, inflight_attempt}` | slot registration and lease |
| `s:<slot>:ready` | sorted set of `msg_id` | **the slot's queue**: tasks in `queued` and replies in `reply_committed` |
| `s:<slot>:open` | set of `msg_id` | the slot's open messages, invalidated together on an epoch change |
| `s:<slot>:inbox` | stream of `msg_id` | doorbell for the slot adapter only |
| `asked` | sorted set of `msg_id` | **the orchestrator's queue**: questions in `asked` |
| `outbox` | stream `{id, event}` | doorbell and event feed for `mctl-bridge wait` (asked, acked, result, late, delivery_unknown) |
| `claim:<msg_id>` | string `<claim_token>` with PX | the right to commit a reply |
| `wakelock:<thread_id>` | string `<wake_id>` with PX | the right to start a bridge-driven turn in a thread |
| `wake:<wake_id>` | hash `{question_id, thread_id, state, turn_id}` | wake intent and outcome |
| `wakes` | set of `wake_id` | wakes not yet settled (`intent`, `started`, `wake_unknown`) |
| `wakes:hour:<n>` | counter with PX | the hourly wake budget |
| `dedup:<idempotency_key>` | string → `msg_id` | deduplication |
| `late:<task_id>` | stream | evidence that arrived after the sender lost the right to change state |
| `audit:<id>` | stream (capped at about 200) | one message's own trail, read by `mctl-bridge status` |
| `audit` | stream | every state transition |

Every transition is **one Lua/FCALL call** that updates `msg:<id>`, `open`, the queues,
`dedup` and `audit` together. No transition is split across round trips.

Queues are sorted sets changed in the same call as the state, so a queue entry cannot
go missing on its own. Streams are only doorbells: a lost or trimmed stream entry
delays a wake-up and loses nothing. The functions live in one library,
`plugin/mctl-bridge/src/bridge.lua`, and derive their keys from the ids they are given,
so the bridge needs a standalone Valkey, not a Cluster. The first key every function
declares is its role key: `orch` for orchestrator functions and `s:<slot>:slot` for
slot functions (see [Permission boundary](#permission-boundary)). `wakelock` and `wake`
arrive with slice 3.

### States

Tasks (orchestrator → slot):
`queued → emit_intent → emitted → acked → completed | failed`, plus `expired`,
`cancelled` and `delivery_unknown`. The state machine cancels a task by itself only
before `emit_intent` (its addressee changed); an operator may cancel at any
non-terminal state through `resolve`.

Questions (slot → orchestrator):
`asked → reply_committed → reply_emit_intent → reply_emitted → reply_acknowledged`,
plus `closed` and `delivery_unknown`.

- A question past its `expires_at` gets a **system reply** (`reply_by: system`, fixed
  text) instead of silence: the asking task ended its turn and waits, and an expired
  question would otherwise wedge the slot, because its task still holds `inflight`.
  The feed carries `question_expired`.
- When a task ends (`report_result`, or `resolve` to a terminal state) its open question
  is `closed` and its claim dropped; no reply can reach it any more.
- `resolve --as closed` is refused (`task_waiting`, with the `task_id`) while the asking
  attempt still holds `inflight`: closing the question would leave that task waiting
  for a reply that never comes. The operator ends the task instead, which closes the
  question with it; a reply already committed stays deliverable.
- An epoch change or a lost heartbeat moves the slot's open questions (`asked`,
  `reply_committed`) to `delivery_unknown` together with its tasks.

Wakes: `intent → started → completed`, plus `intent → failed` (the app server refused
`turn/start` with a JSON-RPC error, so no turn exists) and `wake_unknown`, which leaves
only through `resolve` (`→ resolved`).

- Channels does not acknowledge notifications: a resolved `notification()` means the
  message was written to stdio, not that the model read it. Only the slot's `ack`
  moves a message past `emitted`.
- Nothing is resent automatically. `delivery_unknown` and `wake_unknown` stay in
  `open` until an explicit `resolve`.
- A hop counter (at most 4) in the envelope stops orchestrator/slot loops; the waker
  has an hourly wake-up limit.

### Emit protocol and admission

Fixes P1-b. The fencing check and the stdio write cannot be one operation, so the
window between them is recorded instead of hidden:

1. `emit_intent` (one Lua call) checks that the adapter's `conn_id` and `epoch` are
   current and match the addressee, that the slot is idle with a fresh heartbeat, and
   that `inflight` allows this message (below). It sets `inflight`, generates an
   `attempt_id` and moves the message to `emit_intent`.
2. The adapter writes the notification to stdio.
3. `mark_emitted` moves it to `emitted`.

An adapter that restarts and finds its own message in `emit_intent` cannot know whether
step 2 happened, so the message moves to `delivery_unknown`. The same holds for a
message in `emitted` without an ack when the slot's epoch changes (`/clear`, restart).

**Admission.** Every event carries an explicit instruction to call `ack_task` before
doing any work. A successful `ack_task` returns an admission bound to
`{task_id, attempt_id, uuid, epoch, conn_id}`; `report_result` and `ask_orchestrator`
require it and reject any field mismatch. Admission is enforced only for operations
that go through the bridge. It does **not** block an arbitrary Bash call in the slot;
those stay under the slot's normal permission prompts. The design does not claim more.

**Late evidence.** The right to change state and the right to leave evidence are
separate. A `report_result` from an old epoch or attempt never completes the task, but
it is appended to `late:<task_id>` and `audit` with
`{task_id, attempt_id, epoch, conn_id, reason}`. `mctl-bridge errors` shows these next
to `delivery_unknown`, so an operator sees that a first attempt already acted before
deciding to rerun. `mctl-bridge resolve <id> --as completed|failed|requeue --reason`
is the manual transition and records its author. `requeue` is refused while late
evidence exists unless `--force` is given, so a rerun is a decision taken after reading
what the earlier attempt did.

### Questions and replies

Fixes P1-d.

- `ask_orchestrator` stores the question (`asked`), adds it to `outbox` and returns a
  `question_id` immediately. The slot then ends its turn; it does not wait inside a
  tool call. The originating task stays in `inflight`.
- `reply` (orchestrator, one Lua call) checks the `claim_token`, stores the reply and
  moves the question to `reply_committed`, adds it to the slot inbox and acknowledges
  the outbox entry. It does not claim that the slot has the reply.
- The adapter emits the reply with the same intent protocol (`reply_emit_intent →
  reply_emitted`); the slot's `ack` of the `reply_id` moves it to
  `reply_acknowledged`.
- **Inflight rule.** A message may be emitted when `inflight` is empty, **or** when it
  is a reply whose `question_id`, `attempt_id` and addressee match the task currently
  in `inflight`. Without the second clause a task's own reply would be blocked forever
  by that task. Unrelated tasks still wait.
- End-to-end criterion: the slot acknowledges the `reply_id` and then finishes the
  original task with `report_result` under the **same** `attempt_id`.

### Claims

The orchestrator's queue is the `asked` sorted set; there is no consumer group, because
ownership is decided by the claim alone. The right to answer is an atomic claim,
`SET claim:<msg_id> <claim_token> NX PX <lease>`, with a fresh random token per claim.
Renewal and `reply` are compare-and-set on the token, not on the owner name: if the
same owner loses the lease and claims again, its old token is dead. The interactive
`wait`, a waker-started turn and a manual turn from the ChatGPT app all compete only
for the claim. `mctl-bridge wait` lists questions in `asked` without a live claim, plus
feed events after a cursor kept in `orch`; after a reconnect nothing needs re-reading,
because the queue is the sorted set, not the stream.

### Slot fencing

- Registration: a new adapter takes `epoch + 1` and a fresh `conn_id`. Renewal and
  removal are compare-and-set on `conn_id`.
- A slot's identity is `pid + process start time + conn_id`, so a reused pid cannot
  pass for an old process.
- `send` records the addressee `{uuid, epoch}` in `msg:<id>`.
- `ack` and `result` require the full admission tuple.
- After `/clear` (new session id in the same process) the epoch moves on; a message in
  `emit_intent` or `emitted` without an ack becomes `delivery_unknown` and is never
  handed to the new context.
- Two live processes on one uuid are an explicit conflict.

### Recovery and retention

Fixes P1-c.

- The sweeper scans `open`, not the streams. A message that may be handed out
  (`queued`, `reply_committed`) is put back into its slot's queue if missing, an `asked`
  question back into `asked`, and an id without a record is dropped from `open`.
  `emit_intent` and `reply_emit_intent` are never put back: an epoch change or a lost
  heartbeat moves them to `delivery_unknown`. A committed reply keeps its `reply_id`
  through recovery.
- `dedup:<key>` lives while its message is in `open`, plus a replay window (7 days)
  after the terminal state, never a fixed TTL from creation.
- `msg:<id>`, its own trail `audit:<id>` and its late evidence `late:<id>` live until
  the terminal state plus 7 days, and never expire while the message is open. The
  global `audit` stream is capped (about 100 000 entries); `mctl-bridge status` reads
  the per-message trail, never the global stream.
- Expiry is an explicit transition driven by `expires_at`.
- Durability: Valkey runs with `appendonly yes` and `appendfsync always` for the bridge
  (the recovery test below depends on it). The cluster Valkey's persistence settings
  are checked before slice 5; a weaker policy is acceptable only if this document
  records the resulting loss window. A SIGKILL test cannot tell `always` from
  `everysec` (the page cache outlives a killed process), so `mctl-bridge init` reads
  the live server's settings and reports `durable`, `weak` or `unknown`; a config the
  client may not read is `unknown`, never `durable`.

### Permission boundary

Fixes P1-e. What a slot's shell can reach on the Mac mini decides what the bridge can
promise:

- The Codex control socket `~/.codex/app-server-control/app-server-control.sock` is
  owned by the operator's uid. A process with that uid can start turns in any thread.
- Valkey credentials readable by the slot's uid let it act as whoever owns them.

The target boundary:

- Slots run as a separate macOS user (`mctl-slot`). The control socket and the
  orchestrator's credentials (mode 0600, operator uid) are out of reach.
- Valkey has separate users: `bridge_orch` for the CLI and waker, and
  `bridge_slot_<name>` per slot. Isolation rests on ACL checks of the keys an FCALL
  declares: orchestrator functions (`claim`, `reply`, `resolve`) declare `claim:*`
  keys that no slot user may touch; slot functions declare a key in the slot's own
  namespace `s:<name>:*`, so slot A cannot write a result for slot B.
- Adapter credentials go to the MCP process only, never into the session's
  environment.
- A reply to a question never grants approval, merge or deploy; those follow the
  workspace rules and the slot's own permission prompts (approved through Remote
  Control).

If the MVP keeps one shared uid, that mode is called a **trusted experiment**, is
documented as an accepted risk, and is not used for working slots. End-to-end
scenario 8 tests the boundary either way.

### Busy signal

Hooks write a local file `~/.mctl-bridge/state/<claude_pid>.json` (`busy|idle`,
`session_id`, `source`) atomically (temp file plus rename): `SessionStart` writes the
session id, `UserPromptSubmit` sets busy, `Stop` sets idle. The adapter finds its file
through `getppid()`. Hooks hold no Valkey credentials.

## Implementation slices

Each slice is one PR in this repository unless stated otherwise, with CI, the Claude
review and agy, merged with a merge commit. Every guarantee gets a test, and each test
is shown to fail with its guarantee reverted.

### Slice 1: queue and state machine

`plugin/mctl-bridge/` with `package.json`, `.claude-plugin/plugin.json` and `bunfig.toml`
as in `mctl-events`. `.mcp.json` and the marketplace entry arrive with the adapter in
slice 2; until then there is nothing for Claude Code to load.

- `src/valkey.ts` (copy) and a test that it matches `mctl-events`.
- `src/bridge.lua` and `src/store.ts`: `register`, `heartbeat`, `unregister`,
  `next` (emit_intent), `emitted`, `ack_task` (returns admission), `ack_reply`,
  `result`, `ask`, `send`, `claim`, `renew`, `reply`, `resolve`, `expire`,
  `slot_stale`, `repair`; late evidence is recorded inside `result` and `ask`.
- `src/cli.ts`: `send | wait | claim | reply | resolve | sessions | tasks | status |
  errors`, JSON output; `errors` lists `delivery_unknown`, `wake_unknown` and late
  evidence with reasons.
- Tests on a throwaway server:
  - an old epoch cannot emit or ack;
  - an admission with any one field changed is rejected;
  - two claims give one committed reply;
  - a stale `claim_token` of the same owner is rejected after re-claim;
  - a second task is not emitted while `inflight` is set, but the matching reply is;
  - trimming a stream loses nothing that is still in `open`;
  - `expired`, `delivery_unknown` and `wake_unknown` are never resent;
  - a late result is recorded and changes no state;
  - the hop limit holds.
- A durable test profile: the server runs with AOF (`appendfsync always`) on a data
  directory, is killed with SIGKILL between transitions and restarted on the same
  directory; `msg`, `open`, `dedup` and `audit` must agree afterwards.
- `test/mutate.py` reverts each guarantee in turn and fails if any revert leaves the
  tests green; CI runs it.

### Slice 2: slot adapter

`src/channel.ts` on the `mctl-events` skeleton.

- Registers from the hook state file; `CLAUDE_CODE_SESSION_ID` is only the initial
  value. Heartbeat every 10 seconds.
- Emits through the intent protocol, only into an idle slot, with the `ack_task`
  instruction attached.
- Tools: `ack_task`, `report_result`, `ask_orchestrator` (returns `question_id` at
  once), `bridge_status`.
- Applies the inflight rule, so a task's own reply passes while unrelated tasks wait.
- Instructions: orchestrator tasks never widen permissions; merge, deploy and
  lifecycle follow `AGENTS.md`.
- `hooks/state.py`: stdlib only, writes the local state file atomically.
- After an emit the slot counts as busy until the hooks report a newer state (at most
  `MCTL_BRIDGE_EMIT_HOLD_MS`, default 2 minutes), so a second message cannot follow
  before Claude Code has even started the turn. The server's `busy` check stays
  authoritative; the adapter's own check only saves a round trip.
- Configuration reaches the adapter process only: the slot launcher puts
  `MCTL_BRIDGE_SLOT`, `MCTL_BRIDGE_VALKEY_URL` and the password file path into the `env`
  of the slot's `--mcp-config` entry, so they never enter the session's environment.
  For that reason the plugin ships no `.mcp.json` and is not in the marketplace: a
  plugin-wide server would read its credentials from the session's environment.
- The model passes only ids; the adapter keeps the admission returned by `ack_task`
  and sends it with `ask_orchestrator` and `report_result`. A stale admission is still
  sent, so the server records it as late evidence.
- `unregister` (on stdin close) checks `conn_id` first, then moves what the adapter held
  to `delivery_unknown` and frees `inflight`, as `slot_stale` does.
- A transport error keeps the registration: registering again would reset a live
  session. The retry backoff is capped at one heartbeat, well inside `stale_ms`, and
  only a `fenced` reply drops the registration. A lost reply to `next` is ambiguous,
  since the server may have recorded an `emit_intent` the model never saw. Before
  emitting anything else, the adapter calls `emit_lost`, a fenced operation that moves
  this connection's own `emit_intent` or `reply_emit_intent` to `delivery_unknown`
  (reason `emit_reply_lost`, never resent). A task also frees `inflight`.
- Tests with the fake Claude Code client and a fake state file: nothing is emitted into
  a busy slot; after `/clear` the old message becomes `delivery_unknown` and is not
  resent; a restart takes `epoch + 1`; `/clear` after admission while an external tool
  is running leaves the old attempt's result as late evidence; the acceptance test runs
  task → `ask_orchestrator` → turn ends → reply passes with `inflight` set →
  `reply_acknowledged` → `report_result` with the same `attempt_id`, while an unrelated
  task sent meanwhile stays queued.

### Slice 3: waker and sweeper

`src/waker.ts`, a port of `wake.py`, one long-lived process with the sweeper inside.
Fixes P1-a.

- Picks outbox questions that have had no claim for N seconds. Before any RPC, one Lua
  call takes `wakelock:<thread_id>` (`SET NX PX`) and stores `wake:<wake_id>`
  `{question_id, thread_id, state=intent}`.
- The turn text carries the marker `[wake:<wake_id>]` and tells the orchestrator to
  `claim` and `reply` question `<question_id>`. The waker never answers.
- Notifications are matched on `threadId` and `turnId`, never on the first
  `turn/completed` that arrives.
- If the `turn/start` reply is lost, the waker searches the thread history for the
  wake's user message (its `clientId`, see slice 4a). Exactly one match → `started`;
  none or several → `wake_unknown`, no automatic restart.
- A manual turn from the ChatGPT app does not take the wakelock; for it the bridge
  guarantees only that at most one reply is committed, through the claim.
- Limits: at most K wakes per hour.
- Sweeper: `expires_at` → `expired`; stale heartbeat → `delivery_unknown` for that
  slot's open messages; MINID trimming; the `open` scan on start.
- Tests against a fake app server on a Unix socket (WebSocket, JSON-RPC): a foreign
  `turn/completed` arriving first is ignored; a lost `turn/start` reply resolves through
  the marker; an ambiguous history gives `wake_unknown`; two wakers produce one wake.

Implementation notes (slice 3):

- `bridge_wake_begin` is the one call before any RPC. It refuses a question that is no
  longer `asked`, is claimed, is younger than the quiet period (`MCTL_BRIDGE_WAKE_QUIET_MS`,
  default 30 s), already has a wake in `intent`, `started` or `wake_unknown`, or has used
  its per-question budget (`MCTL_BRIDGE_WAKES_PER_QUESTION`, default 2). It also refuses
  a thread whose wakelock is held and an hour whose budget is spent
  (`MCTL_BRIDGE_WAKES_PER_HOUR`, default 12). The wakelock lasts the turn timeout
  (`MCTL_BRIDGE_TURN_TIMEOUT_MS`, default 15 minutes) plus one minute.
- `completed` and `failed` release the wakelock. A question that is still unclaimed
  after one of them may be woken again, within its per-question budget. `wake_unknown`
  keeps the wakelock until its PX runs out, because the turn may still be running. Its
  question is not woken again until an operator runs
  `mctl-bridge resolve <wake_id> --reason`.
- The turn text carries the marker, the question id, the slot and the CLI commands, but
  not the question's text. That text is slot input, and the orchestrator reads it
  through `mctl-bridge status`, marked as input rather than instruction.
- History is read page by page (see slice 4a). A malformed or failed page is an
  unreadable history and gives `wake_unknown (history_unreadable)`; it is never read as
  "no match".
- After a lost connection, a started turn is followed by polling the history until
  its status leaves `inProgress`. A turn that does not end in time becomes
  `wake_unknown (turn_timeout)`. On start, the waker settles any `intent` from the
  history and follows any `started`; recovery itself never starts a turn.
- The sweeper is the existing `sweep` (expiry, stale slots, the `open` repair scan) on
  its own timer (`MCTL_BRIDGE_SWEEP_MS`, default 5 s), so a long turn never delays it.
  Every stream is capped by `MAXLEN`, and the queues are sorted sets, so no MINID pass is
  needed.
- `mctl-bridge errors` lists `wake_unknown` wakes, and `mctl-bridge wakes` lists every
  open wake.

Live protocol (slice 4a, Codex 0.163.0 on the Mac mini, 2026-11-03). Checked on a
scratch thread with `generate-ts` and real turns, not on the orchestrator thread:

- `turn/start` takes `clientUserMessageId`, and the server keeps it on the turn's
  `userMessage` item as `clientId`. The waker sends the wake id there and matches the
  history on `clientId == wake_id` alone. The `[wake:<id>]` text marker stays for
  people reading the thread, but a pasted copy of it in a manual turn carries the app's
  own client id and is not a match.
- `clientUserMessageId` is **not** deduplicated: sending the same id again starts a
  second turn. A lost start therefore still must never be retried.
- `turn/start` on a busy thread is **not refused**. The input joins the running turn
  (steering) and the reply returns that turn's id. A JSON-RPC error is therefore not a
  "thread busy" signal. The waker reads `thread/read` (metadata only) first and wakes
  only a thread whose status is `idle`; a status it cannot read counts as not idle, and
  that pass spends no budget. A start that still races a manual turn joins it, and the
  wake follows that turn to its end: an accepted, documented outcome, because the
  claim still allows only one committed reply.
- `thread/read {includeTurns: true}` is deprecated for paginated threads. The waker
  uses `thread/turns/list {itemsView: "full", sortDirection: "desc"}` and pages back
  until a page reaches a turn that started more than five minutes before the wake (at
  most 50 pages of 20). `itemsView: "summary"` drops a turn's second user message, so a
  turn listed with anything but `full` items makes the history unreadable.
- Turn statuses are `completed`, `interrupted`, `failed` and `inProgress`; thread
  statuses are `notLoaded`, `idle`, `systemError` and `active` (with flags
  `waitingOnApproval`, `waitingOnUserInput`).

### Slice 4: Mac mini, end to end on an isolated Valkey

Ops files in `plugin/mctl-bridge/ops/`: `slot.sh start|stop <slot> <repo>` (limit 2,
built on `~/mctl-events/run-session.sh` and the PTY driver), the settings file with
hooks, the launchd plists, and a section for `~/orchestrator/AGENTS.md` on how the
orchestrator uses the CLI and what it must not do.

- **Isolated Valkey.** A `valkey-server` built from source on the Mac mini (it has no
  Valkey or Redis, and Docker Desktop does not fit in 8 GB), bound to `127.0.0.1` on
  its own port. launchd `com.mctl.bridge-valkey` (RunAtLoad, KeepAlive), data in
  `~/mctl-bridge/valkey/`, AOF with the policy from slice 1.
- Every client (adapter, waker, CLI) reconnects with backoff, whatever the start order.
- The permission boundary is chosen before these tests run.
- A slot is stopped as idle only when it has nothing in `emit_intent`, `emitted` or
  `acked`, no unanswered question and no running tool. Silence on the channel is not
  idleness.

Scenarios:

1. Addressing: a task for A never appears in B.
2. Laptop closed: question → waker → claim and reply → answer in the same slot → the
   turn is visible on the phone.
3. `wait` and the waker at once give one committed reply.
4. `/clear`, and the adapter killed before and after emit, give `delivery_unknown`
   without a resend.
5. Mac mini reboot: launchd starts Valkey, the Codex daemon, the waker and the slots in
   any order. Afterwards the specific `task_id`, `attempt_id` and audit entries are
   found, dedup is intact, and the question either reaches an answer or the operator
   sees a definite reason why it stopped.
6. A task sent while a tool runs waits for idle.
7. **The main test.** Slot A is working on a task, asks a question and ends its turn.
   The laptop is closed. The orchestrator commits a reply; the waker is killed before it
   sees `turn/completed`. After the restart, A receives the reply, continues the **same
   attempt** and reports its result. The phone shows the question, the reply and the
   result in one thread. B receives nothing.
8. From slot A's shell: try to reply for the orchestrator, write B's result and open the
   Codex control socket. Expected: refused. In trusted-experiment mode the bypass is
   recorded instead.

Then measure two active slots with the Codex app server and the waker.

#### Slice 4 results (2026-11-04, trusted experiment)

Run on the Mac mini against the isolated Valkey 8.1.11 (`appendfsync always`), two
Haiku slots, the Codex daemon 0.163.0 and the waker 0.3.1. Mode: **trusted
experiment**. All processes share one macOS user, so scenario 8 records bypasses, not
isolation. Working slots stay blocked until slice 4b.

| # | Result |
|---|--------|
| 1 | Passed. A's task never reached B. |
| 2 | Passed. Question → wake → claim → reply → same slot, visible in the Codex thread. |
| 3 | Passed in part: the claim token allowed one committed reply. |
| 4 | Passed. `/clear` and an adapter kill gave `delivery_unknown` with reason `epoch_changed` or `heartbeat_lost`, no resend. |
| 5 | Passed with a component-wise restart instead of a reboot (the mini also hosts prod services). SIGKILL of Valkey: task, 5 audit entries and dedup (`dedup:true` on a repeated idempotency key) intact; slots reconnected on their own; the waker logged `ECONNREFUSED` and retried. Waker SIGKILL: recovered, see 7. Mini reboot: **not run**. |
| 6 | Passed. A task sent during a running tool waited for idle. |
| 7 | Passed. Waker killed while the wake was `started`. The turn kept running in the Codex daemon, the orchestrator claimed and replied, slot B acknowledged the reply and reported its result on the same `attempt_id`. After the waker restart `recover()` settled the wake as `wake_completed`; no second `turn/start`. A got nothing. |
| 8 | **Bypass recorded, as expected in this mode.** From the slot's user: `orch.pw`, `slot.pw` and `admin.pw` are readable (0600, same owner); `bridge_slot` and `bridge_orch` can both `HSET`/`DEL` any `mctl:bridge:*` key directly; the Codex control socket accepts a connection. `CONFIG SET` is refused for both roles (`NOPERM`). |

Measured with both slots live: 38% memory free, swap 2.46 GB of 4 GB (the 2.4 GB it
had before), load 1.6. Each Claude slot is about 300 MB; the Codex daemon 150 MB.

Findings:

- **launchd did not respawn a SIGKILLed job.** `com.mctl.bridge-valkey` and
  `com.mctl.bridge-waker` have `KeepAlive` true, yet after `kill -9` and
  `launchctl kill KILL` they stayed `not running` ("pended nondemand spawn =
  inefficient") until `launchctl kickstart`. Do not rely on KeepAlive for recovery on
  this host; a supervisor check or an explicit restart is needed.
- A question has no default TTL (`expires_ms` 0), and a question whose wakes are
  exhausted stays `asked` forever. Slice 4b or a later slice needs a bound.
- `init` needs the admin user (`function|load` is not granted to `bridge_orch`); this is
  intended.

### Slice 4b: security boundary

Give each adapter a distinct Valkey ACL user. Deliver tasks and replies through an
orchestrator-written, slot-readable inbox. Allow the adapter to append observations
only to its own outbox under `s:<slot>:*`. Use explicit command and key allowlists.
Only the orchestrator writes authoritative registrations, epochs, inflight state,
tasks, claims, replies, results and audit records. Admin credentials are for setup.

Derive slot identity from the configured outbox, never from the event body. Treat
every event as untrusted. Before applying it, validate the assigned slot and task,
epoch, conn_id, attempt, admission and legal transition. Commit the transition,
deduplication record and audit together before acknowledging the event. Resume from
durable state after a crash. Preserve late results as reconciliation evidence.

**Admission and delivery protocol**

- Carry a stable request_id across retries. For ack_task, the orchestrator commits
  the admission and its decision before responding. Bind the decision to request_id,
  slot, task_id, epoch, conn_id and attempt_id. The adapter may return MCP success
  only for a matching committed grant on its current registration. A queued
  request, timeout, rejection or response for an earlier session grants no right
  to start work. A retry retrieves the same decision, never a second grant.
- When assigning a task or committing a reply, atomically record its payload and
  a delivery intent alongside the canonical transition. Give the intent a stable
  delivery_id and retain it until acknowledged or explicitly reconciled. A
  publisher may retry publication under that ID; consumers deduplicate before
  admission. Once execution might have started, reconcile an unknown outcome
  instead of automatically executing the task again.
- Treat the slot outbox as untrusted staging. Raw XADD permits MAXLEN/MINID.
  Keep pending submissions for retry under the same request_id until a canonical
  receipt exists. Report success for questions/results only after the orchestrator
  owns the durable payload, decision and receipt in keys the slot cannot trim.
- For an invalid event, atomically record its rejection and advance the consumer
  checkpoint (or durably record the rejection before acknowledging). Deduplicate
  rejection by source slot and stream entry ID; a forged request_id must not
  suppress a later valid request. Resume other entries and slots after restart.

A Valkey namespace alone cannot protect files and sockets owned by the same macOS
user. Before admitting working slots, document and exercise a host boundary (for
example separate OS identities) that protects credentials, adapter configuration,
orchestrator code and the Codex control socket from the slot process. Host changes
requiring elevated privileges are a separate operator step.

**Acceptance on the isolated Valkey and Mac mini:**

- [ ] Run two adversarial slots. A can read its inbox and append its own observations.
  Direct commands and FCALL cannot read or modify B's keys, change canonical state,
  forge an inbox delivery, or run privileged commands. A forged B identity in A's
  outbox cannot change B's state.
- [ ] Inject a forbidden access after a would-be epoch increment. Compare before and
  after: epoch, registration, inflight, task, claim and reply state are unchanged.
  Check permissions before mutation; a Lua error does not roll back earlier writes.
- [ ] From the actual slot OS context, attempts to read admin, orchestrator or peer
  credentials, overwrite trusted launch/config files, or connect to the Codex socket
  fail. Record the OS identity, Valkey role, attempted operation and outcome without
  logging secrets. All three bypasses from scenario 8 must now be refused.
- [ ] Replay duplicate, stale and misaddressed events, and kill the consumer between
  commit and acknowledgement. No second transition or execution occurs. A stale
  result remains visible in audit. Repeat scenarios 2 and 7: only the intended slot
  resumes the same attempt; recovery does not start a second turn.
- [ ] Delay an ack_task request across an epoch change and separately replay an
  old grant to the new adapter. Neither permits work. Lose a valid response and
  retry its request_id: the same grant is recovered, with one side effect at most.
- [ ] For both a task and a reply, kill the publisher after the canonical commit
  but before publication, and again after publication but before recording progress.
  Recovery uses the same delivery_id and attempt_id. The task is not stranded in
  inflight, the reply reaches its asking slot, and no side effect runs twice.
- [ ] With real slot credentials, submit an event and attempt XADD MAXLEN 0 and
  XADD MINID against its outbox before ingestion and after a receipt. A lost staged
  event has no success receipt and is retried. Every acknowledged payload remains
  recoverable by request_id even if the staging entry is gone.
- [ ] Enqueue an invalid event followed by a valid one with the same claimed
  request_id, then restart the consumer at the rejection/ack boundary. Verify one
  rejection in audit, one valid transition, and continued progress for the other slot.
- [ ] Kill Valkey and waker separately on the isolated setup. Record automatic
  restart without manual kickstart, intact task and audit history, and no duplicate
  wake. Test the launchd domain on the host before selecting it.
- [ ] Use a structured reply tool that passes the answer as data without shell
  interpolation. With the client disconnected, deliver an apostrophe, a literal
  command substitution and a newline via a real waker turn. Verify the receiving
  slot acknowledges the exact text and no command runs or waits for approval.
- [ ] The launcher treats repo and config paths as data: spaces and literal shell
  metacharacters reach the intended process without splitting or execution.
  Capture the launched process's argv and use a harmless substitution marker;
  assert exact argument boundaries and that the marker was never created.

Working slots require the above evidence and owner approval. Cluster ACL rollout
remains in slice 5.

### Slice 5: cluster Valkey

A PR in mctl-gitops adds the users from the permission boundary (`bridge_orch`,
`bridge_slot_<name>`, not one shared `bridge`) following the Valkey ACL runbook,
including its render check on the target image. Before that, check the cluster
Valkey's persistence settings and whether it is standalone or a Cluster; hash-slot
co-location of keys used in one script matters only for a Cluster. The Valkey restart
is agreed separately because it interrupts the events pipeline. Then the bridge
switches to the tunnel and scenarios 2, 5, 7 and 8 are repeated.

**Gate before working slots:** the end-to-end tests pass, scenario 8 is refused rather
than run as a trusted experiment, and the owner approves.

## Risks

- **Account and usage limits.** The Team-account hold happened while an always-on
  claude-remote session was running; that is an unconfirmed observation, not an
  established cause. The concurrency limit is justified by the Mac mini's resources
  and by the usage limits of the Claude and ChatGPT plans.
- **Prompt injection.** Orchestrator tasks never widen a session's permissions. There
  is no permission relay in the MVP; approvals go through Remote Control.
- **Shared uid.** Until slots run under their own user, a slot's shell can reach the
  Codex socket; see [Permission boundary](#permission-boundary).
- **Data in the cluster.** No secrets in message content; retention as above.

## Acceptance

- Scenarios 1–8 pass on the isolated Valkey; 2, 5, 7 and 8 pass again on the cluster.
- Every guarantee has a test that fails with the guarantee reverted.
- `mctl-bridge errors` shows every `delivery_unknown`, `wake_unknown` and late result
  with its reason.
- Two active slots fit in the Mac mini's memory without growing swap under load.
