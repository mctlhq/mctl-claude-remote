"""bin/pr-steward-log: the one way a dontAsk steward tick writes its log."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "bin" / "pr-steward-log"


class StewardLogTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="steward-log-"))
        self.log = self.dir / "steward.log"
        self.config = self.dir / "config.json"
        self.config.write_text(json.dumps({"logging": {"file": str(self.log)}}))

    def run_log(self, *args: str, config: Path | None = None) -> subprocess.CompletedProcess:
        env = {**os.environ, "PR_STEWARD_CONFIG": str(config or self.config)}
        return subprocess.run([sys.executable, "-I", str(SCRIPT), *args], capture_output=True, text=True, env=env)

    def test_appends_one_line_and_echoes_it(self) -> None:
        line = '{"repo":"o/r","pr":7,"head_sha":"abc","action":"wait"}'
        self.assertEqual(0, self.run_log(line).returncode)
        proc = self.run_log(line)
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertEqual([line, line], self.log.read_text().splitlines())
        self.assertEqual(line, proc.stdout.strip())

    def test_tick_level_outcomes_are_accepted_but_need_a_tick_id_and_no_pr(self) -> None:
        for good in ('{"tick_id":"t1","action":"skip","reason":"locked"}',
                     '{"tick_id":"t1","result":"auth_error","reason":"token_missing"}'):
            with self.subTest(good=good):
                self.assertEqual(0, self.run_log(good).returncode)
        self.assertEqual(2, len(self.log.read_text().splitlines()))
        for bad in ('{"action":"skip"}', '{"tick_id":"","action":"skip"}', '{"tick_id":"t1"}',
                    '{"tick_id":"t1","action":"skip","pr":3}'):
            with self.subTest(bad=bad):
                self.assertEqual(2, self.run_log(bad).returncode)
        self.assertEqual(2, len(self.log.read_text().splitlines()))

    def test_token_looking_strings_are_redacted(self) -> None:
        self.run_log(json.dumps({"repo": "o/r", "pr": 1, "head_sha": "a", "reason": "ghs_AbC123 and sk-ant-xyz"}))
        text = self.log.read_text()
        self.assertNotIn("ghs_AbC123", text)
        self.assertNotIn("sk-ant-xyz", text)
        self.assertIn("***", text)

    def test_malformed_entries_are_rejected_and_nothing_is_written(self) -> None:
        for bad in ("not json", "[]", '{"repo":"o/r","pr":1}', '{"repo":"o/r","pr":"7","head_sha":"a"}',
                    '{"repo":"o/r","pr":true,"head_sha":"a"}', '{"repo":1,"pr":1,"head_sha":"a"}'):
            with self.subTest(bad=bad):
                self.assertEqual(2, self.run_log(bad).returncode)
        self.assertEqual(2, self.run_log().returncode)
        self.assertFalse(self.log.exists())

    def test_an_unconfigured_or_unwritable_log_fails_instead_of_pretending(self) -> None:
        line = '{"repo":"o/r","pr":1,"head_sha":"a"}'
        for cfg in ({}, {"logging": {}}, {"logging": {"file": str(self.dir / "no" / "dir" / "x.log")}}):
            with self.subTest(cfg=cfg):
                self.config.write_text(json.dumps(cfg))
                proc = self.run_log(line)
                self.assertEqual(1, proc.returncode)
                self.assertEqual("", proc.stdout)
        self.assertEqual(1, self.run_log(line, config=self.dir / "missing.json").returncode)


if __name__ == "__main__":
    unittest.main()
