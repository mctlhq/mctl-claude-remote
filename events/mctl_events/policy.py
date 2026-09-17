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
    ack_timeout_seconds: int = 900
    max_inflight: int = 5
    dedup_ttl_seconds: int = 14 * 24 * 3600
    block_ms: int = 5000
    stream_maxlen: int = 10000

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
    allowed = {"group", "consumer", "routes", "ack_timeout_seconds", "max_inflight",
               "dedup_ttl_seconds", "block_ms", "stream_maxlen"}
    unknown = sorted(set(doc) - allowed)
    if unknown:
        raise ValueError(f"unknown policy fields: {unknown}")
    for key in ("group", "consumer"):
        if not isinstance(doc.get(key), str) or not _NAME.match(doc[key]):
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
        if not isinstance(stream, str) or not _STREAM.match(stream):
            raise ValueError(f"{where}.stream must match {_STREAM.pattern}")
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
        ack_timeout_seconds=_positive(doc, "ack_timeout_seconds", 900),
        max_inflight=_positive(doc, "max_inflight", 5),
        dedup_ttl_seconds=_positive(doc, "dedup_ttl_seconds", 14 * 24 * 3600),
        block_ms=_positive(doc, "block_ms", 5000),
        stream_maxlen=_positive(doc, "stream_maxlen", 10000),
    )


def load(path: Path) -> Policy:
    return from_dict(json.loads(path.read_text(encoding="utf-8")))
