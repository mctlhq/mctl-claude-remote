from __future__ import annotations

import json
import unittest

from support import envelope

from mctl_events import envelope as env_mod
from mctl_events import policy as policy_mod


class EnvelopeTest(unittest.TestCase):
    def test_valid_envelope_round_trips(self) -> None:
        parsed = env_mod.parse(json.dumps(envelope()))
        self.assertEqual(envelope(), json.loads(parsed.to_json()))

    def test_rejections(self) -> None:
        cases = {
            "unknown field": {**envelope(), "body": "hi"},
            "missing field": {k: v for k, v in envelope().items() if k != "correlation_id"},
            "wrong version": {**envelope(), "specversion": "mctl.events/v2"},
            "nested subject": {**envelope(), "subject": {"kind": "x", "text": {"a": 1}}},
            "list subject": {**envelope(), "subject": {"kind": "x", "ids": [1]}},
            "bool subject": {**envelope(), "subject": {"kind": "x", "flag": True}},
            "no kind": {**envelope(), "subject": {"chat_id": "1"}},
            "long value": {**envelope(), "subject": {"kind": "x", "note": "a" * 257}},
            "bad type": {**envelope(), "type": "Telegram Message"},
            "naive time": {**envelope(), "occurred_at": "2026-09-17T08:00:00"},
            "bad time": {**envelope(), "occurred_at": "2026-13-17T08:00:00Z"},
            "too many keys": {**envelope(), "subject": {"kind": "x", **{f"k{i}": "v" for i in range(12)}}},
        }
        for name, doc in cases.items():
            with self.subTest(name):
                with self.assertRaises(env_mod.InvalidEnvelope):
                    env_mod.parse(json.dumps(doc))

    def test_oversized_and_non_utf8_are_rejected(self) -> None:
        with self.assertRaises(env_mod.InvalidEnvelope):
            env_mod.parse(b"\xff\xfe")
        with self.assertRaises(env_mod.InvalidEnvelope):
            env_mod.parse(b" " * (env_mod.MAX_ENVELOPE_BYTES + 1))


class PolicyTest(unittest.TestCase):
    def policy(self, **route):
        base = {"stream": "mctl:events:telegram", "sources": ["mctl-telegram"], "types": ["telegram.message.*"]}
        return policy_mod.from_dict({"group": "g", "consumer": "c", "routes": [{**base, **route}]})

    def test_deny_by_default(self) -> None:
        empty = policy_mod.from_dict({"group": "g", "consumer": "c", "routes": []})
        self.assertIsNone(empty.route_for("mctl:events:telegram", env_mod.from_dict(envelope())))

    def test_every_dimension_must_match(self) -> None:
        env = env_mod.from_dict(envelope())
        self.assertIsNotNone(self.policy(subject={"account_id": ["7"]}).route_for("mctl:events:telegram", env))
        self.assertIsNone(self.policy().route_for("mctl:events:github", env))
        self.assertIsNone(self.policy(sources=["mctl-api"]).route_for("mctl:events:telegram", env))
        self.assertIsNone(self.policy(types=["github.*"]).route_for("mctl:events:telegram", env))
        self.assertIsNone(self.policy(subject={"account_id": ["8"]}).route_for("mctl:events:telegram", env))
        self.assertIsNone(self.policy(subject={"repository": ["*"]}).route_for("mctl:events:telegram", env))

    def test_invalid_policies(self) -> None:
        for doc in (
            {"group": "g", "consumer": "c", "routes": [], "extra": 1},
            {"group": "g g", "consumer": "c", "routes": []},
            {"group": "g", "consumer": "c", "routes": [{"stream": "other", "sources": ["a"], "types": ["a.b"]}]},
            {"group": "g", "consumer": "c", "routes": [{"stream": "mctl:events:x", "sources": [], "types": ["a.b"]}]},
            {"group": "g", "consumer": "c", "routes": [], "max_inflight": 0},
        ):
            with self.subTest(doc=doc), self.assertRaises(ValueError):
                policy_mod.from_dict(doc)


if __name__ == "__main__":
    unittest.main()
