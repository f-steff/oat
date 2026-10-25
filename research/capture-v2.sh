#!/usr/bin/env bash
# Capture real opencode v2 HTTP shapes into a fixtures directory.
#
# Usage (from a container with node + npm, repo mounted somewhere):
#   bash research/capture-v2.sh /fixtures
#
# Installs @opencode/cli into an isolated prefix, starts `serve` with a known
# password, exercises the read/create endpoints + the event stream, and writes
# JSON/text fixtures. Nothing leaves the container except the fixtures dir.
set -euo pipefail

OUT="${1:-/fixtures}"
PASS="fixture-pass"
PORT="${2:-41731}"
PREFIX=/opt/oc2
WORK=/work/proj

mkdir -p "$OUT" "$WORK"
npm install -g --prefix "$PREFIX" @opencode/cli >/dev/null 2>&1
EXE="$PREFIX/lib/node_modules/@opencode/cli/bin/opencode.exe"
[ -x "$EXE" ] || EXE="$PREFIX/lib/node_modules/@opencode/cli/bin/opencode"

export OPENCODE_SERVER_PASSWORD="$PASS"
"$EXE" serve --port "$PORT" --hostname 127.0.0.1 >/work/serve.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT

# Wait for the API to answer.
for _ in $(seq 1 40); do
  if curl -sf -u "opencode:$PASS" "http://127.0.0.1:$PORT/api/info" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

B="http://127.0.0.1:$PORT"
AUTH="opencode:$PASS"
get() { curl -s -u "$AUTH" "$B$1" -o "$OUT/$2" || true; }

get "/api/info" info.json
get "/api/location?directory=$WORK" location.json
get "/api/agent" agent.json
get "/api/provider" provider.json
get "/api/command" command.json
get "/api/model" model.json
get "/api/config" config.json
get "/api/project" project.json
get "/api/session" session-list-empty.json
get "/api/session/active" session-active.json
get "/doc" doc.html
get "/api/doc" api-doc.json

# Capture the event stream across a full (short) turn.
( timeout 25 curl -s -N -u "$AUTH" "$B/api/event" > "$OUT/events.txt" 2>/dev/null ) &
EV=$!
sleep 1

SID=$(curl -s -u "$AUTH" -X POST -H 'content-type: application/json' -d '{"title":"fixture"}' "$B/api/session" \
  | tee "$OUT/session-create.json" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.data&&j.data.id)||j.id||"")}catch{console.log("")}})')
echo "session=$SID"

sleep 1
get "/api/session" session-list.json
get "/api/session/$SID" session-get.json

# Run a short, cheap turn so message/part shapes and a full event sequence are captured.
curl -s -u "$AUTH" -X POST -H 'content-type: application/json' \
  -d '{"text":"Reply with exactly: OK","model":{"providerID":"opencode","modelID":"mimo-v2.6-flash-free"}}' \
  "$B/api/session/$SID/prompt" -o "$OUT/session-prompt.json" || true

# Wait for the turn to settle, then capture the projected messages.
sleep 20
get "/api/session/$SID/message" session-messages.json
get "/api/session" session-list-after.json

wait $EV 2>/dev/null || true

# Never leave the fixture password in the outputs.
if command -v grep >/dev/null; then
  grep -rl "$PASS" "$OUT" 2>/dev/null | while read -r f; do sed -i "s/$PASS/REDACTED/g" "$f"; done || true
fi

echo "--- captured into $OUT ---"
ls -la "$OUT"
