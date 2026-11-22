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
        self.token = self.root / "gh-token"
        self.token.write_text("fake-installation-token\n")
        # Per-tick behaviour comes from files "<n>.rc/.err/.out" next to the fake.
        executable(self.bin / "claude", textwrap.dedent(f"""\
            #!/bin/sh
            n=$(cat "{self.root}/n")
            env > "{self.root}/env.$n"
            printf '%s\\n' "$@" > "{self.root}/argv.$n"
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
                "TICKS": str(ticks), "GH_APP_TOKEN_FILE": str(self.token), "PR_STEWARD_CONFIG": str(self.root / "none.json"), **env}
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

    # The tick runs in dontAsk and cannot read the token file or export anything,
    # so the scheduler hands it the token (SKILL.md section 2).
    def tick_env(self, n: int = 1) -> dict[str, str]:
        text = (self.root / f"env.{n}").read_text()
        return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)

    def test_token_reaches_the_tick_environment_but_never_its_command_line(self) -> None:
        self.tick(1)
        log = self.run_loop(1)
        env = self.tick_env()
        self.assertEqual("fake-installation-token", env["GH_TOKEN"])
        self.assertNotIn("fake-installation-token", (self.root / "argv.1").read_text())
        self.assertNotIn("fake-installation-token", log)
        self.assertRegex(env["PR_STEWARD_TICK_ID"], r"^\d{8}T\d{6}Z$")
        self.assertNotIn("GH_ENTERPRISE_TOKEN", env)

    def test_git_credential_helper_rereads_the_file_and_carries_no_token(self) -> None:
        self.tick(1)
        self.run_loop(1)
        env = self.tick_env()
        self.assertEqual("1", env["GIT_CONFIG_COUNT"])
        self.assertEqual("credential.https://github.com.helper", env["GIT_CONFIG_KEY_0"])
        self.assertIn(str(self.token), env["GIT_CONFIG_VALUE_0"])
        self.assertNotIn("fake-installation-token", env["GIT_CONFIG_VALUE_0"])

    def test_a_ghes_host_gets_the_enterprise_token_variable(self) -> None:
        self.tick(1)
        self.run_loop(1, GH_HOST="git.example.com")
        env = self.tick_env()
        self.assertEqual("fake-installation-token", env["GH_ENTERPRISE_TOKEN"])
        self.assertNotIn("GH_TOKEN", env)
        self.assertEqual("credential.https://git.example.com.helper", env["GIT_CONFIG_KEY_0"])

    def test_missing_or_empty_token_is_logged_loudly_and_no_tick_fires(self) -> None:
        for content in (None, "", "\n"):
            with self.subTest(content=content):
                (self.root / "n").unlink(missing_ok=True)
                (self.root / "env.1").unlink(missing_ok=True)
                if content is None:
                    self.token.unlink(missing_ok=True)
                else:
                    self.token.write_text(content)
                self.tick(1)
                log = self.run_loop(1)
                self.assertIn("result=auth_error reason=token_missing", log)
                self.assertIn("tick NOT fired", log)
                self.assertFalse((self.root / "env.1").exists())

    def test_rotated_token_is_picked_up_on_the_next_tick(self) -> None:
        self.tick(1)
        self.tick(2)
        # the fake sleep runs before each tick; rotate between them via the fake claude
        (self.bin / "claude").write_text((self.bin / "claude").read_text().replace(
            "exit $(cat", f'echo rotated-token > "{self.token}"\nexit $(cat', 1))
        self.run_loop(2)
        self.assertEqual("fake-installation-token", self.tick_env(1)["GH_TOKEN"])
        self.assertEqual("rotated-token", self.tick_env(2)["GH_TOKEN"])

    def allowed(self, n: int = 1) -> list[str]:
        argv = (self.root / f"argv.{n}").read_text().splitlines()
        return argv[argv.index("--allowedTools") + 1:]

    def test_watch_script_adds_exactly_one_rule_and_a_bad_path_adds_none(self) -> None:
        self.tick(1)
        self.run_loop(1, PR_STEWARD_WATCH_SCRIPT="/workspace/.claude/skills/codex-watch/launch.sh")
        self.assertIn("Bash(/workspace/.claude/skills/codex-watch/launch.sh:*)", self.allowed())
        for bad in ("relative/launch.sh", "/x/launch.sh;rm", "/x/a b"):
            with self.subTest(bad=bad):
                (self.root / "n").unlink()
                self.run_loop(1, PR_STEWARD_WATCH_SCRIPT=bad)
                self.assertFalse([r for r in self.allowed() if "launch" in r or "relative" in r or "a b" in r])


if __name__ == "__main__":
    unittest.main()
