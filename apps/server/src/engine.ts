import { resolve } from "node:path";
import { ActionRouter } from "@inkrelay/action-router";
import {
  DEFAULT_SESSION_STATE, PageMapper, StrokeBuilder, emptyPage, penDotEventSchema,
  type PaperDefinition, type PaperProfile, type PenDotEvent, type PenSessionState, type SmartpenPage, type Stroke, type StrokeStyle
} from "@inkrelay/core";
import { ObsidianWriter, RawEventStore, type ExportResult, type LanguageReviewExportResult } from "@inkrelay/obsidian-writer";
import { SVGRenderer } from "@inkrelay/render-svg";
import { WorkflowStore, intentFromAction, type LanguageReview, type WorkflowIntent } from "@inkrelay/workflows";
import {
  NotebookInstanceStore, type NotebookInstancesCatalog, type NotebookReassignment, type NotebookReassignmentInput, type PhysicalNotebook
} from "./notebook-instance-store.js";

export type InkRelayConfig = {
  readonly canonicalDataPath: string;
  readonly vaultPath: string;
  readonly actionZonesPath: string;
  readonly paperProfilesPath?: string;
  readonly paperDefinitionsPath?: string;
  readonly notebookInstancesPath?: string;
  readonly pageWidth?: number;
  readonly pageHeight?: number;
};

export type EngineSnapshot = {
  readonly state: PenSessionState;
  readonly pages: readonly SmartpenPage[];
  readonly warnings: readonly string[];
  readonly recentActions: SmartpenPage["actions"];
  readonly workflows: readonly WorkflowIntent[];
  readonly physicalNotebooks: NotebookInstancesCatalog;
};

export type PhysicalNotebookCaptureRange = {
  readonly paperIdentity: string;
  readonly penId: string;
  readonly sessionId: string;
  readonly pageId: number;
  readonly startSequence: number;
  readonly endSequence: number;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly eventCount: number;
  readonly strokeCount: number;
  readonly instanceId: string;
};

export type InkStyleUpdate = {
  readonly color?: string;
  readonly width?: number;
};

export class InkRelayEngine {
  private state: PenSessionState = DEFAULT_SESSION_STATE;
  private readonly pages = new Map<string, SmartpenPage>();
  private readonly builders = new Map<string, StrokeBuilder>();
  private readonly processedEvents = new Set<string>();
  private readonly warnings: string[] = [];
  private readonly workflowIntents: WorkflowIntent[] = [];
  private readonly listeners = new Set<(snapshot: EngineSnapshot) => void>();
  private readonly mapper: PageMapper;
  private readonly rawStore: RawEventStore;
  private readonly workflowStore: WorkflowStore;
  private readonly notebookInstances: NotebookInstanceStore;
  private readonly renderer = new SVGRenderer();
  private vaultPath: string;
  private ingestionTail: Promise<void> = Promise.resolve();
  private router!: ActionRouter;

  constructor(private readonly config: InkRelayConfig) {
    this.mapper = new PageMapper({ width: config.pageWidth ?? 1480, height: config.pageHeight ?? 2100, unit: "app_px" });
    this.rawStore = new RawEventStore(config.canonicalDataPath);
    this.workflowStore = new WorkflowStore(resolve(config.canonicalDataPath, "..", "workflow"));
    this.notebookInstances = new NotebookInstanceStore(config.notebookInstancesPath ?? resolve(config.canonicalDataPath, "..", "notebook-instances.json"));
    this.vaultPath = config.vaultPath;
  }

  async initialize(): Promise<void> {
    this.router = await ActionRouter.fromFile(this.config.actionZonesPath);
    await this.notebookInstances.initialize();
    for (const input of await this.rawStore.allEvents()) {
      const event = penDotEventSchema.parse(input);
      const identity = eventIdentity(event);
      if (this.processedEvents.has(identity)) continue;
      this.processedEvents.add(identity);
      await this.project(event, await this.notebookInstances.resolveRecorded(event));
    }
  }

  ingest(input: unknown): Promise<{ readonly accepted: boolean; readonly stroke?: Stroke }> {
    const task = this.ingestionTail.then(() => this.ingestSerial(input));
    this.ingestionTail = task.then(() => undefined, () => undefined);
    return task;
  }

  updateInkStyle(update: InkStyleUpdate): Promise<PenSessionState> {
    const task = this.ingestionTail.then(() => {
      if (update.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(update.color)) throw new Error("color must be a six-digit hex value");
      if (update.width !== undefined && (!Number.isFinite(update.width) || update.width < 0.5 || update.width > 12)) throw new Error("width must be between 0.5 and 12");
      if (update.color === undefined && update.width === undefined) throw new Error("color or width is required");
      this.state = {
        ...this.state,
        ...(update.color === undefined ? {} : { currentColor: update.color.toLowerCase() }),
        ...(update.width === undefined ? {} : { currentWidth: update.width })
      };
      this.emit();
      return this.state;
    });
    this.ingestionTail = task.then(() => undefined, () => undefined);
    return task;
  }

  private async ingestSerial(input: unknown): Promise<{ readonly accepted: boolean; readonly stroke?: Stroke }> {
    const event = penDotEventSchema.parse(input);
    const identity = eventIdentity(event);
    const stored = await this.rawStore.append(event);
    if (stored === "duplicate") {
      if (this.processedEvents.has(identity)) return { accepted: false };
      this.processedEvents.add(identity);
      await this.project(event, await this.notebookInstances.resolveRecorded(event));
      return { accepted: false };
    }
    if (stored === "enriched") {
      if (this.processedEvents.has(identity)) await this.applyEnrichment(event);
      else { this.processedEvents.add(identity); await this.project(event, await this.notebookInstances.resolveRecorded(event)); }
      return { accepted: false };
    }
    this.processedEvents.add(identity);

    return { accepted: true, ...(await this.project(event, await this.notebookInstances.assignIncoming(event))) };
  }

  private async applyEnrichment(event: PenDotEvent): Promise<void> {
    if (event.eventType !== "pen_down" || !event.color) return;
    const instance = await this.notebookInstances.resolveRecorded(event);
    const key = pageKey(event.notebookId, event.pageId, instance.instanceId);
    const page = this.pages.get(key);
    if (!page) return;
    const strokeId = deterministicStrokeId(event);
    let changed = false;
    const strokes = page.strokes.map((stroke) => {
      if (stroke.strokeId !== strokeId || stroke.style.color === event.color) return stroke;
      changed = true;
      return { ...stroke, style: { ...stroke.style, color: event.color! } };
    });
    if (changed) { this.pages.set(key, { ...page, strokes }); this.emit(); }
  }

  private async project(event: PenDotEvent, instance: PhysicalNotebook, notify = true): Promise<{ readonly stroke?: Stroke }> {
    const builder = this.builderFor(event, instance.instanceId);
    const completed = builder.process(event);
    // Pages only change when a stroke completes. Emitting the full page corpus
    // for every pen_down/pen_move floods SSE clients during offline imports.
    if (!completed) return {};

    const projected = this.mapper.projectStroke(event.notebookId, completed);
    const routed = this.router.route({ ...projected, physicalNotebookId: instance.instanceId }, this.state);
    this.state = routed.state;
    const key = pageKey(event.notebookId, event.pageId, instance.instanceId);
    const current = this.pages.get(key) ?? {
      ...emptyPage(event.notebookId, event.pageId, this.mapper.dimensionsFor(event.notebookId, event.pageId), event.timestampMs),
      physicalNotebookId: instance.instanceId,
      physicalNotebookName: instance.displayName
    };
    const page: SmartpenPage = {
      ...current,
      strokes: [...current.strokes, routed.stroke],
      actions: [...current.actions, ...routed.actions],
      updatedAtMs: event.timestampMs
    };
    this.pages.set(key, page);
    for (const action of routed.actions) {
      const intent = intentFromAction(action, Date.now());
      if (intent) {
        if (!this.workflowIntents.some((candidate) => candidate.intentId === intent.intentId)) this.workflowIntents.push(intent);
        await this.workflowStore.enqueue(intent);
      }
    }
    if (notify) this.emit();
    return { stroke: routed.stroke };
  }

  async ingestMany(inputs: readonly unknown[]): Promise<{ readonly accepted: number; readonly duplicates: number }> {
    const events = inputs.map((input) => penDotEventSchema.parse(input)).sort((a, b) => a.timestampMs - b.timestampMs || a.sequence - b.sequence);
    let accepted = 0;
    for (const event of events) if ((await this.ingest(event)).accepted) accepted++;
    return { accepted, duplicates: events.length - accepted };
  }

  page(notebookId: string, pageId: number, physicalNotebookId = notebookId): SmartpenPage | undefined { return this.pages.get(pageKey(notebookId, pageId, physicalNotebookId)); }
  svg(notebookId: string, pageId: number, physicalNotebookId?: string): string | undefined { const page = this.page(notebookId, pageId, physicalNotebookId); return page ? this.renderer.render(page) : undefined; }

  async export(notebookId: string, pageId: number, physicalNotebookId?: string): Promise<ExportResult> {
    const page = this.page(notebookId, pageId, physicalNotebookId);
    if (!page) throw new Error(`Unknown page ${notebookId}/${pageId}`);
    const events = await this.eventsForPhysicalPage(page);
    return new ObsidianWriter(this.vaultPath, this.renderer).exportPage(page, events);
  }

  async exportLanguageReview(notebookId: string, pageId: number, review: LanguageReview, physicalNotebookId?: string): Promise<LanguageReviewExportResult> {
    const page = this.page(notebookId, pageId, physicalNotebookId);
    if (!page) throw new Error(`Unknown page ${notebookId}/${pageId}`);
    return new ObsidianWriter(this.vaultPath, this.renderer).exportLanguageReview(page, review);
  }

  setVaultPath(vaultPath: string): void { this.vaultPath = vaultPath; }

  setPaperProfiles(profiles: readonly PaperProfile[]): void {
    this.updatePaperMapping(() => this.mapper.replaceProfiles(profiles));
  }

  setPaperDefinitions(definitions: readonly PaperDefinition[]): void {
    this.updatePaperMapping(() => this.mapper.replaceDefinitions(definitions));
  }

  private updatePaperMapping(update: () => void): void {
    const previous = new Map([...this.pages].map(([key, page]) => [key, this.mapper.mappingFor(page.notebookId, page.pageId).transform]));
    update();
    for (const [key, page] of this.pages) {
      const dimensions = this.mapper.dimensionsFor(page.notebookId, page.pageId);
      const strokes = page.strokes.map((stroke) => this.mapper.reprojectWithTransform(page.notebookId, stroke, previous.get(key)));
      this.pages.set(key, { ...page, ...dimensions, strokes });
    }
    this.emit();
  }

  paperProfile(notebookId: string): PaperProfile | undefined { return this.mapper.profileFor(notebookId); }
  paperMapping(notebookId: string, pageId: number): ReturnType<PageMapper["mappingFor"]> { return this.mapper.mappingFor(notebookId, pageId); }
  fallbackPageDimensions(): { readonly width: number; readonly height: number; readonly unit: "app_px" } { return this.mapper.fallbackDimensions(); }

  async createPhysicalNotebook(paperIdentity: string, displayName: string): Promise<PhysicalNotebook> {
    const instance = await this.notebookInstances.create(paperIdentity, displayName);
    this.emit();
    return instance;
  }

  async renamePhysicalNotebook(instanceId: string, displayName: string): Promise<PhysicalNotebook> {
    const instance = await this.notebookInstances.rename(instanceId, displayName);
    for (const [key, page] of this.pages) if ((page.physicalNotebookId ?? page.notebookId) === instanceId) this.pages.set(key, { ...page, physicalNotebookName: instance.displayName });
    this.emit();
    return instance;
  }

  async activatePhysicalNotebook(instanceId: string): Promise<PhysicalNotebook> {
    const instance = await this.notebookInstances.activate(instanceId);
    this.emit();
    return instance;
  }

  async archivePhysicalNotebook(instanceId: string): Promise<PhysicalNotebook> {
    const instance = await this.notebookInstances.archive(instanceId);
    this.emit();
    return instance;
  }

  async restorePhysicalNotebook(instanceId: string): Promise<PhysicalNotebook> {
    const instance = await this.notebookInstances.restore(instanceId);
    this.emit();
    return instance;
  }

  async physicalNotebookCaptureRanges(paperIdentity: string): Promise<readonly PhysicalNotebookCaptureRange[]> {
    const events = (await this.rawStore.allEvents()).filter((event) => event.notebookId === paperIdentity)
      .sort((left, right) => left.penId.localeCompare(right.penId) || left.sessionId.localeCompare(right.sessionId) || left.sequence - right.sequence);
    const ranges: PhysicalNotebookCaptureRange[] = [];
    let previousProvenanceId: string | undefined;
    for (const event of events) {
      const resolution = await this.notebookInstances.resolveRecordedWithProvenance(event);
      const instance = resolution.instance;
      const previous = ranges.at(-1);
      if (previous && previous.penId === event.penId && previous.sessionId === event.sessionId && previous.pageId === event.pageId
        && previous.instanceId === instance.instanceId && previousProvenanceId === resolution.provenanceId && event.sequence === previous.endSequence + 1) {
        ranges[ranges.length - 1] = {
          ...previous, endSequence: event.sequence, endedAtMs: event.timestampMs,
          eventCount: previous.eventCount + 1, strokeCount: previous.strokeCount + (event.eventType === "pen_up" ? 1 : 0)
        };
      } else {
        ranges.push({
          paperIdentity, penId: event.penId, sessionId: event.sessionId, pageId: event.pageId,
          startSequence: event.sequence, endSequence: event.sequence, startedAtMs: event.timestampMs, endedAtMs: event.timestampMs,
          eventCount: 1, strokeCount: event.eventType === "pen_up" ? 1 : 0, instanceId: instance.instanceId
        });
      }
      previousProvenanceId = resolution.provenanceId;
    }
    return ranges.sort((left, right) => right.endedAtMs - left.endedAtMs || right.endSequence - left.endSequence);
  }

  reassignPhysicalNotebookCapture(input: NotebookReassignmentInput): Promise<NotebookReassignment> {
    const task = this.ingestionTail.then(() => this.reassignPhysicalNotebookCaptureSerial(input));
    this.ingestionTail = task.then(() => undefined, () => undefined);
    return task;
  }

  private async reassignPhysicalNotebookCaptureSerial(input: NotebookReassignmentInput): Promise<NotebookReassignment> {
    const currentRange = (await this.physicalNotebookCaptureRanges(input.paperIdentity)).find((range) => range.penId === input.penId
      && range.sessionId === input.sessionId && range.pageId === input.pageId && range.startSequence === input.startSequence
      && range.endSequence === input.endSequence && range.instanceId === input.fromInstanceId);
    if (!currentRange) throw new Error("Capture range changed; refresh it before reassigning");
    const events = (await this.rawStore.allEvents()).filter((event) => event.notebookId === input.paperIdentity
      && event.penId === input.penId && event.sessionId === input.sessionId && event.pageId === input.pageId
      && event.sequence >= input.startSequence && event.sequence <= input.endSequence);
    if (events.length === 0) throw new Error("Capture range does not contain any canonical events");
    for (const event of events) {
      const current = await this.notebookInstances.resolveRecorded(event);
      if (current.instanceId !== input.fromInstanceId) throw new Error("Capture range changed; refresh it before reassigning");
    }
    const reassignment = await this.notebookInstances.reassign(input);
    await this.rebuildFromCanonicalEvents();
    return reassignment;
  }

  snapshot(): EngineSnapshot {
    const pages = [...this.pages.values()].sort((a, b) => a.notebookId.localeCompare(b.notebookId)
      || (a.physicalNotebookId ?? a.notebookId).localeCompare(b.physicalNotebookId ?? b.notebookId) || a.pageId - b.pageId);
    return { state: this.state, pages, warnings: [...this.warnings], recentActions: pages.flatMap((page) => page.actions).slice(-20), workflows: [...this.workflowIntents], physicalNotebooks: this.notebookInstances.snapshot() };
  }
  clearDebugState(): void { this.pages.clear(); this.builders.clear(); this.processedEvents.clear(); this.workflowIntents.length = 0; this.state = DEFAULT_SESSION_STATE; this.warnings.length = 0; this.emit(); }
  subscribe(listener: (snapshot: EngineSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  private builderFor(event: PenDotEvent, physicalNotebookId: string): StrokeBuilder {
    const key = `${event.penId}\u0000${event.sessionId}\u0000${physicalNotebookId}`;
    let builder = this.builders.get(key);
    if (!builder) {
      builder = new StrokeBuilder({
        getStyle: (styleEvent): StrokeStyle => ({ color: styleEvent.color ?? this.state.currentColor, width: this.state.currentWidth, opacity: this.state.currentTool === "highlighter" ? 0.4 : 1 }),
        onWarning: (message, warningEvent) => { this.warnings.push(`${warningEvent.sessionId}:${warningEvent.sequence} ${message}`); this.warnings.splice(0, Math.max(0, this.warnings.length - 100)); }
      });
      this.builders.set(key, builder);
    }
    return builder;
  }
  private async eventsForPhysicalPage(page: SmartpenPage): Promise<PenDotEvent[]> {
    const physicalNotebookId = page.physicalNotebookId ?? page.notebookId;
    const events = await this.rawStore.eventsForPage(page.notebookId, page.pageId);
    const matching: PenDotEvent[] = [];
    for (const event of events) if ((await this.notebookInstances.resolveRecorded(event)).instanceId === physicalNotebookId) matching.push(event);
    return matching;
  }
  private async rebuildFromCanonicalEvents(): Promise<void> {
    this.pages.clear();
    this.builders.clear();
    this.processedEvents.clear();
    this.workflowIntents.length = 0;
    this.state = DEFAULT_SESSION_STATE;
    this.warnings.length = 0;
    for (const input of await this.rawStore.allEvents()) {
      const event = penDotEventSchema.parse(input);
      const identity = eventIdentity(event);
      if (this.processedEvents.has(identity)) continue;
      this.processedEvents.add(identity);
      await this.project(event, await this.notebookInstances.resolveRecorded(event), false);
    }
    this.emit();
  }
  private emit(): void { const snapshot = this.snapshot(); for (const listener of this.listeners) listener(snapshot); }
}

function pageKey(notebookId: string, pageId: number, physicalNotebookId = notebookId): string { return `${notebookId}\u0000${physicalNotebookId}\u0000${pageId}`; }
function eventIdentity(event: PenDotEvent): string { return `${event.penId}\u0000${event.sessionId}\u0000${event.sequence}`; }
function deterministicStrokeId(event: PenDotEvent): string {
  const safeSession = event.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `s_${safeSession}_${String(event.sequence).padStart(6, "0")}`;
}
