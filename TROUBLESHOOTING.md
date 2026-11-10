# OAT — Troubleshooting FAQ

Short answers to problems that are easy to misattribute to OAT or opencode.

---

## "Couldn't send" on the phone / OAT returns 502 `connect EADDRINUSE` / services become unreachable

**Symptom**

- The iOS app shows **"Couldn't send"** (with Retry).
- `oat list` flaps between one backend and none, or `GET /api/info` through OAT returns
  `502 {"error":"oat proxy error: connect EADDRINUSE …"}`.
- Direct requests to the opencode backend return `000`/time out, even though its process is alive and
  listening.
- Eventually even the local UI cannot connect ("Transport: Unable to connect").

**Cause: local TCP port exhaustion — usually a leaking third-party process, not OAT**

OAT, opencode and the bridge all use loopback TCP. Windows gives outbound connections a limited
dynamic port range (default **49152–65535**, 16,384 ports). A long-running process that leaks sockets —
typically thousands stuck in `CLOSE_WAIT` — consumes the range, and new `connect()` calls fail with
`EADDRINUSE` even when the target is listening.

**Observed case:** **Adobe Desktop Service** had been running for ~18 days and accumulated ~15,400
sockets (10,207 `CLOSE_WAIT` + 5,220 `ESTABLISHED`) — essentially the whole dynamic range. Killing it
restored everything immediately.

### Diagnose (Windows)

```powershell
# How many sockets are stuck, by state?
$ns = netstat -ano
'CLOSE_WAIT  = ' + ($ns | Select-String '\sCLOSE_WAIT\s').Count
'ESTABLISHED = ' + ($ns | Select-String '\sESTABLISHED\s').Count

# Which process owns them?
$ns | Select-String '\sCLOSE_WAIT\s' |
  ForEach-Object { ($_.Line -split '\s+')[-1] } |
  Group-Object | Sort-Object Count -Descending | Select-Object -First 10 |
  ForEach-Object {
    $p = Get-Process -Id ([int]$_.Name) -ErrorAction SilentlyContinue
    '{0,6}  pid={1,-7} {2}' -f $_.Count, $_.Name, $p.ProcessName
  }

# What is the dynamic port range?
netsh int ipv4 show dynamicport tcp
```

If one process owns thousands of sockets, that is the culprit.

### Fix

1. **Stop the leaking process.** For Adobe Desktop Service:

   ```powershell
   Stop-Process -Name 'Adobe Desktop Service' -Force
   ```

   (Adobe documents are not closed; Creative Cloud sync/licensing may pause until the service returns.)

2. **Block it from starting at login.** The clean way is the app setting:
   **Adobe Creative Cloud → Settings → General → uncheck "Launch Creative Cloud at login"**.

   Or disable the scheduled tasks (needs an **elevated** PowerShell):

   ```powershell
   Disable-ScheduledTask -TaskName "Adobe Creative Cloud"
   Disable-ScheduledTask -TaskName "Launch Adobe CCXProcess"
   ```

   Re-enable later with `Enable-ScheduledTask -TaskName "…"`.

3. **Verify recovery:**

   ```powershell
   netstat -ano | Select-String '\sCLOSE_WAIT\s'   # should be a handful, not thousands
   oat reload
   oat list                                        # backend should be present and healthy
   ```

   Then retry from the app.

A reboot also clears leaked sockets, but the leak will return if the offending process autostarts again.

> OAT itself now uses `netstat -ano` for Windows discovery and bounds external probes and control calls
> with timeouts, so a slow OS tool cannot hang `oat status`/`oat list`. Port exhaustion, however, is
> outside OAT and must be fixed at the source.

---

## Updating opencode closes my TUIs (or refuses to)

`oat update opencode` waits for all sessions to become idle, then closes the open TUIs so the binary can
be replaced (on Windows a running `opencode.exe` locks the file). It closes them **gracefully**; if one
does not exit, the command aborts and lists it. Close it manually, or pass `--force-close-tuis`
(force-kill; on Windows this can leave the terminal in mouse-reporting mode — `OPENCODE_DISABLE_MOUSE=1`
avoids the TUI enabling mouse reporting in the first place).

After the update the TUIs are relaunched by default in their original directories (`--no-relaunch` to
skip). Sessionless TUIs are relaunched in their cwd; TUIs started with `oat opencode` are recorded
exactly. The command never restarts the bridge or OAT itself.

---

## "The project has no / commands" / `/btw` is sent as a normal prompt

opencode has **two kinds of slash commands**:

- **Server commands** — listed by `GET /api/command` (built-ins such as `init` and `review`, plus any
  custom commands in `.opencode/commands/*.md`). These are fetched by the bridge and shown in the app.
- **Client-side features** — implemented inside the opencode TUI/GUI, not the API. `/btw` is one of
  these (it opens a side panel and answers without admitting a prompt, see
  `packages/tui/src/feature-plugins/prompt/btw.tsx`). It cannot be invoked through OAT or the bridge, so
  the app sends `/btw …` as ordinary prompt text.

To use `/btw` from the phone, the app would need to implement that panel natively. Other server
commands work normally.
