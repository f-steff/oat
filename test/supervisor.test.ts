import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { defaultConfig } from "../src/config.js";
import { Registry } from "../src/registry.js";
import { BackendSupervisor } from "../src/supervisor.js";
import type { Backend } from "../src/types.js";

// Build a supervisor with fully faked spawn/probe/time so tests are deterministic.
function makeDeps(opts: { healthy?: boolean } = {}) {
  const time = { t: 1_000 };
  const spawns: number[] = [];
  const killed: number[] = [];
  let nextPid = 100;
  const registry = new Registry();
  const supervisor = new BackendSupervisor({
    config: defaultConfig({ port: 0, stateDir: os.tmpdir(), idleShutdownMs: 1_000, backendVersion: "v1" }),
    registry,
    // Record spawns and hand out predictable pids.
    spawnBackend: (port) => {
      spawns.push(port);
      const pid = nextPid++;
      return { pid, kill: () => killed.push(pid) };
    },
    // Advance the fake clock on each probe so health waits terminate.
    probeHealth: async () => {
      time.t += 100;
      return opts.healthy ?? true;
    },
    findFreePort: async () => 5000 + spawns.length,
    now: () => time.t,
    idleSweepMs: 1_000_000,
    healthTimeoutMs: 200,
  });
  return { supervisor, registry, spawns, killed, time };
}

// ensure() should start a server for an unowned directory and register it.
test("supervisor starts and registers a backend, then reuses it", async () => {
  const deps = makeDeps();
  const first = await deps.supervisor.ensure("C:\\proj\\a");
  assert.ok(first);
  assert.equal(first?.primaryDirectory, "C:\\proj\\a");
  assert.equal(deps.spawns.length, 1);
  assert.equal(deps.registry.list().length, 1);

  // A second request for the same directory must not spawn again.
  const second = await deps.supervisor.ensure("C:\\proj\\a");
  assert.equal(second?.port, first?.port);
  assert.equal(deps.spawns.length, 1);
});

// A backend that never becomes healthy must be killed and not registered.
test("supervisor kills a backend that fails its health probe", async () => {
  const deps = makeDeps({ healthy: false });
  const backend = await deps.supervisor.ensure("/p/x");
  assert.equal(backend, null);
  assert.equal(deps.registry.list().length, 0);
  assert.equal(deps.killed.length, 1);
});

// Idle sweeps must stop and unregister managed backends past the idle timeout.
test("supervisor idle sweep stops unused managed backends", async () => {
  const deps = makeDeps();
  const backend = await deps.supervisor.ensure("/p/idle");
  assert.ok(backend);
  // Advance well past the 1000ms idle timeout and sweep.
  deps.time.t += 5_000;
  deps.supervisor.sweep();
  assert.equal(deps.registry.list().length, 0);
  assert.equal(deps.killed.length, 1);
});

// touch() must keep a managed backend from being idled out.
test("touch keeps a managed backend alive across a sweep", async () => {
  const deps = makeDeps();
  const backend = await deps.supervisor.ensure("/p/used");
  assert.ok(backend);
  deps.time.t += 500;
  deps.supervisor.touch(backend!.port);
  deps.time.t += 800; // 800ms since touch, under the 1000ms timeout
  deps.supervisor.sweep();
  assert.equal(deps.registry.list().length, 1);
});

// Concurrent ensures for one directory must share a single spawn.
test("concurrent ensures dedupe into one spawn", async () => {
  const deps = makeDeps();
  const [a, b] = await Promise.all([deps.supervisor.ensure("/p/same"), deps.supervisor.ensure("/p/same")]);
  assert.equal(deps.spawns.length, 1);
  assert.equal(a?.port, b?.port);
});

// stopAll must kill and unregister every managed backend.
test("stopAll stops every managed backend", async () => {
  const deps = makeDeps();
  await deps.supervisor.ensure("/p/a");
  await deps.supervisor.ensure("/p/b");
  assert.equal(deps.registry.list().length, 2);
  deps.supervisor.stopAll();
  assert.equal(deps.registry.list().length, 0);
  assert.equal(deps.killed.length, 2);
});

// OAT must never kill a backend it merely discovered (a user-owned opencode).
test("stopAll leaves discovered (user-owned) backends untouched", async () => {
  const deps = makeDeps();
  // Seed a backend that was already running before OAT started.
  const discovered: Backend = {
    port: 9999,
    pid: 4242,
    baseUrl: "http://127.0.0.1:9999",
    primaryDirectory: "/home/user/proj",
    version: "1.18.31",
    healthy: true,
    lastSeen: 0,
  };
  deps.registry.set([discovered]);
  // OAT lazily starts one of its own.
  await deps.supervisor.ensure("/oat/owned");
  assert.equal(deps.registry.list().length, 2);

  deps.supervisor.stopAll();
  // The discovered backend survives; only the managed one was killed.
  assert.equal(deps.registry.list().length, 1);
  assert.ok(deps.registry.list().some((backend) => backend.port === 9999));
  assert.equal(deps.killed.length, 1);
});

// The anchor is a permanent, headerless default backend (no primary directory).
test("ensureAnchor starts a permanent default backend", async () => {
  const deps = makeDeps();
  const anchor = await deps.supervisor.ensureAnchor();
  assert.ok(anchor);
  // No primary directory, so it never matches a directory-scoped request.
  assert.equal(anchor?.primaryDirectory, null);
  // Reused on the next call.
  const again = await deps.supervisor.ensureAnchor();
  assert.equal(again?.port, anchor?.port);
  assert.equal(deps.spawns.length, 1);
  // An idle sweep must not stop the anchor.
  deps.time.t += 1_000_000;
  deps.supervisor.sweep();
  assert.equal(deps.registry.list().length, 1);
  // stopAll does stop it.
  deps.supervisor.stopAll();
  assert.equal(deps.registry.list().length, 0);
  assert.equal(deps.killed.length, 1);
});

// ensure() must not treat the anchor as the owner of any directory.
test("ensure does not match the anchor for a directory", async () => {
  const deps = makeDeps();
  await deps.supervisor.ensureAnchor();
  const backend = await deps.supervisor.ensure("/some/project");
  assert.equal(backend?.primaryDirectory, "/some/project");
  assert.equal(deps.spawns.length, 2);
});

// With terminal launching enabled, ensure() opens a window and adopts its server.
test("supervisor launches a terminal and adopts the discovered backend", async () => {
  const registry = new Registry();
  const launched: string[] = [];
  const supervisor = new BackendSupervisor({
    config: defaultConfig({ port: 0, stateDir: os.tmpdir(), backendVersion: "v1" }),
    registry,
    launchTerminal: true,
    // Fake the command builder and the launcher so no window is actually opened.
    launchSpec: (directory) => ({ command: "fake-terminal", args: [directory] }),
    launch: (spec) => {
      launched.push(spec.args[0] ?? "");
      return true;
    },
    // Simulate the TUI's server being discovered on the next refresh.
    refresh: async () => {
      registry.set([
        {
          port: 7001,
          pid: 1,
          baseUrl: "http://127.0.0.1:7001",
          primaryDirectory: launched[0] ?? null,
          version: "1.18.31",
          healthy: true,
          lastSeen: 0,
        },
      ]);
    },
    now: () => Date.now(),
    healthTimeoutMs: 2_000,
  });

  const backend = await supervisor.ensure("C:\\proj\\demo");
  assert.equal(backend?.port, 7001);
  assert.deepEqual(launched, ["C:\\proj\\demo"]);
  // Nothing was spawned as a hidden server.
  assert.equal(registry.managedPorts().length, 0);
});

// Once a terminal is opened for a directory, a later call must never spawn a
// hidden duplicate for the same project (that split requests across instances).
test("an already-launched directory is never backed by a hidden duplicate", async () => {
  const registry = new Registry();
  let launchCount = 0;
  const supervisor = new BackendSupervisor({
    config: defaultConfig({ port: 0, stateDir: os.tmpdir(), backendVersion: "v1" }),
    registry,
    launchTerminal: true,
    launchSpec: (directory) => ({ command: "fake-terminal", args: [directory] }),
    launch: () => {
      launchCount += 1;
      return true;
    },
    // Discovery never reports the launched server (simulating a slow start).
    refresh: async () => {},
    now: () => Date.now(),
    healthTimeoutMs: 300,
  });

  assert.equal(await supervisor.ensure("/p"), null);
  assert.equal(await supervisor.ensure("/p"), null);
  assert.equal(launchCount, 1); // not relaunched
  assert.equal(registry.managedPorts().length, 0); // no hidden duplicate
});

// A launched instance that is gone is reopened once the grace window passes.
test("a gone launched instance is reopened after the grace window", async () => {
  const registry = new Registry();
  const time = { t: 1_000 };
  let launches = 0;
  const supervisor = new BackendSupervisor({
    config: defaultConfig({ port: 0, stateDir: os.tmpdir(), backendVersion: "v1" }),
    registry,
    launchTerminal: true,
    launchSpec: (directory) => ({ command: "fake-terminal", args: [directory] }),
    launch: () => {
      launches += 1;
      return true;
    },
    refresh: async () => {},
    now: () => time.t,
    healthTimeoutMs: 100,
    relaunchGraceMs: 1_000,
  });

  assert.equal(await supervisor.ensure("/p"), null); // launch #1
  time.t += 500; // within the grace window
  assert.equal(await supervisor.ensure("/p"), null);
  assert.equal(launches, 1);
  time.t += 2_000; // past the grace window, server still gone
  await supervisor.ensure("/p"); // reopened
  assert.equal(launches, 2);
});

// A maintenance worker left in our directory is reaped, then exactly one is started.
test("ensureAnchor reaps a stale anchor in our directory, then spawns one", async () => {
  const time = { t: 1_000 };
  const killedPids: number[] = [];
  const spawns: number[] = [];
  let nextPid = 300;
  const registry = new Registry();
  const stateDir = os.tmpdir();
  registry.set([
    {
      port: 5555,
      pid: 4242,
      baseUrl: "http://127.0.0.1:5555",
      primaryDirectory: path.join(stateDir, "anchor"),
      version: "1.18.0",
      healthy: true,
      lastSeen: 1,
      anchor: true,
    },
  ]);

  const supervisor = new BackendSupervisor({
    config: defaultConfig({ port: 0, stateDir, idleShutdownMs: 1_000, backendVersion: "v1" }),
    registry,
    spawnBackend: (port) => {
      spawns.push(port);
      const pid = nextPid++;
      return { pid, kill: () => {} };
    },
    probeHealth: async () => true,
    findFreePort: async () => 6000,
    kill: (pid) => killedPids.push(pid),
    now: () => time.t,
    idleSweepMs: 1_000_000,
    healthTimeoutMs: 200,
  });

  const anchor = await supervisor.ensureAnchor();
  assert.ok(anchor);
  assert.deepEqual(killedPids, [4242]); // the stale anchor was reaped
  assert.equal(spawns.length, 1); // and exactly one fresh anchor started
});
