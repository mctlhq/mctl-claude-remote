# Operating the inbound events Channel

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

## The group state, and what each number means

Group state needs the `claude-remote` user (the observer is deliberately not
allowed to see the event streams):

```
XINFO GROUPS mctl:events:github
  name=claude-remote  consumers=1  pending=5  lag=16  last-delivered-id=...
```

- **`pending`** — entries handed to Claude that no `ack_event` has closed yet.
  A non-zero value is normal while the session is working. It is bounded by
  `max_inflight` (5 by default).
- **`lag`** — entries published but not yet read by the group. Lag moves as
  Claude acknowledges; it is *not* a queue of failures.
- **`consumers`** — 1, and it stays 1: the policy fixes the consumer name, so a
  restart reuses it rather than abandoning a pending list under an old name.

### Saturated back-pressure is not an outage

When `pending` equals `max_inflight`, the adapter stops reading new entries
**from every stream**, not just the one that filled it. That is the intended
behaviour: events are held in Valkey rather than dropped or delivered to a
session that cannot act on them. The visible signature is one stream at
`pending=max_inflight` and *another* stream with `pending=0` and a growing
`lag`:

```
XINFO GROUPS mctl:events:github    pending=5  lag=16
XINFO GROUPS mctl:events:telegram  pending=0  lag=18
```

Read that as one condition, not two. The Telegram lag is a consequence of the
GitHub entries, and nothing about the Telegram path is broken.

The usual cause is the session not calling `ack_event`: it is out of quota,
wedged on a modal, or busy. Check the session before touching the transport —
`kubectl -n labs logs <pod> -c base-service` shows the TUI, including a spend
limit message. Once the session acknowledges, `pending` falls, reading resumes
and both lags drain on their own. Nothing needs to be restarted, and an
operator `XACK` would be a lie: it would mark an event handled that Claude
never handled.

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
- **Valkey refusing to start after an ACL change.** The ACL file accepts no
  comments — a single `#` line aborts startup. Notes belong above the rendered
  block, in the ExternalSecret's YAML, never inside it.
