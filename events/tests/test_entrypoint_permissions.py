"""The entrypoint's permission mode and allowlist (#61), run for real under /bin/sh -e.

The settings.json block is cut out of entrypoint.sh by its first and last line
and executed against a scratch workspace, so the test exercises the shipped
text. The jq here must be the image's (1.6 on the CI runner, see pr-checks.yml).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ENTRYPOINT = Path(__file__).resolve().parents[2] / "entrypoint.sh"
TEXT = ENTRYPOINT.read_text(encoding="utf-8")
LINES = TEXT.splitlines()
BASE = {"mcp__mctl-events__ack_event", "mcp__mctl-telegram__get_messages", "Bash(gh pr view *)"}


def cut(first: str, last: str, until: int = 0) -> str:
    start = next(i for i in range(len(LINES)) if LINES[i].startswith(first))
    end = next(i for i in range(max(start, until), len(LINES)) if LINES[i] == last)
    return "\n".join(LINES[start:end + 1]) + "\n"


def shell_source() -> str:
    call = next(i for i, line in enumerate(LINES) if line.startswith("ensure_json /workspace/.claude/settings.json"))
    return (cut("write_json_atomic() {", "}")
            + cut("ensure_json() {", "}")
            + cut('CLAUDE_REMOTE_MODEL="${CLAUDE_REMOTE_MODEL:-haiku}"', "JSON", until=call))


@unittest.skipUnless(shutil.which("jq"), "jq is not on PATH")
class PermissionSettingsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="perm-settings-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.settings = self.root / "settings.json"

    def run_block(self, extra: str | None = None) -> subprocess.CompletedProcess:
        script = shell_source().replace("/workspace/.claude/settings.json", str(self.settings))
        env = {k: v for k, v in os.environ.items() if k != "CLAUDE_REMOTE_EXTRA_ALLOW"}
        if extra is not None:
            env["CLAUDE_REMOTE_EXTRA_ALLOW"] = extra
        return subprocess.run(["/bin/sh", "-e", "-c", script], capture_output=True, text=True,
                              timeout=30, env=env)

    def perms(self) -> dict:
        return json.loads(self.settings.read_text())["permissions"]

    def test_fresh_workspace_is_dontask_with_only_the_hydration_allowlist(self) -> None:
        proc = self.run_block()
        self.assertEqual(0, proc.returncode, proc.stderr)
        perms = self.perms()
        self.assertEqual("dontAsk", perms["defaultMode"])
        self.assertEqual("disable", perms["disableBypassPermissionsMode"])
        self.assertEqual(BASE, set(perms["allow"]))
        self.assertNotIn("allow_bypass_permissions", perms)

    def test_restored_bypass_settings_are_repaired_and_operator_keys_kept(self) -> None:
        self.settings.write_text(json.dumps({
            "permissions": {"defaultMode": "auto", "allow_bypass_permissions": True,
                            "allow": ["Bash(ls *)"], "deny": ["Bash(rm *)"]},
            "model": "sonnet", "operatorKey": 1}))
        proc = self.run_block()
        self.assertEqual(0, proc.returncode, proc.stderr)
        doc = json.loads(self.settings.read_text())
        perms = doc["permissions"]
        self.assertEqual("dontAsk", perms["defaultMode"])
        self.assertEqual("disable", perms["disableBypassPermissionsMode"])
        self.assertNotIn("allow_bypass_permissions", perms)
        self.assertEqual(BASE, set(perms["allow"]))  # the stale Bash(ls *) is revoked
        self.assertEqual(["Bash(rm *)"], perms["deny"])
        self.assertEqual(1, doc["operatorKey"])

    def test_a_dropped_allow_entry_is_restored_and_a_converged_file_is_not_rewritten(self) -> None:
        self.run_block()
        doc = json.loads(self.settings.read_text())
        doc["permissions"]["allow"].remove("mcp__mctl-events__ack_event")
        self.settings.write_text(json.dumps(doc))
        self.run_block()
        self.assertIn("mcp__mctl-events__ack_event", self.perms()["allow"])
        before = self.settings.stat().st_mtime_ns
        proc = self.run_block()
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertEqual(before, self.settings.stat().st_mtime_ns)

    def test_a_broad_or_removed_allow_entry_is_revoked_on_the_next_start(self) -> None:
        self.assertEqual(0, self.run_block("Read").returncode)
        doc = json.loads(self.settings.read_text())
        doc["permissions"]["allow"].append("Bash(*)")
        self.settings.write_text(json.dumps(doc))
        self.assertEqual(0, self.run_block("Read").returncode)
        self.assertEqual(BASE | {"Read"}, set(self.perms()["allow"]))
        # Dropping the item from the env drops the rule from the file.
        self.assertEqual(0, self.run_block().returncode)
        self.assertEqual(BASE, set(self.perms()["allow"]))

    def test_extra_allow_is_added_and_bad_characters_refuse_to_start(self) -> None:
        self.assertEqual(0, self.run_block(" Bash(git status *) , Read ").returncode)
        self.assertEqual(BASE | {"Bash(git status *)", "Read"}, set(self.perms()["allow"]))
        self.settings.unlink()
        for bad in ('Bash(x)", "Bash(*)', "Bash(a;b)", "Bash($(id))", "a\\b"):
            with self.subTest(bad=bad):
                proc = self.run_block(bad)
                self.assertEqual(2, proc.returncode)
                self.assertFalse(self.settings.exists())


class LaunchModeTest(unittest.TestCase):
    def test_no_launch_path_uses_the_bypass_flag(self) -> None:
        code = [line for line in LINES if not line.lstrip().startswith("#")]
        self.assertEqual([], [line for line in code if "--dangerously-skip-permissions" in line])

    def test_every_launch_and_the_steward_tick_run_in_dontask(self) -> None:
        # events branch, plain --remote-control branch, steward tick
        launches = [line for line in LINES if "--permission-mode dontAsk" in line and "Mode:" not in line]
        self.assertEqual(3, len(launches), launches)
        self.assertIn('--allowedTools "$STEWARD_ALLOWED_TOOLS"', TEXT)


if __name__ == "__main__":
    unittest.main()
