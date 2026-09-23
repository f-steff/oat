import { normalizeDir } from "../router.js";
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
  /** Password used to authenticate against v1 servers (`OPENCODE_SERVER_PASSWORD`). */
  v1Password?: string;
}

/** Build the default HTTP probe: v1 `/global/health` + `/path`, v2 `/api/info` + `/api/location`. */
export function makeHttpProbe(timeoutMs = 1_000, options: HttpProbeOptions = {}): Probe {
  return {
    // v1 answers `{healthy:true, version}`; otherwise try v2's `/api/info` with Basic auth.
    async health(baseUrl) {
      let v1 = asRecord(await getJson(`${baseUrl}/global/health`, timeoutMs));
      // A password-protected v1 server rejects the anonymous probe; retry with Basic.
      if (v1?.healthy !== true && options.v1Password) {
        v1 = asRecord(await getJson(`${baseUrl}/global/health`, timeoutMs, options.v1Password));
      }
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
      const json = asRecord(await getJson(`${baseUrl}/path`, timeoutMs, options.v1Password));
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
  /** Password used to authenticate against v1 backends (attached to detected v1 servers). */
  v1Password?: string;
  /**
   * This daemon's own maintenance-worker directory. Servers found there are
   * kept (marked `anchor: true`) so they can be adopted instead of duplicated;
   * every other anchor directory is hidden.
   */
  anchorDir?: string | null;
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
  const probe = options.probe ?? makeHttpProbe(1_000, { v2Password: options.v2Password, v1Password: options.v1Password });
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
      // Maintenance workers are hidden, except our own (kept so it can be adopted).
      const anchorDir = options.anchorDir ?? null;
      const ours = anchorDir != null && primaryDirectory != null && normalizeDir(primaryDirectory) === normalizeDir(anchorDir);
      if (isOatAnchorDir(primaryDirectory) && !ours) return null;
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
        ...(ours ? { anchor: true } : {}),
        // A detected backend is only reachable because we know its password.
        ...(kind === "v2" && options.v2Password ? { password: options.v2Password } : {}),
        ...(kind === "v1" && options.v1Password ? { password: options.v1Password } : {}),
      };
    }),
  );

  // Keep only successful probes, ordered deterministically by port.
  return results.filter((backend): backend is Backend => backend !== null).sort((a, b) => a.port - b.port);
}

/**
 * Probe a known v2 endpoint directly (e.g. from `readV2Service`) and return a
 * Backend, or null when it does not answer as a v2 server.
 */
export async function probeV2Endpoint(
  baseUrl: string,
  password: string,
  timeoutMs = 1_000,
  now: () => number = Date.now,
): Promise<Backend | null> {
  const info = asRecord(await getJson(`${baseUrl}/api/info`, timeoutMs, password));
  if (!info || typeof info.version !== "string") return null;
  const location = asRecord(await getJson(`${baseUrl}/api/location`, timeoutMs, password));
  const primaryDirectory = typeof location?.directory === "string" ? location.directory : null;
  // OAT's own maintenance/anchor v2 servers are never user projects.
  if (isOatAnchorDir(primaryDirectory)) return null;
  let port = 0;
  try {
    port = Number(new URL(baseUrl).port) || 0;
  } catch {
    port = 0;
  }
  return {
    port,
    pid: typeof info.pid === "number" ? info.pid : null,
    baseUrl,
    primaryDirectory,
    version: info.version,
    healthy: true,
    lastSeen: now(),
    kind: "v2",
    password,
  };
}
