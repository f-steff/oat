import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import { test } from "node:test";

import { defaultConfig } from "../src/config.js";
import { Registry } from "../src/registry.js";
import { createMuxServer } from "../src/server.js";
import type { Backend } from "../src/types.js";

// One captured upstream request, so tests can assert what was forwarded.
interface Captured {
  headers: http.IncomingHttpHeaders;
  url: string;
  method: string;
}

// Start an echo backend that records requests and can simulate an error.
function startEcho(): Promise<{ server: http.Server; port: number; captured: Captured[] }> {
  return new Promise((resolve) => {
    const captured: Captured[] = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      captured.push({ headers: req.headers, url: req.url ?? "", method: req.method ?? "" });
      // `/boom` simulates an upstream error status.
      if (url.pathname === "/boom") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0, captured });
    });
  });
}

// Bind a server to an ephemeral loopback port and return that port.
function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

// Close a server, force-closing any open connections first.
async function close(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// Build a healthy backend descriptor for a fake server.
function backendFor(port: number, directory: string): Backend {
  return {
    port,
    pid: port,
    baseUrl: `http://127.0.0.1:${port}`,
    primaryDirectory: directory,
    version: "test",
    healthy: true,
    lastSeen: 0,
  };
}

// The proxy must strip auth/hop-by-hop headers but preserve query and directory.
test("proxy strips Authorization, forwards query + directory, streams response", async (t) => {
  const echo = await startEcho();
  const registry = new Registry();
  registry.set([backendFor(echo.port, "C:\\proj")]);

  const config = defaultConfig({ port: 0, stateDir: os.tmpdir(), debugAttribution: true });
  const server = createMuxServer({ config, registry });
  const port = await listen(server);
  t.after(async () => {
    await close(server);
    await close(echo.server);
  });

  const response = await fetch(`http://127.0.0.1:${port}/thing?a=1&b=2`, {
    headers: {
      "x-opencode-directory": "C:\\proj",
      authorization: "Bearer should-be-stripped",
      "x-custom": "kept",
    },
  });
  assert.equal(response.status, 200);
  // The debug attribution header names the backend that served the request.
  assert.equal(response.headers.get("x-oat-backend"), String(echo.port));

  const captured = echo.captured.at(-1);
  assert.ok(captured, "expected a captured upstream request");
  assert.equal(captured.url, "/thing?a=1&b=2");
  assert.equal(captured.headers["authorization"], undefined);
  assert.equal(captured.headers["x-custom"], "kept");
  assert.equal(captured.headers["x-opencode-directory"], "C:\\proj");
});

// An upstream error status must pass through unchanged.
test("proxy passes through upstream error status", async (t) => {
  const echo = await startEcho();
  const registry = new Registry();
  registry.set([backendFor(echo.port, "/p")]);
  const config = defaultConfig({ port: 0, stateDir: os.tmpdir() });
  const server = createMuxServer({ config, registry });
  const port = await listen(server);
  t.after(async () => {
    await close(server);
    await close(echo.server);
  });

  const response = await fetch(`http://127.0.0.1:${port}/boom`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "boom" });
});

// With no backends, the mux must answer 503 rather than hang.
test("proxy returns 503 when no backend is available", async (t) => {
  const registry = new Registry();
  const config = defaultConfig({ port: 0, stateDir: os.tmpdir() });
  const server = createMuxServer({ config, registry });
  const port = await listen(server);
  t.after(() => close(server));

  const response = await fetch(`http://127.0.0.1:${port}/anything`);
  assert.equal(response.status, 503);
});

// With a supervisor, an unowned directory triggers a lazy start (Q1 / FR-13).
test("mux lazy-starts a backend for an unowned directory", async (t) => {
  const echo = await startEcho();
  const registry = new Registry();
  const ensured: string[] = [];
  const touched: number[] = [];
  const supervisor = {
    // Pretend to start (and expose) an echo backend for the requested directory.
    async ensure(directory: string) {
      ensured.push(directory);
      return backendFor(echo.port, directory);
    },
    // No anchor needed for this case.
    async ensureAnchor() {
      return null;
    },
    touch(port: number) {
      touched.push(port);
    },
  };
  const config = defaultConfig({ port: 0, stateDir: os.tmpdir() });
  const server = createMuxServer({ config, registry, supervisor });
  const port = await listen(server);
  t.after(async () => {
    await close(server);
    await close(echo.server);
  });

  const response = await fetch(`http://127.0.0.1:${port}/session/ses_x/prompt_async`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-directory": "/new/proj" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(ensured, ["/new/proj"]);
  assert.ok(touched.includes(echo.port));
});

// With no directory and no backend, the hidden anchor answers headerless reads.
test("mux uses the anchor for headerless reads when nothing else is available", async (t) => {
  const echo = await startEcho();
  const registry = new Registry();
  let anchorCalls = 0;
  const supervisor = {
    async ensure() {
      return null;
    },
    async ensureAnchor() {
      anchorCalls += 1;
      const backend = backendFor(echo.port, "/anchor");
      backend.anchor = true;
      return backend;
    },
    touch() {},
  };
  const config = defaultConfig({ port: 0, stateDir: os.tmpdir() });
  const server = createMuxServer({ config, registry, supervisor });
  const port = await listen(server);
  t.after(async () => {
    await close(server);
    await close(echo.server);
  });

  const response = await fetch(`http://127.0.0.1:${port}/project`);
  assert.equal(response.status, 200);
  assert.equal(anchorCalls, 1);

  // The anchor is read-only: a mutation routed to it is refused.
  const write = await fetch(`http://127.0.0.1:${port}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(write.status, 503);
});

// When a backend already owns the directory, the supervisor must not be invoked.
test("mux does not lazy-start when a backend owns the directory", async (t) => {
  const echo = await startEcho();
  const registry = new Registry();
  registry.set([backendFor(echo.port, "/owned")]);
  let called = false;
  const supervisor = {
    async ensure(directory: string) {
      called = true;
      return backendFor(echo.port, directory);
    },
    async ensureAnchor() {
      return null;
    },
    touch() {},
  };
  const config = defaultConfig({ port: 0, stateDir: os.tmpdir() });
  const server = createMuxServer({ config, registry, supervisor });
  const port = await listen(server);
  t.after(async () => {
    await close(server);
    await close(echo.server);
  });

  const response = await fetch(`http://127.0.0.1:${port}/echo`, {
    headers: { "x-opencode-directory": "/owned/sub" },
  });
  assert.equal(response.status, 200);
  assert.equal(called, false);
});

// A run action for an unowned project must start its own instance, never the default.
test("mux starts a new instance for an unowned directory on a run action", async (t) => {
  const other = await startEcho();
  const target = await startEcho();
  const registry = new Registry();
  registry.set([backendFor(other.port, "/other")]);
  let ensured: string | null = null;
  const supervisor = {
    async ensure(directory: string) {
      ensured = directory;
      return backendFor(target.port, directory);
    },
    async ensureAnchor() {
      return null;
    },
    touch() {},
  };
  const config = defaultConfig({ port: 0, stateDir: os.tmpdir(), debugAttribution: true });
  const server = createMuxServer({ config, registry, supervisor });
  const port = await listen(server);
  t.after(async () => {
    await close(server);
    await close(other.server);
    await close(target.server);
  });

  const response = await fetch(`http://127.0.0.1:${port}/session/ses_x/prompt_async`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-directory": "/new/proj" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-oat-backend"), String(target.port));
  assert.equal(ensured, "/new/proj");
});

// A read for an unowned project uses the anchor (shared DB) and spawns nothing.
test("mux serves an unowned-directory read via the anchor without spawning", async (t) => {
  const echo = await startEcho();
  const registry = new Registry();
  registry.set([backendFor(echo.port, "/other")]);
  let ensureCalls = 0;
  const supervisor = {
    async ensure() {
      ensureCalls += 1;
      return null;
    },
    async ensureAnchor() {
      const backend = backendFor(echo.port, "/anchor");
      backend.anchor = true;
      return backend;
    },
    touch() {},
  };
  const config = defaultConfig({ port: 0, stateDir: os.tmpdir(), debugAttribution: true });
  const server = createMuxServer({ config, registry, supervisor });
  const port = await listen(server);
  t.after(async () => {
    await close(server);
    await close(echo.server);
  });

  const response = await fetch(`http://127.0.0.1:${port}/session/ses_x/message`, {
    headers: { "x-opencode-directory": "/new/proj" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-oat-backend"), String(echo.port));
  // A read must not spawn a per-directory instance.
  assert.equal(ensureCalls, 0);
});

// A run action carrying only a session id resolves the directory via the anchor, then spawns.
test("mux resolves a session-id-only run action and starts its project instance", async (t) => {
  // Anchor that knows the session's directory.
  const anchor = await new Promise<{ server: http.Server; port: number }>((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith("/session/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ directory: "/resolved/proj" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
  const target = await startEcho();
  const registry = new Registry();
  let ensured: string | null = null;
  const supervisor = {
    async ensure(directory: string) {
      ensured = directory;
      return backendFor(target.port, directory);
    },
    async ensureAnchor() {
      const backend = backendFor(anchor.port, "/anchor");
      backend.anchor = true;
      return backend;
    },
    touch() {},
  };
  const config = defaultConfig({ port: 0, stateDir: os.tmpdir(), debugAttribution: true });
  const server = createMuxServer({ config, registry, supervisor });
  const port = await listen(server);
  t.after(async () => {
    await close(server);
    await close(anchor.server);
    await close(target.server);
  });

  const response = await fetch(`http://127.0.0.1:${port}/session/ses_x/prompt_async`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.equal(ensured, "/resolved/proj");
  assert.equal(response.headers.get("x-oat-backend"), String(target.port));
});

// With no backends, reads return valid empties instead of 503 (no error loop).
test("mux returns empty reads when no backend exists", async (t) => {
  const registry = new Registry();
  const config = defaultConfig({ port: 0, stateDir: os.tmpdir() });
  const server = createMuxServer({ config, registry });
  const port = await listen(server);
  t.after(() => close(server));

  // List endpoints return 200 with an empty array.
  const projects = await fetch(`http://127.0.0.1:${port}/project`);
  assert.equal(projects.status, 200);
  assert.deepEqual(await projects.json(), []);

  // Map endpoint returns an empty object.
  const statuses = await fetch(`http://127.0.0.1:${port}/session/status`);
  assert.equal(statuses.status, 200);
  assert.deepEqual(await statuses.json(), {});

  // Writes still report a gateway error.
  const create = await fetch(`http://127.0.0.1:${port}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(create.status, 503);
});

