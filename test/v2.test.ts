import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { basicAuth, discoverBackends, makeHttpProbe } from "../src/discovery/discover.js";
import type { RawListener } from "../src/types.js";

const PASSWORD = "oat-test-pass";

/** Start a fake opencode v2 server: `/api/info` + `/api/location` behind Basic auth. */
function startV2(directory: string): Promise<{ server: http.Server; port: number }> {
  const expected = basicAuth(PASSWORD);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.headers.authorization !== expected) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (url.pathname === "/api/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ version: "2.0.15", pid: 42, urls: ["http://127.0.0.1:0"] }));
        return;
      }
      if (url.pathname === "/api/location") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ directory }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

test("basicAuth builds the opencode:password Basic value", () => {
  const expected = `Basic ${Buffer.from("opencode:secret").toString("base64")}`;
  assert.equal(basicAuth("secret"), expected);
  assert.equal(basicAuth("secret", "user"), `Basic ${Buffer.from("user:secret").toString("base64")}`);
});

test("makeHttpProbe detects v2 with the right password, and rejects the wrong one", async (t) => {
  const { server, port } = await startV2("C:\\work\\proj");
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${port}`;

  const ok = await makeHttpProbe(1_000, { v2Password: PASSWORD }).health(baseUrl);
  assert.equal(ok?.healthy, true);
  assert.equal(ok?.kind, "v2");
  assert.equal(ok?.version, "2.0.15");

  // Without a password (or with the wrong one) the 401 must not count as opencode.
  assert.equal(await makeHttpProbe(1_000, {}).health(baseUrl), null);
  assert.equal(await makeHttpProbe(1_000, { v2Password: "nope" }).health(baseUrl), null);

  const directory = await makeHttpProbe(1_000, { v2Password: PASSWORD }).path(baseUrl, "v2");
  assert.equal(directory, "C:\\work\\proj");
});

test("discoverBackends tags a v2 server with kind and password", async (t) => {
  const { server, port } = await startV2("C:\\work\\proj");
  t.after(() => server.close());
  const listeners: RawListener[] = [{ port, pid: 42, address: "127.0.0.1" }];

  const backends = await discoverBackends(listeners, { v2Password: PASSWORD });
  assert.equal(backends.length, 1);
  assert.equal(backends[0]?.kind, "v2");
  assert.equal(backends[0]?.password, PASSWORD);
  assert.equal(backends[0]?.primaryDirectory, "C:\\work\\proj");
  assert.equal(backends[0]?.version, "2.0.15");

  // Without the password, the same server is not discoverable as opencode.
  assert.deepEqual(await discoverBackends(listeners, {}), []);
});
