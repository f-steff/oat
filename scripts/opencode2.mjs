#!/usr/bin/env node
// Install opencode v2 (@opencode/cli) side by side with an existing v1 install.
//
// v1 and v2 both ship a bin named `opencode`, so installing v2 globally would
// shadow v1. This helper installs v2 into an isolated prefix and creates only an
// `opencode2` wrapper, leaving `opencode` (v1) untouched. `uninstall` reverses it.
//
// Usage:
//   node scripts/opencode2.mjs install   [--prefix <dir>] [--bin-dir <dir>] [--version <v>] [--force]
//   node scripts/opencode2.mjs uninstall [--prefix <dir>] [--bin-dir <dir>] [--keep-prefix]
//   node scripts/opencode2.mjs status    [--prefix <dir>] [--bin-dir <dir>]
//
// Env overrides: OAT_OPENCODE2_PREFIX, OAT_OPENCODE2_BIN_DIR, OAT_OPENCODE2_VERSION.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const PACKAGE = "@opencode/cli";

function stateDir() {
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "oat");
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "oat");
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "oat");
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--prefix") args.prefix = argv[++i];
    else if (token === "--bin-dir") args.binDir = argv[++i];
    else if (token === "--version") args.version = argv[++i];
    else if (token === "--force") args.force = true;
    else if (token === "--keep-prefix") args.keepPrefix = true;
    else if (token === "-h" || token === "--help") args.help = true;
    else args._.push(token);
  }
  return args;
}

function defaults(args) {
  const prefix = args.prefix ?? process.env.OAT_OPENCODE2_PREFIX ?? join(stateDir(), "opencode2");
  const binDir = args.binDir ?? process.env.OAT_OPENCODE2_BIN_DIR ?? npmGlobalBin();
  const version = args.version ?? process.env.OAT_OPENCODE2_VERSION ?? "latest";
  return { prefix, binDir, version };
}

function npmGlobalBin() {
  const npm = platform() === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["prefix", "-g"], { encoding: "utf8", shell: platform() === "win32" });
  const dir = (result.stdout ?? "").trim();
  return dir || join(homedir(), ".local", "bin");
}

// The package ships a native launcher at bin/opencode(.exe); npm may also place
// a compiled binary elsewhere, so probe the known locations. Global installs use
// <prefix>/node_modules on Windows and <prefix>/lib/node_modules on POSIX.
function packageDirs(prefix) {
  return [
    join(prefix, "node_modules", "@opencode", "cli"),
    join(prefix, "lib", "node_modules", "@opencode", "cli"),
  ];
}

function findBinary(prefix) {
  for (const pkgDir of packageDirs(prefix)) {
    const candidates = [
      join(pkgDir, "bin", "opencode.exe"),
      join(pkgDir, "bin", "opencode"),
      join(pkgDir, "opencode.exe"),
      join(pkgDir, "opencode"),
    ];
    const found = candidates.find((c) => existsSync(c));
    if (found) return found;
  }
  return null;
}

function writeWrappers(binary, binDir) {
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });
  const written = [];

  if (platform() === "win32") {
    const cmd = join(binDir, "opencode2.cmd");
    writeFileSync(cmd, `@ECHO OFF\r\n"${binary}" %*\r\n`);
    written.push(cmd);

    const ps1 = join(binDir, "opencode2.ps1");
    writeFileSync(ps1, `& "${binary}" @args\r\n`);
    written.push(ps1);
  } else {
    const sh = join(binDir, "opencode2");
    writeFileSync(sh, `#!/bin/sh\nexec "${binary}" "$@"\n`);
    chmodSync(sh, 0o755);
    written.push(sh);
  }
  return written;
}

function removeWrappers(binDir) {
  const names = ["opencode2.cmd", "opencode2.ps1", "opencode2", "opencode2.exe"];
  const removed = [];
  for (const name of names) {
    const file = join(binDir, name);
    if (existsSync(file)) {
      rmSync(file, { force: true });
      removed.push(file);
    }
  }
  return removed;
}

function install(args) {
  const { prefix, binDir, version } = defaults(args);
  process.stdout.write(`Installing ${PACKAGE}@${version}\n  prefix:  ${prefix}\n  bin dir: ${binDir}\n`);

  if (existsSync(prefix) && !args.force) {
    const existing = findBinary(prefix);
    if (existing) {
      process.stdout.write(`Already installed at ${prefix} (use --force to reinstall).\n`);
      refreshWrappers(existing, binDir);
      return 0;
    }
  }

  mkdirSync(prefix, { recursive: true });
  const npm = platform() === "win32" ? "npm.cmd" : "npm";
  // The package's postinstall selects the native binary for the platform; npm's
  // allow-scripts policy blocks it unless the package is explicitly allowed.
  const result = spawnSync(
    npm,
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--foreground-scripts",
      `--allow-scripts=${PACKAGE}`,
      `${PACKAGE}@${version}`,
    ],
    { stdio: "inherit", shell: platform() === "win32" },
  );
  if (result.status !== 0) {
    process.stderr.write(`\nInstall failed (exit ${result.status}).\n`);
    return result.status ?? 1;
  }

  const binary = findBinary(prefix);
  if (!binary) {
    const listing = safeList(join(packageDirs(prefix)[1], "bin")) || safeList(join(packageDirs(prefix)[0], "bin"));
    process.stderr.write(
      `\nInstalled, but could not find the v2 binary. Looked under:\n  ${packageDirs(prefix).join("\n  ")}\n` +
        `Bin dir contains: ${listing || "(missing)"}\n`,
    );
    return 1;
  }

  refreshWrappers(binary, binDir);
  return 0;
}

function refreshWrappers(binary, binDir) {
  const written = writeWrappers(binary, binDir);
  process.stdout.write(`\nopencode v2 ready:\n  binary:  ${binary}\n`);
  for (const w of written) process.stdout.write(`  wrapper: ${w}\n`);
  process.stdout.write(
    `\nRun it with:  opencode2 --version\n` +
      `Inside OAT:   oat opencode2\n` +
      `Remove with:  npm run opencode2:uninstall\n`,
  );
}

function safeList(dir) {
  try {
    return readdirSync(dir).join(", ");
  } catch {
    return "";
  }
}

function uninstall(args) {
  const { prefix, binDir } = defaults(args);
  const removed = removeWrappers(binDir);
  process.stdout.write(removed.length ? `Removed wrappers: ${removed.join(", ")}\n` : "No wrappers found.\n");
  if (!args.keepPrefix && existsSync(prefix)) {
    rmSync(prefix, { recursive: true, force: true });
    process.stdout.write(`Removed ${prefix}\n`);
  } else if (args.keepPrefix) {
    process.stdout.write(`Kept ${prefix}\n`);
  }
  return 0;
}

function status(args) {
  const { prefix, binDir, version } = defaults(args);
  const binary = existsSync(prefix) ? findBinary(prefix) : null;
  process.stdout.write(`package:  ${PACKAGE}@${version}\nprefix:   ${prefix}\nbin dir:  ${binDir}\n`);
  process.stdout.write(`binary:   ${binary ?? "(not installed)"}\n`);
  const wrapper = join(binDir, platform() === "win32" ? "opencode2.cmd" : "opencode2");
  process.stdout.write(`wrapper:  ${wrapper} ${existsSync(wrapper) ? "(present)" : "(missing)"}\n`);
  return binary ? 0 : 1;
}

function usage() {
  process.stdout.write(
    `Usage: node scripts/opencode2.mjs <install|uninstall|status> [options]\n\n` +
      `Options:\n` +
      `  --prefix <dir>     Isolated install dir (default: <state>/oat/opencode2)\n` +
      `  --bin-dir <dir>    Where the 'opencode2' wrapper goes (default: npm global bin)\n` +
      `  --version <v>      Package version to install (default: latest)\n` +
      `  --force            Reinstall / overwrite\n` +
      `  --keep-prefix      (uninstall) keep the install dir\n`,
  );
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "install";
if (args.help) {
  usage();
  process.exit(0);
}
const commands = { install, uninstall, status };
const fn = commands[command];
if (!fn) {
  usage();
  process.exit(1);
}
process.exit(fn(args));
