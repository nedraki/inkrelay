import type { PenDotEvent, Stroke, StrokePoint, StrokeStyle } from "./types.js";

type ActiveStroke = {
  readonly first: PenDotEvent;
  readonly style: StrokeStyle;
  readonly points: PenDotEvent[];
};

export type StrokeBuilderOptions = {
  readonly getStyle: (event: PenDotEvent) => StrokeStyle;
  readonly onWarning?: (message: string, event: PenDotEvent) => void;
};

export class StrokeBuilder {
  private active: ActiveStroke | undefined;

  constructor(private readonly options: StrokeBuilderOptions) {}

  process(event: PenDotEvent): Stroke | undefined {
    if (event.eventType === "pen_down") {
      if (this.active) this.warn("pen_down received while a stroke was active; incomplete stroke discarded", event);
      this.active = { first: event, style: { ...this.options.getStyle(event) }, points: [event] };
      return undefined;
    }

    if (!this.active) {
      this.warn(`${event.eventType} received without an active stroke; event ignored`, event);
      return undefined;
    }

    if (this.active.first.notebookId !== event.notebookId || this.active.first.pageId !== event.pageId) {
      this.warn("page changed during an active stroke; incomplete stroke discarded", event);
      this.active = undefined;
      return undefined;
    }

    this.active.points.push(event);
    if (event.eventType === "pen_move") return undefined;

    const active = this.active;
    this.active = undefined;
    const points: StrokePoint[] = active.points.map((point) => ({
      x: point.x,
      y: point.y,
      tMs: point.timestampMs - active.first.timestampMs,
      ...(point.pressure === undefined ? {} : { pressure: point.pressure })
    }));
    return {
      strokeId: deterministicStrokeId(active.first),
      notebookId: active.first.notebookId,
      pageId: active.first.pageId,
      startedAtMs: active.first.timestampMs,
      endedAtMs: event.timestampMs,
      style: active.style,
      points,
      semanticRole: "ink"
    };
  }

  reset(): void { this.active = undefined; }

  private warn(message: string, event: PenDotEvent): void { this.options.onWarning?.(message, event); }
}

function deterministicStrokeId(event: PenDotEvent): string {
  const safeSession = event.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `s_${safeSession}_${String(event.sequence).padStart(6, "0")}`;
}
