"""The pty host really runs a command on a pty, takes keystrokes, shows output and stops.

Run from plugin/mctl-bridge:  python3 -m unittest discover -s test -p 'test_*.py'
"""
import json, os, stat, subprocess, sys, tempfile, time, unittest

PTY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ops", "slot-pty.py")

def run(*a):
    return subprocess.run([sys.executable, PTY, *a], capture_output=True, text=True, timeout=30)

def wait_for(pred, secs=8):
    end = time.time() + secs
    while time.time() < end:
        if pred(): return True
        time.sleep(0.1)
    return False

class PtyHost(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="slotpty-")
        self.addCleanup(lambda: run("stop", self.d))

    def test_start_type_show_stop(self):
        self.assertEqual(run("start", self.d, "/bin/cat").returncode, 0)
        self.assertTrue(wait_for(lambda: run("ping", self.d).returncode == 0), "session never came up")
        # the control socket is private to the slot user
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.d, "ctl.sock")).st_mode) & 0o077, 0)
        self.assertEqual(run("keys", self.d, "hello-pty\\r").stdout.strip(), "ok")
        self.assertTrue(wait_for(lambda: "hello-pty" in run("show", self.d).stdout), "typed text not echoed back")
        run("stop", self.d)
        self.assertTrue(wait_for(lambda: run("ping", self.d).returncode != 0), "still alive after stop")

    def test_child_exit_is_not_alive(self):
        run("start", self.d, "/bin/sh", "-c", "echo bye; exit 3")
        self.assertTrue(wait_for(lambda: os.path.exists(os.path.join(self.d, "ctl.sock"))))
        self.assertTrue(wait_for(lambda: run("ping", self.d).returncode != 0), "a finished child must not read as alive")
        self.assertIn("bye", run("show", self.d).stdout)

    def test_client_disconnect_does_not_kill_the_session(self):
        import socket
        run("start", self.d, "/bin/cat")
        self.assertTrue(wait_for(lambda: run("ping", self.d).returncode == 0))
        run("keys", self.d, "x" * 3000 + "\\r")
        time.sleep(0.3)
        for _ in range(5):  # ask for the buffer and hang up before reading the reply
            s = socket.socket(socket.AF_UNIX); s.connect(os.path.join(self.d, "ctl.sock"))
            s.sendall(b"S"); s.shutdown(socket.SHUT_WR); s.close()
        time.sleep(0.5)
        self.assertEqual(run("ping", self.d).returncode, 0, "a client hanging up killed the host")

    def test_grandchild_holding_the_pty_does_not_keep_the_slot_alive(self):
        # the child prints and exits while a background grandchild still holds the pty open
        # the grandchild leaves the session (setsid), so the pty hangup that would give the host
        # an EOF never reaches it: only waitpid can tell that the child is gone
        code = "import os,time\nprint('tail-output',flush=True)\nif os.fork()==0:\n os.setsid(); time.sleep(8); os._exit(0)\n"
        run("start", self.d, sys.executable, "-c", code)
        self.assertTrue(wait_for(lambda: os.path.exists(os.path.join(self.d, "ctl.sock"))))
        self.assertTrue(wait_for(lambda: run("ping", self.d).returncode != 0), "a grandchild on the pty kept a finished slot alive")
        self.assertIn("tail-output", run("show", self.d).stdout, "output before the exit was lost")

    def test_a_grandchild_that_keeps_writing_does_not_hide_the_exit(self):
        code = "import os,time\nprint('first',flush=True)\nif os.fork()==0:\n os.setsid()\n for _ in range(200):\n  print('noise',flush=True); time.sleep(0.05)\n os._exit(0)\n"
        run("start", self.d, sys.executable, "-c", code)
        self.assertTrue(wait_for(lambda: os.path.exists(os.path.join(self.d, "ctl.sock"))))
        self.assertTrue(wait_for(lambda: run("ping", self.d).returncode != 0, 6), "constant output from a grandchild hid the child's exit")

    def test_stop_after_the_child_exited_signals_nothing(self):
        run("start", self.d, "/bin/sh", "-c", "exit 0")
        self.assertTrue(wait_for(lambda: os.path.exists(os.path.join(self.d, "ctl.sock"))))
        self.assertTrue(wait_for(lambda: run("ping", self.d).returncode != 0))
        self.assertEqual(run("stop", self.d).returncode, 0)
        self.assertTrue(wait_for(lambda: not os.path.exists(os.path.join(self.d, "ctl.sock"))), "host did not exit on stop")

# A stand-in for Claude Code's TUI: it paints with cursor moves (spaces are `ESC[1C`, redraws
# are `ESC[nA` + `ESC[2K`), exactly what made the old escape-stripping `show` unreadable in the
# pilot. `mode` picks what it ends on.
FAKE_TUI = r"""
import sys, time
mode = sys.argv[1]
W = sys.stdout.write
def words(t): return "\x1b[1C".join(t.split(" "))   # the gaps are cursor moves, not spaces
W("\x1b[2J\x1b[H")
for f in "|/-\\":                                     # a spinner redrawn in place
    W("\x1b[2K\r" + f + " Tempering...")
    sys.stdout.flush(); time.sleep(0.02)
W("\x1b[2K\r\n")
if mode == "permission":
    W("-" * 0)
    W("\u2500" * 60 + "\r\n")
    W(" Bash command\r\n")
    W("   Create the local docs branch\r\n")
    W("\u254c" * 60 + "\r\n")
    W(" " + words("git checkout -b docs/bridge-readme-manual-tags && git branch --show-current") + "\r\n")
    W(" " + words("git commit -q -m docs:fix && git log --oneline -1") + "\r\n")
    W("\u254c" * 60 + "\r\n")
    W(" This command requires approval\r\n")
    W(" Do you want to proceed?\r\n")
    W(" \u276f 1. Yes\r\n")
    W("   2. Yes, and don't ask again for: git checkout *\r\n")
    W("   3. No\r\n")
    W(" Esc to cancel \u00b7 Tab to amend\r\n")
elif mode == "tall":
    W("\u2500" * 60 + "\r\n")                              # the box head scrolls off a 50-row screen
    W(" Bash command\r\n")
    W(" " + words("cat > plugin/mctl-bridge/src/handoff.ts <<'EOF'") + "\r\n")
    for n in range(70): W(" line-%02d\r\n" % n)
    W(" EOF\r\n")
    W(" Do you want to proceed?\r\n")
    W(" \u276f 1. Yes\r\n   2. No\r\n")
elif mode == "answered":
    W(" Do you want to proceed?\r\n \u276f 1. Yes\r\n   2. No\r\n")  # answered, then scrolled away
    for n in range(60): W(" out-%02d\r\n" % n)
elif mode == "single":
    W(" Do you want to proceed?\r\n")                      # a question with only one numbered line is not a prompt
    W(" 1. Yes\r\n")
elif mode == "dialog":
    W(" Quick safety check: is this a project you trust?\r\n")
    W(" \u276f No, exit\r\n   Yes, I trust this folder\r\n Enter to confirm \u00b7 Esc to cancel\r\n")
elif mode == "bare":
    # sequences with NO parameter, which a real TUI sends most (ESC[K, ESC[A, ESC[H, ESC 7 / ESC 8)
    W("old text here\r\x1b[Knew\r\n")                      # erase to end of line, then rewrite
    W("first\r\nsecond\x1b[A\x1b[3C-up\r\n\n")             # cursor up one line, no count
    W("mark\x1b7\r\nlower\x1b8-back\r\n")                   # save / restore cursor
    W("\x1b[Hhome-wrote\r\n")                               # home, overwrite line one
elif mode == "wide":
    W("\u65e5\u672cx\x1b[7GZ\r\n")                          # two double-width glyphs, then column 7
    W("e\u0301!\r\n")                                      # a combining accent takes no column
    W("e\u0301\x1b[3GY\r\n")                              # so column 3 is the third cell, right after "e" and a space
    W("\u65e5\u672c\x1b[2Gx\r\n")                          # a narrow char lands on the 2nd half of a wide one
else:
    W("Working on it\r\n")
sys.stdout.flush()
sys.stdin.readline()
print("GOT-KEYS")
time.sleep(30)
"""

def load_pty():
    """slot-pty.py as a module. It runs main() at import, which exits on an unknown command;
    everything above that call is already defined by then."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("slot_pty", PTY)
    mod = importlib.util.module_from_spec(spec)
    argv = sys.argv; sys.argv = ["slot-pty.py", "--no-such-command"]
    try: spec.loader.exec_module(mod)
    except SystemExit: pass
    finally: sys.argv = argv
    return mod

class FindPrompt(unittest.TestCase):
    RULE = "\u2500" * 60
    ASK = [" Do you want to proceed?", " \u276f 1. Yes", "   2. No"]

    def setUp(self):
        self.m = load_pty()

    def test_a_rule_on_the_last_scrollback_line_is_the_head_not_a_truncation(self):
        p = self.m.find_prompt([" Bash command", " git status"] + self.ASK, back=["old output", self.RULE])
        self.assertFalse(p["truncated"])
        self.assertEqual(p["detail"], ["Bash command", "git status"])

    def test_no_rule_anywhere_is_truncated(self):
        p = self.m.find_prompt([" line-1", " line-2"] + self.ASK, back=["out-1", "out-2"])
        self.assertTrue(p["truncated"])
        self.assertEqual(p["detail"], ["line-1", "line-2"])

    def test_a_rule_above_an_earlier_prompt_is_not_this_box_head(self):
        old = [self.RULE, " Bash command", " rm stale", " Do you want to proceed?", " 1. Yes", " 2. No", " out"]
        p = self.m.find_prompt([" line-1"] + self.ASK, back=old)
        self.assertTrue(p["truncated"])
        self.assertNotIn("rm stale", p["detail"])

    def test_a_rule_beyond_the_scan_limit_is_not_taken(self):
        back = [self.RULE, " Bash command"] + [" x"] * self.m.BACK_LIMIT
        p = self.m.find_prompt([" line-1"] + self.ASK, back=back)
        self.assertTrue(p["truncated"])
        self.assertNotIn("Bash command", p["detail"])

class RenderedScreen(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="slotpty-")
        self.addCleanup(lambda: run("stop", self.d))

    def start(self, mode):
        run("start", self.d, sys.executable, "-c", FAKE_TUI, mode)
        self.assertTrue(wait_for(lambda: run("ping", self.d).returncode == 0))

    def prompt(self):
        return json.loads(run("prompt", self.d).stdout)

    def test_spaces_made_of_cursor_moves_survive_and_the_spinner_does_not_pile_up(self):
        self.start("permission")
        self.assertTrue(wait_for(lambda: "Do you want to proceed?" in run("show", self.d, "50").stdout))
        shown = run("show", self.d, "50").stdout
        self.assertIn("git checkout -b docs/bridge-readme-manual-tags && git branch --show-current", shown)
        self.assertNotIn("gitcheckout", shown)
        self.assertEqual(shown.count("Tempering"), 0, "spinner frames drawn in place must not accumulate")

    def test_sequences_without_parameters_are_applied_not_ignored(self):
        # a real Claude Code stream is mostly these; ignoring them left old text under new text
        self.start("bare")
        self.assertTrue(wait_for(lambda: "mark" in run("show", self.d, "50").stdout))
        shown = run("show", self.d, "50").stdout.split("\n")
        self.assertNotIn("old text here", "\n".join(shown), "ESC[K must erase the old text")
        self.assertTrue(any(l.startswith("home-wrote") for l in shown), shown)
        self.assertIn("mark-back", "\n".join(shown), "ESC 7 / ESC 8 must save and restore the cursor")
        self.assertTrue(any(l.startswith("first") and l.endswith("-up") for l in shown), "ESC[A without a count must move up one line")

    def test_double_width_glyphs_keep_later_columns_aligned(self):
        self.start("wide")
        self.assertTrue(wait_for(lambda: "Z" in run("show", self.d, "50").stdout))
        shown = run("show", self.d, "50").stdout
        # 日本 fills columns 1-4, x is 5, column 6 is blank, Z lands in 7 (one cell off if glyphs count as 1)
        self.assertIn("\u65e5\u672cx Z", shown)
        self.assertIn("e\u0301!", shown)
        self.assertIn("e\u0301 Y", shown, "the accent took a column of its own")
        # x overwrites the second half of the first glyph: a terminal blanks the whole glyph
        self.assertTrue(any(l == " x\u672c" for l in shown.split("\n")), shown)

    def test_a_host_that_cannot_answer_is_an_error_not_an_empty_screen(self):
        # a slot host started before the upgrade closes the socket on commands it does not know
        import socket, threading
        path = os.path.join(self.d, "ctl.sock")
        srv = socket.socket(socket.AF_UNIX); srv.bind(path); srv.listen(8)
        stop = threading.Event()
        def serve():
            srv.settimeout(0.2)
            while not stop.is_set():
                try: c, _ = srv.accept()
                except OSError: continue
                try: c.settimeout(2); c.recv(65536)  # read the request: closing with it unread resets the peer on Linux
                except OSError: pass
                c.close()  # a clean close: the client sees an empty reply, as from a host that predates the command
        t = threading.Thread(target=serve, daemon=True); t.start()
        self.addCleanup(lambda: (stop.set(), t.join(2), srv.close()))
        for cmd in ("prompt", "state", "show"):
            r = run(cmd, self.d)
            self.assertNotEqual(r.returncode, 0, cmd + " must fail when the host gives no answer")
            self.assertIn("UNKNOWN", r.stderr)
            self.assertNotIn("pending", r.stdout, cmd + " must not report a state it could not read")

    def test_an_unreachable_host_is_an_error(self):
        r = run("prompt", self.d)  # no host was ever started in this directory
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("unreachable", r.stderr)
        self.assertEqual(r.stdout, "")

    def test_a_waiting_permission_prompt_is_reported_whole(self):
        self.start("permission")
        self.assertTrue(wait_for(lambda: self.prompt()["pending"]), "a visible prompt was not seen")
        p = self.prompt()["prompt"]
        self.assertEqual(p["kind"], "permission")
        self.assertEqual(p["question"], "Do you want to proceed?")
        self.assertEqual([o["n"] for o in p["options"]], [1, 2, 3])
        self.assertEqual(p["options"][0]["text"], "Yes")
        detail = "\n".join(p["detail"])
        # both lines of the command, nothing cut, nothing run together
        self.assertIn("git checkout -b docs/bridge-readme-manual-tags && git branch --show-current", detail)
        self.assertIn("git commit -q -m docs:fix && git log --oneline -1", detail)
        self.assertIn("Create the local docs branch", detail)

    def test_a_box_taller_than_the_screen_keeps_its_head(self):
        # 2026-11-07: the file path of a long heredoc had scrolled off and was approved unseen
        self.start("tall")
        self.assertTrue(wait_for(lambda: self.prompt()["pending"]))
        p = self.prompt()["prompt"]
        self.assertEqual(p["detail"][0], "Bash command")
        self.assertEqual(p["detail"][1], "cat > plugin/mctl-bridge/src/handoff.ts <<'EOF'")
        self.assertEqual([l for l in p["detail"] if l.startswith("line-")], ["line-%02d" % n for n in range(70)])
        self.assertFalse(p["truncated"])

    def test_an_answered_prompt_in_the_scrollback_is_not_pending(self):
        self.start("answered")
        self.assertTrue(wait_for(lambda: "out-59" in run("show", self.d).stdout))
        self.assertEqual(self.prompt(), {"pending": False, "prompt": None})

    def test_reading_a_prompt_never_answers_it(self):
        self.start("permission")
        self.assertTrue(wait_for(lambda: self.prompt()["pending"]))
        for _ in range(3): run("prompt", self.d); run("state", self.d); run("show", self.d)
        time.sleep(0.5)
        self.assertNotIn("GOT-KEYS", run("show", self.d, "50").stdout, "observing sent keystrokes to the slot")

    def test_a_dialog_without_numbered_options_is_still_pending(self):
        self.start("dialog")
        self.assertTrue(wait_for(lambda: self.prompt()["pending"]))
        p = self.prompt()["prompt"]
        self.assertEqual(p["kind"], "dialog")
        self.assertIn("Yes, I trust this folder", "\n".join(p["detail"]))

    def test_a_question_with_a_single_numbered_line_is_not_a_permission_prompt(self):
        self.start("single")
        self.assertTrue(wait_for(lambda: "1. Yes" in run("show", self.d).stdout))
        self.assertEqual(self.prompt(), {"pending": False, "prompt": None})

    def test_no_prompt_is_not_reported_as_pending(self):
        self.start("plain")
        self.assertTrue(wait_for(lambda: "Working on it" in run("show", self.d).stdout))
        self.assertEqual(self.prompt(), {"pending": False, "prompt": None})

    def test_state_says_what_the_screen_does_not_what_the_adapter_claims(self):
        self.start("plain")
        self.assertTrue(wait_for(lambda: "Working on it" in run("show", self.d).stdout))
        time.sleep(1.2)
        st = json.loads(run("state", self.d).stdout)
        self.assertTrue(st["alive"])
        self.assertGreaterEqual(st["idle_s"], 1.0, "a silent screen must read as idle")
        self.assertFalse(st["prompt_pending"])
        run("keys", self.d, "go\\r")
        self.assertTrue(wait_for(lambda: json.loads(run("state", self.d).stdout)["idle_s"] < 1.0), "new output must reset idle_s")


if __name__ == "__main__":
    unittest.main()
