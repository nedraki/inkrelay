import { readFile } from "node:fs/promises";
import type { PaperAction, PaperActionKind, PenSessionState, Stroke } from "@inkrelay/core";

export type ActionZone = {
  readonly zoneId: string;
  readonly label: string;
  readonly pageScope: "all_pages" | { readonly notebookId: string; readonly pageIds: readonly number[] };
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly maxStrokeLength?: number;
  readonly passthroughInk?: boolean;
  readonly action: { readonly kind: PaperActionKind; readonly payload: Readonly<Record<string, unknown>> };
};

export type ActionZoneConfig = { readonly schema_version: "smartpen.action_zones.v1"; readonly zones: readonly ActionZone[] };
export type ActionRouteResult = { readonly stroke: Stroke; readonly actions: readonly PaperAction[]; readonly state: PenSessionState };

export class ActionRouter {
  constructor(private readonly zones: readonly ActionZone[]) {}

  static async fromFile(path: string): Promise<ActionRouter> {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ActionZoneConfig;
    if (parsed.schema_version !== "smartpen.action_zones.v1" || !Array.isArray(parsed.zones)) throw new Error("Unsupported action-zone config");
    return new ActionRouter(parsed.zones);
  }

  route(stroke: Stroke, state: PenSessionState): ActionRouteResult {
    const zones = this.zones.filter((zone) => scopeMatches(zone, stroke) && activates(zone, stroke));
    if (zones.length === 0) return { stroke, actions: [], state };

    let next = state;
    const actions = zones.map((zone, index): PaperAction => {
      const action: PaperAction = {
        actionId: `act_${stroke.strokeId}_${String(index + 1).padStart(2, "0")}`,
        kind: zone.action.kind,
        notebookId: stroke.notebookId,
        ...(stroke.physicalNotebookId ? { physicalNotebookId: stroke.physicalNotebookId } : {}),
        pageId: stroke.pageId,
        createdAtMs: stroke.endedAtMs,
        strokeId: stroke.strokeId,
        payload: { ...zone.action.payload, zoneId: zone.zoneId, label: zone.label }
      };
      next = applyAction(next, action);
      return action;
    });
    const passthrough = zones.some((zone) => zone.passthroughInk);
    return { stroke: { ...stroke, semanticRole: passthrough ? "ink_and_action" : "action" }, actions, state: next };
  }
}

function scopeMatches(zone: ActionZone, stroke: Stroke): boolean {
  return zone.pageScope === "all_pages" ||
    (zone.pageScope.notebookId === stroke.notebookId && zone.pageScope.pageIds.includes(stroke.pageId));
}

function activates(zone: ActionZone, stroke: Stroke): boolean {
  if (stroke.points.length === 0) return false;
  const { x, y, width, height } = zone.bounds;
  const contained = stroke.points.every((point) => point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height);
  if (!contained) return false;
  let length = 0;
  for (let index = 1; index < stroke.points.length; index++) {
    const previous = stroke.points[index - 1];
    const current = stroke.points[index];
    if (previous && current) length += Math.hypot(current.x - previous.x, current.y - previous.y);
  }
  return length <= (zone.maxStrokeLength ?? 80);
}

function applyAction(state: PenSessionState, action: PaperAction): PenSessionState {
  if (action.kind === "set_color" && typeof action.payload.color === "string") return { ...state, currentColor: action.payload.color };
  if (action.kind === "set_width" && typeof action.payload.width === "number") return { ...state, currentWidth: action.payload.width };
  if (action.kind === "mark_important") {
    const key = `${action.physicalNotebookId ?? action.notebookId}:${action.pageId}`;
    return state.importantPages.includes(key) ? state : { ...state, importantPages: [...state.importantPages, key] };
  }
  if (action.kind === "mark_todo" || action.kind === "ai_stub") {
    return { ...state, pendingAction: { kind: action.kind, createdAtMs: action.createdAtMs, payload: action.payload } };
  }
  return state;
}
