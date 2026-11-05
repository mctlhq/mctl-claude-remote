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
elif mode == "dialog":
    W(" Quick safety check: is this a project you trust?\r\n")
    W(" \u276f No, exit\r\n   Yes, I trust this folder\r\n Enter to confirm \u00b7 Esc to cancel\r\n")
else:
    W("Working on it\r\n")
sys.stdout.flush()
sys.stdin.readline()
print("GOT-KEYS")
time.sleep(30)
"""

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
