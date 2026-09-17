from __future__ import annotations

import json
import time
import unittest

from support import POLICY, FakeClaude, ValkeyServer, envelope, requires_valkey

from mctl_events.channel import AUDIT_STREAM

STREAM = "mctl:events:telegram"


@requires_valkey
class WalkingSkeletonTest(unittest.TestCase):
    def setUp(self) -> None:
        self.valkey = ValkeyServer()
        self.db = self.valkey.client()
        self.claude = FakeClaude(self.valkey.url, POLICY)
        self.addCleanup(self.valkey.stop)
        self.addCleanup(self.claude.close)

    def publish(self, doc) -> str:
        return self.db.execute("XADD", STREAM, "*", "envelope", json.dumps(doc)).decode()

    def pending(self) -> int:
        return self.db.execute("XPENDING", STREAM, "claude-remote")[0]

    def wait_for_group(self) -> None:
        deadline = time.time() + 10
        while time.time() < deadline:
            if self.db.execute("EXISTS", STREAM):
                groups = self.db.execute("XINFO", "GROUPS", STREAM)
                if groups:
                    return
            time.sleep(0.05)
        raise AssertionError("consumer group never created")

    def audit_stages(self, event_id: str) -> list[str]:
        stages = []
        for _, flat in self.db.execute("XRANGE", AUDIT_STREAM, "-", "+"):
            fields = dict(zip(flat[::2], flat[1::2]))
            if fields[b"event_id"].decode() == event_id:
                stages.append(fields[b"stage"].decode())
        return stages

    def test_declares_the_channel_capability(self) -> None:
        init = self.claude.handshake()
        self.assertEqual({}, init["result"]["capabilities"]["experimental"]["claude/channel"])
        tools = self.claude.request("tools/list", {})["result"]["tools"]
        self.assertEqual(["ack_event", "event_status"], sorted(t["name"] for t in tools))

    def test_event_reaches_the_session_and_is_acked_only_by_claude(self) -> None:
        self.claude.handshake()
        self.wait_for_group()
        doc = envelope()
        self.publish(doc)

        pushed = self.claude.notification()["params"]
        meta = pushed["meta"]
        self.assertEqual(doc["id"], meta["event_id"])
        self.assertEqual(doc["correlation_id"], meta["correlation_id"])
        self.assertEqual("1", meta["attempt"])
        self.assertEqual("user:42", meta["subject_peer"])
        self.assertTrue(all(k.replace("_", "").isalnum() for k in meta), meta)
        self.assertIn("get_messages(peer=user:42, before_id=1002, limit=1)", pushed["content"])

        # Delivered is not acknowledged: the entry stays pending until Claude says so.
        self.assertEqual(1, self.pending())
        self.assertEqual("in_flight", self.claude.call("event_status", event_id=doc["id"])["body"]["status"])

        ack = self.claude.call("ack_event", event_id=doc["id"], outcome="handled", note="get_messages user:42")
        self.assertEqual("acknowledged", ack["body"]["status"])
        self.assertEqual(0, self.pending())
        self.assertEqual(["received", "delivered", "acked"], self.audit_stages(doc["id"]))

    def test_notification_carries_references_not_content(self) -> None:
        self.claude.handshake()
        self.wait_for_group()
        self.publish(envelope())
        pushed = self.claude.notification()["params"]
        flat = json.dumps(pushed)
        self.assertNotIn("text", pushed["meta"])
        self.assertNotIn("body", flat)

    def test_envelope_carrying_a_body_is_rejected_and_never_delivered(self) -> None:
        self.claude.handshake()
        self.wait_for_group()
        smuggled = envelope("telegram:evt:v1:7:42:1002")
        smuggled["body"] = "the secret message text"
        self.publish(smuggled)
        nested = envelope("telegram:evt:v1:7:42:1003")
        nested["subject"]["text"] = {"value": "the secret message text"}
        self.publish(nested)
        self.claude.no_notification(1.5)
        self.assertEqual(0, self.pending())

    def test_out_of_policy_event_is_skipped_and_acknowledged(self) -> None:
        self.claude.handshake()
        self.wait_for_group()
        foreign = envelope("telegram:evt:v1:8:42:1001")
        foreign["subject"]["account_id"] = "8"
        self.publish(foreign)
        self.claude.no_notification(1.5)
        self.assertEqual(0, self.pending())
        self.assertEqual(["skipped"], self.audit_stages(foreign["id"]))

    def test_ack_for_an_unknown_event_changes_nothing(self) -> None:
        self.claude.handshake()
        result = self.claude.call("ack_event", event_id="telegram:evt:v1:7:42:9", outcome="handled")
        self.assertEqual("unknown", result["body"]["status"])
        bad = self.claude.call("ack_event", event_id="x", outcome="done")
        self.assertTrue(bad["isError"])


if __name__ == "__main__":
    unittest.main()
