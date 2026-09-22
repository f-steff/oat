import assert from "node:assert/strict";
import { test } from "node:test";

import { buildLaunchSpec, expandTokens, projectTitle } from "../src/launcher.js";

// Window titles must be short and derive from the project folder name.
test("projectTitle is short and path-based", () => {
  assert.equal(projectTitle("C:\\Projects\\ccs-linux-container"), "oat: ccs-linux-container");
  assert.equal(projectTitle("/home/user/proj/"), "oat: proj");
});

// Windows uses Windows Terminal with a short title and the project as cwd.
test("buildLaunchSpec uses Windows Terminal on win32", () => {
  const spec = buildLaunchSpec("C:\\Projects\\demo", "win32");
  assert.equal(spec?.command, "wt.exe");
  assert.ok(spec?.args.includes("-d"));
  assert.ok(spec?.args.includes("C:\\Projects\\demo"));
  assert.ok(spec?.args.includes("--title"));
  assert.ok(spec?.args.includes("oat: demo"));
  assert.ok(spec?.args.includes("opencode"));
});

// macOS uses Terminal.app through AppleScript.
test("buildLaunchSpec uses osascript on darwin", () => {
  const spec = buildLaunchSpec("/Users/me/proj", "darwin");
  assert.equal(spec?.command, "osascript");
  assert.ok(spec?.args.join(" ").includes("proj"));
});

// Linux defaults to gnome-terminal.
test("buildLaunchSpec uses gnome-terminal on linux", () => {
  const spec = buildLaunchSpec("/srv/app", "linux");
  assert.equal(spec?.command, "gnome-terminal");
  assert.ok(spec?.args.some((arg) => arg.startsWith("--working-directory=")));
});

// A user template with placeholders overrides the per-OS default.
test("buildLaunchSpec expands a template", () => {
  const spec = buildLaunchSpec("/p/x", "linux", "myterm --dir={dir} --name={title}");
  assert.equal(spec?.command, "myterm");
  assert.deepEqual(spec?.args, ["--dir=/p/x", "--name=oat: x"]);
});

// Extra opencode arguments are appended to the launched command.
test("buildLaunchSpec appends opencode args", () => {
  const win = buildLaunchSpec("C:\\p\\demo", "win32", null, ["--port", "5000"]);
  assert.ok((win?.args.join(" ") ?? "").includes("opencode --port 5000"));
  const linux = buildLaunchSpec("/p/demo", "linux", null, ["serve"]);
  assert.deepEqual(linux?.args.slice(-2), ["opencode", "serve"]);
});

// Named `{...}` placeholders expand; unknown ones are left untouched.
test("expandTokens expands placeholders", () => {
  assert.deepEqual(expandTokens("--opencode-port {port} --host {host}", { port: "4096", host: "127.0.0.1" }), [
    "--opencode-port",
    "4096",
    "--host",
    "127.0.0.1",
  ]);
  assert.deepEqual(expandTokens("a {missing} b", {}), ["a", "{missing}", "b"]);
});
