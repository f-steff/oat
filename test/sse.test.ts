import assert from "node:assert/strict";
import { test } from "node:test";

import { formatSseEvent, getEventType, SseMerger, splitSseEvents } from "../src/sse.js";

// Splitting must return complete events and keep the trailing partial block.
test("splitSseEvents returns complete events and keeps the partial carry", () => {
  const { events, rest } = splitSseEvents("data: a\n\ndata: b\n\ndata: par");
  assert.deepEqual(events, ["data: a", "data: b"]);
  assert.equal(rest, "data: par");
});

// Event type must be read from the opencode JSON payload.
test("getEventType reads opencode payload.type", () => {
  const block = 'data: {"payload":{"type":"server.connected","properties":{}}}';
  assert.equal(getEventType(block), "server.connected");
});

// An explicit `event:` line takes precedence over the JSON payload.
test("getEventType prefers an explicit event: line", () => {
  assert.equal(getEventType("event: ping\ndata: {}"), "ping");
});

// Duplicate lifecycle events from several backends collapse to one (Q6/FR-17).
test("merger collapses duplicate server.connected across sources", () => {
  const merger = new SseMerger();
  const first = merger.ingest("5000", 'data: {"payload":{"type":"server.connected"}}\n\n');
  const second = merger.ingest("5001", 'data: {"payload":{"type":"server.connected"}}\n\n');
  assert.equal(first.length, 1);
  assert.equal(first[0]?.source, "5000");
  assert.equal(second.length, 0);
});

// Non-lifecycle events from every source must all be forwarded.
test("merger forwards non-lifecycle events from every source", () => {
  const merger = new SseMerger();
  merger.ingest("5000", 'data: {"payload":{"type":"server.connected"}}\n\n');
  const fromA = merger.ingest("5000", 'data: {"payload":{"type":"session.updated"},"x":"A"}\n\n');
  const fromB = merger.ingest("5001", 'data: {"payload":{"type":"session.updated"},"x":"B"}\n\n');
  assert.equal(fromA.length, 1);
  assert.equal(fromA[0]?.source, "5000");
  assert.equal(fromB.length, 1);
  assert.equal(fromB[0]?.source, "5001");
});

// Formatting must preserve the event and only add a source comment when asked.
test("formatSseEvent optionally attributes the source", () => {
  const event = { source: "5000", block: 'data: {"a":1}', data: '{"a":1}', eventType: null };
  assert.equal(formatSseEvent(event), 'data: {"a":1}\n\n');
  assert.equal(formatSseEvent(event, { attribute: true }), ': oat-backend=5000\ndata: {"a":1}\n\n');
});
