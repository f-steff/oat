import assert from "node:assert/strict";
import { test } from "node:test";

import {
  mapInodesToPids,
  parseLsof,
  parseMacNetstat,
  parseProcNetTcp,
  parseWindowsNetTcp,
  type FsLike,
} from "../src/discovery/ports.js";

// Windows parsing keeps loopback/wildcard rows and extracts ports and PIDs.
test("parseWindowsNetTcp parses address|port|pid and filters foreign addresses", () => {
  const out = "127.0.0.1|46010|1234\r\n0.0.0.0|4096|5678\r\n8.8.8.8|80|9\r\n";
  const rows = parseWindowsNetTcp(out);
  assert.deepEqual(
    rows.map((row) => row.port),
    [46010, 4096],
  );
  assert.equal(rows[0]?.pid, 1234);
});

// /proc parsing keeps only LISTEN rows and decodes the hexadecimal port.
test("parseProcNetTcp keeps LISTEN rows and decodes hex ports", () => {
  const content = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:B3B2 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0",
    "   1: 0100007F:0035 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 99999 1 0000000000000000 100 0 0 10 0",
  ].join("\n");
  const rows = parseProcNetTcp(content);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.port, 0xb3b2);
  assert.equal(rows[0]?.inode, "12345");
});

// lsof parsing reads the PID column and the NAME column before "(LISTEN)".
test("parseLsof parses a macOS LISTEN line", () => {
  const out = "Python    60400 fsteff    3u  IPv4 0x1234      0t0  TCP 127.0.0.1:46123 (LISTEN)";
  const rows = parseLsof(out);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.port, 46123);
  assert.equal(rows[0]?.pid, 60400);
});

// macOS netstat (verbose) carries the owning process as `Name:PID`.
test("parseMacNetstat extracts the process pid", () => {
  const out =
    "tcp4 0 0 127.0.0.1.46123 *.* LISTEN 0 0 131072 131072 Python:60400 00000 00000006 000000000000fa9810 00000000 00000800 1 0 000000";
  const rows = parseMacNetstat(out);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.port, 46123);
  assert.equal(rows[0]?.pid, 60400);
});

// Inode-to-PID mapping scans /proc/<pid>/fd symlinks for socket:[inode].
test("mapInodesToPids scans /proc/<pid>/fd symlinks", async () => {
  const fsLike: FsLike = {
    async readFile() {
      return "";
    },
    async readdir(dir: string) {
      // Two processes with one socket fd each; one empty process.
      if (dir === "/proc") return ["1", "self", "42"];
      if (dir === "/proc/1/fd") return ["0", "3"];
      if (dir === "/proc/42/fd") return ["5"];
      if (dir === "/proc/self/fd") return [];
      throw new Error("ENOENT");
    },
    async readlink(file: string) {
      if (file === "/proc/1/fd/3") return "socket:[12345]";
      if (file === "/proc/42/fd/5") return "socket:[777]";
      throw new Error("ENOENT");
    },
  };
  const map = await mapInodesToPids(new Set(["12345", "777"]), fsLike, "/proc");
  assert.equal(map.get("12345"), 1);
  assert.equal(map.get("777"), 42);
});
