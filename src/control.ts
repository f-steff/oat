import { OAT_CONTROL_PREFIX } from "./server.js";

/** Identity response returned by `/__oat/identity` when an OAT daemon is listening. */
export interface OatIdentity {
  /** Always true when the endpoint is an OAT daemon. */
  oat: true;
  /** Daemon version, when available. */
  version: string | null;
  /** Daemon process id, when available. */
  pid: number | null;
  /** Port the daemon serves on, when available. */
  port: number | null;
}

/** A control API response: HTTP status plus the decoded body. */
export interface ControlResult {
  /** HTTP status code. */
  status: number;
  /** Parsed JSON body, or the raw text when it is not JSON. */
  body: unknown;
}

/** Narrow an unknown JSON value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Probe `/__oat/identity` to determine whether an OAT daemon is listening at `baseUrl`. */
export async function fetchIdentity(baseUrl: string, timeoutMs = 1_000): Promise<OatIdentity | null> {
  try {
    // The identity route is intentionally unauthenticated so a second invocation
    // can discover the daemon before it reads the token from the state file.
    const response = await fetch(`${baseUrl}${OAT_CONTROL_PREFIX}/identity`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const json = asRecord(await response.json());
    if (json?.oat !== true) return null;
    return {
      oat: true,
      version: typeof json.version === "string" ? json.version : null,
      pid: typeof json.pid === "number" ? json.pid : null,
      port: typeof json.port === "number" ? json.port : null,
    };
  } catch {
    return null;
  }
}

/** Call a token-protected control route on a running daemon. */
export async function callControl(
  baseUrl: string,
  token: string,
  route: string,
  method: "GET" | "POST" = "GET",
): Promise<ControlResult> {
  // Present the bearer token and decode JSON when possible, falling back to text.
  const response = await fetch(`${baseUrl}${OAT_CONTROL_PREFIX}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep the raw text when the body is not JSON.
  }
  return { status: response.status, body };
}
