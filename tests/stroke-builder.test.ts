import { describe, expect, it, vi } from "vitest";
import { StrokeBuilder } from "@inkrelay/core";
import { event } from "./helpers.js";

describe("StrokeBuilder", () => {
  it("builds one deterministic completed stroke", () => {
    const builder = new StrokeBuilder({ getStyle: () => ({ color: "#123456", width: 3, opacity: 1 }) });
    expect(builder.process(event(1, "pen_down"))).toBeUndefined();
    expect(builder.process(event(2, "pen_move"))).toBeUndefined();
    const result = builder.process(event(3, "pen_up"));
    expect(result).toMatchObject({ strokeId: "s_session-test_000001", style: { color: "#123456", width: 3 }, points: [{ tMs: 0 }, { tMs: 10 }, { tMs: 20 }] });
  });

  it("warns and safely ignores malformed sequences", () => {
    const warning = vi.fn();
    const builder = new StrokeBuilder({ getStyle: () => ({ color: "black", width: 2, opacity: 1 }), onWarning: warning });
    expect(builder.process(event(1, "pen_move"))).toBeUndefined();
    builder.process(event(2, "pen_down"));
    expect(builder.process(event(3, "pen_up", { pageId: 13 }))).toBeUndefined();
    expect(warning).toHaveBeenCalledTimes(2);
  });
});
