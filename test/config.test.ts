import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultConfig, defaultStateDir, newToken } from "../src/config.js";

// Verify the per-OS state directory mapping.
test("defaultStateDir maps per platform", () => {
  // Windows uses %LOCALAPPDATA%.
  assert.ok(defaultStateDir("win32", { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" } as NodeJS.ProcessEnv).endsWith("oat"));
  // macOS lives under Application Support.
  assert.ok(defaultStateDir("darwin", {} as NodeJS.ProcessEnv).includes("Application Support"));
  // Linux honors XDG_STATE_HOME.
  const linux = defaultStateDir("linux", { XDG_STATE_HOME: "/tmp/xdg" } as NodeJS.ProcessEnv);
  assert.ok(linux.includes("xdg") && linux.endsWith("oat"));
});

// Verify that explicit overrides win over environment defaults.
test("defaultConfig honors overrides", () => {
  const cfg = defaultConfig({ port: 1234, token: "abc", host: "127.0.0.1" });
  assert.equal(cfg.port, 1234);
  assert.equal(cfg.token, "abc");
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.debugAttribution, false);
});

// Tokens must be unique, 24-byte, lowercase hex strings.
test("newToken returns distinct 48-char hex tokens", () => {
  const a = newToken();
  const b = newToken();
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{48}$/);
});

// The log file defaults under the state dir and honors an explicit override.
test("defaultConfig resolves the log file", () => {
  const cfg = defaultConfig({ stateDir: "/tmp/oat-state" });
  assert.ok(cfg.logFile.includes("oat-state") && cfg.logFile.endsWith("oat.log"));
  assert.equal(defaultConfig({ logFile: "/custom/oat.log" }).logFile, "/custom/oat.log");
  // On-demand anchor allowed by default; terminal launching is the default for lazy starts.
  assert.equal(cfg.anchor, true);
  assert.equal(cfg.launchTerminal, true);
  // Injected-arg templates have sensible defaults.
  assert.equal(cfg.bridgeBin, "sesori-bridge");
  assert.equal(cfg.bridgeArgs, "--opencode-no-auto-start --opencode-port {port}");
  assert.equal(cfg.opencodeArgs, "--port {host_port} --hostname {host}");
});
