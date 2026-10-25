import { execFileSync } from "node:child_process";

import type { BackendKind } from "./types.js";

/** Configured generation: an explicit override or `"auto"` (detect from the binary). */
export type GenerationSetting = BackendKind | "auto";

/**
 * Detect which opencode generation a binary is by asking for its version.
 * v1 prints a bare `1.18.32`; v2 prints `opencode v2.0.15`. Defaults to `"v1"`.
 */
export function detectOpencodeGeneration(command: string): BackendKind {
  const parse = (out: string): BackendKind | null => {
    const text = out.trim();
    if (/opencode\s+v?2\./i.test(text) || /^v?2\./.test(text)) return "v2";
    if (/^\d+\.\d+/.test(text)) return "v1";
    return null;
  };
  const run = (shell: boolean): string | null => {
    try {
      return execFileSync(command, ["--version"], { encoding: "utf8", timeout: 5_000, windowsHide: true, shell });
    } catch {
      return null;
    }
  };
  // A bare name on Windows may be a `.cmd`/`.ps1` shim which needs a shell.
  const out = run(false) ?? (process.platform === "win32" && !/[\\/]/.test(command) ? run(true) : null);
  const kind = out ? parse(out) : null;
  // Unresolvable binary: assume v1 (the historical default).
  return kind ?? "v1";
}

/** Resolve the generation to use: an explicit `v1`/`v2`, else detect from the binary. */
export function resolveGeneration(configured: GenerationSetting, command: string): BackendKind {
  return configured === "auto" ? detectOpencodeGeneration(command) : configured;
}
