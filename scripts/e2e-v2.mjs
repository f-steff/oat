// End-to-end smoke test for OAT against a REAL opencode v2 server.
//
// Self-contained and self-terminating: starts one `opencode2 serve` instance on
// an isolated port + DB, discovers it with the v2 password, routes the v1
// surface through the mux, and exercises the v1<->v2 translation.
//
// Run:  npm run build && node scripts/e2e-v2.mjs
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultConfig, defaultStateDir } from "../dist/config.js";
import { basicAuth, discoverBackends, makeHttpProbe } from "../dist/discovery/discover.js";
import { listListeners } from "../dist/discovery/ports.js";
import { Registry } from "../dist/registry.js";
import { createMuxServer } from "../dist/server.js";

const V2_PORT = 46310;
const MUX_PORT = 46399;
const PASSWORD = "oat-e2e-v2-pass";

const children = [];
const results = [];
let mux = null;
let teardownDone = false;

function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
}

// Resolve the opencode v2 executable (env, isolated install, or PATH).
function opencode2Exe() {
  const candidates = [
    process.env.OAT_OPENCODE2_BIN,
    path.join(defaultStateDir(), "opencode2", "node_modules", "@opencode", "cli", "bin", "opencode.exe"),
    path.join(defaultStateDir(), "opencode2", "lib", "node_modules", "@opencode", "cli", "bin", "opencode.exe"),
    path.join(defaultStateDir(), "opencode2", "node_modules", "@opencode", "cli", "bin", "opencode"),
    path.join(defaultStateDir(), "opencode2", "lib", "node_modules", "@opencode", "cli", "bin", "opencode"),
  ];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  return "opencode2";
}

function killTree(pid) {
  if (!pid) return;
  try {
    process.kill(pid);
  } catch {}
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 8000 });
  } catch {}
}

function teardown(reason) {
  if (teardownDone) return;
  teardownDone = true;
  console.log(`\n[teardown] ${reason}`);
  try {
    mux?.close();
  } catch {}
  for (const child of children) {
    killTree(child.pid);
    console.log(`[teardown] killed opencode2 pid=${child.pid}`);
  }
}

const watchdog = setTimeout(() => {
  teardown("watchdog");
  process.exit(2);
}, 180_000);
process.on("SIGINT", () => {
  teardown("SIGINT");
  process.exit(130);
});
process.on("SIGTERM", () => {
  teardown("SIGTERM");
  process.exit(143);
});

// Start one throwaway v2 server in its own directory/DB, logging to a file.
function startV2(cwd, logFile, base) {
  const fd = openSync(logFile, "w");
  const child = spawn(opencode2Exe(), ["serve", "--port", String(V2_PORT), "--hostname", "127.0.0.1"], {
    cwd,
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: PASSWORD,
      // Keep everything under the temp dir so the real user DB is untouched.
      OPENCODE_DB: path.join(base, "opencode.db"),
      XDG_DATA_HOME: path.join(base, "data"),
      XDG_STATE_HOME: path.join(base, "state"),
      XDG_CONFIG_HOME: path.join(base, "config"),
    },
  });
  child.unref();
  children.push(child);
  child.on("error", (error) => console.error(`[opencode2] spawn error: ${error.message}`));
  return child;
}

// Poll `/api/info` (Basic) until the v2 server answers.
async function waitHealth(timeoutMs = 90_000) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const res = await fetch(`http://127.0.0.1:${V2_PORT}/api/info`, {
        signal: controller.signal,
        headers: { authorization: basicAuth(PASSWORD) },
      });
      if (res.ok && typeof (await res.json()).version === "string") {
        clearTimeout(timer);
        return true;
      }
    } catch {}
    clearTimeout(timer);
    if (attempts % 10 === 0) console.log(`    ... still waiting for :${V2_PORT} (${Math.round((Date.now() - start) / 1000)}s)`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

async function readOneEvent(url, timeoutMs = 6_000) {
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
  const base = mkdtempSync(path.join(os.tmpdir(), "oat-e2e-v2-"));
  const dir = path.join(base, "proj");
  mkdirSync(dir, { recursive: true });

  console.log("[1] starting a real opencode v2 server");
  console.log(`    using exe: ${opencode2Exe()}`);
  const log = path.join(base, "v2.log");
  startV2(dir, log, base);
  const healthy = await waitHealth();
  check("v2 server healthy", healthy, `:${V2_PORT}`);
  if (!healthy) {
    console.error(`--- opencode2 log ---\n${readFileSync(log, "utf8").slice(-2000)}`);
    return 1;
  }

  console.log("\n[2] discovery with the v2 password");
  const listeners = await listListeners();
  const discovered = await discoverBackends(listeners, {
    probe: makeHttpProbe(1_000, { v2Password: PASSWORD }),
    skipPorts: new Set([MUX_PORT]),
    v2Password: PASSWORD,
  });
  const v2 = discovered.find((b) => b.port === V2_PORT);
  check("discovery tagged the server as v2", v2?.kind === "v2", `kind=${v2?.kind}`);
  check("discovery learned the directory", v2?.primaryDirectory === dir, v2?.primaryDirectory ?? "");

  console.log("\n[3] routing + translation through the mux");
  const registry = new Registry();
  registry.set(discovered);
  const config = defaultConfig({
    port: MUX_PORT,
    host: "127.0.0.1",
    stateDir: base,
    v2Password: PASSWORD,
    debugAttribution: true,
  });
  mux = createMuxServer({ config, registry });
  await listen(mux, MUX_PORT);
  const baseUrl = `http://127.0.0.1:${MUX_PORT}`;

  const health = await (await fetch(`${baseUrl}/global/health`)).json();
  check("mux health is OAT", health.healthy === true && String(health.version).startsWith("oat/"), JSON.stringify(health));

  // v1 `/path` -> v2 `/api/location`; routed by directory.
  const upstreamLoc = await fetch(`http://127.0.0.1:${V2_PORT}/api/location?directory=${encodeURIComponent(dir)}`, {
    headers: { authorization: basicAuth(PASSWORD) },
  });
  check("direct v2 /api/location answers", upstreamLoc.status === 200, `status=${upstreamLoc.status}`);
  const pathRes = await fetch(`${baseUrl}/path`, { headers: { "x-opencode-directory": dir } });
  const pathText = await pathRes.text();
  let pathBody = {};
  try {
    pathBody = JSON.parse(pathText);
  } catch {
    pathBody = { raw: pathText };
  }
  check(
    "v1 /path translated to v2 location",
    pathRes.headers.get("x-oat-backend") === String(V2_PORT) && pathBody.directory === dir,
    `via=${pathRes.headers.get("x-oat-backend")} status=${pathRes.status} body=${pathText.slice(0, 120)}`,
  );

  // v1 `POST /session` -> v2 `/api/session`; the response is a v1 session (top-level directory).
  const created = await (
    await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-directory": dir },
      body: JSON.stringify({ title: "e2e-v2" }),
    })
  ).json();
  check("created a session via translation", typeof created?.id === "string" && created.directory === dir, `id=${created?.id} dir=${created?.directory}`);

  const sid = created?.id;
  if (sid) {
    const got = await (await fetch(`${baseUrl}/session/${sid}`, { headers: { "x-opencode-directory": dir } })).json();
    check("v2 session mapped to v1 shape", got?.id === sid && got.directory === dir && got.location === undefined, JSON.stringify(got).slice(0, 80));
  }

  const list = await (await fetch(`${baseUrl}/session`, { headers: { "x-opencode-directory": dir } })).json();
  check("session list translated to an array", Array.isArray(list) && list.some((s) => s.id === sid), `count=${list?.length}`);

  // SSE fan-in translates v2 `/api/event` into v1 events (server.connected at least).
  const sse = await readOneEvent(`${baseUrl}/global/event`, 6_000);
  check("SSE stream yields translated events", sse.includes("data:") && sse.includes("server.connected"), `${sse.split("\n").find((l) => l.startsWith("data:"))?.slice(0, 70) ?? ""}`);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n=== E2E-V2 RESULT: ${passed}/${results.length} checks passed ===`);
  return results.every((r) => r.ok) ? 0 : 1;
}

try {
  const code = await main();
  teardown("done");
  clearTimeout(watchdog);
  process.exit(code);
} catch (error) {
  console.error("E2E-V2 ERROR:", error);
  teardown("error");
  clearTimeout(watchdog);
  process.exit(1);
}
