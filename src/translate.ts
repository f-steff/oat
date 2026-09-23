/**
 * Minimal, toggleable v1 <-> v2 translation for the bridge.
 *
 * The Sesori bridge speaks opencode's v1 HTTP surface; an opencode v2 backend
 * speaks `/api/*` with HTTP Basic auth. When `OAT_TRANSLATE_V2` is on, OAT maps
 * the v1 requests the bridge makes onto their v2 equivalents and unwraps v2
 * responses back into v1 shapes. This is a stopgap so a v1 client can drive a v2
 * backend; it is intentionally partial and can be disabled once the bridge
 * speaks v2 natively.
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
 * known mapping (the caller then forwards the path unchanged).
 */
export function mapV1PathToV2(pathname: string): string | null {
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
    case "/path":
      return "/api/location";
    case "/provider":
    case "/config/providers":
      return "/api/provider";
    case "/command":
      return "/api/command";
    case "/agent":
      return "/api/agent";
    default:
      break;
  }
  // Session sub-resources (a prompt/command/shell/abort against a session).
  const message = SESSION_MESSAGE.exec(pathname);
  if (message) return `/api/session/${message[1]}/prompt`;
  const sub = SESSION_SUBRESOURCE.exec(pathname);
  if (sub) {
    const verb = sub[2] === "abort" ? "interrupt" : sub[2] === "summarize" ? "compact" : sub[2];
    return `/api/session/${sub[1]}/${verb}`;
  }
  if (SESSION.test(pathname)) return `/api${pathname}`;
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

/**
 * Build a v1-shaped "reserved user message" response locally, so a v2 backend
 * never has to admit a duplicate user message for the bridge's reserve step.
 */
export function synthesizeReservedMessage(sessionId: string, body: unknown, now = Date.now()): unknown {
  const record = asRecord(body);
  const id = typeof record?.messageID === "string" ? record.messageID : `msg_oat_${now}`;
  const parts = Array.isArray(record?.parts) ? record.parts : [];
  return {
    info: {
      id,
      sessionID: sessionId,
      role: "user",
      time: { created: now },
    },
    parts: parts.map((part, index) => {
      const p = asRecord(part) ?? {};
      return { id: `prt_oat_${now}_${index}`, messageID: id, sessionID: sessionId, ...p };
    }),
  };
}

/** Translate a downstream v1 request into the upstream request for a v2 backend. */
export function translateRequest(
  method: string,
  pathname: string,
  search: string,
  body: unknown,
  directory: string | null,
): TranslatedRequest {
  const mapped = mapV1PathToV2(pathname) ?? pathname;
  // `x-opencode-directory` has no v2 header; pass it as the `directory` query.
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (directory && !params.has("directory")) params.set("directory", directory);
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
