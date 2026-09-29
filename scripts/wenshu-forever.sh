#!/bin/bash
# Keep the wenshu supervisor alive: if it exits for any reason, restart it after a
# minute. State lives in /tmp/wenshu-nightly-state.json, so a restart resumes the
# walk where it stopped.
cd "$(dirname "$0")/.." || exit 1
LOG=/tmp/wenshu-nightly.log
while true; do
  node scripts/wenshu-nightly.mjs "$@" >> "$LOG" 2>&1
  echo "[$(date -u +%FT%TZ)] [wrapper] supervisor exited (code $?) — restarting in 60s" >> "$LOG"
  sleep 60
done
