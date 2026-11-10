import { execFileSync } from "node:child_process";
import fs from "node:fs";

import { resolveOpencodeExecutable } from "./launcher.js";

/** How an installed opencode can be updated. */
export type InstallMethod = "npm" | "brew-core" | "brew-tap" | "curl" | "other";

/** Resolved information about the opencode binary OAT would use. */
export interface OpencodeInfo {
  /** The configured executable (`OPENCODE_BIN`). */
  bin: string;
  /** The command OAT actually runs (may be a bare name). */
  command: string;
  /** Whether the command needs a shell (Windows `.cmd` shim). */
  shell: boolean;
  /** Canonical path of the executable, when it can be resolved. */
  realPath: string | null;
  /** `opencode --version` output, when it runs. */
  version: string | null;
  /** Detected installation method. */
  method: InstallMethod;
}

/** One external step in an install/update plan. */
export interface CommandStep {
  file: string;
  args: string[];
}

/** A description plus the commands to run. */
export interface CommandPlan {
  description: string;
  steps: CommandStep[];
}

/** Injectable primitives for detection (tests). */
export interface MethodDeps {
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  realpath?: (p: string) => string;
  exec?: (file: string, args: string[], opts?: { timeoutMs?: number; shell?: boolean }) => string;
}

const defaultExists = (p: string): boolean => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

const defaultRealpath = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

const defaultExec = (file: string, args: string[], opts: { timeoutMs?: number; shell?: boolean } = {}): string => {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 10_000,
      windowsHide: true,
      ...(opts.shell ? { shell: true } : {}),
    }).trim();
  } catch {
    return "";
  }
};

/** Classify an installed opencode path into the method that can update it. */
export function classifyMethod(realPath: string | null): InstallMethod {
  if (!realPath) return "other";
  const p = realPath.replace(/\\/g, "/").toLowerCase();
  if (
    p.includes("/node_modules/@opencode/cli/") ||
    p.includes("/node_modules/.bin/opencode") ||
    p.includes("/appdata/roaming/npm/") ||
    p.includes("/appdata/npm/")
  ) {
    return "npm";
  }
  if (p.includes("/cellar/opencode-v2/") || p.includes("/cellar/anomalyco/")) return "brew-tap";
  if (p.includes("/cellar/opencode/")) return "brew-core";
  if (p.includes("/.opencode/bin/")) return "curl";
  return "other";
}

/** Resolve the binary, its version, and how it is installed. */
export function resolveOpencodeInfo(bin: string, deps: MethodDeps = {}): OpencodeInfo {
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? defaultExists;
  const realpath = deps.realpath ?? defaultRealpath;
  const exec = deps.exec ?? defaultExec;

  const resolved = resolveOpencodeExecutable(bin);
  let realPath: string | null = null;
  if (resolved.command.includes("/") || resolved.command.includes("\\")) {
    realPath = exists(resolved.command) ? realpath(resolved.command) : null;
  } else {
    // A bare command: resolve it through the platform's PATH search.
    const which = platform === "win32" ? exec("where", [resolved.command]) : exec("which", [resolved.command]);
    const first = which
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (first) realPath = exists(first) ? realpath(first) : null;
  }

  const versionOut = exec(resolved.command, ["--version"], { timeoutMs: 8_000, shell: resolved.shell });
  const version = versionOut
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? null;

  return {
    bin,
    command: resolved.command,
    shell: resolved.shell,
    realPath,
    version,
    method: classifyMethod(realPath),
  };
}

/** Latest published `@opencode/cli` version, or null when npm is unavailable. */
export function latestNpmVersion(deps: MethodDeps = {}): string | null {
  const exec = deps.exec ?? defaultExec;
  const platform = deps.platform ?? process.platform;
  const out = exec("npm", ["view", "@opencode/cli", "version"], {
    timeoutMs: 20_000,
    shell: platform === "win32",
  });
  return (
    out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

/** Strip a leading `v` and map `latest` to the npm dist-tag. */
function targetSuffix(target: string): string {
  return target === "latest" ? "latest" : target.replace(/^v/, "");
}

/** Build the update plan for a detected installation method. */
export function updatePlan(info: OpencodeInfo, target = "latest"): CommandPlan | null {
  switch (info.method) {
    case "npm":
      return {
        description: "npm global",
        steps: [{ file: "npm", args: ["install", "-g", `@opencode/cli@${targetSuffix(target)}`] }],
      };
    case "brew-core":
      return {
        description: "Homebrew core",
        steps: [
          { file: "brew", args: ["update"] },
          { file: "brew", args: ["upgrade", "opencode"] },
        ],
      };
    case "brew-tap":
      return {
        description: "Homebrew tap",
        steps: [{ file: "brew", args: ["upgrade", "anomalyco/tap/opencode-v2"] }],
      };
    case "curl":
      return {
        description: "official installer",
        steps: [
          {
            file: info.command,
            args: ["upgrade", "--method", "curl", ...(target === "latest" ? [] : [targetSuffix(target)])],
          },
        ],
      };
    default:
      return null;
  }
}

/** Build the install plan. `auto` matches the detected method, else npm. */
export function installPlan(
  info: OpencodeInfo,
  method: InstallMethod | "auto",
  target = "latest",
): CommandPlan | null {
  const chosen = method === "auto" ? (info.method === "other" ? "npm" : info.method) : method;
  switch (chosen) {
    case "npm":
      return {
        description: "npm global",
        steps: [{ file: "npm", args: ["install", "-g", `@opencode/cli@${targetSuffix(target)}`] }],
      };
    case "brew-core":
      return { description: "Homebrew core", steps: [{ file: "brew", args: ["install", "opencode"] }] };
    case "brew-tap":
      return {
        description: "Homebrew tap",
        steps: [{ file: "brew", args: ["install", "anomalyco/tap/opencode-v2"] }],
      };
    case "curl":
      // The curl updater needs an existing install to update.
      return info.version
        ? {
            description: "official installer",
            steps: [
              {
                file: info.command,
                args: ["upgrade", "--method", "curl", ...(target === "latest" ? [] : [targetSuffix(target)])],
              },
            ],
          }
        : null;
    default:
      return null;
  }
}

/** A short human description of the detected installation. */
export function describeInfo(info: OpencodeInfo): string {
  const path = info.realPath ?? "(unresolved)";
  const version = info.version ?? "(unknown version)";
  const label = version.startsWith("opencode") ? version : `opencode ${version}`;
  return `${label} · ${info.method} · ${path}`;
}
