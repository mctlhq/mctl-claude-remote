#!/usr/bin/env python3
"""Gate-2 SessionStart hook: record session_id/source with the process identity."""
import json
import os
import sys
import time

data = json.load(sys.stdin)
rec = {"t": round(time.time(), 3), "hook": data.get("hook_event_name"), "session_id": data.get("session_id"), "source": data.get("source"),
       "cwd": data.get("cwd"), "ppid": os.getppid(),
       "CLAUDE_PID": os.environ.get("CLAUDE_PID"), "env_session": os.environ.get("CLAUDE_CODE_SESSION_ID")}
with open(os.path.expanduser("~/bridge-gate2/hooks.log"), "a") as f:
    f.write(json.dumps(rec) + "\n")
