import { describe, expect, it } from "vitest";
import { projectPageToExcalidraw, recognizeGeometry } from "@inkrelay/render-excalidraw";
import { page, stroke } from "./helpers.js";

function segment(from: readonly [number, number], to: readonly [number, number], steps = 12): { x: number; y: number; tMs: number }[] {
  return Array.from({ length: steps }, (_, index) => ({
    x: from[0] + (to[0] - from[0]) * index / (steps - 1),
    y: from[1] + (to[1] - from[1]) * index / (steps - 1),
    tMs: index * 10
  }));
}

const rectangle = [
  ...segment([100, 100], [400, 100]),
  ...segment([400, 100], [400, 300]),
  ...segment([400, 300], [100, 300]),
  ...segment([100, 300], [100, 100])
];

describe("Excalidraw projection", () => {
  it("faithfully maps every ink stroke to deterministic editable freedraw", () => {
    const input = page({ strokes: [stroke({
      strokeId: "pressure-ink",
      style: { color: "#e03131", width: 4, opacity: 0.75 },
      points: [{ x: 20, y: 30, tMs: 0, pressure: 200 }, { x: 80, y: 90, tMs: 10, pressure: 800 }]
    })] });
    const first = projectPageToExcalidraw(input, "faithful");
    const second = projectPageToExcalidraw(input, "faithful");
    expect(first.elements).toEqual(second.elements);
    expect(first.elements[0]).toMatchObject({ id: "ink-pressure-ink", type: "freedraw", x: 20, y: 30, strokeColor: "#e03131", opacity: 75 });
    expect(first.elements[0]!.strokeWidth).toBeCloseTo(4 / 4.25);
    expect(first.recognized).toEqual({ freedraw: 1, rectangle: 0, diamond: 0, ellipse: 0, line: 0, arrow: 0 });
  });

  it("promotes only clear hybrid geometry and leaves handwriting as free ink", () => {
    const handwriting = [{ x: 160, y: 160, tMs: 0 }, { x: 170, y: 130, tMs: 10 }, { x: 180, y: 160, tMs: 20 }, { x: 190, y: 130, tMs: 30 }];
    const result = projectPageToExcalidraw(page({ strokes: [
      stroke({ strokeId: "box", points: rectangle }),
      stroke({ strokeId: "label", points: handwriting })
    ] }), "hybrid");
    expect(result.elements.map((element) => element.type)).toEqual(["rectangle", "freedraw"]);
    expect(result.recognized.rectangle).toBe(1);
    expect(result.recognized.freedraw).toBe(1);
  });

  it("recognizes a long connector but rejects an ambiguous curved mark", () => {
    expect(recognizeGeometry(segment([10, 20], [350, 24], 20))).toBe("line");
    expect(recognizeGeometry([{ x: 10, y: 10 }, { x: 80, y: 50 }, { x: 130, y: 25 }, { x: 180, y: 90 }])).toBeUndefined();
  });

  it("recognizes small closed shapes at the smartpen coordinate scale", () => {
    const circle = Array.from({ length: 40 }, (_, index) => {
      const angle = index / 39 * Math.PI * 2;
      return { x: 40 + Math.cos(angle) * 15, y: 40 + Math.sin(angle) * 14 };
    });
    expect(recognizeGeometry(circle)).toBe("ellipse");
  });

  it("recognizes an asymmetric hand-drawn diamond instead of treating it as an ellipse", () => {
    const vertices = [[200, 100], [310, 150], [260, 280], [90, 210], [190, 110]] as const;
    const diamond = vertices.slice(0, -1).flatMap((vertex, index) => segment(vertex, vertices[index + 1]!));
    expect(recognizeGeometry(diamond)).toBe("diamond");
  });

  it("assembles four neighboring straight strokes into one rectangle", () => {
    const sides = [
      [[100, 100], [180, 100]], [[180, 100], [180, 150]],
      [[180, 150], [100, 150]], [[100, 150], [100, 100]]
    ] as const;
    const strokes = sides.map((side, index) => stroke({
      strokeId: `side-${index}`,
      startedAtMs: 1_000 + index * 200,
      endedAtMs: 1_100 + index * 200,
      points: segment(side[0], side[1])
    }));
    const result = projectPageToExcalidraw(page({ strokes }), "hybrid");
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toMatchObject({ type: "rectangle", x: 100, y: 100, width: 80, height: 50 });
    expect(result.recognized.rectangle).toBe(1);
  });

  it("assembles a slightly open and skewed two-stroke rectangle", () => {
    const left = stroke({
      strokeId: "open-left", startedAtMs: 1_000, endedAtMs: 1_200,
      points: segment([459, 236], [492, 355])
    });
    const remainingSides = stroke({
      strokeId: "open-rest", startedAtMs: 1_300, endedAtMs: 1_800,
      points: [
        ...segment([509, 221], [638, 261]),
        ...segment([638, 261], [628, 393]),
        ...segment([628, 393], [468, 373])
      ]
    });
    const result = projectPageToExcalidraw(page({ strokes: [left, remainingSides] }), "hybrid");
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toMatchObject({ type: "rectangle", x: 459, y: 221, width: 179, height: 172 });
    expect(result.recognized.rectangle).toBe(1);
  });

  it("assembles an open hand-drawn diamond split across three strokes", () => {
    const strokes = [
      stroke({
        strokeId: "diamond-upper-left", startedAtMs: 1_000, endedAtMs: 1_200,
        points: segment([724, 423], [675, 483])
      }),
      stroke({
        strokeId: "diamond-upper-right", startedAtMs: 1_300, endedAtMs: 1_500,
        points: segment([732, 425], [783, 493])
      }),
      stroke({
        strokeId: "diamond-lower", startedAtMs: 1_600, endedAtMs: 1_900,
        points: [...segment([676, 489], [711, 573]), ...segment([711, 573], [779, 498])]
      })
    ];
    const result = projectPageToExcalidraw(page({ strokes }), "hybrid");
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toMatchObject({ type: "diamond", x: 675, y: 423, width: 108, height: 150 });
    expect(result.recognized.diamond).toBe(1);
  });

  it("does not absorb an ellipse and its interior writing into a composite diamond", () => {
    const circle = Array.from({ length: 40 }, (_, index) => {
      const angle = index / 39 * Math.PI * 2;
      return { x: 200 + Math.cos(angle) * 70, y: 200 + Math.sin(angle) * 65, tMs: index * 10 };
    });
    const result = projectPageToExcalidraw(page({ strokes: [
      stroke({ strokeId: "circle", startedAtMs: 1_000, endedAtMs: 1_500, points: circle }),
      stroke({ strokeId: "inside-one", startedAtMs: 1_600, endedAtMs: 1_800, points: segment([198, 170], [198, 220]) }),
      stroke({ strokeId: "inside-two", startedAtMs: 1_900, endedAtMs: 2_100, points: segment([215, 175], [220, 215]) })
    ] }), "hybrid");
    expect(result.recognized.diamond).toBe(0);
    expect(result.elements[0]).toMatchObject({ type: "ellipse" });
  });

  it("combines a curved shaft and a separate V head into a native arrow", () => {
    const shaft = stroke({
      strokeId: "shaft", startedAtMs: 1_000, endedAtMs: 1_400,
      points: [{ x: 10, y: 40, tMs: 0 }, { x: 40, y: 35, tMs: 100 }, { x: 70, y: 48, tMs: 200 }, { x: 100, y: 42, tMs: 300 }]
    });
    const head = stroke({
      strokeId: "head", startedAtMs: 1_500, endedAtMs: 1_700,
      points: [{ x: 88, y: 32, tMs: 0 }, { x: 102, y: 42, tMs: 100 }, { x: 90, y: 55, tMs: 200 }]
    });
    const result = projectPageToExcalidraw(page({ strokes: [shaft, head] }), "hybrid");
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toMatchObject({ type: "arrow", endArrowhead: "arrow" });
    expect(result.recognized.arrow).toBe(1);
  });

  it("recognizes a shaft and arrowhead drawn in one continuous stroke", () => {
    const result = projectPageToExcalidraw(page({ strokes: [stroke({
      strokeId: "one-stroke-arrow",
      points: [
        { x: 10, y: 70, tMs: 0 }, { x: 45, y: 70, tMs: 100 }, { x: 90, y: 70, tMs: 200 },
        { x: 76, y: 59, tMs: 300 }, { x: 90, y: 70, tMs: 400 }, { x: 76, y: 82, tMs: 500 }
      ]
    })] }), "hybrid");
    expect(result.elements[0]).toMatchObject({ type: "arrow", endArrowhead: "arrow" });
  });

  it("combines aligned short strokes into a dashed native line", () => {
    const dashes = [[10, 25], [35, 50], [62, 77], [90, 105]].map(([from, to], index) => stroke({
      strokeId: `dash-${index}`, startedAtMs: 1_000 + index * 200, endedAtMs: 1_100 + index * 200,
      points: segment([from!, 80], [to!, 80], 5)
    }));
    const result = projectPageToExcalidraw(page({ strokes: dashes }), "hybrid");
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toMatchObject({ type: "line", strokeStyle: "dashed" });
  });
});
