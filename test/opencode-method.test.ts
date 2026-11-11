import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyMethod,
  installPlan,
  listAvailableVersions,
  resolveOpencodeInfo,
  updatePlan,
  type OpencodeInfo,
} from "../src/opencode-method.js";

const BASE: OpencodeInfo = {
  bin: "opencode",
  command: "opencode",
  shell: false,
  realPath: "/x",
  version: "opencode v2.0.22",
  method: "npm",
};

test("classifyMethod recognises npm and Homebrew installs", () => {
  assert.equal(
    classifyMethod("C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.exe"),
    "npm",
  );
  assert.equal(classifyMethod("/opt/homebrew/Cellar/opencode/2.0.20/bin/opencode"), "brew-core");
  assert.equal(classifyMethod("/opt/homebrew/Cellar/opencode-v2/2.0.24/bin/opencode"), "brew-tap");
  assert.equal(classifyMethod("/home/x/.opencode/bin/opencode"), "curl");
  assert.equal(classifyMethod("/usr/local/bin/opencode"), "other");
  assert.equal(classifyMethod(null), "other");
});

test("updatePlan maps each method to the right command", () => {
  assert.deepEqual(updatePlan(BASE, "2.0.24")?.steps, [
    { file: "npm", args: ["install", "-g", "@opencode/cli@2.0.24"] },
  ]);
  assert.deepEqual(
    updatePlan({ ...BASE, method: "brew-core" })?.steps.map((step) => [step.file, ...step.args]),
    [
      ["brew", "update"],
      ["brew", "upgrade", "opencode"],
    ],
  );
  assert.deepEqual(updatePlan({ ...BASE, method: "brew-tap" })?.steps[0]?.args, [
    "upgrade",
    "anomalyco/tap/opencode-v2",
  ]);
  assert.deepEqual(updatePlan({ ...BASE, method: "curl" }, "2.0.24")?.steps[0]?.args, [
    "upgrade",
    "--method",
    "curl",
    "2.0.24",
  ]);
  assert.equal(updatePlan({ ...BASE, method: "other" }), null);
});

test("installPlan defaults to npm when no install is detected", () => {
  const fresh: OpencodeInfo = { ...BASE, realPath: null, version: null, method: "other" };
  assert.deepEqual(installPlan(fresh, "auto")?.steps, [
    { file: "npm", args: ["install", "-g", "@opencode/cli@latest"] },
  ]);
  assert.deepEqual(installPlan(fresh, "brew-core")?.steps, [{ file: "brew", args: ["install", "opencode"] }]);
});

test("resolveOpencodeInfo uses the resolved path and version", () => {
  const info = resolveOpencodeInfo("C:\\tools\\opencode.exe", {
    platform: "win32",
    exists: (candidate) => candidate === "C:\\tools\\opencode.exe",
    realpath: (candidate) => candidate,
    exec: (_file, args) => (args[0] === "--version" ? "opencode v2.0.22" : ""),
  });
  assert.equal(info.version, "opencode v2.0.22");
  assert.equal(info.method, "other");
});

test("listAvailableVersions keeps stable versions sorted and reads tags", () => {
  const available = listAvailableVersions("opencode v2.2.5", {
    platform: "linux",
    exec: (_file, args) => {
      if (args.includes("versions")) {
        return JSON.stringify(["2.2.0", "2.2.6", "2.2.7", "2.2.6-internal.1", "2.2.5"]);
      }
      if (args.includes("dist-tags")) return JSON.stringify([{ latest: "2.2.7", beta: "0.0.0-beta" }]);
      return "";
    },
  });
  assert.deepEqual(available.versions, ["2.2.7", "2.2.6", "2.2.5", "2.2.0"]);
  assert.equal(available.latest, "2.2.7");
  assert.equal(available.installed, "2.2.5");
});
