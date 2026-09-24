import { execFileSync } from "node:child_process";

import type { BackendKind } from "./types.js";

/** Configured generation: an explicit override or `"auto"` (detect from the binary). */
export type GenerationSetting = BackendKind | "auto";

/**
 * Detect which opencode generation a binary is by asking for its version.
 * v1 prints a bare `1.18.32`; v2 prints `opencode v2.0.15`. Defaults to `"v1"`.
 */
export function detectOpencodeGeneration(command: string): BackendKind {
  try {
    const out = execFileSync(command, ["--version"], { encoding: "utf8", timeout: 5_000, windowsHide: true }).trim();
    // v2 prints "opencode v2.x.y"; v1 prints a bare semver.
    if (/opencode\s+v?2\./i.test(out) || /^v?2\./.test(out)) return "v2";
    if (/^\d+\.\d+/.test(out)) return "v1";
  } catch {
    // Unresolvable binary: assume v1 (the historical default).
  }
  return "v1";
}

/** Resolve the generation to use: an explicit `v1`/`v2`, else detect from the binary. */
export function resolveGeneration(configured: GenerationSetting, command: string): BackendKind {
  return configured === "auto" ? detectOpencodeGeneration(command) : configured;
}
