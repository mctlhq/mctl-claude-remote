# Claude Code Channels — Spike (Communication Agent, Phase 0)

Status: **spike complete, recommendation below.** This documents what was
verified about Claude Code "Channels" as the delivery mechanism for pushing
Telegram events into a dedicated Claude session for the MCTL Communication
Agent, and why the production recommendation is what it is.

## What Channels are

A **channel** is an MCP server that Claude Code spawns as a stdio subprocess
and that can *push* events into the running session. It is distinct from
ordinary MCP tools (which Claude pulls). Reference:
`https://code.claude.com/docs/en/channels-reference.md` (research preview).

Contract (verified against the docs and a Go prototype):

- The server declares capability `capabilities.experimental["claude/channel"]: {}`.
- It emits notification method **`notifications/claude/channel`** with
  `{ content: string, meta: Record<string,string> }`. `content` becomes the
  body of a `<channel source="…" …>` tag injected into Claude's context;
  each `meta` key becomes a tag attribute (keys must be `[A-Za-z0-9_]+`;
  others are silently dropped).
- Two-way channels additionally expose an ordinary MCP **reply tool**; the
  optional `claude/channel/permission` capability relays tool-approval prompts.
- **No delivery acknowledgement, no retries, no event IDs** in the protocol.
  `notification()` resolves when bytes hit the transport, not when Claude has
  processed the event. Events queue FIFO and are batched on the next turn when
  Claude is busy.

## What was verified

1. **The flags exist in the pinned runtime.** `--channels <servers...>` and
   `--dangerously-load-development-channels <servers...>` are present (though
   hidden from `--help`) in Claude Code **2.1.198** (the image pin) and
   2.1.209. `-p`/`--print` (non-interactive) mode is documented to support
   channels — the real constraint is that `-p` is one-shot: the process
   exits after its turn, so a channel notification only reaches it if
   something is already invoking `-p` per event, not because channels and
   `-p` are incompatible.

2. **A Go / `mark3labs/mcp-go` server is accepted as a channel.** A minimal
   Go stdio server declaring the `claude/channel` experimental capability and
   emitting `notifications/claude/channel` was spawned by Claude Code and
   registered — the session debug log shows:

   ```
   MCP server "agentchan": Channel notifications registered
   ```

   This matters: it means the PR8 channel bridge (`cmd/agent-channel`) can be
   written in Go against the same `mcp-go` already used by mctl-telegram,
   rather than requiring a Node/Bun sidecar. `mcp-go` exposes
   `WithExperimental`, `WithInstructions`, `NewStdioServer` /
   `ServeStdio`, and `SendNotificationToAllClients` — everything the contract
   needs.

3. **Custom channels are never on the allowlist during the research preview.**
   They require `--dangerously-load-development-channels`. The flag bypasses
   only the allowlist; the `channelsEnabled` org policy still applies
   independently.

## Blocker found: the dev-channels flag prompts on every launch

`--dangerously-load-development-channels` renders an **interactive terminal
confirmation** ("I am using this for local development" / "Exit") on *every*
process start. It is not persisted anywhere. The remote-control entrypoint in
this repo launches Claude headless under `script -qfc` with stdin effectively
`/dev/null`, so nothing is present to answer that prompt — the session parks
at the dialog and the channel subprocess never spawns.

This is the load-bearing constraint for deployment, not a property of Channels
themselves: a human at a TTY clears the dialog once and the channel works, but
an unattended container cannot.

## Not proven

The full **event → Claude → reply-tool (ack)** round trip was **not**
reproduced in the automated harness. Six `expect`-driven attempts were all
defeated by TUI timing: the channel subprocess (and therefore its HTTP
listener) only binds *after* the session finishes its startup dialogs, and
driving those dialogs deterministically through `expect` proved unreliable.
This is a test-harness limitation, not evidence against Channels — registration
is confirmed and the notification mechanism is documented. Proving the ack
end-to-end needs either a real TTY or a PTY driver that watches for each dialog
by content rather than by fixed sleeps.

## Options

- **Option A — separate Channels process/deployment.** A dedicated
  `mctl-communication-agent` pod runs `claude
  --dangerously-load-development-channels server:agent-channel
  [--remote-control …]` — **not** `--channels`, which per the docs is for
  allowlisted `plugin:<name>@<marketplace>` entries and will not register a
  bare `.mcp.json` server like `agent-channel`; combining both flags does not
  extend the bypass either. The Go `cmd/agent-channel` bridge long-polls the
  mctl-telegram agent API and pushes `notifications/claude/channel`. Requires
  solving the per-launch dev-channel confirm in the headless entrypoint (a PTY
  driver in `entrypoint.sh` that answers the dialog, or an approved-allowlist
  listing that removes the dev flag entirely).

- **Option B — Channels + `--remote-control` in one process.** Same as A but
  co-resident with the operator's remote-control session. Adds no capability
  over A for the agent and couples two concerns; not preferred.

- **Option C — headless worker, no Channels.** A Go worker (or Agent SDK /
  `claude -p` per job) pulls from the durable queue and invokes Claude with
  restricted MCP tools and a strict JSON schema (`--json-schema`), sidestepping
  the dev-channel dialog entirely. Loses the "push into a live session"
  ergonomics but is fully unattended today with no research-preview flag.

## Recommendation

The durable queue in mctl-telegram (incoming_events → agent_jobs, at-least-once
with visibility-timeout requeue and `complete_agent_job` as the ack) is the
source of truth regardless of transport — a Channels notification is only a
wake-up, and a dropped one is recovered by the queue. That makes the transport
swappable.

**Ship the queue + agent API first (transport-agnostic), then adopt Option A**
for the interactive/observation ergonomics *if and only if* the per-launch
dev-channel confirm is solved in the headless entrypoint (PTY driver or
allowlist). **Until that is solved, Option C is the unattended fallback** and
is enough to reach the observation-mode MVP: pull a job, produce a structured
draft, deliver it to Saved Messages. Both options consume the identical agent
API, so the choice is deferrable and does not block the mctl-telegram work.

## Prototype

The throwaway Go channel server used for verification:
`scratchpad/channels-spike/main.go` (declares `claude/channel`, one `ack`
tool, forwards HTTP POSTs as channel notifications). Kept out of the repo; the
production bridge is `cmd/agent-channel` in mctl-telegram (PR8).
