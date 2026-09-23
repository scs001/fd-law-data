#!/bin/sh
# Container entrypoint for legal-auth-broker. It starts an X server, VNC and
# noVNC for operator login, then executes the requested broker command. No
# account credentials, cookies or proxy URLs are baked into this image.
set -eu

export DISPLAY="${DISPLAY:-:99}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &
XVFB_PID=$!

wait_for_x() {
  i=0
  while ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -gt 100 ] && { echo "Xvfb did not become ready" >&2; exit 1; }
    sleep 0.1
  done
}
wait_for_x

# VNC listens only on loopback; websockify bridges it to the in-pod noVNC port.
x11vnc -display "$DISPLAY" -forever -shared -rfbport 5900 \
  ${LEGAL_AUTH_VNC_PASSWORD:+-passwd "$LEGAL_AUTH_VNC_PASSWORD"} \
  ${LEGAL_AUTH_VNC_PASSWORD:- -nopw} >/tmp/x11vnc.log 2>&1 &
X11VNC_PID=$!

websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &
NOVNC_PID=$!

cleanup() {
  kill "$NOVNC_PID" "$X11VNC_PID" "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

exec "$@"
