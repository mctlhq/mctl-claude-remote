# Operating the inbound events Channel

**Use this when** events stop reaching the session, when a stream's `lag` is
growing, when you need to prove what happened to one `event_id`, or before
touching anything in the consumer group. For the producer side — a webhook that
never became an event — see `mctlhq/mctl-api`, `docs/github-events-producer.md`.

What the channel looks like from the outside: how to read its state without
being able to change it, what each number means, and which observations are
symptoms of a fault as opposed to the design working.

The behaviour itself is specified in the README section *Inbound events
Channel*; this document does not repeat it. It assumes the deployment in
`platform-gitops/services/labs/claude-remote`, with Valkey in the
`platform-events` namespace.

## Reading the trail without write access

The ACL user `events-observer` exists for exactly this. It can read
`mctl:events:audit` and nothing else — no writes anywhere, no access to the
event streams themselves:

```
XLEN mctl:events:audit             -> 310
XADD mctl:events:audit * probe 1   -> NOPERM ... no permissions to run the 'xadd' command
XLEN mctl:events:telegram          -> NOPERM No permissions to access a key
```

Its password lives in Vault at `secret/platform/valkey`, field
`events-observer-password`, and is rendered into the ACL file by the
`valkey-acl` ExternalSecret. Hand it to `valkey-cli` over stdin
(`REDISCLI_AUTH`) rather than on the command line, so it stays out of argv and
out of shell history:

```sh
printf '%s' "$PW" | kubectl -n platform-events exec -i valkey-0 -c valkey -- \
  sh -c 'REDISCLI_AUTH=$(cat) exec valkey-cli --no-auth-warning --user events-observer "$@"' \
  _ XREVRANGE mctl:events:audit + - COUNT 20
```

One event's life is one `XRANGE` away, because every record carries the same
`event_id` and `correlation_id`:

```
EVENT github:0ccfdcce-b2d2-11f1-9e2e-e360579921db
  1789675066242-0  received   (ingress)
  1789675066248-0  published  component=mctl-api    attempt=1
  1789675066249-0  delivered  component=mctl-events attempt=1
  1789675076527-0  acked      component=mctl-events attempt=1
```

The gap between `delivered` and `acked` is Claude's own working time — it
covers hydration through MCP and whatever the session did about the event. It
is not a transport latency and there is no timeout on it.

### What an `acked` record carries, and who may read it

`acked` is written by the `ack_event` handler and by nothing else, so it is the
only record that proves the session itself finished an event rather than some
other tool call having touched it. It carries two fields the other stages do
not:

- **`outcome`** — `handled`, `ignored` or `failed`, chosen by the session.
- **`note`** — a short, Claude-authored line naming what was hydrated and what
  was done, capped at 500 characters (`channel.py`, `Adapter.ack`).

That note is written **after** hydration, so unlike the envelope it is not
reference-only: summarising what a message or a pull request was about can
include a few words from it. This is deliberate and it is the difference
between an audit trail you can read and a list of ids, but it means the two
streams have different sensitivities and must be treated differently:

| | `mctl:events:<source>` | `mctl:events:audit` |
|---|---|---|
| contents | references only — closed 4 KiB envelope schema, identifiers, no body | stage records, plus a Claude-authored summary on `acked` |
| written by | the producers | the adapter (best effort) |
| read by | `claude-remote` only | `events-observer` only |

Neither stream is exported, mirrored or exposed to any third party, and the
`events-observer` ACL user is read-only and hand-issued for operators. Keep it
that way: the audit stream is operator-facing observability, **not** a feed to
hand to an external consumer, and anything that would forward it needs its own
review of what the note may contain rather than inheriting this one.

## The group state, and what each number means

Group state needs the `claude-remote` user (the observer is deliberately not
allowed to see the event streams):

```
XINFO GROUPS mctl:events:github
  name=claude-remote  consumers=1  pending=5  lag=16  last-delivered-id=...
```

- **`pending`** — entries the group has already handed out and that no
  `ack_event` has closed yet. Already delivered, not yet acknowledged. A
  non-zero value is normal while the session is working.
- **`lag`** — entries published to the stream that the group has **not read at
  all** yet. Not delivered, therefore not pending. Lag moves as Claude
  acknowledges and the adapter resumes reading; it is not a queue of failures.
- **`max_inflight`** (5 by default) — **a budget for the adapter as a whole,
  not per stream.** It caps the total number of unacknowledged entries across
  every stream the policy subscribes to. This is the single most
  misread number in the whole channel, so it has its own section below.
- **`consumers`** — 1, and it stays 1: the policy fixes the consumer name, so a
  restart reuses it rather than abandoning a pending list under an old name.

### Saturated back-pressure is not an outage

`max_inflight` is one budget for the adapter, not one per stream. The in-flight
set is a single map keyed by event id, and one `XREADGROUP` reads every
subscribed stream in the same call; when that map is full the adapter does not
issue the read at all (`events/mctl_events/channel.py`, `read_once`). So when
the total of unacknowledged entries reaches `max_inflight`, **new deliveries
stop from every stream, including streams whose own `pending` is 0.**

That is the intended behaviour: events are held in Valkey rather than dropped
or delivered to a session that cannot act on them. The visible signature is one
stream at `pending=max_inflight` and *another* stream with `pending=0` and a
growing `lag`:

```
XINFO GROUPS mctl:events:github    pending=5  lag=16
XINFO GROUPS mctl:events:telegram  pending=0  lag=18
```

Read that as one condition, not two. The Telegram lag is a consequence of the
GitHub entries, and nothing about the Telegram path is broken.

The usual cause is the session not calling `ack_event`: it is out of quota,
wedged on a modal, or busy — or it reads the events and does not know it must
acknowledge them. Claude Code tells the model that channel content is untrusted
and not to act on imperative language inside it, so the "Then call ack_event."
in the notification carries no weight; the entrypoint therefore maintains the
contract as a managed section in `/workspace/CLAUDE.md` (markers
`<!-- mctl-events:begin … -->` / `<!-- mctl-events:end -->`). If a session
hydrates events and never acknowledges, check that the section is present in
the file the running session was started with (`[entrypoint] CLAUDE.md:
mctl-events contract present, written|current` in the pod log).

Check the session before touching the transport — `kubectl -n labs logs <pod>
-c base-service` shows the TUI, including a spend limit message. Once the
session acknowledges, `pending` falls, reading resumes and both lags drain on
their own. Nothing needs to be restarted, and an operator `XACK` would be a
lie: it would mark an event handled that Claude never handled.

## Durable state

Two keys per event, both under `mctl:events:state:`, with the group and event
id percent-encoded:

```
GET    mctl:events:state:attempt:claude-remote:github%3A48bf1f42-...  -> 1
EXISTS mctl:events:state:dedup:claude-remote:github%3A48bf1f42-...    -> 0
```

The pairing is diagnostic on its own:

| attempt | dedup | meaning |
|---|---|---|
| present | absent | delivered, not yet acknowledged — in flight |
| present | present | acknowledged; a producer retry will be suppressed until the dedup TTL expires |
| absent | present | acknowledged long enough ago that the attempt key expired — normal |
| absent | absent | never delivered, or both TTLs have passed |

An attempt key that keeps growing for one event id is the thing to look at: it
means the event is being delivered again and again without an acknowledgement,
and at `max_attempts` it will be audited as `rejected` and acknowledged so the
entry stops circulating.

## Recovery after a restart

The deployment uses `Recreate`, so a rollout kills the adapter with whatever
was in flight still pending. The new pod re-reads its own pending list before
reading anything new, and re-delivers those entries. Observed on the 0.12.0
rollout: five GitHub entries pending at kill, all five re-delivered 2m29s after
the new pod started, none lost and none acknowledged on Claude's behalf.

That first push is deliberately late. Claude Code registers its channel handler
only after the server's capabilities have travelled through its UI state —
about a second after `initialized` on 2.1.280 (`Channel notifications
registered` in `mcp-logs-mctl-events/`) — and a notification that arrives
before that is dropped without a trace. On 2026-09-23 (0.12.2, issue #67) the
recovered entries were pushed 0.6 s after connect, 1.5 s before registration,
and the session never saw them. The adapter now waits `startup_grace_ms`
(3000) after the client's last handshake message before consuming at all, and
logs `consumer started` when it does. If `delivered` records appear in the
audit trail *before* that log line, the grace period is too short for the
client in use.

The second safety net is the idle redelivery: an in-flight event that Claude has
not acknowledged within `reclaim_min_idle_ms` is pushed again with the next
attempt number (`delivered` with `redelivery=idle`), up to `max_attempts`, after
which it is audited as `rejected` and acknowledged so it stops holding a
`max_inflight` slot. Before this, a missed push stayed in flight until the next
restart and blocked every newer event behind it.

This is why the consumer name is fixed in the policy. An entry left pending
under a *different* consumer name is not recovered this way — it waits for
`reclaim_min_idle_ms` and is then taken over, which is the slow path and only
reached when the deployment is renamed or scaled.

## Symptoms worth acting on

- **`delivered` with no matching `acked`, and the attempt counter rising.** The
  session receives events and does not finish them. Look at the session, not at
  Valkey.
- **`published` with no `received`/`delivered`, lag rising, `pending=0`.** The
  adapter is not reading. Confirm the process is alive
  (`python3 -m mctl_events.channel` in the `base-service` container) and check
  its policy: an event whose subject falls outside the routes is acknowledged
  and audited as `skipped`, so *silence* in the audit trail means it never
  reached the adapter at all.
- **Gaps in the audit trail.** Audit writes are best effort and are dropped
  rather than blocking delivery. A gap means Valkey was unreachable for the
  audit writer, not that an event was lost.
- **Valkey refusing to start after an ACL change.** On the deployed image a
  single `#` line inside the rendered ACL file aborts startup rather than being
  ignored. Notes belong above the block, in the ExternalSecret's YAML, never
  inside it — the details are in `mctlhq/mctl-gitops`,
  `docs/runbooks/valkey-acl.md`.
