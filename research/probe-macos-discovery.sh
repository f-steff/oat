#!/usr/bin/env bash
# R1 probe for macOS (Apple Silicon M2): determine the best way to enumerate
# LISTEN TCP sockets and map them to PIDs, so OAT's discovery works on macOS.
#
# Usage:  bash probe-macos-discovery.sh [test-port]
# Default test port: 46123. Non-destructive; removes its own listener on exit.
set -u

PORT="${1:-46123}"
echo "=== OAT macOS discovery probe ==="
echo "uname : $(uname -a)"
echo "test  : 127.0.0.1:$PORT"
echo

LISTENER_PID=""
cleanup() {
  if [ -n "$LISTENER_PID" ]; then
    kill "$LISTENER_PID" 2>/dev/null || true
  fi
  rm -f /tmp/oat_probe_listener 2>/dev/null || true
}
trap cleanup EXIT

start_listener() {
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$PORT" <<'PY' &
import socket, sys, time
port = int(sys.argv[1])
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", port))
s.listen(1)
time.sleep(60)
PY
    LISTENER_PID=$!
    disown 2>/dev/null || true
  elif command -v nc >/dev/null 2>&1; then
    nc -l 127.0.0.1 "$PORT" >/dev/null 2>&1 &
    LISTENER_PID=$!
    disown 2>/dev/null || true
  else
    echo "FAIL: neither python3 nor nc available to create a test listener."
    exit 1
  fi
}

echo "--- tool availability ---"
for t in lsof netstat ss nc python3 pgrep; do
  printf '%-8s ' "$t"
  command -v "$t" || echo MISSING
done
echo

start_listener
sleep 1
echo "listener pid: $LISTENER_PID"
echo

# Check whether a command's output identifies the test port, and show the matching lines.
probe() {
  name="$1"; shift
  out="$("$@" 2>/dev/null)"
  if printf '%s\n' "$out" | grep -Eq "[.:]${PORT}([^0-9]|$)"; then
    echo "PASS  $name  -> found $PORT"
    printf '%s\n' "$out" | grep -E "[.:]${PORT}([^0-9]|$)" | head -3 | sed 's/^/        /'
  else
    echo "FAIL  $name  -> did not find $PORT"
  fi
}

echo "--- enumeration methods ---"
if command -v lsof >/dev/null 2>&1; then
  probe "lsof -nP -iTCP -sTCP:LISTEN" lsof -nP -iTCP -sTCP:LISTEN
  pid="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ')"
  echo "        pid via lsof -t: ${pid:-<none>}"
fi

if command -v netstat >/dev/null 2>&1; then
  probe "netstat -anv -p tcp" netstat -anv -p tcp
fi

if command -v ss >/dev/null 2>&1; then
  probe "ss -ltnp" ss -ltnp
fi

echo
echo "--- process discovery ---"
if command -v pgrep >/dev/null 2>&1; then
  echo "pgrep -fl opencode: $(pgrep -fl opencode 2>/dev/null | head -3 | tr '\n' '|')"
fi

echo
echo "=== recommendation ==="
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Use: lsof -nP -iTCP -sTCP:LISTEN   (gives port + PID; bundled with macOS)"
  echo "Targeted PID for one port: lsof -nP -iTCP:<port> -sTCP:LISTEN -t"
else
  echo "lsof unavailable/blocked; fall back to 'netstat -anv -p tcp' (no PID) + pgrep."
fi
echo
echo "Note: macOS has no /proc. lsof is the portable method; if it is ever"
echo "restricted, netstat lists sockets but not owning PIDs."
