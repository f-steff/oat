import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { callControl } from "./control.js";
import { readV2Service } from "./discovery/service.js";
import { resolveOpencodeExecutable } from "./launcher.js";
import {
  describeInfo,
  installPlan,
  latestNpmVersion,
  resolveOpencodeInfo,
  updatePlan,
  type CommandPlan,
  type InstallMethod,
  type OpencodeInfo,
} from "./opencode-method.js";
import { readState } from "./state.js";
import {
  closeTuis,
  relaunchTuis,
  resumeCommand,
  snapshotTuis,
  type TuiEntry,
  type TuiRelaunchResult,
} from "./tuis.js";
import type { OatConfig } from "./types.js";

/** Parsed options for the lifecycle commands. */
export interface LifecycleOptions {
  check: boolean;
  method: "auto" | InstallMethod;
  version: string;
  /** 0 = wait indefinitely. */
  timeoutMs: number;
  forceInterrupt: boolean;
  noRelaunch: boolean;
  forceCloseTuis: boolean;
  backupDb: boolean;
  yes: boolean;
  force: boolean;
  json: boolean;
  help: boolean;
  unknown: string[];
}

/** Usage text for `oat install|update|restart opencode`. */
export const LIFECYCLE_USAGE = [
  "Usage:",
  "  oat install opencode [--method auto|npm|brew-core|brew-tap|curl] [--version latest|<x.y.z>]",
  "                       [--force] [--yes] [-json]",
  "  oat update  opencode [--check] [--method ...] [--version latest|<x.y.z>]",
  "                       [--timeout <seconds>] [--force-interrupt] [--no-relaunch]",
  "                       [--force-close-tuis] [--backup-db] [--yes] [-json]",
  "  oat restart opencode [--timeout <seconds>] [--force-interrupt] [--no-relaunch]",
  "                       [--force-close-tuis] [--yes] [-json]",
  "",
  "Defaults: --method auto, wait for idle indefinitely, relaunch TUIs, graceful close only.",
  "  --timeout <s>         give up waiting after <s> seconds (0 = forever)",
  "  --force-interrupt     interrupt active sessions (their current turn is lost)",
  "  --no-relaunch         do not reopen the TUIs that were closed",
  "  --force-close-tuis    force-kill a TUI that does not close gracefully (may leak mouse mode)",
  "  --backup-db           copy opencode.db before updating (may be several GB)",
  "  --yes                 do not ask for confirmation",
  "",
].join("\n");

/** Parse lifecycle flags. */
export function parseLifecycleArgs(args: string[]): LifecycleOptions {
  const options: LifecycleOptions = {
    check: false,
    method: "auto",
    version: "latest",
    timeoutMs: 0,
    forceInterrupt: false,
    noRelaunch: false,
    forceCloseTuis: false,
    backupDb: false,
    yes: false,
    force: false,
    json: false,
    help: false,
    unknown: [],
  };
  const methods = new Set(["auto", "npm", "brew-core", "brew-tap", "curl", "other"]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    const valueOf = (name: string): string | undefined => {
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
      if (arg === name) return args[i + 1];
      return undefined;
    };
    if (arg === "--check") options.check = true;
    else if (arg === "--force-interrupt") options.forceInterrupt = true;
    else if (arg === "--no-relaunch") options.noRelaunch = true;
    else if (arg === "--force-close-tuis") options.forceCloseTuis = true;
    else if (arg === "--backup-db") options.backupDb = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "-json" || arg === "--json") options.json = true;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--timeout" || arg.startsWith("--timeout=")) {
      const raw = valueOf("--timeout");
      const seconds = Number(raw);
      if (raw !== undefined && Number.isFinite(seconds) && seconds >= 0) options.timeoutMs = seconds * 1000;
      if (arg === "--timeout") i += 1;
    } else if (arg === "--method" || arg.startsWith("--method=")) {
      const raw = valueOf("--method");
      if (raw && methods.has(raw)) options.method = raw as LifecycleOptions["method"];
      if (arg === "--method") i += 1;
    } else if (arg === "--version" || arg.startsWith("--version=")) {
      const raw = valueOf("--version");
      if (raw) options.version = raw;
      if (arg === "--version") i += 1;
    } else {
      options.unknown.push(arg);
    }
  }
  return options;
}

/** A running opencode v2 service. */
export interface ServiceClient {
  url: string;
  info(): Promise<{ version: string; pid: number | null } | null>;
  active(): Promise<Record<string, { type: string }>>;
  session(id: string): Promise<{ title?: string; location?: { directory?: string } } | null>;
  interrupt(id: string): Promise<void>;
}

/** Open the discovered v2 service, or null when it is not registered. */
export async function openService(): Promise<ServiceClient | null> {
  const service = await readV2Service();
  if (!service) return null;
  const auth = "Basic " + Buffer.from(`opencode:${service.password}`).toString("base64");
  const get = async (route: string): Promise<unknown | null> => {
    try {
      const response = await fetch(service.url + route, {
        headers: { authorization: auth },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return null;
      return (await response.json()) as unknown;
    } catch {
      return null;
    }
  };
  return {
    url: service.url,
    async info() {
      const json = (await get("/api/info")) as { version?: unknown; pid?: unknown } | null;
      if (!json || typeof json.version !== "string") return null;
      return { version: json.version, pid: typeof json.pid === "number" ? json.pid : null };
    },
    async active() {
      const json = (await get("/api/session/active")) as { data?: unknown } | Record<string, unknown> | null;
      const value = json && typeof json === "object" && "data" in json ? (json as { data?: unknown }).data : json;
      return value && typeof value === "object" ? (value as Record<string, { type: string }>) : {};
    },
    async session(id: string) {
      const json = (await get(`/api/session/${encodeURIComponent(id)}`)) as Record<string, unknown> | null;
      if (!json) return null;
      const value = (json.data ?? json) as { title?: string; location?: { directory?: string } };
      return value;
    },
    async interrupt(id: string) {
      try {
        await fetch(service.url + `/api/session/${encodeURIComponent(id)}/interrupt`, {
          method: "POST",
          headers: { authorization: auth },
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        // Best effort; the idle loop reports if it stays active.
      }
    },
  };
}

/** Sleep helper. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until no session is active. */
export async function waitForIdle(
  client: ServiceClient | null,
  options: Pick<LifecycleOptions, "timeoutMs" | "forceInterrupt">,
  log: (message: string) => void = () => {},
  deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  if (!client) return true;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? delay;
  const deadline = options.timeoutMs > 0 ? now() + options.timeoutMs : Number.POSITIVE_INFINITY;
  let interrupted = false;
  for (;;) {
    const active = await client.active();
    const ids = Object.keys(active);
    if (ids.length === 0) return true;
    if (options.forceInterrupt && !interrupted) {
      for (const id of ids) {
        log(`interrupting ${id}`);
        await client.interrupt(id);
      }
      interrupted = true;
      await sleep(1_000);
      continue;
    }
    if (now() >= deadline) return false;
    log(`waiting for ${ids.length} active session(s): ${ids.join(", ")}`);
    await sleep(2_000);
  }
}

/** Run an external command, inheriting the terminal. */
export function runCommand(
  file: string,
  args: string[],
  options: { inherit?: boolean; timeoutMs?: number } = {},
): Promise<number> {
  return new Promise((resolve) => {
    const shell = process.platform === "win32" && !file.includes("\\") && !file.includes("/");
    const child = spawn(file, args, {
      stdio: options.inherit === false ? "ignore" : "inherit",
      shell,
      windowsHide: false,
    });
    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            try {
              child.kill();
            } catch {
              // Ignore.
            }
          }, options.timeoutMs)
        : null;
    child.on("error", () => {
      if (timer) clearTimeout(timer);
      resolve(1);
    });
    child.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

/** Stop or start the shared service. */
function runService(config: OatConfig, subcommand: string): Promise<number> {
  const { command } = resolveOpencodeExecutable(config.opencodeBin);
  return runCommand(command, ["service", subcommand], { inherit: true, timeoutMs: 60_000 });
}

/** Wait for the freshly started service to answer. */
async function waitForService(timeoutMs = 90_000): Promise<ServiceClient | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = await openService();
    if (client && (await client.info())) return client;
    if (Date.now() >= deadline) return null;
    await delay(500);
  }
}

/** Ask the OAT daemon to rescan (best effort). */
async function reloadOat(config: OatConfig): Promise<void> {
  const state = await readState(config.stateDir);
  if (!state) return;
  try {
    await callControl(`http://${state.host}:${state.port}`, state.token, "/reload", "POST");
  } catch {
    // The daemon may not be running; discovery will catch up when it is.
  }
}

/** Copy the opencode database (and WAL files) before an update. */
function backupDatabase(config: OatConfig, log: (message: string) => void): void {
  const home = os.homedir();
  const database = path.join(home, ".local", "share", "opencode", "opencode.db");
  if (!fs.existsSync(database)) {
    log("no opencode database found to back up");
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = path.join(config.stateDir, "backups", stamp);
  fs.mkdirSync(directory, { recursive: true });
  for (const file of [database, `${database}-wal`, `${database}-shm`]) {
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(directory, path.basename(file)));
  }
  log(`database backed up to ${directory}`);
}

/** Ask a yes/no question unless `--yes` was passed. */
async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.error("oat: refusing to continue without --yes (not a terminal)");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** True when the reported binary is opencode v2. */
function isV2(info: OpencodeInfo): boolean {
  const version = info.version ?? "";
  return /opencode\s+v?2\./i.test(version) || /^v?2\./.test(version);
}

function printPlan(info: OpencodeInfo, plan: CommandPlan, latest: string | null): void {
  console.log(describeInfo(info));
  console.log(`method:  ${plan.description}`);
  for (const step of plan.steps) console.log(`  ${step.file} ${step.args.join(" ")}`);
  if (latest) console.log(`latest:  ${latest}`);
}

async function printActive(client: ServiceClient | null): Promise<void> {
  if (!client) return;
  const active = await client.active();
  const ids = Object.keys(active);
  if (ids.length === 0) return;
  console.log(`active sessions: ${ids.length}`);
  for (const id of ids) {
    const session = await client.session(id);
    console.log(`  ${id}  ${session?.title ?? ""}  ${session?.location?.directory ?? ""}`);
  }
}

function printTuis(entries: TuiEntry[]): void {
  if (entries.length === 0) return;
  console.log(`open TUIs: ${entries.length}`);
  for (const entry of entries) {
    console.log(`  pid ${entry.pid}  ${entry.sessionId ?? "(no session)"}  ${entry.cwd ?? "(unknown cwd)"}`);
  }
}

function relaunch(config: OatConfig, entries: TuiEntry[], options: LifecycleOptions): TuiRelaunchResult {
  if (options.noRelaunch || entries.length === 0) return { launched: [], failed: [] };
  const result = relaunchTuis(entries, { launchCommand: config.launchCommand });
  if (!options.json) {
    if (result.launched.length > 0) console.log(`relaunched ${result.launched.length} TUI(s)`);
    if (result.failed.length > 0) {
      console.log("could not relaunch:");
      for (const entry of result.failed) console.log(`  ${resumeCommand(entry)}`);
    }
  }
  return result;
}

/** Resolve the target version and plan for an update. */
function planFor(info: OpencodeInfo, options: LifecycleOptions): CommandPlan | null {
  if (options.method !== "auto") {
    return updatePlan({ ...info, method: options.method }, options.version);
  }
  return updatePlan(info, options.version);
}

/** Shared update lifecycle. */
async function runUpdate(
  config: OatConfig,
  options: LifecycleOptions,
  info: OpencodeInfo,
  plan: CommandPlan,
): Promise<number> {
  const latest = options.version === "latest" ? latestNpmVersion() : options.version;
  const client = await openService();
  const tuis = await snapshotTuis(
    config.stateDir,
    process.platform,
    async (sessionId) => (await client?.session(sessionId))?.location?.directory ?? null,
  );

  const emit = options.json
    ? (message: string): void => console.error(message)
    : (message: string): void => console.log(message);

  if (options.check) {
    if (options.json) {
      console.log(
        JSON.stringify(
          { info, plan, latest, active: client ? await client.active() : {}, tuis },
          null,
          2,
        ),
      );
    } else {
      printPlan(info, plan, latest);
      await printActive(client);
      printTuis(tuis);
    }
    return 0;
  }

  if (!(await confirm(`Update opencode (${plan.description}) now?`, options.yes))) return 2;

  const idle = await waitForIdle(client, options, (message) => emit(`oat: ${message}`));
  if (!idle) {
    console.error("oat: sessions are still active; aborting (use --force-interrupt to abort them)");
    return 1;
  }

  const closed = await closeTuis(tuis, { force: options.forceCloseTuis });
  if (closed.failed.length > 0) {
    console.error(`oat: could not close TUI pid(s): ${closed.failed.join(", ")}`);
    console.error("oat: close them manually, or pass --force-close-tuis (may leak mouse mode)");
    const result = relaunch(config, tuis.filter((entry) => closed.closed.includes(entry.pid)), options);
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            updated: false,
            reason: "tui-close-failed",
            closed: closed.closed,
            failed: closed.failed,
            relaunched: result.launched.map((entry) => entry.pid),
            relaunchFailed: result.failed.map((entry) => entry.pid),
          },
          null,
          2,
        ),
      );
    }
    return 1;
  }

  await runService(config, "stop");
  if (options.backupDb) backupDatabase(config, (message) => emit(`oat: ${message}`));
  let code = 0;
  for (const step of plan.steps) {
    code = await runCommand(step.file, step.args, { inherit: true });
    if (code !== 0) break;
  }

  const after = resolveOpencodeInfo(config.opencodeBin);
  if (code !== 0 || !after.version) {
    console.error("oat: opencode update failed or the new binary is not runnable");
    const oldVersion = /(\d+\.\d+\.\d+)/.exec(info.version ?? "")?.[1];
    if (info.method === "npm" && oldVersion) {
      console.error(`oat: restoring opencode ${oldVersion}`);
      await runCommand("npm", ["install", "-g", `@opencode/cli@${oldVersion}`], { inherit: true });
    }
    await runService(config, "start");
    await waitForService();
    await reloadOat(config);
    const result = relaunch(config, tuis, options);
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            updated: false,
            from: info.version,
            relaunched: result.launched.map((entry) => entry.pid),
            relaunchFailed: result.failed.map((entry) => entry.pid),
          },
          null,
          2,
        ),
      );
    }
    return 1;
  }

  await runService(config, "start");
  const newClient = await waitForService();
  await reloadOat(config);
  if (!newClient) console.error("oat: the new opencode service did not become healthy");
  const result = relaunch(config, tuis, options);
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          updated: true,
          from: info.version,
          to: after.version,
          healthy: newClient !== null,
          relaunched: result.launched.map((entry) => entry.pid),
          relaunchFailed: result.failed.map((entry) => entry.pid),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`opencode updated: ${info.version ?? "(unknown)"} -> ${after.version}`);
  }
  return newClient ? 0 : 1;
}

/** `oat update opencode`. */
export async function updateOpencode(config: OatConfig, args: string[]): Promise<number> {
  const options = parseLifecycleArgs(args);
  if (options.help) {
    console.log(LIFECYCLE_USAGE);
    return 0;
  }
  if (options.unknown.length > 0) console.error(`oat: ignoring unknown option(s): ${options.unknown.join(", ")}`);

  const info = resolveOpencodeInfo(config.opencodeBin);
  if (!info.version) {
    console.error("oat: opencode is not installed; run `oat install opencode`");
    return 1;
  }
  if (!isV2(info)) {
    console.error(`oat: this command supports opencode v2 only (detected ${info.version})`);
    return 1;
  }
  const plan = planFor(info, options);
  if (!plan) {
    console.error(`oat: cannot determine how to update this install (${info.method}); pass --method`);
    return 1;
  }
  return runUpdate(config, options, info, plan);
}

/** `oat install opencode`. */
export async function installOpencode(config: OatConfig, args: string[]): Promise<number> {
  const options = parseLifecycleArgs(args);
  if (options.help) {
    console.log(LIFECYCLE_USAGE);
    return 0;
  }
  const info = resolveOpencodeInfo(config.opencodeBin);
  const plan = installPlan(info, options.method, options.version);
  if (!plan) {
    console.error("oat: cannot determine how to install opencode; pass --method npm");
    return 1;
  }
  const latest = options.version === "latest" ? latestNpmVersion() : options.version;
  if (options.check) {
    if (options.json) console.log(JSON.stringify({ info, plan, latest }, null, 2));
    else printPlan(info, plan, latest);
    return 0;
  }
  if (info.version && !options.force) {
    console.log(`opencode is already installed: ${describeInfo(info)}`);
    console.log("use `oat update opencode`, or `--force` to replace it");
    return 0;
  }
  if (info.version) {
    // Replacing an existing install follows the update lifecycle (idle, close, relaunch).
    return runUpdate(config, options, info, plan);
  }
  if (!(await confirm(`Install opencode (${plan.description}) now?`, options.yes))) return 2;

  for (const step of plan.steps) {
    const code = await runCommand(step.file, step.args, { inherit: true });
    if (code !== 0) {
      console.error(`oat: ${step.file} failed (exit ${code})`);
      return 1;
    }
  }
  const after = resolveOpencodeInfo(config.opencodeBin);
  if (!after.version) {
    console.error("oat: opencode is still not runnable after install");
    if (process.platform === "win32") {
      console.error("oat: if npm blocked the install script, add @opencode/cli to allow-scripts in ~/.npmrc");
    }
    return 1;
  }
  if (!(await openService())) await runService(config, "start");
  const healthy = await waitForService();
  if (!healthy) {
    console.error("oat: the opencode service did not become healthy after install");
    return 1;
  }
  await reloadOat(config);
  if (options.json) console.log(JSON.stringify({ installed: true, version: after.version }, null, 2));
  else console.log(`opencode installed: ${after.version}`);
  return 0;
}

/** `oat restart opencode`. */
export async function restartOpencode(config: OatConfig, args: string[]): Promise<number> {
  const options = parseLifecycleArgs(args);
  if (options.help) {
    console.log(LIFECYCLE_USAGE);
    return 0;
  }
  const info = resolveOpencodeInfo(config.opencodeBin);
  if (!info.version) {
    console.error("oat: opencode is not installed; run `oat install opencode`");
    return 1;
  }
  if (!isV2(info)) {
    console.error(`oat: this command supports opencode v2 only (detected ${info.version})`);
    return 1;
  }
  const client = await openService();
  const tuis = await snapshotTuis(
    config.stateDir,
    process.platform,
    async (sessionId) => (await client?.session(sessionId))?.location?.directory ?? null,
  );
  const emit = options.json
    ? (message: string): void => console.error(message)
    : (message: string): void => console.log(message);

  if (options.check) {
    if (options.json) {
      console.log(JSON.stringify({ info, active: client ? await client.active() : {}, tuis }, null, 2));
    } else {
      console.log(describeInfo(info));
      await printActive(client);
      printTuis(tuis);
    }
    return 0;
  }
  if (!(await confirm("Restart the opencode shared service now?", options.yes))) return 2;

  const idle = await waitForIdle(client, options, (message) => emit(`oat: ${message}`));
  if (!idle) {
    console.error("oat: sessions are still active; aborting (use --force-interrupt to abort them)");
    return 1;
  }
  const closed = await closeTuis(tuis, { force: options.forceCloseTuis });
  if (closed.failed.length > 0) {
    console.error(`oat: could not close TUI pid(s): ${closed.failed.join(", ")}`);
    console.error("oat: close them manually, or pass --force-close-tuis (may leak mouse mode)");
    const result = relaunch(config, tuis.filter((entry) => closed.closed.includes(entry.pid)), options);
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            restarted: false,
            reason: "tui-close-failed",
            closed: closed.closed,
            failed: closed.failed,
            relaunched: result.launched.map((entry) => entry.pid),
            relaunchFailed: result.failed.map((entry) => entry.pid),
          },
          null,
          2,
        ),
      );
    }
    return 1;
  }

  await runService(config, "stop");
  const code = await runService(config, "start");
  const newClient = code === 0 ? await waitForService() : null;
  if (!newClient) console.error("oat: the opencode service did not become healthy");
  await reloadOat(config);
  const result = relaunch(config, tuis, options);
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          restarted: newClient !== null,
          relaunched: result.launched.map((entry) => entry.pid),
          relaunchFailed: result.failed.map((entry) => entry.pid),
        },
        null,
        2,
      ),
    );
  } else {
    console.log("opencode service restarted");
  }
  return newClient ? 0 : 1;
}
