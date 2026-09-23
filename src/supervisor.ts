import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { log } from "./logger.js";
import {
  buildLaunchSpec,
  expandTokens,
  killProcess,
  launchTerminal,
  resolveOpencode2Executable,
  resolveOpencodeExecutable,
  type LaunchSpec,
} from "./launcher.js";
import { basicAuth } from "./discovery/discover.js";
import type { Registry } from "./registry.js";
import { isProcessAlive } from "./state.js";
import { normalizeDir } from "./router.js";
import type { Backend, BackendKind, OatConfig } from "./types.js";

/** A process started by the supervisor. */
export interface SpawnedBackend {
  /** OS process id of the started process. */
  pid: number;
  /** Best-effort termination of the process (and its tree). */
  kill: () => void;
}

/** Options for constructing a `BackendSupervisor`. */
export interface SupervisorOptions {
  /** Runtime configuration (opencode binary, idle timeout, ...). */
  config: OatConfig;
  /** Registry that managed backends are added to / removed from. */
  registry: Registry;
  /** Override the backend spawner (tests). */
  spawnBackend?: (port: number, directory: string) => SpawnedBackend;
  /** Override the health probe (tests). */
  probeHealth?: (port: number) => Promise<boolean>;
  /** Override free-port selection (tests). */
  findFreePort?: () => Promise<number>;
  /** Clock injection (tests). */
  now?: () => number;
  /** Override process termination (tests); defaults to a pid-only kill. */
  kill?: (pid: number) => void;
  /** How often the idle sweep runs, in milliseconds. */
  idleSweepMs?: number;
  /** How long to wait for a freshly started backend to become healthy. */
  healthTimeoutMs?: number;
  /** When true, open a visible terminal running opencode instead of a hidden server. */
  launchTerminal?: boolean;
  /** Override the terminal launch command builder (tests). */
  launchSpec?: (directory: string, opencodeArgs: string[]) => LaunchSpec | null;
  /** Override the terminal launcher itself (tests). */
  launch?: (spec: LaunchSpec) => boolean;
  /** Trigger a discovery scan while waiting for a launched terminal's server. */
  refresh?: () => Promise<void>;
  /** Maximum number of OAT-started instances (safety cap). Default 32 or OAT_MAX_INSTANCES. */
  maxInstances?: number;
  /** Maximum new instances started per rolling minute (burst guard). Default 6 or OAT_SPAWNS_PER_MINUTE. */
  spawnsPerMinute?: number;
  /** How long before a launched-but-absent instance may be reopened (default 60s). */
  relaunchGraceMs?: number;
}

/** Find a free loopback TCP port by binding to port 0. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Probe a backend's health (v1 `/global/health`, v2 `/api/info` with Basic auth). */
async function probeHealth(port: number, kind: BackendKind = "v1", password?: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  try {
    if (kind === "v2") {
      const headers: Record<string, string> = password ? { authorization: basicAuth(password) } : {};
      const response = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: controller.signal, headers });
      const body = (await response.json()) as { version?: unknown };
      return response.ok && typeof body.version === "string";
    }
    const response = await fetch(`http://127.0.0.1:${port}/global/health`, { signal: controller.signal });
    // Only a healthy opencode body counts as success.
    const body = (await response.json()) as { healthy?: boolean };
    return response.ok && body.healthy === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts an opencode server on demand for a directory with no live backend, and
 * idle-shuts it down again (FR-13 / Q1).
 */
export class BackendSupervisor {
  private readonly config: OatConfig;
  private readonly registry: Registry;
  /** Which opencode generation this supervisor starts (v1 `serve`, or v2 `opencode2 serve`). */
  private readonly kind: BackendKind;
  private readonly spawnBackend: (port: number, directory: string) => SpawnedBackend;
  private readonly probe: (port: number) => Promise<boolean>;
  private readonly findPort: () => Promise<number>;
  private readonly now: () => number;
  /** Terminates a process by pid (injectable for tests). */
  private readonly killPid: (pid: number) => void;
  private readonly idleSweepMs: number;
  private readonly healthTimeoutMs: number;
  /** Whether to open a visible terminal (true) or a hidden server (false). */
  private readonly useTerminal: boolean;
  /** Builds the terminal command for a directory. */
  private readonly launchSpec: (directory: string, opencodeArgs: string[]) => LaunchSpec | null;
  /** Opens the terminal window. */
  private readonly launch: (spec: LaunchSpec) => boolean;
  /** Optional scan trigger used while waiting for a launched terminal's server. */
  private readonly refresh: (() => Promise<void>) | undefined;
  /** Terminal instances by normalized directory: chosen port and launch time. */
  private readonly launched = new Map<string, { port: number; at: number }>();
  /** Safety cap on the number of instances OAT will start. */
  private readonly maxInstances: number;
  /** Maximum new instances started per rolling minute. */
  private readonly spawnsPerMinute: number;
  /** Timestamps of recent instance starts, for the burst guard. */
  private readonly spawnTimes: number[] = [];
  /** How long before a launched-but-absent instance may be reopened. */
  private readonly relaunchGraceMs: number;
  /** File recording the hidden servers this daemon owns (for orphan reaping). */
  private readonly recordFile: string;
  /** Last-used timestamp per managed port, for idle shutdown. */
  private readonly lastUsed = new Map<number, number>();
  /** Spawn handles per managed port, so shutdown uses the matching kill function. */
  private readonly spawned = new Map<number, SpawnedBackend>();
  /** In-flight spawns keyed by normalized directory, to dedupe concurrent requests. */
  private readonly inFlight = new Map<string, Promise<Backend | null>>();
  /** Port of the default "anchor" backend, if one is running. */
  private anchorPort: number | null = null;
  private timer: NodeJS.Timeout | undefined;

  /** Build a supervisor, defaulting to real process/net/fetch implementations. */
  constructor(options: SupervisorOptions) {
    this.config = options.config;
    this.kind = this.config.backendVersion;
    this.registry = options.registry;
    this.now = options.now ?? Date.now;
    this.killPid = options.kill ?? killProcess;
    this.idleSweepMs = options.idleSweepMs ?? 60_000;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 30_000;
    this.probe =
      options.probeHealth ??
      ((port) => probeHealth(port, this.kind, this.kind === "v2" ? this.config.v2Password : undefined));
    this.findPort = options.findFreePort ?? freePort;
    this.useTerminal = options.launchTerminal ?? false;
    this.refresh = options.refresh;
    this.launch = options.launch ?? launchTerminal;
    this.maxInstances = options.maxInstances ?? Number(process.env.OAT_MAX_INSTANCES ?? 32);
    this.spawnsPerMinute = options.spawnsPerMinute ?? Number(process.env.OAT_SPAWNS_PER_MINUTE ?? 6);
    this.relaunchGraceMs = options.relaunchGraceMs ?? 60_000;
    this.recordFile = path.join(this.config.stateDir, "managed.json");
    this.launchSpec =
      options.launchSpec ??
      ((directory, opencodeArgs) => buildLaunchSpec(directory, process.platform, this.config.launchCommand, opencodeArgs));
    // Default spawner launches a headless server detached in the target
    // directory, with no console window and output redirected to a log file.
    this.spawnBackend = options.spawnBackend ?? ((port, directory) => this.defaultSpawn(port, directory));
  }

  /** Start a headless opencode server (v1 `serve`, or v2 `opencode2 serve`) for a directory. */
  private defaultSpawn(port: number, directory: string): SpawnedBackend {
    // Redirect server output to a log file.
    const logDir = path.join(this.config.stateDir, "logs");
    let logFd: number | undefined;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      logFd = fs.openSync(path.join(logDir, `${this.kind === "v2" ? "opencode2" : "opencode"}-${port}.log`), "a");
    } catch {
      logFd = undefined;
    }
    const stdio: "ignore" | Array<"ignore" | number> = logFd !== undefined ? ["ignore", logFd, logFd] : "ignore";
    // v2 servers use an OAT-chosen password; v1 servers reuse OPENCODE_SERVER_PASSWORD if set.
    const env =
      this.kind === "v2"
        ? { ...process.env, OPENCODE_SERVER_PASSWORD: this.config.v2Password }
        : this.config.v1Password
          ? { ...process.env, OPENCODE_SERVER_PASSWORD: this.config.v1Password }
          : process.env;
    const { command, args } =
      this.kind === "v2"
        ? {
            command: resolveOpencode2Executable(this.config.opencode2Bin, this.config.stateDir).command,
            args: expandTokens(this.config.opencode2Args, {
              port: String(this.config.port),
              host: this.config.host,
              host_port: String(port),
            }),
          }
        : { command: resolveOpencodeExecutable(this.config.opencodeBin).command, args: ["serve", "--port", String(port)] };
    // No shell: a shell would flash a console window on Windows.
    const child = spawn(command, args, { cwd: directory, detached: true, stdio, windowsHide: true, env });
    // A failed spawn (missing binary) must not crash the daemon.
    child.on("error", (error) => log.warn(`supervisor: failed to start opencode: ${error.message}`));
    // The child holds the descriptor now; close our copy.
    if (logFd !== undefined) {
      try {
        fs.closeSync(logFd);
      } catch {
        // Ignore.
      }
    }
    child.unref();
    const pid = child.pid ?? -1;
    return { pid, kill: () => killProcess(pid) };
  }

  /** Start the periodic idle sweep. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.idleSweepMs);
    this.timer.unref();
  }

  /** Mark a managed backend as recently used so it is not idled out. */
  touch(port: number): void {
    if (this.lastUsed.has(port)) this.lastUsed.set(port, this.now());
  }

  /**
   * Return a backend for `directory`, starting one if none exists.
   * `sessionId`, when known, is resumed in a launched terminal so the window
   * shows the session the user is actually working on.
   * Concurrent callers for the same directory share a single spawn.
   */
  async ensure(directory: string, sessionId?: string): Promise<Backend | null> {
    const normalized = normalizeDir(directory);
    // Reuse an existing (discovered or managed) backend for this directory.
    const existing = this.registry
      .list()
      .find((backend) => backend.primaryDirectory && normalizeDir(backend.primaryDirectory) === normalized);
    if (existing) {
      this.touch(existing.port);
      return existing;
    }
    // Deduplicate concurrent requests for the same directory.
    const pending = this.inFlight.get(normalized);
    if (pending) return pending;
    const promise = this.launchOrSpawn(directory, normalized, sessionId);
    this.inFlight.set(normalized, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(normalized);
    }
  }

  /** Open a terminal for the directory (when enabled), else start a hidden server. */
  private async launchOrSpawn(directory: string, normalized: string, sessionId?: string): Promise<Backend | null> {
    // Never exceed the safety cap on OAT-started instances.
    if (this.activeInstanceCount() >= this.maxInstances) {
      log.warn(`supervisor: instance cap (${this.maxInstances}) reached; not starting one for ${directory}`);
      return null;
    }
    // Preferred: a visible terminal the user can work in. v2 uses hidden
    // `opencode2 serve` backends (the user runs the TUI with `oat opencode2`).
    if (this.useTerminal && this.kind !== "v2") {
      const prior = this.launched.get(normalized);
      if (prior) {
        // Adopt the launched instance's server if it is still running.
        const existing = this.registry.get(prior.port);
        if (existing?.healthy) return existing;
        // Still within the grace window: it may just be slow to appear.
        if (this.now() - prior.at <= this.relaunchGraceMs) {
          return await this.waitForDiscovered(directory);
        }
        // The instance is gone (terminal closed): allow a fresh launch.
        this.launched.delete(normalized);
      }
      if (!this.allowSpawn()) {
        log.warn(`supervisor: spawn rate limit (${this.spawnsPerMinute}/min) reached; not starting one for ${directory}`);
        return null;
      }
      // Inject a free port so the TUI exposes a server OAT can discover, and
      // resume the session being viewed so the window shows that session.
      const hostPort = await this.findPort();
      const injected = expandTokens(this.config.opencodeArgs, {
        port: String(this.config.port),
        host: this.config.host,
        host_port: String(hostPort),
      });
      const spec = this.launchSpec(directory, sessionId ? [...injected, "-s", sessionId] : injected);
      if (spec && this.launch(spec)) {
        this.launched.set(normalized, { port: hostPort, at: this.now() });
        log.info(`supervisor: opened a terminal for ${directory} (opencode on http://${this.config.host}:${hostPort})`);
        // The terminal opened; adopt the server it starts (no hidden duplicate).
        return await this.waitForDiscovered(directory);
      }
      log.warn(`supervisor: could not open a terminal for ${directory}; starting a hidden server`);
    }
    // Fallback: a hidden server OAT owns.
    if (!this.allowSpawn()) {
      log.warn(`supervisor: spawn rate limit (${this.spawnsPerMinute}/min) reached; not starting one for ${directory}`);
      return null;
    }
    return this.spawnAndWait(directory);
  }

  /** Wait (bounded, wall-clock) for a discovered backend matching the directory. */
  private async waitForDiscovered(directory: string): Promise<Backend | null> {
    const target = normalizeDir(directory);
    const deadline = Date.now() + this.healthTimeoutMs;
    while (Date.now() < deadline) {
      if (this.refresh) {
        try {
          await this.refresh();
        } catch {
          // A failed refresh must not abort the wait.
        }
      }
      const found = this.registry
        .list()
        .find((backend) => backend.healthy && backend.primaryDirectory && normalizeDir(backend.primaryDirectory) === target);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  }

  /**
   * Ensure a default "anchor" backend exists for headerless global reads
   * (`/project`, `/experimental/session`, ...). It is registered with a null
   * primary directory so it never matches a directory request, and it is never
   * idle-shut while the daemon runs.
   */
  async ensureAnchor(): Promise<Backend | null> {
    // Reuse the anchor if it is still registered and healthy.
    if (this.anchorPort != null) {
      const existing = this.registry.get(this.anchorPort);
      if (existing?.healthy) return existing;
      this.anchorPort = null;
    }
    // Run the anchor from an OAT-owned directory so it cannot collide with a project.
    const directory = path.join(this.config.stateDir, "anchor");
    const target = normalizeDir(directory);
    // Reap any maintenance worker already running in our directory (e.g. left by
    // a previous daemon) so exactly one anchor exists and this daemon owns it.
    for (const stale of this.registry.list()) {
      if (stale.anchor && stale.pid && normalizeDir(stale.primaryDirectory ?? "") === target) {
        log.info(`supervisor: reaping stale anchor on :${stale.port}`);
        this.killPid(stale.pid);
      }
    }
    try {
      await fs.promises.mkdir(directory, { recursive: true });
    } catch {
      // Directory creation is best-effort; spawn will surface real failures.
    }
    const backend = await this.spawnAndWait(directory, true);
    if (backend) this.anchorPort = backend.port;
    return backend;
  }

  /** Number of instances OAT started (terminal launches + hidden per-directory servers). */
  private activeInstanceCount(): number {
    const hidden = this.registry.managedPorts().filter((port) => port !== this.anchorPort).length;
    return this.launched.size + hidden;
  }

  /** Rolling-minute spawn budget; records the start when allowed. */
  private allowSpawn(): boolean {
    const cutoff = this.now() - 60_000;
    while (this.spawnTimes.length > 0 && (this.spawnTimes[0] ?? 0) < cutoff) this.spawnTimes.shift();
    if (this.spawnTimes.length >= this.spawnsPerMinute) return false;
    this.spawnTimes.push(this.now());
    return true;
  }

  /** Kill hidden servers left by a previous (now dead) daemon, if any. */
  reapOrphans(): void {
    try {
      const record = JSON.parse(fs.readFileSync(this.recordFile, "utf8")) as { daemonPid?: number; pids?: number[] };
      // Only reap when the owning daemon is gone (never disturb a live one).
      if (record.daemonPid && record.daemonPid !== process.pid && !isProcessAlive(record.daemonPid)) {
        for (const pid of record.pids ?? []) killProcess(pid);
        log.info(`supervisor: reaped ${record.pids?.length ?? 0} orphaned server(s)`);
      }
    } catch {
      // No record yet.
    }
    try {
      fs.unlinkSync(this.recordFile);
    } catch {
      // Nothing to clear.
    }
  }

  /** Persist the hidden servers this daemon owns (best-effort). */
  private persistManaged(): void {
    try {
      const pids = [...this.spawned.values()].map((child) => child.pid);
      fs.writeFileSync(this.recordFile, JSON.stringify({ daemonPid: process.pid, pids }), "utf8");
    } catch {
      // Best-effort only.
    }
  }

  /** Spawn a server, wait for health, and register it. */
  private async spawnAndWait(directory: string, anchor = false): Promise<Backend | null> {
    let port: number;
    try {
      port = await this.findPort();
    } catch (error) {
      log.warn(`supervisor: could not find a free port: ${(error as Error).message}`);
      return null;
    }

    let child: SpawnedBackend;
    try {
      child = this.spawnBackend(port, directory);
    } catch (error) {
      log.warn(`supervisor: failed to start opencode for ${directory}: ${(error as Error).message}`);
      return null;
    }

    // Health-gate the new server before exposing it to the bridge.
    const healthy = await this.waitHealth(port);
    if (!healthy) {
      log.warn(`supervisor: opencode on :${port} for ${directory} did not become healthy`);
      child.kill();
      return null;
    }

    const backend: Backend = {
      port,
      pid: child.pid,
      baseUrl: `http://127.0.0.1:${port}`,
      // The anchor has no directory so it is only ever the default backend.
      primaryDirectory: anchor ? null : directory,
      version: null,
      healthy: true,
      lastSeen: this.now(),
      anchor,
      kind: this.kind,
      ...(this.kind === "v2" ? { password: this.config.v2Password } : {}),
    };
    this.registry.addManaged(backend);
    this.spawned.set(port, child);
    this.persistManaged();
    // Track usage for idle shutdown, except for the permanent anchor.
    if (!anchor) this.lastUsed.set(port, this.now());
    log.info(`supervisor: started opencode ${anchor ? "(anchor) " : ""}for ${directory} on :${port} (pid ${child.pid})`);
    return backend;
  }

  /** Poll health until the backend answers or the timeout elapses. */
  private async waitHealth(port: number): Promise<boolean> {
    const deadline = this.now() + this.healthTimeoutMs;
    while (this.now() < deadline) {
      if (await this.probe(port)) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  /** Stop managed backends that have been idle beyond the configured timeout. */
  sweep(): void {
    const now = this.now();
    for (const port of this.registry.managedPorts()) {
      // The anchor is permanent and never idled out.
      if (port === this.anchorPort) continue;
      const used = this.lastUsed.get(port) ?? 0;
      if (now - used > this.config.idleShutdownMs) {
        this.stopBackend(port);
      }
    }
  }

  /** Stop one managed backend and unregister it. */
  private stopBackend(port: number): void {
    // Forget the anchor when it is the one being stopped.
    if (port === this.anchorPort) this.anchorPort = null;
    // Prefer the recorded spawn handle so injected spawners can be exercised.
    const child = this.spawned.get(port);
    if (child) {
      child.kill();
      this.spawned.delete(port);
    } else {
      const backend = this.registry.get(port);
      if (backend?.pid) killProcess(backend.pid);
    }
    this.registry.removeManaged(port);
    this.lastUsed.delete(port);
    this.persistManaged();
    log.info(`supervisor: stopped idle opencode on :${port}`);
  }

  /** Stop every managed backend (called on daemon shutdown). */
  stopAll(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const port of this.registry.managedPorts()) {
      this.stopBackend(port);
    }
    // Nothing hidden is owned by this daemon anymore.
    try {
      fs.unlinkSync(this.recordFile);
    } catch {
      // Already gone.
    }
  }
}
