import type { SmartpenPage, Stroke } from "@inkrelay/core";

export type ReplayEntry = {
  readonly stroke: Stroke;
  readonly startMs: number;
  readonly durationMs: number;
};

export type ReplayTimeline = {
  readonly entries: readonly ReplayEntry[];
  readonly durationMs: number;
};

const MIN_STROKE_MS = 80;
const MAX_STROKE_MS = 3_000;
const MIN_GAP_MS = 40;
const MAX_GAP_MS = 600;

export function createReplayTimeline(page: SmartpenPage): ReplayTimeline {
  const strokes = [...page.strokes]
    .filter((stroke) => stroke.semanticRole !== "action" && stroke.points.length > 0)
    .sort((a, b) => a.startedAtMs - b.startedAtMs || a.strokeId.localeCompare(b.strokeId));
  const entries: ReplayEntry[] = [];
  let cursor = 0;
  for (let index = 0; index < strokes.length; index += 1) {
    const stroke = strokes[index]!;
    if (index > 0) {
      const previous = strokes[index - 1]!;
      cursor += clamp(stroke.startedAtMs - previous.endedAtMs, MIN_GAP_MS, MAX_GAP_MS);
    }
    const pointDuration = stroke.points.at(-1)?.tMs ?? 0;
    const durationMs = clamp(Math.max(pointDuration, stroke.endedAtMs - stroke.startedAtMs), MIN_STROKE_MS, MAX_STROKE_MS);
    entries.push({ stroke, startMs: cursor, durationMs });
    cursor += durationMs;
  }
  return { entries, durationMs: cursor };
}

export function formatReplayTime(valueMs: number): string {
  const totalSeconds = Math.max(0, Math.round(valueMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function replayPointAt(timeline: ReplayTimeline, positionMs: number): { readonly x: number; readonly y: number } | undefined {
  let current: ReplayEntry | undefined;
  for (const entry of timeline.entries) {
    if (positionMs < entry.startMs) break;
    current = entry;
  }
  if (!current) return undefined;
  const progress = clamp((positionMs - current.startMs) / current.durationMs, 0, 1);
  const points = current.stroke.points;
  const first = points[0];
  if (!first) return undefined;
  if (points.length === 1 || progress <= 0) return { x: first.x, y: first.y };
  const last = points.at(-1)!;
  if (progress >= 1) return { x: last.x, y: last.y };
  const sourceDuration = Math.max(1, last.tMs || points.length - 1);
  const targetTime = progress * sourceDuration;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const point = points[index]!;
    const previousTime = previous.tMs || (index - 1) / (points.length - 1) * sourceDuration;
    const pointTime = point.tMs || index / (points.length - 1) * sourceDuration;
    if (pointTime < targetTime) continue;
    const amount = (targetTime - previousTime) / Math.max(1, pointTime - previousTime);
    return { x: previous.x + (point.x - previous.x) * amount, y: previous.y + (point.y - previous.y) * amount };
  }
  return { x: last.x, y: last.y };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
