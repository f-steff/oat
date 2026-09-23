import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isReserve,
  mapV1PathToV2,
  synthesizeReservedMessage,
  translatePromptBody,
  translateRequest,
  unwrapV2Response,
} from "../src/translate.js";

test("mapV1PathToV2 maps the bridge's core routes", () => {
  assert.equal(mapV1PathToV2("/session"), "/api/session");
  assert.equal(mapV1PathToV2("/session/ses_1"), "/api/session/ses_1");
  assert.equal(mapV1PathToV2("/session/ses_1/message"), "/api/session/ses_1/prompt");
  assert.equal(mapV1PathToV2("/session/ses_1/prompt_async"), "/api/session/ses_1/prompt");
  assert.equal(mapV1PathToV2("/session/ses_1/command"), "/api/session/ses_1/command");
  assert.equal(mapV1PathToV2("/session/ses_1/shell"), "/api/session/ses_1/shell");
  assert.equal(mapV1PathToV2("/session/ses_1/abort"), "/api/session/ses_1/interrupt");
  assert.equal(mapV1PathToV2("/session/ses_1/summarize"), "/api/session/ses_1/compact");
  assert.equal(mapV1PathToV2("/session/status"), "/api/session/active");
  assert.equal(mapV1PathToV2("/project"), "/api/project");
  assert.equal(mapV1PathToV2("/path"), "/api/location");
  assert.equal(mapV1PathToV2("/provider"), "/api/provider");
  assert.equal(mapV1PathToV2("/agent"), "/api/agent");
  assert.equal(mapV1PathToV2("/command"), "/api/command");
  // Unknown routes have no mapping.
  assert.equal(mapV1PathToV2("/global/event"), null);
});

test("isReserve detects a noReply reserve body", () => {
  assert.equal(isReserve({ noReply: true }), true);
  assert.equal(isReserve({ noReply: false }), false);
  assert.equal(isReserve({}), false);
  assert.equal(isReserve(undefined), false);
});

test("translatePromptBody converts parts and ids and drops noReply", () => {
  const out = translatePromptBody({
    messageID: "msg_1",
    noReply: true,
    agent: "build",
    parts: [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
      { type: "file", url: "file://x", mime: "text/plain" },
    ],
  }) as Record<string, unknown>;
  assert.equal(out.id, "msg_1");
  assert.equal(out.messageID, undefined);
  assert.equal(out.noReply, undefined);
  assert.equal(out.text, "hello\nworld");
  assert.equal(out.agent, "build");
  assert.deepEqual(out.files, [{ type: "file", url: "file://x", mime: "text/plain" }]);
  assert.equal(out.parts, undefined);
});

test("unwrapV2Response unwraps a data envelope and leaves plain bodies alone", () => {
  assert.deepEqual(unwrapV2Response({ data: { id: "x" }, location: {} }), { id: "x" });
  assert.deepEqual(unwrapV2Response({ id: "x" }), { id: "x" });
  assert.deepEqual(unwrapV2Response([{ id: "x" }]), [{ id: "x" }]);
});

test("synthesizeReservedMessage returns a v1-shaped user message", () => {
  const out = synthesizeReservedMessage("ses_1", {
    messageID: "msg_1",
    parts: [{ type: "text", text: "hi" }],
  }, 123) as { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };
  assert.equal(out.info.id, "msg_1");
  assert.equal(out.info.sessionID, "ses_1");
  assert.equal(out.info.role, "user");
  assert.equal(out.parts[0]?.text, "hi");
  assert.equal(out.parts[0]?.messageID, "msg_1");
});

test("translateRequest maps the path, adds the directory query, and reshapes the body", () => {
  const req = translateRequest(
    "POST",
    "/session/ses_1/prompt_async",
    "",
    { messageID: "msg_1", parts: [{ type: "text", text: "hi" }] },
    "C:\\work\\proj",
  );
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/session/ses_1/prompt?directory=C%3A%5Cwork%5Cproj");
  assert.deepEqual(JSON.parse(req.body ?? "{}"), { id: "msg_1", text: "hi" });
});

test("translateRequest passes non-prompt bodies through and keeps existing query", () => {
  const req = translateRequest("GET", "/session", "?limit=5", undefined, null);
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/session?limit=5");
  assert.equal(req.body, undefined);
});
