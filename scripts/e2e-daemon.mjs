// End-to-end test for the daemon lifecycle and singleton handoff.
//
// Starts a real OAT daemon (via the built CLI), then exercises the CLI as a
// second invocation to prove it detects the running daemon and hands control to
// it instead of starting a second one. The daemon is stopped before exit so the
// caller's process tree is always left empty.
//
// Run:  npm run build && node scripts/e2e-daemon.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { callControl, fetchIdentity } from "../dist/control.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const PORT = 46399;
const STATE_DIR = mkdtempSync(path.join(os.tmpdir(), "oat-daemon-"));
const ENV = {
  ...process.env,
  OAT_PORT: String(PORT),
  OAT_STATE_DIR: STATE_DIR,
  OAT_TOKEN: "e2e-daemon-token",
  OAT_LOG_LEVEL: "warn",
  // The anchor is opt-in; enable it so the anchor check exercises that path.
  OAT_ANCHOR: "1",
  // Keep the test windowless: never open a terminal for lazy starts.
  OAT_LAUNCH_TERMINAL: "0",
};

let daemon = null;
let done = false;

// Run one CLI command and return its stdout (throws on non-zero exit).
function runCli(args, timeout = 10_000) {
  return execFileSync(process.execPath, [CLI, ...args], { env: ENV, encoding: "utf8", timeout });
}

// Poll the daemon identity endpoint until it answers or the deadline passes.
async function waitIdentity(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const identity = await fetchIdentity(`http://127.0.0.1:${PORT}`, 500);
    if (identity?.oat) return identity;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

// Poll the control /list route until at least one backend (the anchor) exists.
async function waitBackends(base, token, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const result = await callControl(base, token, "/list");
      if (Array.isArray(result.body)) {
        if (result.body.length > 0) return { ok: true, detail: `backends=${result.body.length}` };
        last = "backends=0";
      } else {
        last = `status ${result.status}`;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return { ok: false, detail: last };
}

// Stop the daemon (gracefully, so it also kills its hidden servers) if alive.
function teardown(reason) {
  if (done) return;
  done = true;
  try {
    execFileSync(process.execPath, [CLI, "stop"], { env: ENV, encoding: "utf8", timeout: 10_000 });
  } catch {}
  if (daemon && daemon.exitCode === null) {
    try {
      daemon.kill();
    } catch {}
  }
}

// Wait for the daemon child process to exit.
function waitExit(timeoutMs = 5_000) {
  return new Promise((resolve) => {
    if (!daemon || daemon.exitCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    daemon.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const checks = [];
// Record a pass/fail check and print it.
function check(name, ok, detail = "") {
  checks.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
}

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

try {
  console.log("[1] starting the OAT daemon");
  daemon = spawn(process.execPath, [CLI, "serve"], { env: ENV, stdio: "ignore" });
  const identity1 = await waitIdentity();
  check("daemon is up and identifies as OAT", !!identity1, `pid=${identity1?.pid}`);

  // Regression guard: the daemon must outlive its first discovery scan.
  console.log("\n[1b] daemon persists past its first discovery scan");
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  const identityPersist = await fetchIdentity(`http://127.0.0.1:${PORT}`, 500);
  check("daemon still up after the first scan", identityPersist?.pid === identity1?.pid, `pid=${identityPersist?.pid}`);

  console.log("\n[2] CLI forwards control to the running daemon");
  const status = JSON.parse(runCli(["status", "-json"]));
  check("status reports the daemon port", status.port === PORT, JSON.stringify(status));

  const list = JSON.parse(runCli(["list", "-json"]));
  check("list returns an array of backends", Array.isArray(list));

  console.log("\n[3] a second invocation does not start a new daemon");
  const started = JSON.parse(runCli(["start", "-json"]));
  check("start is idempotent (same port)", started.port === PORT, JSON.stringify(started));
  const identity2 = await fetchIdentity(`http://127.0.0.1:${PORT}`, 500);
  check("daemon pid unchanged after start", identity2?.pid === identity1?.pid, `${identity1?.pid} -> ${identity2?.pid}`);

  const bare = JSON.parse(runCli(["-json"]));
  check("bare invocation reuses the daemon", bare.port === PORT, JSON.stringify(bare));

  console.log("\n[3b] OAT starts an on-demand anchor when no opencode server is listening");
  // A headerless read triggers the anchor (opencode startup can take ~15s).
  let projectStatus = -1;
  let projectCount = -1;
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/project`, { signal: AbortSignal.timeout(60_000) });
    projectStatus = response.status;
    const body = await response.json();
    projectCount = Array.isArray(body) ? body.length : -1;
  } catch {
    projectStatus = -1;
  }
  check("OAT /project served via the on-demand anchor", projectStatus === 200, `status=${projectStatus} projects=${projectCount}`);
  // The anchor should now be registered as a backend.
  const anchored = await waitBackends(`http://127.0.0.1:${PORT}`, ENV.OAT_TOKEN, 20_000);
  check("anchor backend registered", anchored.ok, anchored.detail);

  console.log("\n[4] stop shuts the daemon down");
  const stop = JSON.parse(runCli(["stop", "-json"]));
  check("stop acknowledges", stop.ok === true, JSON.stringify(stop));
  const exited = await waitExit();
  check("daemon process exited", exited);
  const identity3 = await fetchIdentity(`http://127.0.0.1:${PORT}`, 500);
  check("identity no longer responds", identity3 === null);

  const passed = checks.filter(Boolean).length;
  console.log(`\n=== DAEMON E2E RESULT: ${passed}/${checks.length} checks passed ===`);
  teardown("done");
  clearTimeout(watchdog);
  process.exit(checks.every(Boolean) ? 0 : 1);
} catch (error) {
  console.error("DAEMON E2E ERROR:", error instanceof Error ? error.message : error);
  teardown("error");
  clearTimeout(watchdog);
  process.exit(1);
}
