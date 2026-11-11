import assert from "node:assert/strict";
import { test } from "node:test";

import { detectOpencodeGeneration, resolveGeneration } from "../src/generation.js";

test("resolveGeneration honours an explicit setting", () => {
  assert.equal(resolveGeneration("v1", "opencode"), "v1");
  assert.equal(resolveGeneration("v2", "opencode"), "v2");
});

test("detectOpencodeGeneration defaults to v1 for an unresolvable binary", () => {
  assert.equal(detectOpencodeGeneration("definitely-not-a-real-binary-xyz"), "v1");
});
