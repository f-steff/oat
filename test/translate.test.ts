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
  translateV2Events,
  translateV2Message,
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
  assert.equal(mapV1PathToV2("/session/ses_1/message"), "/api/session/ses_1/message");
  assert.equal(mapV1PathToV2("/session/ses_1/message", "POST"), "/api/session/ses_1/prompt");
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
  assert.equal(mapV1PathToV2("/permission"), "/api/permission/request");
  assert.equal(mapV1PathToV2("/experimental/session"), "/api/session");
  assert.equal(mapV1PathToV2("/session/ses_1/children"), "/api/session");
  assert.equal(mapV1PathToV2("/project/current"), "/api/location");
  assert.equal(mapV1PathToV2("/experimental/worktree"), "/api/worktree");
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

test("translateRequest maps /session/:id/children to a parentID-filtered session list", () => {
  const req = translateRequest("GET", "/session/ses_1/children", "", undefined, null);
  assert.equal(req.path, "/api/session?parentID=ses_1");
});

test("translateV2Response maps v2 session reads to v1 shapes (fixtures)", () => {
  const list = translateV2Response("/session", fixture("session-list.json")) as Array<Record<string, unknown>>;
  assert.equal(list.length, 1);
  assert.equal(list[0]?.directory, "/");
  assert.equal(list[0]?.location, undefined);
  assert.equal(list[0]?.title, "fixture");
  // v1 `slug` is required and absent from v2; it mirrors the id.
  assert.equal(list[0]?.slug, list[0]?.id);

  const single = translateV2Response("/session/ses_x", fixture("session-create.json")) as Record<string, unknown>;
  assert.equal(single.directory, "/");
  assert.match(String(single.id), /^ses_/);

  // The global session list (`/experimental/session`) maps to the same shape.
  const globalList = translateV2Response("/experimental/session", fixture("session-list.json")) as Array<
    Record<string, unknown>
  >;
  assert.equal(globalList[0]?.directory, "/");
  assert.equal(globalList[0]?.slug, globalList[0]?.id);

  // `/session/:id/children` is the parentID-filtered list, same v1 shape.
  const children = translateV2Response("/session/ses_1/children", {
    location: {},
    data: [{ id: "ses_c", projectID: "p", parentID: "ses_1", time: { created: 1, updated: 2 }, location: { directory: "/" } }],
  }) as Array<Record<string, unknown>>;
  assert.equal(children.length, 1);
  assert.equal(children[0]?.slug, "ses_c");
  assert.equal(children[0]?.directory, "/");
});

test("translateV2Message drops messages with no v1 equivalent (idle/system)", () => {
  assert.equal(translateV2Message({ id: "m", type: "idle" }), null);
  assert.equal(translateV2Message({ id: "m", type: "system", text: "x" }), null);
});

test("translateV2Response maps v2 messages to v1 {info,parts} and drops idle (fixtures)", () => {
  const messages = translateV2Response(
    "/session/ses_x/message",
    fixture("session-messages.json"),
  ) as Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>;
  assert.equal(messages.length, 2); // user + assistant; idle marker dropped
  const [user, assistant] = messages;
  assert.equal(user?.info.role, "user");
  assert.equal(user?.parts[0]?.text, "Reply with exactly: OK");
  assert.equal(assistant?.info.role, "assistant");
  assert.equal(assistant?.info.parentID, user?.info.id);
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

test("translateV2Response maps v2 projects to v1 Project (worktree/name/sandboxes)", () => {
  const list = translateV2Response("/project", fixture("project.json")) as Array<Record<string, unknown>>;
  assert.equal(list.length, 1);
  assert.equal(list[0]?.worktree, "/");
  assert.equal(list[0]?.canonical, undefined);
  assert.equal(typeof list[0]?.name, "string");
  assert.deepEqual(list[0]?.sandboxes, []);

  // `/project/current` is served from the `/api/location` response.
  const current = translateV2Response("/project/current", fixture("location.json")) as Record<string, unknown>;
  assert.equal(current.worktree, "/");
  assert.equal(current.canonical, undefined);
});

test("translateV2Response maps v2 permission requests to v1 PermissionRequest", () => {
  const out = translateV2Response("/permission", {
    location: {},
    data: [{ id: "per_1", sessionID: "ses_1", action: "bash", resources: ["*"], save: ["bash"] }],
  }) as Array<Record<string, unknown>>;
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    id: "per_1",
    sessionID: "ses_1",
    permission: "bash",
    patterns: ["*"],
    metadata: {},
    always: ["bash"],
  });
});

test("translateV2Response gives commands `hints` and agents `permission`/`options` (fixtures)", () => {
  const commands = translateV2Response("/command", fixture("command.json")) as Array<Record<string, unknown>>;
  assert.equal(commands.length, 2);
  for (const command of commands) assert.deepEqual(command.hints, []);

  const agents = translateV2Response("/agent", fixture("agent.json")) as Array<Record<string, unknown>>;
  assert.ok(agents.length >= 1);
  const build = agents[0] ?? {};
  assert.deepEqual(build.options, {});
  assert.equal(build.permissions, undefined);
  assert.equal(build.request, undefined);
  const rules = build.permission as Array<Record<string, unknown>>;
  assert.deepEqual(rules[0], { permission: "*", pattern: "*", action: "allow" });
  assert.deepEqual(rules[2], { permission: "read", pattern: "*.env", action: "ask" });
});

/** Parse the captured `/api/event` stream into raw v2 event objects. */
function fixtureEvents(): unknown[] {
  const text = fs.readFileSync(path.join("test", "fixtures", "v2", "events.txt"), "utf8");
  const out: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      out.push(JSON.parse(line.slice(5).trim()));
    } catch {
      // ignore heartbeats/partials
    }
  }
  return out;
}

test("translateV2Events maps the captured v2 stream to v1 event types", () => {
  const types = new Set<string>();
  let userParts = 0;
  const assistantKeys = ["id", "sessionID", "role", "time", "parentID", "modelID", "providerID", "mode", "agent", "path", "cost", "tokens"];
  for (const raw of fixtureEvents()) {
    for (const event of translateV2Events(raw)) {
      types.add(event.type);
      if (event.type === "message.updated") {
        const info = event.properties.info as Record<string, unknown> | undefined;
        if (info?.role === "assistant") {
          for (const key of assistantKeys) assert.ok(key in info, `assistant info.${key}`);
        } else if (info?.role === "user") {
          assert.ok("agent" in info, "user info.agent");
          assert.ok("model" in info, "user info.model");
        }
      }
      if (event.type === "session.updated") {
        const info = event.properties.info as Record<string, unknown> | undefined;
        for (const key of ["id", "slug", "projectID", "directory", "time"]) {
          assert.ok(info && key in info, `session.updated info.${key}`);
        }
      }
      if (event.type === "message.part.updated") {
        const part = event.properties.part as { type?: string; time?: unknown } | undefined;
        if (part?.type === "text") userParts += 1;
        // The bridge's ReasoningPart model requires a {start, end} range.
        if (part?.type === "reasoning") assert.ok(part.time, "reasoning part time");
      }
    }
  }
  assert.ok(types.has("server.connected"), "server.connected");
  assert.ok(types.has("session.updated"), "session.created -> session.updated");
  assert.ok(types.has("message.updated"), "inbox/step -> message.updated");
  assert.ok(types.has("message.part.updated"), "text/reasoning -> message.part.updated");
  assert.ok(types.has("session.idle"), "execution.succeeded -> session.idle");
  assert.ok(userParts >= 1, "user prompt part emitted");
});

test("the synthesized reserve matches the mapped v2 user message shape", () => {
  const synth = synthesizeReservedMessage(
    "ses_1",
    { messageID: "msg_1", parts: [{ type: "text", text: "hi" }] },
    1,
  ) as { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };
  const mapped = translateV2Message({ id: "msg_1", time: { created: 1 }, type: "user", text: "hi" }, "ses_1") as {
    info: Record<string, unknown>;
    parts: Array<Record<string, unknown>>;
  };
  assert.deepEqual(Object.keys(synth.info).sort(), Object.keys(mapped.info).sort());
  assert.deepEqual(Object.keys(synth.parts[0] ?? {}).sort(), Object.keys(mapped.parts[0] ?? {}).sort());
  assert.equal(synth.parts[0]?.type, mapped.parts[0]?.type);
});
