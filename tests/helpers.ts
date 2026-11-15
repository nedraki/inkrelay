import { PEN_EVENT_SCHEMA_VERSION, type PenDotEvent, type SmartpenPage, type Stroke } from "@inkrelay/core";

export function event(sequence: number, eventType: PenDotEvent["eventType"], overrides: Partial<PenDotEvent> = {}): PenDotEvent {
  return {
    schemaVersion: PEN_EVENT_SCHEMA_VERSION,
    eventType,
    source: "mock",
    sessionId: "session-test",
    penId: "pen-test",
    sequence,
    timestampMs: 1_000 + sequence * 10,
    notebookId: "NB01",
    pageId: 12,
    x: 400 + sequence,
    y: 300 + sequence,
    pressure: 400,
    coordinateSpace: "app_px",
    ...overrides
  };
}

export function stroke(overrides: Partial<Stroke> = {}): Stroke {
  return {
    strokeId: "s_test_000001",
    notebookId: "NB01",
    pageId: 12,
    startedAtMs: 1_000,
    endedAtMs: 1_020,
    style: { color: "#111111", width: 2, opacity: 1 },
    points: [{ x: 170, y: 30, tMs: 0 }, { x: 175, y: 35, tMs: 20 }],
    semanticRole: "ink",
    ...overrides
  };
}

export function page(overrides: Partial<SmartpenPage> = {}): SmartpenPage {
  return {
    notebookId: "NB01", pageId: 12, width: 1480, height: 2100, unit: "app_px",
    strokes: [stroke({ points: [{ x: 100, y: 200, tMs: 0 }, { x: 110, y: 210, tMs: 20 }] })],
    actions: [], createdAtMs: 1_000, updatedAtMs: 2_000, ...overrides
  };
}
