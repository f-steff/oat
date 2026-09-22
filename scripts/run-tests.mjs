import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Node's test runner only gained glob support in v21, so passing a glob is not
// portable to Node 20. Enumerate the compiled tests and pass explicit paths,
// which every supported version accepts.
const dir = "dist-test/test";
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".test.js"))
  .map((name) => `${dir}/${name}`);

if (files.length === 0) {
  console.error(`no test files found in ${dir}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
