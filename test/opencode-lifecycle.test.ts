import assert from "node:assert/strict";
import { test } from "node:test";

import { parseLifecycleArgs, waitForIdle, type ServiceClient } from "../src/opencode-lifecycle.js";

function client(active: () => Promise<Record<string, { type: string }>>, interrupted?: string[]): ServiceClient {
  return {
    url: "http://127.0.0.1:1",
    info: async () => null,
    active,
    session: async () => null,
    interrupt: async (id) => {
      interrupted?.push(id);
    },
  };
}

test("parseLifecycleArgs parses defaults and flags", () => {
  const defaults = parseLifecycleArgs([]);
  assert.equal(defaults.method, "auto");
  assert.equal(defaults.timeoutMs, 0);
  assert.equal(defaults.noRelaunch, false);

  const parsed = parseLifecycleArgs([
    "--check",
    "--list",
    "--method",
    "brew-core",
    "--version=2.0.24",
    "--timeout",
    "30",
    "--force-interrupt",
    "--no-relaunch",
    "--force-close-tuis",
    "--backup-db",
    "--yes",
  ]);
  assert.equal(parsed.check, true);
  assert.equal(parsed.list, true);
  assert.equal(parsed.method, "brew-core");
  assert.equal(parsed.version, "2.0.24");
  assert.equal(parsed.timeoutMs, 30_000);
  assert.equal(parsed.forceInterrupt, true);
  assert.equal(parsed.noRelaunch, true);
  assert.equal(parsed.forceCloseTuis, true);
  assert.equal(parsed.backupDb, true);
  assert.equal(parsed.yes, true);
});

test("waitForIdle returns immediately when nothing is active", async () => {
  assert.equal(await waitForIdle(client(async () => ({})), { timeoutMs: 0, forceInterrupt: false }), true);
});

test("waitForIdle interrupts active sessions once and then succeeds", async () => {
  let active: Record<string, { type: string }> = { ses_a: { type: "running" } };
  const interrupted: string[] = [];
  const service = client(async () => active, interrupted);
  service.interrupt = async (id) => {
    interrupted.push(id);
    active = {};
  };
  const ok = await waitForIdle(service, { timeoutMs: 0, forceInterrupt: true }, () => {}, {
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(ok, true);
  assert.deepEqual(interrupted, ["ses_a"]);
});

test("waitForIdle times out", async () => {
  let now = 0;
  const ok = await waitForIdle(
    client(async () => ({ ses_a: { type: "running" } })),
    { timeoutMs: 1_000, forceInterrupt: false },
    () => {},
    {
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    },
  );
  assert.equal(ok, false);
});
