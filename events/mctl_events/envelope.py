"""Event envelope v1 -- a signal that something happened, never a copy of it.

The envelope carries identity and references only. The content an event refers
to (a Telegram message body, a pull request) stays in its system of record and
is hydrated by Claude through that system's MCP tools, under that system's own
authorization. That is why the envelope is closed: an unknown top-level field is
rejected rather than passed along, so a producer cannot start smuggling bodies
through the transport by adding a key.

Canonical JSON Schema: mctlhq/.github events/schemas/event-envelope.v1.schema.json.
This module is the consumer-side enforcement of the same contract.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any

SPEC_VERSION = "mctl.events/v1"

_FIELDS = {"specversion", "id", "type", "source", "occurred_at", "correlation_id", "subject"}
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:._/@#-]{0,255}$")
_TYPE = re.compile(r"^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$")
_SOURCE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
_SUBJECT_KEY = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
_RFC3339 = re.compile(
    r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d"
    r"(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$"
)
_KIND = re.compile(r"^[a-z0-9_]+(\.[a-z0-9_]+)*$")
# A subject value is an identifier (a number, `user:42`, `owner/repo`, a SHA),
# never prose: no whitespace, quotes or brackets, so a free-text sentence cannot
# travel in a reference-shaped key such as `subject.text`.
_SUBJECT_VALUE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@#+=-]*$")
MAX_KIND = 64
MAX_SUBJECT_KEYS = 12
MAX_SUBJECT_VALUE = 256
MAX_ENVELOPE_BYTES = 4096


class InvalidEnvelope(ValueError):
    pass


@dataclass(frozen=True)
class Envelope:
    id: str
    type: str
    source: str
    occurred_at: str
    correlation_id: str
    subject: dict[str, str]

    def to_json(self) -> str:
        return json.dumps(
            {
                "specversion": SPEC_VERSION,
                "id": self.id,
                "type": self.type,
                "source": self.source,
                "occurred_at": self.occurred_at,
                "correlation_id": self.correlation_id,
                "subject": self.subject,
            },
            sort_keys=True,
            separators=(",", ":"),
        )


def parse(raw: str | bytes) -> Envelope:
    if isinstance(raw, bytes):
        if len(raw) > MAX_ENVELOPE_BYTES:
            raise InvalidEnvelope(f"envelope exceeds {MAX_ENVELOPE_BYTES} bytes")
        try:
            raw = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise InvalidEnvelope("envelope is not UTF-8") from exc
    if len(raw.encode("utf-8")) > MAX_ENVELOPE_BYTES:
        raise InvalidEnvelope(f"envelope exceeds {MAX_ENVELOPE_BYTES} bytes")
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise InvalidEnvelope(f"envelope is not JSON: {exc.msg}") from exc
    except RecursionError as exc:
        # 4 KiB of "[[[[..." parses deeper than the interpreter allows.
        raise InvalidEnvelope("envelope nests too deeply") from exc
    return from_dict(doc)


def from_dict(doc: Any) -> Envelope:
    if not isinstance(doc, dict):
        raise InvalidEnvelope("envelope must be an object")
    unknown = sorted(set(doc) - _FIELDS)
    if unknown:
        raise InvalidEnvelope(f"unknown envelope fields: {unknown}")
    missing = sorted(_FIELDS - set(doc))
    if missing:
        raise InvalidEnvelope(f"missing envelope fields: {missing}")
    if doc["specversion"] != SPEC_VERSION:
        raise InvalidEnvelope(f"unsupported specversion {doc['specversion']!r}")
    for name, pattern in (("id", _ID), ("type", _TYPE), ("source", _SOURCE), ("correlation_id", _ID)):
        value = doc[name]
        if not isinstance(value, str) or not pattern.fullmatch(value):
            raise InvalidEnvelope(f"invalid {name}: {value!r}")
    occurred_at = doc["occurred_at"]
    if not isinstance(occurred_at, str) or not _RFC3339.fullmatch(occurred_at):
        raise InvalidEnvelope(f"invalid occurred_at: {occurred_at!r}")
    try:
        datetime.fromisoformat(occurred_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise InvalidEnvelope(f"invalid occurred_at: {occurred_at!r}") from exc

    subject = doc["subject"]
    if not isinstance(subject, dict) or "kind" not in subject:
        raise InvalidEnvelope("subject must be an object with a kind")
    kind = subject["kind"]
    if not isinstance(kind, str) or len(kind) > MAX_KIND or not _KIND.fullmatch(kind):
        raise InvalidEnvelope(f"invalid subject.kind: {kind!r}")
    if len(subject) > MAX_SUBJECT_KEYS:
        raise InvalidEnvelope(f"subject has more than {MAX_SUBJECT_KEYS} keys")
    normalized: dict[str, str] = {}
    for key, value in subject.items():
        if not isinstance(key, str) or not _SUBJECT_KEY.fullmatch(key):
            raise InvalidEnvelope(f"invalid subject key {key!r}")
        # References are bounded strings. A nested object, list or unbounded
        # number is how content (or an oversized value) would sneak in.
        if not isinstance(value, str):
            raise InvalidEnvelope(f"subject.{key} must be a string")
        if not value or len(value) > MAX_SUBJECT_VALUE:
            raise InvalidEnvelope(f"subject.{key} must be 1..{MAX_SUBJECT_VALUE} characters")
        if not _SUBJECT_VALUE.fullmatch(value):
            raise InvalidEnvelope(f"subject.{key} must be an identifier, not free text")
        normalized[key] = value
    return Envelope(
        id=doc["id"],
        type=doc["type"],
        source=doc["source"],
        occurred_at=occurred_at,
        correlation_id=doc["correlation_id"],
        subject=normalized,
    )
