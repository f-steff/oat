import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import { test } from "node:test";

import { defaultConfig } from "../src/config.js";
import { Registry } from "../src/registry.js";
import { createMuxServer } from "../src/server.js";
import type { Backend } from "../src/types.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function backendFor(port: number): Backend {
  return {
    port,
    pid: port,
    baseUrl: `http://127.0.0.1:${port}`,
    primaryDirectory: null,
    version: "2.0.24",
    healthy: true,
    lastSeen: 0,
    kind: "v2",
  };
}

// A v2 client must never receive JSON on an SSE endpoint: with no backend yet,
// OAT holds a valid event stream open and starts proxying when one appears.
test("v2 /api/event waits for a backend and then proxies it", async (t) => {
  const backend = http.createServer((req, res) => {
    if ((req.url ?? "/") === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write('data: {"id":"evt_1","type":"server.connected","data":{}}\n\n');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const backendPort = await listen(backend);

  const registry = new Registry();
  const config = defaultConfig({ port: 0, stateDir: os.tmpdir() });
  const mux = createMuxServer({ config, registry });
  const muxPort = await listen(mux);
  t.after(async () => {
    await close(mux);
    await close(backend);
  });

  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: muxPort, path: "/api/event", agent: false }, resolve).on("error", reject);
  });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["content-type"]), /text\/event-stream/);

  const chunks: string[] = [];
  const waitFor = (needle: string, timeoutMs = 4_000): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${JSON.stringify(needle)}; got ${JSON.stringify(chunks.join(""))}`)),
        timeoutMs,
      );
      const check = (): void => {
        if (chunks.join("").includes(needle)) {
          clearTimeout(timer);
          resolve();
        }
      };
      response.on("data", (chunk) => {
        chunks.push(String(chunk));
        check();
      });
      response.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      check();
    });

  // No backend yet: the stream is still a valid SSE response (heartbeat comment).
  await waitFor(": oat waiting for opencode");

  // Discovery finds the backend: the same response switches to its raw stream.
  registry.set([backendFor(backendPort)]);
  await waitFor('"type":"server.connected"');
  response.destroy();
});
