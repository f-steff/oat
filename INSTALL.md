# OAT — Install Guide

This guide installs the three pieces OAT ties together:

| Piece | What it is | Where it comes from |
|---|---|---|
| **opencode** | the coding agent you drive | npm (`opencode-ai@1` **or** `@opencode/cli@2`) or Homebrew |
| **sesori-bridge** | connects the Sesori phone app to opencode | Sesori install script / npm bootstrap |
| **OAT** | one endpoint that muxes all your opencode instances | this repository (a release package is planned) |

OAT runs on **Windows, macOS and Linux**, and works with **opencode v1 or v2**. To install and use OAT
itself you need **Node.js ≥ 20**, **npm** and **git**.

- Design and behaviour: [`README.md`](README.md)
- Developing / testing OAT (incl. remote machines over SSH): [`DEVELOPING.md`](DEVELOPING.md)
- Test plan and troubleshooting: [`TESTING.md`](TESTING.md)

---

## 1. Decide: opencode v1 or v2 (read this first)

> **The switch from v1 to v2 is one-way.** opencode v2 migrates opencode's shared database in place the
> first time it runs; afterwards v1 can no longer read it. Back up before installing v2:
>
> - macOS/Linux: `~/.local/share/opencode/opencode.db*`
> - Windows: `%USERPROFILE%\.local\share\opencode\opencode.db*`

OAT **auto-detects** whichever `opencode` is installed, so you normally install **one** generation.
If you want **both at once** (e.g. to test one against the other) see
[Running v1 and v2 side by side](#5-running-v1-and-v2-side-by-side) — it is possible with a little
isolation.

## 2. Install opencode

Pick **one** of the lines below, as the `opencode` command on your `PATH`:

```bash
npm install -g opencode-ai@1      # v1
npm install -g @opencode/cli@2    # v2
```

- **macOS (Homebrew alternative):** `brew install opencode` installs v2 from Homebrew core.
- **Linux CPU requirement:** opencode's *baseline* build needs **x86-64-v2** (SSE4.2, POPCNT, AVX-era).
  Pre-2013 CPUs (e.g. Core 2 Duo) report `Illegal instruction` — those machines cannot run opencode.
- **Windows / hardened npm:** if npm has an `allow-scripts` policy, the v2 install script (which fetches
  the platform binary) is blocked. Allow it once in `%USERPROFILE%\.npmrc`:
  `allow-scripts=opencode-ai,@opencode/cli`.

Verify:

```bash
opencode --version      # "1.x" for v1, "opencode v2.x" for v2
```

## 3. Install sesori-bridge

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/sesori-ai/sesori_apps_monorepo/main/install.sh | bash
sesori-bridge --version
# if PATH has not refreshed yet:
~/.local/share/sesori/bin/sesori-bridge --version
```

**Windows**

```powershell
irm https://raw.githubusercontent.com/sesori-ai/sesori_apps_monorepo/main/install.ps1 | iex
sesori-bridge --version
# if PATH has not refreshed yet:
& "$env:LOCALAPPDATA\sesori\bin\sesori-bridge.exe" --version
```

The npm bootstrap `npx @sesori/bridge` installs the same managed runtime. See the upstream
`bridge/INSTALL.md` for details (install locations, update track, headless/VM notes).

## 4. Install OAT

Until OAT is published, install from source (this is the only supported method today):

```bash
git clone https://github.com/f-steff/oat.git
cd oat
npm ci
npm run build      # required: the `oat` shim runs the compiled dist/
npm link           # puts `oat` on your PATH
oat version        # expect: 0.2.0
```

Prefer not to install a global command? Run `bin/oat <cmd>` (POSIX), `bin\oat <cmd>` (Windows), or
`node dist/cli.js <cmd>`.

### Quick start

```bash
oat start          # start the detached OAT daemon (idempotent)
oat status         # pid, port, generation (v1/v2), backend count
oat list           # discovered opencode backends

cd <project>
oat opencode       # the installed opencode generation's TUI, here

oat sesori-bridge  # in another terminal: the bridge, pointed at OAT
```

The bridge reaches every opencode instance through OAT. Default port is `4096` (`OPENCODE_PORT`/`OAT_PORT`).

## 5. Running v1 and v2 side by side

Both generations can live on one machine if they use **separate data directories**. opencode honours the
XDG base-dir variables, so point v1 at its own `data`/`state`/`config` and it will never touch the
v2-migrated database.

1. Install the second generation from a source checkout without adding a second global `opencode` shim
   (the two packages both provide a binary called `opencode`, so the global name collides):

   ```bash
   npm install --prefix "$HOME/opt/opencode-v1" opencode-ai@1     # macOS/Linux
   npm install --prefix "%USERPROFILE%\opt\opencode-v1" opencode-ai@1   # Windows
   ```

2. Create a wrapper that sets the isolated dirs and runs that binary.

   **macOS / Linux** — `~/.local/bin/oc-v1`:
   ```bash
   #!/bin/bash
   export XDG_DATA_HOME="$HOME/opencode-v1/data"
   export XDG_STATE_HOME="$HOME/opencode-v1/state"
   export XDG_CONFIG_HOME="$HOME/opencode-v1/config"
   exec "$HOME/opt/opencode-v1/node_modules/opencode-ai/bin/opencode.exe" "$@"
   ```
   (`chmod +x` it; the npm binary is named `opencode.exe` on every platform.)

   **Windows** — `%USERPROFILE%\opt\bin\oc-v1.cmd` (add that dir to `PATH`):
   ```bat
   @echo off
   set "XDG_DATA_HOME=%USERPROFILE%\opencode-v1\data"
   set "XDG_STATE_HOME=%USERPROFILE%\opencode-v1\state"
   set "XDG_CONFIG_HOME=%USERPROFILE%\opencode-v1\config"
   "%USERPROFILE%\opt\opencode-v1\node_modules\opencode-ai\bin\opencode.exe" %*
   ```

3. Use it:

   ```bash
   oc-v1                 # v1 TUI, isolated data
   oc-v1 serve --port 5099
   ```

   The global `opencode` remains whichever generation you installed normally (commonly v2). Each side
   keeps its own database, sessions and config.

To make **OAT** drive v1, point it at the v1 binary and (optionally) force the generation:

```bash
OAT_BACKEND_VERSION=v1 OPENCODE_BIN="$HOME/.local/bin/oc-v1" oat start   # macOS/Linux
```

## 6. Updating opencode

The in-TUI `/update` relies on opencode detecting how it was installed, which is **not always reliable**.
If it reports *"Could not detect the installation method"*, pass the method explicitly or use the
package manager:

| How opencode was installed | Update command |
|---|---|
| npm (`opencode-ai@1` / `@opencode/cli@2`) | `opencode upgrade --method npm` |
| Homebrew core formula (`brew install opencode`) | `brew update && brew upgrade opencode` |
| Homebrew official tap | `opencode upgrade --method brew` (needs the `anomalyco/tap`) |

> **Windows + npm:** `opencode upgrade --method npm` re-runs the package's install script. If your npm
> blocks install scripts, add `@opencode/cli` to `allow-scripts` first (see §2), otherwise the upgrade
> can leave a broken/absent platform binary.

Upgrading within v2 (2.0.x → 2.0.y) is safe. Never downgrade v2 → v1 against the same data dir.

## 7. How OAT picks the generation

`OAT_BACKEND_VERSION=auto` (the default) runs the resolved `opencode` with `--version` and reads the
result: `1.x` → v1, `opencode v2.x` → v2. The binary is `OPENCODE_BIN` if set, otherwise `opencode` from
`PATH` (on Windows, OAT also probes the npm package paths and prefers `@opencode/cli`). Force it with
`OAT_BACKEND_VERSION=v1|v2`, and/or choose a specific binary with `OPENCODE_BIN`.

## 8. Uninstall

```bash
oat stop
npm unlink -g oat            # remove the `oat` command (keep the clone if you like)
```

State/log locations: Windows `%LOCALAPPDATA%\oat`, macOS `~/Library/Application Support/oat`,
Linux `${XDG_STATE_HOME:-~/.local/state}/oat`.

The bridge keeps its managed runtime under `~/.local/share/sesori` (macOS/Linux) or
`%LOCALAPPDATA%\sesori` (Windows); remove those directories to fully uninstall it.
