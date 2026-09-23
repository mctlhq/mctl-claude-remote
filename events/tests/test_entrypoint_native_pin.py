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
                echo "{PIN}" ;;
              install)
                [ "${{FAKE_INSTALL:-ok}}" = fail ] && {{ echo "install failed"; exit 1; }}
                mkdir -p "{self.versions}"
                v="$2"; [ "${{FAKE_INSTALL:-ok}}" = corrupt ] && v="9.9.9"
                printf '#!/bin/sh\\necho "%s (Claude Code)"\\n' "$v" > "{self.versions}/$2"
                chmod +x "{self.versions}/$2"
                echo "  Next: Run claude --help to get started" ;;
            esac
            """))

    def run_block(self, install: str = "ok", version: str = "ok") -> tuple[str, str, str]:
        self.tmp = self.root / "tmp"
        self.tmp.mkdir(exist_ok=True)
        script = block().replace("/workspace", str(self.ws)).replace("/tmp/claude-install.", f"{self.tmp}/claude-install.")
        probe = 'printf "\\nPATH=%s\\n" "$PATH"'
        env = {**os.environ, "PATH": f"{self.root / 'bin'}:{os.environ['PATH']}",
               "FAKE_INSTALL": install, "FAKE_VERSION": version}
        proc = subprocess.run(["/bin/sh", "-e", "-c", script + probe], env=env,
                              capture_output=True, text=True, timeout=30)
        self.assertEqual(0, proc.returncode, proc.stdout + proc.stderr)
        out = proc.stdout + proc.stderr
        path = proc.stdout.rsplit("PATH=", 1)[1].strip()
        native = subprocess.run([str(self.native), "--version"], capture_output=True, text=True).stdout.strip() \
            if self.native.exists() else ""
        return out, path, native

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
        self.assertIn("WARN versions/2.1.280 reports '9.9.9 (Claude Code)', not '2.1.280 (Claude Code)'; not promoting it", out)
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


if __name__ == "__main__":
    unittest.main()
