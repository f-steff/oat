import assert from "node:assert/strict";
import { test } from "node:test";

import { listListeners, type FsLike, type Runner } from "../src/discovery/ports.js";

// A /proc/net/tcp fixture with a single LISTEN socket (inode 12345).
const PROC_TCP = [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 0100007F:B3B2 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0",
].join("\n");

// Windows dispatch should ask PowerShell and parse the address|port|pid output.
test("listListeners(win32) dispatches to PowerShell and parses output", async () => {
  const runner: Runner = async (_file, args) => {
    const command = args[args.length - 1] ?? "";
    // The version probe picks the shell; the listener command returns our fixture.
    if (command.includes("PSVersionTable")) return "7";
    if (command.includes("Get-NetTCPConnection")) return "127.0.0.1|46010|1234\r\n";
    return "";
  };
  const rows = await listListeners({ platform: "win32", runner });
  assert.deepEqual(
    rows.map((row) => row.port),
    [46010],
  );
  assert.equal(rows[0]?.pid, 1234);
});

// macOS dispatch should use lsof and parse its LISTEN line.
test("listListeners(darwin) dispatches to lsof", async () => {
  const runner: Runner = async (file) => {
    if (file === "lsof") return "Python    60400 fsteff    3u  IPv4 0x1      0t0  TCP 127.0.0.1:46123 (LISTEN)";
    return "";
  };
  const rows = await listListeners({ platform: "darwin", runner });
  assert.equal(rows[0]?.port, 46123);
  assert.equal(rows[0]?.pid, 60400);
});

// Linux dispatch should read /proc and map the socket inode to its PID.
test("listListeners(linux) uses /proc and maps inode to pid", async () => {
  const fsLike: FsLike = {
    readFile: async (file) => (file.endsWith("/tcp") ? PROC_TCP : ""),
    readdir: async (dir) => {
      // One process, with one file descriptor.
      if (dir === "/proc") return ["1"];
      if (dir === "/proc/1/fd") return ["3"];
      return [];
    },
    readlink: async () => "socket:[12345]",
  };
  const rows = await listListeners({ platform: "linux", fs: fsLike, procDir: "/proc" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.port, 0xb3b2);
  assert.equal(rows[0]?.pid, 1);
});
