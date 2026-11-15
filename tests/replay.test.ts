import { describe, expect, it } from "vitest";
import { createReplayTimeline, formatReplayTime, replayPointAt } from "../apps/web/src/replay.js";
import { page, stroke } from "./helpers.js";

describe("handwriting replay timeline", () => {
  it("orders visible strokes and compresses long pauses without changing source data", () => {
    const later = stroke({ strokeId: "later", startedAtMs: 20_000, endedAtMs: 20_500, points: [{ x: 2, y: 2, tMs: 0 }, { x: 4, y: 4, tMs: 500 }] });
    const first = stroke({ strokeId: "first", startedAtMs: 1_000, endedAtMs: 1_200, points: [{ x: 1, y: 1, tMs: 0 }, { x: 2, y: 2, tMs: 200 }] });
    const action = stroke({ strokeId: "action", semanticRole: "action", startedAtMs: 500, endedAtMs: 700 });
    const timeline = createReplayTimeline(page({ strokes: [later, action, first] }));
    expect(timeline.entries.map((entry) => entry.stroke.strokeId)).toEqual(["first", "later"]);
    expect(timeline.entries[1]?.startMs).toBe(800);
    expect(timeline.durationMs).toBe(1_300);
  });

  it("caps unusually long strokes and formats playback time", () => {
    const timeline = createReplayTimeline(page({ strokes: [stroke({
      strokeId: "long", startedAtMs: 1_000, endedAtMs: 20_000,
      points: [{ x: 0, y: 0, tMs: 0 }, { x: 10, y: 10, tMs: 19_000 }]
    })] }));
    expect(timeline.durationMs).toBe(3_000);
    expect(formatReplayTime(65_000)).toBe("1:05");
  });

  it("locates the active pen tip for replay auto-follow, including pauses", () => {
    const timeline = createReplayTimeline(page({ strokes: [
      stroke({ strokeId: "first", startedAtMs: 1_000, endedAtMs: 1_200, points: [{ x: 0, y: 10, tMs: 0 }, { x: 100, y: 30, tMs: 200 }] }),
      stroke({ strokeId: "second", startedAtMs: 1_400, endedAtMs: 1_600, points: [{ x: 200, y: 50, tMs: 0 }, { x: 300, y: 70, tMs: 200 }] })
    ] }));
    expect(replayPointAt(timeline, 100)).toEqual({ x: 50, y: 20 });
    expect(replayPointAt(timeline, 300)).toEqual({ x: 100, y: 30 });
    expect(replayPointAt(timeline, 500)).toEqual({ x: 250, y: 60 });
  });
});
