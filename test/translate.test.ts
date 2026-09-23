import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  isReserve,
  mapV1PathToV2,
  synthesizeReservedMessage,
  translatePromptBody,
  translateRequest,
  translateV2Response,
  unwrapV2Response,
} from "../src/translate.js";

/** Read a captured opencode v2 fixture (see research/capture-v2.sh). */
function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join("test", "fixtures", "v2", name), "utf8"));
}

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

test("translateV2Response maps v2 session reads to v1 shapes (fixtures)", () => {
  const list = translateV2Response("/session", fixture("session-list.json")) as Array<Record<string, unknown>>;
  assert.equal(list.length, 1);
  assert.equal(list[0]?.directory, "/");
  assert.equal(list[0]?.location, undefined);
  assert.equal(list[0]?.title, "fixture");

  const single = translateV2Response("/session/ses_x", fixture("session-create.json")) as Record<string, unknown>;
  assert.equal(single.directory, "/");
  assert.match(String(single.id), /^ses_/);
});

test("translateV2Response maps v2 messages to v1 {info,parts} and drops idle (fixtures)", () => {
  const messages = translateV2Response(
    "/session/ses_x/message",
    fixture("session-messages.json"),
  ) as Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>;
  assert.equal(messages.length, 2); // user + assistant; idle marker dropped
  const [assistant, user] = messages;
  assert.equal(user?.info.role, "user");
  assert.equal(user?.parts[0]?.text, "Reply with exactly: OK");
  assert.equal(assistant?.info.role, "assistant");
  const texts = assistant?.parts.filter((p) => p.type === "text").map((p) => p.text);
  assert.deepEqual(texts, ["OK"]);
});

test("translateV2Response maps v2 providers to v1 /provider and /config/providers (fixtures)", () => {
  const provider = translateV2Response("/provider", fixture("provider.json")) as Record<string, unknown>;
  assert.equal(Array.isArray(provider.all), true);
  assert.deepEqual(provider.connected, ["opencode"]);

  const config = translateV2Response("/config/providers", fixture("provider.json")) as Record<string, unknown>;
  assert.equal(Array.isArray(config.providers), true);
  assert.deepEqual(config.default, {});
});
