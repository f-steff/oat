# OAT — Testing Guide

## 1. Automated tests

```bash
npm run typecheck   # tsc --noEmit
npm test            # unit + integration (no external tools needed)
npm run build       # tsc emit
npm run lint        # eslint
npm run e2e:daemon  # daemon lifecycle + singleton + maintenance worker
npm run e2e         # real opencode: two servers, discovery, routing, SSE
```

CI runs `build`, `test` and `lint` on Linux (Node 20 & 22) and on macOS (Node 22). Linux can also be
exercised locally with Docker; macOS has no Docker image:

```bash
docker run --rm -v "<repo>:/src:ro" -w /tmp node:22 bash -lc \
  "cp -r /src /work && cd /work && rm -rf node_modules dist dist-test && npm ci >/dev/null && npm run typecheck && npm run build && npm test && npm run lint"
```

The helper installer is cross-platform; verify it in a container too:

```bash
docker run --rm -v "<repo>:/src:ro" node:22 bash -lc \
  "node /src/scripts/opencode2.mjs install --prefix /opt/oc2 --bin-dir /usr/local/bin && opencode2 --version && node /src/scripts/opencode2.mjs uninstall --prefix /opt/oc2 --bin-dir /usr/local/bin"
```

The two `e2e` suites need a real `opencode` binary and are therefore local/manual.

What the automated tests cover: per-OS discovery parsers; health/path probing (**v1 and v2**); routing
precedence (affinity → directory → session dir → default); proxy behavior (auth/hop-by-hop stripping,
query and directory passthrough, 503/502 semantics, WebSocket upgrades, anchor read-only); SSE merge and
`server.connected` collapse; state file + singleton handoff; supervisor caps and lazy-launch; config
and arg templates; **v1<->v2 translation** (path mapping, prompt body, response unwrap, reserve).

## 2. Manual plan — Windows (primary)

**Start**
```powershell
npm install; npm run build; npm link   # once
oat start
oat status
oat list
```

**Bridge**
```powershell
oat sesori-bridge      # == sesori-bridge --opencode-no-auto-start --opencode-port 4096
```
Expect in the bridge log: `[opencode] using existing server ... (auto-start disabled)`.

**Verify**
- [ ] Projects and sessions from every open TUI appear on the phone.
- [ ] A session running in a TUI shows **live** updates on the phone.
- [ ] A prompt from the phone runs in the same session and streams back.
- [ ] MCP tools from one project do **not** appear in another.
- [ ] Closing one TUI does not affect the others.

**Runners / lifecycle**
- [ ] `oat opencode` runs the TUI in this terminal; it appears in `oat list`.
- [ ] A prompt for a project with no instance opens a **terminal** there (resuming the session) and replies.
- [ ] Closing that terminal and prompting again reopens it.
- [ ] `oat list` shows at most one `(maintenance worker)`; no duplicates.
- [ ] `oat stop` stops the daemon and hidden servers; your terminal windows stay.
- [ ] `oat list -json` / `oat status -json` print JSON.

## 3. macOS / Linux

```bash
npm install && npm run build && npm link
npm test
OAT_PORT=4096 oat start && oat list
oat sesori-bridge
```
macOS discovery probe (standalone): `bash research/probe-macos-discovery.sh`.
Linux parser probe (Docker): `docker run --rm -v "$PWD/research:/research:ro" python:3-slim python3 /research/probe-linux-discovery.py`.

## 4. Known gaps

- Plain `opencode` TUI exposes no port (not routable) — use `oat opencode`.
- opencode v2: translation covers only the endpoints the bridge uses; v2 SSE events are passed through
  unshaped; a v2 server without a known password is not discoverable.
- PTY/WebSocket proxying is handshake-tested only.
- Distribution is source + `npm link`; no published package/binary.
- Real-opencode end-to-end tests are local/manual (no v2 e2e yet).

## 5. Troubleshooting

**`oat` is not recognized.** Not installed: `npm install && npm run build && npm link`; open a new shell.

**Bridge: `cannot reach OpenCode at port 4096 (auto-start disabled)`.** OAT isn't running there. Start
it first (`oat start`), or the bridge was started without `--opencode-no-auto-start` — use
`oat sesori-bridge`.

**`oat status`/`oat list` say `unauthorized`, or state is missing.** The daemon is up but its token
isn't on disk. Run `oat stop` (it falls back to killing the daemon pid), then `oat start`.

**Empty `oat list`.** No listening opencode server was found. Start an instance with `oat opencode`
(or `opencode serve`).

Logs: Windows `%LOCALAPPDATA%\oat\oat.log`, macOS `~/Library/Application Support/oat/oat.log`,
Linux `${XDG_STATE_HOME:-~/.local/state}/oat/oat.log`. Use `OAT_LOG_LEVEL=debug` for detail.
