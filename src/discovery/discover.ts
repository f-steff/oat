import type { Backend, BackendKind, RawListener } from "../types.js";

/** Result of probing a server (v1 `/global/health` or v2 `/api/info`). */
export interface HealthResult {
  /** True when the endpoint reported the server is up. */
  healthy: boolean;
  /** Reported server version, when present. */
  version: string | null;
  /** Which protocol generation answered (defaults to `"v1"`). */
  kind?: BackendKind;
}

/** Probe primitive used to identify and describe an opencode server. */
export interface Probe {
  /** Probe a base URL, detecting v1 (`/global/health`) or v2 (`/api/info`). */
  health(baseUrl: string): Promise<HealthResult | null>;
  /** Read the server's own directory (v1 `GET /path`, v2 `GET /api/location`). */
  path(baseUrl: string, kind?: BackendKind): Promise<string | null>;
}

/** Build the HTTP `Authorization: Basic` value for a v2 server (user `opencode`). */
export function basicAuth(password: string, username = "opencode"): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/** Narrow an unknown JSON value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Fetch and parse JSON with a bounded timeout, returning null on any failure. */
async function getJson(url: string, timeoutMs: number, password?: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = password ? { authorization: basicAuth(password) } : {};
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Options for the default HTTP probe. */
export interface HttpProbeOptions {
  /** Password used to authenticate against v2 servers (`OAT_V2_PASSWORD`). */
  v2Password?: string;
}

/** Build the default HTTP probe: v1 `/global/health` + `/path`, v2 `/api/info` + `/api/location`. */
export function makeHttpProbe(timeoutMs = 1_000, options: HttpProbeOptions = {}): Probe {
  return {
    // v1 answers `{healthy:true, version}`; otherwise try v2's `/api/info` with Basic auth.
    async health(baseUrl) {
      const v1 = asRecord(await getJson(`${baseUrl}/global/health`, timeoutMs));
      if (v1?.healthy === true) {
        const version = typeof v1.version === "string" ? v1.version : null;
        // Another OAT instance answers /global/health too; never treat it as opencode.
        if (version?.toLowerCase().startsWith("oat/")) return null;
        return { healthy: true, version, kind: "v1" };
      }
      if (options.v2Password) {
        const info = asRecord(await getJson(`${baseUrl}/api/info`, timeoutMs, options.v2Password));
        if (info && typeof info.version === "string") return { healthy: true, version: info.version, kind: "v2" };
      }
      return null;
    },
    // The un-headered v1 `/path` (or v2 `/api/location`) names the server's own directory.
    async path(baseUrl, kind) {
      if (kind === "v2") {
        if (!options.v2Password) return null;
        const info = asRecord(await getJson(`${baseUrl}/api/location`, timeoutMs, options.v2Password));
        const directory = info?.directory ?? asRecord(info?.data)?.directory;
        return typeof directory === "string" ? directory : null;
      }
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
  /** Password used to authenticate against v2 backends (attached to detected v2 servers). */
  v2Password?: string;
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
  const probe = options.probe ?? makeHttpProbe(1_000, { v2Password: options.v2Password });
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
      const kind = health.kind ?? "v1";
      // Capture the primary directory and the owning pid (if discovery found it).
      const primaryDirectory = await probe.path(baseUrl, kind);
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
        kind,
        // A detected v2 backend is only reachable because we know the password.
        ...(kind === "v2" && options.v2Password ? { password: options.v2Password } : {}),
      };
    }),
  );

  // Keep only successful probes, ordered deterministically by port.
  return results.filter((backend): backend is Backend => backend !== null).sort((a, b) => a.port - b.port);
}
