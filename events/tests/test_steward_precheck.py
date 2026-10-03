"""bin/pr-steward-precheck: the scheduler's cheap gate before a paid tick.

The shipped script runs as a subprocess against a fake `gh` that serves a
canned `gh pr list` body per repo, so the jq filtering, the steward.log
reading and the exit codes are exercised for real.

Exit codes: 0 = a candidate PR exists (fire a tick), 1 = nothing to do,
2 = broken (config/auth, or every repo query failed).
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "bin" / "pr-steward-precheck"

REPO = "mctlhq/mctl-gitops"
HEAD_A = "61c9781" + "a" * 33
HEAD_B = "0b1c2d3" + "b" * 33


def pr(number=1492, head=HEAD_A, labels=("steward:owned", "steward:ready-to-merge"), branch="feat/agents-x",
       review="APPROVED"):
    return {
        "number": number,
        "headRefName": branch,
        "headRefOid": head,
        "labels": [{"name": name} for name in labels],
        # gh renders a null reviewDecision as "".
        "reviewDecision": review,
    }


def entry(pr_number=1492, head=HEAD_A, action="ready-to-merge", result="labeled", reason="clean-green",
          repo=REPO, **extra):
    return json.dumps({
        "ts": "2026-10-02T21:29:32Z", "tick_id": "20261002T212932Z", "repo": repo, "pr": pr_number,
        "head_sha": head, "action": action, "result": result, "reason": reason, **extra,
    })


@unittest.skipUnless(shutil.which("jq"), "jq not installed")
class PrecheckTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="steward-precheck-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        bindir = self.root / "bin"
        bindir.mkdir()
        self.bodies = self.root / "bodies"
        self.bodies.mkdir()
        fake = bindir / "gh"
        # Serves bodies/<owner>_<repo>.json for `gh pr list -R owner/repo ...`;
        # no body = a failed query. Records argv for the --json assertion.
        fake.write_text(
            "#!/bin/sh\n"
            f'printf "%s\\n" "$*" >> "{self.root}/argv"\n'
            'repo=""; prev=""\n'
            'for a in "$@"; do [ "$prev" = "-R" ] && repo="$a"; prev="$a"; done\n'
            f'body="{self.bodies}/$(printf "%s" "$repo" | tr / _).json"\n'
            '[ -f "$body" ] || { echo "HTTP 404: Not Found" >&2; exit 1; }\n'
            'cat "$body"\n'
        )
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        self.token = self.root / "gh-token"
        self.token.write_text("ghs_SECRETVALUE\n")
        self.log = self.root / "steward.log"
        self.config = self.root / "config.json"
        self.write_config()
        self.env = dict(
            os.environ,
            PATH=f"{bindir}{os.pathsep}{os.environ['PATH']}",
            PR_STEWARD_CONFIG=str(self.config),
            GH_APP_TOKEN_FILE=str(self.token),
        )

    def write_config(self, top_mode="never", repo_mode=None, repos=None, logging=True, fix_mode=None,
                     top_fix_mode=None):
        if repos is None:
            entry_ = {"name": REPO, "pr_filter": {"head_prefix": "feat/agents-"}}
            if repo_mode is not None:
                entry_["merge_mode"] = repo_mode
            if fix_mode is not None:
                entry_["fix_mode"] = fix_mode
            repos = [entry_]
        config = {"label_prefix": "steward", "repos": repos}
        if top_mode is not None:
            config["merge_mode"] = top_mode
        if top_fix_mode is not None:
            config["fix_mode"] = top_fix_mode
        if logging:
            config["logging"] = {"file": str(self.log)}
        self.config.write_text(json.dumps(config))

    def serve(self, prs, repo=REPO):
        (self.bodies / (repo.replace("/", "_") + ".json")).write_text(json.dumps(prs))

    def write_log(self, *lines):
        self.log.write_text("".join(line + "\n" for line in lines))

    def run_precheck(self):
        proc = subprocess.run([str(SCRIPT)], env=self.env, capture_output=True, text=True, timeout=30, check=False)
        self.assertNotIn("SECRETVALUE", proc.stdout + proc.stderr)
        return proc

    def assertExit(self, code):
        proc = self.run_precheck()
        self.assertEqual(proc.returncode, code, proc.stdout + proc.stderr)
        return proc

    # --- the #74 invariant -------------------------------------------------

    def test_first_eligible_tick_is_a_candidate(self):
        # Labelled, but the steward has not logged the decision yet.
        self.serve([pr()])
        self.write_log()
        self.assertExit(0)

    def test_ready_to_merge_at_unchanged_head_in_never_mode_is_idle(self):
        self.serve([pr()])
        self.write_log(entry())
        proc = self.assertExit(1)
        self.assertIn("1 idle PR(s)", proc.stdout)

    def test_already_labeled_re_evaluation_keeps_the_pr_idle(self):
        self.serve([pr()])
        self.write_log(entry(), entry(result="already-labeled"))
        self.assertExit(1)

    def test_behind_or_blocked_never_path_keeps_ticking(self):
        # Skill §5: behind/blocked in a never repo also labels ready-to-merge,
        # but BEHIND -> DIRTY or a check going red happens at an unchanged
        # head, so its escalate entry must not idle the PR.
        for reason in ("behind", "blocked"):
            with self.subTest(reason=reason):
                self.serve([pr()])
                self.write_log(entry(action="escalate", result="escalated", reason=reason))
                self.assertExit(0)

    def test_ready_to_merge_entry_without_clean_green_reason_keeps_ticking(self):
        # Pre-contract production shapes, e.g. mctl-gitops#1492's ticks: the
        # entry cannot be told apart from the behind/blocked path.
        for kwargs in ({"result": "escalated", "reason": "merge_mode=never"},
                       {"action": "wait", "result": "ready-to-merge-already-labeled", "reason": ""}):
            with self.subTest(**kwargs):
                self.serve([pr()])
                self.write_log(entry(**kwargs))
                self.assertExit(0)

    def test_twelve_char_logged_sha_matches_the_full_head(self):
        self.serve([pr()])
        self.write_log(entry(head=HEAD_A[:12]))
        self.assertExit(1)

    def test_new_head_makes_the_pr_eligible_again(self):
        self.serve([pr(head=HEAD_B)])
        self.write_log(entry(head=HEAD_A))
        self.assertExit(0)

    def test_label_removed_makes_the_pr_eligible_again(self):
        self.serve([pr(labels=("steward:owned",))])
        self.write_log(entry())
        self.assertExit(0)

    def test_a_later_steward_entry_for_the_pr_supersedes_the_decision(self):
        self.serve([pr()])
        self.write_log(entry(), entry(action="wait", result="", reason="awaiting-review"))
        self.assertExit(0)

    def test_entries_for_other_prs_and_repos_do_not_count(self):
        self.serve([pr()])
        self.write_log(entry(pr_number=7), entry(repo="mctlhq/other"))
        self.assertExit(0)

    def test_only_the_idle_pr_is_skipped(self):
        self.serve([pr(number=1492), pr(number=1500, labels=("steward:owned",))])
        self.write_log(entry())
        proc = self.assertExit(0)
        self.assertIn("1 candidate PR(s)", proc.stdout)

    def test_head_ref_oid_is_requested_in_the_single_list_call(self):
        self.serve([pr()])
        self.write_log(entry())
        self.assertExit(1)
        calls = (self.root / "argv").read_text().splitlines()
        self.assertEqual(len(calls), 1)
        self.assertIn("headRefOid", calls[0])
        self.assertIn("reviewDecision", calls[0])

    # --- merge_mode resolution --------------------------------------------

    def test_per_repo_when_green_keeps_ticking(self):
        # when-green PRs get ready-to-merge while awaiting approval; an
        # approval does not move the head, so they must stay candidates.
        self.write_config(top_mode="never", repo_mode="when-green")
        self.serve([pr()])
        self.write_log(entry())
        self.assertExit(0)

    def test_top_level_never_is_inherited_when_the_repo_omits_it(self):
        self.write_config(top_mode="never", repo_mode=None)
        self.serve([pr()])
        self.write_log(entry())
        self.assertExit(1)

    def test_missing_merge_mode_everywhere_defaults_to_never(self):
        self.write_config(top_mode=None, repo_mode=None)
        self.serve([pr()])
        self.write_log(entry())
        self.assertExit(1)

    def test_top_level_when_green_inherited_keeps_ticking(self):
        self.write_config(top_mode="when-green", repo_mode=None)
        self.serve([pr()])
        self.write_log(entry())
        self.assertExit(0)

    def test_per_repo_never_overrides_top_level_when_green(self):
        self.write_config(top_mode="when-green", repo_mode="never")
        self.serve([pr()])
        self.write_log(entry())
        self.assertExit(1)

    def test_unrecognized_merge_mode_is_unknown_not_idle(self):
        self.write_config(top_mode="never", repo_mode="sometimes")
        self.serve([pr()])
        self.write_log(entry())
        proc = self.assertExit(0)
        self.assertIn("unrecognized merge_mode 'sometimes'", proc.stderr)

    # --- fail-safe: unknown is never idle ------------------------------------

    def test_missing_log_file_is_a_candidate(self):
        self.serve([pr()])
        self.assertFalse(self.log.exists())
        self.assertExit(0)

    def test_no_logging_file_configured_is_a_candidate(self):
        self.write_config(logging=False)
        self.serve([pr()])
        self.write_log(entry())
        self.assertExit(0)

    def test_unreadable_log_is_a_candidate(self):
        if os.geteuid() == 0:
            self.skipTest("root reads any file")
        self.serve([pr()])
        self.write_log(entry())
        self.log.chmod(0)
        self.assertExit(0)

    def test_corrupt_line_after_the_decision_is_a_candidate(self):
        self.serve([pr()])
        self.write_log(entry(), '{"repo":"mctlhq/mctl-gitops","pr":1492,"action":"wa')
        self.assertExit(0)

    def test_corrupt_line_before_the_decision_does_not_matter(self):
        self.serve([pr()])
        self.write_log("garbage", entry())
        self.assertExit(1)

    def test_entirely_corrupt_log_is_a_candidate(self):
        self.serve([pr()])
        self.log.write_bytes(b"\x00\xff not json at all\n")
        self.assertExit(0)

    def test_missing_or_garbled_logged_sha_is_a_candidate(self):
        for head in ("", "not-a-sha", "abc", HEAD_A[:7], HEAD_A[:11], None):
            with self.subTest(head=head):
                self.serve([pr()])
                self.write_log(entry(head=head))
                self.assertExit(0)

    def test_missing_current_head_is_a_candidate(self):
        body = pr()
        del body["headRefOid"]
        self.serve([body])
        self.write_log(entry())
        self.assertExit(0)

    # --- fix_mode: review remediation owned by the DevLoop shepherd ----------

    def test_fix_mode_never_unapproved_pr_is_not_a_candidate(self):
        self.write_config(fix_mode="never")
        for review in ("REVIEW_REQUIRED", "CHANGES_REQUESTED", ""):
            with self.subTest(review=review):
                self.serve([pr(labels=(), review=review)])
                self.write_log()
                proc = self.assertExit(1)
                self.assertIn("1 PR(s) awaiting approval", proc.stdout)

    def test_fix_mode_never_approved_pr_is_a_candidate(self):
        self.write_config(fix_mode="never")
        self.serve([pr(labels=(), review="APPROVED")])
        self.write_log()
        self.assertExit(0)

    def test_fix_mode_never_one_approved_pr_among_held_ones_fires(self):
        self.write_config(fix_mode="never")
        self.serve([pr(number=1, labels=(), review="REVIEW_REQUIRED"), pr(number=2, labels=(), review="APPROVED")])
        proc = self.assertExit(0)
        self.assertIn("1 candidate PR(s)", proc.stdout)

    def test_absent_or_auto_fix_mode_keeps_unapproved_prs_candidates(self):
        for fix_mode in (None, "auto"):
            with self.subTest(fix_mode=fix_mode):
                self.write_config(fix_mode=fix_mode)
                self.serve([pr(labels=(), review="REVIEW_REQUIRED")])
                self.write_log()
                self.assertExit(0)

    def test_fix_mode_is_per_repo_other_prefixes_unaffected(self):
        # The feat/agents- entry holds its unapproved PR; the claude/ and fix/
        # entries in other repos keep today's behaviour.
        self.write_config(repos=[
            {"name": REPO, "pr_filter": {"head_prefix": "feat/agents-"}, "fix_mode": "never"},
            {"name": "mctlhq/claude-repo", "pr_filter": {"head_prefix": "claude/"}},
            {"name": "mctlhq/fix-repo", "pr_filter": {"head_prefix": "fix/"}},
        ])
        self.serve([pr(labels=(), review="REVIEW_REQUIRED")])
        for repo, branch in (("mctlhq/claude-repo", "claude/x"), ("mctlhq/fix-repo", "fix/x")):
            with self.subTest(repo=repo):
                for other in ("mctlhq/claude-repo", "mctlhq/fix-repo"):
                    self.serve([], repo=other)
                self.serve([pr(labels=(), branch=branch, review="REVIEW_REQUIRED")], repo=repo)
                proc = self.assertExit(0)
                self.assertIn(f"{repo} has 1 candidate PR(s)", proc.stdout)
        for other in ("mctlhq/claude-repo", "mctlhq/fix-repo"):
            self.serve([], repo=other)
        self.assertExit(1)

    def test_unknown_fix_mode_warns_and_behaves_as_never(self):
        self.write_config(fix_mode="sometimes")
        self.serve([pr(labels=(), review="REVIEW_REQUIRED")])
        self.write_log()
        proc = self.assertExit(1)
        self.assertIn("unrecognized fix_mode 'sometimes'", proc.stderr)
        self.serve([pr(labels=(), review="APPROVED")])
        self.assertExit(0)

    def test_fix_mode_never_unreadable_review_decision_is_a_failed_query(self):
        self.write_config(fix_mode="never")
        for bad in ("missing", None, 1):
            with self.subTest(review=bad):
                body = pr(labels=())
                if bad == "missing":
                    del body["reviewDecision"]
                else:
                    body["reviewDecision"] = bad
                self.serve([body])
                proc = self.assertExit(2)
                self.assertIn("unreadable gh pr list output", proc.stderr)

    def test_top_level_fix_mode_never_is_inherited(self):
        # A key placed next to the top-level merge_mode must not be silently
        # ignored: that would hand fixing back to the steward.
        self.write_config(top_fix_mode="never")
        self.serve([pr(labels=(), review="REVIEW_REQUIRED")])
        self.assertExit(1)

    def test_per_repo_auto_overrides_top_level_never(self):
        self.write_config(top_fix_mode="never", fix_mode="auto")
        self.serve([pr(labels=(), review="REVIEW_REQUIRED")])
        self.assertExit(0)

    def test_unknown_top_level_fix_mode_warns_and_behaves_as_never(self):
        self.write_config(top_fix_mode="sometimes")
        self.serve([pr(labels=(), review="REVIEW_REQUIRED")])
        proc = self.assertExit(1)
        self.assertIn("unrecognized fix_mode 'sometimes'", proc.stderr)

    def test_out_of_scope_pr_with_unreadable_review_decision_does_not_fail_the_repo(self):
        self.write_config(fix_mode="never")
        stray = pr(number=5, labels=(), branch="dependabot/x")
        del stray["reviewDecision"]
        terminal = pr(number=6, labels=("steward:merged",))
        del terminal["reviewDecision"]
        self.serve([stray, terminal, pr(number=7, labels=(), review="APPROVED")])
        self.assertExit(0)

    def test_fix_mode_never_failed_query_is_broken_not_idle(self):
        self.write_config(fix_mode="never")
        self.assertExit(2)

    def test_fix_mode_never_failed_repo_does_not_hide_held_state(self):
        # One repo held, one repo erroring: errors > 0 → exit 2, not idle.
        self.write_config(repos=[
            {"name": REPO, "pr_filter": {"head_prefix": "feat/agents-"}, "fix_mode": "never"},
            {"name": "mctlhq/missing", "pr_filter": {"head_prefix": "feat/agents-"}, "fix_mode": "never"},
        ])
        self.serve([pr(labels=(), review="REVIEW_REQUIRED")])
        self.assertExit(2)

    def test_fix_mode_never_approved_idle_ready_to_merge_stays_idle(self):
        # #74 preserved: approved + ready-to-merge at an unchanged head with a
        # clean-green entry is idle under merge_mode=never.
        self.write_config(fix_mode="never")
        self.serve([pr(review="APPROVED")])
        self.write_log(entry())
        proc = self.assertExit(1)
        self.assertIn("1 idle PR(s)", proc.stdout)

    def test_fix_owned_by_shepherd_entry_never_idles_a_pr(self):
        # The skill's backstop line is a later entry that is not clean-green:
        # it supersedes an earlier ready-to-merge decision, never creates one.
        self.write_config(fix_mode="never")
        self.serve([pr(review="APPROVED")])
        self.write_log(entry(), entry(action="wait", result="", reason="fix-owned-by-shepherd"))
        self.assertExit(0)

    def test_fix_mode_never_new_head_after_approval_dismissal_is_held(self):
        # A shepherd fix push dismisses the approval: the PR is held again,
        # whatever the log says.
        self.write_config(fix_mode="never")
        self.serve([pr(head=HEAD_B, review="REVIEW_REQUIRED")])
        self.write_log(entry(head=HEAD_A))
        self.assertExit(1)

    def test_fix_mode_never_terminal_labels_still_skipped(self):
        self.write_config(fix_mode="never")
        self.serve([pr(labels=("steward:merged",), review="APPROVED")])
        proc = self.assertExit(1)
        self.assertNotIn("awaiting approval", proc.stdout)

    # --- unchanged behaviour ---------------------------------------------------

    def test_terminal_labels_are_still_skipped(self):
        for label in ("steward:merged", "steward:escalated"):
            with self.subTest(label=label):
                self.serve([pr(labels=("steward:owned", label))])
                self.write_log()
                self.assertExit(1)

    def test_unlabelled_in_scope_pr_is_a_candidate(self):
        self.serve([pr(labels=())])
        self.write_log(entry())
        self.assertExit(0)

    def test_out_of_scope_branch_is_ignored(self):
        self.serve([pr(labels=(), branch="dependabot/x")])
        self.assertExit(1)

    def test_every_query_failing_is_broken_not_idle(self):
        self.assertExit(2)

    def test_unreadable_gh_body_is_broken_not_idle(self):
        (self.bodies / (REPO.replace("/", "_") + ".json")).write_text("<html>rate limited</html>")
        self.assertExit(2)


if __name__ == "__main__":
    unittest.main()
