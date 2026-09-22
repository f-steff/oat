import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

import type { RawListener } from "../types.js";

/** Promisified `execFile` used by the default runner. */
const pexec = promisify(execFile);

/** Runs an external command and resolves its stdout as a string. */
export type Runner = (file: string, args: string[]) => Promise<string>;

/** Default runner backed by `child_process.execFile`. */
export const defaultRunner: Runner = async (file, args) => {
  const { stdout } = await pexec(file, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  return stdout;
};

/** Minimal filesystem surface needed for Linux `/proc` discovery (injectable for tests). */
export interface FsLike {
  /** Read a text file. */
  readFile(file: string, encoding: "utf8"): Promise<string>;
  /** List directory entries. */
  readdir(dir: string): Promise<string[]>;
  /** Resolve a symlink target. */
  readlink(file: string): Promise<string>;
}

/** Default filesystem backed by `node:fs`. */
export const defaultFs: FsLike = {
  readFile: (file, encoding) => fs.promises.readFile(file, encoding),
  readdir: (dir) => fs.promises.readdir(dir),
  readlink: (file) => fs.promises.readlink(file),
};

/** Whether an address is loopback, wildcard or otherwise worth probing. */
export function isRelevantAddress(address: string): boolean {
  // Strip IPv6 brackets before comparing.
  const a = address.replace(/^\[|\]$/g, "");
  return a === "127.0.0.1" || a === "0.0.0.0" || a === "::1" || a === "::" || a === "*" || a === "localhost";
}

/** Parse Windows `Get-NetTCPConnection` output rendered as `address|port|pid` lines. */
export function parseWindowsNetTcp(output: string): RawListener[] {
  const out: RawListener[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Each line is pipe-delimited: address|port|pid.
    const parts = line.split("|");
    if (parts.length < 2) continue;
    const address = (parts[0] ?? "").trim();
    const port = Number.parseInt((parts[1] ?? "").trim(), 10);
    if (!Number.isFinite(port)) continue;
    if (!isRelevantAddress(address)) continue;
    const pid = parts[2] ? Number.parseInt(parts[2].trim(), 10) : Number.NaN;
    out.push({ port, pid: Number.isFinite(pid) && pid > 0 ? pid : null, address });
  }
  return out;
}

/** Parse `/proc/net/tcp{,6}` keeping only LISTEN (state 0A) rows. */
export function parseProcNetTcp(content: string): { port: number; inode: string }[] {
  const rows: { port: number; inode: string }[] = [];
  const lines = content.split(/\r?\n/);
  // Skip the header row and decode each LISTEN entry.
  for (let i = 1; i < lines.length; i++) {
    const parts = (lines[i] ?? "").trim().split(/\s+/);
    if (parts.length < 10) continue;
    const local = parts[1] ?? "";
    const state = parts[3] ?? "";
    const inode = parts[9] ?? "";
    if (state !== "0A") continue;
    const colon = local.lastIndexOf(":");
    if (colon === -1) continue;
    // The local port is hexadecimal in /proc/net/tcp.
    const port = Number.parseInt(local.slice(colon + 1), 16);
    if (!Number.isFinite(port)) continue;
    rows.push({ port, inode });
  }
  return rows;
}

/** Parse macOS/Linux `lsof -nP -iTCP -sTCP:LISTEN` output. */
export function parseLsof(output: string): RawListener[] {
  const out: RawListener[] = [];
  for (const line of output.split(/\r?\n/)) {
    // Only LISTEN rows are relevant.
    const marker = line.indexOf("(LISTEN)");
    if (marker === -1) continue;
    const cols = line.slice(0, marker).trim().split(/\s+/);
    if (cols.length < 3) continue;
    const pid = Number.parseInt(cols[1] ?? "", 10);
    // The NAME column is the token immediately before "(LISTEN)".
    const name = cols[cols.length - 1] ?? "";
    const cleaned = name.replace(/^\[|\]$/g, "");
    const colon = cleaned.lastIndexOf(":");
    if (colon === -1) continue;
    const port = Number.parseInt(cleaned.slice(colon + 1), 10);
    if (!Number.isFinite(port)) continue;
    out.push({ port, pid: Number.isFinite(pid) ? pid : null, address: cleaned.slice(0, colon) || "*" });
  }
  return out;
}

/** Parse macOS `netstat -anv -p tcp` (which carries `Process:PID` on modern macOS). */
export function parseMacNetstat(output: string): RawListener[] {
  const out: RawListener[] = [];
  for (const line of output.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/);
    // LISTEN sits after the address columns; the local address is column 3.
    const listenIdx = tokens.indexOf("LISTEN");
    if (listenIdx < 4) continue;
    const local = tokens[3] ?? "";
    const dot = local.lastIndexOf(".");
    if (dot === -1) continue;
    const port = Number.parseInt(local.slice(dot + 1), 10);
    if (!Number.isFinite(port)) continue;
    // Find a later `name:pid` token such as `Python:60400`.
    let pid: number | null = null;
    for (let i = listenIdx + 1; i < tokens.length; i++) {
      const match = /^[A-Za-z0-9_.-]+:(\d+)$/.exec(tokens[i] ?? "");
      if (match?.[1]) pid = Number.parseInt(match[1], 10);
    }
    out.push({ port, pid, address: local.slice(0, dot) });
  }
  return out;
}

/** Map socket inodes to PIDs by scanning `/proc/<pid>/fd` symlinks. */
export async function mapInodesToPids(
  inodes: Set<string>,
  fsLike: FsLike = defaultFs,
  procDir = "/proc",
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  let pids: string[];
  try {
    pids = await fsLike.readdir(procDir);
  } catch {
    // Not Linux, or /proc unavailable: nothing to map.
    return map;
  }
  for (const pidStr of pids) {
    // Only numeric entries are processes.
    if (!/^\d+$/.test(pidStr)) continue;
    const fdDir = `${procDir}/${pidStr}/fd`;
    let fds: string[];
    try {
      fds = await fsLike.readdir(fdDir);
    } catch {
      // Permission denied or process exited: skip it.
      continue;
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = await fsLike.readlink(`${fdDir}/${fd}`);
      } catch {
        continue;
      }
      // Sockets appear as `socket:[<inode>]`.
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match?.[1] && inodes.has(match[1])) {
        map.set(match[1], Number.parseInt(pidStr, 10));
      }
    }
  }
  return map;
}

/** Enumerate LISTEN sockets on Linux using `/proc` only (no external tools). */
export async function listListenersLinux(fsLike: FsLike = defaultFs, procDir = "/proc"): Promise<RawListener[]> {
  const rows: { port: number; inode: string }[] = [];
  // Merge IPv4 and IPv6 tables (either may be absent).
  for (const file of ["tcp", "tcp6"]) {
    try {
      rows.push(...parseProcNetTcp(await fsLike.readFile(`${procDir}/net/${file}`, "utf8")));
    } catch {
      // Missing file (e.g. IPv6 disabled): skip.
    }
  }
  const inodes = new Set(rows.map((row) => row.inode));
  const pidMap = await mapInodesToPids(inodes, fsLike, procDir);
  return rows.map((row) => ({ port: row.port, pid: pidMap.get(row.inode) ?? null, address: "" }));
}

/** Pick an available PowerShell on Windows (prefer PowerShell 7 `pwsh`). */
async function pickWindowsShell(runner: Runner): Promise<string> {
  for (const shell of ["pwsh", "powershell"]) {
    try {
      await runner(shell, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"]);
      return shell;
    } catch {
      // Try the next candidate.
    }
  }
  return "powershell";
}

/** Injectable dependencies for `listListeners`. */
export interface ListenerDeps {
  /** Override the detected platform (tests). */
  platform?: NodeJS.Platform;
  /** Override the command runner (tests). */
  runner?: Runner;
  /** Override the filesystem used for `/proc` (tests). */
  fs?: FsLike;
  /** Override the `/proc` mount point (tests). */
  procDir?: string;
}

/** Enumerate LISTEN TCP sockets on the local machine, per OS. */
export async function listListeners(deps: ListenerDeps = {}): Promise<RawListener[]> {
  const platform = deps.platform ?? process.platform;
  const runner = deps.runner ?? defaultRunner;

  // Windows: PowerShell reports address, port and owning PID directly.
  if (platform === "win32") {
    const script =
      "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.LocalAddress -in @('127.0.0.1','::1','0.0.0.0','::') } | " +
      "ForEach-Object { \"$($_.LocalAddress)|$($_.LocalPort)|$($_.OwningProcess)\" }";
    const shell = await pickWindowsShell(runner);
    return parseWindowsNetTcp(await runner(shell, ["-NoProfile", "-NonInteractive", "-Command", script]));
  }

  // macOS: prefer lsof, fall back to netstat when lsof yields nothing.
  if (platform === "darwin") {
    try {
      const parsed = parseLsof(await runner("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]));
      if (parsed.length > 0) return parsed;
    } catch {
      // Fall through to netstat.
    }
    return parseMacNetstat(await runner("netstat", ["-anv", "-p", "tcp"]));
  }

  // Linux (and anything else): dependency-free /proc parsing.
  return listListenersLinux(deps.fs ?? defaultFs, deps.procDir ?? "/proc");
}
