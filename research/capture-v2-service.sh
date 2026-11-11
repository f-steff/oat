#!/usr/bin/env bash
# Inspect opencode v2's shared-service registration (for discovery).
set -euo pipefail

npm i -g --prefix /opt/oc2 @opencode/cli >/dev/null 2>&1
EXE=/opt/oc2/lib/node_modules/@opencode/cli/bin/opencode.exe

echo "--- version ---"; "$EXE" --version
echo "--- service start ---"; timeout 30 "$EXE" service start || true
sleep 2
echo "--- state service.json ---"; cat "$HOME/.local/state/opencode/service.json" 2>/dev/null || echo "(none)"
echo; echo "--- config service.json ---"; cat "$HOME/.config/opencode/service.json" 2>/dev/null || echo "(none)"
echo; echo "--- service status ---"; timeout 15 "$EXE" service status 2>&1 | head -20 || true
echo "--- json files ---"; find "$HOME/.local" "$HOME/.config" -maxdepth 4 -name '*.json' 2>/dev/null | head -30
