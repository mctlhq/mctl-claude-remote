"""bin/pr-steward-usage: a steward tick's result entry -> ADR-012 usage records
(mctlhq/.github#50), and the scheduler wiring that runs it.

The converter is loaded from the shipped file, and the dispatch path runs it as
a subprocess against a fake `gh`, so the token handling is exercised for real.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "bin" / "pr-steward-usage"
ENTRYPOINT = ROOT / "entrypoint.sh"


def load():
    loader = importlib.machinery.SourceFileLoader("pr_steward_usage", str(SCRIPT))
    spec = importlib.util.spec_from_loader("pr_steward_usage", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


usage = load()

RESULT = {
    "type": "result",
    "subtype": "success",
    "is_error": False,
    "session_id": "sess-1",
    "uuid": "res-1",
    "num_turns": 12,
    "duration_api_ms": 34000,
    "stop_reason": "end_turn",
    "result": "PROSE THAT MUST NOT LEAK",
    "total_cost_usd": 1.23,
    "modelUsage": {
        "claude-sonnet-5-5": {
            "inputTokens": 100,
            "outputTokens": 20,
            "cacheReadInputTokens": 3000,
            "cacheCreationInputTokens": 400,
            "costUSD": 1.2,
        },
        "claude-haiku-4-5": {"inputTokens": 7, "outputTokens": 1},
    },
}
REPOS = {"mctlhq/mctl-telegram", "mctlhq/mctl-design"}


def line(repo, pr, action="address-review"):
    return json.dumps({"ts": "t", "tick_id": "x", "repo": repo, "pr": pr, "action": action})


class BuildRecordsTest(unittest.TestCase):
    def test_one_record_per_model_with_the_adr012_shape(self):
        records = usage.build_records(RESULT, ("mctlhq/mctl-telegram", 725), "2026-10-01T00:00:00Z")
        self.assertEqual([r["model_key"] for r in records], ["claude-sonnet-5-5", "claude-haiku-4-5"])
        sonnet = records[0]
        self.assertEqual(sonnet["agent"], "pr-steward")
        self.assertEqual(sonnet["devloop_stage"], "shepherd")
        self.assertEqual(sonnet["session_id"], "sess-1")
        self.assertEqual(sonnet["result_uuid"], "res-1")
        self.assertEqual(sonnet["target_repo"], "mctlhq/mctl-telegram")
        self.assertEqual(sonnet["pr_number"], 725)
        self.assertEqual(sonnet["input_tokens"], 100)
        self.assertEqual(sonnet["output_tokens"], 20)
        self.assertEqual(sonnet["cache_read_tokens"], 3000)
        self.assertEqual(sonnet["cache_write_tokens"], 400)
        self.assertEqual(sonnet["retry_attempt"], 0)
        self.assertEqual(sonnet["outcome"], "success")
        self.assertEqual(sonnet["schema_version"], 1)

    def test_no_text_cost_or_invented_correlation(self):
        records = usage.build_records(RESULT, None, "2026-10-01T00:00:00Z")
        blob = json.dumps(records)
        self.assertNotIn("PROSE", blob)
        for record in records:
            for absent in ("calculated_cost", "pricing_version", "provider_reported_cost", "id",
                           "work_item_id", "temporal_workflow_id", "temporal_run_id",
                           "target_repo", "pr_number"):
                self.assertNotIn(absent, record)

    def test_an_unreported_counter_stays_absent(self):
        haiku = usage.build_records(RESULT, None, "t")[1]
        self.assertNotIn("cache_read_tokens", haiku)
        self.assertNotIn("web_search_requests", haiku)

    def test_error_outcome_and_no_session_means_no_records(self):
        failed = dict(RESULT, subtype="error_max_turns", is_error=True)
        self.assertEqual(usage.build_records(failed, None, "t")[0]["outcome"], "error")
        self.assertEqual(usage.build_records(dict(RESULT, session_id=""), None, "t"), [])


class AttributionTest(unittest.TestCase):
    def test_exactly_one_configured_pr_is_attributed(self):
        tail = "\n".join([line("mctlhq/mctl-telegram", 725), line("mctlhq/mctl-telegram", 725, "merge")])
        self.assertEqual(usage.acted_pr(tail, REPOS), ("mctlhq/mctl-telegram", 725))

    def test_two_prs_attribute_nothing(self):
        tail = "\n".join([line("mctlhq/mctl-telegram", 725), line("mctlhq/mctl-design", 9)])
        self.assertIsNone(usage.acted_pr(tail, REPOS))

    def test_unconfigured_repo_and_garbage_are_ignored(self):
        tail = "\n".join(["not json", line("evil/repo", 1), line("mctlhq/mctl-telegram", 0),
                          line("mctlhq/mctl-telegram", True), line("mctlhq/mctl-design", 4)])
        self.assertEqual(usage.acted_pr(tail, REPOS), ("mctlhq/mctl-design", 4))
        self.assertIsNone(usage.acted_pr("", REPOS))

    def test_result_entry_accepts_object_and_stream_forms(self):
        self.assertEqual(usage.result_entry(json.dumps(RESULT))["uuid"], "res-1")
        stream = json.dumps([{"type": "system"}, dict(RESULT, uuid="a"), dict(RESULT, uuid="b")])
        self.assertEqual(usage.result_entry(stream)["uuid"], "b")
        self.assertIsNone(usage.result_entry("timeout, no output"))
        self.assertIsNone(usage.result_entry(json.dumps({"type": "assistant"})))


class EndToEndTest(unittest.TestCase):
    """Runs the shipped script with a fake `gh` that records what it was given."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="steward-usage-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        bindir = self.root / "bin"
        bindir.mkdir()
        fake = bindir / "gh"
        fake.write_text(
            "#!/bin/sh\n"
            f'printf "%s\\n" "$*" > "{self.root}/argv"\n'
            f'printf "%s" "$GH_TOKEN" > "{self.root}/token-seen"\n'
            f'cat > "{self.root}/stdin"\n'
            'exit "${FAKE_GH_EXIT:-0}"\n'
        )
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        self.env = dict(os.environ, PATH=f"{bindir}{os.pathsep}{os.environ['PATH']}")
        self.token = self.root / "gh-token"
        self.token.write_text("ghs_SECRETVALUE\n")
        self.log = self.root / "steward.log"
        self.log.write_text(line("mctlhq/mctl-design", 3) + "\n")
        self.offset = self.log.stat().st_size
        with self.log.open("a") as fh:
            fh.write(line("mctlhq/mctl-telegram", 725) + "\n")
        self.config = self.root / "config.json"
        self.config.write_text(json.dumps({
            "repos": [{"name": n} for n in sorted(REPOS)],
            "logging": {"file": str(self.log)},
        }))
        self.result = self.root / "result.json"
        self.result.write_text(json.dumps(RESULT))

    def run_script(self, *extra, env=None):
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--result", str(self.result), "--config", str(self.config),
             "--log-offset", str(self.offset), "--token-file", str(self.token), *extra],
            env=env or self.env, capture_output=True, text=True, timeout=30, check=False,
        )

    def test_dispatches_records_with_the_token_only_in_env(self):
        proc = self.run_script()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        argv = (self.root / "argv").read_text()
        self.assertIn("repos/mctlhq/.github/dispatches", argv)
        self.assertNotIn("SECRETVALUE", argv)
        self.assertNotIn("SECRETVALUE", proc.stdout + proc.stderr)
        self.assertEqual((self.root / "token-seen").read_text(), "ghs_SECRETVALUE")
        body = json.loads((self.root / "stdin").read_text())
        self.assertEqual(body["event_type"], "pr-steward-usage")
        records = body["client_payload"]["records"]
        self.assertEqual(len(records), 2)
        # Only the line written after the offset counts: one PR, attributed.
        self.assertEqual({(r["target_repo"], r["pr_number"]) for r in records}, {("mctlhq/mctl-telegram", 725)})

    def test_never_fails_the_tick(self):
        failing = dict(self.env, FAKE_GH_EXIT="1")
        self.assertEqual(self.run_script(env=failing).returncode, 0)
        (self.root / "argv").unlink()
        self.result.write_text("")
        proc = self.run_script()
        self.assertEqual(proc.returncode, 0)
        self.assertIn("NOT measured", proc.stderr)
        self.assertFalse((self.root / "argv").exists())

    def test_missing_token_sends_nothing(self):
        self.token.unlink()
        proc = self.run_script()
        self.assertEqual(proc.returncode, 0)
        self.assertFalse((self.root / "argv").exists())
        self.assertIn("not sent", proc.stderr)


class SchedulerWiringTest(unittest.TestCase):
    def test_tick_captures_json_and_runs_the_converter(self):
        text = ENTRYPOINT.read_text(encoding="utf-8")
        tick = text[text.index('"$STEWARD_CLAUDE_BIN" -p "Run the pr-steward skill"'):]
        tick = tick[:tick.index("done")]
        self.assertIn("--output-format json", tick)
        self.assertIn('>"$STEWARD_RESULT"', tick)
        self.assertIn('"$STEWARD_USAGE" --result "$STEWARD_RESULT"', tick)
        self.assertIn("|| true", tick[tick.index('"$STEWARD_USAGE"'):])
        self.assertIn("STEWARD_USAGE=/opt/steward/bin/pr-steward-usage", text)


if __name__ == "__main__":
    unittest.main()
