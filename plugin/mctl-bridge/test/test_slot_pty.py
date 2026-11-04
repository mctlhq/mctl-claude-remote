"""The pty host really runs a command on a pty, takes keystrokes, shows output and stops.

Run from plugin/mctl-bridge:  python3 -m unittest discover -s test -p 'test_*.py'
"""
import os, stat, subprocess, sys, tempfile, time, unittest

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

if __name__ == "__main__":
    unittest.main()
