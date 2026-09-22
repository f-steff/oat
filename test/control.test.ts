import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import { test } from "node:test";

import { defaultConfig } from "../src/config.js";
import { callControl, fetchIdentity } from "../src/control.js";
import { Registry } from "../src/registry.js";
import { createMuxServer } from "../src/server.js";

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

// The control API must be discoverable without a token but protect every other route.
test("control API: identity public, others token-guarded, commands dispatched", async (t) => {
  const calls = { reload: 0, stop: 0 };
  const config = defaultConfig({ port: 0, token: "secret", stateDir: os.tmpdir() });
  const registry = new Registry();
  const server = createMuxServer({
    config,
    registry,
    control: {
      status: () => ({ ok: true }),
      list: () => registry.list(),
      reload: async () => {
        calls.reload += 1;
      },
      stop: async () => {
        calls.stop += 1;
      },
    },
  });
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  // Identity is public so a second invocation can detect the daemon.
  const identity = await fetchIdentity(base, 1_000);
  assert.equal(identity?.oat, true);
  assert.ok((identity?.version ?? "").length > 0);

  // Any other route without the token is rejected.
  const unauthorized = await fetch(`${base}/__oat/status`);
  assert.equal(unauthorized.status, 401);

  // With the token, status and list succeed.
  const status = await callControl(base, "secret", "/status");
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, { ok: true });

  const list = await callControl(base, "secret", "/list");
  assert.equal(list.status, 200);

  // reload and stop dispatch to the handlers.
  const reload = await callControl(base, "secret", "/reload", "POST");
  assert.equal(reload.status, 200);
  assert.equal(calls.reload, 1);

  const stop = await callControl(base, "secret", "/stop", "POST");
  assert.equal(stop.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.stop, 1);

  // Unknown control routes return 404.
  const missing = await callControl(base, "secret", "/nope");
  assert.equal(missing.status, 404);
});
