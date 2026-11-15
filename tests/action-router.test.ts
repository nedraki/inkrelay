import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ActionRouter, type ActionZone } from "@inkrelay/action-router";
import { DEFAULT_SESSION_STATE } from "@inkrelay/core";
import { stroke } from "./helpers.js";

const red: ActionZone = { zoneId: "red", label: "Red", pageScope: "all_pages", bounds: { x: 120, y: 0, width: 120, height: 80 }, action: { kind: "set_color", payload: { color: "#d11a2a" } } };

describe("ActionRouter", () => {
  it("detects a contained short action stroke and updates state", () => {
    const result = new ActionRouter([red]).route(stroke({ physicalNotebookId: "copy-a" }), DEFAULT_SESSION_STATE);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.kind).toBe("set_color");
    expect(result.actions[0]?.physicalNotebookId).toBe("copy-a");
    expect(result.state.currentColor).toBe("#d11a2a");
    expect(result.stroke.semanticRole).toBe("action");
  });

  it("does not trigger for ordinary ink merely crossing a zone", () => {
    const crossing = stroke({ points: [{ x: 100, y: 30, tMs: 0 }, { x: 170, y: 30, tMs: 20 }] });
    expect(new ActionRouter([red]).route(crossing, DEFAULT_SESSION_STATE).actions).toHaveLength(0);
  });

  it("maps the detected LAMY controller palette without passing taps through as ink", async () => {
    const router = await ActionRouter.fromFile(resolve("config/action-zones.json"));
    const tap = stroke({
      notebookId: "NEO_3_1013_1", pageId: 11,
      points: [{ x: 203, y: 483, tMs: 0 }, { x: 204, y: 483, tMs: 20 }]
    });
    const result = router.route(tap, DEFAULT_SESSION_STATE);
    expect(result.actions).toMatchObject([{ kind: "set_color", payload: { color: "#249bd3", zoneId: "lamy-controller-cyan" } }]);
    expect(result.state.currentColor).toBe("#249bd3");
    expect(result.stroke.semanticRole).toBe("action");
  });

  it("maps every LAMY controller color row and line-width button", async () => {
    const router = await ActionRouter.fromFile(resolve("config/action-zones.json"));
    const colors = [
      [160, 440, "#f2f2f2"], [203, 440, "#e53935"],
      [160, 485, "#222222"], [203, 485, "#249bd3"],
      [160, 532, "#bdbdbd"], [203, 532, "#59a14f"],
      [160, 580, "#f2c12e"], [203, 580, "#b33b8f"],
      [160, 625, "#f47b20"], [203, 625, "#3f5fab"]
    ] as const;
    for (const [x, y, color] of colors) {
      const result = router.route(stroke({ notebookId: "NEO_3_1013_1", pageId: 11, points: [{ x, y, tMs: 0 }] }), DEFAULT_SESSION_STATE);
      expect(result.actions, `color button at ${x},${y}`).toHaveLength(1);
      expect(result.state.currentColor).toBe(color);
    }
    for (const [y, width] of [[462, 1], [532, 2], [605, 5]] as const) {
      const result = router.route(stroke({ notebookId: "NEO_3_1013_1", pageId: 11, points: [{ x: 100, y, tMs: 0 }] }), DEFAULT_SESSION_STATE);
      expect(result.actions, `line button at 100,${y}`).toHaveLength(1);
      expect(result.state.currentWidth).toBe(width);
    }
  });

  it("does not treat the gaps between controller controls as commands", async () => {
    const router = await ActionRouter.fromFile(resolve("config/action-zones.json"));
    for (const [x, y] of [[135, 440], [185, 440], [160, 463], [100, 500]] as const) {
      const result = router.route(stroke({ notebookId: "NEO_3_1013_1", pageId: 11, points: [{ x, y, tMs: 0 }] }), DEFAULT_SESSION_STATE);
      expect(result.actions, `blank controller area at ${x},${y}`).toHaveLength(0);
    }
  });
});
