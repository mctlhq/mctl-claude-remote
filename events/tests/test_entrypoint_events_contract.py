"""The entrypoint's managed mctl-events section in CLAUDE.md, run under /bin/sh -e.

`ensure_events_contract` and the `write_json_atomic` helper it uses are cut out
of entrypoint.sh by their first and last lines and executed against a scratch
CLAUDE.md, so the test exercises the shipped text. `/bin/sh` is dash on the
image and on the CI runner.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ENTRYPOINT = Path(__file__).resolve().parents[2] / "entrypoint.sh"
BEGIN = "<!-- mctl-events:begin (managed by the entrypoint; edits inside are overwritten) -->"
END = "<!-- mctl-events:end -->"


def function(first: str, last: str) -> str:
    lines = ENTRYPOINT.read_text(encoding="utf-8").splitlines()
    start = lines.index(first)
    end = next(i for i in range(start, len(lines)) if lines[i] == last)
    return "\n".join(lines[start:end + 1]) + "\n"


def shell_source() -> str:
    return (function("write_json_atomic() {  # $1 = destination, $2 = mode for a NEW file (default 600), stdin = content; leaves $1 alone on failure", "}")
            + function("seed_claude_md() {  # $1 = destination (default /workspace/CLAUDE.md)", "}")
            + function('CLAUDE_MD="/workspace/CLAUDE.md"', "}"))


class EventsContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="events-contract-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.md = self.root / "CLAUDE.md"

    def run_fn(self, mode: str = "present") -> str:
        script = shell_source().replace("/workspace/CLAUDE.md", str(self.md))
        proc = subprocess.run(["/bin/sh", "-e", "-c", f"{script}\nensure_events_contract {mode}\necho rc=$?"],
                              capture_output=True, text=True, timeout=30)
        self.assertEqual(0, proc.returncode, proc.stdout + proc.stderr)
        self.assertIn("rc=0", proc.stdout)
        return proc.stdout + proc.stderr

    def content(self) -> str:
        return self.md.read_text(encoding="utf-8")

    def section_count(self) -> int:
        return self.content().count(BEGIN)

    def test_seeded_file_gets_the_section_appended_once(self) -> None:
        # Trailing blank lines in the operator's file do not accumulate.
        self.md.write_text("# Remote Worker Environment\n\noperator text\n\n\n")
        out = self.run_fn()
        self.assertIn("present, written", out)
        text = self.content()
        self.assertTrue(text.startswith("# Remote Worker Environment\n\noperator text\n\n" + BEGIN + "\n"), text)
        self.assertTrue(text.endswith(END + "\n"), text)
        self.assertIn("mcp__mctl-events__ack_event", text)

        again = self.run_fn()
        self.assertIn("present, current", again)
        self.assertEqual(text, self.content())

    def test_stale_section_in_the_middle_is_replaced_and_operator_text_kept(self) -> None:
        self.md.write_text(f"# top\n\n{BEGIN}\nOLD CONTRACT\n{END}\n\n## after\n\nkeep me\n")
        self.run_fn()
        text = self.content()
        self.assertNotIn("OLD CONTRACT", text)
        self.assertEqual(1, self.section_count())
        self.assertTrue(text.startswith("# top\n\n## after\n\nkeep me\n\n" + BEGIN), text)
        self.assertTrue(text.endswith(END + "\n"))
        before = text
        self.run_fn()
        self.assertEqual(before, self.content())

    def test_edits_inside_the_markers_are_overwritten_and_outside_survive(self) -> None:
        self.md.write_text("mine above\n")
        self.run_fn()
        self.md.write_text(self.content().replace("Keep the turn short", "HACKED") + "mine below\n")
        self.run_fn()
        text = self.content()
        self.assertNotIn("HACKED", text)
        self.assertIn("mine above\n", text)
        self.assertIn("mine below\n", text)
        self.assertTrue(text.endswith(END + "\n"))

    def test_missing_file_is_created_and_stays_identical(self) -> None:
        self.run_fn()
        self.assertTrue(self.content().startswith(BEGIN))
        self.assertEqual(0o644, self.md.stat().st_mode & 0o777)  # documentation, not a credential
        self.md.chmod(0o600)
        self.md.write_text(self.content() + "\nmine\n")
        self.run_fn()
        self.assertEqual(0o600, self.md.stat().st_mode & 0o777)  # an existing file keeps its mode
        self.assertEqual(1, self.content().count("\n" + BEGIN), self.content())
        first = self.content()
        for _ in range(3):
            self.run_fn()
        self.assertEqual(first, self.content())

    def test_directory_at_the_path_is_a_warning_not_a_write(self) -> None:
        self.md.mkdir()
        out = self.run_fn()
        self.assertIn("WARN", out)
        self.assertIn("not a regular file", out)
        self.assertEqual([], list(self.md.iterdir()))  # nothing moved INTO it

    def test_unterminated_section_leaves_the_file_untouched(self) -> None:
        original = f"# top\n\n{BEGIN}\nhalf a section, end marker lost\n\n## operator prose after it\n"
        self.md.write_text(original)
        out = self.run_fn()
        self.assertIn("do not alternate begin/end (1 begin, 0 end)", out)
        self.assertEqual(original, self.content())

    def test_unbalanced_markers_leave_the_file_untouched(self) -> None:
        """An orphaned begin marker before a real section would make the awk
        pass drop the prose between them; a stray end marker would eat a
        line of prose on every start; an end before a begin runs to EOF;
        a nested pair has equal counts and would still drop the prose
        between the two begin markers. All are repair-by-hand cases."""

        cases = {
            "orphan begin then a real section": (
                f"# top\n\n{BEGIN}\n\n## prose the orphan would swallow\n\n{BEGIN}\nbody\n{END}\n", "(2 begin, 1 end)"),
            "stray end marker in prose": (f"# top\n\n{END}\n\nkeep me\n", "(0 begin, 1 end)"),
            "end before begin": (f"# top\n\n{END}\n\nkeep me\n\n{BEGIN}\nbody\n", "(1 begin, 1 end)"),
            "nested pair, equal counts": (
                f"# top\n\n{BEGIN}\n\n## prose between the begins\n\n{BEGIN}\nbody\n{END}\n\ntail\n\n{END}\n\nmore\n", "(2 begin, 2 end)"),
        }
        for name, (original, expected) in cases.items():
            with self.subTest(name):
                self.md.write_text(original)
                out = self.run_fn()
                self.assertIn(expected, out)
                self.assertEqual(original, self.content())
                out = self.run_fn("absent")
                self.assertIn(expected, out)
                self.assertEqual(original, self.content())

    def test_two_complete_sections_collapse_into_one(self) -> None:
        """Equal counts are unambiguous (a restore that merged two copies):
        the file heals itself instead of freezing behind a WARN forever."""

        self.md.write_text(f"# top\n\n{BEGIN}\nold\n{END}\n\n## middle\n\n{BEGIN}\nolder\n{END}\n\ntail\n")
        out = self.run_fn()
        self.assertNotIn("WARN", out)
        text = self.content()
        self.assertEqual(1, self.section_count())
        self.assertNotIn("old\n", text)
        self.assertTrue(text.startswith("# top\n\n## middle\n\ntail\n\n" + BEGIN), text)
        self.assertEqual("# top\n\n## middle\n\ntail\n", (self.run_fn("absent"), self.content())[1])

    def test_outcome_vocabulary_matches_ack_event(self) -> None:
        """The heredoc is a copy of channel.py's INSTRUCTIONS for the model's
        eyes; teaching it an outcome `ack_event` rejects would fail every ack."""

        channel = (ENTRYPOINT.parent / "events/mctl_events/channel.py").read_text(encoding="utf-8")
        enum = re.search(r'"outcome": \{"type": "string", "enum": \[([^\]]+)\]\}', channel)
        self.assertIsNotNone(enum, "ack_event's outcome enum not found in channel.py")
        outcomes = re.findall(r'"([a-z]+)"', enum.group(1))
        self.assertEqual(sorted(outcomes), sorted(re.findall(r'"([a-z]+)"', re.search(
            r"if outcome not in \(([^)]+)\)", channel).group(1))), "channel.py disagrees with itself")
        self.run_fn()
        section = self.content()
        outcome_line = next(l for l in section.splitlines() if "`outcome`" in l)
        self.assertEqual(sorted(outcomes), sorted(re.findall(r"`([a-z]+)`", outcome_line.split("`outcome`", 1)[1])))
        self.assertTrue(re.search(r"outcome \(([^)]+)\)", channel), "INSTRUCTIONS no longer names the outcomes")
        self.assertEqual(sorted(outcomes),
                         sorted(re.findall(r"[a-z]+", re.search(r"outcome \(([^)]+)\)", channel).group(1))))

    def test_absent_removes_the_section_and_keeps_the_rest(self) -> None:
        self.md.write_text("# top\n\nkeep me\n")
        self.run_fn("present")
        out = self.run_fn("absent")
        self.assertIn("absent, written", out)
        self.assertEqual("# top\n\nkeep me\n", self.content())
        self.assertIn("absent, current", self.run_fn("absent"))

    def test_absent_with_no_file_and_with_a_file_that_held_only_the_section(self) -> None:
        """The seed has already run by the time the section is stripped, so a
        file holding nothing else is reseeded with the environment brief:
        neither no CLAUDE.md at all nor a contract for an unmounted tool."""

        self.assertNotIn("WARN", self.run_fn("absent"))
        self.assertFalse(self.md.exists())
        self.run_fn("present")
        out = self.run_fn("absent")
        self.assertIn("held nothing else and was reseeded", out)
        self.assertTrue(self.content().startswith("# Remote Worker Environment\n"), self.content()[:80])
        self.assertNotIn(BEGIN, self.content())
        self.assertEqual(0o644, self.md.stat().st_mode & 0o777)
        self.assertIn("absent, current", self.run_fn("absent"))

    def test_unwritable_directory_is_a_warning_not_an_abort(self) -> None:
        self.md.write_text("# top\n")
        os.chmod(self.root, 0o555)
        self.addCleanup(os.chmod, self.root, 0o755)
        if os.access(self.root, os.W_OK):
            self.skipTest("running as root: directory permissions are not enforced")
        out = self.run_fn()
        self.assertIn("WARN could not write", out)
        self.assertEqual("# top\n", self.content())

    def test_failed_reseed_keeps_the_stale_section_and_says_so(self) -> None:
        self.run_fn("present")
        section_only = self.content()
        os.chmod(self.root, 0o555)
        self.addCleanup(os.chmod, self.root, 0o755)
        if os.access(self.root, os.W_OK):
            self.skipTest("running as root: directory permissions are not enforced")
        out = self.run_fn("absent")
        self.assertIn("WARN could not reseed", out)
        self.assertEqual(section_only, self.content())  # stale, but present

    def test_reseed_writes_the_path_it_judged_not_a_hardcoded_one(self) -> None:
        """seed_claude_md defaults to /workspace/CLAUDE.md; the reseed must
        pass the path it inspected, which the test points elsewhere."""

        self.run_fn("present")
        script = shell_source().replace('CLAUDE_MD="/workspace/CLAUDE.md"', f'CLAUDE_MD="{self.md}"')
        decoy = self.root / "decoy"
        script = script.replace('"${1:-/workspace/CLAUDE.md}"', f'"${{1:-{decoy}}}"')
        proc = subprocess.run(["/bin/sh", "-e", "-c", f"{script}\nensure_events_contract absent"],
                              capture_output=True, text=True, timeout=30)
        self.assertEqual(0, proc.returncode, proc.stdout + proc.stderr)
        self.assertIn("was reseeded", proc.stdout)
        self.assertFalse(decoy.exists(), "reseed wrote the hardcoded default instead of $CLAUDE_MD")
        self.assertTrue(self.content().startswith("# Remote Worker Environment\n"))


if __name__ == "__main__":
    unittest.main()
