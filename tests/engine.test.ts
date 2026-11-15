import { mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { InkRelayEngine } from "../apps/server/src/engine.js";
import { event } from "./helpers.js";

describe("InkRelayEngine", () => {
  it("applies UI ink styles only to strokes started after the change", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkrelay-ui-ink-style-"));
    const engine = new InkRelayEngine({ canonicalDataPath: join(root, "raw"), vaultPath: join(root, "vault"), actionZonesPath: resolve("config/action-zones.json") });
    await engine.initialize();
    await engine.ingestMany([event(1, "pen_down"), event(2, "pen_move"), event(3, "pen_up")]);
    await engine.updateInkStyle({ color: "#249BD3", width: 5 });
    await engine.ingestMany([
      event(4, "pen_down", { sessionId: "styled-stroke" }),
      event(5, "pen_move", { sessionId: "styled-stroke" }),
      event(6, "pen_up", { sessionId: "styled-stroke" })
    ]);
    expect(engine.page("NB01", 12)?.strokes.map((stroke) => stroke.style)).toMatchObject([
      { color: "#111111", width: 2 },
      { color: "#249bd3", width: 5 }
    ]);
    await expect(engine.updateInkStyle({ color: "blue" })).rejects.toThrow("six-digit hex");
    await expect(engine.updateInkStyle({ width: 20 })).rejects.toThrow("between 0.5 and 12");
  });

  it("uses an offline stroke's embedded Neo colour and enriches a prior colourless import", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkrelay-offline-color-"));
    const engine = new InkRelayEngine({ canonicalDataPath: join(root, "raw"), vaultPath: join(root, "vault"), actionZonesPath: resolve("config/action-zones.json") });
    await engine.initialize();
    await engine.ingestMany([
      event(1, "pen_down", { sessionId: "offline-red" }),
      event(2, "pen_move", { sessionId: "offline-red" }),
      event(3, "pen_up", { sessionId: "offline-red" })
    ]);
    expect(engine.page("NB01", 12)?.strokes[0]?.style.color).toBe("#111111");
    expect(await engine.ingest(event(1, "pen_down", { sessionId: "offline-red", color: "#e53935" }))).toEqual({ accepted: false });
    expect(engine.page("NB01", 12)?.strokes[0]?.style.color).toBe("#e53935");

    const restarted = new InkRelayEngine({ canonicalDataPath: join(root, "raw"), vaultPath: join(root, "vault"), actionZonesPath: resolve("config/action-zones.json") });
    await restarted.initialize();
    expect(restarted.page("NB01", 12)?.strokes[0]?.style.color).toBe("#e53935");
  });

  it("publishes page snapshots only when a stroke completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkrelay-emissions-"));
    const engine = new InkRelayEngine({ canonicalDataPath: join(root, "raw"), vaultPath: join(root, "vault"), actionZonesPath: resolve("config/action-zones.json") });
    await engine.initialize();
    let emissions = 0;
    engine.subscribe(() => { emissions += 1; });
    await engine.ingest(event(1, "pen_down"));
    await engine.ingest(event(2, "pen_move"));
    expect(emissions).toBe(0);
    await engine.ingest(event(3, "pen_up"));
    expect(emissions).toBe(1);
  });

  it("applies and updates paper calibration without rewriting canonical events", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkrelay-paper-transform-"));
    const engine = new InkRelayEngine({ canonicalDataPath: join(root, "raw"), vaultPath: join(root, "vault"), actionZonesPath: resolve("config/action-zones.json") });
    await engine.initialize();
    await engine.ingestMany([event(1, "pen_down", { x: 100, y: 200 }), event(2, "pen_move", { x: 110, y: 210 }), event(3, "pen_up", { x: 120, y: 220 })]);
    engine.setPaperProfiles([{ notebookId: "NB01", displayName: "B5", widthMm: 190, heightMm: 250, appPxPerMm: 10, revision: 2, calibration: { kind: "axis_aligned_affine", scaleX: 2, scaleY: 3, offsetX: -10, offsetY: 20, anchors: [{ sourceX: 0, sourceY: 0, paperXMm: 0, paperYMm: 0 }, { sourceX: 1, sourceY: 1, paperXMm: 1, paperYMm: 1 }] } }]);
    expect(engine.page("NB01", 12)).toMatchObject({ width: 1900, height: 2500 });
    expect(engine.page("NB01", 12)?.strokes[0]?.points[0]).toMatchObject({ x: 190, y: 620 });
    const sourceEvents = await readFile(join(root, "raw", "NB01", "Page_012", "session-test.events.jsonl"), "utf8");
    expect(sourceEvents).toContain('"x":100');
  });

  it("keeps two physical notebooks with the same paper identity separate across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkrelay-physical-notebooks-"));
    const config = { canonicalDataPath: join(root, "raw"), vaultPath: join(root, "vault"), actionZonesPath: resolve("config/action-zones.json") };
    const engine = new InkRelayEngine(config);
    await engine.initialize();
    await engine.ingestMany([event(1, "pen_down"), event(2, "pen_move"), event(3, "pen_up")]);
    await engine.renamePhysicalNotebook("NB01", "French course — 2026");
    const work = await engine.createPhysicalNotebook("NB01", "Work notes — Summer");
    await engine.ingestMany([event(4, "pen_down"), event(5, "pen_move"), event(6, "pen_up")]);

    expect(engine.page("NB01", 12)?.physicalNotebookName).toBe("French course — 2026");
    expect(engine.page("NB01", 12)?.strokes).toHaveLength(1);
    expect(engine.page("NB01", 12, work.instanceId)?.physicalNotebookName).toBe("Work notes — Summer");
    expect(engine.page("NB01", 12, work.instanceId)?.strokes).toHaveLength(1);
    const exported = await engine.export("NB01", 12, work.instanceId);
    expect((await readFile(exported.eventsPath, "utf8")).trim().split("\n")).toHaveLength(3);

    const restarted = new InkRelayEngine(config);
    await restarted.initialize();
    expect(restarted.page("NB01", 12)?.strokes).toHaveLength(1);
    expect(restarted.page("NB01", 12, work.instanceId)?.strokes).toHaveLength(1);
  });

  it("reassigns a captured range and rebuilds projections without changing canonical events", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkrelay-physical-reassignment-"));
    const config = { canonicalDataPath: join(root, "raw"), vaultPath: join(root, "vault"), actionZonesPath: resolve("config/action-zones.json") };
    const engine = new InkRelayEngine(config);
    await engine.initialize();
    await engine.ingestMany([event(1, "pen_down"), event(2, "pen_move"), event(3, "pen_up")]);
    const work = await engine.createPhysicalNotebook("NB01", "Work notes");
    await engine.ingestMany([event(4, "pen_down"), event(5, "pen_move"), event(6, "pen_up")]);
    const ranges = await engine.physicalNotebookCaptureRanges("NB01");
    const misplaced = ranges.find((range) => range.instanceId === "NB01");
    expect(misplaced).toMatchObject({ pageId: 12, startSequence: 1, endSequence: 3, strokeCount: 1 });
    await expect(engine.reassignPhysicalNotebookCapture({
      paperIdentity: misplaced!.paperIdentity, penId: misplaced!.penId, sessionId: misplaced!.sessionId, pageId: misplaced!.pageId,
      startSequence: misplaced!.startSequence, endSequence: misplaced!.endSequence - 1,
      fromInstanceId: misplaced!.instanceId, targetInstanceId: work.instanceId
    })).rejects.toThrow("Capture range changed");

    await engine.reassignPhysicalNotebookCapture({
      paperIdentity: misplaced!.paperIdentity, penId: misplaced!.penId, sessionId: misplaced!.sessionId, pageId: misplaced!.pageId,
      startSequence: misplaced!.startSequence, endSequence: misplaced!.endSequence,
      fromInstanceId: misplaced!.instanceId, targetInstanceId: work.instanceId
    });
    expect(engine.page("NB01", 12)).toBeUndefined();
    expect(engine.page("NB01", 12, work.instanceId)?.strokes).toHaveLength(2);
    expect((await engine.physicalNotebookCaptureRanges("NB01")).filter((range) => range.instanceId === work.instanceId)).toMatchObject([
      { startSequence: 4, endSequence: 6 }, { startSequence: 1, endSequence: 3 }
    ]);
    expect((await readFile(join(root, "raw", "NB01", "Page_012", "session-test.events.jsonl"), "utf8")).trim().split("\n")).toHaveLength(6);

    const restarted = new InkRelayEngine(config);
    await restarted.initialize();
    expect(restarted.page("NB01", 12)).toBeUndefined();
    expect(restarted.page("NB01", 12, work.instanceId)?.strokes).toHaveLength(2);
  });

  it("persists first, deduplicates replay, applies actions to later ink, and exports", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkrelay-engine-"));
    const engine = new InkRelayEngine({ canonicalDataPath: join(root, "raw"), vaultPath: join(root, "vault"), actionZonesPath: resolve("config/action-zones.json") });
    await engine.initialize();
    const events = [
      event(1, "pen_down", { x: 170, y: 30 }), event(2, "pen_move", { x: 175, y: 35 }), event(3, "pen_up", { x: 180, y: 40 }),
      event(4, "pen_down", { x: 400, y: 300 }), event(5, "pen_move", { x: 420, y: 320 }), event(6, "pen_up", { x: 440, y: 340 })
    ];
    expect(await engine.ingestMany(events)).toEqual({ accepted: 6, duplicates: 0 });
    expect(await engine.ingestMany(events)).toEqual({ accepted: 0, duplicates: 6 });
    expect(engine.page("NB01", 12)?.strokes[1]?.style.color).toBe("#d11a2a");
    const output = await engine.export("NB01", 12);
    expect(await readFile(output.actionsPath, "utf8")).toContain("set_color");
    expect((await readFile(output.eventsPath, "utf8")).trim().split("\n")).toHaveLength(6);

    const restarted = new InkRelayEngine({ canonicalDataPath: join(root, "raw"), vaultPath: join(root, "vault"), actionZonesPath: resolve("config/action-zones.json") });
    await restarted.initialize();
    expect(restarted.page("NB01", 12)?.strokes).toHaveLength(2);
    expect(await restarted.ingestMany(events)).toEqual({ accepted: 0, duplicates: 6 });
    expect(restarted.page("NB01", 12)?.strokes).toHaveLength(2);
    expect((await readFile(output.eventsPath, "utf8")).trim().split("\n")).toHaveLength(6);
  });
});
