# OAT — Developer Setup

This guide is for **working on OAT itself**. To install and use OAT, see [`README.md`](README.md); for the
test plan, coverage and troubleshooting, see [`TESTING.md`](TESTING.md).

## 1. Prerequisites

- **Node.js ≥ 20** and npm
- **git**
- At least one opencode generation on `PATH` — v1 (`opencode-ai@1`) or v2 (`@opencode/cli@2`).
  OAT auto-detects the installed generation (`OAT_BACKEND_VERSION=auto`).
- Optionally **Docker** for a local Linux environment.

> **One generation at a time.** opencode v2 migrates opencode's shared database in place on first run and
> v1 can no longer read it afterwards. Do not point v1 and v2 at the same data directory. See
> [`README.md`](README.md) → *Migrating from opencode v1 to v2*.

## 2. Local development

```bash
git clone https://github.com/f-steff/oat.git
cd oat
npm ci
npm run build        # emit dist/ (required: the `oat` shim runs dist/cli.js)
npm link             # put `oat` on PATH
oat version          # expect: 0.2.0
```

Day-to-day checks:

```bash
npm run typecheck    # tsc --noEmit
npm test             # unit + integration (no external tools needed)
npm run lint
npm run e2e:daemon   # daemon lifecycle / singleton / maintenance worker
npm run e2e          # real opencode v1 (needs opencode-ai on PATH)
npm run e2e:v2       # real opencode v2 (set OPENCODE_BIN if it is not on PATH)
```

The `e2e`/`e2e:v2` suites start real opencode servers against an **isolated** data/state directory, so
they never touch your real opencode database.

## 3. Testing across platforms

- **Linux** — CI runs `build`/`test`/`lint` on `ubuntu-latest`, plus the v1 and v2 end-to-end jobs.
  A headless Linux box is fine, but **check the CPU first**: opencode's *baseline* build needs
  **x86-64-v2** (SSE4.2 / AVX-era). `grep -m1 -oE 'sse4_2|avx' /proc/cpuinfo` should print a flag; if it
  does not (e.g. a Core 2 Duo), opencode exits with `Illegal instruction`. In that case test Linux with
  **Docker on a modern host** (Docker Desktop on Windows/macOS, or any recent Linux):

  ```bash
  docker run --rm -v "$PWD:/src:ro" -w /tmp node:22 bash -lc \
    "cp -r /src /work && cd /work && rm -rf node_modules dist dist-test && \
     npm ci && npm run build && npm test && \
     npm i -g @opencode/cli@2 && node scripts/e2e-v2.mjs"
  ```

  Swap `@opencode/cli@2`/`e2e-v2` for `opencode-ai@1`/`e2e` to exercise v1. On Apple Silicon add
  `--platform linux/amd64` to match CI; without it you test linux/arm64 — also useful, just different.
  The CI scripts live in [`ci/`](ci/).
- **macOS** — there is no macOS Docker image, so macOS is covered by a CI job and by a real Mac. OAT state
  and logs live in `~/Library/Application Support/oat`.
- **Windows** — the primary development and live-use platform.

Installing **both** opencode generations on one machine (for v1-vs-v2 testing) is possible with isolated
data dirs — see [`INSTALL.md`](INSTALL.md) §5.

## 4. Accessing a remote test machine over SSH

The examples use a **macOS** test box; the same pattern works for a headless Linux build server. Replace
`mac`, `<host>`, `<user>` and paths with your own values. Keep machine-specific values (hostnames,
usernames, IPs) out of the repository — see [Housekeeping](#6-housekeeping).

### 4.1 On the remote machine (once)

- **macOS:** System Settings → General → Sharing → **Remote Login** → on. The pane shows the exact
  `ssh` command. The Bonjour name is what `scutil --get LocalHostName` returns (typically
  `<name>.local`).
- **Linux:** make sure `sshd` is running and reachable.

### 4.2 On your workstation (once)

A Windows client is built in (`ssh`, `ssh-keygen`, `scp`). Generate a key if you do not have one:

```powershell
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\id_ed25519"
```

Install the public key on the remote host (this asks for the remote password **once**). `ssh-copy-id` is
not shipped with Windows and third-party shims are often broken, so append the key manually:

```powershell
$key = Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub"
ssh <user>@<host> "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '$key' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

Add a shortcut in `~/.ssh/config` so you can use a short alias:

```sshconfig
Host mac
    HostName <host>.local
    User <user>
    IdentityFile C:\Users\<you>\.ssh\id_ed25519
    IdentitiesOnly yes
```

Prefer the **`.local` (mDNS/Bonjour) name** to a raw IP address — it survives DHCP changes. Check that
your workstation resolves it:

```powershell
Resolve-DnsName <host>.local
```

If `.local` does not resolve (some networks block mDNS), install Apple Bonjour, use a static
address/DHCP reservation, or fall back to the IP in `HostName`.

### 4.3 Verify (non-interactive)

```powershell
ssh -o BatchMode=yes mac 'sw_vers; whoami; hostname'
```

`BatchMode=yes` fails immediately instead of prompting for a password, so it also confirms that key
auth works — use it for anything automated. Interactive sessions can just use `ssh mac`. On the first
connection, accept the host key (or pass `-o StrictHostKeyChecking=accept-new` for automation).

### 4.4 Running the OAT workflow remotely

```powershell
# update, build and test on the remote
ssh mac 'cd ~/src/oat && git pull && npm ci && npm run build && npm test'

# start the daemon and list backends
ssh mac 'cd ~/src/oat && node dist/cli.js start && node dist/cli.js list'
```

Remember the daemon is per-machine: `oat start`/`oat stop` control only the daemon on the host you run
them on, and the Sesori bridge must point at that host's OAT port.

## 5. Housekeeping

- Machine-specific knowledge (hostnames, keys, tokens, local paths, session recovery notes) belongs in
  the gitignored `temp/` directory, **not** in tracked files.
- Do not commit personal usernames, machine names or IP addresses. Use placeholders as above.
- Branch workflow: open a **pull request into `main`**; `main` is protected and requires the
  `build`/`test`/`lint` checks to pass. Do not commit directly to `main`.
