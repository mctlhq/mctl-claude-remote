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
  out=$("$CLI" observe "$id" 2>/dev/null); rc=$?
  res=$(printf '%s\n' "$out" | parse)
  case $res in
    OK\ *)
      bad=0
      rest=${res#OK }; verdict=${rest%% *}; line=${rest#* }
      if [ "$line" != "$last" ]; then echo "$line"; last=$line; fi
      case $verdict in
        settled) exit 0 ;;
        operator) echo "WATCH-NEEDS-OPERATOR: $line"; exit 4 ;;
      esac ;;
    *)
      bad=$((bad + 1))
      echo "WATCH-ERROR: ${res#ERR } (cli exit $rc, reading $bad of 3)"
      if [ "$bad" -ge 3 ]; then echo "WATCH-ERROR: giving up, the state of $id could not be observed"; exit 3; fi ;;
  esac
  if [ "$waited" -ge "$max" ]; then echo "WATCH-TIMEOUT: $id not settled after ${max}s (last: $last)"; exit 5; fi
  sleep "$every"; waited=$((waited + every))
done
