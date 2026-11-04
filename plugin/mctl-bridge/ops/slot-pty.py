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
    srv.listen(4)
    buf = b""; alive = True; status = None
    while True:
        r, _, _ = select.select([fd, srv] if alive else [srv], [], [], 1.0)
        if fd in r:
            try: data = os.read(fd, 65536)
            except OSError: data = b""
            if data:
                buf = (buf + data)[-200000:]
                with open(log, "wb") as f: f.write(buf)
            else:
                alive = False
                try: _, status = os.waitpid(pid, 0)
                except ChildProcessError: pass
        if srv in r:
            c, _ = srv.accept(); req = b""
            c.settimeout(2)
            try:
                while True:
                    x = c.recv(65536)
                    if not x: break
                    req += x
            except socket.timeout: pass
            cmd, arg = req[:1], req[1:]
            if cmd == b"K" and alive: os.write(fd, arg); c.sendall(b"ok")
            elif cmd == b"P": c.sendall(b"alive" if alive else b"dead")
            elif cmd == b"S":
                c.sendall(buf)
            elif cmd == b"Q":
                c.sendall(b"ok")
                try: os.kill(pid, signal.SIGTERM)
                except ProcessLookupError: pass
                t = time.time()
                while alive and time.time() - t < 5:
                    try:
                        p, _ = os.waitpid(pid, os.WNOHANG)
                        if p: alive = False
                    except ChildProcessError: alive = False
                    time.sleep(0.1)
                if alive:
                    try: os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                c.close(); break
            c.close()
        if not alive and status is not None and not select.select([srv], [], [], 0)[0]:
            # keep serving so `show` can read the last output; a later stop removes the socket
            pass
    try: os.unlink(path)
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
