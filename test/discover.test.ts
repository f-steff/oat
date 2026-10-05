import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { discoverBackends, isOatAnchorDir, makeHttpProbe } from "../src/discovery/discover.js";
import type { RawListener } from "../src/types.js";

// Start a fake opencode-like server with configurable health and a directory.
function startServer(opts: { healthy: boolean; directory: string; notOpencode?: boolean; version?: string }): Promise<{
  server: http.Server;
  port: number;
}> {
  return new Promise((resolve) => {
    // A "notOpencode" server answers everything with 404.
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (opts.notOpencode) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (url.pathname === "/global/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ healthy: opts.healthy, version: opts.version ?? "test" }));
        return;
      }
      if (url.pathname === "/path") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ directory: opts.directory }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    // Bind an ephemeral port and report it back.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

// Close a server, force-closing any keep-alive connections.
async function close(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// Discovery should return only servers whose health probe succeeds.
test("discoverBackends finds healthy servers and skips unhealthy ones", async (t) => {
  const good = await startServer({ healthy: true, directory: "/p/a" });
  const bad = await startServer({ healthy: false, directory: "/p/b" });
  t.after(async () => {
    await close(good.server);
    await close(bad.server);
  });

  const listeners: RawListener[] = [
    { port: good.port, pid: 1, address: "127.0.0.1" },
    { port: bad.port, pid: 2, address: "127.0.0.1" },
  ];
  const found = await discoverBackends(listeners, { probe: makeHttpProbe(500) });

  assert.equal(found.length, 1);
  assert.equal(found[0]?.port, good.port);
  assert.equal(found[0]?.primaryDirectory, "/p/a");
  assert.equal(found[0]?.version, "test");
});

// Discovery must ignore a listener that is not opencode at all.
test("discoverBackends ignores non-opencode listeners", async (t) => {
  const other = await startServer({ healthy: true, directory: "/x", notOpencode: true });
  t.after(() => close(other.server));

  const found = await discoverBackends([{ port: other.port, pid: 3, address: "127.0.0.1" }], {
    probe: makeHttpProbe(500),
  });
  assert.equal(found.length, 0);
});

// `skipPorts` must exclude OAT's own port (or any caller-provided port).
test("discoverBackends honors skipPorts", async (t) => {
  const good = await startServer({ healthy: true, directory: "/p/a" });
  t.after(() => close(good.server));

  const found = await discoverBackends([{ port: good.port, pid: 1, address: "127.0.0.1" }], {
    probe: makeHttpProbe(500),
    skipPorts: new Set([good.port]),
  });
  assert.equal(found.length, 0);
});

// Another OAT instance advertises an `oat/` version and must never be treated as opencode.
test("discoverBackends ignores an OAT instance", async (t) => {
  const oat = await startServer({ healthy: true, directory: "/x", version: "oat/0.2.0" });
  t.after(() => close(oat.server));

  const found = await discoverBackends([{ port: oat.port, pid: 1, address: "127.0.0.1" }], {
    probe: makeHttpProbe(500),
  });
  assert.equal(found.length, 0);
});

// OAT's own anchor directories are never treated as project backends.
test("isOatAnchorDir recognizes OAT anchor directories", () => {
  assert.equal(isOatAnchorDir("C:\\Users\\x\\AppData\\Local\\oat\\anchor"), true);
  assert.equal(isOatAnchorDir("C:\\Users\\x\\AppData\\Local\\Temp\\oat-daemon-Abc123\\anchor"), true);
  assert.equal(isOatAnchorDir("C:\\Projects\\github\\f-steff\\git-nest"), false);
  // A genuine project folder called "anchor" is not excluded.
  assert.equal(isOatAnchorDir("C:\\Projects\\myapp\\anchor"), false);
  assert.equal(isOatAnchorDir(null), false);
});

// Our own anchor is kept (so it can be adopted); foreign/temp anchors are hidden.
test("discoverBackends keeps our anchor and hides foreign ones", async (t) => {
  const ours = await startServer({ healthy: true, directory: "/srv/oat/anchor" });
  t.after(() => close(ours.server));
  const foreign = await startServer({ healthy: true, directory: "/tmp/oat-daemon-x/anchor" });
  t.after(() => close(foreign.server));

  const listeners: RawListener[] = [
    { port: ours.port, pid: 11, address: "127.0.0.1" },
    { port: foreign.port, pid: 22, address: "127.0.0.1" },
  ];

  const found = await discoverBackends(listeners, { probe: makeHttpProbe(500), anchorDir: "/srv/oat/anchor" });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.port, ours.port);
  assert.equal(found[0]?.anchor, true);

  // With no anchorDir, every anchor directory is hidden.
  const none = await discoverBackends(listeners, { probe: makeHttpProbe(500) });
  assert.equal(none.length, 0);
});

