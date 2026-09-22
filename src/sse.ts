/** A single parsed Server-Sent Event plus the source it came from. */
export interface SseEvent {
  /** Backend port (or other source tag) this event came from. */
  source: string;
  /** The raw SSE block without the trailing blank line. */
  block: string;
  /** The concatenated `data:` payload. */
  data: string;
  /** Event type, from an `event:` line or the opencode `payload.type` JSON field. */
  eventType: string | null;
}

/** Split a buffer into complete SSE blocks, returning the trailing partial block. */
export function splitSseEvents(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let rest = buffer;
  // SSE events are separated by a blank line ("\n\n").
  for (;;) {
    const idx = rest.indexOf("\n\n");
    if (idx === -1) break;
    events.push(rest.slice(0, idx));
    rest = rest.slice(idx + 2);
  }
  return { events, rest };
}

/** Join all `data:` lines of an SSE block into a single payload string. */
export function getData(block: string): string | null {
  const dataLines = block.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  if (dataLines.length === 0) return null;
  // Strip the "data:" prefix and one optional leading space, then join multi-line data.
  return dataLines.map((line) => line.slice(5).replace(/^ /, "")).join("\n");
}

/** Determine an event's type from an `event:` line or the opencode JSON `type`. */
export function getEventType(block: string): string | null {
  // An explicit `event:` field takes precedence.
  const match = /^event:\s*(.+)$/m.exec(block);
  if (match?.[1]) return match[1].trim();
  // Otherwise decode the opencode payload and read `payload.type` (or top-level `type`).
  const data = getData(block);
  if (!data) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const payload = obj.payload;
      if (payload && typeof payload === "object") {
        const type = (payload as Record<string, unknown>).type;
        if (typeof type === "string") return type;
      }
      if (typeof obj.type === "string") return obj.type;
    }
  } catch {
    // Malformed JSON: treat the event as typeless.
  }
  return null;
}

/** Options controlling how duplicate lifecycle events are handled. */
export interface SseMergerOptions {
  /** Collapse duplicate `server.connected` events from multiple backends (Q6, FR-17). */
  collapseServerConnected?: boolean;
}

/** Fan-in parser: many upstream SSE chunks in, a single ordered event stream out. */
export class SseMerger {
  /** Partial block carried between chunks per the current source. */
  private carry = "";
  /** Whether a `server.connected` event has already been forwarded. */
  private connectedSeen = false;
  /** Resolved collapse setting. */
  private readonly collapse: boolean;

  /** Create a merger, collapsing duplicate `server.connected` by default. */
  constructor(options: SseMergerOptions = {}) {
    this.collapse = options.collapseServerConnected ?? true;
  }

  /** Feed a raw chunk from one backend; returns the events ready to forward. */
  ingest(source: string, chunk: string): SseEvent[] {
    // Append the chunk and extract every complete block.
    this.carry += chunk;
    const { events, rest } = splitSseEvents(this.carry);
    this.carry = rest;
    const out: SseEvent[] = [];
    for (const block of events) {
      if (!block.trim()) continue;
      const eventType = getEventType(block);
      // Drop all but the first `server.connected` when collapsing.
      if (this.collapse && eventType === "server.connected") {
        if (this.connectedSeen) continue;
        this.connectedSeen = true;
      }
      out.push({ source, block, data: getData(block) ?? "", eventType });
    }
    return out;
  }

  /** Forget carried state (used when a downstream client reconnects). */
  reset(): void {
    this.carry = "";
    this.connectedSeen = false;
  }
}

/** Format an event for the downstream stream, optionally attributing its source. */
export function formatSseEvent(event: SseEvent, options: { attribute?: boolean } = {}): string {
  // A comment line names the source without perturbing the event payload.
  const prefix = options.attribute ? `: oat-backend=${event.source}\n` : "";
  return `${prefix}${event.block}\n\n`;
}
