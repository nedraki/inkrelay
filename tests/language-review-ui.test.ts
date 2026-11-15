import { describe, expect, it } from "vitest";
import { locateCorrections } from "../apps/web/src/language-review.js";

describe("annotated essay correction placement", () => {
  it("places corrections in reading order even when the model returns them out of order", () => {
    const ranges = locateCorrections("Paper\nHello world", [
      { correctionId: "world", replacement: "world" },
      { correctionId: "paper", replacement: "Paper" }
    ]);
    expect(ranges.map((range) => range.correction.correctionId)).toEqual(["paper", "world"]);
  });

  it("uses separate occurrences for repeated replacement text", () => {
    const ranges = locateCorrections("The cat and the cat", [
      { correctionId: "first", replacement: "cat" },
      { correctionId: "second", replacement: "cat" }
    ]);
    expect(ranges.map((range) => range.start)).toEqual([4, 16]);
  });
});
