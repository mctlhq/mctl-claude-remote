"""The pr-steward scheduler loop escalates an auth-lost tick (#64 item 1).

The shipped text (tg_send plus the scheduler block) is cut out of entrypoint.sh
and run under /bin/sh with a fake `claude`, `curl`, `sleep` and precheck, so no
Telegram or network call is made. The fake `sleep` ends the loop after the
requested number of ticks by killing its parent (the loop subshell).
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

ENTRYPOINT = Path(__file__).resolve().parents[2] / "entrypoint.sh"
FIRST = "tg_send() {"
LAST = "# ── Session rotation"


def block() -> str:
    lines = ENTRYPOINT.read_text(encoding="utf-8").splitlines()
    start = lines.index(FIRST)
    end = next(i for i in range(start, len(lines)) if lines[i].startswith(LAST))
    return "\n".join(lines[start:end]) + "\n"


def executable(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


class AuthEscalationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="steward-auth-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.logdir = self.root / "log"
        self.logdir.mkdir()
        self.bin = self.root / "bin"
        self.sends = self.root / "sends"
        self.ts = self.logdir / "auth-alert-ts"
        executable(self.bin / "curl", f'#!/bin/sh\nfor a; do case "$a" in text=*) echo "$a" >> "{self.sends}";; esac; done\n'
                   # Like the real curl, an HTTP error only fails the call under --fail.
                   '[ "${FAKE_CURL:-ok}" = network ] && exit 7\n'
                   'if [ "${FAKE_CURL:-ok}" = http_error ]; then for a; do [ "$a" = --fail ] && exit 22; done; fi\nexit 0\n')
        # Ends the loop after $TICKS sleeps by killing the loop subshell.
        executable(self.bin / "sleep", f'#!/bin/sh\nn=$(cat "{self.root}/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "{self.root}/n"\n'
                   '[ "$n" -gt "$TICKS" ] && kill -9 $PPID\nexit 0\n')
        executable(self.bin / "timeout", '#!/bin/sh\nshift\nexec "$@"\n')  # not on a Mac
        executable(self.root / "precheck", "#!/bin/sh\nexit 0\n")
        # Per-tick behaviour comes from files "<n>.rc/.err/.out" next to the fake.
        executable(self.bin / "claude", textwrap.dedent(f"""\
            #!/bin/sh
            n=$(cat "{self.root}/n")
            [ -f "{self.root}/$n.out" ] && cat "{self.root}/$n.out"
            [ -f "{self.root}/$n.err" ] && cat "{self.root}/$n.err" >&2
            exit $(cat "{self.root}/$n.rc" 2>/dev/null || echo 0)
            """))

    def tick(self, n: int, rc: int = 0, err: str = "", out: str = "") -> None:
        (self.root / f"{n}.rc").write_text(str(rc))
        (self.root / f"{n}.err").write_text(err)
        (self.root / f"{n}.out").write_text(out)

    def run_loop(self, ticks: int, **env: str) -> str:
        script = block().replace("/opt/steward/bin/pr-steward-precheck", str(self.root / "precheck")) \
            .replace("/var/log/steward", str(self.logdir))
        script = f'DEVICE_NAME=dev\nPATH="{self.bin}:$PATH"\n' + script + "\nwait\n"
        full = {**os.environ, "PR_STEWARD_ENABLED": "true", "PR_STEWARD_SCHEDULE_SECONDS": "1",
                "TELEGRAM_BOT_TOKEN": "tok", "STARTUP_WEDGE_ALERT_CHAT_ID": "42",
                "TICKS": str(ticks), "PR_STEWARD_CONFIG": str(self.root / "none.json"), **env}
        subprocess.run(["/bin/sh", "-c", script], env=full, capture_output=True, text=True, timeout=60)
        return (self.logdir / "scheduler.log").read_text()

    def sent(self) -> list[str]:
        return self.sends.read_text().splitlines() if self.sends.exists() else []

    def test_auth_loss_in_stderr_sends_one_alert_then_suppresses(self) -> None:
        for n in (1, 2, 3):
            self.tick(n, rc=1, err="Failed to authenticate. API Error: 401\n")
        log = self.run_loop(3)
        self.assertEqual(1, len(self.sent()), self.sent())
        self.assertIn("auth lost", self.sent()[0])
        self.assertTrue(self.ts.exists())
        self.assertIn("Failed to authenticate", log)  # stderr still reaches the log
        self.assertIn("Claude auth lost", log)

    def test_each_specified_pattern_is_an_auth_loss_in_either_stream(self) -> None:
        for i, (where, text) in enumerate([("err", "OAuth session expired"), ("err", "Not logged in"),
                                           ("out", '{"result":"Not logged in"}'),
                                           ("out", "Failed to authenticate")]):
            with self.subTest(text=text, where=where):
                self.sends.unlink(missing_ok=True)
                self.ts.unlink(missing_ok=True)
                (self.root / "n").unlink(missing_ok=True)
                self.tick(1, rc=1, **{where: text})
                self.run_loop(1)
                self.assertEqual(1, len(self.sent()))

    def test_reminder_after_interval(self) -> None:
        self.ts.write_text(str(int(time.time()) - 7200))
        self.tick(1, rc=1, err="Not logged in")
        self.run_loop(1, PR_STEWARD_AUTH_REMINDER_SECONDS="3600")
        self.assertEqual(1, len(self.sent()))
        self.assertIn("reminder", self.sent()[0])
        self.assertGreater(int(self.ts.read_text()), time.time() - 60)

    def test_no_reminder_inside_interval(self) -> None:
        recent = str(int(time.time()) - 100)
        self.ts.write_text(recent)
        self.tick(1, rc=1, err="Not logged in")
        self.run_loop(1, PR_STEWARD_AUTH_REMINDER_SECONDS="3600")
        self.assertEqual([], self.sent())
        self.assertEqual(recent, self.ts.read_text())

    def test_invalid_interval_falls_back_to_six_hours(self) -> None:
        for bad in ("abc", "0", "-5", ""):
            with self.subTest(bad=bad):
                self.sends.unlink(missing_ok=True)
                (self.root / "n").unlink(missing_ok=True)
                self.ts.write_text(str(int(time.time()) - 3600))  # 1h: inside 6h, past any junk-derived 0/1s
                self.tick(1, rc=1, err="Not logged in")
                self.run_loop(1, PR_STEWARD_AUTH_REMINDER_SECONDS=bad)
                self.assertEqual([], self.sent())
        self.ts.write_text(str(int(time.time()) - 22000))  # past 6h
        (self.root / "n").unlink()
        self.run_loop(1, PR_STEWARD_AUTH_REMINDER_SECONDS="abc")
        self.assertEqual(1, len(self.sent()))

    def test_success_clears_backoff_so_next_loss_alerts_at_once(self) -> None:
        self.tick(1, rc=1, err="Not logged in")
        self.tick(2, rc=0)
        self.tick(3, rc=1, err="Not logged in")
        self.run_loop(3)
        self.assertEqual(2, len(self.sent()))

    def test_unrelated_failure_neither_alerts_nor_resets_backoff(self) -> None:
        self.tick(1, rc=1, err="Not logged in")
        self.tick(2, rc=124, err="some other crash")
        self.tick(3, rc=1, err="Not logged in")
        log = self.run_loop(3)
        self.assertEqual(1, len(self.sent()))  # tick 3 still inside the backoff
        self.assertIn("tick exited non-zero", log)

    def test_auth_text_on_a_successful_tick_is_ignored(self) -> None:
        self.tick(1, rc=0, err="Not logged in", out='{"result":"docs mention Not logged in"}')
        self.run_loop(1)
        self.assertEqual([], self.sent())

    def test_stale_result_file_from_an_earlier_run_is_not_classified(self) -> None:
        (self.logdir / "tick-result.json").write_text("Not logged in")
        (self.logdir / "tick-stderr.log").write_text("Not logged in")
        self.tick(1, rc=1, err="unrelated")
        self.run_loop(1)
        self.assertEqual([], self.sent())

    def test_failed_send_is_not_recorded_so_next_tick_retries(self) -> None:
        self.tick(1, rc=1, err="Not logged in")
        self.run_loop(1, FAKE_CURL="network")
        self.assertFalse(self.ts.exists())

    def test_telegram_http_error_is_not_recorded_so_next_tick_retries(self) -> None:
        self.tick(1, rc=1, err="Not logged in")
        self.run_loop(1, FAKE_CURL="http_error")
        self.assertFalse(self.ts.exists())

    def test_temp_files_are_cleaned_up(self) -> None:
        self.tick(1, rc=1, err="Not logged in")
        self.run_loop(1)
        self.assertFalse((self.logdir / "tick-stderr.log").exists())
        self.assertFalse((self.logdir / "tick-result.json").exists())


if __name__ == "__main__":
    unittest.main()
