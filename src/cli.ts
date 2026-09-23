#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultConfig } from "./config.js";
import { callControl, fetchIdentity } from "./control.js";
import { discoverBackends, makeHttpProbe, probeV2Endpoint } from "./discovery/discover.js";
import { listListeners } from "./discovery/ports.js";
import { readV2Service } from "./discovery/service.js";
import { expandTokens, opencode2LaunchArgs, resolveExecutable, resolveOpencode2Executable, resolveOpencodeExecutable } from "./launcher.js";
import { log, logFilePath, setLogFile } from "./logger.js";
import { Registry } from "./registry.js";
import { createMuxServer, OAT_VERSION, type ControlHandlers } from "./server.js";
import { clearState, clearStateIfOwned, isProcessAlive, readState, writeState, type OatState } from "./state.js";
import { BackendSupervisor } from "./supervisor.js";
import type { Backend, OatConfig } from "./types.js";

/** Read the tail of the daemon log file, when present, for error reporting. */
async function logTail(logFile: string, lines = 25): Promise<string> {
  try {
    const content = await fs.promises.readFile(logFile, "utf8");
    return content.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/** Build the loopback base URL for a host/port pair. */
function baseUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

/** Find a running daemon via the state file (validated) or the configured port. */
async function resolveRunning(config: OatConfig): Promise<OatState | null> {
  // Prefer the recorded state, but only if its process is alive and it answers.
  const state = await readState(config.stateDir);
  if (state) {
    const alive = state.pid <= 0 || isProcessAlive(state.pid);
    if (alive && (await fetchIdentity(baseUrl(state.host, state.port)))) return state;
    await clearState(config.stateDir); // stale
  }
  // Fall back to probing the configured port directly.
  const identity = await fetchIdentity(baseUrl(config.host, config.port));
  if (identity?.oat) {
    return {
      pid: identity.pid ?? 0,
      pidStartMarker: null,
      port: config.port,
      host: config.host,
      version: identity.version ?? "0",
      startedAt: 0,
      token: config.token,
    };
  }
  return null;
}

/** Return a running daemon, starting one detached if necessary. */
async function ensureDaemon(config: OatConfig): Promise<OatState> {
  const running = await resolveRunning(config);
  if (running) return running;

  // Re-launch this same CLI in "serve" mode, fully detached (§13.3).
  const entry = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [entry, "serve"], {
    detached: true,
    // Discard stdio: the daemon logs to a file, and a console must not appear.
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      OAT_TOKEN: config.token,
      OAT_PORT: String(config.port),
      // Keep the child's log file identical to the parent's choice.
      OAT_LOG_FILE: config.logFile,
      // Keep the v2 backend password stable across CLI and daemon.
      OAT_V2_PASSWORD: config.v2Password,
    },
  });
  child.unref();

  // Wait (bounded) for the daemon's identity endpoint to answer.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await fetchIdentity(baseUrl(config.host, config.port))) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const state = await readState(config.stateDir);
  const identity = await fetchIdentity(baseUrl(config.host, config.port));
  // On failure, surface the daemon log so the cause is visible.
  if (!state || !identity) {
    const tail = await logTail(config.logFile);
    throw new Error(
      `oat failed to start on ${config.host}:${config.port}.` +
        (tail ? `\nDaemon log (${config.logFile}):\n${tail}` : `\nNo daemon log at ${config.logFile}`),
    );
  }
  return state;
}

/** Render an aligned plain-text table. */
function printTable(headers: string[], rows: string[][]): void {
  // Column widths come from the header and every cell.
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)));
  const format = (cells: string[]): string => cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  console.log(format(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(format(row));
}

/** Print the discovered backends as a table, or JSON with `-json`. */
function renderBackends(body: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  const list = Array.isArray(body) ? (body as Backend[]) : [];
  if (list.length === 0) {
    console.log("(no opencode instances)");
    return;
  }
  printTable(
    ["PORT", "PID", "DIRECTORY", "VERSION", "HEALTHY"],
    list.map((backend) => [
      String(backend.port),
      String(backend.pid ?? ""),
      backend.anchor ? "(maintenance worker)" : backend.primaryDirectory ?? "",
      String(backend.version ?? ""),
      backend.healthy ? "yes" : "no",
    ]),
  );
}

/** Print the daemon status as a key/value table, or JSON with `-json`. */
function renderStatus(body: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    printTable(
      ["KEY", "VALUE"],
      Object.entries(body as Record<string, unknown>).map(([key, value]) => [
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      ]),
    );
    return;
  }
  console.log(String(body));
}

/** Force a fresh scan on the daemon, ignoring failures. */
async function refreshScan(state: OatState): Promise<void> {
  try {
    await callControl(baseUrl(state.host, state.port), state.token, "/reload", "POST");
  } catch {
    // A scan failure must not block reading whatever data is available.
  }
}

/** `oat status`: force a scan, then show status (table, or JSON with `-json`). */
async function statusCommand(config: OatConfig, json: boolean): Promise<number> {
  const running = await resolveRunning(config);
  if (!running) {
    console.error("oat is not running");
    return 1;
  }
  return statusFor(running, json);
}

/** Show status for a daemon we already know about, refreshing first. */
async function statusFor(state: OatState, json: boolean): Promise<number> {
  await refreshScan(state);
  const result = await callControl(baseUrl(state.host, state.port), state.token, "/status");
  if (result.status >= 400) {
    console.error(typeof result.body === "string" ? result.body : JSON.stringify(result.body));
    return 1;
  }
  renderStatus(result.body, json);
  return 0;
}

/** `oat list`: force a scan, then show backends (table, or JSON with `-json`). */
async function listCommand(config: OatConfig, json: boolean): Promise<number> {
  const running = await resolveRunning(config);
  if (!running) {
    console.error("oat is not running");
    return 1;
  }
  await refreshScan(running);
  const result = await callControl(baseUrl(running.host, running.port), running.token, "/list");
  if (result.status >= 400) {
    console.error(typeof result.body === "string" ? result.body : JSON.stringify(result.body));
    return 1;
  }
  renderBackends(result.body, json);
  return 0;
}

/**
 * `oat stop`: ask the daemon to stop; if its control token is unknown (state
 * file lost), fall back to killing the daemon's pid from the identity endpoint.
 */
async function stopCommand(config: OatConfig, json: boolean): Promise<number> {
  const running = await resolveRunning(config);
  if (running) {
    const result = await callControl(baseUrl(running.host, running.port), running.token, "/stop", "POST");
    if (result.status !== 401) {
      if (json) console.log(JSON.stringify(result.body, null, 2));
      else console.log("stopped");
      return result.status >= 400 ? 1 : 0;
    }
    // Unauthorized: fall through to the pid-based recovery.
  }
  const identity = await fetchIdentity(baseUrl(config.host, config.port));
  if (identity?.pid) {
    // Kill only the daemon, never its tree: launched terminals must survive.
    try {
      process.kill(identity.pid);
    } catch {
      // Already gone.
    }
    try {
      execFileSync("taskkill", ["/PID", String(identity.pid), "/F"], { stdio: "ignore", timeout: 8_000 });
    } catch {
      // taskkill is Windows-only / already exited.
    }
    console.log(json ? JSON.stringify({ stopped: identity.pid }) : "stopped");
    return 0;
  }
  console.error("oat is not running");
  return 1;
}

/** `oat reload` / `oat stop`: send a control command and acknowledge. */
async function simpleCommand(config: OatConfig, route: string, okMessage: string, json: boolean): Promise<number> {
  const running = await resolveRunning(config);
  if (!running) {
    console.error("oat is not running");
    return 1;
  }
  const result = await callControl(baseUrl(running.host, running.port), running.token, route, "POST");
  if (json) console.log(JSON.stringify(result.body, null, 2));
  else console.log(okMessage);
  return result.status >= 400 ? 1 : 0;
}

/**
 * Run `oat opencode [args...]`: start opencode in the CURRENT terminal (so you
 * interact with it right here), with the OAT daemon running so the bridge can
 * discover and connect to this instance. Arguments after `opencode` pass through.
 */
async function runOpencode(config: OatConfig, opencodeArgs: string[]): Promise<number> {
  // Ensure the daemon is up so it can discover and route this instance.
  await ensureDaemon(config);
  const directory = process.cwd();
  const { command, shell } = resolveOpencodeExecutable(config.opencodeBin);

  // Recent opencode runs an embedded server unless explicitly given a network
  // flag. Inject a free `--port`/`--hostname` (per the template) so the TUI
  // exposes a real server OAT (and therefore the bridge) can attach to.
  const hasNetworkFlag = opencodeArgs.some(
    (arg) => arg === "--port" || arg.startsWith("--port=") || arg === "--hostname" || arg.startsWith("--hostname=") || arg === "--mdns",
  );
  let args = opencodeArgs;
  if (!hasNetworkFlag) {
    // Only compute a free port when the template actually references one.
    const needsPort = config.opencodeArgs.includes("{host_port}");
    const hostPort = needsPort ? await freePort() : 0;
    const injected = expandTokens(config.opencodeArgs, {
      port: String(config.port),
      host: config.host,
      host_port: String(hostPort),
    });
    args = [...injected, ...opencodeArgs];
    if (needsPort) console.log(`oat: opencode will listen on http://${config.host}:${hostPort} (so the bridge can attach)`);
  }

  console.log(`oat: starting opencode in this terminal (${directory})`);
  // Inherit stdio so the TUI runs here; stay attached until opencode exits.
  const child = spawn(command, args, { cwd: directory, stdio: "inherit", shell, windowsHide: false });
  return await new Promise<number>((resolve) => {
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on("error", (error) => {
      console.error(`oat: failed to start opencode: ${error.message}`);
      resolve(1);
    });
  });
}

/**
 * Run `oat opencode2 [args...]`: start opencode v2 in the CURRENT terminal with
 * a PRIVATE server (`--standalone`) so it stays per-project, and set a known
 * password so OAT can discover and authenticate to it. Arguments pass through.
 */
async function runOpencode2(config: OatConfig, args: string[]): Promise<number> {
  // Ensure the daemon is up so it can discover and route this instance.
  await ensureDaemon(config);
  const directory = process.cwd();
  const { command, shell } = resolveOpencode2Executable(config.opencode2Bin, config.stateDir);
  // Default to a private server (don't hijack v2's shared background service).
  const finalArgs = opencode2LaunchArgs(args);
  console.log(`oat: starting opencode v2 in this terminal (${directory})`);
  // Inherit stdio so the TUI runs here; expose the known server password to it.
  const child = spawn(command, finalArgs, {
    cwd: directory,
    stdio: "inherit",
    shell,
    windowsHide: false,
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: config.v2Password },
  });
  return await new Promise<number>((resolve) => {
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on("error", (error) => {
      console.error(`oat: failed to start opencode v2: ${error.message}`);
      resolve(1);
    });
  });
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

/**
 * Run `oat sesori-bridge [args...]`: start sesori-bridge in the CURRENT terminal,
 * pointed at OAT (auto-start disabled, OAT's port). This lets you move OAT off a
 * busy 4096 with `oat --port <n> sesori-bridge`. Extra args pass through.
 */
async function runSesoriBridge(config: OatConfig, bridgeArgs: string[]): Promise<number> {
  // Ensure OAT is up on the configured port first.
  const state = await ensureDaemon(config);
  // Warn early if there is nothing for the bridge to route to.
  try {
    const listed = await callControl(baseUrl(state.host, state.port), state.token, "/list");
    if (Array.isArray(listed.body) && listed.body.length === 0) {
      console.log("oat: no opencode instances discovered yet - start one with `oat opencode`");
    }
  } catch {
    // A failed pre-flight check must not block starting the bridge.
  }
  // Inject OAT's standard bridge flags (template first, then user args so they win).
  const injected = expandTokens(config.bridgeArgs, { port: String(config.port), host: config.host });
  const args = [...injected, ...bridgeArgs];
  const { command, shell } = resolveExecutable(config.bridgeBin);
  console.log(`oat: starting ${config.bridgeBin} -> OAT http://${config.host}:${config.port}`);
  // Run in this terminal and stay attached until the bridge exits.
  const child = spawn(command, args, { stdio: "inherit", shell, windowsHide: false });
  return await new Promise<number>((resolve) => {
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on("error", (error) => {
      console.error(`oat: failed to start ${config.bridgeBin}: ${error.message}`);
      resolve(1);
    });
  });
}

/** Run the daemon in the foreground until stopped. */
async function runDaemon(config: OatConfig): Promise<void> {
  // Ensure the log directory exists and route logs to the configured file:
  // a detached daemon has its stdio discarded, so the file is the only record.
  await fs.promises.mkdir(path.dirname(config.logFile), { recursive: true });
  setLogFile(config.logFile);
  // Record crashes instead of dying silently.
  process.on("uncaughtException", (error) => log.error("uncaughtException", error));
  process.on("unhandledRejection", (error) => log.error("unhandledRejection", error));
  log.info(
    `oat starting: version=${OAT_VERSION} port=${config.port} host=${config.host} bin=${config.opencodeBin} stateDir=${config.stateDir}`,
  );

  const registry = new Registry();
  // Probe v1 (`/global/health`) then v2 (`/api/info`, Basic) with the known password.
  const probe = makeHttpProbe(config.probeTimeoutMs, { v2Password: config.v2Password, v1Password: config.v1Password });
  const state: OatState = {
    pid: process.pid,
    pidStartMarker: null,
    port: config.port,
    host: config.host,
    version: OAT_VERSION,
    startedAt: Date.now(),
    token: config.token,
  };

  // One discovery pass: enumerate listeners, probe, and update the registry.
  let scanning = false;
  const scan = async (): Promise<void> => {
    if (scanning) return;
    scanning = true;
    try {
      const listeners = await listListeners();
      // Never treat OAT's own port, or a managed (lazily started) backend, as a
      // fresh discovery candidate.
      const skipPorts = new Set<number>([config.port, ...registry.managedPorts()]);
      const backends = await discoverBackends(listeners, {
        probe,
        skipPorts,
        v2Password: config.v2Password,
        v1Password: config.v1Password,
        anchorDir: path.join(config.stateDir, "anchor"),
      });
      // Also attach to a user-started v2 shared service (its password lives on disk).
      const service = await readV2Service();
      if (service) {
        const extra = await probeV2Endpoint(service.url, service.password, config.probeTimeoutMs);
        if (extra && extra.port && !skipPorts.has(extra.port) && !backends.some((b) => b.port === extra.port)) {
          backends.push(extra);
        }
      }
      registry.set(backends);
      const summary = backends.map((b) => `${b.port}${b.primaryDirectory ? `@${b.primaryDirectory}` : ""}`).join(", ");
      log.info(`discovered ${backends.length} backend(s): ${summary || "none"}`);
      // The anchor is a persistent maintenance worker: it is started on demand
      // and stopped only by `oat stop`, never when real instances appear.
    } catch (error) {
      log.warn(`discovery scan failed: ${(error as Error).message}`);
    } finally {
      scanning = false;
    }
  };

  // The supervisor lazily provides an opencode instance for a directory with no
  // server: a visible terminal by default, else a hidden server. It triggers a
  // discovery scan while waiting for a launched terminal's server to appear.
  const supervisor = new BackendSupervisor({
    config,
    registry,
    launchTerminal: config.launchTerminal,
    refresh: () => scan(),
  });
  // Clean up hidden servers left by a previous, now-dead daemon.
  supervisor.reapOrphans();
  supervisor.start();

  let stopping = false;
  let timer: NodeJS.Timeout | undefined = undefined;
  // `let`: server/shutdown/control reference each other (circular), so server is
  // assigned after those closures are defined.
  // eslint-disable-next-line prefer-const
  let server: ReturnType<typeof createMuxServer>;

  // Stop cleanly: halt sweeps, kill managed backends, remove state, close, exit.
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    supervisor.stopAll();
    // Only remove our own state, then drop every connection (SSE included) so
    // close() cannot hang on the bridge's live stream.
    await clearStateIfOwned(config.stateDir, process.pid);
    server.closeAllConnections?.();
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
    process.exit(0);
  };

  // Control handlers exposed over `/__oat/*`.
  const control: ControlHandlers = {
    status: () => ({
      version: OAT_VERSION,
      pid: process.pid,
      port: config.port,
      host: config.host,
      startedAt: state.startedAt,
      backends: registry.list().length,
    }),
    list: () => registry.list(),
    reload: scan,
    stop: shutdown,
  };

  server = createMuxServer({ config, registry, control, supervisor });

  // Bind before advertising ourselves in the state file.
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => resolve());
    });
  } catch (error) {
    log.error(`failed to listen on ${config.host}:${config.port}`, error);
    throw error;
  }
  await writeState(config.stateDir, state);
  log.info(`oat listening on http://${config.host}:${config.port} (pid ${process.pid})`);
  log.info(`oat log file: ${logFilePath() ?? "(none)"}`);

  // Handle Ctrl-C / termination as a clean shutdown.
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // First scan now (this also manages the fallback anchor), then periodically.
  await scan();

  // Start the persistent maintenance worker up front (when enabled) so reads
  // of any cached project are available immediately.
  if (config.anchor) {
    await supervisor.ensureAnchor();
  }

  timer = setInterval(() => void scan(), config.discoveryIntervalMs);
  timer.unref();

  // Keep the daemon alive forever: if runDaemon resolved, main() would call
  // process.exit and terminate the daemon. Shutdown is driven by signals/control.
  await new Promise<void>(() => {});
}

/** CLI usage text (the command column is padded so both columns line up). */
const USAGE = ((): string => {
  const rows: Array<[string, string]> = [
    ["oat", "start (detached) if needed, then show status"],
    ["oat start", "start the daemon (idempotent)"],
    ["oat status", "show daemon status"],
    ["oat list", "list discovered opencode backends"],
    ["oat reload", "re-scan for opencode backends"],
    ["oat stop", "stop the daemon"],
    ["oat opencode [args]", "run opencode in this terminal (args after 'opencode' go to opencode)"],
    ["oat opencode2 [args]", "run opencode v2 in this terminal as a private server (args pass through)"],
    ["oat sesori-bridge [args]", "run the bridge here, pointed at OAT (args pass through)"],
    ["oat serve", "run the daemon in the foreground (internal)"],
    ["oat version", "print version"],
  ];
  // Pad the command column to the longest command for aligned descriptions.
  const width = Math.max(...rows.map(([command]) => command.length));
  const lines = rows.map(([command, description]) => `  ${command.padEnd(width)}  ${description}`);
  return [
    "oat - OpenCode Address Translation",
    "",
    "Usage:",
    ...lines,
    "",
    "Data commands show a table; add -json for JSON (e.g. oat list -json).",
    "",
  ].join("\n");
})();

/** Parse the command line and dispatch to the right operation. */
async function main(): Promise<number> {
  const raw = process.argv.slice(2);
  // `oat [oat-opts] <tool> [args...]` splits at the first tool token; the rest
  // passes through to that tool. First match in the line wins.
  const TOOLS = ["sesori-bridge", "opencode2", "opencode"];
  let tool: string | null = null;
  let splitIndex = -1;
  for (const candidate of TOOLS) {
    const index = raw.indexOf(candidate);
    if (index !== -1 && (splitIndex === -1 || index < splitIndex)) {
      tool = candidate;
      splitIndex = index;
    }
  }
  const oatArgs = tool ? raw.slice(0, splitIndex) : raw;
  const toolArgs = tool ? raw.slice(splitIndex + 1) : [];
  // The command is the tool name, a recognized flag-only command, or the first
  // non-flag OAT argument (a lone `-json` etc. is a flag, not a command).
  const first = oatArgs[0] ?? "";
  const FLAG_COMMANDS = new Set(["-v", "--version", "-h", "--help"]);
  const command = tool ?? (FLAG_COMMANDS.has(first) ? first : first && !first.startsWith("-") ? first : "");
  // `-json` (or `--json`) switches data commands from tables to JSON.
  const json = oatArgs.includes("-json") || oatArgs.includes("--json");
  // Read a `--flag value` or `--flag=value` option from the OAT arguments.
  const option = (name: string): string | undefined => {
    const index = oatArgs.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
    if (index === -1) return undefined;
    const token = oatArgs[index] ?? "";
    return token.includes("=") ? token.slice(token.indexOf("=") + 1) : oatArgs[index + 1];
  };
  // Optional overrides for the log file and port.
  const logFile = option("--log-file");
  const portOption = option("--port");
  const config = defaultConfig({
    ...(logFile ? { logFile } : {}),
    ...(portOption && Number.isFinite(Number(portOption)) ? { port: Number(portOption) } : {}),
  });

  switch (command) {
    // Internal foreground daemon (also used by the detached spawn).
    case "serve":
    case "daemon":
      await runDaemon(config);
      return 0;
    // Runner: run opencode in this terminal, discoverable by OAT.
    case "opencode":
      return runOpencode(config, toolArgs);
    // Runner: run opencode v2 in this terminal as a private server.
    case "opencode2":
      return runOpencode2(config, toolArgs);
    // Runner: run sesori-bridge in this terminal, pointed at OAT.
    case "sesori-bridge":
      return runSesoriBridge(config, toolArgs);
    // Start if needed, then report fresh status.
    case "start":
    case "ensure": {
      const state = await ensureDaemon(config);
      return statusFor(state, json);
    }
    // Report fresh status of a running daemon.
    case "status":
      return statusCommand(config, json);
    // Data commands (fresh scan; table by default, `-json` for JSON).
    case "list":
      return listCommand(config, json);
    case "reload":
      return simpleCommand(config, "/reload", "reloaded", json);
    case "stop":
      return stopCommand(config, json);
    // Simple informational commands.
    case "version":
    case "--version":
    case "-v":
      console.log(OAT_VERSION);
      return 0;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;
    // Bare invocation: ensure a daemon then show fresh status.
    case "": {
      const state = await ensureDaemon(config);
      return statusFor(state, json);
    }
    default:
      console.error(`unknown command: ${command}\n`);
      process.stderr.write(USAGE);
      return 2;
  }
}

// Entry point: map the returned code to the process exit code.
main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
