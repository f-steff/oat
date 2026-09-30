import assert from "node:assert/strict";
import { test } from "node:test";

import { Registry } from "../src/registry.js";
import type { Backend } from "../src/types.js";

/** Build a backend with sensible defaults. */
function backend(over: Partial<Backend>): Backend {
  return {
    port: 5000,
    pid: 1,
    baseUrl: "http://127.0.0.1:5000",
    primaryDirectory: null,
    version: "2.0.20",
    healthy: true,
    lastSeen: 0,
    ...over,
  };
}

test("registerLocation adds per-project rows for the shared service", () => {
  const registry = new Registry();
  registry.set([backend({ port: 5000, shared: true, primaryDirectory: "C:/Users/x" })]);
  registry.registerLocation("C:/Projects/a");
  registry.registerLocation("C:/Projects/b");

  const rows = registry.list().filter((b) => b.location);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.primaryDirectory).sort(),
    ["C:/Projects/a", "C:/Projects/b"],
  );
  assert.ok(rows.every((row) => row.port === 5000 && row.shared === true));
});

test("registerLocation does not duplicate a directory owned by a real backend", () => {
  const registry = new Registry();
  registry.set([
    backend({ port: 5000, shared: true, primaryDirectory: "C:/Users/x" }),
    backend({ port: 6000, primaryDirectory: "C:/Projects/a" }),
  ]);
  registry.registerLocation("C:/Projects/a");
  assert.equal(registry.list().filter((b) => b.location).length, 0);
});

test("registerLocation is a no-op without a discovered shared service", () => {
  const registry = new Registry();
  registry.set([backend({ port: 6000, primaryDirectory: "C:/Projects/a" })]);
  registry.registerLocation("C:/Projects/b");
  assert.equal(registry.list().filter((b) => b.location).length, 0);
});
