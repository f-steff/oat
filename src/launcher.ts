import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { defaultStateDir } from "./config.js";

/** A command to open a terminal window running opencode in a directory. */
export interface LaunchSpec {
  /** Executable to run (e.g. `wt.exe`, `gnome-terminal`). */
  command: string;
  /** Arguments, already expanded. */
  args: string[];
}

/**
 * Resolve an executable by name, preferring a real binary over a shell shim
 * (a shell `.cmd`/`.bat` spawns a visible console on Windows).
 */
export function resolveExecutable(name: string, candidates: string[] = []): { command: string; shell: boolean } {
  if (name.includes("/") || name.includes("\\")) return { command: name, shell: false };
  if (process.platform !== "win32") return { command: name, shell: false };
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return { command: candidate, shell: false };
  }
  try {
    const found = execFileSync("where", [name], { encoding: "utf8", timeout: 5_000 })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const exe = found.find((line) => line.toLowerCase().endsWith(".exe"));
    if (exe) return { command: exe, shell: false };
  } catch {
    // Fall through to the shim.
  }
  return { command: name, shell: true };
}

/**
 * Resolve the opencode executable, preferring a real binary over a shell shim.
 * A shell (`.cmd`) spawns a visible console on Windows, so it is a last resort.
 */
export function resolveOpencodeExecutable(bin: string): { command: string; shell: boolean } {
  // An explicit path is used verbatim, without a shell.
  if (bin.includes("/") || bin.includes("\\")) return { command: bin, shell: false };
  if (process.platform !== "win32") return { command: bin, shell: false };
  // Prefer the real .exe shipped with the npm package (no console window).
  const candidates = [
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe") : "",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "opencode", "bin", "opencode.exe") : "",
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return { command: candidate, shell: false };
  }
  // Resolve via PATH, accepting a real .exe when one is found.
  try {
    const found = execFileSync("where", ["opencode"], { encoding: "utf8", timeout: 5_000 })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const exe = found.find((line) => line.toLowerCase().endsWith(".exe"));
    if (exe) return { command: exe, shell: false };
  } catch {
    // Ignore and fall through to the shim.
  }
  // Last resort: the bare name (no shell, so no console window can flash).
  return { command: bin, shell: false };
}

/** Candidate binary paths for the isolated opencode v2 install (`npm run opencode2:install`). */
function opencode2Candidates(stateDir: string): string[] {
  const binDirs = [
    path.join(stateDir, "opencode2", "node_modules", "@opencode", "cli", "bin"),
    path.join(stateDir, "opencode2", "lib", "node_modules", "@opencode", "cli", "bin"),
  ];
  return binDirs.flatMap((dir) => [path.join(dir, "opencode.exe"), path.join(dir, "opencode")]);
}

/**
 * Resolve the opencode v2 executable, preferring the isolated install created by
 * `npm run opencode2:install`, then a `opencode2`/`opencode` real binary on PATH.
 */
export function resolveOpencode2Executable(bin: string, stateDir = defaultStateDir()): { command: string; shell: boolean } {
  // An explicit path is used verbatim.
  if (bin.includes("/") || bin.includes("\\")) return { command: bin, shell: false };
  for (const candidate of opencode2Candidates(stateDir)) {
    if (fs.existsSync(candidate)) return { command: candidate, shell: false };
  }
  if (process.platform !== "win32") return { command: bin, shell: false };
  // Prefer a real .exe on PATH (the `opencode2` shim may be a .cmd).
  try {
    const found = execFileSync("where", [bin], { encoding: "utf8", timeout: 5_000 })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const exe = found.find((line) => line.toLowerCase().endsWith(".exe"));
    if (exe) return { command: exe, shell: false };
  } catch {
    // Fall through to the shim/bare name.
  }
  return { command: bin, shell: false };
}

/** Kill a process by pid (no tree kill, so no console/tab side effects). */
export function killProcess(pid: number): void {
  if (!pid || pid < 0) return;
  try {
    process.kill(pid);
  } catch {
    // Already gone.
  }
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore", timeout: 8_000 });
  } catch {
    // taskkill is Windows-only or the process already exited.
  }
}

/** Derive a short, human-friendly window title from a directory path. */
export function projectTitle(directory: string): string {
  const trimmed = directory.replace(/[\\/]+$/, "");
  const base = trimmed.split(/[\\/]/).filter(Boolean).pop() ?? directory;
  return `oat: ${base}`;
}

/**
 * Expand `{name}` placeholders in a whitespace-separated argument template.
 * `{...}` is used (not `${...}` or `%...%`) so it is not mistaken for a shell
 * variable by bash, PowerShell or cmd.
 */
export function expandTokens(template: string, vars: Record<string, string>): string[] {
  return template
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole));
}

/** Expand `{dir}` and `{title}` placeholders in a user-provided template. */
function expandTemplate(template: string, directory: string, title: string): LaunchSpec | null {
  const parts = template.trim().split(/\s+/);
  const command = parts.shift();
  if (!command) return null;
  const args = parts.map((part) => part.replace(/\{dir\}/g, directory).replace(/\{title\}/g, title));
  return { command, args };
}

/**
 * Build the command that opens a terminal in `directory` and runs opencode.
 * A user template (`OAT_LAUNCH_CMD`) wins; otherwise a sensible per-OS default.
 * `opencodeArgs` are appended to the opencode invocation.
 */
export function buildLaunchSpec(
  directory: string,
  platform: NodeJS.Platform = process.platform,
  template?: string | null,
  opencodeArgs: string[] = [],
): LaunchSpec | null {
  const title = projectTitle(directory);
  // Explicit user template.
  if (template && template.trim()) {
    const spec = expandTemplate(template, directory, title);
    return spec ? { command: spec.command, args: [...spec.args, ...opencodeArgs] } : null;
  }

  if (platform === "win32") {
    // Windows Terminal: new tab, start in the project, short title, run opencode.
    return {
      command: "wt.exe",
      args: ["-w", "0", "nt", "-d", directory, "--title", title, "pwsh", "-NoExit", "-Command", "opencode", ...opencodeArgs],
    };
  }
  if (platform === "darwin") {
    // Terminal.app via AppleScript; sets the working directory and runs opencode.
    const command = ["opencode", ...opencodeArgs].join(" ");
    const script = `tell application "Terminal" to do script "cd '${directory.replace(/'/g, "'\\''")}' && ${command}"`;
    return { command: "osascript", args: ["-e", script] };
  }
  // Linux default.
  return {
    command: "gnome-terminal",
    args: [`--working-directory=${directory}`, `--title=${title}`, "--", "opencode", ...opencodeArgs],
  };
}

/**
 * Open a terminal window for `directory`. Returns false when the terminal
 * could not be started (the caller then falls back to a hidden server).
 */
export function launchTerminal(spec: LaunchSpec): boolean {
  try {
    const child = spawn(spec.command, spec.args, {
      detached: true,
      stdio: "ignore",
      // The window is the point here, so it must be visible.
      windowsHide: false,
    });
    child.on("error", () => {
      // Swallow: the caller cannot be notified synchronously anyway.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
