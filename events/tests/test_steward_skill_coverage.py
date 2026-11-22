"""Every shell command skills/pr-steward/SKILL.md tells the model to run must be
allowed in the steward tick (#61).

The tick runs in `dontAsk`: a command outside `--allowedTools` is denied, and a
denied token step once meant every tick silently ended as auth_error. This test
reads the skill's fenced `sh` blocks and its inline command spans, takes the
command head of each (pipes, `;`, `&&` and `$(...)` split into their own
commands), and requires each to match a rule in the default allow list shipped
in entrypoint.sh. Shell syntax the tick cannot run (`export`, `cat`, `[`, `case`,
`exit`) has no rule, so it fails here instead of in production.
"""

from __future__ import annotations

import re
import shlex
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKILL = (ROOT / "skills" / "pr-steward" / "SKILL.md").read_text(encoding="utf-8")
ENTRYPOINT = (ROOT / "entrypoint.sh").read_text(encoding="utf-8")

# Words that, as the first word of an inline code span, make it a shell command.
INLINE_HEADS = {"gh", "git", "jq", "rm", "cat", "echo", "export", "printenv", "date", "nohup", "setsid",
                "curl", "sh", "bash", "python3", "mkdir", "ls", "test", "env", "tee", "sed", "awk"}
SEPARATORS = {"|", "||", "&&", ";", "&"}


def default_rules() -> list[str]:
    line = next(x for x in ENTRYPOINT.splitlines() if x.lstrip().startswith("STEWARD_ALLOWED_TOOLS=\"${PR_STEWARD_ALLOWED_TOOLS:-"))
    value = re.search(r":-(.*)\}\"$", line.strip()).group(1)
    return re.findall(r"Bash\([^)]*\)|[A-Za-z]+", value)


def bash_rules(rules: list[str]) -> list[str]:
    return [m.group(1) for r in rules if (m := re.fullmatch(r"Bash\((.*)\)", r))]


def covered(words: list[str], rules: list[str]) -> bool:
    for rule in bash_rules(rules):
        if rule.endswith(":*"):
            prefix = rule[:-2].split(" ")
            if words[:len(prefix)] == prefix:
                return True
        elif words == rule.split(" "):
            return True
    return False


def commands(text: str) -> list[list[str]]:
    """Split one logical shell command into simple commands (word lists)."""
    lex = shlex.shlex(text, posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    lex.commenters = "#"
    out, cur = [], []
    for tok in lex:
        if tok in SEPARATORS:
            if cur:
                out.append(cur)
            cur = []
        elif set(tok) <= set("<>()"):
            continue
        else:
            cur.append(tok)
    if cur:
        out.append(cur)
    # $(...) bodies are commands too, even inside double quotes.
    for m in re.finditer(r"\$\(([^)]*)\)", text):
        out.extend(commands(m.group(1)))
    return [c for c in out if not (re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", c[0]))]


def fenced_sh_commands(skill: str) -> list[list[str]]:
    found = []
    for block in re.findall(r"```sh\n(.*?)```", skill, re.S):
        pending = ""
        for line in block.splitlines():
            pending = (pending + "\n" + line) if pending else line
            try:
                shlex.split(pending, comments=True)
            except ValueError:
                continue  # inside a multi-line quoted argument
            if pending.rstrip().endswith("\\"):
                pending = pending.rstrip()[:-1]
                continue
            if pending.strip() and not pending.lstrip().startswith("#"):
                found.extend(commands(pending))
            pending = ""
        if pending.strip():
            found.extend(commands(pending))
    return found


def inline_commands(skill: str) -> list[list[str]]:
    body = re.sub(r"```.*?```", "", skill, flags=re.S)
    found = []
    for span in re.findall(r"`([^`\n]+)`", body):
        words = span.split()
        if words and (words[0] in INLINE_HEADS or words[0].startswith("/opt/steward/")):
            found.append(words)
    return found


def uncovered(skill: str, rules: list[str]) -> list[str]:
    return sorted({" ".join(c) for c in fenced_sh_commands(skill) + inline_commands(skill)
                   if not covered(c, rules)})


class SkillCommandCoverageTest(unittest.TestCase):
    def test_the_allow_list_parses(self) -> None:
        rules = default_rules()
        for expected in ("Bash(gh:*)", "Bash(git:*)", "Bash(printenv PR_STEWARD_ENABLED)",
                         "Bash(rm -f /workspace/.steward.lock)"):
            self.assertIn(expected, rules)

    def test_every_command_the_skill_asks_for_is_allowed(self) -> None:
        self.assertEqual([], uncovered(SKILL, default_rules()))

    def test_the_skill_really_has_commands_to_check(self) -> None:
        heads = {c[0] for c in fenced_sh_commands(SKILL) + inline_commands(SKILL)}
        self.assertTrue({"gh", "git", "printenv", "rm", "/opt/steward/bin/pr-steward-log"} <= heads, heads)

    def test_the_watcher_launcher_is_configured_not_guessed(self) -> None:
        self.assertIn("PR_STEWARD_WATCH_SCRIPT", SKILL)
        self.assertIn("PR_STEWARD_WATCH_SCRIPT", ENTRYPOINT)


class DetectorIsRedWhenACommandIsNotCoveredTest(unittest.TestCase):
    """The checker must fail on the exact commands that broke the tick."""

    def check(self, snippet: str) -> list[str]:
        return uncovered("```sh\n" + snippet + "\n```\n", default_rules())

    def test_the_original_gate_auth_and_lock_steps_are_flagged(self) -> None:
        self.assertTrue(self.check('[ "${PR_STEWARD_ENABLED:-false}" = "true" ] || { echo off; exit 0; }'))
        self.assertTrue(self.check('export GH_TOKEN="$(cat "$TOKEN_FILE")"'))
        self.assertIn("cat $TOKEN_FILE", self.check('x="$(cat "$TOKEN_FILE")"'))
        self.assertTrue(self.check("nohup ./watch.sh &"))
        self.assertTrue(self.check("rm -f $LOCK"))
        self.assertTrue(self.check("date -u +%FT%TZ"))
        self.assertTrue(self.check("gh pr list | sort"))
        self.assertTrue(self.check("printenv GH_TOKEN"))

    def test_covered_commands_and_continuations_pass(self) -> None:
        self.assertEqual([], self.check("gh pr list -R x \\\n  --search y"))
        self.assertEqual([], self.check("rm -f /workspace/.steward.lock"))
        self.assertEqual([], self.check("gh api graphql -f query='\n  query($a:String!){ x }' -F a=b"))
        self.assertTrue(self.check("rm -f /workspace/other"))

    def test_an_inline_span_is_checked_too(self) -> None:
        self.assertEqual(["cat /run/steward/gh-token"], uncovered("use `cat /run/steward/gh-token` now", default_rules()))
        self.assertEqual([], uncovered("use `gh pr view 3` now", default_rules()))


if __name__ == "__main__":
    unittest.main()
