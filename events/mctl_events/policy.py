"""Routing policy: which events this session is allowed to be woken by.

A session subscribes to streams and, within each, to event types and subject
values. Anything outside the policy is acknowledged and audited as `skipped`,
never delivered: a Claude session must not be woken for an account or a
repository it does not own, even if the producer and the stream share it.
Deny by default -- an empty route list delivers nothing.
"""

from __future__ import annotations

import fnmatch
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .envelope import Envelope

_STREAM = re.compile(r"^mctl:events:[a-z0-9][a-z0-9_-]{0,62}$")
# Streams the adapter itself writes to. Subscribing to one would feed the
# adapter its own output: every audit entry has no envelope, so each would be
# rejected and audited again, forever.
RESERVED_STREAMS = frozenset({"mctl:events:audit", "mctl:events:state"})
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


@dataclass(frozen=True)
class Route:
    stream: str
    sources: tuple[str, ...]
    types: tuple[str, ...]
    subject: dict[str, tuple[str, ...]] = field(default_factory=dict)

    def matches(self, stream: str, envelope: Envelope) -> bool:
        if stream != self.stream or envelope.source not in self.sources:
            return False
        if not any(fnmatch.fnmatchcase(envelope.type, pattern) for pattern in self.types):
            return False
        for key, patterns in self.subject.items():
            value = envelope.subject.get(key)
            if value is None or not any(fnmatch.fnmatchcase(value, p) for p in patterns):
                return False
        return True


@dataclass(frozen=True)
class Policy:
    group: str
    consumer: str
    routes: tuple[Route, ...]
    max_inflight: int = 5
    block_ms: int = 5000
    # How long an acknowledged event id is remembered in Valkey, so a producer
    # retry that arrives after a restart is acknowledged instead of waking the
    # session again. Producers republish from an outbox within minutes; a day
    # covers that with room to spare and costs one small key per event.
    dedup_ttl_seconds: int = 86400
    # An event unacknowledged for at least this long is delivered again with
    # the next attempt number: this consumer's own in-flight events are pushed
    # to the session once more (a push the session missed is not lost until
    # the next restart), and an entry pending on *another* consumer is taken
    # over (XCLAIM). Generous on purpose: a session that is simply slow to
    # answer is told to check for an earlier side effect, not undercut.
    reclaim_min_idle_ms: int = 300000
    # Delay between the client's last handshake message (`initialized`, then
    # `tools/list`) and the first delivery. Claude Code registers its channel
    # handler only after the server's capabilities have propagated through
    # its UI state -- observed ~1 s after `initialized` on 2.1.280 -- and a
    # notification pushed before that is dropped by the client without a
    # trace. Nothing in the protocol marks the moment, so the adapter waits
    # for the handshake to go quiet instead.
    startup_grace_ms: int = 3000
    # Deliveries of one entry before it is rejected: a poison event that Claude
    # never acknowledges must not be reclaimed forever.
    max_attempts: int = 5
    # Where a consumer group starts when the adapter creates it for the first
    # time: "$" (default) = only events published from now on, so a new session
    # is not flooded with the retained history; "0" = replay the
    # retained stream. Once created, the group's position lives in Valkey and
    # restarts resume from it either way.
    group_start: str = "$"

    @property
    def streams(self) -> tuple[str, ...]:
        return tuple(sorted({route.stream for route in self.routes}))

    def route_for(self, stream: str, envelope: Envelope) -> Route | None:
        return next((route for route in self.routes if route.matches(stream, envelope)), None)


def _strings(value: Any, where: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not value or not all(isinstance(v, str) and v for v in value):
        raise ValueError(f"{where} must be a non-empty list of strings")
    return tuple(value)


def _positive(doc: dict[str, Any], key: str, default: int) -> int:
    value = doc.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{key} must be a positive integer")
    return value


def from_dict(doc: Any) -> Policy:
    if not isinstance(doc, dict):
        raise ValueError("policy must be an object")
    # Only knobs this adapter honours: accepting any other field would let an
    # operator believe a setting is in effect when nothing reads it.
    allowed = {"group", "consumer", "routes", "max_inflight", "block_ms", "group_start",
               "dedup_ttl_seconds", "reclaim_min_idle_ms", "max_attempts", "startup_grace_ms"}
    unknown = sorted(set(doc) - allowed)
    if unknown:
        raise ValueError(f"unknown policy fields: {unknown}")
    for key in ("group", "consumer"):
        if not isinstance(doc.get(key), str) or not _NAME.fullmatch(doc[key]):
            raise ValueError(f"{key} must match {_NAME.pattern}")
    routes_doc = doc.get("routes")
    if not isinstance(routes_doc, list):
        raise ValueError("routes must be a list")
    routes = []
    for index, item in enumerate(routes_doc):
        where = f"routes[{index}]"
        if not isinstance(item, dict) or set(item) - {"stream", "sources", "types", "subject"}:
            raise ValueError(f"{where} must be an object with stream, sources, types and optional subject")
        stream = item.get("stream")
        if not isinstance(stream, str) or not _STREAM.fullmatch(stream):
            raise ValueError(f"{where}.stream must match {_STREAM.pattern}")
        if stream in RESERVED_STREAMS:
            raise ValueError(f"{where}.stream {stream} is reserved for the adapter's own output")
        subject_doc = item.get("subject", {})
        if not isinstance(subject_doc, dict):
            raise ValueError(f"{where}.subject must be an object")
        routes.append(
            Route(
                stream=stream,
                sources=_strings(item.get("sources"), f"{where}.sources"),
                types=_strings(item.get("types"), f"{where}.types"),
                subject={k: _strings(v, f"{where}.subject.{k}") for k, v in sorted(subject_doc.items())},
            )
        )
    return Policy(
        group=doc["group"],
        consumer=doc["consumer"],
        routes=tuple(routes),
        max_inflight=_positive(doc, "max_inflight", 5),
        block_ms=_positive(doc, "block_ms", 5000),
        group_start=_group_start(doc.get("group_start", "$")),
        dedup_ttl_seconds=_positive(doc, "dedup_ttl_seconds", 86400),
        reclaim_min_idle_ms=_positive(doc, "reclaim_min_idle_ms", 300000),
        max_attempts=_positive(doc, "max_attempts", 5),
        startup_grace_ms=_positive(doc, "startup_grace_ms", 3000),
    )


def _group_start(value: Any) -> str:
    if value not in ("$", "0"):
        raise ValueError('group_start must be "$" or "0"')
    return value


def load(path: Path) -> Policy:
    return from_dict(json.loads(path.read_text(encoding="utf-8")))
