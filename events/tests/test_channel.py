from __future__ import annotations

import json
import threading
import time
import unittest

from support import POLICY, FakeClaude, ValkeyServer, envelope, requires_valkey

from mctl_events import policy as policy_mod
from mctl_events.channel import AUDIT_STREAM, Adapter
from mctl_events.valkey import ValkeyConnectionError

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

    def audit_stages(self, event_id: str, expect: list[str] | None = None) -> list[str]:
        """Audit writes are asynchronous: poll until the expected stages land."""

        deadline = time.time() + 5
        while True:
            stages = []
            for _, flat in self.db.execute("XRANGE", AUDIT_STREAM, "-", "+") or []:
                fields = dict(zip(flat[::2], flat[1::2]))
                if fields[b"event_id"].decode() == event_id:
                    stages.append(fields[b"stage"].decode())
            if expect is None or stages == expect or time.time() > deadline:
                return stages
            time.sleep(0.05)

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
        self.assertEqual(["received", "delivered", "acked"], self.audit_stages(doc["id"], ["received", "delivered", "acked"]))

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
        self.assertEqual(["skipped"], self.audit_stages(foreign["id"], ["skipped"]))

    def test_ack_for_an_unknown_event_changes_nothing(self) -> None:
        self.claude.handshake()
        result = self.claude.call("ack_event", event_id="telegram:evt:v1:7:42:9", outcome="handled")
        self.assertEqual("unknown", result["body"]["status"])
        bad = self.claude.call("ack_event", event_id="x", outcome="done")
        self.assertTrue(bad["isError"])


    def test_duplicate_entry_in_flight_wakes_the_session_once(self) -> None:
        self.claude.handshake()
        self.wait_for_group()
        doc = envelope()
        self.publish(doc)
        self.claude.notification()
        self.publish(doc)  # a producer retry publishes the same envelope again
        self.claude.no_notification(1.0)
        self.assertEqual(2, self.pending())
        self.assertEqual(2, self.claude.call("event_status", event_id=doc["id"])["body"]["entries"])
        self.claude.call("ack_event", event_id=doc["id"], outcome="handled")
        self.assertEqual(0, self.pending())
        self.assertEqual(["received", "delivered", "duplicate", "acked"], self.audit_stages(doc["id"], ["received", "delivered", "duplicate", "acked"]))

    def test_duplicate_after_ack_is_acknowledged_silently(self) -> None:
        self.claude.handshake()
        self.wait_for_group()
        doc = envelope("telegram:evt:v1:7:42:4001")
        self.publish(doc)
        self.claude.notification()
        self.claude.call("ack_event", event_id=doc["id"], outcome="handled")
        self.publish(doc)  # a late producer retry
        self.claude.no_notification(1.5)
        self.assertEqual(0, self.pending())
        expected = ["received", "delivered", "acked", "duplicate"]
        self.assertEqual(expected, self.audit_stages(doc["id"], expected))

    def test_in_flight_is_bounded_by_max_inflight(self) -> None:
        self.claude.close()
        claude = FakeClaude(self.valkey.url, {**POLICY, "max_inflight": 1})
        self.addCleanup(claude.close)
        claude.handshake()
        self.wait_for_group()
        first, second = envelope("telegram:evt:v1:7:42:2001"), envelope("telegram:evt:v1:7:42:2002")
        self.publish(first)
        self.publish(second)
        self.assertEqual(first["id"], claude.notification()["params"]["meta"]["event_id"])
        claude.no_notification(1.5)
        claude.call("ack_event", event_id=first["id"], outcome="handled")
        self.assertEqual(second["id"], claude.notification()["params"]["meta"]["event_id"])

    def test_consumer_recovers_after_valkey_restarts(self) -> None:
        self.claude.handshake()
        self.wait_for_group()
        self.valkey.restart()  # empty server: stream and group are gone too
        self.db = self.valkey.client()
        self.wait_for_group()  # the adapter reconnects and recreates its group
        doc = envelope("telegram:evt:v1:7:42:3001")
        self.publish(doc)
        self.assertEqual(doc["id"], self.claude.notification(timeout=40)["params"]["meta"]["event_id"])

    def test_unacknowledged_event_is_delivered_again_after_the_adapter_restarts(self) -> None:
        self.claude.handshake()
        self.wait_for_group()
        doc = envelope("telegram:evt:v1:7:42:4001")
        self.publish(doc)
        self.assertEqual(doc["id"], self.claude.notification()["params"]["meta"]["event_id"])
        self.claude.kill()  # crash before ack_event: the entry stays pending
        self.assertEqual(1, self.pending())

        replacement = FakeClaude(self.valkey.url, POLICY)
        self.addCleanup(replacement.close)
        replacement.handshake()
        self.assertEqual(doc["id"], replacement.notification()["params"]["meta"]["event_id"])
        self.assertEqual("acknowledged", replacement.call("ack_event", event_id=doc["id"], outcome="handled")["body"]["status"])
        self.assertEqual(0, self.pending())
        replacement.no_notification(0.5)


class _FailFirstXack:
    """Commands connection whose first XACK fails as if Valkey dropped the link."""

    def __init__(self, conn) -> None:
        self.conn, self.failed = conn, False

    def execute(self, *args, **kwargs):
        if args[0] == "XACK" and not self.failed:
            self.failed = True
            raise ValkeyConnectionError("simulated disconnect")
        return self.conn.execute(*args, **kwargs)


@requires_valkey
class InProcessAdapterTest(unittest.TestCase):
    def setUp(self) -> None:
        self.valkey = ValkeyServer()
        self.addCleanup(self.valkey.stop)
        self.db = self.valkey.client()
        self.policy = policy_mod.from_dict({**POLICY, "block_ms": 5000})

    def adapter(self, commands=None) -> Adapter:
        adapter = Adapter(self.policy, commands or self.valkey.client(), self.valkey.client(),
                          emit=lambda message: None)
        adapter.ensure_groups()
        return adapter

    def test_failed_automatic_ack_is_retried_from_the_pending_list(self) -> None:
        adapter = self.adapter(_FailFirstXack(self.valkey.client()))
        self.db.execute("XADD", STREAM, "*", "envelope", "not json")
        with self.assertRaises(ValkeyConnectionError):
            adapter.read_once(block_ms=100)
        self.assertEqual(1, self.db.execute("XPENDING", STREAM, "claude-remote")[0])
        self.assertEqual(1, adapter.recover_pending())
        self.assertEqual(0, self.db.execute("XPENDING", STREAM, "claude-remote")[0])

    def test_reconnect_does_not_duplicate_an_in_flight_entry(self) -> None:
        adapter = self.adapter()
        self.db.execute("XADD", STREAM, "*", "envelope", json.dumps(envelope("telegram:evt:v1:7:42:5001")))
        self.assertEqual(1, adapter.read_once(block_ms=100))
        adapter.recover_pending()
        self.assertEqual(1, len(adapter.inflight["telegram:evt:v1:7:42:5001"].entries))

    def test_stop_interrupts_a_blocked_read(self) -> None:
        adapter = self.adapter()
        consumer = threading.Thread(target=adapter.run, daemon=True)
        consumer.start()
        time.sleep(0.3)  # let it block in XREADGROUP for up to 5 s
        started = time.time()
        adapter.stop()
        consumer.join(timeout=3)
        self.assertFalse(consumer.is_alive())
        self.assertLess(time.time() - started, 2)


if __name__ == "__main__":
    unittest.main()
