#!/usr/bin/env python3
"""mctl-bridge hook: record the session's busy/idle state for the slot adapter.

Wired to SessionStart, UserPromptSubmit and Stop. Writes
<state dir>/<claude pid>.json atomically (temp file + rename) with
session_id, state (busy|idle), the hook event and a timestamp. It holds no
Valkey credentials and never blocks Claude Code: any failure exits 0.

UserPromptSubmit fires for channel events as well as typed prompts, so an
emitted task marks the slot busy; Stop marks it idle at the end of the turn.
"""
import json
import os
import sys
import tempfile
import time

EVENTS = {"SessionStart": "idle", "UserPromptSubmit": "busy", "Stop": "idle"}


def main() -> None:
    data = json.load(sys.stdin)
    event = data.get("hook_event_name")
    if event not in EVENTS:
        return
    pid = os.environ.get("CLAUDE_PID") or str(os.getppid())
    state_dir = os.environ.get("MCTL_BRIDGE_STATE_DIR") or os.path.expanduser("~/.mctl-bridge/state")
    os.makedirs(state_dir, mode=0o700, exist_ok=True)
    path = os.path.join(state_dir, f"{pid}.json")
    try:
        with open(path) as f:
            record = json.load(f)
        if not isinstance(record, dict):
            record = {}
    except (OSError, ValueError):
        record = {}
    if data.get("session_id"):
        record["session_id"] = data["session_id"]
    if event == "SessionStart":
        record["source"] = data.get("source")
    record.update(state=EVENTS[event], event=event, t=time.time())
    fd, tmp = tempfile.mkstemp(dir=state_dir, prefix=".state-")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(record, f)
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # never block the session
        print(f"mctl-bridge state hook: {exc}", file=sys.stderr)
    sys.exit(0)
