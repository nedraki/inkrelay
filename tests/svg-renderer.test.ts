import { describe, expect, it } from "vitest";
import { SVGRenderer } from "@inkrelay/render-svg";
import { page } from "./helpers.js";

describe("SVGRenderer", () => {
  it("renders deterministic rounded paths and omits action-only strokes", () => {
    const renderer = new SVGRenderer();
    const input = page();
    expect(renderer.render(input)).toBe(renderer.render(input));
    expect(renderer.render(input)).toContain('stroke-linecap="round"');
    expect(renderer.render(input)).toContain('d="M 100 200 L 110 210"');
  });
});
