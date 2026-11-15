export const PEN_EVENT_SCHEMA_VERSION = "inkrelay.pen_event.v1" as const;

export type PenDotEvent = {
  readonly schemaVersion: typeof PEN_EVENT_SCHEMA_VERSION;
  readonly eventType: "pen_down" | "pen_move" | "pen_up";
  readonly source: "web_bluetooth" | "native_bridge" | "replay" | "mock";
  readonly sessionId: string;
  readonly penId: string;
  readonly sequence: number;
  readonly timestampMs: number;
  readonly notebookId: string;
  readonly pageId: number;
  readonly x: number;
  readonly y: number;
  readonly pressure?: number | undefined;
  readonly color?: string | undefined;
  readonly coordinateSpace: "app_px";
};

export type StrokePoint = {
  readonly x: number;
  readonly y: number;
  readonly tMs: number;
  readonly pressure?: number | undefined;
};

export type StrokeStyle = {
  readonly color: string;
  readonly width: number;
  readonly opacity: number;
};

export type Stroke = {
  readonly strokeId: string;
  readonly notebookId: string;
  readonly physicalNotebookId?: string;
  readonly pageId: number;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly style: StrokeStyle;
  readonly points: readonly StrokePoint[];
  readonly semanticRole: "ink" | "action" | "ink_and_action";
};

export type PaperActionKind =
  | "set_color"
  | "set_width"
  | "mark_important"
  | "mark_todo"
  | "select_region"
  | "export_page"
  | "ai_stub";

export type PaperAction = {
  readonly actionId: string;
  readonly kind: PaperActionKind;
  readonly notebookId: string;
  readonly physicalNotebookId?: string;
  readonly pageId: number;
  readonly createdAtMs: number;
  readonly strokeId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type PenSessionState = {
  readonly currentColor: string;
  readonly currentWidth: number;
  readonly currentTool: "pen" | "highlighter" | "selector" | "eraser";
  readonly importantPages: readonly string[];
  readonly pendingAction?: {
    readonly kind: "mark_todo" | "ai_stub";
    readonly createdAtMs: number;
    readonly payload?: Readonly<Record<string, unknown>>;
  };
};

export type SmartpenPage = {
  readonly notebookId: string;
  readonly physicalNotebookId?: string;
  readonly physicalNotebookName?: string;
  readonly pageId: number;
  readonly width: number;
  readonly height: number;
  readonly unit: "app_px";
  readonly strokes: readonly Stroke[];
  readonly actions: readonly PaperAction[];
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
};

export const DEFAULT_SESSION_STATE: PenSessionState = {
  currentColor: "#111111",
  currentWidth: 2,
  currentTool: "pen",
  importantPages: []
};

export interface OCRAdapter {
  recognize(page: SmartpenPage): Promise<{ readonly text: string; readonly confidence?: number }>;
}
export interface HermesAgentAdapter { run(input: unknown): Promise<unknown>; }
export interface VisionModelAdapter { analyze(page: SmartpenPage): Promise<unknown>; }
export interface ExcalidrawProjectionAdapter { project(page: SmartpenPage): Promise<unknown>; }
export interface GestureRecognizer { recognize(stroke: Stroke): Promise<PaperAction | undefined>; }
export interface SpreadMapper { map(pages: readonly SmartpenPage[]): Promise<unknown>; }
export interface CalibrationProfile { readonly profileId: string; normalize(x: number, y: number): { x: number; y: number }; }
export interface AIActionAdapter {
  runAction(input: {
    readonly action: PaperAction;
    readonly page: SmartpenPage;
    readonly selectedStrokeIds?: readonly string[];
  }): Promise<{ readonly markdown: string; readonly metadata: Readonly<Record<string, unknown>> }>;
}
