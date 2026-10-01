/**
 * Minimal, toggleable v1 <-> v2 translation for the bridge.
 *
 * The Sesori bridge speaks opencode's v1 HTTP surface; an opencode v2 backend
 * speaks `/api/*` with HTTP Basic auth. When `OAT_TRANSLATE_V2_TO_V1_BRIDGE` is
 * on, OAT maps the v1 requests the bridge makes onto their v2 equivalents and
 * reshapes v2 responses back into the v1 models the bridge decodes. This is a
 * stopgap so a v1 client can drive a v2 backend; it is intentionally partial and
 * is skipped entirely for `/api/*` clients (a v2-native bridge speaks v2
 * directly).
 */

/** A translated upstream request. */
export interface TranslatedRequest {
  /** HTTP method to use upstream. */
  method: string;
  /** Upstream path (including any query string). */
  path: string;
  /** Upstream body as a JSON string, when the request has one. */
  body?: string;
}

/** Narrow an unknown JSON value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const SESSION_MESSAGE = /^\/session\/([^/]+)\/(message|prompt_async)$/;
const SESSION_SUBRESOURCE = /^\/session\/([^/]+)\/(command|shell|abort|summarize|init|revert|unrevert|fork|share)$/;
const SESSION = /^\/session\/([^/]+)$/;

/**
 * Map a v1 path to its v2 `/api/...` equivalent, or `null` when there is no
 * known mapping (the caller then forwards the path unchanged). `method`
 * disambiguates the few paths whose meaning is verb-dependent (v1 reads and
 * writes a session's messages on the same `/session/:id/message` path).
 */
export function mapV1PathToV2(pathname: string, method = "GET"): string | null {
  // Fixed top-level resources.
  switch (pathname) {
    case "/session":
      return "/api/session";
    case "/session/status":
      return "/api/session/active";
    case "/session/active":
      return "/api/session/active";
    case "/project":
      return "/api/project";
    // The bridge reads the current project from `/project/current`; v2 exposes
    // it (wrapped in the location) from `/api/location`.
    case "/project/current":
      return "/api/location";
    case "/path":
      return "/api/location";
    // v1 lists every root session from `/experimental/session`; v2 has no such
    // route, but `/api/session` is the same collection.
    case "/experimental/session":
      return "/api/session";
    case "/experimental/worktree":
      return "/api/worktree";
    case "/provider":
    case "/config/providers":
      return "/api/provider";
    case "/command":
      return "/api/command";
    case "/agent":
      return "/api/agent";
    // v1's pending-permission list; v2 exposes the same as `/api/permission/request`.
    case "/permission":
      return "/api/permission/request";
    default:
      break;
  }
  // Session sub-resources (a prompt/command/shell/abort against a session).
  const message = SESSION_MESSAGE.exec(pathname);
  if (message) {
    // `GET /session/:id/message` lists messages; `POST` sends a prompt.
    if (message[2] === "message" && (method === "GET" || method === "HEAD")) {
      return `/api/session/${message[1]}/message`;
    }
    return `/api/session/${message[1]}/prompt`;
  }
  const sub = SESSION_SUBRESOURCE.exec(pathname);
  if (sub) {
    const verb = sub[2] === "abort" ? "interrupt" : sub[2] === "summarize" ? "compact" : sub[2];
    return `/api/session/${sub[1]}/${verb}`;
  }
  if (SESSION.test(pathname)) return `/api${pathname}`;
  // v1 children (subagent sessions) -> the v2 session list filtered by parentID.
  if (/^\/session\/[^/]+\/children$/.test(pathname)) return "/api/session";
  // A single message (and its parts) keeps its shape under `/api`.
  if (/^\/session\/[^/]+\/message\//.test(pathname)) return `/api${pathname}`;
  // Experimental routes keep their name under `/api`.
  if (pathname.startsWith("/experimental/")) return `/api${pathname}`;
  return null;
}

/** True when a v1 request is a "reserve" (a user message admitted without a reply). */
export function isReserve(body: unknown): boolean {
  const record = asRecord(body);
  return record?.noReply === true;
}

/**
 * Convert a v1 prompt body (`parts`, `messageID`) to a v2 prompt body
 * (`text`, `files`, `id`). v1-only fields (`noReply`) are dropped.
 */
export function translatePromptBody(body: unknown): unknown {
  const record = asRecord(body);
  if (!record) return body;
  const out: Record<string, unknown> = { ...record };
  if (out.id === undefined && typeof record.messageID === "string") out.id = record.messageID;
  delete out.messageID;
  delete out.noReply;
  const parts = Array.isArray(record.parts) ? record.parts : null;
  if (parts) {
    const texts: string[] = [];
    const files: unknown[] = [];
    for (const part of parts) {
      const p = asRecord(part);
      if (!p) continue;
      if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
      else if (p.type === "file") files.push(p);
    }
    if (out.text === undefined) out.text = texts.join("\n");
    if (files.length > 0 && out.files === undefined) out.files = files;
    delete out.parts;
  }
  return out;
}

/** Unwrap a v2 response into a v1 shape: `{ data }` -> `data`, else unchanged. */
export function unwrapV2Response(body: unknown): unknown {
  const record = asRecord(body);
  if (record && "data" in record) return record.data;
  return body;
}

const SESSION_ID_PATH = /^\/session\/([^/]+)(?:\/|$)/;

/** Extract a session id from a v1 path (ignoring `/session/status`). */
function sessionIdOf(pathname: string): string | undefined {
  const match = SESSION_ID_PATH.exec(pathname);
  const id = match?.[1];
  return id && id !== "status" ? id : undefined;
}

/**
 * v2 `Session.Info` -> v1 `Session`: the directory lives under `location` in v2
 * but is a top-level `directory` in v1.
 */
export function translateV2Session(value: unknown): unknown {
  const session = asRecord(value);
  if (!session) return value;
  const location = asRecord(session.location);
  const out: Record<string, unknown> = { ...session };
  delete out.location;
  if (typeof location?.directory === "string") out.directory = location.directory;
  // v1 `Session.slug` is required (non-null); v2 drops it, so mirror the id.
  if (typeof out.slug !== "string" && typeof out.id === "string") out.slug = out.id;
  return out;
}

/** The trailing path segment, for a POSIX or Windows path. */
function baseName(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || value;
}

/**
 * v2 `Project` -> v1 `Project`: v2 calls the root `canonical` where v1 expects
 * `worktree`. v1 also requires a non-null `sandboxes` list and a `name`.
 */
export function translateV2Project(value: unknown): unknown {
  const project = asRecord(value);
  if (!project) return value;
  const out: Record<string, unknown> = { ...project };
  const worktree =
    typeof project.worktree === "string"
      ? project.worktree
      : typeof project.canonical === "string"
        ? project.canonical
        : undefined;
  delete out.canonical;
  if (worktree !== undefined) {
    out.worktree = worktree;
    if (out.name === undefined || out.name === null) out.name = baseName(worktree);
  }
  if (!Array.isArray(out.sandboxes)) out.sandboxes = [];
  return out;
}

/**
 * v2 `Command` -> v1 `Command`: v1 requires a non-null `hints` string list that
 * v2 omits.
 */
export function translateV2Command(value: unknown): unknown {
  const command = asRecord(value);
  if (!command) return value;
  const out: Record<string, unknown> = { ...command };
  if (!Array.isArray(out.hints)) out.hints = [];
  return out;
}

/**
 * v2 `Permission.Request` -> v1 `PermissionRequest`: v2 names the permission
 * `action` with `resources`/`save` lists, where v1 expects `permission`,
 * `patterns` and `always` (all required, non-null).
 */
export function translateV2PermissionRequest(value: unknown): unknown {
  const request = asRecord(value);
  if (!request) return value;
  return {
    id: request.id,
    sessionID: request.sessionID,
    permission: request.permission ?? request.action ?? "*",
    patterns: Array.isArray(request.patterns) ? request.patterns : Array.isArray(request.resources) ? request.resources : [],
    metadata: asRecord(request.metadata) ?? {},
    always: Array.isArray(request.always) ? request.always : Array.isArray(request.save) ? request.save : [],
  };
}

/**
 * v2 `Agent` -> v1 `Agent`: v2 sends `permissions` as `{action, resource,
 * effect}` where v1 expects `permission` as `{permission, pattern, action}`, and
 * v1 requires non-null `options`. `system` maps to the v1 `prompt`.
 */
export function translateV2Agent(value: unknown): unknown {
  const agent = asRecord(value);
  if (!agent) return value;
  const out: Record<string, unknown> = { ...agent };
  const permissions = Array.isArray(agent.permissions) ? agent.permissions : [];
  out.permission = permissions.map((entry) => {
    const rule = asRecord(entry) ?? {};
    return {
      permission: rule.permission ?? rule.action ?? "*",
      pattern: rule.pattern ?? rule.resource ?? "*",
      action: rule.effect ?? "allow",
    };
  });
  if (!asRecord(out.options)) out.options = {};
  if (out.prompt === undefined && typeof agent.system === "string") out.prompt = agent.system;
  delete out.permissions;
  delete out.system;
  delete out.request;
  return out;
}

/**
 * v2 message (`user` / `assistant` with a `content[]` array) -> v1 `{ info, parts }`.
 * v2 messages are minimal, so v1-required fields the bridge's models cast
 * non-null (`agent`/`model` on users; `parentID`/`modelID`/`providerID`/`mode`/
 * `path`/`cost`/`tokens` on assistants; `time` on reasoning parts) are filled in.
 * Types with no v1 equivalent (the `idle` marker and v2's `system` turns) map to
 * `null` and are dropped from the list.
 */
export function translateV2Message(
  value: unknown,
  sessionID?: string,
  parentID?: string,
  directory?: string | null,
): unknown {
  const message = asRecord(value);
  if (!message) return null;
  const id = String(message.id ?? "");
  const time = asRecord(message.time) ?? {};
  const type = message.type;
  const cwd = typeof directory === "string" ? directory : "";
  if (type !== "user" && type !== "assistant") return null;
  if (type === "user") {
    const agents = Array.isArray(message.agents) ? message.agents : [];
    const agent = typeof agents[0] === "string" ? agents[0] : "build";
    return {
      info: {
        id,
        sessionID,
        role: "user",
        time: { created: time.created },
        agent,
        model: { providerID: "opencode", modelID: "unknown" },
      },
      parts: [{ id: `${id}_text`, messageID: id, sessionID, type: "text", text: message.text ?? "" }],
    };
  }
  if (type === "assistant") {
    const model = asRecord(message.model) ?? {};
    const content = Array.isArray(message.content) ? message.content : [];
    const parts = content.map((entry, index) => {
      const part = asRecord(entry) ?? {};
      const kind = part.type === "reasoning" ? "reasoning" : "text";
      const base = { id: `${id}_${index}`, messageID: id, sessionID, type: kind, text: part.text ?? "" };
      // v1 `ReasoningPart` requires a `{start, end}` range; text parts do not.
      if (kind === "reasoning") {
        const span = asRecord(part.time) ?? {};
        return { ...base, time: { start: span.created ?? time.created, end: span.completed ?? time.completed } };
      }
      return base;
    });
    const tokens = asRecord(message.tokens) ?? {};
    return {
      info: {
        id,
        sessionID,
        role: "assistant",
        time: { created: time.created, completed: time.completed },
        parentID: parentID ?? "",
        modelID: typeof model.id === "string" ? model.id : "",
        providerID: typeof model.providerID === "string" ? model.providerID : "",
        mode: "build",
        agent: typeof message.agent === "string" ? message.agent : "build",
        path: { cwd, root: cwd },
        cost: typeof message.cost === "number" ? message.cost : 0,
        tokens,
        variant: model.variant,
        finish: message.finish,
      },
      parts,
    };
  }
  return null;
}

/**
 * Translate an unwrapped v2 response body into the v1 shape expected for
 * `v1Path`. Unknown paths fall back to the plain `{ data }` unwrap.
 */
export function translateV2Response(v1Path: string, body: unknown, directory?: string | null): unknown {
  const unwrapped = unwrapV2Response(body);
  // v2 `/api/provider` -> v1 `/provider` ({all, default, connected}).
  if (v1Path === "/provider" || v1Path === "/config/providers") {
    const list = Array.isArray(unwrapped) ? unwrapped : [];
    if (v1Path === "/config/providers") return { providers: list, default: {} };
    const connected = list
      .map((entry) => asRecord(entry))
      .filter((entry) => entry?.activation === "enabled")
      .map((entry) => entry?.id);
    return { all: list, default: {}, connected };
  }
  // Session lists and single sessions: lift `location.directory` to `directory`.
  // `/experimental/session` is v1's global session list (mapped to `/api/session`)
  // and `/session/:id/children` is the parentID-filtered list.
  const sessionList =
    v1Path === "/session" ||
    v1Path === "/experimental/session" ||
    /^\/session\/[^/]+\/children$/.test(v1Path);
  if (sessionList && Array.isArray(unwrapped)) return unwrapped.map(translateV2Session);
  if (sessionList && asRecord(unwrapped)) return translateV2Session(unwrapped);
  if (/^\/session\/[^/]+$/.test(v1Path) && asRecord(unwrapped)) return translateV2Session(unwrapped);
  // v2 project lists are bare arrays; `/project/current` reads the project out
  // of the `/api/location` response.
  if (v1Path === "/project" && Array.isArray(unwrapped)) return unwrapped.map(translateV2Project);
  if (v1Path === "/project/current") {
    const project = asRecord(asRecord(unwrapped)?.project);
    return project ? translateV2Project(project) : unwrapped;
  }
  // Commands and agents need their v1-required fields synthesized.
  if (v1Path === "/command" && Array.isArray(unwrapped)) return unwrapped.map(translateV2Command);
  if (v1Path === "/agent" && Array.isArray(unwrapped)) return unwrapped.map(translateV2Agent);
  if (v1Path === "/permission" && Array.isArray(unwrapped)) return unwrapped.map(translateV2PermissionRequest);
  // Message lists: v2 returns newest-first and v1 expects oldest-first, so order
  // by creation time while reshaping to `{ info, parts }[]`, linking each
  // assistant to the user before it and dropping the `idle` marker.
  if (/^\/session\/[^/]+\/message$/.test(v1Path) && Array.isArray(unwrapped)) {
    const sessionID = sessionIdOf(v1Path);
    const created = (value: unknown): number => {
      const at = asRecord(asRecord(value)?.time)?.created;
      return typeof at === "number" ? at : 0;
    };
    const ordered = [...unwrapped].sort((a, b) => created(a) - created(b));
    const out: unknown[] = [];
    let lastUserId = "";
    for (const message of ordered) {
      const record = asRecord(message);
      if (record?.type === "user" && typeof record.id === "string") lastUserId = record.id;
      const mapped = translateV2Message(message, sessionID, lastUserId, directory);
      if (mapped !== null) out.push(mapped);
    }
    return out;
  }
  if (/^\/session\/[^/]+\/message\/[^/]+$/.test(v1Path) && asRecord(unwrapped)) {
    return translateV2Message(unwrapped, sessionIdOf(v1Path), undefined, directory) ?? unwrapped;
  }
  return unwrapped;
}

/**
 * Build a v1-shaped "reserved user message" response locally, so a v2 backend
 * never has to admit a duplicate user message for the bridge's reserve step.
 */
export function synthesizeReservedMessage(sessionId: string, body: unknown, now = Date.now()): unknown {
  const record = asRecord(body);
  const id = typeof record?.messageID === "string" ? record.messageID : `msg_oat_${now}`;
  const parts = Array.isArray(record?.parts) ? record.parts : [];
  const agent = typeof record?.agent === "string" ? record.agent : "build";
  return {
    info: {
      id,
      sessionID: sessionId,
      role: "user",
      time: { created: now },
      agent,
      model: { providerID: "opencode", modelID: "unknown" },
    },
    parts: parts.map((part, index) => {
      const p = asRecord(part) ?? {};
      return { id: `prt_oat_${now}_${index}`, messageID: id, sessionID: sessionId, ...p };
    }),
  };
}

/** A v1-style SSE payload, as the bridge expects (`type` + `properties`). */
export interface V1Event {
  type: string;
  properties: Record<string, unknown>;
}

/** Per-assistant metadata remembered from `session.step.started` (model/agent). */
interface AssistantMeta {
  agent: string;
  modelID: string;
  providerID: string;
  variant?: string;
}
const assistantMetaByMessage = new Map<string, AssistantMeta>();
/** Last user message id per session, so streamed assistant messages can link to it. */
const lastUserMessageBySession = new Map<string, string>();

/** Coerce an unknown value to a string ("" when not a string). */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The directory carried by a v2 event's `location`, or "". */
function eventDir(event: Record<string, unknown>): string {
  const location = asRecord(event.location);
  return typeof location?.directory === "string" ? location.directory : "";
}

/** A v1 `tokens` map with the non-null fields the bridge's model requires. */
function tokensOr(value: unknown): Record<string, unknown> {
  const tokens = asRecord(value);
  if (tokens && tokens.cache) return tokens;
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}

/** Build a complete v1 `assistant` message for `message.updated` (SSE). */
function assistantMessageUpdated(
  sessionID: unknown,
  messageID: string,
  created: number,
  directory: string,
  data: Record<string, unknown>,
): V1Event {
  const meta = assistantMetaByMessage.get(messageID);
  const parentID = typeof sessionID === "string" ? lastUserMessageBySession.get(sessionID) ?? "" : "";
  return {
    type: "message.updated",
    properties: {
      sessionID,
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        time: { created, completed: created },
        parentID,
        modelID: meta?.modelID ?? "",
        providerID: meta?.providerID ?? "",
        mode: "build",
        agent: meta?.agent ?? "build",
        path: { cwd: directory, root: directory },
        cost: typeof data.cost === "number" ? data.cost : 0,
        tokens: tokensOr(data.tokens),
        ...(meta?.variant ? { variant: meta.variant } : {}),
        finish: data.finish,
      },
    },
  };
}

/** Build a v1 `message.part.updated` payload for a streamed text/reasoning part. */
function partUpdated(
  sessionID: unknown,
  messageID: string,
  kind: "text" | "reasoning",
  text: unknown,
  ordinal: unknown,
  created: number,
): V1Event {
  const index = typeof ordinal === "number" ? ordinal : 0;
  const part: Record<string, unknown> = {
    id: `${messageID}_${kind}_${index}`,
    messageID,
    sessionID,
    type: kind,
    text: typeof text === "string" ? text : "",
  };
  // v1 `ReasoningPart` requires a `{start, end}` range; `TextPart` does not.
  if (kind === "reasoning") part.time = { start: created, end: created };
  return { type: "message.part.updated", properties: { sessionID, part } };
}

/**
 * Translate one opencode v2 `/api/event` payload into a v1 `{type, properties}`
 * event, or `null` when it has no v1 equivalent (e.g. heartbeats/instructions).
 *
 * This is best-effort: it covers the session lifecycle and streaming parts the
 * bridge renders. Unknown v2 event types are dropped.
 */
export function translateV2Event(raw: unknown): V1Event | null {
  const event = asRecord(raw);
  if (!event) return null;
  const type = typeof event.type === "string" ? event.type : "";
  const data = asRecord(event.data) ?? {};
  const sessionID = data.sessionID;
  const messageID = typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined;
  const created = typeof event.created === "number" ? event.created : 0;
  const directory = eventDir(event);

  switch (type) {
    case "server.connected":
      return { type: "server.connected", properties: {} };
    case "session.created":
    case "session.updated": {
      // The bridge decodes this into a full v1 `Session`, so provide every
      // non-null field its model casts.
      const location = asRecord(data.location);
      return {
        type: "session.updated",
        properties: {
          sessionID,
          info: {
            id: sessionID,
            slug: typeof data.slug === "string" ? data.slug : str(sessionID),
            projectID: typeof data.projectID === "string" ? data.projectID : "",
            directory: typeof location?.directory === "string" ? location.directory : "",
            title: data.title,
            time: { created, updated: created },
          },
        },
      };
    }
    case "session.inbox.enqueued":
    case "session.inbox.delivered": {
      const id = typeof data.inboxID === "string" ? data.inboxID : undefined;
      if (!id) return null;
      if (typeof sessionID === "string") lastUserMessageBySession.set(sessionID, id);
      const agents = Array.isArray(data.agents) ? data.agents : [];
      const agent = typeof agents[0] === "string" ? (agents[0] as string) : "build";
      return {
        type: "message.updated",
        properties: {
          sessionID,
          info: {
            id,
            sessionID,
            role: "user",
            time: { created },
            agent,
            model: { providerID: "unknown", modelID: "unknown" },
          },
        },
      };
    }
    case "session.step.started": {
      if (!messageID) return null;
      const model = asRecord(data.model) ?? {};
      assistantMetaByMessage.set(messageID, {
        agent: str(data.agent) || "build",
        modelID: str(model.id),
        providerID: str(model.providerID),
        ...(typeof model.variant === "string" ? { variant: model.variant } : {}),
      });
      return assistantMessageUpdated(sessionID, messageID, created, directory, data);
    }
    case "session.text.started":
    case "session.text.delta":
    case "session.text.ended":
      if (!messageID) return null;
      return partUpdated(sessionID, messageID, "text", data.delta ?? data.text, data.ordinal, created);
    case "session.reasoning.started":
    case "session.reasoning.delta":
    case "session.reasoning.ended":
      if (!messageID) return null;
      return partUpdated(sessionID, messageID, "reasoning", data.delta ?? data.text, data.ordinal, created);
    case "session.step.ended":
      if (!messageID) return null;
      return assistantMessageUpdated(sessionID, messageID, created, directory, data);
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.ended":
      return { type: "session.idle", properties: { sessionID } };
    default:
      return null;
  }
}

/** Extra v1 events a v2 event expands into (e.g. the part for a user inbox item). */
export function translateV2EventParts(raw: unknown): V1Event[] {
  const event = asRecord(raw);
  const data = asRecord(event?.data) ?? {};
  if (event?.type === "session.inbox.enqueued" || event?.type === "session.inbox.delivered") {
    const id = typeof data.inboxID === "string" ? data.inboxID : undefined;
    if (!id) return [];
    const payload = asRecord(asRecord(data.item)?.payload);
    const text = typeof payload?.text === "string" ? payload.text : "";
    return [partUpdated(data.sessionID, id, "text", text, 0, typeof event?.created === "number" ? event.created : 0)];
  }
  return [];
}

/** All v1 events a single v2 event expands into (the main event plus any parts). */
export function translateV2Events(raw: unknown): V1Event[] {
  const main = translateV2Event(raw);
  return [...(main ? [main] : []), ...translateV2EventParts(raw)];
}

/** Translate a downstream v1 request into the upstream request for a v2 backend. */
export function translateRequest(
  method: string,
  pathname: string,
  search: string,
  body: unknown,
  directory: string | null,
): TranslatedRequest {
  const mapped = mapV1PathToV2(pathname, method) ?? pathname;
  // `x-opencode-directory` has no v2 header; pass it as the `directory` query.
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (directory && !params.has("directory")) params.set("directory", directory);
  // v1 `/session/:id/children` becomes the v2 list filtered by parentID.
  const childId = /^\/session\/([^/]+)\/children$/.exec(pathname)?.[1];
  if (childId && !params.has("parentID")) params.set("parentID", childId);
  const query = params.toString();
  const path = query ? `${mapped}?${query}` : mapped;
  // Prompt-ish bodies are reshaped; everything else passes through.
  const isPrompt = SESSION_MESSAGE.test(pathname) || pathname === "/session";
  const translated = isPrompt && body !== undefined ? translatePromptBody(body) : body;
  return {
    method,
    path,
    ...(translated !== undefined ? { body: JSON.stringify(translated) } : {}),
  };
}
