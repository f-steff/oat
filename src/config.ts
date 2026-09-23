import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { OatConfig } from "./types.js";

/** Return the per-user state directory for the given platform. */
export function defaultStateDir(platform: NodeJS.Platform = process.platform, env = process.env): string {
  // Windows keeps per-user app data under %LOCALAPPDATA%.
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "oat");
  }
  // macOS uses ~/Library/Application Support.
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "oat");
  }
  // Linux follows the XDG base-directory spec.
  return path.join(env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "oat");
}

/** Generate a fresh random bearer token for the control API. */
export function newToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

/** Build a complete config from environment defaults and optional overrides. */
export function defaultConfig(overrides: Partial<OatConfig> = {}): OatConfig {
  // Port precedence: explicit override → OAT_PORT → OPENCODE_PORT → opencode default.
  const port = overrides.port ?? Number(process.env.OAT_PORT ?? process.env.OPENCODE_PORT ?? 4096);
  // State directory precedence: explicit override → OAT_STATE_DIR → per-OS default.
  const stateDir = overrides.stateDir ?? process.env.OAT_STATE_DIR ?? defaultStateDir();
  return {
    port,
    host: overrides.host ?? process.env.OAT_HOST ?? "127.0.0.1",
    stateDir,
    // Log file precedence: explicit override → OAT_LOG_FILE → <stateDir>/oat.log.
    logFile: overrides.logFile ?? process.env.OAT_LOG_FILE ?? path.join(stateDir, "oat.log"),
    discoveryIntervalMs: overrides.discoveryIntervalMs ?? 5_000,
    probeTimeoutMs: overrides.probeTimeoutMs ?? 1_000,
    idleShutdownMs: overrides.idleShutdownMs ?? 30 * 60_000,
    debugAttribution: overrides.debugAttribution ?? process.env.OAT_DEBUG === "1",
    token: overrides.token ?? process.env.OAT_TOKEN ?? newToken(),
    opencodeBin: overrides.opencodeBin ?? process.env.OPENCODE_BIN ?? "opencode",
    // On-demand fallback server is allowed by default; OAT_ANCHOR=0 disables it.
    anchor: overrides.anchor ?? process.env.OAT_ANCHOR !== "0",
    // A visible terminal is the default for lazily started servers; OAT_LAUNCH_TERMINAL=0 disables.
    launchTerminal: overrides.launchTerminal ?? process.env.OAT_LAUNCH_TERMINAL !== "0",
    launchCommand: overrides.launchCommand ?? process.env.OAT_LAUNCH_CMD ?? null,
    // Injected-arg templates keep OAT decoupled from the tools' flag names.
    bridgeBin: overrides.bridgeBin ?? process.env.OAT_BRIDGE_BIN ?? "sesori-bridge",
    bridgeArgs: overrides.bridgeArgs ?? process.env.OAT_BRIDGE_ARGS ?? "--opencode-no-auto-start --opencode-port {port}",
    opencodeArgs: overrides.opencodeArgs ?? process.env.OAT_OPENCODE_ARGS ?? "--port {host_port} --hostname {host}",
    // opencode v2 is a separate binary (`opencode2`); its server uses HTTP Basic auth.
    opencode2Bin: overrides.opencode2Bin ?? process.env.OAT_OPENCODE2_BIN ?? "opencode2",
    opencode2Args:
      overrides.opencode2Args ?? process.env.OAT_OPENCODE2_ARGS ?? "serve --port {host_port} --hostname {host}",
    // Stable per-daemon password for v2 backends (propagated to the daemon via env).
    v2Password: overrides.v2Password ?? process.env.OAT_V2_PASSWORD ?? newToken(),
    translateV2: overrides.translateV2 ?? process.env.OAT_TRANSLATE_V2 !== "0",
  };
}
