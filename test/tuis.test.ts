import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  isTuiCommand,
  registerTui,
  relaunchTuis,
  resumeCommand,
  sessionIdFromArgs,
  snapshotTuis,
} from "../src/tuis.js";

test("sessionIdFromArgs reads -s and --session", () => {
  assert.equal(sessionIdFromArgs("opencode -s ses_abc"), "ses_abc");
  assert.equal(sessionIdFromArgs("opencode --session=ses_def"), "ses_def");
  assert.equal(sessionIdFromArgs("opencode --continue"), null);
});

test("isTuiCommand excludes servers", () => {
  assert.equal(isTuiCommand("C:\\x\\opencode.exe -s ses_a"), true);
  assert.equal(isTuiCommand("opencode --continue"), true);
  assert.equal(isTuiCommand("C:\\x\\opencode.exe serve --service"), false);
  assert.equal(isTuiCommand("opencode serve --port 4096"), false);
  assert.equal(isTuiCommand("node dist/cli.js serve"), false);
});

test("snapshotTuis merges registered and detected TUIs and resolves session dirs", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "oat-tui-"));
  try {
    registerTui(stateDir, { pid: 111, cwd: "C:\\proj-a", args: ["-s", "ses_a"], startedAt: 1 });
    const entries = await snapshotTuis(
      stateDir,
      "linux",
      async (sessionId) => (sessionId === "ses_a" ? "/proj/a" : sessionId === "ses_b" ? "/proj/b" : null),
      {
        alive: (pid) => pid === 111 || pid === 222,
        run: (file) =>
          file === "ps"
            ? " 111 /usr/bin/opencode -s ses_a\n 222 /usr/bin/opencode -s ses_b\n 333 /usr/bin/opencode serve --service\n"
            : "",
      },
    );
    assert.equal(entries.length, 2);
    const a = entries.find((entry) => entry.pid === 111);
    const b = entries.find((entry) => entry.pid === 222);
    assert.equal(a?.cwd, "/proj/a");
    assert.equal(a?.sessionId, "ses_a");
    assert.equal(a?.source, "registry");
    assert.equal(b?.cwd, "/proj/b");
    assert.equal(b?.sessionId, "ses_b");
    assert.equal(b?.source, "process");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("relaunchTuis skips entries without a cwd", () => {
  const specs: string[] = [];
  const result = relaunchTuis(
    [
      { pid: 1, cwd: "/a", args: [], sessionId: "ses_a", source: "registry" },
      { pid: 2, cwd: null, args: [], sessionId: null, source: "process" },
    ],
    { launchCommand: null },
    "linux",
    {
      launch: (spec) => {
        specs.push(`${spec.command} ${spec.args.join(" ")}`);
        return true;
      },
    },
  );
  assert.equal(result.launched.length, 1);
  assert.equal(result.failed.length, 1);
  assert.match(specs[0] ?? "", /opencode -s ses_a/);
});

test("resumeCommand includes the directory and session", () => {
  assert.equal(
    resumeCommand({ pid: 1, cwd: "/x", args: [], sessionId: "ses_a", source: "registry" }),
    'cd "/x" && oat opencode -s ses_a',
  );
});
