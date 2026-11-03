# Orchestrator bridge gate spikes (2026-11-03)

Throwaway scripts used to run the two gates in
[`../chatgpt-orchestrator-bridge.md`](../chatgpt-orchestrator-bridge.md). They are
kept as the reference for the protocol facts recorded there, not as bridge code.
Standard library only; run with the system `python3` on the Mac mini.

| File | Gate | What it does |
|---|---|---|
| `wake.py` | 1 | Talks to the Codex app-server daemon over its control socket (WebSocket on a Unix socket). `wake.py list` lists threads under `~/orchestrator`; `wake.py turn <thread_id> <text>` starts a turn and prints the answer. |
| `probe.py` | 2 | Minimal stdio MCP server declaring `claude/channel`. Records its `CLAUDE*` environment, emits every `<slot>/inbox/*.txt` as a channel event, logs emits and `ack` calls. |
| `hook.py` | 2 | Hook command for `SessionStart`, `UserPromptSubmit`, `Stop` and `SubagentStop`; appends the event, `session_id`, `source` and the claude pid to `~/bridge-gate2/hooks.log`. |
| `slot.sh` | 2 | Starts one test slot: interactive `claude` with the probe channel, no claude.ai connectors. |
| `scr.sh` | 2 | Drives a slot running under GNU `screen`: send keys, dump the screen. |

Gate 2 layout on the Mac mini: `~/bridge-gate2/{A,B}/mcp.json` point `probe.py` at
the slot directory, and `~/bridge-gate2/settings.json` wires `hook.py` to the hook
events above. Slots run as `screen -dmS gate2-A ~/bridge-gate2/slot.sh A`; the
trust-folder and development-channels dialogs are answered with `scr.sh`.
