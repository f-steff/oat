import type { Backend, RawListener } from "../types.js";

/** Result of probing `/global/health`. */
export interface HealthResult {
  /** True when the endpoint reported `healthy: true`. */
  healthy: boolean;
  /** Reported server version, when present. */
  version: string | null;
}

/** Probe primitive used to identify and describe an opencode server. */
export interface Probe {
  /** Probe `/global/health` for a base URL. */
  health(baseUrl: string): Promise<HealthResult | null>;
  /** Read the server's own directory from `GET /path`. */
  path(baseUrl: string): Promise<string | null>;
}

/** Narrow an unknown JSON value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Fetch and parse JSON with a bounded timeout, returning null on any failure. */
async function getJson(url: string, timeoutMs: number): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Build the default HTTP probe for opencode's `/global/health` and `/path`. */
export function makeHttpProbe(timeoutMs = 1_000): Probe {
  return {
    // Health is identified by the `{healthy:true}` body.
    async health(baseUrl) {
      const json = asRecord(await getJson(`${baseUrl}/global/health`, timeoutMs));
      if (json?.healthy !== true) return null;
      const version = typeof json.version === "string" ? json.version : null;
      // Another OAT instance answers /global/health too; never treat it as opencode.
      if (version?.toLowerCase().startsWith("oat/")) return null;
      return { healthy: true, version };
    },
    // The un-headered `/path` response names the server's own working directory.
    async path(baseUrl) {
      const json = asRecord(await getJson(`${baseUrl}/path`, timeoutMs));
      return typeof json?.directory === "string" ? json.directory : null;
    },
  };
}

/** Options for `discoverBackends`. */
export interface DiscoverOptions {
  /** Probe implementation (defaults to the HTTP probe). */
  probe?: Probe;
  /** Ports to ignore (e.g. OAT's own port). */
  skipPorts?: Set<number>;
  /** Clock injection for tests. */
  now?: () => number;
}

/** True for OAT's internal anchor/maintenance directories, which are not projects. */
export function isOatAnchorDir(directory: string | null): boolean {
  if (!directory) return false;
  const parts = directory.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  const base = parts[parts.length - 1] ?? "";
  const parent = parts[parts.length - 2] ?? "";
  // Matches `<...>/oat/anchor` and `<...>/oat-daemon-xxxx/anchor`.
  return base === "anchor" && parent.startsWith("oat");
}

/** Probe candidate listeners and return those that are live opencode servers. */
export async function discoverBackends(
  listeners: RawListener[],
  options: DiscoverOptions = {},
): Promise<Backend[]> {
  const probe = options.probe ?? makeHttpProbe();
  const now = options.now ?? Date.now;
  const skip = options.skipPorts ?? new Set<number>();
  // De-duplicate ports and drop any the caller asked to skip.
  const ports = [...new Set(listeners.map((listener) => listener.port))].filter((port) => !skip.has(port));

  const results = await Promise.all(
    ports.map(async (port): Promise<Backend | null> => {
      const baseUrl = `http://127.0.0.1:${port}`;
      // A candidate only counts if its health probe succeeds.
      const health = await probe.health(baseUrl);
      if (!health?.healthy) return null;
      // Capture the primary directory and the owning pid (if discovery found it).
      const primaryDirectory = await probe.path(baseUrl);
      // OAT's own anchor/maintenance servers are never user projects.
      if (isOatAnchorDir(primaryDirectory)) return null;
      const listener = listeners.find((entry) => entry.port === port);
      return {
        port,
        pid: listener?.pid ?? null,
        baseUrl,
        primaryDirectory,
        version: health.version,
        healthy: true,
        lastSeen: now(),
      };
    }),
  );

  // Keep only successful probes, ordered deterministically by port.
  return results.filter((backend): backend is Backend => backend !== null).sort((a, b) => a.port - b.port);
}
