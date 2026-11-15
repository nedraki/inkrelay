import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { NEO_PAPER_REFERENCES, parseNeoPaperDefinition } from "@inkrelay/adapters";
import { PageMapper } from "@inkrelay/core";
import { PaperDefinitionStore } from "../apps/server/src/paper-definition-store.js";
import { createApp } from "../apps/server/src/app.js";
import { event, stroke } from "./helpers.js";

const xml = await readFile(resolve("fixtures/synthetic-paper.nproj"), "utf8");
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

describe("automatic paper definitions", () => {
  it("maps fractional asymmetric crop geometry, source units, segments and landscape pages", () => {
    const definition = parseNeoPaperDefinition(xml);
    expect(definition).toMatchObject({ notebookId: "NEO_3_27_8000", displayName: "Synthetic & asymmetric", provenance: { kind: "nproj", digest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(definition.pages[0]!.widthMm).toBeCloseTo(25.4);
    expect(definition.pages[0]!.heightMm).toBeCloseTo(50.8);
    const mapper = new PageMapper();
    mapper.replaceDefinitions([definition]);
    expect(mapper.dimensionsFor(definition.notebookId, 5)).toEqual({ width: 254, height: 508, unit: "app_px" });
    expect(mapper.dimensionsFor(definition.notebookId, 6)).toEqual({ width: 508, height: 254, unit: "app_px" });
    expect(mapper.mappingFor(definition.notebookId, 4).source).toBe("fallback");
    const projected = mapper.projectStroke(definition.notebookId, stroke({ notebookId: definition.notebookId, pageId: 5,
      points: [{ x: 13 / 6.72 * 10, y: 27 / 6.72 * 10, tMs: 0 }, { x: 85 / 6.72 * 10, y: 171 / 6.72 * 10, tMs: 10, pressure: 123 }] }));
    expect(projected.points[0]!.x).toBeCloseTo(0);
    expect(projected.points[0]!.y).toBeCloseTo(0);
    expect(projected.points[1]!.x).toBeCloseTo(254);
    expect(projected.points[1]!.y).toBeCloseTo(508);
    expect(projected.points[1]).toMatchObject({ tMs: 10, pressure: 123 });
    expect(parseNeoPaperDefinition(xml.replace('x2="94"', 'x2="94.5"')).pages[0]!.widthMm).toBeCloseTo(72.5 * 25.4 / 72);
  });

  it("supports legacy start_page without segment_info and handles its attributes", () => {
    const legacy = xml.replace('<segment_info ncode_start_page="5" ncode_end_page="6"/>', "");
    expect(parseNeoPaperDefinition(legacy).pages.map((page) => page.firstPage)).toEqual([1, 2]);
  });

  it.each([
    xml.replace('rotate_angle="0"', 'rotate_angle="90"'),
    xml.replace('crop_margin="3,7,9,9"', 'crop_margin="100,0,100,0"'),
    xml.replace('crop_margin="3,7,9,9"', 'crop_margin="3,7,9"'),
    xml.replace('crop_margin="3,7,9,9"', 'crop_margin="-1,7,9,9"'),
    xml.replace('x1="10"', 'x1="NaN"'),
    xml.replace('count="2"', 'count="3"'),
    xml.replace('number="1"', 'number="0"'),
    xml.replace('ncode_end_page="6"', 'ncode_end_page="7"'),
    xml.replace('<owner>27</owner>', '<owner>27</owner><owner>31</owner>'),
    xml.replace('<!DOCTYPE nproj>', '<!DOCTYPE nproj [<!ENTITY dangerous "value">]>'),
    xml.replace('<!DOCTYPE nproj>', '<!DOCTYPE nproj SYSTEM "file:///etc/passwd">'),
    xml.replace('version="2.31"', 'version="99.0"'),
    "<nproj>broken", "x".repeat(2_000_001)
  ])("rejects unsupported or invalid metadata without guessing geometry (%#)", (input) => {
    expect(() => parseNeoPaperDefinition(input)).toThrow();
  });

  it("limits measured references to exact identities and retains manual profile precedence", () => {
    const mapper = new PageMapper();
    mapper.replaceDefinitions(NEO_PAPER_REFERENCES);
    expect(mapper.mappingFor("NEO_3_27_747", 12)).toMatchObject({ source: "measured_reference", width: 1900, height: 2500 });
    for (const id of ["NEO_0_31_701", "NEO_3_1012_3027", "NEO_3_1013_1"]) expect(mapper.mappingFor(id, 12).source).toBe("fallback");
    expect(mapper.mappingFor("NEO_3_27_747", 0).source).toBe("fallback");
    mapper.replaceProfiles([{ notebookId: "NEO_3_27_747", displayName: "Legacy dimensions only", widthMm: 123, heightMm: 234, appPxPerMm: 10, revision: 1 }]);
    expect(mapper.mappingFor("NEO_3_27_747", 12)).toMatchObject({ source: "manual", width: 1230, height: 2340 });
    expect(mapper.projectStroke("NEO_3_27_747", stroke()).points).toEqual(stroke().points);
  });

  it("persists imports idempotently, preserves earlier versions, and retains state after invalid imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkrelay-definition-"));
    const path = join(root, "definitions.json");
    const store = new PaperDefinitionStore(path);
    await Promise.all([store.import(xml), store.import(xml)]);
    expect(JSON.parse(await readFile(path, "utf8")).imports).toHaveLength(1);
    await expect(store.import("invalid")).rejects.toThrow();
    await store.import(xml.replace('x2="94"', 'x2="95"'));
    expect(JSON.parse(await readFile(path, "utf8")).imports).toHaveLength(2);
    const disabled = new PaperDefinitionStore(path, false);
    expect(await disabled.load()).toEqual([]);
    await expect(disabled.import(xml)).rejects.toThrow("disabled");
    const loaded = await new PaperDefinitionStore(path).load();
    expect(loaded.find((item) => item.notebookId === "NEO_3_27_8000")!.pages[0]!.widthMm).toBeCloseTo(73 * 25.4 / 72);
  });

  it("imports through the API, reprojects once, preserves raw events, replays offline, and preserves manual calibration", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkrelay-auto-paper-api-"));
    const config = { canonicalDataPath: join(root, "raw"), vaultPath: join(root, "vault"), actionZonesPath: resolve("config/action-zones.json"),
      port: 0, host: "127.0.0.1", pythonServiceUrl: "http://127.0.0.1:8321", languageWorkerUrl: "http://127.0.0.1:8321", languageReviewTimeoutMs: 100, bluetoothEnabled: false };
    ({ app } = await createApp(config));
    const notebookId = "NEO_3_27_8000";
    const events = [event(1, "pen_down", { notebookId, pageId: 5 }), event(2, "pen_move", { notebookId, pageId: 5 }), event(3, "pen_up", { notebookId, pageId: 5 })];
    await app.inject({ method: "POST", url: "/api/pen/events", payload: events });
    const rawPath = join(root, "raw", notebookId, "Page_005", "session-test.events.jsonl");
    const rawBefore = await readFile(rawPath, "utf8");
    expect((await app.inject({ method: "POST", url: "/api/paper/metadata", payload: { xml, notebookId: "wrong" } })).statusCode).toBe(400);
    const imported = await app.inject({ method: "POST", url: "/api/paper/metadata", payload: { xml, notebookId } });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().definitions.find((item: { notebookId: string }) => item.notebookId === notebookId).provenance.kind).toBe("nproj");
    const before = (await app.inject({ method: "GET", url: `/api/pages/${notebookId}/5` })).json();
    expect(before).toMatchObject({ width: 254, height: 508, strokes: [{ strokeId: "s_session-test_000001" }] });
    expect(before.strokes[0].points[0].x).toBeCloseTo(events[0]!.x * (56 / 600 * 25.4) - 13 * 25.4 / 72 * 10);
    await app.inject({ method: "POST", url: "/api/paper/metadata", payload: { xml } });
    expect((await app.inject({ method: "GET", url: `/api/pages/${notebookId}/5` })).json()).toEqual(before);
    expect(await readFile(rawPath, "utf8")).toBe(rawBefore);
    // Fresh live input uses the same transform as earlier replayed input.
    const later = events.map((item) => ({ ...item, timestampMs: item.timestampMs + 1000, sessionId: "later-live", source: "native_bridge" as const }));
    await app.inject({ method: "POST", url: "/api/pen/events", payload: later });
    const livePage = (await app.inject({ method: "GET", url: `/api/pages/${notebookId}/5` })).json();
    expect(livePage.strokes[1].points).toEqual(before.strokes[0].points);
    await app.close();
    ({ app } = await createApp(config));
    expect((await app.inject({ method: "GET", url: `/api/pages/${notebookId}/5` })).json()).toEqual(livePage);
    expect((await app.inject({ method: "POST", url: "/api/pen/events", payload: events })).json()).toMatchObject({ accepted: 0, duplicates: 3 });
    // Dimension-only overrides keep their historical identity mapping. Removing
    // an automatic transform must recover source positions rather than double-map.
    expect((await app.inject({ method: "PUT", url: `/api/paper/profiles/${notebookId}`, payload: { displayName: "Manual", widthMm: 130, heightMm: 210 } })).statusCode).toBe(200);
    const manual = (await app.inject({ method: "GET", url: `/api/pages/${notebookId}/5` })).json();
    expect(manual.width).toBe(1300);
    expect(manual.strokes[0].points[0].x).toBeCloseTo(events[0]!.x);
    const calibration = { kind: "axis_aligned_affine", scaleX: 2, scaleY: 3, offsetX: 1, offsetY: 2,
      anchors: [{ sourceX: 0, sourceY: 0, paperXMm: 0, paperYMm: 0 }, { sourceX: 10, sourceY: 10, paperXMm: 10, paperYMm: 10 }] };
    await app.inject({ method: "PUT", url: `/api/paper/profiles/${notebookId}`, payload: { displayName: "Manual", widthMm: 130, heightMm: 210, calibration } });
    await app.inject({ method: "POST", url: "/api/paper/metadata", payload: { xml } });
    expect((await app.inject({ method: "GET", url: `/api/pages/${notebookId}/5` })).json().strokes[0].points[0].x).toBeCloseTo(events[0]!.x * 2 + 1);
    expect(await readFile(rawPath, "utf8")).toBe(rawBefore);
  });
});
