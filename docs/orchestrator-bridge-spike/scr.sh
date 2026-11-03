#!/bin/zsh
# scr.sh <slot> show | keys <printf-escaped string>
s=$1; shift
if [ "$1" = keys ]; then screen -S gate2-$s -p 0 -X stuff "$(printf "$2")"; sleep ${3:-2}; fi
screen -S gate2-$s -p 0 -X hardcopy -h /tmp/gate2-$s.txt; sleep 0.5
LC_ALL=C tr -cd "[:print:]\n" < /tmp/gate2-$s.txt | grep -v "^\s*$" | tail -${LINES_N:-14}
