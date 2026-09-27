#!/bin/bash
S=$1; cd "/Users/christianvidalwolf/AMAZON AWS SP-API"
while read g; do [ -n "$g" ] && .venv/bin/python $S/run_auto.py $S $3 $g submit 2>&1 | tail -2; done < $S/$4_$2.txt
