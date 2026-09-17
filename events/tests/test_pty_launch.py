from __future__ import annotations

import importlib.machinery
import importlib.util
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

LAUNCHER = Path(__file__).resolve().parents[2] / "bin" / "claude-pty-launch"
_loader = importlib.machinery.SourceFileLoader("claude_pty_launch", str(LAUNCHER))
_spec = importlib.util.spec_from_loader("claude_pty_launch", _loader)
launch = importlib.util.module_from_spec(_spec)
_loader.exec_module(launch)


class AnswerForTest(unittest.TestCase):
    def test_matches_dialog_text_drawn_with_cursor_moves(self) -> None:
        # The TUI positions each word with escape sequences, so there are no spaces.
        screen = b"\x1b[3;5HI\x1b[3;7Ham\x1b[3;10Husing\x1b[3;16Hthis\x1b[3;21Hfor\x1b[3;25Hlocal\x1b[3;31Hdevelopment"
        self.assertEqual(("development-channels", b"\r"), launch.answer_for(screen, {}))

    def test_same_dialog_on_screen_is_answered_once(self) -> None:
        answered: dict[str, int] = {}
        screen = b"Yes, I trust this folder"
        self.assertIsNotNone(launch.answer_for(screen, answered))
        self.assertIsNone(launch.answer_for(screen, answered))

    def test_unknown_prompt_is_left_alone(self) -> None:
        self.assertIsNone(launch.answer_for(b"Do you want to delete everything? (y/n)", {}))


class LauncherProcessTest(unittest.TestCase):
    def test_answers_dialog_and_propagates_exit_status(self) -> None:
        fake = textwrap.dedent(
            """
            import sys
            print("I am using this for local development", flush=True)
            line = sys.stdin.readline()
            print("got-enter" if line == "\\n" else "got:" + repr(line), flush=True)
            sys.exit(7)
            """
        )
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "fake_claude.py"
            script.write_text(fake)
            proc = subprocess.run(
                [sys.executable, str(LAUNCHER), "--", sys.executable, str(script)],
                capture_output=True, timeout=30,
                env={**os.environ, "CLAUDE_PTY_ANSWER_DELAY_SECONDS": "0.1"},
            )
        self.assertEqual(7, proc.returncode, proc.stderr)
        self.assertIn(b"got-enter", proc.stdout)
        self.assertIn(b"answered development-channels", proc.stderr)


class LauncherArrowKeyTest(unittest.TestCase):
    def test_down_enter_reaches_the_child_for_a_default_no_dialog(self) -> None:
        fake = textwrap.dedent(
            """
            import sys, termios, tty
            print("1. No, exit   2. Yes, I trust this folder", flush=True)
            tty.setcbreak(sys.stdin.fileno())
            keys = sys.stdin.read(4)
            print("keys:" + keys.encode().hex(), flush=True)
            """
        )
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "fake_trust.py"
            script.write_text(fake)
            proc = subprocess.run(
                [sys.executable, str(LAUNCHER), "--", sys.executable, str(script)],
                capture_output=True, timeout=30,
                env={**os.environ, "CLAUDE_PTY_ANSWER_DELAY_SECONDS": "0.1"},
            )
        self.assertEqual(0, proc.returncode, proc.stderr)
        # ESC [ B then CR (cbreak keeps ICRNL, so CR arrives as LF).
        self.assertIn(b"keys:1b5b420a", proc.stdout)
        self.assertIn(b"answered trust-folder", proc.stderr)


if __name__ == "__main__":
    unittest.main()
