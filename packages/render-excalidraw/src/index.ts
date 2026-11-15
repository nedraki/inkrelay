import type { SmartpenPage, Stroke } from "@inkrelay/core";
import type { ExcalidrawElement, ExcalidrawFreeDrawElement } from "@excalidraw/excalidraw/element/types";

export type ExcalidrawProjectionMode = "faithful" | "hybrid";
export type RecognizedInkKind = "freedraw" | "rectangle" | "diamond" | "ellipse" | "line" | "arrow";

export type ProjectionResult = {
  readonly elements: readonly ExcalidrawElement[];
  readonly recognized: Readonly<Record<RecognizedInkKind, number>>;
};

type Point = { readonly x: number; readonly y: number };
type Bounds = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
type NativeKind = Exclude<RecognizedInkKind, "freedraw">;
type ConnectorCandidate = {
  readonly strokes: readonly Stroke[];
  readonly shaftPoints: readonly Point[];
  readonly kind: "line" | "arrow";
  readonly strokeStyle: "solid" | "dashed";
};

/**
 * Projects canonical pen strokes without OCR. Faithful mode maps one pen stroke
 * to one Excalidraw freedraw element. Hybrid mode only promotes highly
 * confident, single-stroke geometry and leaves every other mark untouched.
 */
export function projectPageToExcalidraw(page: SmartpenPage, mode: ExcalidrawProjectionMode): ProjectionResult {
  const counts: Record<RecognizedInkKind, number> = { freedraw: 0, rectangle: 0, diamond: 0, ellipse: 0, line: 0, arrow: 0 };
  const elements: ExcalidrawElement[] = [];
  const compositeRectangles = mode === "hybrid" ? findCompositeRectangles(page.strokes) : new Map<string, readonly Stroke[]>();
  const compositeDiamonds = mode === "hybrid" ? findCompositeDiamonds(page.strokes) : new Map<string, readonly Stroke[]>();
  const connectors = mode === "hybrid" ? findConnectors(page.strokes) : new Map<string, ConnectorCandidate>();
  const consumed = new Set<string>();

  for (const stroke of page.strokes) {
    if (stroke.semanticRole === "action" || stroke.points.length === 0) continue;
    if (consumed.has(stroke.strokeId)) continue;
    const connector = connectors.get(stroke.strokeId);
    if (connector) {
      elements.push(nativeConnectorElement(connector));
      for (const part of connector.strokes) consumed.add(part.strokeId);
      counts[connector.kind] += 1;
      continue;
    }
    const composite = compositeRectangles.get(stroke.strokeId);
    if (composite) {
      elements.push(nativeCompositeRectangle(composite));
      for (const part of composite) consumed.add(part.strokeId);
      counts.rectangle += 1;
      continue;
    }
    const compositeDiamond = compositeDiamonds.get(stroke.strokeId);
    if (compositeDiamond) {
      elements.push(nativeCompositeDiamond(compositeDiamond));
      for (const part of compositeDiamond) consumed.add(part.strokeId);
      counts.diamond += 1;
      continue;
    }
    const kind = mode === "hybrid" ? recognizeGeometry(stroke.points) : undefined;
    if (kind) {
      elements.push(nativeElement(stroke, kind));
      counts[kind] += 1;
    } else {
      elements.push(freedrawElement(stroke, mode));
      counts.freedraw += 1;
    }
  }

  return { elements, recognized: counts };
}

function findConnectors(strokes: readonly Stroke[]): Map<string, ConnectorCandidate> {
  const found = new Map<string, ConnectorCandidate>();
  for (let index = 0; index < strokes.length; index += 1) {
    const shaft = strokes[index]!;
    if (shaft.semanticRole === "action" || shaft.points.length < 2) continue;

    const single = singleStrokeArrow(shaft);
    if (single) { found.set(shaft.strokeId, single); continue; }

    const dashed = dashedRun(strokes, index);
    if (dashed) {
      let candidate: ConnectorCandidate = dashed;
      for (let offset = 0; offset < 3; offset += 1) {
        const headIndex = index + dashed.strokes.length + offset;
        const head = strokes[headIndex];
        if (!head || head.startedAtMs - dashed.strokes.at(-1)!.endedAtMs >= 5_000) break;
        if (isArrowHead(head.points, dashed.shaftPoints)) {
          candidate = { ...dashed, strokes: strokes.slice(index, headIndex + 1), kind: "arrow" };
          break;
        }
      }
      found.set(shaft.strokeId, candidate);
      index += candidate.strokes.length - 1;
      continue;
    }

    const head = strokes[index + 1];
    if (head && isShaft(shaft.points) && head.startedAtMs - shaft.endedAtMs < 5_000 && isArrowHead(head.points, shaft.points)) {
      found.set(shaft.strokeId, { strokes: [shaft, head], shaftPoints: simplify(shaft.points), kind: "arrow", strokeStyle: "solid" });
      index += 1;
    }
  }
  return found;
}

function singleStrokeArrow(stroke: Stroke): ConnectorCandidate | undefined {
  const points = simplify(stroke.points);
  if (points.length < 5 || points.length > 12) return undefined;
  const start = points[0]!;
  let tipIndex = 1;
  for (let index = 2; index < points.length - 1; index += 1) if (distance(start, points[index]!) > distance(start, points[tipIndex]!)) tipIndex = index;
  const tip = points[tipIndex]!;
  const shaftLength = distance(start, tip);
  if (tipIndex >= points.length - 2 || shaftLength < 28) return undefined;
  let returnIndex = -1;
  for (let index = tipIndex + 2; index < points.length - 1; index += 1) {
    if (distance(points[index]!, tip) <= Math.max(8, shaftLength * 0.12)) { returnIndex = index; break; }
  }
  if (returnIndex < 0) return undefined;
  const firstWing = points.slice(tipIndex + 1, returnIndex).reduce((farthest, point) => distance(point, tip) > distance(farthest, tip) ? point : farthest);
  const secondWing = points.at(-1)!;
  if (!validArrowWings(tip, start, firstWing, secondWing, shaftLength)) return undefined;
  return { strokes: [stroke], shaftPoints: points.slice(0, tipIndex + 1), kind: "arrow", strokeStyle: "solid" };
}

function isShaft(points: readonly Point[]): boolean {
  const box = bounds(points);
  const diagonal = Math.hypot(box.width, box.height);
  const length = pathLength(points);
  return diagonal >= 28 && distance(points[0]!, points.at(-1)!) / Math.max(1, length) >= 0.45;
}

function isArrowHead(points: readonly Point[], shaftPoints: readonly Point[]): boolean {
  if (points.length < 3) return false;
  const shaftStart = shaftPoints[0]!;
  const shaftEnd = shaftPoints.at(-1)!;
  const shaftLength = distance(shaftStart, shaftEnd);
  if (shaftLength < 20) return false;
  const direction = unit({ x: shaftEnd.x - shaftStart.x, y: shaftEnd.y - shaftStart.y });
  let tipIndex = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (dot({ x: points[index]!.x - shaftEnd.x, y: points[index]!.y - shaftEnd.y }, direction) > dot({ x: points[tipIndex]!.x - shaftEnd.x, y: points[tipIndex]!.y - shaftEnd.y }, direction)) tipIndex = index;
  }
  if (tipIndex === 0 || tipIndex === points.length - 1) return false;
  const tip = points[tipIndex]!;
  if (distance(tip, shaftEnd) > Math.max(10, shaftLength * 0.3)) return false;
  const firstWing = points.slice(0, tipIndex).reduce((farthest, point) => distance(point, tip) > distance(farthest, tip) ? point : farthest);
  const secondWing = points.slice(tipIndex + 1).reduce((farthest, point) => distance(point, tip) > distance(farthest, tip) ? point : farthest);
  return validArrowWings(tip, shaftStart, firstWing, secondWing, shaftLength);
}

function validArrowWings(tip: Point, shaftStart: Point, firstWing: Point, secondWing: Point, shaftLength: number): boolean {
  const backward = unit({ x: shaftStart.x - tip.x, y: shaftStart.y - tip.y });
  const first = { x: firstWing.x - tip.x, y: firstWing.y - tip.y };
  const second = { x: secondWing.x - tip.x, y: secondWing.y - tip.y };
  const firstLength = Math.hypot(first.x, first.y);
  const secondLength = Math.hypot(second.x, second.y);
  if (firstLength < 5 || secondLength < 5 || firstLength > shaftLength * 0.65 || secondLength > shaftLength * 0.65) return false;
  if (dot(unit(first), backward) < 0.12 || dot(unit(second), backward) < 0.12) return false;
  const angleCos = dot(unit(first), unit(second));
  return angleCos < 0.9 && angleCos > -0.9;
}

function dashedRun(strokes: readonly Stroke[], startIndex: number): ConnectorCandidate | undefined {
  const run: Stroke[] = [];
  for (let index = startIndex; index < Math.min(strokes.length, startIndex + 10); index += 1) {
    const stroke = strokes[index]!;
    if (stroke.semanticRole === "action" || stroke.points.length < 2) break;
    const direct = distance(stroke.points[0]!, stroke.points.at(-1)!);
    const length = pathLength(stroke.points);
    if (direct < 3 || direct > 45 || direct / Math.max(1, length) < 0.82) break;
    if (run.length && stroke.startedAtMs - run.at(-1)!.endedAtMs > 3_000) break;
    run.push(stroke);
  }
  if (run.length < 3) return undefined;
  const centers = run.map((stroke) => {
    const a = stroke.points[0]!; const b = stroke.points.at(-1)!;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  });
  const axis = unit({ x: centers.at(-1)!.x - centers[0]!.x, y: centers.at(-1)!.y - centers[0]!.y });
  const span = distance(centers[0]!, centers.at(-1)!);
  if (span < 28) return undefined;
  const normal = { x: -axis.y, y: axis.x };
  let previousProjection = -Infinity;
  for (let index = 0; index < run.length; index += 1) {
    const stroke = run[index]!;
    const a = stroke.points[0]!; const b = stroke.points.at(-1)!;
    const segment = unit({ x: b.x - a.x, y: b.y - a.y });
    const relative = { x: centers[index]!.x - centers[0]!.x, y: centers[index]!.y - centers[0]!.y };
    const projection = dot(relative, axis);
    const alignmentFloor = distance(a, b) < 10 ? 0.55 : 0.84;
    if (Math.abs(dot(segment, axis)) < alignmentFloor || Math.abs(dot(relative, normal)) > 8 || projection + 3 < previousProjection) return undefined;
    previousProjection = projection;
  }
  const first = run[0]!.points[0]!;
  const lastStroke = run.at(-1)!;
  const last = distance(lastStroke.points[0]!, centers.at(-1)!) > distance(lastStroke.points.at(-1)!, centers.at(-1)!) ? lastStroke.points[0]! : lastStroke.points.at(-1)!;
  return { strokes: run, shaftPoints: [first, last], kind: "line", strokeStyle: "dashed" };
}

function nativeConnectorElement(candidate: ConnectorCandidate): ExcalidrawElement {
  const points = simplify(candidate.shaftPoints);
  const box = bounds(points);
  const source = candidate.strokes[0]!;
  const id = `ink-${candidate.kind}-${candidate.strokes.map((stroke) => stroke.strokeId).join("-")}`;
  const localPoints = points.map((point) => [point.x - box.x, point.y - box.y]);
  return {
    ...baseElement(source, id, "hybrid", candidate.kind),
    type: candidate.kind,
    x: box.x,
    y: box.y,
    width: Math.max(1, box.width),
    height: Math.max(1, box.height),
    points: localPoints,
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: candidate.kind === "arrow" ? "arrow" : null,
    ...(candidate.kind === "arrow" ? { elbowed: false } : {}),
    strokeStyle: candidate.strokeStyle,
    roundness: { type: 2 },
    updated: Math.max(...candidate.strokes.map((stroke) => stroke.endedAtMs)),
    customData: { inkrelay: { sourceStrokeIds: candidate.strokes.map((stroke) => stroke.strokeId), projection: "hybrid", kind: candidate.kind, rendererVersion: 2 } }
  } as unknown as ExcalidrawElement;
}

export function recognizeGeometry(points: readonly Point[]): NativeKind | undefined {
  if (points.length < 2) return undefined;
  const box = bounds(points);
  const diagonal = Math.hypot(box.width, box.height);
  const length = pathLength(points);
  if (diagonal < 20 || length < 28) return undefined;

  const endGap = distance(points[0]!, points.at(-1)!);
  const closed = endGap <= Math.max(6, Math.min(diagonal * 0.36, length * 0.22));
  if (!closed) {
    return diagonal >= 28 && distance(points[0]!, points.at(-1)!) / length >= 0.95 ? "line" : undefined;
  }

  if (box.width < 18 || box.height < 18 || points.length < 10) return undefined;
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const rx = box.width / 2;
  const ry = box.height / 2;
  const samples = evenlySample(points, 48);
  const edgeScore = mean(samples.map((point) => Math.min(
    Math.abs(point.x - box.x), Math.abs(point.x - (box.x + box.width)),
    Math.abs(point.y - box.y), Math.abs(point.y - (box.y + box.height))
  ))) / Math.min(box.width, box.height);
  const ellipseScore = mean(samples.map((point) => Math.abs(Math.hypot((point.x - center.x) / rx, (point.y - center.y) / ry) - 1)));
  const idealDiamondScore = mean(samples.map((point) => Math.abs(Math.abs(point.x - center.x) / rx + Math.abs(point.y - center.y) / ry - 1)));
  const diamondScore = Math.min(idealDiamondScore, asymmetricDiamondScore(samples, box));
  const coverage = extremaCoverage(samples, box);
  if (!coverage) return undefined;

  const candidates: { kind: NativeKind; score: number; limit: number }[] = [
    { kind: "rectangle", score: hasCornerCoverage(samples, box) ? edgeScore : Infinity, limit: 0.12 },
    { kind: "ellipse", score: ellipseScore, limit: 0.17 },
    { kind: "diamond", score: diamondScore, limit: 0.15 }
  ];
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0]!.score <= candidates[0]!.limit ? candidates[0]!.kind : undefined;
}

function freedrawElement(stroke: Stroke, mode: ExcalidrawProjectionMode): ExcalidrawElement {
  const box = bounds(stroke.points);
  const points = stroke.points.map((point) => [point.x - box.x, point.y - box.y] as const);
  const hasPressure = stroke.points.some((point) => point.pressure !== undefined);
  const element: ExcalidrawFreeDrawElement = {
    ...baseElement(stroke, `ink-${stroke.strokeId}`, mode, "freedraw"),
    type: "freedraw",
    x: box.x,
    y: box.y,
    width: Math.max(1, box.width),
    height: Math.max(1, box.height),
    points: points as ExcalidrawFreeDrawElement["points"],
    pressures: hasPressure ? stroke.points.map((point) => normalizePressure(point.pressure)) : [],
    simulatePressure: !hasPressure,
    lastCommittedPoint: points.at(-1) as ExcalidrawFreeDrawElement["lastCommittedPoint"],
    roundness: null,
    roughness: 0
  };
  return element;
}

function nativeElement(stroke: Stroke, kind: NativeKind): ExcalidrawElement {
  const box = bounds(stroke.points);
  const id = `ink-${kind}-${stroke.strokeId}`;
  if (kind === "line") {
    const start = stroke.points[0]!;
    const end = stroke.points.at(-1)!;
    const lineBox = bounds([start, end]);
    return {
      ...baseElement(stroke, id, "hybrid", kind),
      type: "line",
      x: lineBox.x,
      y: lineBox.y,
      width: Math.max(1, lineBox.width),
      height: Math.max(1, lineBox.height),
      points: [[start.x - lineBox.x, start.y - lineBox.y], [end.x - lineBox.x, end.y - lineBox.y]],
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: null,
      roundness: { type: 2 }
    } as unknown as ExcalidrawElement;
  }
  return {
    ...baseElement(stroke, id, "hybrid", kind),
    type: kind,
    x: box.x,
    y: box.y,
    width: Math.max(1, box.width),
    height: Math.max(1, box.height),
    backgroundColor: "transparent",
    fillStyle: "hachure",
    roughness: 1,
    roundness: { type: 3 }
  } as ExcalidrawElement;
}

function baseElement(stroke: Stroke, id: string, projection: ExcalidrawProjectionMode, kind: RecognizedInkKind) {
  const seed = stablePositiveInt(id);
  return {
    id,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    angle: 0,
    strokeColor: stroke.style.color,
    backgroundColor: "transparent",
    fillStyle: "hachure" as const,
    strokeWidth: kind === "freedraw" ? Math.max(0.2, stroke.style.width / 4.25) : Math.max(1, stroke.style.width),
    strokeStyle: "solid" as const,
    roughness: 0,
    opacity: Math.round(stroke.style.opacity * 100),
    groupIds: [],
    frameId: null,
    index: null,
    roundness: null,
    seed,
    version: 1,
    versionNonce: seed,
    isDeleted: false,
    boundElements: null,
    updated: stroke.endedAtMs,
    link: null,
    locked: false,
    customData: { inkrelay: { sourceStrokeIds: [stroke.strokeId], projection, kind, rendererVersion: 2 } }
  };
}

function findCompositeRectangles(strokes: readonly Stroke[]): Map<string, readonly Stroke[]> {
  const found = new Map<string, readonly Stroke[]>();
  for (let index = 0; index <= strokes.length - 2; index += 1) {
    for (let size = Math.min(4, strokes.length - index); size >= 2; size -= 1) {
      const group = strokes.slice(index, index + size);
      if (group.some((stroke) => stroke.semanticRole === "action" || stroke.points.length < 2)) continue;
      if (group.at(-1)!.endedAtMs - group[0]!.startedAtMs > 15_000 || !isCompositeRectangle(group)) continue;
      found.set(group[0]!.strokeId, group);
      index += size - 1;
      break;
    }
  }
  return found;
}

function isCompositeRectangle(strokes: readonly Stroke[]): boolean {
  const allPoints = strokes.flatMap((stroke) => [...stroke.points]);
  const box = bounds(allPoints);
  if (box.width < 18 || box.height < 18) return false;
  const samples = evenlySample(allPoints, 64);
  const edgeScore = mean(samples.map((point) => Math.min(
    Math.abs(point.x - box.x), Math.abs(point.x - (box.x + box.width)),
    Math.abs(point.y - box.y), Math.abs(point.y - (box.y + box.height))
  ))) / Math.min(box.width, box.height);
  const perimeter = 2 * (box.width + box.height);
  const totalLength = strokes.reduce((total, stroke) => total + pathLength(stroke.points), 0);
  if (edgeScore > 0.12 || !hasCornerCoverage(samples, box) || totalLength < perimeter * 0.68 || totalLength > perimeter * 1.55) return false;

  const segments = strokes.map((stroke) => {
    const start = stroke.points[0]!;
    const end = stroke.points.at(-1)!;
    const length = pathLength(stroke.points);
    const direct = distance(start, end);
    return { start, end, direct, straightness: direct / Math.max(1, length), horizontal: Math.abs(end.x - start.x) >= Math.abs(end.y - start.y) };
  });
  // Four independently drawn sides get an additional straightness/orientation
  // check. Two- or three-stroke boxes may contain several corners per stroke.
  if (strokes.length === 4 && segments.some((segment) => segment.direct < 12 || segment.straightness < 0.88)) return false;
  const horizontalCount = segments.filter((segment) => segment.horizontal).length;
  if (strokes.length === 4 && horizontalCount !== 2) return false;
  const joinTolerance = Math.max(8, Math.hypot(box.width, box.height) * 0.2);
  return segments.every((segment, index) => segments.some((other, otherIndex) => otherIndex !== index && Math.min(
    distance(segment.start, other.start), distance(segment.start, other.end),
    distance(segment.end, other.start), distance(segment.end, other.end)
  ) <= joinTolerance));
}

function nativeCompositeRectangle(strokes: readonly Stroke[]): ExcalidrawElement {
  const box = bounds(strokes.flatMap((stroke) => [...stroke.points]));
  const source = strokes[0]!;
  const id = `ink-rectangle-${strokes.map((stroke) => stroke.strokeId).join("-")}`;
  return {
    ...baseElement(source, id, "hybrid", "rectangle"),
    type: "rectangle",
    x: box.x,
    y: box.y,
    width: Math.max(1, box.width),
    height: Math.max(1, box.height),
    backgroundColor: "transparent",
    roughness: 1,
    roundness: { type: 3 },
    updated: Math.max(...strokes.map((stroke) => stroke.endedAtMs)),
    customData: { inkrelay: { sourceStrokeIds: strokes.map((stroke) => stroke.strokeId), projection: "hybrid", kind: "rectangle", rendererVersion: 2 } }
  } as ExcalidrawElement;
}

function findCompositeDiamonds(strokes: readonly Stroke[]): Map<string, readonly Stroke[]> {
  const found = new Map<string, readonly Stroke[]>();
  for (let index = 0; index <= strokes.length - 2; index += 1) {
    for (let size = Math.min(4, strokes.length - index); size >= 2; size -= 1) {
      const group = strokes.slice(index, index + size);
      if (group.some((stroke) => stroke.semanticRole === "action" || stroke.points.length < 2)) continue;
      if (group.at(-1)!.endedAtMs - group[0]!.startedAtMs > 15_000 || !isCompositeDiamond(group)) continue;
      found.set(group[0]!.strokeId, group);
      index += size - 1;
      break;
    }
  }
  return found;
}

function isCompositeDiamond(strokes: readonly Stroke[]): boolean {
  const allPoints = strokes.flatMap((stroke) => [...stroke.points]);
  const box = bounds(allPoints);
  // Multi-stroke diamonds need a larger floor than single-stroke shapes so
  // connected letters are not promoted as diagram nodes.
  if (box.width < 60 || box.height < 60) return false;
  if (strokes.some((stroke) => {
    const kind = recognizeGeometry(stroke.points);
    return kind === "rectangle" || kind === "diamond" || kind === "ellipse";
  })) return false;
  const samples = evenlySample(allPoints, 64);
  const vertices = diamondVertices(samples, box);
  if (!vertices || asymmetricDiamondScore(samples, box) > 0.15 || !extremaCoverage(samples, box)) return false;

  const expectedPerimeter = vertices.reduce((total, vertex, index) => total + distance(vertex, vertices[(index + 1) % vertices.length]!), 0);
  const totalLength = strokes.reduce((total, stroke) => total + pathLength(stroke.points), 0);
  if (totalLength < expectedPerimeter * 0.65 || totalLength > expectedPerimeter * 1.55) return false;

  const segments = strokes.map((stroke) => ({
    start: stroke.points[0]!,
    end: stroke.points.at(-1)!,
    straightness: distance(stroke.points[0]!, stroke.points.at(-1)!) / Math.max(1, pathLength(stroke.points))
  }));
  if (strokes.length === 4 && segments.some((segment) => segment.straightness < 0.78)) return false;
  const joinTolerance = Math.max(8, Math.hypot(box.width, box.height) * 0.2);
  return segments.every((segment, index) => segments.some((other, otherIndex) => otherIndex !== index && Math.min(
    distance(segment.start, other.start), distance(segment.start, other.end),
    distance(segment.end, other.start), distance(segment.end, other.end)
  ) <= joinTolerance));
}

function nativeCompositeDiamond(strokes: readonly Stroke[]): ExcalidrawElement {
  const box = bounds(strokes.flatMap((stroke) => [...stroke.points]));
  const source = strokes[0]!;
  const id = `ink-diamond-${strokes.map((stroke) => stroke.strokeId).join("-")}`;
  return {
    ...baseElement(source, id, "hybrid", "diamond"),
    type: "diamond",
    x: box.x,
    y: box.y,
    width: Math.max(1, box.width),
    height: Math.max(1, box.height),
    backgroundColor: "transparent",
    roughness: 1,
    roundness: { type: 3 },
    updated: Math.max(...strokes.map((stroke) => stroke.endedAtMs)),
    customData: { inkrelay: { sourceStrokeIds: strokes.map((stroke) => stroke.strokeId), projection: "hybrid", kind: "diamond", rendererVersion: 2 } }
  } as ExcalidrawElement;
}

function bounds(points: readonly Point[]): Bounds {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const point of points) { minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y); }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function pathLength(points: readonly Point[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += distance(points[index - 1]!, points[index]!);
  return total;
}

function distance(a: Point, b: Point): number { return Math.hypot(a.x - b.x, a.y - b.y); }
function mean(values: readonly number[]): number { return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length); }
function normalizePressure(value: number | undefined): number { return value === undefined ? 0.5 : Math.max(0.01, Math.min(1, value > 1 ? value / 1023 : value)); }
function dot(a: Point, b: Point): number { return a.x * b.x + a.y * b.y; }
function unit(vector: Point): Point { const length = Math.hypot(vector.x, vector.y) || 1; return { x: vector.x / length, y: vector.y / length }; }

function simplify(points: readonly Point[]): readonly Point[] {
  if (points.length <= 2) return points;
  const tolerance = Math.max(0.8, Math.hypot(bounds(points).width, bounds(points).height) * 0.012);
  let farthestDistance = 0;
  let farthestIndex = 0;
  const start = points[0]!; const end = points.at(-1)!;
  for (let index = 1; index < points.length - 1; index += 1) {
    const candidateDistance = pointToSegmentDistance(points[index]!, start, end);
    if (candidateDistance > farthestDistance) { farthestDistance = candidateDistance; farthestIndex = index; }
  }
  if (farthestDistance <= tolerance) return [start, end];
  return [...simplify(points.slice(0, farthestIndex + 1)), ...simplify(points.slice(farthestIndex)).slice(1)];
}

function pointToSegmentDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x; const dy = end.y - start.y;
  const denominator = dx * dx + dy * dy;
  if (!denominator) return distance(point, start);
  const amount = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / denominator));
  return distance(point, { x: start.x + dx * amount, y: start.y + dy * amount });
}

function evenlySample(points: readonly Point[], count: number): readonly Point[] {
  if (points.length <= count) return points;
  return Array.from({ length: count }, (_, index) => points[Math.round(index * (points.length - 1) / (count - 1))]!);
}

function extremaCoverage(points: readonly Point[], box: Bounds): boolean {
  const marginX = box.width * 0.14;
  const marginY = box.height * 0.14;
  return points.some((point) => point.x <= box.x + marginX)
    && points.some((point) => point.x >= box.x + box.width - marginX)
    && points.some((point) => point.y <= box.y + marginY)
    && points.some((point) => point.y >= box.y + box.height - marginY);
}

function hasCornerCoverage(points: readonly Point[], box: Bounds): boolean {
  // Real pen rectangles commonly stop just before a corner or meet it at a
  // slight slant. Edge fit and perimeter coverage still guard against turning
  // arbitrary open handwriting into a rectangle.
  const tolerance = Math.hypot(box.width, box.height) * 0.17;
  const corners = [
    { x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }
  ];
  return corners.every((corner) => points.some((point) => distance(corner, point) <= tolerance));
}

function asymmetricDiamondScore(points: readonly Point[], box: Bounds): number {
  const vertices = diamondVertices(points, box);
  if (!vertices) return Infinity;
  const [top, right, bottom, left] = vertices;

  return mean(points.map((point) => Math.min(
    pointToSegmentDistance(point, top, right),
    pointToSegmentDistance(point, right, bottom),
    pointToSegmentDistance(point, bottom, left),
    pointToSegmentDistance(point, left, top)
  ))) / Math.min(box.width, box.height);
}

function diamondVertices(points: readonly Point[], box: Bounds): readonly [Point, Point, Point, Point] | undefined {
  const top = points.reduce((best, point) => point.y < best.y ? point : best);
  const right = points.reduce((best, point) => point.x > best.x ? point : best);
  const bottom = points.reduce((best, point) => point.y > best.y ? point : best);
  const left = points.reduce((best, point) => point.x < best.x ? point : best);
  const vertices = [top, right, bottom, left];
  if (new Set(vertices).size < 4) return undefined;

  const normalized = {
    topX: (top.x - box.x) / box.width,
    rightY: (right.y - box.y) / box.height,
    bottomX: (bottom.x - box.x) / box.width,
    leftY: (left.y - box.y) / box.height
  };
  if (Object.values(normalized).some((value) => value < 0.15 || value > 0.85)) return undefined;
  return vertices as [Point, Point, Point, Point];
}

function stablePositiveInt(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0) || 1;
}
