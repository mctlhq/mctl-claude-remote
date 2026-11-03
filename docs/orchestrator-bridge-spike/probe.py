#!/usr/bin/env python3
"""Gate-2 probe channel: minimal stdio MCP server declaring claude/channel.

probe.py <slot_dir>
  - records its CLAUDE_* environment to <slot_dir>/env-<pid>.json
  - emits every <slot_dir>/inbox/*.txt as a channel event (meta token = file stem)
  - logs emit and ack times to <slot_dir>/events.log
"""
import json
import os
import sys
import threading
import time

SLOT = os.path.abspath(sys.argv[1])
INBOX = os.path.join(SLOT, "inbox")
SENT = os.path.join(SLOT, "sent")
LOG = os.path.join(SLOT, "events.log")
os.makedirs(INBOX, exist_ok=True)
os.makedirs(SENT, exist_ok=True)
lock = threading.Lock()


def log(event, **kw):
    with open(LOG, "a") as f:
        f.write(json.dumps({"t": round(time.time(), 3), "pid": os.getpid(), "event": event, **kw}) + "\n")


def write(msg):
    with lock:
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()


with open(os.path.join(SLOT, f"env-{os.getpid()}.json"), "w") as f:
    json.dump({"ppid": os.getppid(), "env": {k: v for k, v in os.environ.items() if k.startswith("CLAUDE")}}, f, indent=1)
log("start", ppid=os.getppid(), session_env=os.environ.get("CLAUDE_CODE_SESSION_ID"))

ready = threading.Event()


def pump():
    ready.wait()
    while True:
        for name in sorted(os.listdir(INBOX)):
            if not name.endswith(".txt"):
                continue
            src = os.path.join(INBOX, name)
            token = name[:-4]
            with open(src) as f:
                content = f.read()
            os.rename(src, os.path.join(SENT, name))
            write({"jsonrpc": "2.0", "method": "notifications/claude/channel",
                   "params": {"content": content, "meta": {"token": token}}})
            log("emitted", token=token)
        time.sleep(0.5)


threading.Thread(target=pump, daemon=True).start()

TOOLS = [{
    "name": "ack",
    "description": "Acknowledge a probe channel event by its token.",
    "inputSchema": {"type": "object", "properties": {"token": {"type": "string"}}, "required": ["token"]},
}]

for line in sys.stdin:
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    method, mid = msg.get("method"), msg.get("id")
    if method == "initialize":
        write({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": msg["params"].get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {}, "experimental": {"claude/channel": {}}},
            "serverInfo": {"name": "probe", "version": "0.0.1"},
            "instructions": ('Test events arrive as <channel source="probe" token="...">. For each one, call the '
                             'ack tool with its token, then answer in one short line. Nothing else.'),
        }})
    elif method == "notifications/initialized":
        ready.set()
        log("initialized")
    elif method == "tools/list":
        write({"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}})
    elif method == "tools/call":
        token = msg["params"].get("arguments", {}).get("token", "")
        log("ack", token=token)
        write({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": f"acked {token}"}]}})
    elif mid is not None:
        write({"jsonrpc": "2.0", "id": mid, "result": {}})
log("stdin closed")
