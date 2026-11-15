import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PageMapper } from "@inkrelay/core";
import { PaperProfileStore } from "../apps/server/src/paper-profile-store.js";

describe("paper profiles", () => {
  it("persists versioned notebook dimensions and increments revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkrelay-paper-profile-"));
    const path = join(root, "paper-profiles.json");
    const store = new PaperProfileStore(path);
    expect(await store.load()).toEqual({ schemaVersion: "inkrelay.paper_catalog.v2", profiles: [] });

    const first = await store.upsert("NEO_3_27_1", { displayName: "My official notebook", widthMm: 130, heightMm: 210 });
    expect(first.profiles[0]).toMatchObject({ notebookId: "NEO_3_27_1", widthMm: 130, heightMm: 210, appPxPerMm: 10, revision: 1 });
    const second = await store.upsert("NEO_3_27_1", { displayName: "My official notebook", widthMm: 148, heightMm: 210 });
    expect(second.profiles[0]).toMatchObject({ widthMm: 148, heightMm: 210, revision: 2 });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(second);
  });

  it("migrates dimension-only v1 catalogs and persists calibration anchors", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkrelay-paper-calibration-"));
    const path = join(root, "paper-profiles.json");
    const store = new PaperProfileStore(path);
    await writeFile(path, JSON.stringify({
      schemaVersion: "inkrelay.paper_catalog.v1",
      profiles: [{ notebookId: "NEO_3_27_747", displayName: "B5", widthMm: 190, heightMm: 250, appPxPerMm: 10, revision: 1 }]
    }));
    expect((await store.load()).schemaVersion).toBe("inkrelay.paper_catalog.v2");
    const calibration = {
      kind: "axis_aligned_affine" as const, scaleX: 2, scaleY: 2.5, offsetX: -100, offsetY: -120,
      anchors: [{ sourceX: 100, sourceY: 90, paperXMm: 10, paperYMm: 10 }, { sourceX: 800, sourceY: 1060, paperXMm: 180, paperYMm: 240 }] as const
    };
    const catalog = await store.upsert("NEO_3_27_747", { displayName: "B5", widthMm: 190, heightMm: 250, calibration });
    expect(catalog).toMatchObject({ schemaVersion: "inkrelay.paper_catalog.v2", profiles: [{ calibration, revision: 2 }] });
  });

  it("maps a known notebook and preserves the fallback for unknown paper", () => {
    const mapper = new PageMapper({ width: 1480, height: 2100, unit: "app_px" }, [{
      notebookId: "NEO_3_27_1", displayName: "Landscape pad", widthMm: 210, heightMm: 148, appPxPerMm: 10, revision: 1
    }]);
    expect(mapper.dimensionsFor("NEO_3_27_1", 7)).toEqual({ width: 2100, height: 1480, unit: "app_px" });
    expect(mapper.dimensionsFor("UNKNOWN", 1)).toEqual({ width: 1480, height: 2100, unit: "app_px" });
  });

  it("projects source strokes through a paper calibration", () => {
    const mapper = new PageMapper({ width: 1480, height: 2100, unit: "app_px" }, [{
      notebookId: "NB", displayName: "Calibrated", widthMm: 190, heightMm: 250, appPxPerMm: 10, revision: 2,
      calibration: { kind: "axis_aligned_affine", scaleX: 2, scaleY: 3, offsetX: -10, offsetY: 20, anchors: [{ sourceX: 0, sourceY: 0, paperXMm: 0, paperYMm: 0 }, { sourceX: 1, sourceY: 1, paperXMm: 1, paperYMm: 1 }] }
    }]);
    const stroke = { strokeId: "s", notebookId: "NB", pageId: 1, startedAtMs: 1, endedAtMs: 2, style: { color: "#000000", width: 2, opacity: 1 }, points: [{ x: 100, y: 200, tMs: 1 }], semanticRole: "ink" as const };
    expect(mapper.projectStroke("NB", stroke).points[0]).toMatchObject({ x: 190, y: 620 });
  });
});
