import assert from "node:assert/strict";
import { test } from "node:test";

import { directoryOwner, matchByDirectory, normalizeDir, pickBackend } from "../src/router.js";
import type { Backend } from "../src/types.js";

// Build a minimal healthy backend descriptor for routing tests.
function backend(port: number, primaryDirectory: string | null, healthy = true): Backend {
  return {
    port,
    pid: port,
    baseUrl: `http://127.0.0.1:${port}`,
    primaryDirectory,
    version: "1.18.31",
    healthy,
    lastSeen: 0,
  };
}

// Path normalization must handle separators, trailing slashes, and platform case rules.
test("normalizeDir handles separators, trailing slash and platform case rules", () => {
  assert.equal(normalizeDir("C:\\Projects\\Foo\\", true), "c:/projects/foo");
  // Case-sensitive filesystems (Linux) preserve case.
  assert.equal(normalizeDir("/home/User/proj/", false), "/home/User/proj");
  assert.equal(normalizeDir("/", false), "/");
});

// Directory matching must prefer the most specific (longest) prefix.
test("matchByDirectory picks the longest matching prefix", () => {
  const backends = [backend(5000, "C:\\Projects\\A"), backend(5001, "C:\\Projects\\A\\sub")];
  assert.equal(matchByDirectory(backends, "C:\\Projects\\A\\sub\\deep")?.port, 5001);
  assert.equal(matchByDirectory(backends, "C:\\Projects\\A\\other")?.port, 5000);
  assert.equal(matchByDirectory(backends, "C:\\Projects\\B"), null);
});

// The request's own directory header is the primary routing key.
test("pickBackend routes by request directory", () => {
  const backends = [backend(5000, "/p/a"), backend(5001, "/p/b")];
  const decision = pickBackend(backends, { directory: "/p/b/x" });
  assert.equal(decision?.backend.port, 5001);
  assert.equal(decision?.reason, "directory");
});

// When only a session directory is known, route by that.
test("pickBackend falls back to session directory", () => {
  const backends = [backend(5000, "/p/a"), backend(5001, "/p/b")];
  const decision = pickBackend(backends, { sessionDirectory: "/p/b/x" });
  assert.equal(decision?.backend.port, 5001);
  assert.equal(decision?.reason, "session-directory");
});

// Explicit session affinity must override directory matching (duplicate directories).
test("session affinity overrides directory matching (duplicates)", () => {
  const backends = [backend(5000, "/p"), backend(5001, "/p")];
  const decision = pickBackend(backends, { directory: "/p", affinityPort: 5001 });
  assert.equal(decision?.backend.port, 5001);
  assert.equal(decision?.reason, "session-affinity");
});

// With no directory context, the lowest healthy port is the deterministic default.
test("default is the lowest healthy port and unhealthy backends are ignored", () => {
  const backends = [backend(5002, null, false), backend(5000, null), backend(5001, null)];
  const decision = pickBackend(backends, {});
  assert.equal(decision?.backend.port, 5000);
  assert.equal(decision?.reason, "default");
});

// No healthy backend means no routing decision.
test("pickBackend returns null when no backend is healthy", () => {
  assert.equal(pickBackend([backend(5000, null, false)], {}), null);
});

// Duplicate-directory owner selection must be deterministic.
test("directoryOwner is deterministic by pid then port", () => {
  const a = backend(5000, "/p");
  const b = backend(5001, "/p");
  a.pid = 20;
  b.pid = 10;
  assert.equal(directoryOwner([a, b], "/p")?.port, 5001);
});

// The anchor is only chosen when no real backend is available.
test("default routing prefers a real backend over the anchor", () => {
  const anchor = backend(5000, null);
  anchor.anchor = true;
  const real = backend(5001, null);
  // With both present, the real one wins even though the anchor has a lower port.
  assert.equal(pickBackend([anchor, real], {})?.backend.port, 5001);
  // With only the anchor, it is used as the fallback.
  assert.equal(pickBackend([anchor], {})?.backend.port, 5000);
});
