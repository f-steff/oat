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

test("registry.list returns only real discovered/managed backends (no synthetic project rows)", () => {
  const registry = new Registry();
  registry.set([backend({ port: 5000, shared: true, primaryDirectory: "C:/Users/x" })]);
  registry.addManaged(backend({ port: 6000, primaryDirectory: "C:/Projects/a" }));

  assert.deepEqual(
    registry.list()
      .map((b) => b.port)
      .sort(),
    [5000, 6000],
  );
  // The v2 shared service appears exactly once, regardless of how many projects exist.
  assert.equal(registry.list().filter((b) => b.port === 5000).length, 1);
});
