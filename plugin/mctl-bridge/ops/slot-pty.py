#!/usr/bin/python3
"""Tiny pty host for one slot (replaces GNU screen, whose 2006 build exits silently for the
hidden slot users). It runs a command on a pty as the CURRENT user, detached, and offers a
control socket (mode 600, in the slot's own directory) so the operator can type into the
session and read its output:

  slot-pty.py start <dir> <cmd> [args...]   daemonize; <dir>/ctl.sock, <dir>/screen.log
  slot-pty.py ping  <dir>                   exit 0 if the session is alive
  slot-pty.py keys  <dir> <text>            type text (use \\r for Enter, \\x03 for Ctrl+C)
  slot-pty.py show  <dir> [lines]           last lines of the RENDERED screen (a small terminal emulator
                                            applies cursor moves, so redraws and spaces survive)
  slot-pty.py prompt <dir>                  JSON: is a permission prompt or dialog waiting, with its
                                            question, options and the full command/detail text
  slot-pty.py state <dir>                   JSON: alive, seconds since the last output, and the prompt
                                            (what Claude is doing; the adapter heartbeat is not)
  slot-pty.py stop  <dir>                   ask the child to end (SIGTERM), then SIGKILL
The socket is only reachable by the slot user (and root); nothing here reads credentials.
"""
import codecs, fcntl, json, os, pty, re, select, signal, socket, struct, sys, termios, time, unicodedata

def sock_path(d): return os.path.join(d, "ctl.sock")

def call(d, payload, timeout=5):
    s = socket.socket(socket.AF_UNIX); s.settimeout(timeout)
    s.connect(sock_path(d)); s.sendall(payload); s.shutdown(socket.SHUT_WR)
    out = b""
    while True:
        c = s.recv(65536)
        if not c: return out
        out += c



def query(d, tag):
    """Ask the host for its screen (R), visible grid (V) or state (A).

    A host that cannot be read is an error, never an empty screen: the screen replies always carry
    at least the grid's own line breaks, so an empty reply means the host does not know the
    command (it was started before the upgrade and still runs the old code) or went away. Reading
    that as "nothing on screen" would report a slot that waits on a permission prompt as not
    waiting.
    """
    try:
        reply = call(d, tag)
    except OSError as e:
        sys.exit(f"slot host unreachable ({e}): cannot observe this slot, its prompt state is UNKNOWN")
    if not reply:
        sys.exit("slot host sent no answer: it probably started before the upgrade and runs the old "
                 "code. Restart the slot to observe it (stop, then start); its prompt state is UNKNOWN")
    return reply

class Screen:
    """A small terminal emulator, enough to read what a TUI shows right now.

    Stripping escape codes from the byte stream (what `show` used to do) loses the cursor moves
    a TUI uses for spaces and redraws: words ran together ("gitcheckout") and a spinner's
    frames piled up. This keeps a character grid instead: printable text, CR/LF/BS/TAB, and the
    CSI cursor/erase sequences (A B C D E F G H f J K P X d). Colours, modes and everything
    else are ignored. Scrollback keeps lines that scrolled off the top.
    """
    def __init__(self, rows=50, cols=160, keep=2000):
        self.rows, self.cols, self.keep = rows, cols, keep
        self.grid = [[" "] * cols for _ in range(rows)]
        self.back = []
        self.r = self.c = 0
        self.saved = (0, 0)
        self.state = "text"; self.param = ""
        self.dec = codecs.getincrementaldecoder("utf-8")("replace")

    def _scroll(self):
        self.back.append("".join(self.grid.pop(0)).rstrip())
        del self.back[:-self.keep]
        self.grid.append([" "] * self.cols)

    def _lf(self):
        if self.r == self.rows - 1: self._scroll()
        else: self.r += 1

    def _put(self, ch):
        if unicodedata.combining(ch) or unicodedata.category(ch) in ("Mn", "Me", "Cf"):
            if self.c > 0: self.grid[self.r][self.c - 1] += ch  # takes no column of its own
            return
        w = 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
        if self.c + w > self.cols:
            self.c = 0; self._lf()
        row = self.grid[self.r]
        if row[self.c] == "" and self.c > 0: row[self.c - 1] = " "  # overwriting the second half of a wide glyph
        if w == 1 and self.c + 1 < self.cols and row[self.c + 1] == "": row[self.c + 1] = " "  # or its first half
        self.grid[self.r][self.c] = ch
        if w == 2: self.grid[self.r][self.c + 1] = ""  # the second column belongs to the glyph
        self.c += w

    def feed(self, data):
        for ch in self.dec.decode(data):
            o = ord(ch)
            if self.state == "text":
                if ch == "\x1b": self.state = "esc"
                elif ch == "\r": self.c = 0
                elif ch == "\n": self._lf()
                elif ch == "\b": self.c = max(0, self.c - 1)
                elif ch == "\t": self.c = min(self.cols - 1, (self.c // 8 + 1) * 8)
                elif o >= 32 and o != 127: self._put(ch)
            elif self.state == "esc":
                if ch == "[": self.state = "csi"; self.param = ""
                elif ch == "]": self.state = "osc"
                elif ch in "()": self.state = "skip1"
                else:
                    if ch == "7": self.saved = (self.r, self.c)
                    elif ch == "8": self.r, self.c = self.saved
                    self.state = "text"
            elif self.state == "skip1":
                self.state = "text"
            elif self.state == "osc":
                if ch == "\x07": self.state = "text"
                elif ch == "\x1b": self.state = "oscesc"
            elif self.state == "oscesc":
                self.state = "text"
            elif self.state == "csi":
                if 0x40 <= o <= 0x7e:
                    self._csi(ch, self.param); self.state = "text"
                else:
                    self.param += ch

    def _csi(self, f, p):
        if p and p[0] in "?><=!": return  # private modes, cursor style, keyboard protocol: no layout effect
        a = [int(x) if x.isdigit() else 0 for x in p.split(";")] if p else []
        n = a[0] if a and a[0] else 1
        if f == "A": self.r = max(0, self.r - n)
        elif f == "B": self.r = min(self.rows - 1, self.r + n)
        elif f == "C": self.c = min(self.cols - 1, self.c + n)
        elif f == "D": self.c = max(0, self.c - n)
        elif f == "E": self.r = min(self.rows - 1, self.r + n); self.c = 0
        elif f == "F": self.r = max(0, self.r - n); self.c = 0
        elif f == "G": self.c = min(self.cols - 1, n - 1)
        elif f in "Hf":
            self.r = min(self.rows - 1, (a[0] or 1) - 1 if a else 0)
            self.c = min(self.cols - 1, (a[1] or 1) - 1 if len(a) > 1 else 0)
        elif f == "d": self.r = min(self.rows - 1, n - 1)
        elif f == "J":
            m = a[0] if a else 0
            if m == 0:
                self.grid[self.r][self.c:] = [" "] * (self.cols - self.c)
                for i in range(self.r + 1, self.rows): self.grid[i] = [" "] * self.cols
            elif m == 1:
                self.grid[self.r][:self.c + 1] = [" "] * (self.c + 1)
                for i in range(self.r): self.grid[i] = [" "] * self.cols
            else:
                for i in range(self.rows): self.grid[i] = [" "] * self.cols
        elif f == "K":
            m = a[0] if a else 0
            if m == 0: self.grid[self.r][self.c:] = [" "] * (self.cols - self.c)
            elif m == 1: self.grid[self.r][:self.c + 1] = [" "] * (self.c + 1)
            else: self.grid[self.r] = [" "] * self.cols
        elif f == "X":
            end = min(self.cols, self.c + n)
            self.grid[self.r][self.c:end] = [" "] * (end - self.c)
        elif f == "P":
            row = self.grid[self.r]; n = min(n, self.cols - self.c)
            del row[self.c:self.c + n]; row.extend([" "] * n)

    def lines(self):
        """Scrollback plus the live grid, trailing blanks trimmed."""
        return self.back + ["".join(r).rstrip() for r in self.grid]

    def visible(self):
        return ["".join(r).rstrip() for r in self.grid]

SOLID = re.compile(r"[─━]{20,}")
DASHED = re.compile(r"^[\s╌┄┈─━│]*$")
QUESTION = re.compile(r"^\s*(?:Do you want to|Would you like to|Allow)\b.*\?\s*$")
OPTION = re.compile(r"^\s*[❯>]?\s*(\d+)\.\s+(\S.*?)\s*$")
FOOTER = re.compile(r"Enter to confirm|Esc to cancel|Press Enter to continue")

def find_prompt(lines, back=()):
    """The prompt or dialog the screen is waiting on, or None. `lines` is the visible screen;
    `back` is the scrollback above it. Only the visible screen decides whether a prompt is
    waiting (an answered prompt can still sit in the scrollback). When the box is taller than
    the screen, its head (the rule and the first lines of the command) has scrolled off: the
    detail then continues upward into `back`, up to the rule, so the command is never cut.

    A permission prompt is a question line ('Do you want to ...?') with at least two numbered
    options below it; the text between the last solid rule above it and the question is the
    command or edit being asked about, returned whole. Other dialogs (folder trust, development
    channels) are recognised by their 'Enter to confirm' / 'Esc to cancel' footer.
    """
    q = None
    for i, l in enumerate(lines):
        if QUESTION.match(l):
            opts = []
            for m in map(OPTION.match, lines[i + 1:i + 8]):
                if not m: break
                opts.append({"n": int(m.group(1)), "text": m.group(2)})
            if len(opts) >= 2: q = (i, opts)
    if q:
        i, opts = q
        j = i - 1
        while j >= 0 and not SOLID.search(lines[j]): j -= 1
        above = []
        if j < 0:
            back = list(back)
            k = len(back) - 1
            while k >= 0 and not SOLID.search(back[k]): k -= 1
            above = back[k + 1:] if k >= 0 else []  # no rule in the scrollback either: not the box's head
        body = [l.strip() for l in above + lines[max(j, 0) + (1 if j >= 0 else 0):i] if l.strip() and not DASHED.match(l)]
        return {"kind": "permission", "question": lines[i].strip(), "options": opts, "detail": body,
                "truncated": j < 0 and not above}
    if any(FOOTER.search(l) for l in lines):
        shown = [l.strip() for l in lines if l.strip() and not DASHED.match(l)]
        return {"kind": "dialog", "question": None, "options": [], "detail": shown[-15:]}
    return None

def read_prompt(d):
    """find_prompt over the live screen, with the scrollback for a box taller than the screen.
    Two reads ('V', then 'R': both answered by hosts started before this change). The
    scrollback is used only if the full read still ends with the screen just read; if the
    screen moved in between, the detail stays visible-only and says truncated."""
    vis = query(d, b"V").decode("utf-8", "replace").split("\n")
    full = query(d, b"R").decode("utf-8", "replace").split("\n")
    back = full[:-len(vis)] if len(full) > len(vis) and full[-len(vis):] == vis else []
    return find_prompt(vis, back)

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
    screen = Screen(); last_out = time.time()
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
        nonlocal buf, last_out
        screen.feed(data); last_out = time.time()
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
            elif cmd == b"R": c.sendall("\n".join(screen.lines()).encode())
            elif cmd == b"V": c.sendall("\n".join(screen.visible()).encode())
            elif cmd == b"A": c.sendall(json.dumps({"alive": alive, "idle_s": round(time.time() - last_out, 1)}).encode())
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
        lines = [l for l in query(sys.argv[2], b"R").decode("utf-8", "replace").split("\n") if l.strip()]
        n = int(sys.argv[3]) if len(sys.argv) > 3 else 20
        print("\n".join(lines[-n:]))
    elif cmd == "prompt":
        p = read_prompt(sys.argv[2])
        print(json.dumps({"pending": p is not None, "prompt": p}, ensure_ascii=False))
    elif cmd == "state":
        st = json.loads(query(sys.argv[2], b"A"))
        p = read_prompt(sys.argv[2])
        # What the adapter reports (heartbeat, busy) only says its own process is alive. Progress
        # of the Claude session is: output on the screen (idle_s) or a prompt waiting for a decision.
        print(json.dumps({**st, "prompt_pending": p is not None, "prompt": p}, ensure_ascii=False))
    elif cmd == "stop":
        try: call(sys.argv[2], b"Q", timeout=15)
        except OSError: pass
    else:
        sys.exit(__doc__)

main()
