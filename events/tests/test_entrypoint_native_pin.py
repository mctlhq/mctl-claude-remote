"""The entrypoint's native-claude block, run for real under /bin/sh -e.

The block is cut out of entrypoint.sh by its first and last line and executed
against a fake `claude` in a scratch workspace, so the test exercises the
shipped text, not a copy of it. `/bin/sh` is dash on the image and on the CI
runner; on a developer Mac it is bash in POSIX mode, which is close enough
for this block (no arrays, no pipefail).
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
BLOCK_FIRST = 'NATIVE_CLAUDE="/workspace/.local/bin/claude"'
BLOCK_LAST = "  echo \"[entrypoint] WARN native claude is"
PIN = "2.1.280 (Claude Code)"


def block() -> str:
    lines = ENTRYPOINT.read_text(encoding="utf-8").splitlines()
    start = lines.index(BLOCK_FIRST)
    end = next(i for i in range(start, len(lines)) if lines[i].startswith(BLOCK_LAST))
    # The WARN line is inside an if/else; take through the closing `fi`.
    end = next(i for i in range(end, len(lines)) if lines[i] == "fi")
    return "\n".join(lines[start:end + 1]) + "\n"


def executable(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def fake_version_binary(path: Path, version: str) -> None:
    executable(path, f'#!/bin/sh\necho "{version} (Claude Code)"\n')


class NativePinTest(unittest.TestCase):
    """One scenario per method; `run_block` returns (stdout+stderr, PATH, native version)."""

    def setUp(self) -> None:
        # Every probe in the block runs under the real GNU `timeout`; without it
        # no scenario means anything, so all of them skip together.
        if shutil.which("timeout") is None:
            self.skipTest("GNU timeout is not on PATH")
        self.root = Path(tempfile.mkdtemp(prefix="native-pin-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.ws = self.root / "ws"
        self.ws.mkdir()
        self.versions = self.ws / ".local/share/claude/versions"
        self.native = self.ws / ".local/bin/claude"
        # The npm-global claude: reports the pin; `install <ver>` only creates
        # versions/<ver>, which is what the real installer was seen to do with
        # a pre-existing regular file at ~/.local/bin/claude (#66).
        executable(self.root / "bin/claude", textwrap.dedent(f"""\
            #!/bin/sh
            case "$1" in
              --version)
                [ "${{FAKE_VERSION:-ok}}" = fail ] && {{ echo "cannot start" >&2; exit 1; }}
                [ "${{FAKE_VERSION:-ok}}" = blank ] && {{ echo "   "; exit 0; }}
                echo "{PIN}" ;;
              install)
                [ "${{FAKE_INSTALL:-ok}}" = fail ] && {{ echo "install failed"; exit 1; }}
                [ "${{FAKE_INSTALL:-ok}}" = hang ] && {{ echo "downloading..."; sleep 30; exit 0; }}
                [ "${{FAKE_INSTALL:-ok}}" = nofile ] && {{ echo "installed somewhere else"; exit 0; }}
                [ "${{FAKE_INSTALL:-ok}}" = custom ] && {{ mkdir -p "{self.versions}"; cp "{self.root}/candidate" "{self.versions}/$2"; chmod +x "{self.versions}/$2"; exit 0; }}
                [ "${{FAKE_INSTALL:-ok}}" = selfupdate ] && {{ cp "{self.root}/candidate" "{self.native}"; chmod +x "{self.native}"; exit 0; }}
                mkdir -p "{self.versions}"
                v="$2"; [ "${{FAKE_INSTALL:-ok}}" = corrupt ] && v="9.9.9"
                printf '#!/bin/sh\\necho "%s (Claude Code)"\\n' "$v" > "{self.versions}/$2"
                chmod +x "{self.versions}/$2"
                echo "  Next: Run claude --help to get started" ;;
            esac
            """))

    def run_block(self, install: str = "ok", version: str = "ok", timeout_env: str = "2",
                  version_timeout: str | None = "10", outer: int = 30, env_extra: dict | None = None,
                  read_native: bool = True) -> tuple[str, str, str]:
        """`version_timeout=None` leaves NATIVE_VERSION_TIMEOUT unset (the default).
        `outer` bounds the whole shell, so a broken guard fails the test promptly.
        `read_native=False` skips running the native binary afterwards (it hangs)."""

        self.tmp = self.root / "tmp"
        self.tmp.mkdir(exist_ok=True)
        script = (block().replace("/workspace", str(self.ws))
                  .replace("/tmp/claude-install.", f"{self.tmp}/claude-install.")
                  .replace("/tmp/claude-version.", f"{self.tmp}/claude-version."))
        # Fail closed: if the script text changes and a substitution stops
        # matching, the block would touch the real /workspace and /tmp.
        self.assertNotIn("/workspace", script)
        self.assertNotIn("/tmp/claude-", script.replace(str(self.tmp), ""))
        self.assertIn(f"{self.tmp}/claude-install.", script)
        self.assertIn(f"{self.tmp}/claude-version.", script)
        probe = 'printf "\\nPATH=%s\\n" "$PATH"'
        env = {**os.environ, "PATH": f"{self.root / 'bin'}:{os.environ['PATH']}",
               "FAKE_INSTALL": install, "FAKE_VERSION": version, "NATIVE_INSTALL_TIMEOUT": timeout_env}
        env.update(env_extra or {})
        env.pop("NATIVE_VERSION_TIMEOUT", None)
        if version_timeout is not None:
            env["NATIVE_VERSION_TIMEOUT"] = version_timeout
        proc = subprocess.run(["/bin/sh", "-e", "-c", script + probe], env=env,
                              capture_output=True, text=True, timeout=outer)
        self.assertEqual(0, proc.returncode, proc.stdout + proc.stderr)
        out = proc.stdout + proc.stderr
        path = proc.stdout.rsplit("PATH=", 1)[1].strip()
        native = subprocess.run([str(self.native), "--version"], capture_output=True, text=True).stdout.strip() \
            if read_native and self.native.is_file() else ""
        return out, path, native

    def test_fresh_workspace_installs_and_promotes_the_pin(self) -> None:
        """The ordinary first boot: no native binary, a working installer."""

        out, path, native = self.run_block()
        self.assertIn("native claude replaced with versions/2.1.280", out)
        self.assertTrue(self.native.is_file())
        self.assertEqual(PIN, native)
        self.assertTrue(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_stalled_install_is_cut_off_and_falls_back(self) -> None:
        """A download that never returns must not park PID 1; the timeout is
        a failed install like any other."""

        fake_version_binary(self.native, "2.1.274")
        started = time.monotonic()
        out, path, native = self.run_block(install="hang")
        self.assertLess(time.monotonic() - started, 20)
        self.assertIn("WARN native install failed", out)
        self.assertIn("using npm-global claude", out)
        self.assertEqual("2.1.274 (Claude Code)", native)
        self.assertFalse(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_invalid_install_timeout_falls_back_to_the_default(self) -> None:
        """`0` would disable the bound and a non-number makes `timeout` exit
        125 before the installer runs; both must become the 600s default."""

        # A recording `timeout` in front of the real one: logs its duration
        # argument, then runs the command unbounded (the fake install is quick).
        # Version probes (`timeout -k 2 N bin --version`) pass through unlogged.
        executable(self.root / "bin/timeout", '#!/bin/sh\n[ "$1" = -k ] && shift 2 && shift && exec "$@"\necho "$1" >> "' + str(self.root / "timeout-args") + '"\nshift\nexec "$@"\n')
        args = self.root / "timeout-args"
        for value in ("0", "abc", "-5", "1.5", ""):
            with self.subTest(value=value):
                args.unlink(missing_ok=True)
                shutil.rmtree(self.ws / ".local", ignore_errors=True)
                out, _, native = self.run_block(timeout_env=value)
                self.assertEqual(["600"], args.read_text().split(), value)
                self.assertIn("native claude replaced with versions/2.1.280", out)
                self.assertEqual(PIN, native)
        args.unlink(missing_ok=True)
        shutil.rmtree(self.ws / ".local", ignore_errors=True)
        self.run_block(timeout_env="7")
        self.assertEqual(["7"], args.read_text().split())  # a valid value is kept

    def test_blank_version_line_counts_as_no_pin(self) -> None:
        """A whitespace-only version line has no first field: every branch
        of the block must agree that there is no pin."""

        fake_version_binary(self.native, "2.1.274")
        out, path, _ = self.run_block(version="blank")
        self.assertIn("no pin to enforce; using native claude: 2.1.274 (Claude Code)", out)
        self.assertTrue(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_stale_native_is_replaced_by_the_installers_download(self) -> None:
        fake_version_binary(self.native, "2.1.274")
        out, path, native = self.run_block()
        self.assertIn("native claude replaced with versions/2.1.280", out)
        self.assertIn(f"using native claude: {PIN}", out)
        self.assertEqual(PIN, native)
        self.assertTrue(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_current_native_is_kept_without_an_install(self) -> None:
        fake_version_binary(self.native, "2.1.280")
        out, path, _ = self.run_block()
        self.assertIn("already current", out)
        self.assertNotIn("installing", out)
        self.assertTrue(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_download_of_the_wrong_version_is_not_used(self) -> None:
        fake_version_binary(self.native, "2.1.274")
        out, path, native = self.run_block(install="corrupt")
        self.assertNotIn("replaced", out)
        self.assertIn("WARN versions/2.1.280 reports '9.9.9 (Claude Code)', not 2.1.280; not promoting it", out)
        self.assertIn("WARN native claude is '2.1.274 (Claude Code)'", out)
        self.assertIn("using npm-global claude", out)
        self.assertEqual("2.1.274 (Claude Code)", native)  # left alone, not on PATH first
        self.assertFalse(path.startswith(f"{self.ws}/.local/bin:"), path)
        self.assertTrue(path.endswith(f":{self.ws}/.local/bin"), path)  # still reachable for other tools

    def test_failed_install_without_a_native_binary_falls_back(self) -> None:
        out, path, native = self.run_block(install="fail")
        self.assertIn("WARN native install failed", out)
        self.assertIn("using npm-global claude", out)
        self.assertEqual("", native)
        self.assertFalse(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_failed_install_with_a_stale_binary_falls_back(self) -> None:
        fake_version_binary(self.native, "2.1.274")
        out, path, native = self.run_block(install="fail")
        self.assertIn("WARN native install failed", out)
        self.assertIn("WARN no " + str(self.versions) + "/2.1.280 to promote\n", out)  # the fact, not a layout diagnosis
        self.assertNotIn("layout may have changed", out)
        self.assertIn("WARN native claude is '2.1.274 (Claude Code)'", out)
        self.assertEqual("2.1.274 (Claude Code)", native)
        self.assertFalse(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_replacement_failure_is_a_warning_not_an_abort(self) -> None:
        """A stale claude.tmp *directory* and an unwritable bin dir must end in
        the fallback, never in a non-zero entrypoint (set -e is on)."""

        fake_version_binary(self.native, "2.1.274")
        (self.ws / ".local/bin/claude.tmp").mkdir()
        os.chmod(self.ws / ".local/bin", 0o555)
        self.addCleanup(os.chmod, self.ws / ".local/bin", 0o755)
        if os.access(self.ws / ".local/bin", os.W_OK):
            self.skipTest("running as root: directory permissions are not enforced")
        out, path, native = self.run_block()
        self.assertIn("WARN could not replace native claude", out)
        self.assertIn("using npm-global claude", out)
        self.assertEqual("2.1.274 (Claude Code)", native)
        self.assertFalse(path.startswith(f"{self.ws}/.local/bin:"), path)


    def test_stale_tmp_directory_without_a_native_binary_is_cleared_first(self) -> None:
        """With no `claude` file, `cp` into a leftover claude.tmp directory and
        `mv` of that directory both exit 0, so the chain would report
        "replaced" while ~/.local/bin/claude had become a directory."""

        (self.ws / ".local/bin/claude.tmp").mkdir(parents=True)
        out, path, native = self.run_block()
        self.assertIn("native claude replaced with versions/2.1.280", out)
        self.assertTrue(self.native.is_file(), "native path must be the binary, not a directory")
        self.assertEqual(PIN, native)
        self.assertIn(f"using native claude: {PIN}", out)
        self.assertTrue(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_directory_at_the_native_path_is_refused_not_replaced(self) -> None:
        """`mv claude.tmp claude` with a directory at `claude` moves the file
        INTO it and exits 0; the chain must refuse instead of logging
        "replaced", and must not remove what the operator put there."""

        (self.native / "operator-file").parent.mkdir(parents=True)
        (self.native / "operator-file").write_text("mine\n")
        out, path, _ = self.run_block()
        self.assertIn(f"WARN {self.native} is a directory; refusing to replace it", out)
        self.assertNotIn("replaced", out)
        self.assertIn("using npm-global claude", out)
        self.assertTrue(self.native.is_dir())
        self.assertEqual(["operator-file"], [p.name for p in self.native.iterdir()])  # nothing moved into it
        self.assertFalse(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_native_build_with_a_longer_version_line_still_counts_as_the_pin(self) -> None:
        """Equality is on the version number, not the whole line."""

        executable(self.native, '#!/bin/sh\necho "2.1.280 (Claude Code, native)"\n')
        out, path, _ = self.run_block()
        self.assertIn("already current (2.1.280 (Claude Code, native))", out)
        self.assertIn("using native claude: 2.1.280 (Claude Code, native)", out)
        self.assertTrue(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_tab_separated_version_line_is_parsed_the_same_everywhere(self) -> None:
        """One first-field rule for the fast path, the promotion check and the
        gate: a tab after the number must not make the halves disagree."""

        executable(self.native, '#!/bin/sh\nprintf "2.1.280\\t(Claude Code)\\n"\n')
        out, path, _ = self.run_block()
        self.assertIn("already current", out)
        self.assertNotIn("WARN", out)
        self.assertTrue(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_install_that_leaves_no_versions_file_is_named_in_the_log(self) -> None:
        fake_version_binary(self.native, "2.1.274")
        out, path, native = self.run_block(install="nofile")
        self.assertIn("WARN install succeeded but left no " + str(self.versions) + "/2.1.280 to promote; the installer's layout may have changed", out)
        self.assertIn("using npm-global claude", out)
        self.assertEqual("2.1.274 (Claude Code)", native)
        self.assertFalse(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_no_image_pin_uses_a_native_binary_that_runs(self) -> None:
        """When the image's own claude cannot report a version there is no pin
        to enforce; a native binary that runs is the only way to start."""

        fake_version_binary(self.native, "2.1.274")
        out, path, native = self.run_block(version="fail")
        self.assertIn("installing/refreshing native claude binary (latest)", out)
        self.assertIn("no pin to enforce; using native claude: 2.1.274 (Claude Code)", out)
        self.assertEqual("2.1.274 (Claude Code)", native)
        self.assertTrue(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_no_image_pin_and_no_native_binary_falls_back_without_aborting(self) -> None:
        out, path, native = self.run_block(version="fail")
        self.assertIn("WARN native claude is '', image pins ''", out)
        self.assertEqual("", native)
        self.assertFalse(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_no_image_pin_and_a_native_binary_that_does_not_run_falls_back(self) -> None:
        """No pin is not a licence to put a broken native binary first."""

        executable(self.native, "#!/bin/sh\nexit 1\n")
        out, path, _ = self.run_block(version="fail")
        self.assertNotIn("no pin to enforce", out)
        self.assertIn("WARN native claude is '', image pins ''", out)
        self.assertFalse(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_install_log_never_follows_a_planted_symlink(self) -> None:
        """/tmp is a pod-scoped tmpfs that outlives the container: a fixed log
        name could be a symlink left by an earlier session, and `>` would
        truncate its target."""

        victim = self.root / "victim"
        victim.write_text("precious\n")
        (self.root / "tmp").mkdir(exist_ok=True)
        (self.root / "tmp/claude-install.log").symlink_to(victim)
        fake_version_binary(self.native, "2.1.274")
        out, _, native = self.run_block()
        self.assertEqual("precious\n", victim.read_text())
        self.assertEqual(PIN, native)
        self.assertIn("replaced", out)
        # And the log itself is cleaned up: only the planted symlink remains.
        self.assertEqual(["claude-install.log"], sorted(p.name for p in (self.root / "tmp").iterdir()))

    def test_non_directory_at_the_bin_path_is_a_warning_not_an_abort(self) -> None:
        """`mkdir -p ~/.local/bin` fails when a stale regular file sits there;
        under set -e that must not take the entrypoint down."""

        (self.ws / ".local").mkdir()
        (self.ws / ".local/bin").write_text("not a directory\n")
        out, path, native = self.run_block()
        self.assertIn("WARN could not replace native claude", out)
        self.assertIn("using npm-global claude", out)
        self.assertEqual("", native)
        self.assertFalse(path.startswith(f"{self.ws}/.local/bin:"), path)


    # --- `<native> --version` is bounded by NATIVE_VERSION_TIMEOUT (real GNU
    # `timeout`). A probe that hangs, fails or is blank is "no version" and takes
    # the existing reinstall/fallback path. Deadlines are 1-2 s and the outer
    # subprocess is bounded, so a broken guard fails in seconds.

    HANG = '#!/bin/sh\nsleep 60\necho "2.1.280 (Claude Code)"\n'
    # Ignores TERM and keeps the shell itself alive; only KILL ends it.
    STUBBORN = '#!/bin/sh\ntrap "" TERM\nwhile :; do sleep 1; done\n'

    def timed(self, **kw):
        # Ordinary stubs run with a generous 10 s deadline (a loaded runner must
        # not flake); only the scenarios that hang on purpose use this 1 s one.
        kw.setdefault("version_timeout", "1")
        started = time.monotonic()
        res = self.run_block(outer=20, **kw)
        return res, time.monotonic() - started

    def test_hanging_version_probe_is_cut_off_and_reinstalled(self) -> None:
        executable(self.native, self.HANG)
        (out, path, native), took = self.timed()
        self.assertLess(took, 12)
        self.assertNotIn("already current", out)
        self.assertIn("installing/refreshing native claude binary", out)
        self.assertIn("native claude replaced with versions/2.1.280", out)
        self.assertEqual(PIN, native)
        self.assertTrue(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_hanging_probe_with_a_failed_install_falls_back_not_aborts(self) -> None:
        executable(self.native, self.HANG)
        (out, path, _), took = self.timed(install="fail", read_native=False)
        self.assertLess(took, 15)
        self.assertIn("WARN native install failed", out)
        self.assertIn("WARN native claude is ''", out)  # no version was reported
        self.assertIn("using npm-global claude", out)
        self.assertFalse(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_probe_that_ignores_term_is_killed(self) -> None:
        executable(self.native, self.STUBBORN)
        (out, path, _), took = self.timed(install="fail", version_timeout="1", read_native=False)
        self.assertLess(took, 15)
        self.assertIn("using npm-global claude", out)
        self.assertFalse(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_hanging_promoted_download_is_not_promoted(self) -> None:
        """The versions/<pin> check is a native probe too."""

        executable(self.native, '#!/bin/sh\necho "2.1.274 (Claude Code)"\n')
        # The installer drops a download that hangs in --version.
        fake = (self.root / "bin/claude").read_text()
        patched = fake.replace("printf '#!/bin/sh\\necho", "printf '#!/bin/sh\\nsleep 60\\necho")
        self.assertNotEqual(fake, patched)
        (self.root / "bin/claude").write_text(patched)
        (out, path, native), took = self.timed()
        self.assertLess(took, 15)
        self.assertNotIn("replaced", out)
        self.assertIn("not promoting it", out)
        self.assertEqual("2.1.274 (Claude Code)", native)
        self.assertFalse(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_descendant_holding_stdout_does_not_block_a_probe(self) -> None:
        """A probe that exits with a background child still holding its stdout
        must not hold the substitution open until the child ends."""

        executable(self.native, '#!/bin/sh\n[ -n "$HOLD" ] && { sleep 8 & }\necho "2.1.280 (Claude Code)"\n')
        (out, path, _), took = self.timed(version_timeout="10", env_extra={"HOLD": "1"}, read_native=False)
        self.assertLess(took, 5)
        self.assertIn("already current", out)
        self.assertTrue(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_failing_or_blank_probe_is_never_a_match(self) -> None:
        for name, body in (("exit 1 with the pin printed", '#!/bin/sh\necho "2.1.280 (Claude Code)"\nexit 1\n'),
                           ("blank", '#!/bin/sh\necho "   "\n'),
                           ("silent", "#!/bin/sh\nexit 0\n")):
            with self.subTest(name):
                shutil.rmtree(self.ws / ".local", ignore_errors=True)
                executable(self.native, body)
                out, path, native = self.run_block(install="fail")
                self.assertNotIn("already current", out)
                self.assertIn("installing/refreshing", out)
                self.assertIn("using npm-global claude", out)
                self.assertFalse(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_matching_and_mismatched_versions_still_compare_by_number(self) -> None:
        fake_version_binary(self.native, "2.1.280")
        out, _, _ = self.run_block()
        self.assertIn("already current", out)
        fake_version_binary(self.native, "2.1.274")
        out, _, native = self.run_block()
        self.assertNotIn("already current", out)
        self.assertEqual(PIN, native)

    def test_default_override_and_invalid_version_timeouts(self) -> None:
        args = self.root / "timeout-args"
        # Logs the duration of version probes (`timeout -k 2 N bin --version`).
        executable(self.root / "bin/timeout",
                   '#!/bin/sh\n[ "$1" = -k ] && echo "$3" >> "' + str(args) + '"\n'
                   '[ "$1" = -k ] && { shift 3; exec "$@"; }\nshift\nexec "$@"\n')
        cases = [(None, "20"), ("", "20"), ("0", "20"), ("-5", "20"), ("abc", "20"), ("1.5", "20"),
                 ("3", "3"), ("45", "45")]
        for value, expect in cases:
            with self.subTest(value=value):
                args.unlink(missing_ok=True)
                shutil.rmtree(self.ws / ".local", ignore_errors=True)
                fake_version_binary(self.native, "2.1.280")
                out, _, _ = self.run_block(version_timeout=value)
                self.assertIn("already current", out)
                recorded = args.read_text().split()
                self.assertTrue(recorded)
                self.assertEqual({expect}, set(recorded), value)

    # --- Probe reuse. Synthetic binaries log every run to a file, so these assert
    # how many times each binary was really executed, not what the source says.

    def counted(self, path: Path, name: str, body: str) -> Path:
        """Install a stub at `path` that logs one line per run to count-<name>."""
        log = self.root / f"count-{name}"
        executable(path, f'#!/bin/sh\necho run >> "{log}"\n{body}')
        return log

    def runs(self, log: Path) -> int:
        return len(log.read_text().split()) if log.exists() else 0

    def candidate(self, body: str) -> Path:
        """The binary the fake installer drops at versions/<pin> (FAKE_INSTALL=custom)."""
        return self.counted(self.root / "candidate", "cand", body)

    def test_bad_candidate_is_probed_once_and_the_warning_reuses_the_result(self) -> None:
        cases = [
            ("hang", "sleep 60\necho \"2.1.280 (Claude Code)\"\n", "1", "timed out after 1s"),
            ("fail", 'echo "libfoo.so: cannot open shared object" >&2\nexit 3\n', "10",
             "exited with status 3; stderr: libfoo.so: cannot open shared object"),
            ("blank", 'echo "   "\n', "10", "exited 0 with empty stdout"),
        ]
        for name, body, deadline, why in cases:
            with self.subTest(name):
                shutil.rmtree(self.ws / ".local", ignore_errors=True)
                stale = self.counted(self.native, "native", 'echo "2.1.274 (Claude Code)"\n')
                stale.unlink(missing_ok=True)
                cand = self.candidate(body)
                cand.unlink(missing_ok=True)
                (out, path, _), _ = self.timed(install="custom", version_timeout=deadline, read_native=False)
                self.assertEqual(1, self.runs(cand), out)  # decision + WARN share ONE probe
                self.assertEqual(2, self.runs(stale), out)  # initial + after the install; final gate reuses
                self.assertIn(f"not promoting it ({why})", out)
                self.assertNotIn("replaced", out)
                self.assertFalse(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_mismatched_candidate_is_probed_once_without_a_failure_reason(self) -> None:
        self.counted(self.native, "native", 'echo "2.1.274 (Claude Code)"\n')
        cand = self.candidate('echo "9.9.9 (Claude Code)"\n')
        out, _, _ = self.run_block(install="custom", read_native=False)
        self.assertEqual(1, self.runs(cand))
        self.assertIn("reports '9.9.9 (Claude Code)', not 2.1.280; not promoting it\n", out)

    def test_unchanged_native_is_probed_once_per_branch(self) -> None:
        # Current: one probe serves the fast path, its log line and the final gate.
        log = self.counted(self.native, "native", 'echo "2.1.280 (Claude Code)"\n')
        out, path, _ = self.run_block(read_native=False)
        self.assertEqual(1, self.runs(log), out)
        self.assertIn("already current (2.1.280 (Claude Code)); skipping install", out)
        self.assertTrue(path.startswith(f"{self.ws}/.local/bin:"), path)
        # Stale, install leaves nothing: the install may have replaced the binary,
        # so exactly one re-probe, shared by the promotion test, the elif and the gate.
        for install in ("fail", "nofile"):
            with self.subTest(install):
                log.unlink()
                self.counted(self.native, "native", 'echo "2.1.274 (Claude Code)"\n')
                out, _, _ = self.run_block(install=install, read_native=False)
                self.assertEqual(2, self.runs(log), out)
                self.assertIn("using npm-global claude", out)

    def test_native_that_fails_keeps_its_reason_without_another_probe(self) -> None:
        log = self.counted(self.native, "native", 'echo "bad ELF header" >&2\nexit 126\n')
        out, _, _ = self.run_block(install="fail", read_native=False)
        self.assertEqual(2, self.runs(log), out)
        self.assertIn("WARN native claude version probe: exited with status 126; stderr: bad ELF header", out)
        self.assertIn("WARN native claude is '', image pins", out)

    def test_stderr_never_leaks_into_the_version_token(self) -> None:
        executable(self.native, '#!/bin/sh\necho "warning: noisy" >&2\necho "2.1.280 (Claude Code)"\n')
        out, _, _ = self.run_block()
        self.assertIn("already current (2.1.280 (Claude Code)); skipping install", out)
        self.assertNotIn("WARN", out)

    def test_replacing_the_binary_invalidates_the_old_result(self) -> None:
        """After promotion the file at the native path is a different binary: it
        is probed again, and a replacement that misreports is not put on PATH."""
        self.counted(self.native, "native", 'echo "2.1.274 (Claude Code)"\n')
        # Reports the pin to the first run (the candidate check) and something
        # else to every later run (the replaced native binary).
        cand = self.candidate('[ "$(wc -l < "' + str(self.root / "count-cand") + '")" -le 1 ] '
                              '&& echo "2.1.280 (Claude Code)" || echo "2.1.999 (Claude Code)"\n')
        out, path, _ = self.run_block(install="custom", read_native=False)
        self.assertIn("native claude replaced with versions/2.1.280", out)
        self.assertEqual(2, self.runs(cand), out)  # candidate check + re-validation of the copy
        self.assertIn("WARN native claude is '2.1.999 (Claude Code)'", out)
        self.assertFalse(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_replacing_the_binary_is_probed_again_and_used_when_good(self) -> None:
        self.counted(self.native, "native", 'echo "2.1.274 (Claude Code)"\n')
        cand = self.candidate('echo "2.1.280 (Claude Code)"\n')
        out, path, _ = self.run_block(install="custom", read_native=False)
        self.assertEqual(2, self.runs(cand), out)
        self.assertIn(f"using native claude: {PIN}", out)
        self.assertTrue(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_binary_changed_by_the_installer_is_not_judged_by_its_old_result(self) -> None:
        """`claude install` may update the native binary in place."""
        stale = self.counted(self.native, "native", 'echo "2.1.274 (Claude Code)"\n')
        fresh = self.candidate('echo "2.1.280 (Claude Code)"\n')
        out, path, _ = self.run_block(install="selfupdate", read_native=False)
        self.assertEqual(1, self.runs(stale), out)  # only the initial probe; the old result is dropped
        self.assertEqual(1, self.runs(fresh), out)  # re-probed once, then reused by the gate
        self.assertIn(f"using native claude: {PIN}", out)
        self.assertNotIn("WARN", out)
        self.assertTrue(path.startswith(f"{self.ws}/.local/bin:"), path)

    def test_probe_output_is_capped(self) -> None:
        """A runaway --version cannot fill the disk through the capture files."""
        executable(self.native, '#!/bin/sh\nwhile :; do echo "2.1.280 spam spam spam spam spam spam spam spam" ; done\n')
        started = time.monotonic()
        out, path, _ = self.run_block(install="fail", version_timeout="3", outer=60, read_native=False)
        self.assertLess(time.monotonic() - started, 40)
        self.assertFalse(path.startswith(f"{self.ws}/.local/bin:"), path)
        self.assertEqual([], sorted(p.name for p in self.tmp.iterdir()))  # nothing left behind

    def test_install_timeout_semantics_are_unchanged(self) -> None:
        fake_version_binary(self.native, "2.1.274")
        started = time.monotonic()
        out, _, native = self.run_block(install="hang", timeout_env="1")
        self.assertLess(time.monotonic() - started, 15)
        self.assertIn("WARN native install failed", out)
        self.assertEqual("2.1.274 (Claude Code)", native)


if __name__ == "__main__":
    unittest.main()
