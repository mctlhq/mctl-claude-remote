#!/usr/bin/python3
"""Isolation probe, run AS a slot user (see host-boundary-probe.sh). It tries what a hostile
slot shell could try and checks each result against what the host boundary promises. It never
prints file contents: only the uid, the attempt and ALLOWED/DENIED/ABSENT.

  host-boundary-probe.py <bridge home> <operator home> <own slot> <other slot> ... [pid=N ...]
(pid=N: a process of another user that must not be signalled)
Exit status 0 only if every attempt matched its expectation. ABSENT (the target does not
exist) is never a pass for a DENIED expectation: a probe that cannot observe proves nothing.
"""
import glob, os, socket, sys

H, OPHOME, own, *rest = sys.argv[1:]
others = [a for a in rest if not a.startswith("pid=")]
foreign = [int(a[4:]) for a in rest if a.startswith("pid=") and a[4:].isdigit()]
users = {s: f"/Users/mctl-slot-{s}" for s in [own, *others]}
rows = []

def attempt(name, expect, fn):
    try:
        fn(); got = "ALLOWED"
    except FileNotFoundError:
        got = "ABSENT"
    except PermissionError:
        got = "DENIED"
    except OSError as e:
        got = f"ERROR({e.errno})"
    ok = got == expect
    rows.append(ok)
    print(f"uid={os.getuid()} {'PASS' if ok else 'FAIL'} {name}: {got} (expected {expect})")

def read1(p):
    def f():
        with open(p, "rb") as fh: fh.read(1)
    return f
def append(p):
    def f():
        with open(p, "ab"): pass
    return f
def listdir(p): return lambda: os.listdir(p)
def connect(p):
    def f():
        s = socket.socket(socket.AF_UNIX); s.settimeout(2)
        try: s.connect(p)
        finally: s.close()
    return f

attempt("read own slot.pw", "ALLOWED", read1(f"{users[own]}/.mctl-bridge/slot.pw"))
for o in others:
    attempt(f"read slot {o}'s slot.pw", "DENIED", read1(f"{users[o]}/.mctl-bridge/slot.pw"))
    attempt(f"list slot {o}'s home", "DENIED", listdir(users[o]))
for pw in ["admin.pw", "orch.pw", f"slot-{own}.pw"] + [f"slot-{o}.pw" for o in others]:
    attempt(f"read operator-side etc/{pw}", "DENIED", read1(f"{H}/etc/{pw}"))
attempt("list operator-side etc/", "DENIED", listdir(f"{H}/etc"))
for rel in ["slot.sh", "slot-pty.py", "mctl-bridge", "host-boundary-probe.py", "host-boundary-probe.sh", "plugin/src/channel.ts", "plugin/src/ingest.ts", "plugin/hooks/state.py"]:
    attempt(f"write trusted file {rel}", "DENIED", append(f"{H}/{rel}"))
attempt("read Valkey data dir", "DENIED", listdir(f"{H}/valkey/data"))
socks = glob.glob(f"{OPHOME}/.codex/app-server-control/*.sock")
if socks:
    for s in socks: attempt(f"connect Codex control socket {os.path.basename(s)}", "DENIED", connect(s))
else:
    # not readable either: that is the boundary working, but say so rather than pass silently
    try: os.listdir(f"{OPHOME}/.codex/app-server-control"); print("FAIL no Codex socket visible to probe in a listable directory"); rows.append(False)
    except PermissionError:
        print(f"uid={os.getuid()} PASS Codex socket directory is not listable: DENIED"); rows.append(True)
    except FileNotFoundError:
        print(f"uid={os.getuid()} FAIL Codex socket directory absent, nothing observed"); rows.append(False)
# secrets in the operator home: the files are 0600 and must stay unreadable even where the
# directory above them can be traversed (the home itself is 0711)
for rel in [".codex/auth.json", ".codex/config.toml", ".codex/history.jsonl", ".config/gh/hosts.yml", ".config/claude-runner/secret.env", ".claude/.credentials.json", ".claude.json", ".zsh_history"]:
    if os.path.exists(f"{OPHOME}/{rel}"):
        attempt(f"read operator secret {rel}", "DENIED", read1(f"{OPHOME}/{rel}"))
# a process of another user must not be signalled (signal 0 only asks whether it may)
def kill0(pid):
    def f(): os.kill(pid, 0)
    return f
for pid in foreign:
    attempt(f"signal foreign pid {pid}", "DENIED", kill0(pid))
# the fixed default path, whether or not the directory can be listed: a real connect attempt
attempt("connect Codex control socket (default path)", "DENIED", connect(f"{OPHOME}/.codex/app-server-control/app-server-control.sock"))
attempt("write operator home", "DENIED", append(f"{OPHOME}/.mctl-probe-{os.getpid()}"))
sys.exit(0 if all(rows) else 1)
