#!/usr/bin/env node
// Install opencode v2 (@opencode/cli) side by side with an existing v1 install.
//
// v1 (`opencode-ai`) and v2 (`@opencode/cli`) BOTH ship a bin named `opencode`,
// so installing v2 into the global prefix would overwrite v1 and `opencode`
// would start v2. This helper avoids that: it installs v2 into an ISOLATED
// prefix and writes only an `opencode2` wrapper into the real global bin, so
// v1's `opencode` is never touched. It refuses a prefix that would collide with
// the global bin, verifies both versions afterwards, and `uninstall` reverses it.
//
// Usage:
//   node scripts/opencode2.mjs install   [--prefix <dir>] [--bin-dir <dir>] [--version <v>] [--force]
//   node scripts/opencode2.mjs uninstall [--prefix <dir>] [--bin-dir <dir>] [--keep-prefix]
//   node scripts/opencode2.mjs status    [--prefix <dir>] [--bin-dir <dir>]
//
// Env overrides: OAT_OPENCODE2_PREFIX, OAT_OPENCODE2_BIN_DIR, OAT_OPENCODE2_VERSION.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "oat");
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

/** Directory where `npm i -g` links bins: the global prefix itself on Windows, `<prefix>/bin` on POSIX. */
function npmGlobalBin() {
  const npm = platform() === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["prefix", "-g"], {
    encoding: "utf8",
    shell: platform() === "win32",
    windowsHide: true,
  });
  const prefix = (result.stdout ?? "").trim();
  if (!prefix) return join(homedir(), ".local", "bin");
  return platform() === "win32" ? prefix : join(prefix, "bin");
}

/** Compare two paths ignoring case and separators. */
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

/** Where npm places the shims for `npm i -g --prefix <prefix>`. */
function shimDir(prefix) {
  return platform() === "win32" ? prefix : join(prefix, "bin");
}

/** Resolve a command on PATH (first match), or null. */
function which(name) {
  const finder = platform() === "win32" ? "where" : "which";
  const result = spawnSync(finder, [name], {
    encoding: "utf8",
    shell: platform() === "win32",
    windowsHide: true,
    timeout: 8_000,
  });
  return (result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? null;
}

/** Run `<name> --version` and return the numeric version, or null. */
function commandVersion(name) {
  const result = spawnSync(name, ["--version"], {
    encoding: "utf8",
    shell: platform() === "win32",
    windowsHide: true,
    timeout: 20_000,
  });
  if (result.error) return null;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return match ? match[0] : null;
}

// The package ships a native launcher at bin/opencode(.exe); global installs use
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

function safeList(dir) {
  try {
    return readdirSync(dir).join(", ");
  } catch {
    return "";
  }
}

/**
 * Report which `opencode` (v1) and `opencode2` (v2) resolve on PATH and their
 * versions, warning if v1 looks overwritten by v2.
 */
function reportEnvironments(prefix, binDir) {
  const v1Path = which("opencode");
  const v1Version = v1Path ? commandVersion("opencode") : null;
  const v2Path = which("opencode2");
  const v2Version = v2Path ? commandVersion("opencode2") : null;

  process.stdout.write("\nopencode environments:\n");
  if (!v1Path) {
    process.stdout.write("  v1 `opencode`:   (not on PATH) -> install with: npm install -g opencode-ai\n");
  } else {
    const overwritten =
      (v1Version?.startsWith("2.") ?? false) || (prefix && v1Path.replace(/\\/g, "/").toLowerCase().startsWith(prefix.replace(/\\/g, "/").toLowerCase()));
    process.stdout.write(
      `  v1 \`opencode\`:   ${v1Path}  ${v1Version ? `(${v1Version})` : "(version unknown)"}` +
        `${overwritten ? "   <-- WARNING: v1 looks overwritten by v2" : ""}\n`,
    );
  }
  if (!v2Path) {
    process.stdout.write("  v2 `opencode2`:  (not on PATH) -> run: npm run opencode2:install\n");
  } else {
    process.stdout.write(`  v2 \`opencode2\`:  ${v2Path}  ${v2Version ? `(${v2Version})` : "(version unknown)"}\n`);
  }
  const wrapper = join(binDir, platform() === "win32" ? "opencode2.cmd" : "opencode2");
  process.stdout.write(`  wrapper:        ${wrapper} ${existsSync(wrapper) ? "(present)" : "(missing)"}\n`);
}

function install(args) {
  const { prefix, binDir, version } = defaults(args);
  process.stdout.write(`Installing ${PACKAGE}@${version}\n  prefix:  ${prefix}\n  bin dir: ${binDir}\n`);

  // Refuse a prefix whose shim dir is the real global bin: that would let npm
  // write an `opencode` shim there and overwrite v1.
  if (samePath(shimDir(prefix), npmGlobalBin()) && !args.force) {
    process.stderr.write(
      `\nRefusing: the isolated prefix (${prefix}) maps to the global bin (${npmGlobalBin()}).\n` +
        `Installing there would overwrite v1's \`opencode\`. Choose another --prefix (or pass --force).\n`,
    );
    return 2;
  }

  if (existsSync(prefix) && !args.force && findBinary(prefix)) {
    process.stdout.write(`Already installed at ${prefix} (use --force to reinstall).\n`);
    refreshWrappers(findBinary(prefix), binDir);
    reportEnvironments(prefix, binDir);
    return 0;
  }

  mkdirSync(prefix, { recursive: true });
  const npm = platform() === "win32" ? "npm.cmd" : "npm";
  // The package's postinstall selects the native binary; npm's allow-scripts
  // policy blocks it unless the package is explicitly allowed.
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
  reportEnvironments(prefix, binDir);
  return 0;
}

/** Reinstall/update v2 in place (same isolated prefix), then verify. */
function update(args) {
  return install({ ...args, force: true });
}

function refreshWrappers(binary, binDir) {
  const written = writeWrappers(binary, binDir);
  process.stdout.write(`\nopencode v2 ready:\n  binary:  ${binary}\n`);
  for (const w of written) process.stdout.write(`  wrapper: ${w}\n`);
  process.stdout.write(`\nRun it with:  opencode2 --version\nInside OAT:   oat opencode2\nRemove with:  npm run opencode2:uninstall\n`);
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
  reportEnvironments(prefix, binDir);
  return 0;
}

function status(args) {
  const { prefix, binDir, version } = defaults(args);
  const binary = existsSync(prefix) ? findBinary(prefix) : null;
  process.stdout.write(`package:  ${PACKAGE}@${version}\nprefix:   ${prefix}\nbin dir:  ${binDir}\n`);
  process.stdout.write(`binary:   ${binary ?? "(not installed)"}\n`);
  reportEnvironments(prefix, binDir);
  return binary ? 0 : 1;
}

function usage() {
  process.stdout.write(
    `Usage: node scripts/opencode2.mjs <install|update|uninstall|status> [options]\n\n` +
      `Installs opencode v2 (@opencode/cli) side by side with v1, without overwriting\n` +
      `v1's \`opencode\` command (v2 is exposed as \`opencode2\`).\n\n` +
      `Options:\n` +
      `  --prefix <dir>     Isolated install dir (default: <state-dir>/opencode2)\n` +
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
const commands = { install, update, uninstall, status };
const fn = commands[command];
if (!fn) {
  usage();
  process.exit(1);
}
process.exit(fn(args));
