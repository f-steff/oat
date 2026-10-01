import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { clearState, isProcessAlive, readState, writeState } from "../src/state.js";

// State must round-trip through disk and clear cleanly.
test("state round-trips and clears", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oat-state-"));
  // A fresh directory has no state.
  assert.equal(await readState(dir), null);
  // Write, read back, then clear.
  await writeState(dir, {
    pid: 123,
    pidStartMarker: null,
    port: 4096,
    host: "127.0.0.1",
    version: "0.2.0",
    startedAt: 1,
    token: "t",
  });
  const loaded = await readState(dir);
  assert.equal(loaded?.port, 4096);
  assert.equal(loaded?.token, "t");
  await clearState(dir);
  assert.equal(await readState(dir), null);
});

// The v2 backend password must persist so every CLI/daemon invocation agrees.
test("state round-trips the v2 backend password", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oat-state-v2-"));
  await writeState(dir, {
    pid: 1,
    pidStartMarker: null,
    port: 4096,
    host: "127.0.0.1",
    version: "0.2.0",
    startedAt: 1,
    token: "t",
    v2Password: "shared-secret",
  });
  assert.equal((await readState(dir))?.v2Password, "shared-secret");
});

// The current process must always be reported alive.
test("isProcessAlive is true for this process", () => {
  assert.equal(isProcessAlive(process.pid), true);
});
