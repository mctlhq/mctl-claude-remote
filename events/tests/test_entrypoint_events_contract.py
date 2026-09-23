"""The entrypoint's managed mctl-events section in CLAUDE.md, run under /bin/sh -e.

`ensure_events_contract` and the `write_json_atomic` helper it uses are cut out
of entrypoint.sh by their first and last lines and executed against a scratch
CLAUDE.md, so the test exercises the shipped text. `/bin/sh` is dash on the
image and on the CI runner.
"""

from __future__ import annotations

import os
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
    return (function("write_json_atomic() {  # $1 = destination, stdin = content; leaves $1 alone on failure", "}")
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
        self.assertIn("no end marker", out)
        self.assertEqual(original, self.content())

    def test_absent_removes_the_section_and_keeps_the_rest(self) -> None:
        self.md.write_text("# top\n\nkeep me\n")
        self.run_fn("present")
        out = self.run_fn("absent")
        self.assertIn("absent, written", out)
        self.assertEqual("# top\n\nkeep me\n", self.content())
        self.assertIn("absent, current", self.run_fn("absent"))

    def test_absent_with_no_file_and_with_a_file_that_held_only_the_section(self) -> None:
        self.assertNotIn("WARN", self.run_fn("absent"))
        self.assertFalse(self.md.exists())
        self.run_fn("present")
        out = self.run_fn("absent")
        self.assertIn("deleted", out)
        self.assertFalse(self.md.exists())

    def test_unwritable_directory_is_a_warning_not_an_abort(self) -> None:
        self.md.write_text("# top\n")
        os.chmod(self.root, 0o555)
        self.addCleanup(os.chmod, self.root, 0o755)
        if os.access(self.root, os.W_OK):
            self.skipTest("running as root: directory permissions are not enforced")
        out = self.run_fn()
        self.assertIn("WARN could not write", out)
        self.assertEqual("# top\n", self.content())


if __name__ == "__main__":
    unittest.main()
