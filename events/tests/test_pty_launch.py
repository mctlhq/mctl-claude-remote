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
        self.assertEqual(("development-channels", b"\r"), launch.answer_for(screen, {}, 100.0, 5.0))

    def test_redraw_within_cooldown_is_ignored_and_a_later_prompt_is_answered(self) -> None:
        answered: dict[str, float] = {}
        screen = b"Yes, I trust this folder"
        self.assertIsNotNone(launch.answer_for(screen, answered, 100.0, 5.0))
        self.assertIsNone(launch.answer_for(screen, answered, 102.0, 5.0))
        self.assertEqual(("trust-folder", b"\x1b[B\r"), launch.answer_for(screen, answered, 106.0, 5.0))

    def test_unknown_prompt_is_left_alone(self) -> None:
        self.assertIsNone(launch.answer_for(b"Do you want to delete everything? (y/n)", {}, 100.0, 5.0))


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


class LauncherRepeatTest(unittest.TestCase):
    def test_the_same_dialog_shown_twice_is_answered_twice(self) -> None:
        fake = textwrap.dedent(
            """
            import sys, time
            for n in (1, 2):
                print("I am using this for local development", flush=True)
                line = sys.stdin.readline()
                print(f"answer{n}:" + ("enter" if line == "\\n" else repr(line)), flush=True)
                time.sleep(0.8)
            """
        )
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "fake_twice.py"
            script.write_text(fake)
            proc = subprocess.run(
                [sys.executable, str(LAUNCHER), "--", sys.executable, str(script)],
                capture_output=True, timeout=30,
                env={**os.environ, "CLAUDE_PTY_ANSWER_DELAY_SECONDS": "0.05",
                     "CLAUDE_PTY_ANSWER_COOLDOWN_SECONDS": "0.4"},
            )
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertIn(b"answer1:enter", proc.stdout)
        self.assertIn(b"answer2:enter", proc.stdout)
        self.assertEqual(2, proc.stderr.count(b"answered development-channels"))


if __name__ == "__main__":
    unittest.main()
