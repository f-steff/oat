import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

import { log } from "./logger.js";
import type { Registry } from "./registry.js";
import { pickBackend } from "./router.js";
import { basicAuth } from "./discovery/discover.js";
import { isReserve, synthesizeReservedMessage, translateRequest, translateV2Events, translateV2Response } from "./translate.js";
import { formatSseEvent, getData, splitSseEvents, SseMerger, type SseEvent } from "./sse.js";
import type { Backend, OatConfig } from "./types.js";

/** OAT's own semantic version, reported by `/global/health` and the control API. */
export const OAT_VERSION = "0.1.0";
/** Reserved URL prefix for the local control API. */
export const OAT_CONTROL_PREFIX = "/__oat";

/** Headers that must not be forwarded verbatim to/from an upstream backend. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

/** Control API operations the CLI can invoke on a running daemon. */
export interface ControlHandlers {
  /** Return daemon status (pid, port, backend count, ...). */
  status(): unknown;
  /** Return the discovered backends. */
  list(): unknown;
  /** Ask the daemon to stop (used by `oat stop`). */
  stop(): Promise<void>;
  /** Ask the daemon to re-scan for backends. */
  reload(): Promise<void>;
}

/** The subset of the backend supervisor the mux server needs. */
export interface SupervisorLike {
  /** Return a backend for a directory, starting one if necessary. */
  ensure(directory: string, sessionId?: string): Promise<Backend | null>;
  /** Return the hidden maintenance worker, starting one if necessary. */
  ensureAnchor(): Promise<Backend | null>;
  /** Mark a managed backend as recently used (idle-shutdown guard). */
  touch(port: number): void;
}

/** Dependencies for building the mux server. */
export interface MuxDeps {
  /** Runtime configuration. */
  config: OatConfig;
  /** Live backend registry. */
  registry: Registry;
  /** Optional control handlers; omitted in tests that only exercise proxying. */
  control?: ControlHandlers;
  /** Optional lazy supervisor used when no backend owns a directory (Q1). */
  supervisor?: SupervisorLike;
}

/** Return the first value of a possibly repeated header. */
function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** Extract a session id from a `/session/<id>/...` path, ignoring `/session/status`. */
function extractSessionId(pathname: string): string | null {
  const match = /^\/session\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match?.[1]) return null;
  const id = match[1];
  return id === "status" ? null : id;
}

/** Resolve the directory context from the header or the `directory` query param. */
function directoryFor(req: http.IncomingMessage, url: URL): string | null {
  return firstHeader(req.headers["x-opencode-directory"]) ?? url.searchParams.get("directory");
}

/** Extract the bearer token from `Authorization` or the `x-oat-token` header. */
function bearerToken(req: http.IncomingMessage): string | null {
  const auth = firstHeader(req.headers["authorization"]);
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return firstHeader(req.headers["x-oat-token"]);
}

/** Send a JSON response with the given status. */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * A valid empty body for read endpoints when no backend exists yet.
 * Returning 200-with-empty lets the bridge's cold-start succeed instead of
 * error-looping on 503 before a server (or the anchor) is ready.
 */
function emptyReadBody(pathname: string): unknown | undefined {
  switch (pathname) {
    case "/project":
    case "/experimental/session":
    case "/session":
    case "/command":
    case "/agent":
    case "/question":
    case "/permission":
      return [];
    case "/session/status":
      return {};
    case "/provider":
      return { all: [], default: {}, connected: [] };
    case "/config/providers":
      return { providers: [], default: {} };
    default:
      return undefined;
  }
}

/** Write one merged SSE event downstream unless the response has already ended. */
function writeEvent(res: http.ServerResponse, event: SseEvent, attribute: boolean): void {
  if (!res.writableEnded) res.write(formatSseEvent(event, { attribute }));
}

/** Abortable delay used for SSE reconnect backoff. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // Resolve early when the fan-in is torn down.
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Open one event-stream connection to a backend and forward its events until it ends. */
async function pumpOnce(
  backend: Backend,
  merger: SseMerger,
  res: http.ServerResponse,
  signal: AbortSignal,
  attribute: boolean,
): Promise<void> {
  // v1 streams `/global/event`; v2 streams `/api/event` and needs Basic auth.
  const path = backend.kind === "v2" ? "/api/event" : "/global/event";
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (backend.kind === "v2" && backend.password) headers.authorization = basicAuth(backend.password);
  const response = await fetch(`${backend.baseUrl}${path}`, { headers, signal });
  if (!response.ok || !response.body) throw new Error(`upstream ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const source = String(backend.port);
  // v2 blocks are carried here; v1 blocks are carried inside the merger.
  let carry = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (backend.kind !== "v2") {
      for (const event of merger.ingest(source, text)) writeEvent(res, event, attribute);
      continue;
    }
    // Parse each v2 event, translate it to v1, and reuse the merger for collapse/typing.
    carry += text;
    const { events, rest } = splitSseEvents(carry);
    carry = rest;
    for (const block of events) {
      const data = getData(block);
      if (!data) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(data);
      } catch {
        continue;
      }
      for (const mapped of translateV2Events(raw)) {
        const chunk = `data: ${JSON.stringify(mapped)}\n\n`;
        for (const event of merger.ingest(source, chunk)) writeEvent(res, event, attribute);
      }
    }
  }
}

/** Keep a backend's SSE stream merged, reconnecting with backoff if it drops. */
async function pumpBackend(
  backend: Backend,
  merger: SseMerger,
  res: http.ServerResponse,
  signal: AbortSignal,
  attribute: boolean,
): Promise<void> {
  let delay = 500;
  // Retry until the downstream client disconnects (or the backend is removed).
  while (!signal.aborted) {
    try {
      await pumpOnce(backend, merger, res, signal, attribute);
      delay = 500;
    } catch (error) {
      if (signal.aborted) break;
      log.debug(`sse upstream ${backend.port} ended: ${(error as Error).message}`);
    }
    if (signal.aborted) break;
    await sleep(delay, signal);
    // Cap the backoff so a restarted backend is picked up quickly.
    delay = Math.min(delay * 2, 5_000);
  }
}

/** Handle a downstream `/global/event` request by fanning in every backend. */
function handleSse(req: http.IncomingMessage, res: http.ServerResponse, deps: MuxDeps): void {
  // SSE requires this exact content type, which the bridge checks.
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": oat ready\n\n");

  const merger = new SseMerger({ collapseServerConnected: true });
  const controllers = new Map<number, AbortController>();
  const attribute = deps.config.debugAttribution;

  // Start upstreams for healthy backends and stop those no longer present.
  const sync = (): void => {
    const healthy = deps.registry.list().filter((backend) => backend.healthy);
    const wanted = new Set(healthy.map((backend) => backend.port));
    for (const backend of healthy) {
      if (controllers.has(backend.port)) continue;
      const controller = new AbortController();
      controllers.set(backend.port, controller);
      void pumpBackend(backend, merger, res, controller.signal, attribute);
    }
    for (const port of [...controllers.keys()]) {
      if (wanted.has(port)) continue;
      controllers.get(port)?.abort();
      controllers.delete(port);
    }
  };

  sync();
  // React to registry changes (new/removed backends) while this client is attached.
  const onChange = (): void => sync();
  deps.registry.on("change", onChange);
  req.on("close", () => {
    deps.registry.off("change", onChange);
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
  });
}

/** Endpoints that actually start or drive an agent run for a directory. */
function isRunAction(method: string, pathname: string): boolean {
  if (method !== "POST") return false;
  // Creating a session, or driving one (a prompt first reserves a `/message`).
  if (pathname === "/session") return true;
  return /^\/session\/[^/]+\/(prompt_async|message|command|shell|summarize|init)$/.test(pathname);
}

/** Ask a backend for a session's directory (used when only the id is known). */
async function fetchSessionDirectory(backend: Backend, sessionId: string): Promise<string | null> {
  try {
    const v2 = backend.kind === "v2";
    const headers: Record<string, string> = {};
    if (v2 && backend.password) headers.authorization = basicAuth(backend.password);
    const path = v2 ? `/api/session/${sessionId}` : `/session/${sessionId}`;
    const response = await fetch(`${backend.baseUrl}${path}`, { signal: AbortSignal.timeout(10_000), headers });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    // v2 wraps the session in `{ data }` and nests the directory under `location`.
    const data = v2 ? ((body.data as Record<string, unknown>) ?? body) : body;
    const location = data.location as { directory?: unknown } | undefined;
    const directory = location?.directory ?? data.directory;
    return typeof directory === "string" ? directory : null;
  } catch {
    return null;
  }
}

/** Read a full request body into a buffer (small JSON payloads only). */
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Translate a v1 request to a v2 backend and return a v1-shaped response. */
async function handleTranslatedProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  backend: Backend,
): Promise<void> {
  const directory = directoryFor(req, url);
  let body: unknown;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const raw = await readBody(req);
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        body = undefined;
      }
    }
  }
  // A v1 "reserve" has no v2 equivalent and would double-admit the user message.
  if (body !== undefined && isReserve(body)) {
    sendJson(res, 200, synthesizeReservedMessage(extractSessionId(url.pathname) ?? "", body));
    return;
  }
  const translated = translateRequest(req.method ?? "GET", url.pathname, url.search, body, directory);
  const headers: Record<string, string | string[] | undefined> = { ...req.headers };
  for (const header of HOP_BY_HOP) delete headers[header];
  delete headers["authorization"];
  delete headers["content-length"];
  delete headers["x-opencode-directory"];
  if (backend.password) headers["authorization"] = basicAuth(backend.password);
  if (translated.body !== undefined) headers["content-type"] = "application/json";
  const upstream = http.request(
    { host: "127.0.0.1", port: backend.port, method: translated.method, path: translated.path, headers },
    (upstreamRes) => {
      const chunks: Buffer[] = [];
      upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
      upstreamRes.on("end", () => {
        const raw = Buffer.concat(chunks);
        const contentType = String(upstreamRes.headers["content-type"] ?? "");
        let payload = raw;
        if (contentType.includes("application/json") && raw.length > 0) {
          try {
            payload = Buffer.from(JSON.stringify(translateV2Response(url.pathname, JSON.parse(raw.toString("utf8")))));
          } catch {
            // Not JSON after all; return it unchanged.
          }
        }
        const outHeaders = { ...upstreamRes.headers };
        outHeaders["content-length"] = String(payload.length);
        res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
        res.end(payload);
      });
    },
  );
  upstream.on("error", (error) => {
    if (!res.headersSent) sendJson(res, 502, { error: `oat proxy error: ${error.message}` });
    else res.end();
  });
  if (translated.body !== undefined) upstream.write(translated.body);
  upstream.end();
}

/** Route and proxy a normal HTTP request to the selected backend. */
async function handleProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: MuxDeps,
  url: URL,
): Promise<void> {
  const directory = directoryFor(req, url);
  const sessionId = extractSessionId(url.pathname);
  // Choose a backend using directory/affinity/default precedence.
  let decision = pickBackend(
    deps.registry.list(),
    {
      directory,
      affinityPort: sessionId ? deps.registry.affinityPort(sessionId) : null,
    },
    { defaultPort: deps.registry.defaultPort() },
  );

  const directoryMatched = decision?.reason === "directory" || decision?.reason === "session-directory";
  const runAction = isRunAction(req.method ?? "GET", url.pathname);

  if (deps.supervisor && deps.config.anchor && !directoryMatched) {
    if (runAction) {
      // A real action must reach a dedicated instance for its project, never an
      // unrelated default backend. Resolve the directory from the header, or by
      // asking the anchor for the session's directory when only the id is known.
      let target = directory ?? null;
      if (!target && sessionId) {
        const anchor = await deps.supervisor.ensureAnchor();
        if (anchor) target = await fetchSessionDirectory(anchor, sessionId);
      }
      if (target) {
        const managed = await deps.supervisor.ensure(target, sessionId ?? undefined);
        decision = managed ? { backend: managed, reason: "default" } : null;
      }
    } else if (directory) {
      // A directory read (routine scan fan-out): serve it from the shared DB via
      // the anchor, never spawning a process per project.
      decision = null;
    }
  }

  // Anchor fallback: reads from the shared DB (mutations are refused).
  if (!decision && deps.supervisor && deps.config.anchor) {
    const anchor = await deps.supervisor.ensureAnchor();
    if (anchor) decision = { backend: anchor, reason: "default" };
  }

  // Still nothing (anchor disabled or failed): serve empty reads so the bridge
  // settles, but error on actions that need a server.
  if (!decision) {
    const empty = req.method === "GET" ? emptyReadBody(url.pathname) : undefined;
    if (empty !== undefined) {
      sendJson(res, 200, empty);
      return;
    }
    sendJson(res, 503, { error: "oat: no opencode backend available" });
    return;
  }

  const backend = decision.backend;
  // The anchor exists only for reads; never run a mutation in its own directory.
  if (backend.anchor && req.method !== "GET") {
    sendJson(res, 503, { error: "oat: no opencode instance for this project (anchor is read-only)" });
    return;
  }
  // Keep managed backends alive while they are being used.
  deps.supervisor?.touch(backend.port);
  // Remember the backend for this session so duplicates stay sticky.
  if (sessionId) deps.registry.setAffinity(sessionId, backend.port);
  log.debug(`route ${req.method} ${url.pathname} dir=${directory ?? "-"} -> ${backend.port} (${decision.reason})`);

  // v2 backends speak `/api/*` + Basic auth; translate the v1 surface when enabled.
  if (backend.kind === "v2" && deps.config.translateV2) {
    await handleTranslatedProxy(req, res, url, backend);
    return;
  }

  // Copy headers, dropping hop-by-hop ones and any auth meant for another server.
  const headers: Record<string, string | string[] | undefined> = { ...req.headers };
  for (const header of HOP_BY_HOP) delete headers[header];
  delete headers["authorization"];
  // v2 backends require HTTP Basic auth with the password OAT knows.
  if (backend.kind === "v2" && backend.password) headers["authorization"] = basicAuth(backend.password);

  // Stream the request upstream and the response back down (no buffering).
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: backend.port,
      method: req.method,
      path: url.pathname + url.search,
      headers,
    },
    (upstreamRes) => {
      const outHeaders: Record<string, string | string[] | undefined> = { ...upstreamRes.headers };
      if (deps.config.debugAttribution) outHeaders["x-oat-backend"] = String(backend.port);
      res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
      upstreamRes.pipe(res);
    },
  );

  // Surface upstream failures as a 502 so the bridge raises a plugin error.
  upstream.on("error", (error) => {
    log.warn(`proxy error -> ${backend.port}: ${error.message}`);
    if (!res.headersSent) sendJson(res, 502, { error: `oat proxy error: ${error.message}` });
    else res.end();
  });

  req.pipe(upstream);
}

/** Proxy a WebSocket/HTTP upgrade (PTY, terminal, web) to the selected backend. */
function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, deps: MuxDeps): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  // Upgrades are routed by directory only (no body to inspect).
  const decision = pickBackend(
    deps.registry.list(),
    { directory: directoryFor(req, url) },
    { defaultPort: deps.registry.defaultPort() },
  );
  if (!decision) {
    socket.destroy();
    return;
  }
  // Open a raw TCP connection and replay the request line/headers verbatim.
  const upstream = net.connect(decision.backend.port, "127.0.0.1", () => {
    const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
    for (const [key, value] of Object.entries(req.headers)) {
      // Replace any client auth with the backend's own credentials below.
      if (key.toLowerCase() === "authorization") continue;
      if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
      else if (value !== undefined) lines.push(`${key}: ${value}`);
    }
    if (decision.backend.kind === "v2" && decision.backend.password) {
      lines.push(`authorization: ${basicAuth(decision.backend.password)}`);
    }
    lines.push("", "");
    upstream.write(lines.join("\r\n"));
    if (head.length > 0) upstream.write(head);
    // Pipe both directions for the lifetime of the socket.
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

/** Serve the token-guarded control API under `/__oat/*`. */
async function handleControl(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: MuxDeps,
  url: URL,
): Promise<void> {
  // The route minus the shared prefix.
  const route = url.pathname.slice(OAT_CONTROL_PREFIX.length) || "/";

  // Identity is intentionally public so a second invocation can detect the daemon.
  if (route === "/identity") {
    sendJson(res, 200, { oat: true, version: OAT_VERSION, pid: process.pid, port: deps.config.port });
    return;
  }

  // Everything else requires the bearer token from the state file.
  if (bearerToken(req) !== deps.config.token) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (!deps.control) {
    sendJson(res, 501, { error: "control unavailable" });
    return;
  }

  // Dispatch each supported control command.
  if (route === "/status") {
    sendJson(res, 200, deps.control.status());
    return;
  }
  if (route === "/list") {
    sendJson(res, 200, deps.control.list());
    return;
  }
  if (route === "/reload") {
    await deps.control.reload();
    sendJson(res, 200, { ok: true });
    return;
  }
  if (route === "/stop") {
    // Answer before stopping so the client gets a clean response.
    sendJson(res, 200, { ok: true });
    setImmediate(() => {
      void deps.control?.stop();
    });
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

/** Build the OAT mux HTTP server (local health, SSE fan-in, routing proxy, control API). */
export function createMuxServer(deps: MuxDeps): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

    // Control API takes precedence over the opencode surface.
    if (url.pathname.startsWith(OAT_CONTROL_PREFIX)) {
      void handleControl(req, res, deps, url);
      return;
    }
    // OAT answers the bridge's liveness probe itself.
    if (url.pathname === "/global/health") {
      sendJson(res, 200, { healthy: true, version: `oat/${OAT_VERSION}` });
      return;
    }
    // The event stream is merged across all backends.
    if (url.pathname === "/global/event") {
      handleSse(req, res, deps);
      return;
    }
    // Everything else is routed to a backend.
    void handleProxy(req, res, deps, url);
  });

  // WebSocket upgrades are proxied separately from normal requests.
  server.on("upgrade", (req, socket, head) => handleUpgrade(req, socket, head, deps));
  return server;
}
