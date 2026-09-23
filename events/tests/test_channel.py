from __future__ import annotations

import json
import queue
import threading
import time
import unittest

from support import POLICY, FakeClaude, ValkeyServer, envelope, requires_valkey

from mctl_events import policy as policy_mod
from mctl_events.channel import AUDIT_STREAM, PENDING_BATCH, Adapter
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
        pushed = replacement.notification()["params"]["meta"]
        self.assertEqual(doc["id"], pushed["event_id"])
        # Delivered before, so Claude is told to check for an earlier side effect.
        self.assertEqual("2", pushed["attempt"])
        self.assertEqual("acknowledged", replacement.call("ack_event", event_id=doc["id"], outcome="handled")["body"]["status"])
        self.assertEqual(0, self.pending())
        replacement.no_notification(0.5)

    def leave_one_pending(self, event_id: str) -> dict:
        """Deliver an event and crash the adapter before it is acknowledged."""

        self.claude.handshake()
        self.wait_for_group()
        doc = envelope(event_id)
        self.publish(doc)
        self.assertEqual(doc["id"], self.claude.notification()["params"]["meta"]["event_id"])
        self.claude.kill()
        self.assertEqual(1, self.pending())
        return doc

    def test_first_push_waits_for_the_handshake_to_settle(self) -> None:
        """Claude Code registers its channel handler about a second after
        `initialized` and silently drops a push that arrives before that, so the
        recovered pending list must not be pushed the moment the handshake ends."""

        doc = self.leave_one_pending("telegram:evt:v1:7:42:8001")
        replacement = FakeClaude(self.valkey.url, {**POLICY, "startup_grace_ms": 1500})
        self.addCleanup(replacement.close)
        replacement.handshake()
        replacement.no_notification(0.9)
        pushed = replacement.notification(timeout=5)["params"]["meta"]
        self.assertEqual((doc["id"], "2"), (pushed["event_id"], pushed["attempt"]))

    def test_tools_list_restarts_the_settle_countdown(self) -> None:
        """The client lists tools after `initialized`; the window counts from
        whichever handshake message came last."""

        self.leave_one_pending("telegram:evt:v1:7:42:8002")
        replacement = FakeClaude(self.valkey.url, {**POLICY, "startup_grace_ms": 1500})
        self.addCleanup(replacement.close)
        replacement.handshake()
        time.sleep(1.0)
        replacement.request("tools/list", {})
        replacement.no_notification(0.9)  # 1.9 s after initialized: still waiting
        replacement.notification(timeout=5)

    def test_duplicate_after_a_restart_is_acknowledged_without_waking_the_session(self) -> None:
        """The dedup marker lives in Valkey, not in the adapter's memory."""

        self.claude.handshake()
        self.wait_for_group()
        doc = envelope("telegram:evt:v1:7:42:6001")
        self.publish(doc)
        self.claude.notification()
        self.claude.call("ack_event", event_id=doc["id"], outcome="handled")
        self.claude.kill()  # the in-memory set of acked ids dies with it

        replacement = FakeClaude(self.valkey.url, POLICY)
        self.addCleanup(replacement.close)
        replacement.handshake()
        self.publish(doc)  # the producer republishes from its outbox
        replacement.no_notification(2.0)
        self.assertEqual(0, self.pending())
        # Killing the first adapter can lose its queued audit records, so what
        # matters here is the last stage: the republished entry ended as a
        # duplicate rather than a second delivery.
        deadline = time.time() + 5
        while time.time() < deadline and "duplicate" not in self.audit_stages(doc["id"]):
            time.sleep(0.05)
        self.assertEqual("duplicate", self.audit_stages(doc["id"])[-1])


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

    def adapter(self, commands=None, policy=None, emit=None) -> Adapter:
        adapter = Adapter(policy or self.policy, commands or self.valkey.client(), self.valkey.client(),
                          emit=emit or (lambda message: None))
        adapter.ensure_groups()
        return adapter

    def audit_stages(self) -> list[str]:
        return [dict(zip(flat[::2], flat[1::2]))[b"stage"].decode()
                for _, flat in self.db.execute("XRANGE", AUDIT_STREAM, "-", "+") or []]

    def claim_as_ghost(self, doc, **overrides) -> Adapter:
        """Deliver an event on a consumer that is then abandoned mid-flight.

        A real adapter under a different name, not a bare XREADGROUP: the
        attempt number is counted by the adapter as it hands the event to
        Claude, so only a real delivery leaves the state a takeover inherits."""

        ghost = self.adapter(policy=policy_mod.from_dict(
            {**POLICY, "consumer": "ghost-consumer", **overrides}))
        self.db.execute("XADD", STREAM, "*", "envelope", json.dumps(doc))
        self.assertEqual(1, ghost.read_once(block_ms=100))  # delivered, never acked
        return ghost

    def test_entry_abandoned_by_another_consumer_is_reclaimed_with_a_higher_attempt(self) -> None:
        pushed: list[dict] = []
        policy = policy_mod.from_dict({**POLICY, "reclaim_min_idle_ms": 1})
        adapter = self.adapter(policy=policy, emit=pushed.append)
        doc = envelope("telegram:evt:v1:7:42:7001")
        self.claim_as_ghost(doc)
        time.sleep(0.05)  # let it idle past reclaim_min_idle_ms

        self.assertEqual(1, adapter.reclaim())
        self.assertEqual(doc["id"], pushed[0]["params"]["meta"]["event_id"])
        # The abandoned consumer already delivered it once: the count is kept in
        # Valkey, so the takeover continues it instead of starting over.
        self.assertEqual("2", pushed[0]["params"]["meta"]["attempt"])
        self.assertEqual("acknowledged", adapter.ack(doc["id"], "handled", "")["status"])
        self.assertEqual(0, self.db.execute("XPENDING", STREAM, "claude-remote")[0])

    def test_reclaim_leaves_this_consumers_own_pending_entries_alone(self) -> None:
        policy = policy_mod.from_dict({**POLICY, "reclaim_min_idle_ms": 1})
        adapter = self.adapter(policy=policy)
        self.db.execute("XADD", STREAM, "*", "envelope", json.dumps(envelope("telegram:evt:v1:7:42:7002")))
        self.assertEqual(1, adapter.read_once(block_ms=100))
        time.sleep(0.05)

        # Claude is still working on it: taking it over here would inflate the
        # attempt number of an event that was never abandoned.
        self.assertEqual(0, adapter.reclaim())
        self.assertEqual(1, adapter.inflight["telegram:evt:v1:7:42:7002"].attempt)

    def test_an_event_never_acknowledged_is_rejected_after_max_attempts(self) -> None:
        pushed: list[dict] = []
        policy = policy_mod.from_dict({**POLICY, "reclaim_min_idle_ms": 1, "max_attempts": 1})
        adapter = self.adapter(policy=policy, emit=pushed.append)
        doc = envelope("telegram:evt:v1:7:42:7003")
        self.claim_as_ghost(doc)
        time.sleep(0.05)

        self.assertEqual(1, adapter.reclaim())
        self.assertEqual([], pushed)  # attempt 2 is past the cap: not delivered again
        self.assertEqual(0, self.db.execute("XPENDING", STREAM, "claude-remote")[0])
        adapter.flush_audit()
        self.assertIn("rejected", self.audit_stages())

    def test_a_rejected_event_is_not_started_over_by_a_producer_retry(self) -> None:
        """The cap survives the entry it rejected: rejection marks the event id."""

        pushed: list[dict] = []
        policy = policy_mod.from_dict({**POLICY, "reclaim_min_idle_ms": 1, "max_attempts": 1})
        adapter = self.adapter(policy=policy, emit=pushed.append)
        doc = envelope("telegram:evt:v1:7:42:7004")
        self.claim_as_ghost(doc)
        time.sleep(0.05)
        self.assertEqual(1, adapter.reclaim())

        self.db.execute("XADD", STREAM, "*", "envelope", json.dumps(doc))  # outbox retry
        self.assertEqual(1, adapter.read_once(block_ms=100))
        self.assertEqual([], pushed)  # rejected once, not delivered again at attempt 1
        self.assertEqual(0, self.db.execute("XPENDING", STREAM, "claude-remote")[0])

    def test_restarting_the_same_consumer_still_reaches_max_attempts(self) -> None:
        """Valkey's own delivery count does not move on an ID-based re-read, so a
        crash loop on one consumer name has to be bounded by the durable count."""

        pushed: list[dict] = []
        policy = policy_mod.from_dict({**POLICY, "max_attempts": 2})
        first = self.adapter(policy=policy, emit=pushed.append)
        self.db.execute("XADD", STREAM, "*", "envelope", json.dumps(envelope("telegram:evt:v1:7:42:7005")))
        self.assertEqual(1, first.read_once(block_ms=100))  # attempt 1, never acked

        # Every restart re-reads this consumer's own pending list.
        for _ in range(3):
            self.adapter(policy=policy, emit=pushed.append).recover_pending()
        attempts = [message["params"]["meta"]["attempt"] for message in pushed]
        self.assertEqual(["1", "2"], attempts)  # the third re-read is past the cap
        self.assertEqual(0, self.db.execute("XPENDING", STREAM, "claude-remote")[0])

    def test_own_unacknowledged_event_is_pushed_again_after_reclaim_min_idle(self) -> None:
        """A push the session missed used to stay in flight until the next
        restart; now it is offered again, with the next attempt number."""

        pushed: list[dict] = []
        policy = policy_mod.from_dict({**POLICY, "reclaim_min_idle_ms": 50})
        adapter = self.adapter(policy=policy, emit=pushed.append)
        doc = envelope("telegram:evt:v1:7:42:7101")
        self.db.execute("XADD", STREAM, "*", "envelope", json.dumps(doc))
        self.assertEqual(1, adapter.read_once(block_ms=100))
        self.assertEqual(0, adapter.redeliver_stale())  # not idle yet
        time.sleep(0.06)

        self.assertEqual(1, adapter.redeliver_stale())
        self.assertEqual(["1", "2"], [message["params"]["meta"]["attempt"] for message in pushed])
        self.assertEqual(2, adapter.inflight[doc["id"]].attempt)
        self.assertEqual(0, adapter.redeliver_stale())  # the idle clock restarted with the push
        self.assertEqual("acknowledged", adapter.ack(doc["id"], "handled", "")["status"])
        self.assertEqual(0, self.db.execute("XPENDING", STREAM, "claude-remote")[0])
        adapter.flush_audit()
        self.assertEqual(["received", "delivered", "delivered", "acked"], self.audit_stages())

    def test_redelivery_of_an_own_event_stops_at_max_attempts(self) -> None:
        pushed: list[dict] = []
        policy = policy_mod.from_dict({**POLICY, "reclaim_min_idle_ms": 50, "max_attempts": 1})
        adapter = self.adapter(policy=policy, emit=pushed.append)
        self.db.execute("XADD", STREAM, "*", "envelope", json.dumps(envelope("telegram:evt:v1:7:42:7102")))
        self.assertEqual(1, adapter.read_once(block_ms=100))
        time.sleep(0.06)

        self.assertEqual(0, adapter.redeliver_stale())
        self.assertEqual(1, len(pushed))  # attempt 2 is past the cap: not pushed again
        self.assertEqual({}, adapter.inflight)  # the slot is free for newer events
        self.assertEqual(0, self.db.execute("XPENDING", STREAM, "claude-remote")[0])
        adapter.flush_audit()
        self.assertEqual("rejected", self.audit_stages()[-1])

    def test_a_redelivery_that_never_reached_claude_keeps_the_slot_and_the_attempt(self) -> None:
        pushed: list[dict] = []
        broken = False

        def emit(message: dict) -> None:
            if broken:
                raise BrokenPipeError("stdout is gone")
            pushed.append(message)

        policy = policy_mod.from_dict({**POLICY, "reclaim_min_idle_ms": 50})
        adapter = self.adapter(policy=policy, emit=emit)
        doc = envelope("telegram:evt:v1:7:42:7103")
        self.db.execute("XADD", STREAM, "*", "envelope", json.dumps(doc))
        self.assertEqual(1, adapter.read_once(block_ms=100))
        broken = True
        time.sleep(0.06)

        self.assertEqual(0, adapter.redeliver_stale())
        self.assertEqual(1, adapter.inflight[doc["id"]].attempt)  # refunded, still in flight
        self.assertEqual(b"1", self.db.execute(
            "GET", "mctl:events:state:attempt:claude-remote:telegram%3Aevt%3Av1%3A7%3A42%3A7103"))
        broken = False
        self.assertEqual(1, adapter.redeliver_stale())  # still idle: tried again at once
        self.assertEqual(["1", "2"], [message["params"]["meta"]["attempt"] for message in pushed])

    def test_run_loop_pushes_a_stuck_event_again_without_a_restart(self) -> None:
        """The wiring, not only the method: a live consumer retries on its own."""

        pushed: "queue.Queue[dict]" = queue.Queue()
        policy = policy_mod.from_dict({**POLICY, "block_ms": 200, "reclaim_min_idle_ms": 300})
        adapter = self.adapter(policy=policy, emit=pushed.put)
        consumer = threading.Thread(target=adapter.run, daemon=True)
        consumer.start()
        self.addCleanup(consumer.join, 3)
        self.addCleanup(adapter.stop)
        doc = envelope("telegram:evt:v1:7:42:7104")
        self.db.execute("XADD", STREAM, "*", "envelope", json.dumps(doc))

        first = pushed.get(timeout=5)["params"]["meta"]
        second = pushed.get(timeout=5)["params"]["meta"]
        self.assertEqual([(doc["id"], "1"), (doc["id"], "2")],
                         [(m["event_id"], m["attempt"]) for m in (first, second)])
        adapter.ack(doc["id"], "handled", "")
        with self.assertRaises(queue.Empty):  # acknowledged: nothing more to retry
            pushed.get(timeout=0.7)

    def test_a_notification_that_never_reached_claude_does_not_spend_an_attempt(self) -> None:
        """A stdio hiccup is not a delivery: the event has not been tried, so the
        durable counter is given back and the next attempt is still the first."""

        pushed: list[dict] = []
        broken = True

        def emit(message: dict) -> None:
            if broken:
                raise BrokenPipeError("stdout is gone")
            pushed.append(message)

        policy = policy_mod.from_dict({**POLICY, "max_attempts": 1})
        adapter = self.adapter(policy=policy, emit=emit)
        self.db.execute("XADD", STREAM, "*", "envelope", json.dumps(envelope("telegram:evt:v1:7:42:7007")))
        self.assertEqual(1, adapter.read_once(block_ms=100))
        self.assertEqual({}, adapter.inflight)  # the slot was released with the attempt
        self.assertEqual(b"0", self.db.execute(
            "GET", "mctl:events:state:attempt:claude-remote:telegram%3Aevt%3Av1%3A7%3A42%3A7007"))

        broken = False
        self.assertEqual(1, self.adapter(policy=policy, emit=emit).recover_pending())
        # Still attempt 1 under a cap of 1: the failed notification was refunded,
        # so the budget was not spent on a delivery Claude never saw.
        self.assertEqual(["1"], [message["params"]["meta"]["attempt"] for message in pushed])

    def test_reclaim_looks_past_a_page_full_of_this_consumers_own_entries(self) -> None:
        """Own entries are never taken over but still occupy rows of the pending
        list, so a backlog of them must not hide an abandoned entry behind it."""

        pushed: list[dict] = []
        broken = True

        def emit(message: dict) -> None:
            if broken:
                raise BrokenPipeError("stdout is gone")
            pushed.append(message)

        policy = policy_mod.from_dict({**POLICY, "reclaim_min_idle_ms": 1})
        adapter = self.adapter(policy=policy, emit=emit)
        # A stdio outage leaves entries pending while capacity stays free, so
        # this consumer's own backlog grows past one XPENDING page.
        for index in range(PENDING_BATCH + 1):
            self.db.execute("XADD", STREAM, "*", "envelope",
                            json.dumps(envelope(f"telegram:evt:v1:7:42:9{index:03d}")))
        while adapter.read_once(block_ms=100):
            pass
        self.assertGreater(self.db.execute("XPENDING", STREAM, "claude-remote")[0], PENDING_BATCH)

        self.claim_as_ghost(envelope("telegram:evt:v1:7:42:7008"))  # newest, so last in id order
        time.sleep(0.05)
        broken = False

        self.assertEqual(1, adapter.reclaim())
        self.assertEqual(["telegram:evt:v1:7:42:7008"],
                         [message["params"]["meta"]["event_id"] for message in pushed])

    def test_reclaim_survives_an_entry_trimmed_out_of_the_stream(self) -> None:
        """An entry can be pending and gone at once, and carries nothing to deliver."""

        policy = policy_mod.from_dict({**POLICY, "reclaim_min_idle_ms": 1})
        adapter = self.adapter(policy=policy)
        doc = envelope("telegram:evt:v1:7:42:7006")
        self.claim_as_ghost(doc)
        entry = self.db.execute("XRANGE", STREAM, "-", "+")[0][0].decode()
        self.db.execute("XDEL", STREAM, entry)
        time.sleep(0.05)

        self.assertEqual(0, adapter.reclaim())  # nothing to deliver, and no crash
        # Valkey drops a deleted entry from the pending list as XCLAIM touches
        # it, so the takeover also clears what it could never have delivered.
        self.assertEqual(0, self.db.execute("XPENDING", STREAM, "claude-remote")[0])

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
