import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import { test } from "node:test";

import { defaultConfig } from "../src/config.js";
import { Registry } from "../src/registry.js";
import { createMuxServer } from "../src/server.js";
import type { Backend } from "../src/types.js";

/** A running fake opencode backend. */
interface FakeBackend {
  server: http.Server;
  port: number;
  directory: string;
}

// Start a fake opencode server exposing health, path, echo and an SSE stream.
function startFakeBackend(directory: string, label: string): Promise<FakeBackend> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      // Liveness probe.
      if (url.pathname === "/global/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ healthy: true, version: "test" }));
        return;
      }
      // Primary-directory probe.
      if (url.pathname === "/path") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ directory }));
        return;
      }
      // Identity echo used to prove which backend served a request.
      if (url.pathname === "/echo") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ directory, label }));
        return;
      }
      // A long-lived SSE stream that identifies its source.
      if (url.pathname === "/global/event") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ label, seq: 1 })}\n\n`);
        const timer = setInterval(() => res.write(`: keepalive ${label}\n\n`), 1_000);
        req.on("close", () => {
          clearInterval(timer);
          res.end();
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0, directory });
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
async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// End-to-end through the mux: health, directory routing, default and SSE fan-in.
test("mux: health, directory routing, and SSE fan-in across two backends", async (t) => {
  const a = await startFakeBackend("C:\\proj\\a", "A");
  const b = await startFakeBackend("C:\\proj\\b", "B");

  // Seed the registry directly (discovery is covered by discover.test.ts).
  const registry = new Registry();
  const backends: Backend[] = [
    {
      port: a.port,
      pid: 111,
      baseUrl: `http://127.0.0.1:${a.port}`,
      primaryDirectory: a.directory,
      version: "test",
      healthy: true,
      lastSeen: 0,
    },
    {
      port: b.port,
      pid: 222,
      baseUrl: `http://127.0.0.1:${b.port}`,
      primaryDirectory: b.directory,
      version: "test",
      healthy: true,
      lastSeen: 0,
    },
  ];
  registry.set(backends);

  const config = defaultConfig({
    port: 0,
    host: "127.0.0.1",
    token: "test-token",
    debugAttribution: true,
    stateDir: os.tmpdir(),
  });
  const server = createMuxServer({ config, registry });
  const muxPort = await listen(server);
  const base = `http://127.0.0.1:${muxPort}`;

  t.after(async () => {
    await closeServer(server);
    await closeServer(a.server);
    await closeServer(b.server);
  });

  // OAT answers the bridge's liveness probe itself.
  const health = (await (await fetch(`${base}/global/health`)).json()) as { healthy: boolean; version: string };
  assert.equal(health.healthy, true);
  assert.match(health.version, /^oat\//);

  // Requests are routed by the x-opencode-directory header.
  const ra = await fetch(`${base}/echo`, { headers: { "x-opencode-directory": "C:\\proj\\a\\deep" } });
  assert.equal(ra.headers.get("x-oat-backend"), String(a.port));
  assert.equal(((await ra.json()) as { label: string }).label, "A");

  const rb = await fetch(`${base}/echo`, { headers: { "x-opencode-directory": "C:\\proj\\b" } });
  assert.equal(rb.headers.get("x-oat-backend"), String(b.port));
  assert.equal(((await rb.json()) as { label: string }).label, "B");

  // With no directory, the lowest port is the deterministic default.
  const rd = await fetch(`${base}/echo`);
  assert.equal(rd.headers.get("x-oat-backend"), String(Math.min(a.port, b.port)));

  // Both backends' SSE streams are merged into one downstream stream.
  const controller = new AbortController();
  const sse = await fetch(`${base}/global/event`, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  const reader = sse.body?.getReader();
  assert.ok(reader, "expected an SSE body");
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && !(text.includes('"label":"A"') && text.includes('"label":"B"'))) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  controller.abort();

  // Both sources and both attribution comments must be present.
  assert.match(text, /"label":"A"/);
  assert.match(text, /"label":"B"/);
  assert.match(text, new RegExp(`: oat-backend=${a.port}`));
  assert.match(text, new RegExp(`: oat-backend=${b.port}`));
});
