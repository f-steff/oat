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
- **opencode** on `PATH` (or set `OPENCODE_BIN` to its full path)
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

### Running opencode v1 and v2 side by side

opencode v2 (`@opencode/cli`) also ships an `opencode` binary, so installing it globally would shadow
v1. The helper installs v2 into an isolated prefix and exposes only an `opencode2` command, leaving v1's
`opencode` untouched:

```bash
npm run opencode2:install    # installs @opencode/cli into <state>/oat/opencode2; creates `opencode2`
opencode --version           # v1 (unchanged)
opencode2 --version          # v2
npm run opencode2:status     # show the isolated prefix and wrapper paths
npm run opencode2:uninstall  # remove the `opencode2` wrapper and the isolated install
```

The helper passes `--allow-scripts=@opencode/cli` so the package's postinstall can select the native
binary (npm blocks install scripts by default on this machine). Override locations with
`npm run opencode2:install -- --prefix <dir> --bin-dir <dir>`.

> See "opencode v2 support" below for running v2 with OAT.

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

## opencode v2 support

OAT can coexist with opencode v1 and v2 and detect each backend automatically (v1 answers
`/global/health`; v2 answers `/api/info` behind HTTP Basic auth).

- **Discovery** probes `/global/health` (v1) then `/api/info` with the known password (v2), and tags each
  backend with its generation.
- **Manage v2 backends** with `OAT_BACKEND_VERSION=v2`: OAT starts `opencode2 serve --port <n>` per
  project, injecting an OAT-chosen `OPENCODE_SERVER_PASSWORD`, and adds `Authorization: Basic` upstream.
- **`oat opencode2 [args]`** runs the v2 TUI in the current terminal as a private server
  (`--standalone`), with that password exported so OAT can discover and route to it. `oat opencode`
  remains for v1.
- **Translation** (`OAT_TRANSLATE_V2`, on by default): the Sesori bridge speaks v1, so OAT maps the v1
  requests it makes onto v2's `/api/*` surface and unwraps v2 responses back to v1 shapes. This is a
  stopgap — set `OAT_TRANSLATE_V2=0` once the bridge speaks v2 natively.

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
