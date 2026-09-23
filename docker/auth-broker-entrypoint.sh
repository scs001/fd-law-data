#!/bin/sh
# Container entrypoint for legal-auth-broker. It starts an X server, VNC and
# noVNC for operator login, then executes the requested broker command. No
# account credentials, cookies or proxy URLs are baked into this image.
set -eu

export DISPLAY="${DISPLAY:-:99}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg}"
# Non-root Xvfb will not create the socket directory itself; the image ships it
# 1777, and this fallback covers older mounts.
mkdir -p /tmp/.X11-unix /tmp/xdg 2>/dev/null || true
chmod 1777 /tmp/.X11-unix 2>/dev/null || true
chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true

Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &
XVFB_PID=$!

wait_for_x() {
  i=0
  while [ ! -S "/tmp/.X11-unix/X${DISPLAY#*:}" ]; do
    i=$((i + 1))
    [ "$i" -gt 100 ] && { echo "Xvfb did not become ready" >&2; exit 1; }
    sleep 0.1
  done
}
wait_for_x

# VNC listens only on loopback; websockify bridges it to the in-pod noVNC port.
# Prefer -rfbauth so the password never appears in process arguments.
X11VNC_ARGS="-display $DISPLAY -forever -shared -rfbport 5900"
if [ -n "${LEGAL_AUTH_VNC_PASSWORD:-}" ]; then
  x11vnc -storepasswd "$LEGAL_AUTH_VNC_PASSWORD" /tmp/legal-auth-vncpass
  chmod 600 /tmp/legal-auth-vncpass
  X11VNC_ARGS="$X11VNC_ARGS -rfbauth /tmp/legal-auth-vncpass"
else
  X11VNC_ARGS="$X11VNC_ARGS -nopw"
fi
x11vnc $X11VNC_ARGS >/tmp/x11vnc.log 2>&1 &
X11VNC_PID=$!

websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &
NOVNC_PID=$!

cleanup() {
  kill "$NOVNC_PID" "$X11VNC_PID" "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

exec "$@"
