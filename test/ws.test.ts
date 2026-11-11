import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { test } from "node:test";

import { defaultConfig } from "../src/config.js";
import { Registry } from "../src/registry.js";
import { createMuxServer } from "../src/server.js";
import type { Backend } from "../src/types.js";

// Start a backend that accepts a WebSocket upgrade and writes a marker.
function startUpgradeBackend(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer();
    // The upgrade handler completes the handshake and sends "hello".
    server.on("upgrade", (_req, socket) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      socket.write("hello");
      setTimeout(() => socket.end(), 50);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

// Start a backend that accepts an upgrade and echoes the first payload, then ends.
function startEchoBackend(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.on("upgrade", (_req, socket) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      socket.on("data", (chunk: Buffer) => {
        socket.write(chunk);
        socket.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
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

// A raw upgrade request is forwarded to the backend selected by directory.
test("mux proxies websocket upgrades by directory", async (t) => {
  const backend = await startUpgradeBackend();
  const descriptor: Backend = {
    port: backend.port,
    pid: 5,
    baseUrl: `http://127.0.0.1:${backend.port}`,
    primaryDirectory: "C:\\ws",
    version: "test",
    healthy: true,
    lastSeen: 0,
  };
  const registry = new Registry();
  registry.set([descriptor]);

  const config = defaultConfig({ port: 0, stateDir: os.tmpdir() });
  const server = createMuxServer({ config, registry });
  const port = await listen(server);
  t.after(async () => {
    await close(server);
    await close(backend.server);
  });

  // Perform the upgrade handshake through the mux and collect the response.
  const response = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        "GET /ws HTTP/1.1\r\n" +
          "Host: 127.0.0.1\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "x-opencode-directory: C:\\ws\r\n\r\n",
      );
    });
    let data = "";
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    // Safety net so the test cannot hang if the socket stays open.
    setTimeout(() => {
      socket.destroy();
      resolve(data);
    }, 2_000);
  });

  assert.match(response, /101 Switching Protocols/);
  assert.match(response, /hello/);
});

// After the handshake the mux must tunnel data both ways (PTY-style live flow).
test("mux proxies live bidirectional websocket data", async (t) => {
  const backend = await startEchoBackend();
  const descriptor: Backend = {
    port: backend.port,
    pid: 6,
    baseUrl: `http://127.0.0.1:${backend.port}`,
    primaryDirectory: "C:\\pty",
    version: "test",
    healthy: true,
    lastSeen: 0,
  };
  const registry = new Registry();
  registry.set([descriptor]);

  const config = defaultConfig({ port: 0, stateDir: os.tmpdir() });
  const server = createMuxServer({ config, registry });
  const port = await listen(server);
  t.after(async () => {
    await close(server);
    await close(backend.server);
  });

  const received = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        "GET /ws HTTP/1.1\r\n" +
          "Host: 127.0.0.1\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "x-opencode-directory: C:\\pty\r\n\r\n",
      );
    });
    let data = "";
    let sent = false;
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      // Once upgraded, send a payload; the backend echoes it and closes.
      if (!sent && data.includes("101 Switching Protocols")) {
        sent = true;
        socket.write("ping-123");
      }
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      resolve(data);
    }, 2_000);
  });

  assert.match(received, /101 Switching Protocols/);
  assert.match(received, /ping-123/);
});
