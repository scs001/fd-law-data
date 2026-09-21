#!/usr/bin/env bash
# Launch the STANDING standalone Chrome for wenshu (CDP 9223) — the browser whose
# login state the crawler rides. Two details make CDP possible at all:
#   * a NON-default --user-data-dir (Chrome 136+ refuses --remote-debugging-port
#     on the default profile);
#   * the real Chrome binary, so the fingerprint stays a real browser's.
# Leave the window open (minimizing is fine). Closing it ends the wenshu session;
# the nightly supervisor logs a loud SESSION INVALID line until a human logs in
# again in this window.
#
# Usage: scripts/wenshu-nightly.sh [url]
set -euo pipefail

PROFILE="${WENSHU_PROFILE:-$HOME/.cache/fd-law-data/wenshu-standalone-profile}"
PORT="${WENSHU_CDP_PORT:-9223}"
URL="${1:-https://wenshu.court.gov.cn/website/wenshu/181029CR4M5A62CH/index.html}"

mkdir -p "$PROFILE"
open -na "Google Chrome" --args \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port="$PORT" \
  --no-first-run \
  --no-default-browser-check \
  --window-size=1300,900 \
  "$URL"

echo "standing Chrome requested: CDP http://localhost:${PORT}  profile ${PROFILE}"
