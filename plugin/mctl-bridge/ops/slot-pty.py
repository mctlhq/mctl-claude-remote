#!/usr/bin/python3
"""Tiny pty host for one slot (replaces GNU screen, whose 2006 build exits silently for the
hidden slot users). It runs a command on a pty as the CURRENT user, detached, and offers a
control socket (mode 600, in the slot's own directory) so the operator can type into the
session and read its output:

  slot-pty.py start <dir> <cmd> [args...]   daemonize; <dir>/ctl.sock, <dir>/screen.log
  slot-pty.py ping  <dir>                   exit 0 if the session is alive
  slot-pty.py keys  <dir> <text>            type text (use \\r for Enter, \\x03 for Ctrl+C)
  slot-pty.py show  <dir> [lines]           last lines of output, escape codes stripped
  slot-pty.py stop  <dir>                   ask the child to end (SIGTERM), then SIGKILL
The socket is only reachable by the slot user (and root); nothing here reads credentials.
"""
import fcntl, os, pty, re, select, signal, socket, struct, sys, termios, time

def sock_path(d): return os.path.join(d, "ctl.sock")

def call(d, payload, timeout=5):
    s = socket.socket(socket.AF_UNIX); s.settimeout(timeout)
    s.connect(sock_path(d)); s.sendall(payload); s.shutdown(socket.SHUT_WR)
    out = b""
    while True:
        c = s.recv(65536)
        if not c: return out
        out += c

ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]")

def serve(d, argv):
    log = os.path.join(d, "screen.log")
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.setdefault("TERM", "xterm-256color")
        os.execvp(argv[0], argv)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
    path = sock_path(d)
    try: os.unlink(path)
    except FileNotFoundError: pass
    srv = socket.socket(socket.AF_UNIX); old = os.umask(0o177); srv.bind(path); os.umask(old)
    srv.listen(64)  # a burst of clients must queue, not be refused (macOS refuses past the backlog)
    buf = b""; alive = True; died_at = None
    GRACE = 300  # keep serving this long after the child ends, so `show` can read the tail
    mine = os.stat(path).st_ino
    def reap(reaped=False):
        nonlocal alive, died_at
        if alive:
            alive = False; died_at = time.time()
            if not reaped:
                try: os.waitpid(pid, 0)
                except ChildProcessError: pass
    def absorb(data):
        nonlocal buf
        buf = (buf + data)[-200000:]
        with open(log, "wb") as f: f.write(buf)
    def child_exited():
        # A grandchild may keep the pty open, so EOF never comes. Notice the exit by waitpid,
        # but only after draining what the pty still holds, so no output is lost.
        try: done = os.waitpid(pid, os.WNOHANG)[0]
        except ChildProcessError: done = pid
        if not done: return False
        for _ in range(64):  # bounded: a grandchild that keeps writing must not trap the host here
            if not select.select([fd], [], [], 0)[0]: break
            try: data = os.read(fd, 65536)
            except OSError: break
            if not data: break
            absorb(data)
        reap(reaped=True)
        return True
    while True:
        r, _, _ = select.select([fd, srv] if alive else [srv], [], [], 1.0)
        if fd in r:
            try: data = os.read(fd, 65536)
            except OSError: data = b""
            if data: absorb(data)
            else: reap()
        if alive: child_exited()  # every pass: a grandchild that keeps writing keeps fd readable
        if not alive and died_at is not None and time.time() - died_at > GRACE:
            break
        if srv not in r: continue
        c, _ = srv.accept()
        try:
            req = b""; c.settimeout(2)
            try:
                while True:
                    x = c.recv(65536)
                    if not x: break
                    req += x
            except socket.timeout: pass
            cmd, arg = req[:1], req[1:]
            if cmd == b"K" and alive: os.write(fd, arg); c.sendall(b"ok")
            elif cmd == b"K": c.sendall(b"dead")
            elif cmd == b"P": c.sendall(b"alive" if alive else b"dead")
            elif cmd == b"S": c.sendall(buf)
            elif cmd == b"Q":
                c.sendall(b"ok")
                if alive:  # never signal a pid that was already reaped: it may be reused
                    try: os.kill(pid, signal.SIGTERM)
                    except ProcessLookupError: pass
                    end_t = time.time() + 5
                    while alive and time.time() < end_t:
                        try:
                            if os.waitpid(pid, os.WNOHANG)[0]: alive = False
                        except ChildProcessError: alive = False
                        time.sleep(0.1)
                    if alive:
                        try: os.kill(pid, signal.SIGKILL)
                        except ProcessLookupError: pass
                        reap()
                break
        except OSError:
            pass  # one client going away must never take the session down
        finally:
            c.close()
    # remove our own socket only: a newer host may have replaced it
    try:
        if os.stat(path).st_ino == mine: os.unlink(path)
    except FileNotFoundError: pass

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "start":
        d = sys.argv[2]; argv = sys.argv[3:]
        if not argv: sys.exit("start needs a command")
        if os.fork(): return
        os.setsid()
        if os.fork(): os._exit(0)
        for n in (0, 1, 2):
            os.close(n)
        os.open(os.devnull, os.O_RDWR); os.dup2(0, 1); os.dup2(0, 2)
        serve(d, argv)
    elif cmd == "ping":
        try: sys.exit(0 if call(sys.argv[2], b"P") == b"alive" else 1)
        except OSError: sys.exit(1)
    elif cmd == "keys":
        text = sys.argv[3].encode().decode("unicode_escape").encode("latin-1")
        sys.stdout.write(call(sys.argv[2], b"K" + text).decode() + "\n")
    elif cmd == "show":
        raw = ANSI.sub(b"", call(sys.argv[2], b"S")).replace(b"\r", b"")
        lines = [l for l in raw.decode("utf-8", "replace").split("\n") if l.strip()]
        n = int(sys.argv[3]) if len(sys.argv) > 3 else 20
        print("\n".join(lines[-n:]))
    elif cmd == "stop":
        try: call(sys.argv[2], b"Q", timeout=15)
        except OSError: pass
    else:
        sys.exit(__doc__)

main()
