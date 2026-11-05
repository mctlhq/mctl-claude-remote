#!/bin/sh
# Follow one task (t-), question (q-) or wake (w-) until it settles, and print a line whenever
# what is observed changes:   watch.sh ID [INTERVAL_S=15] [MAX_S=1800]
#
# Exit status: 0 settled, 4 needs the operator (delivery_unknown / wake_unknown),
#              5 not settled within MAX_S, 3 the observation itself keeps failing.
#
# Anything that is not a clean reading is printed as `WATCH-ERROR: <why>` and never as a state:
# empty or garbled output, a CLI error and an unknown id all count as "could not observe", which
# is different from "nothing to report" or "finished". Three failed readings in a row stop the
# watch with status 3 instead of looping silently.
CLI=${MCTL_BRIDGE_CLI:-$(dirname "$0")/mctl-bridge}
id=${1:?usage: watch.sh ID [INTERVAL_S] [MAX_S]}
# One reading may take this long (MCTL_BRIDGE_READING_TIMEOUT, seconds): a hung Valkey must end up as
# a printed error and not as a watch that never says anything.
limit=${MCTL_BRIDGE_READING_TIMEOUT:-20}
every=${2:-15}
max=${3:-1800}

# stdin: the CLI's stdout. Prints "OK <verdict> <line>" or "ERR <why>".
parse() {
  python3 -I -c '
import json, sys
raw = sys.stdin.read()
lines = [l for l in raw.splitlines() if l.strip()]
if not lines:
    print("ERR empty output from the CLI"); sys.exit()
try:
    d = json.loads(lines[-1])
except ValueError:
    print("ERR unreadable output: " + raw.strip()[:200].replace("\n", " ")); sys.exit()
if not isinstance(d, dict) or d.get("ok") is not True:
    code = d.get("code") if isinstance(d, dict) else None
    why = d.get("error") if isinstance(d, dict) else None
    print("ERR cli refused: " + str(code or "no ok") + (" (" + str(why) + ")" if why else "")); sys.exit()
state = d.get("state")
if not state:
    print("ERR reply carries no state"); sys.exit()
verdict = "settled" if d.get("terminal") is True else "operator" if d.get("needs_operator") is True else "running"
line = "{} {} {}".format(d.get("kind", "?"), d.get("id", "?"), state)
if d.get("reason"): line += " reason=" + str(d["reason"])
for w in d.get("wakes") or []: line += " wake {}={}".format(w.get("id"), w.get("state"))
print("OK " + verdict + " " + line)
'
}

last=""; bad=0; waited=0
while :; do
  out=$(python3 -I -c '
import subprocess, sys
try:
    r = subprocess.run([sys.argv[1], "observe", sys.argv[2]], capture_output=True, text=True, timeout=float(sys.argv[3]))
except subprocess.TimeoutExpired:
    sys.exit(124)
sys.stdout.write(r.stdout); sys.exit(r.returncode)
' "$CLI" "$id" "$limit" 2>/dev/null); rc=$?
  if [ "$rc" -eq 124 ]; then res="ERR no answer within ${limit}s"; else res=$(printf '%s\n' "$out" | parse); fi
  case $res in
    OK\ *)
      bad=0
      rest=${res#OK }; verdict=${rest%% *}; line=${rest#* }
      if [ "$line" != "$last" ]; then printf '%s\n' "$line"; last=$line; fi
      case $verdict in
        settled) exit 0 ;;
        operator) printf 'WATCH-NEEDS-OPERATOR: %s\n' "$line"; exit 4 ;;
      esac ;;
    *)
      bad=$((bad + 1))
      printf 'WATCH-ERROR: %s (cli exit %s, reading %s of 3)\n' "${res#ERR }" "$rc" "$bad"
      if [ "$bad" -ge 3 ]; then printf 'WATCH-ERROR: giving up, the state of %s could not be observed\n' "$id"; exit 3; fi ;;
  esac
  if [ "$waited" -ge "$max" ]; then printf 'WATCH-TIMEOUT: %s not settled after %ss (last: %s)\n' "$id" "$max" "$last"; exit 5; fi
  sleep "$every"; waited=$((waited + every))
done
