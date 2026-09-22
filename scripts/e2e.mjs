// End-to-end smoke test for OAT against REAL opencode servers.
//
// Self-contained and self-terminating: it starts two `opencode serve` instances
// on isolated ports/directories, discovers them via the real per-OS discovery
// path, routes through the mux, then kills everything before exiting.
//
// Run:  npm run build && node scripts/e2e.mjs
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { defaultConfig } from "../dist/config.js";
import { discoverBackends, makeHttpProbe } from "../dist/discovery/discover.js";
import { listListeners } from "../dist/discovery/ports.js";
import { Registry } from "../dist/registry.js";
import { createMuxServer } from "../dist/server.js";

// The two throwaway server ports and the mux port (all clear of OAT's default).
const PORTS = [46210, 46211];
const MUX_PORT = 46299;

const children = [];
const results = [];
let mux = null;
let teardownDone = false;

// Record a pass/fail check and print it.
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
}

// Resolve the real opencode executable (env override, known npm path, or PATH).
function opencodeExe() {
  const candidates = [
    process.env.OPENCODE_BIN,
    process.env.OPENCODE_EXE,
    "C:\\Users\\DKfls\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe",
    "opencode",
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate === "opencode" || existsSync(candidate)) return candidate;
  }
  return "opencode";
}

// Kill a process (and its tree on Windows) best-effort.
function killTree(pid) {
  if (!pid) return;
  try {
    process.kill(pid);
  } catch {}
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 8000 });
  } catch {}
}

// Close the mux and kill every opencode child, exactly once.
function teardown(reason) {
  if (teardownDone) return;
  teardownDone = true;
  console.log(`\n[teardown] ${reason}`);
  try {
    mux?.close();
  } catch {}
  for (const child of children) {
    killTree(child.pid);
    console.log(`[teardown] killed opencode pid=${child.pid}`);
  }
}

// Watchdog so a stuck run can never hang the caller.
const watchdog = setTimeout(() => {
  teardown("watchdog");
  process.exit(2);
}, 150_000);

// Clean up on Ctrl-C / termination too.
process.on("SIGINT", () => {
  teardown("SIGINT");
  process.exit(130);
});
process.on("SIGTERM", () => {
  teardown("SIGTERM");
  process.exit(143);
});

// Start one throwaway opencode server in its own directory, logging to a file.
function startOpencode(port, cwd, logFile) {
  const fd = openSync(logFile, "w");
  const child = spawn(opencodeExe(), ["serve", "--port", String(port)], {
    cwd,
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  child.unref();
  children.push(child);
  child.on("error", (error) => console.error(`[opencode:${port}] spawn error: ${error.message}`));
  child.on("exit", (code) => console.error(`[opencode:${port}] exited early code=${code}`));
  return child;
}

// Poll `/global/health` with a per-attempt timeout until it answers.
async function waitHealth(port, timeoutMs = 60_000) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    // Bound each attempt so a stalled connection cannot hang the whole run.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/global/health`, { signal: controller.signal });
      if (res.ok && (await res.json()).healthy === true) {
        clearTimeout(timer);
        return true;
      }
    } catch {}
    clearTimeout(timer);
    // Periodic progress so a slow start is visible.
    if (attempts % 10 === 0) console.log(`    ... still waiting for :${port} (${Math.round((Date.now() - start) / 1000)}s)`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

// Bind the mux server to the fixed test port.
function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

// Read the merged SSE stream until a `data:` event arrives (or timeout).
async function readOneEvent(url, timeoutMs = 4_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text = "";
  try {
    const res = await fetch(url, { headers: { accept: "text/event-stream" }, signal: controller.signal });
    const reader = res.body?.getReader();
    if (!reader) return text;
    const decoder = new TextDecoder();
    while (!text.includes("data:")) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {}
  clearTimeout(timer);
  return text;
}

async function main() {
  const base = mkdtempSync(path.join(os.tmpdir(), "oat-e2e-"));
  const dirs = [path.join(base, "a"), path.join(base, "b")];
  for (const dir of dirs) mkdirSync(dir, { recursive: true });

  console.log("[1] starting two real opencode servers");
  console.log(`    using exe: ${opencodeExe()}`);
  const logs = [path.join(base, "a.log"), path.join(base, "b.log")];
  startOpencode(PORTS[0], dirs[0], logs[0]);
  startOpencode(PORTS[1], dirs[1], logs[1]);
  const healthy = await Promise.all(PORTS.map((port) => waitHealth(port)));
  check("both opencode servers healthy", healthy.every(Boolean), PORTS.map((p, i) => `${p}:${healthy[i]}`).join(" "));
  if (!healthy.every(Boolean)) {
    // Surface the server logs to explain why a startup failed.
    for (let i = 0; i < PORTS.length; i++) {
      if (healthy[i]) continue;
      console.error(`--- opencode :${PORTS[i]} log ---\n${readFileSync(logs[i] ?? logs[0], "utf8").slice(-2000)}`);
    }
    return 1;
  }

  console.log("\n[2] real per-OS discovery");
  const listeners = await listListeners();
  const discovered = await discoverBackends(listeners, {
    probe: makeHttpProbe(1_000),
    skipPorts: new Set([MUX_PORT]),
  });
  const byPort = new Map(discovered.map((b) => [b.port, b]));
  check("discovery found server A", byPort.has(PORTS[0]), byPort.get(PORTS[0])?.primaryDirectory ?? "");
  check("discovery found server B", byPort.has(PORTS[1]), byPort.get(PORTS[1])?.primaryDirectory ?? "");

  console.log("\n[3] routing through the mux");
  const registry = new Registry();
  registry.set(discovered);
  const config = defaultConfig({ port: MUX_PORT, host: "127.0.0.1", debugAttribution: true, stateDir: base });
  mux = createMuxServer({ config, registry });
  await listen(mux, MUX_PORT);
  const baseUrl = `http://127.0.0.1:${MUX_PORT}`;

  const health = await (await fetch(`${baseUrl}/global/health`)).json();
  check("mux health", health.healthy === true && String(health.version).startsWith("oat/"), JSON.stringify(health));

  // `/path` with a directory header must be served by the matching backend.
  const pathA = await fetch(`${baseUrl}/path`, { headers: { "x-opencode-directory": dirs[0] } });
  check("dir A routes to server A", pathA.headers.get("x-oat-backend") === String(PORTS[0]), `via=${pathA.headers.get("x-oat-backend")}`);
  const pathB = await fetch(`${baseUrl}/path`, { headers: { "x-opencode-directory": dirs[1] } });
  check("dir B routes to server B", pathB.headers.get("x-oat-backend") === String(PORTS[1]), `via=${pathB.headers.get("x-oat-backend")}`);

  // Global reads come from the shared DB through the mux.
  const projects = await (await fetch(`${baseUrl}/project`)).json();
  check("global /project via mux", Array.isArray(projects) && projects.length > 0, `count=${projects?.length}`);

  // SSE fan-in is live.
  const sse = await readOneEvent(`${baseUrl}/global/event`, 5_000);
  check("SSE stream yields events", sse.includes("data:"), `${sse.split("\n").find((l) => l.startsWith("data:"))?.slice(0, 60) ?? ""}`);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n=== E2E RESULT: ${passed}/${results.length} checks passed ===`);
  return results.every((r) => r.ok) ? 0 : 1;
}

try {
  const code = await main();
  teardown("done");
  clearTimeout(watchdog);
  process.exit(code);
} catch (error) {
  console.error("E2E ERROR:", error);
  teardown("error");
  clearTimeout(watchdog);
  process.exit(1);
}
