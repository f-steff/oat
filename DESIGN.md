# OAT — Design

OAT (OpenCode Address Translation) is a local multiplexer that lets **one** Sesori Bridge connection
drive **many** independent opencode instances. It presents a single opencode-shaped HTTP + SSE endpoint
on a fixed port and routes each request to the right instance, so each opencode process keeps its own
MCP/config and lifecycle.

See [`README.md`](README.md) for install/usage and [`TESTING.md`](TESTING.md) for the test plan.

## 1. Background

- Sesori's opencode integration is an HTTP + SSE client pointed at **one** base URL.
- Each interactive opencode runs its own server on its own port; recent versions even embed the server
  unless a network flag (`--port`/`--hostname`) is given, so a plain TUI listens on **nothing**.
- The common workaround (force every TUI onto one shared server) causes MCP/config bleed and couples
  all lifecycles.

## 2. Architecture

```
sesori-bridge ──HTTP/SSE──> OAT (one port) ──HTTP/WS/SSE──> opencode instance A
                                            ├──────────────> opencode instance B
                                            └──────────────> maintenance worker (hidden)
```

Components (`src/`):

- `discovery/ports.ts` — per-OS enumeration of LISTEN sockets.
- `discovery/discover.ts` — probes `/global/health` + `/path`; ignores OAT's own servers.
- `router.ts` — chooses a backend for a request.
- `registry.ts` — discovered + managed backends, plus per-session affinity.
- `server.ts` — the mux: local health, SSE fan-in, HTTP + WebSocket proxy, `/__oat/*` control API.
- `supervisor.ts` — starts/stops hidden servers; lazy per-project instances; caps.
- `launcher.ts` — opens terminals; resolves executables; kills processes.
- `sse.ts` — SSE parsing/merging.
- `state.ts` / `control.ts` / `config.ts` / `cli.ts` — lifecycle, control handoff, CLI.

### 2.1 Discovery (per OS)

| OS | Method |
|---|---|
| Windows | `Get-NetTCPConnection -State Listen` (with PID) |
| Linux | `/proc/net/tcp{,6}` (state `0A`) + inode→PID via `/proc/<pid>/fd` |
| macOS | `lsof -nP -iTCP -sTCP:LISTEN` (fallback `netstat -anv -p tcp`) |

Each candidate is confirmed with `GET /global/health` then `GET /path` (its own directory). OAT's own
servers (version `oat/…`, or running in an `…/oat*/anchor` directory) are excluded.

### 2.2 Routing (priority)

1. **Session affinity** — a session already served by a backend stays there.
2. **`x-opencode-directory`** (header or `?directory=`) — longest-prefix match, sandbox-aware.
3. **Session directory** — resolved from a session id when no directory header is present.
4. **Default** — a real backend if any, else the maintenance worker.

Reads and actions are treated differently:

- **Reads** (`GET`) for an unowned project are served from the shared DB via the **maintenance worker**
  — routine scans never spawn a process per project.
- **Run actions** (`POST /session`, `…/message`, `…/prompt_async`, `…/command`, `…/shell`,
  `…/summarize`, `…/init`) start a **dedicated instance** for that project and are never routed to an
  unrelated instance. If only a session id is present, OAT resolves its directory via the worker first.

`/session/status`, `/question`, `/permission` are live per-server state and are aggregated.

### 2.3 SSE fan-in

One `/global/event` consumer per backend, merged into a single downstream `text/event-stream`;
duplicate `server.connected` events are collapsed, and upstreams reconnect with backoff.

### 2.4 Lifecycle

- On start OAT binds its port, writes a state file, and serves `/__oat/identity` (public) plus a
  token-guarded control API (`status`, `list`, `reload`, `stop`).
- A second `oat` invocation detects the running daemon and hands control to it; a bare `oat` starts a
  detached daemon.
- On stop: hidden servers are killed, connections force-closed, state removed, process exits quickly.

### 2.5 Maintenance worker and lazy instances

- **Maintenance worker** (`OAT_ANCHOR`, on by default): a persistent hidden opencode that answers reads
  from the shared DB. It is never used for chat and never listed as a backend.
- **Lazy per-project instances**: a run action for an unowned project opens a visible terminal running
  opencode (with an injected port, resuming the viewing session) and routes to it. Hidden-server
  fallback if a terminal cannot open. Closed instances are reopened after a grace window.
- **Caps**: `OAT_MAX_INSTANCES` (default 32 concurrent) and `OAT_SPAWNS_PER_MINUTE` (default 6) bound
  resource use.

### 2.6 Runners

- `oat opencode [args]` — runs opencode in the current terminal (`stdio: inherit`), injecting
  `OAT_OPENCODE_ARGS` when no network flag is given.
- `oat sesori-bridge [args]` — runs the bridge in the current terminal, injecting `OAT_BRIDGE_ARGS`
  (`--opencode-no-auto-start --opencode-port {port}`) so it attaches to OAT.

## 3. Key decisions

| Decision | Why |
|---|---|
| **External tool**, no Sesori changes | Validated by a spike and source review; avoids forking the bridge. |
| **Reads via the shared DB; only actions spawn** | Prevents a window per project during startup scans; keeps MCP isolation. |
| **Maintenance worker is read-only** | A prompt can never run in the wrong directory. |
| **Visible terminal for lazy starts + injected port** | Usable by the user and discoverable/routable. |
| **Env-templated injected args** (`{port}`/`{host}`/`{host_port}`) | Adapts to Sesori/opencode flag changes without code edits. |
| **Placeholders use `{}`** | Not expanded by bash/PowerShell/cmd (unlike `${}`/`%%`). |
| **Anchors never listed; reaped on start/stop** | Orphaned workers cannot masquerade as projects. |
| **`oat stop` kills only the daemon pid** | Never closes your terminal windows. |

## opencode v1 / v2

opencode v2 changes the model: endpoints live under `/api/*` behind HTTP Basic auth (user `opencode`,
password printed or set via `OPENCODE_SERVER_PASSWORD`), and the CLI ships as `@opencode/cli`. v2 also
migrates opencode's shared DB in place, so OAT targets **one active generation** (whichever `opencode` is
installed) rather than driving both against the same data directory.

- **Detection** (`generation.ts`): ask the installed `opencode` for its version (`1.x` = v1,
  `opencode v2.x` = v2); `OAT_BACKEND_VERSION=auto` (default) uses this, `v1`/`v2` force it. Per request,
  discovery probes v1 `/global/health`, else v2 `/api/info` with the known password; each `Backend` is
  tagged `kind: "v1" | "v2"` and, when known, carries its `password`.
- **Launching** (`cli.ts`/`supervisor.ts`): `oat opencode` follows the detected generation — v1 injects a
  `--port`/`--hostname`; v2 runs a private server (`--standalone`) with `OPENCODE_SERVER_PASSWORD`.
  Lazily-started backends: v1 opens a visible terminal; v2 starts a hidden `opencode serve --port <n>`.
- **Auth** (`server.ts`): the proxy and WebSocket replay add `Authorization: Basic` for any backend that
  carries a password (v2 always; v1 when `OPENCODE_SERVER_PASSWORD`/`OAT_V1_PASSWORD` is set).
- **Translation** (`translate.ts`, `OAT_TRANSLATE_V2`): the bridge speaks v1, so OAT maps the v1 routes
  it uses onto v2 — `/session/:id/{message,prompt_async}` → `/api/session/:id/prompt`, `abort` →
  `interrupt`, `/path` → `/api/location`, etc. — passes `x-opencode-directory` as the `directory` query,
  unwraps v2's `{data}` envelopes, and answers a v1 `noReply` "reserve" locally (v2 has no reserve and
  would otherwise double-admit the user message). v2 `/api/event` is fanned in like v1 `/global/event`.
- **Status** (`cli.ts`): `oat status` reports the daemon's generation; `oat list` shows each backend's
  `KIND`.

This layer is deliberately partial and toggleable: set `OAT_TRANSLATE_V2=0` once the bridge speaks v2.

## 4. Learnings (brief)

- Interactive opencode exposes **no TCP port** unless a network flag is passed → OAT must inject a port.
- The opencode DB is **global**, so global reads are identical on any server — hence one worker suffices.
- A prompt is two calls (`/message` reserve + `/prompt_async`); they must hit the **same** instance or
  the user message is duplicated.
- Long-lived child processes can hang supervising shells; OAT must run **detached**.
- Killing a process **tree** (`taskkill /T`) can close terminal tabs; kill only the target pid.

## 5. Known limitations

See the "Known limitations" section in [`README.md`](README.md).
