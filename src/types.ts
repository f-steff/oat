/**
 * Shared type definitions for OAT.
 *
 * These types are deliberately transport-agnostic so the router, discovery and
 * server layers can be unit-tested in isolation.
 */

/** A listening TCP socket found by platform discovery (one row per socket). */
export interface RawListener {
  /** TCP port that is in the LISTEN state. */
  port: number;
  /** Owning process id when the platform can supply it, else null. */
  pid: number | null;
  /** Local bind address (may be empty when discovery cannot report it). */
  address: string;
}

/** A live opencode server that OAT has discovered and health-probed. */
export interface Backend {
  /** The port the opencode server listens on. */
  port: number;
  /** Owning process id, when known. */
  pid: number | null;
  /** Base URL used to reach the server, e.g. `http://127.0.0.1:4096`. */
  baseUrl: string;
  /** The server's own working directory (`GET /path` with no directory header). */
  primaryDirectory: string | null;
  /** Server version from `/global/health`. */
  version: string | null;
  /** Whether the most recent health probe succeeded. */
  healthy: boolean;
  /** Epoch milliseconds of the last successful probe. */
  lastSeen: number;
  /** True only for OAT's own fallback "anchor" server (never routed while others exist). */
  anchor?: boolean;
}

/** Why a particular backend was chosen for a request (useful in logs/tests). */
export type RouteReason = "session-affinity" | "directory" | "session-directory" | "default";

/** The outcome of routing a request: the chosen backend and the reason. */
export interface RouteDecision {
  backend: Backend;
  reason: RouteReason;
}

/** Runtime configuration for the OAT daemon. */
export interface OatConfig {
  /** Port OAT listens on and the bridge is pointed at. Default `OPENCODE_PORT` or 4096. */
  port: number;
  /** Host OAT binds to (loopback by default). */
  host: string;
  /** Directory used for the state/control files. */
  stateDir: string;
  /** How often discovery re-scans for backends, in milliseconds. */
  discoveryIntervalMs: number;
  /** Per-request probe timeout, in milliseconds. */
  probeTimeoutMs: number;
  /** Idle time before a lazily started backend is shut down, in milliseconds. */
  idleShutdownMs: number;
  /** When true, stamp `x-oat-backend` headers/SSE comments for debugging. */
  debugAttribution: boolean;
  /** Bearer token guarding the `/__oat/*` control API. */
  token: string;
  /** Path to the opencode executable used to lazily start servers. */
  opencodeBin: string;
  /** When true, start a permanent anchor server if none is listening (default true). */
  anchor: boolean;
  /** File the daemon appends its log to (default `<stateDir>/oat.log`). */
  logFile: string;
  /** Open a visible terminal (with opencode) instead of a hidden server (default false). */
  launchTerminal: boolean;
  /** Optional terminal launch template with `{dir}` and `{title}` placeholders. */
  launchCommand: string | null;
  /** Path/name of the sesori-bridge executable (default `sesori-bridge`). */
  bridgeBin: string;
  /** Args injected before user args for `oat sesori-bridge` (`{port}`, `{host}`). */
  bridgeArgs: string;
  /** Args injected for `oat opencode` when no network flag is given (`{host_port}`, `{host}`). */
  opencodeArgs: string;
}
