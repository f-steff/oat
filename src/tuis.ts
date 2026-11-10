import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildLaunchSpec, launchTerminal, type LaunchSpec } from "./launcher.js";

/** A TUI registered by `oat opencode` (so its cwd is known exactly). */
export interface TuiRegistryEntry {
  pid: number;
  cwd: string;
  args: string[];
  startedAt: number;
}

/** A running opencode TUI to consider closing/relaunching. */
export interface TuiEntry {
  pid: number;
  cwd: string | null;
  args: string[];
  sessionId: string | null;
  source: "registry" | "process";
}

/** Result of a close attempt. */
export interface TuiCloseResult {
  closed: number[];
  failed: number[];
}

/** Result of a relaunch attempt. */
export interface TuiRelaunchResult {
  launched: TuiEntry[];
  failed: TuiEntry[];
}

/** Injectable process primitives (tests). */
export interface TuiDeps {
  platform?: NodeJS.Platform;
  run?: (file: string, args: string[], timeoutMs?: number) => string;
  alive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  launch?: (spec: LaunchSpec) => boolean;
}

const defaultRun = (file: string, args: string[], timeoutMs = 10_000): string => {
  try {
    return execFileSync(file, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true }).trim();
  } catch {
    return "";
  }
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** True when the process exists (EPERM still means it exists). */
export function isAlive(pid: number, alive?: (pid: number) => boolean): boolean {
  if (alive) return alive(pid);
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Path of the `oat opencode` TUI registry. */
export function tuiRegistryPath(stateDir: string): string {
  return path.join(stateDir, "tuis.json");
}

/** Read the TUI registry, ignoring malformed entries. */
export function readTuiRegistry(stateDir: string): TuiRegistryEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(tuiRegistryPath(stateDir), "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is TuiRegistryEntry => {
      const row = entry as Partial<TuiRegistryEntry> | null;
      return (
        !!row &&
        typeof row.pid === "number" &&
        typeof row.cwd === "string" &&
        Array.isArray(row.args) &&
        row.args.every((arg) => typeof arg === "string")
      );
    });
  } catch {
    return [];
  }
}

function writeTuiRegistry(stateDir: string, entries: TuiRegistryEntry[]): void {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const file = tuiRegistryPath(stateDir);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
    try {
      fs.renameSync(tmp, file);
    } catch {
      // Windows can refuse to replace an existing file; copy then remove.
      fs.copyFileSync(tmp, file);
      fs.unlinkSync(tmp);
    }
  } catch {
    // Best effort: a missing registry only degrades relaunching, never routing.
  }
}

/** Record a TUI started by `oat opencode`. */
export function registerTui(stateDir: string, entry: TuiRegistryEntry): void {
  const entries = readTuiRegistry(stateDir).filter((row) => row.pid !== entry.pid && isAlive(row.pid));
  entries.push(entry);
  writeTuiRegistry(stateDir, entries);
}

/** Remove a TUI record when it exits. */
export function unregisterTui(stateDir: string, pid: number): void {
  writeTuiRegistry(
    stateDir,
    readTuiRegistry(stateDir).filter((row) => row.pid !== pid),
  );
}

/** Extract a session id from a TUI command line (`-s` / `--session`). */
export function sessionIdFromArgs(commandLine: string): string | null {
  const match = /(?:^|\s)(?:-s|--session)(?:=|\s+)(ses_[A-Za-z0-9]+)/.exec(commandLine);
  return match?.[1] ?? null;
}

/** True when a command line is an opencode TUI (not a server). */
export function isTuiCommand(commandLine: string): boolean {
  const command = commandLine.replace(/"/g, "").replace(/\\/g, "/");
  // The executable must be opencode.
  if (!/(^|[\s/])opencode(?:\.exe)?(?:\s|$)/i.test(command)) return false;
  // `opencode serve …` is a server, never a TUI.
  if (/(^|[\s/])opencode(?:\.exe)?\s+serve(?:\s|$)/i.test(command)) return false;
  // The OAT daemon/CLI is not opencode.
  if (/cli\.js\s+serve/i.test(command)) return false;
  return true;
}

/** List running opencode processes with their full command lines. */
export function listProcessTuis(platform = process.platform, deps: TuiDeps = {}): Array<{ pid: number; cmd: string }> {
  const run = deps.run ?? defaultRun;
  if (platform === "win32") {
    const script =
      "Get-CimInstance Win32_Process -Filter \"Name='opencode.exe'\" | " +
      "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    const out =
      run("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script]) ||
      run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
    if (!out) return [];
    try {
      const parsed = JSON.parse(out) as unknown;
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows
        .map((row) => {
          const value = row as { ProcessId?: unknown; CommandLine?: unknown };
          return {
            pid: typeof value.ProcessId === "number" ? value.ProcessId : 0,
            cmd: typeof value.CommandLine === "string" ? value.CommandLine : "",
          };
        })
        .filter((row) => row.pid > 0);
    } catch {
      return [];
    }
  }

  const out = run("ps", ["-axo", "pid=,args="]);
  return out
    .split(/\r?\n/)
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => !!match)
    .map((match) => ({ pid: Number(match[1]), cmd: match[2] ?? "" }));
}

const WINDOWS_CWD_SCRIPT = `param([int]$TargetPid)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class OatPeb {
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_BASIC_INFORMATION {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr Reserved3;
  }
  [DllImport("ntdll.dll")]
  public static extern int NtQueryInformationProcess(IntPtr h, int c, ref PROCESS_BASIC_INFORMATION p, int l, out int r);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(int a, bool i, int p);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool ReadProcessMemory(IntPtr h, IntPtr b, byte[] buf, int size, out IntPtr read);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr h);
}
"@
$h = [OatPeb]::OpenProcess(0x0410, $false, $TargetPid)
if ($h -eq [IntPtr]::Zero) { exit 1 }
try {
  $bi = [OatPeb+PROCESS_BASIC_INFORMATION]::new()
  $len = 0
  $st = [OatPeb]::NtQueryInformationProcess($h, 0, [ref]$bi, [Runtime.InteropServices.Marshal]::SizeOf($bi), [ref]$len)
  if ($st -ne 0) { exit 1 }
  $buf = New-Object byte[] 16
  $read = [IntPtr]::Zero
  if (-not [OatPeb]::ReadProcessMemory($h, [IntPtr]($bi.PebBaseAddress.ToInt64() + 0x20), $buf, 8, [ref]$read)) { exit 1 }
  $pp = [BitConverter]::ToInt64($buf, 0)
  if (-not [OatPeb]::ReadProcessMemory($h, [IntPtr]($pp + 0x38), $buf, 16, [ref]$read)) { exit 1 }
  $strLen = [BitConverter]::ToUInt16($buf, 0)
  $strBuf = [BitConverter]::ToInt64($buf, 8)
  if ($strLen -le 0) { exit 1 }
  $strBytes = New-Object byte[] $strLen
  if (-not [OatPeb]::ReadProcessMemory($h, [IntPtr]$strBuf, $strBytes, $strLen, [ref]$read)) { exit 1 }
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  Write-Output ([Text.Encoding]::Unicode.GetString($strBytes))
} finally { [OatPeb]::CloseHandle($h) | Out-Null }
`;

/** Best-effort cwd of a Windows process via a PEB read (x64). */
function windowsCwd(pid: number, run: (file: string, args: string[], timeoutMs?: number) => string): string | null {
  try {
    const script = path.join(os.tmpdir(), "oat-win-cwd.ps1");
    if (!fs.existsSync(script) || fs.readFileSync(script, "utf8") !== WINDOWS_CWD_SCRIPT) {
      fs.writeFileSync(script, WINDOWS_CWD_SCRIPT, "utf8");
    }
    for (const shell of ["pwsh", "powershell"]) {
      const out = run(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, String(pid)], 5_000);
      const value = out.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (value) {
        const normalized = path.win32.normalize(value);
        const trimmed = normalized.replace(/\\+$/, "");
        return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Resolve the working directory of a process. */
export function cwdOf(pid: number, platform = process.platform, deps: TuiDeps = {}): string | null {
  const run = deps.run ?? defaultRun;
  if (platform === "linux") {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  if (platform === "darwin") {
    const out = run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], 5_000);
    const line = out
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find((value) => value.startsWith("n"));
    return line ? line.slice(1) : null;
  }
  if (platform === "win32") return windowsCwd(pid, run);
  return null;
}

/** Snapshot the TUIs to close/relaunch, preferring recorded cwd and session directories. */
export async function snapshotTuis(
  stateDir: string,
  platform = process.platform,
  lookup?: (sessionId: string) => Promise<string | null>,
  deps: TuiDeps = {},
): Promise<TuiEntry[]> {
  const alive = (pid: number): boolean => isAlive(pid, deps.alive);
  const registry = readTuiRegistry(stateDir).filter((entry) => alive(entry.pid));
  const byPid = new Map(registry.map((entry) => [entry.pid, entry]));
  const processes = listProcessTuis(platform, deps).filter((row) => isTuiCommand(row.cmd));
  const entries: TuiEntry[] = [];
  const seen = new Set<number>();

  for (const process of processes) {
    if (seen.has(process.pid) || !alive(process.pid)) continue;
    seen.add(process.pid);
    const recorded = byPid.get(process.pid);
    const sessionId = sessionIdFromArgs(process.cmd) ?? (recorded ? sessionIdFromArgs(recorded.args.join(" ")) : null);
    let cwd = recorded?.cwd ?? cwdOf(process.pid, platform, deps);
    if (sessionId && lookup) {
      const directory = await lookup(sessionId);
      if (directory) cwd = directory;
    }
    entries.push({
      pid: process.pid,
      cwd,
      args: recorded?.args ?? (sessionId ? ["-s", sessionId] : []),
      sessionId,
      source: recorded ? "registry" : "process",
    });
  }

  for (const recorded of registry) {
    if (seen.has(recorded.pid)) continue;
    const sessionId = sessionIdFromArgs(recorded.args.join(" "));
    entries.push({
      pid: recorded.pid,
      cwd: recorded.cwd,
      args: recorded.args,
      sessionId,
      source: "registry",
    });
  }
  return entries;
}

function softClose(pid: number, platform: NodeJS.Platform): void {
  try {
    if (platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid)], { timeout: 5_000, windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(pid, "SIGINT");
    }
  } catch {
    // Already gone or not closable; the waiter below reports it.
  }
}

function forceClose(pid: number, platform: NodeJS.Platform): void {
  try {
    if (platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/F", "/T"], { timeout: 5_000, windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Ignore: the result reports what survived.
  }
}

/** Gracefully close the TUIs; with `force`, kill survivors afterwards. */
export async function closeTuis(
  entries: TuiEntry[],
  opts: { platform?: NodeJS.Platform; graceMs?: number; force?: boolean; selfPid?: number } = {},
  deps: TuiDeps = {},
): Promise<TuiCloseResult> {
  const platform = opts.platform ?? process.platform;
  const alive = (pid: number): boolean => isAlive(pid, deps.alive);
  const sleep = deps.sleep ?? defaultSleep;
  const selfPid = opts.selfPid ?? process.pid;
  const targets = entries.filter((entry) => entry.pid !== selfPid && alive(entry.pid));

  for (const entry of targets) softClose(entry.pid, platform);
  const deadline = Date.now() + (opts.graceMs ?? 5_000);
  while (Date.now() < deadline && targets.some((entry) => alive(entry.pid))) await sleep(200);

  if (opts.force) {
    for (const entry of targets.filter((target) => alive(target.pid))) forceClose(entry.pid, platform);
    const forceDeadline = Date.now() + 2_000;
    while (Date.now() < forceDeadline && targets.some((entry) => alive(entry.pid))) await sleep(100);
  }

  return {
    closed: targets.filter((entry) => !alive(entry.pid)).map((entry) => entry.pid),
    failed: targets.filter((entry) => alive(entry.pid)).map((entry) => entry.pid),
  };
}

/** Relaunch each snapshot TUI in its directory, preserving `-s <session>`. */
export function relaunchTuis(
  entries: TuiEntry[],
  config: { launchCommand: string | null },
  platform = process.platform,
  deps: TuiDeps = {},
): TuiRelaunchResult {
  const launch = deps.launch ?? launchTerminal;
  const launched: TuiEntry[] = [];
  const failed: TuiEntry[] = [];
  for (const entry of entries) {
    if (!entry.cwd) {
      failed.push(entry);
      continue;
    }
    const args = entry.sessionId ? ["-s", entry.sessionId] : entry.args;
    const spec = buildLaunchSpec(entry.cwd, platform, config.launchCommand, args);
    if (spec && launch(spec)) launched.push(entry);
    else failed.push(entry);
  }
  return { launched, failed };
}

/** A clipboard-friendly command that reopens a TUI. */
export function resumeCommand(entry: TuiEntry): string {
  const cd = entry.cwd ? `cd "${entry.cwd}" && ` : "";
  const args = entry.sessionId ? ` -s ${entry.sessionId}` : "";
  return `${cd}oat opencode${args}`;
}
