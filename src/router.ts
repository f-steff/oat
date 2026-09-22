import type { Backend, RouteDecision } from "./types.js";

/** Filesystems are case-insensitive on Windows and macOS, case-sensitive on Linux. */
export const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

/** Normalize a path for comparison: forward slashes, no trailing slash, case-folded where the FS is. */
export function normalizeDir(dir: string, caseInsensitive = CASE_INSENSITIVE_FS): string {
  // Collapse separators and trim any trailing slash so prefixes compare cleanly.
  let d = dir.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  if (d.length > 1) d = d.replace(/\/+$/, "");
  // Only case-fold on case-insensitive filesystems; Linux paths are case-sensitive.
  return caseInsensitive ? d.toLowerCase() : d;
}

/** True when `child` equals `parent` or lives beneath it (path-boundary aware). */
export function isUnder(child: string, parent: string): boolean {
  // An exact match always counts.
  if (child === parent) return true;
  // A root parent is an ancestor of every absolute path.
  if (parent === "" || parent === "/") return child.startsWith("/");
  // Otherwise require a separator so /ab does not match /a.
  return child.startsWith(parent + "/");
}

/** Inputs that can select a backend, in priority order. */
export interface PickInput {
  /** `x-opencode-directory` header / `directory` query value. */
  directory?: string | null;
  /** Directory resolved from a session id, when the request carries only the id. */
  sessionDirectory?: string | null;
  /** Explicitly preferred backend port (session affinity; Q5 duplicates). */
  affinityPort?: number | null;
}

/** Options that influence fallback selection. */
export interface PickOptions {
  /** Deterministic default backend when nothing else matches. */
  defaultPort?: number | null;
}

/** Best backend whose primary directory is an ancestor of (or equal to) `directory`. */
export function matchByDirectory(backends: Backend[], directory?: string | null): Backend | null {
  // No directory to match means there is nothing to resolve.
  if (!directory) return null;
  const target = normalizeDir(directory);
  let best: Backend | null = null;
  let bestLen = -1;
  // Choose the most specific (longest) matching primary directory.
  for (const backend of backends) {
    if (!backend.primaryDirectory) continue;
    const primary = normalizeDir(backend.primaryDirectory);
    if (!isUnder(target, primary)) continue;
    if (primary.length > bestLen) {
      best = backend;
      bestLen = primary.length;
    }
  }
  return best;
}

/**
 * Choose the backend for a request.
 *
 * Priority: session affinity (explicit) → request directory → session directory →
 * default. Ties are broken deterministically by lowest port.
 */
export function pickBackend(
  backends: Backend[],
  input: PickInput,
  options: PickOptions = {},
): RouteDecision | null {
  // Only healthy backends are ever eligible; sort for deterministic tie-breaking.
  const healthy = backends.filter((backend) => backend.healthy).sort((a, b) => a.port - b.port);
  if (healthy.length === 0) return null;

  // 1. Explicit session affinity wins (required for duplicate directories).
  if (input.affinityPort != null) {
    const match = healthy.find((backend) => backend.port === input.affinityPort);
    if (match) return { backend: match, reason: "session-affinity" };
  }

  // 2. Route by the request's own directory header/query.
  const byDirectory = matchByDirectory(healthy, input.directory);
  if (byDirectory) return { backend: byDirectory, reason: "directory" };

  // 3. Fall back to a directory resolved from the session id.
  const bySession = matchByDirectory(healthy, input.sessionDirectory);
  if (bySession) return { backend: bySession, reason: "session-directory" };

  // 4. Default: prefer a real backend; the anchor is only a last resort.
  const nonAnchor = healthy.filter((backend) => !backend.anchor);
  if (nonAnchor.length === 0) return { backend: healthy[0]!, reason: "default" };
  if (options.defaultPort != null) {
    const match = nonAnchor.find((backend) => backend.port === options.defaultPort);
    if (match) return { backend: match, reason: "default" };
  }
  return { backend: nonAnchor[0]!, reason: "default" };
}

/** Deterministic owner for a directory when several backends share it (Q5). */
export function directoryOwner(backends: Backend[], directory: string): Backend | null {
  // Prefer the oldest process (lowest pid), then the lowest port.
  const candidates = backends
    .filter((backend) => backend.healthy && backend.primaryDirectory && matchByDirectory([backend], directory))
    .sort((a, b) => (a.pid ?? Number.MAX_SAFE_INTEGER) - (b.pid ?? Number.MAX_SAFE_INTEGER) || a.port - b.port);
  return candidates[0] ?? null;
}
