# OAT — OpenCode Address Translation ("The Gathering")

> **Work in progress.** This is an early, actively-developed tool; interfaces and behaviour may change.
>
> This project would not be possible without the assistance of DeepSeek, Codex, Claude, opencode, and
> Sesori. It is developed and tested to a high degree with AI tools, but is hand-coded, orchestrated
> and reviewed by Flemming Steffensen (f-steff). © 2026 f-steff.
>
> **Tested primarily on Windows 11.** Linux and macOS are supported and covered by CI (build/test/lint)
> and by discovery probes, but live end-to-end use has mostly been on Windows.

A local multiplexer that presents a single opencode-shaped HTTP+SSE endpoint, so one **Sesori Bridge**
connection drives **all your independent opencode instances** at once — without merging them into a
shared server (no MCP bleed, independent lifecycles). `sesori-bridge` attaches to one fixed port; OAT
routes each request to the right instance.

- Design: [`DESIGN.md`](DESIGN.md)
- Testing & troubleshooting: [`TESTING.md`](TESTING.md)

---

## Requirements

- **Node.js ≥ 20** and npm
- **opencode** on `PATH` — v1 (`opencode`) and/or v2 (`opencode2`); see
  [Installing opencode v1 and v2 side by side](#installing-opencode-v1-and-v2-side-by-side) (or set
  `OPENCODE_BIN` / `OAT_OPENCODE2_BIN` to a full path)
- **sesori-bridge** for the phone connection
- **git** to obtain the source

No compiler or native build tools are needed — the only dependencies are dev-time (TypeScript, ESLint).

## Install

```bash
git clone https://github.com/f-steff/oat.git
cd oat
npm install
npm run build      # required: the `oat` shim runs the compiled dist/
npm link           # puts `oat` on your PATH (Windows: %APPDATA%\npm)
oat version        # expect: 0.2.0
```

Prefer not to install a global command? Run from the repo after `npm run build`:
`bin/oat <command>` (POSIX) or `bin\oat <command>` (Windows), or `node dist/cli.js <command>`.

### Installing opencode v1 and v2 side by side

opencode v1 (`opencode-ai`) and v2 (`@opencode/cli`) **both ship a binary called `opencode`**, so a global
v2 install would overwrite v1's command. Install v1 normally, then use OAT's helper to add v2 as a
separate `opencode2` command: v2 goes into an isolated prefix, so the two never collide.

```bash
# 1. v1 — provides the `opencode` command
npm install -g opencode-ai

# 2. v2 — isolated install; provides the `opencode2` command (v1's `opencode` stays intact)
npm run opencode2:install

# 3. verify both coexist and see where each resolves
npm run opencode2:status  # lists `opencode` (v1) and `opencode2` (v2) with versions/paths
opencode  --version       # 1.x
opencode2 --version       # 2.x
```

Run either from a normal terminal — `opencode` is v1, `opencode2` is v2 — or through OAT: `oat opencode`
(v1) / `oat opencode2` (v2) / `OAT_BACKEND_VERSION=v2` (OAT-managed v2 backends).

```bash
npm run opencode2:status      # show both environments (and warn if v1 was overwritten)
npm run opencode2:uninstall   # remove the `opencode2` wrapper and the isolated v2 install (v1 untouched)
```

How it works and platform notes:

- **v1 is never touched.** v2 is installed into an isolated prefix, and the helper **refuses** a `--prefix`
  that maps onto your global bin (which is where npm would otherwise write an `opencode` shim and shadow
  v1). `npm run opencode2:status` verifies both commands and warns if v1's `opencode` came back as 2.x.
- The isolated v2 prefix defaults to `<state-dir>/opencode2`:
  Windows `%LOCALAPPDATA%\oat\opencode2`, macOS `~/Library/Application Support/oat/opencode2`,
  Linux `${XDG_STATE_HOME:-~/.local/state}/oat/opencode2`.
- The `opencode2` wrapper is written to your npm global bin (Windows `npm prefix -g`; on Linux/macOS its
  `bin/`), which is already on `PATH`. On Linux/macOS that may need `sudo`; alternatively write it to a
  dir already on `PATH`, e.g. `npm run opencode2:install -- --bin-dir ~/.local/bin`.
- The helper passes `--allow-scripts=@opencode/cli` so the package's postinstall can download/select the
  native binary (npm blocks install scripts by default). Change locations with `--prefix`/`--bin-dir`,
  and pin a release with `npm run opencode2:install -- --version 2.0.15`.
- Uninstall leaves v1 fully intact; re-run `npm run opencode2:install` any time to restore v2.

## Start

```bash
oat start          # starts a detached daemon; returns immediately to your prompt
oat status         # pid, port, backend count
oat list           # discovered opencode instances
```

Then point the bridge at OAT (the only Sesori-side change):

```bash
oat sesori-bridge  # == sesori-bridge --opencode-no-auto-start --opencode-port <port>
```

## How it behaves

| Situation | OAT's behavior |
|---|---|
| opencode instances running | Discovers them and routes the bridge to the right one |
| Phone **browses/history** for a project with no instance | Served by a persistent hidden **maintenance worker** (reads the shared DB) — no process per project |
| Phone **acts** (prompt / new session) on a project with no instance | Opens a **visible terminal** there running opencode (resumes the session you're viewing) and routes to it |
| Nothing running | The maintenance worker answers reads; no per-project processes until you act |
| `oat stop` | Stops the daemon and any **hidden** servers it started; terminal windows you launched are left alone |

Default port is `OPENCODE_PORT` or **4096**. OAT and the bridge must use the same port.

## Running v1 and v2 with OAT in parallel

One OAT daemon can drive a **mix of v1 and v2 instances at the same time**. It detects each backend's
generation (v1 answers `/global/health`; v2 answers `/api/info` behind HTTP Basic auth), tags it, and
routes per project directory. Because the Sesori bridge speaks v1, OAT also translates v1↔v2 — so the
phone can drive v2 instances with **no bridge change**.

```bash
oat start                     # one OAT daemon

cd ~/proj-a && oat opencode   # v1 TUI (OAT injects a port so it is discoverable)
cd ~/proj-b && oat opencode2  # v2 TUI as a private server (password exported for OAT)

oat list                      # both appear, distinguished by VERSION (1.x vs 2.x)
oat sesori-bridge             # the bridge reaches both through OAT
```

- Lazily-started backends (a phone action for a project with no instance) use the generation from
  `OAT_BACKEND_VERSION` (`v1` by default; `v2` starts `opencode2 serve`). `oat opencode2` instances are
  always v2.
- `oat stop` stops the daemon and any hidden OAT-started servers; your own `opencode`/`opencode2` windows
  are left alone.

Internals:

- **Discovery** probes `/global/health` (v1) then `/api/info` with the known password (v2), and tags each
  backend with its generation.
- **Managed v2** (`OAT_BACKEND_VERSION=v2`): OAT starts `opencode2 serve --port <n>` per project with an
  OAT-chosen `OPENCODE_SERVER_PASSWORD`, and adds `Authorization: Basic` upstream.
- **`oat opencode2 [args]`** runs the v2 TUI as a private server (`--standalone`) with that password
  exported; `oat opencode` remains for v1.
- **Translation** (`OAT_TRANSLATE_V2`, on by default) maps the bridge's v1 requests onto v2 `/api/*` and
  translates v2 responses/events back to v1 shapes; set `OAT_TRANSLATE_V2=0` once the bridge speaks v2.

The v2 path is newer and less battle-tested than v1; see Known limitations.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `OPENCODE_PORT` / `OAT_PORT` | `4096` | Port OAT listens on (bridge must match) |
| `OAT_HOST` | `127.0.0.1` | Bind host |
| `OAT_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `OAT_LOG_FILE` | `<state>/oat.log` | Log file (or `oat start --log-file <path>`) |
| `OAT_LAUNCH_TERMINAL` | `1` | `0` = start hidden servers instead of terminals |
| `OAT_LAUNCH_CMD` | per-OS default | Terminal template, supports `{dir}` and `{title}` |
| `OAT_ANCHOR` | `1` | Persistent hidden maintenance worker for reads (`0` disables) |
| `OPENCODE_BIN` | `opencode` | opencode executable |
| `OAT_BRIDGE_BIN` | `sesori-bridge` | Bridge executable used by `oat sesori-bridge` |
| `OAT_BRIDGE_ARGS` | `--opencode-no-auto-start --opencode-port {port}` | Args injected before your bridge args (`{port}`, `{host}`) |
| `OAT_OPENCODE_ARGS` | `--port {host_port} --hostname {host}` | Args injected by `oat opencode` when no network flag is given |
| `OAT_BACKEND_VERSION` | `v1` | Generation OAT starts for projects (`v2` uses `opencode2 serve`) |
| `OAT_OPENCODE2_BIN` | `opencode2` | opencode v2 executable (isolated install or PATH) |
| `OAT_OPENCODE2_ARGS` | `serve --port {host_port} --hostname {host}` | Args for a managed v2 server |
| `OAT_V2_PASSWORD` | generated per daemon | Password OAT sets as `OPENCODE_SERVER_PASSWORD` for v2 servers |
| `OAT_V1_PASSWORD` | `OPENCODE_SERVER_PASSWORD` | Password for password-protected v1 servers (Basic auth) |
| `OAT_TRANSLATE_V2` | `1` | Translate v1<->v2 for the bridge (`0` disables) |
| `OAT_MAX_INSTANCES` | `32` | Safety cap on concurrently running OAT-started instances |
| `OAT_SPAWNS_PER_MINUTE` | `6` | Burst guard: max new instances started per rolling minute |
| `OAT_STATE_DIR` | per-OS | Where state/logs live |

Log/state locations: Windows `%LOCALAPPDATA%\oat`, macOS `~/Library/Application Support/oat`,
Linux `${XDG_STATE_HOME:-~/.local/state}/oat`.

## Commands

```
oat                       start (detached) if needed, then show status
oat start                 start the daemon (idempotent)
oat status                show daemon status
oat list                  list discovered opencode backends
oat reload                re-scan for opencode backends
oat stop                  stop the daemon
oat opencode [args]       run opencode in this terminal (args after 'opencode' go to opencode)
oat opencode2 [args]      run opencode v2 in this terminal as a private server (args pass through)
oat sesori-bridge [args]  run the bridge here, pointed at OAT (args pass through)
oat serve                 run the daemon in the foreground (internal)
oat version               print version
```

`status` and `list` print a readable table and refresh discovery first; append `-json` for JSON
(`oat list -json`).

### `oat opencode`

Runs opencode **in the terminal you are in** (arguments after `opencode` pass through), ensuring the
daemon is up so the bridge connects to it. Because a plain opencode TUI exposes no port, OAT injects a
free `--port`/`--hostname` so the instance is discoverable.

```bash
cd <project>
oat opencode                 # opencode TUI, here, in this folder
oat opencode -s ses_...      # any opencode args pass through
```

### `oat sesori-bridge`

Runs the bridge in the current terminal, pointed at OAT. The injected flags are a template
(`OAT_BRIDGE_ARGS`); `oat --port 5000 sesori-bridge` moves both off a busy 4096.

### `oat opencode2`

Runs opencode **v2** in the current terminal as a private server (`--standalone`) so it stays
per-project, exporting `OPENCODE_SERVER_PASSWORD` so OAT can discover and route to it. Arguments pass
through. Use `oat opencode` (not `opencode2`) for a v1 TUI.

```bash
cd <project>
oat opencode2                 # v2 TUI, private server, this folder
oat opencode2 --server http://127.0.0.1:4096   # or attach to a specific server
```

## Known limitations

- A plain `opencode` TUI (started without `--port`/`--hostname`) exposes **no port** and is not
  routable. Use `oat opencode` (injects a port), `opencode serve`, or `opencode --port N`.
- **opencode v2 support is newer and less tested than v1.** v2 backends must be reachable with a known
  password (`OAT_V2_PASSWORD`); user-started v2 servers without it are not discoverable. The v1<->v2
  **translation** covers the endpoints the bridge uses and is intentionally partial (see
  `OAT_TRANSLATE_V2`); v2 SSE events are passed through without per-type reshaping.
- A **standalone launcher shim** for opencode is not implemented.
- **PTY/WebSocket** proxying is implemented but only handshake-tested; no live PTY test yet.
- Distribution is **source + `npm link`** only; no published package or single binary.
- The daemon's port is **unauthenticated** and bound to loopback by default.
- OAT assumes a **single daemon**; multiple daemons are not coordinated.
- Real-opencode end-to-end tests are local/manual (they need opencode installed). Cross-OS checks run on
  Windows + Linux (Docker) locally and include a macOS CI job (no macOS Docker image exists).

## Known issues

Bugs we are aware of, with upstream links where the cause is outside OAT.

- **A prompt sent from the phone appears twice in the local opencode TUI** (the model/tool runs once).
  The Sesori Bridge reserves a user message and then re-dispatches it with the same `messageID` and
  `parts`, so opencode appends the text a second time. OAT only proxies the two calls. Tracked upstream:
  [sesori-ai/sesori_apps_monorepo#1596](https://github.com/sesori-ai/sesori_apps_monorepo/issues/1596).

## Run at login (optional)

- **Windows:** Task Scheduler → at logon → `oat start` (user context).
- **macOS:** a LaunchAgent running `oat start`.
- **Linux:** a systemd `--user` unit, or an autostart entry.

## Uninstall

```bash
oat stop
npm unlink -g oat
```

## License

MIT — see [`LICENSE`](LICENSE). © 2026 f-steff.
