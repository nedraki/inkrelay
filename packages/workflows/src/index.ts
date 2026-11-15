import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PaperAction, SmartpenPage } from "@inkrelay/core";
import { Agent, fetch as undiciFetch } from "undici";
import { z } from "zod";

export type WorkflowKind = "summarize" | "extract_tasks" | "create_links" | "custom";
export type WorkflowIntent = {
  readonly schemaVersion: "inkrelay.workflow_intent.v1";
  readonly intentId: string;
  readonly actionId: string;
  readonly notebookId: string;
  readonly physicalNotebookId?: string;
  readonly pageId: number;
  readonly kind: WorkflowKind;
  readonly requestedAtMs: number;
  readonly importedAtMs: number;
  readonly inputScope: { readonly type: "page" | "region" | "strokes"; readonly strokeIds?: readonly string[] };
  readonly payload: Readonly<Record<string, unknown>>;
};

export type WorkflowRunStatus = "queued" | "waiting_for_model" | "running" | "completed" | "failed" | "cancelled";
export type WorkflowRun = {
  readonly schemaVersion: "inkrelay.workflow_run.v1";
  readonly runId: string;
  readonly intentId: string;
  readonly status: WorkflowRunStatus;
  readonly attempts: number;
  readonly updatedAtMs: number;
  readonly outputFiles: readonly string[];
  readonly error?: string;
};

export type WorkflowContext = { readonly page: SmartpenPage };
export type WorkflowResult = { readonly markdown: string; readonly metadata: Readonly<Record<string, unknown>> };
export interface WorkflowExecutor {
  canExecute(intent: WorkflowIntent): Promise<boolean>;
  execute(intent: WorkflowIntent, context: WorkflowContext): Promise<WorkflowResult>;
}

export function intentFromAction(action: PaperAction, importedAtMs: number): WorkflowIntent | undefined {
  if (action.kind !== "ai_stub") return undefined;
  const requested = String(action.payload.futureAction ?? "custom");
  const kind: WorkflowKind = requested === "summarize" || requested === "extract_tasks" || requested === "create_links" ? requested : "custom";
  return {
    schemaVersion: "inkrelay.workflow_intent.v1",
    intentId: `intent_${action.actionId}`,
    actionId: action.actionId,
    notebookId: action.notebookId,
    ...(action.physicalNotebookId ? { physicalNotebookId: action.physicalNotebookId } : {}),
    pageId: action.pageId,
    kind,
    requestedAtMs: action.createdAtMs,
    importedAtMs,
    inputScope: { type: "page" },
    payload: action.payload
  };
}

export class WorkflowStore {
  private readonly intentsPath: string;
  private readonly runsPath: string;
  constructor(root: string) { this.intentsPath = join(root, "workflows.intents.jsonl"); this.runsPath = join(root, "workflows.runs.jsonl"); }

  async enqueue(intent: WorkflowIntent): Promise<boolean> {
    const existing = await this.intents();
    const previous = existing.find((candidate) => candidate.intentId === intent.intentId);
    if (previous && sameIntentProjection(previous, intent)) return false;
    await mkdir(dirname(this.intentsPath), { recursive: true });
    await appendFile(this.intentsPath, `${JSON.stringify(intent)}\n`, "utf8");
    if (!previous) await this.recordRun({ schemaVersion: "inkrelay.workflow_run.v1", runId: `run_${intent.intentId}_001`, intentId: intent.intentId, status: "queued", attempts: 0, updatedAtMs: intent.importedAtMs, outputFiles: [] });
    return true;
  }
  async recordRun(run: WorkflowRun): Promise<void> { await mkdir(dirname(this.runsPath), { recursive: true }); await appendFile(this.runsPath, `${JSON.stringify(run)}\n`, "utf8"); }
  async intents(): Promise<WorkflowIntent[]> {
    const latest = new Map<string, WorkflowIntent>();
    for (const intent of await readJsonl<WorkflowIntent>(this.intentsPath)) latest.set(intent.intentId, intent);
    return [...latest.values()];
  }
  async runs(): Promise<WorkflowRun[]> { return readJsonl<WorkflowRun>(this.runsPath); }
}

function sameIntentProjection(left: WorkflowIntent, right: WorkflowIntent): boolean {
  return left.actionId === right.actionId && left.notebookId === right.notebookId
    && left.physicalNotebookId === right.physicalNotebookId && left.pageId === right.pageId && left.kind === right.kind
    && left.requestedAtMs === right.requestedAtMs && JSON.stringify(left.inputScope) === JSON.stringify(right.inputScope)
    && JSON.stringify(left.payload) === JSON.stringify(right.payload);
}

export class PythonHttpWorkflowExecutor implements WorkflowExecutor {
  constructor(private readonly baseUrl: string, private readonly timeoutMs = 30_000) {}
  async canExecute(_intent: WorkflowIntent): Promise<boolean> {
    try { const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(Math.min(this.timeoutMs, 2_000)) }); return response.ok; }
    catch { return false; }
  }
  async execute(intent: WorkflowIntent, context: WorkflowContext): Promise<WorkflowResult> {
    const response = await fetch(`${this.baseUrl}/v1/workflows/execute`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: "inkrelay.python_request.v1", intent, page: context.page }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) throw new Error(`Python workflow service returned HTTP ${response.status}`);
    const result = await response.json() as WorkflowResult;
    if (typeof result.markdown !== "string" || typeof result.metadata !== "object") throw new Error("Python workflow service returned an invalid response");
    return result;
  }
}

export type LanguageReviewOptions = {
  readonly language: string;
  readonly explanationLanguage: string;
};

export type LanguageCorrectionExample = {
  readonly incorrect: string;
  readonly correct: string;
};

export type LanguageCorrection = {
  readonly correctionId: string;
  readonly original: string;
  readonly replacement: string;
  readonly category: string;
  readonly explanation: string;
  readonly examples: readonly LanguageCorrectionExample[];
};

export type LanguageReviewProvenance = {
  readonly provider: string;
  readonly model: string;
  readonly pipelineVersion: string;
  readonly inputMode: "page_image";
};

export type LanguageReview = {
  readonly schemaVersion: "inkrelay.language_review.v1";
  readonly reviewId: string;
  readonly notebookId: string;
  readonly physicalNotebookId?: string;
  readonly pageId: number;
  readonly sourcePageUpdatedAtMs: number;
  readonly sourceStrokeIds: readonly string[];
  readonly inputDigest: string;
  readonly requestedAtMs: number;
  readonly completedAtMs: number;
  readonly requestedLanguage: string;
  readonly explanationLanguage: string;
  readonly detectedLanguage: string;
  readonly originalText: string;
  readonly correctedText: string;
  readonly summary: string;
  readonly corrections: readonly LanguageCorrection[];
  readonly strengths: readonly string[];
  readonly nextSteps: readonly string[];
  readonly provenance: LanguageReviewProvenance;
};

export type LanguageReviewWorkerRequest = {
  readonly schemaVersion: "inkrelay.language_worker_request.v1";
  readonly reviewId: string;
  readonly page: SmartpenPage;
  readonly options: LanguageReviewOptions;
};

export type LanguageReviewWorkerResult = {
  readonly schemaVersion: "inkrelay.language_worker_result.v1";
  readonly detectedLanguage: string;
  readonly originalText: string;
  readonly correctedText: string;
  readonly summary: string;
  readonly corrections: readonly Omit<LanguageCorrection, "correctionId">[];
  readonly strengths: readonly string[];
  readonly nextSteps: readonly string[];
  readonly provenance: LanguageReviewProvenance;
};

export interface LanguageReviewer {
  health(): Promise<{
    readonly status: string;
    readonly model?: string;
    readonly provider?: string;
    readonly pipelineVersion?: string;
    readonly modelEndpoint?: string;
    readonly healthcheck?: string;
    readonly error?: string;
  }>;
  review(request: LanguageReviewWorkerRequest): Promise<LanguageReviewWorkerResult>;
}

const correctionExampleSchema = z.object({ incorrect: z.string(), correct: z.string() });
const workerResultSchema = z.object({
  schemaVersion: z.literal("inkrelay.language_worker_result.v1"),
  detectedLanguage: z.string().min(1),
  originalText: z.string().min(1),
  correctedText: z.string().min(1),
  summary: z.string(),
  corrections: z.array(z.object({
    original: z.string(), replacement: z.string(), category: z.string().min(1), explanation: z.string().min(1),
    examples: z.array(correctionExampleSchema).max(4)
  })).max(100),
  strengths: z.array(z.string()).max(20),
  nextSteps: z.array(z.string()).max(20),
  provenance: z.object({
    provider: z.string().min(1), model: z.string().min(1), pipelineVersion: z.string().min(1), inputMode: z.literal("page_image")
  })
});

const languageReviewSchema = workerResultSchema.omit({ corrections: true }).extend({
  schemaVersion: z.literal("inkrelay.language_review.v1"),
  reviewId: z.string().min(1), notebookId: z.string().min(1), physicalNotebookId: z.string().min(1).optional(), pageId: z.number().int(),
  sourcePageUpdatedAtMs: z.number(), sourceStrokeIds: z.array(z.string()), inputDigest: z.string().min(1),
  requestedAtMs: z.number(), completedAtMs: z.number(), requestedLanguage: z.string().min(1), explanationLanguage: z.string().min(1),
  corrections: z.array(z.object({
    correctionId: z.string().min(1), original: z.string(), replacement: z.string(), category: z.string().min(1),
    explanation: z.string().min(1), examples: z.array(correctionExampleSchema).max(4)
  })).max(100)
});

export class LanguageReviewHttpClient implements LanguageReviewer {
  private readonly dispatcher: Agent;

  constructor(private readonly baseUrl: string, private readonly timeoutMs = 3_600_000) {
    // Node's built-in fetch gives up waiting for response headers after five
    // minutes even when AbortSignal allows longer. The worker is synchronous
    // and sends headers only after local inference completes, so align every
    // Undici boundary with the configured review timeout.
    this.dispatcher = new Agent({
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      connectTimeout: Math.min(timeoutMs, 10_000)
    });
  }

  async health(): ReturnType<LanguageReviewer["health"]> {
    const response = await undiciFetch(`${this.baseUrl}/health`, {
      dispatcher: this.dispatcher, signal: AbortSignal.timeout(Math.min(this.timeoutMs, 3_000))
    });
    if (!response.ok) throw new Error(`Language worker returned HTTP ${response.status}`);
    const result = await response.json() as Record<string, unknown>;
    if (typeof result.status !== "string") throw new Error("Language worker returned an invalid health response");
    return {
      status: result.status,
      ...(typeof result.model === "string" ? { model: result.model } : {}),
      ...(typeof result.provider === "string" ? { provider: result.provider } : {}),
      ...(typeof result.pipelineVersion === "string" ? { pipelineVersion: result.pipelineVersion } : {}),
      ...(typeof result.modelEndpoint === "string" ? { modelEndpoint: result.modelEndpoint } : {}),
      ...(typeof result.healthcheck === "string" ? { healthcheck: result.healthcheck } : {}),
      ...(typeof result.error === "string" ? { error: result.error } : {})
    };
  }

  async review(request: LanguageReviewWorkerRequest): Promise<LanguageReviewWorkerResult> {
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      response = await undiciFetch(`${this.baseUrl}/v1/language/review`, {
        dispatcher: this.dispatcher, method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(request), signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      const detail = fetchErrorDetail(error);
      const timedOut = detail.timedOut;
      throw Object.assign(new Error(timedOut ? `Language review timed out: ${detail.message}` : `Language worker is unavailable: ${detail.message}`), { statusCode: timedOut ? 504 : 502 });
    }
    if (!response.ok) {
      const detail = await response.text();
      throw Object.assign(new Error(`Language worker returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`), { statusCode: 502 });
    }
    return workerResultSchema.parse(await response.json()) as LanguageReviewWorkerResult;
  }
}

function fetchErrorDetail(error: unknown): { readonly message: string; readonly timedOut: boolean } {
  const cause = error instanceof Error && "cause" in error ? error.cause : undefined;
  const code = cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
  const causeMessage = cause instanceof Error ? cause.message : undefined;
  const message = [error instanceof Error ? error.message : String(error), code, causeMessage].filter(Boolean).join(" · ");
  const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    || Boolean(code?.includes("TIMEOUT"));
  return { message, timedOut };
}

export class LanguageReviewStore {
  constructor(private readonly root: string) {}

  async save(review: LanguageReview): Promise<boolean> {
    const existing = await this.reviewsForPage(review.notebookId, review.pageId, review.physicalNotebookId);
    if (existing.some((candidate) => candidate.reviewId === review.reviewId)) return false;
    const path = this.pagePath(review.notebookId, review.pageId, review.physicalNotebookId);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(review)}\n`, "utf8");
    return true;
  }

  async reviewsForPage(notebookId: string, pageId: number, physicalNotebookId?: string): Promise<LanguageReview[]> {
    return (await readJsonl<unknown>(this.pagePath(notebookId, pageId, physicalNotebookId)))
      .map((value) => languageReviewSchema.parse(value) as LanguageReview)
      .sort((a, b) => b.completedAtMs - a.completedAtMs || a.reviewId.localeCompare(b.reviewId));
  }

  async byId(notebookId: string, pageId: number, reviewId: string, physicalNotebookId?: string): Promise<LanguageReview | undefined> {
    return (await this.reviewsForPage(notebookId, pageId, physicalNotebookId)).find((review) => review.reviewId === reviewId);
  }

  private pagePath(notebookId: string, pageId: number, physicalNotebookId?: string): string {
    return join(this.root, safe(physicalNotebookId ?? notebookId), `Page_${String(pageId).padStart(3, "0")}.reviews.jsonl`);
  }
}

export class LanguageReviewCoordinator {
  private readonly inFlight = new Map<string, Promise<LanguageReview>>();

  constructor(private readonly store: LanguageReviewStore, private readonly reviewer: LanguageReviewer) {}

  health(): ReturnType<LanguageReviewer["health"]> { return this.reviewer.health(); }
  reviewsForPage(notebookId: string, pageId: number, physicalNotebookId?: string): Promise<LanguageReview[]> { return this.store.reviewsForPage(notebookId, pageId, physicalNotebookId); }

  async review(page: SmartpenPage, options: LanguageReviewOptions, now = Date.now()): Promise<LanguageReview> {
    const normalized = normalizeLanguageOptions(options);
    const sourceStrokes = page.strokes.filter((stroke) => stroke.semanticRole !== "action" && stroke.points.length > 0);
    if (sourceStrokes.length === 0) return Promise.reject(Object.assign(new Error("The page has no visible ink to review"), { statusCode: 400 }));
    const health = await this.reviewer.health();
    if (!health.model || !health.modelEndpoint) {
      const missing = [!health.model ? "model" : "", !health.modelEndpoint ? "modelEndpoint" : ""].filter(Boolean).join(", ");
      throw Object.assign(new Error(`Language worker health response is missing required model identity: ${missing}`), { statusCode: 502 });
    }
    const processor = {
      provider: health.provider ?? "legacy-openai-compatible",
      model: health.model,
      pipelineVersion: health.pipelineVersion ?? "legacy-health-contract",
      modelEndpoint: health.modelEndpoint
    };
    const { physicalNotebookName: _displayOnlyName, ...digestPage } = page;
    const inputDigest = digest({ page: { ...digestPage, strokes: sourceStrokes }, options: normalized, processor });
    const reviewId = `review_${inputDigest.slice(0, 24)}`;
    const running = this.inFlight.get(reviewId);
    if (running) return running;
    const operation = this.runReview(page, sourceStrokes.map((stroke) => stroke.strokeId), normalized, inputDigest, reviewId, now)
      .finally(() => this.inFlight.delete(reviewId));
    this.inFlight.set(reviewId, operation);
    return await operation;
  }

  private async runReview(page: SmartpenPage, sourceStrokeIds: readonly string[], options: LanguageReviewOptions, inputDigest: string, reviewId: string, requestedAtMs: number): Promise<LanguageReview> {
    const cached = await this.store.byId(page.notebookId, page.pageId, reviewId, page.physicalNotebookId);
    if (cached) return cached;
    const result = await this.reviewer.review({ schemaVersion: "inkrelay.language_worker_request.v1", reviewId, page, options });
    const review: LanguageReview = languageReviewSchema.parse({
      schemaVersion: "inkrelay.language_review.v1", reviewId, notebookId: page.notebookId,
      ...(page.physicalNotebookId ? { physicalNotebookId: page.physicalNotebookId } : {}), pageId: page.pageId,
      sourcePageUpdatedAtMs: page.updatedAtMs, sourceStrokeIds, inputDigest, requestedAtMs, completedAtMs: Date.now(),
      requestedLanguage: options.language, explanationLanguage: options.explanationLanguage,
      detectedLanguage: result.detectedLanguage, originalText: result.originalText, correctedText: result.correctedText,
      summary: result.summary,
      corrections: result.corrections.map((correction, index) => ({ ...correction, correctionId: `${reviewId}_c${String(index + 1).padStart(3, "0")}` })),
      strengths: result.strengths, nextSteps: result.nextSteps, provenance: result.provenance
    }) as LanguageReview;
    await this.store.save(review);
    return review;
  }
}

async function readJsonl<T>(path: string): Promise<T[]> {
  try { return (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return []; throw error; }
}

function normalizeLanguageOptions(options: LanguageReviewOptions): LanguageReviewOptions {
  const language = options.language.trim();
  const explanationLanguage = options.explanationLanguage.trim();
  if (!language || language.length > 80) throw Object.assign(new Error("language must contain 1–80 characters"), { statusCode: 400 });
  if (!explanationLanguage || explanationLanguage.length > 80) throw Object.assign(new Error("explanationLanguage must contain 1–80 characters"), { statusCode: 400 });
  return { language, explanationLanguage };
}

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function safe(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, "_"); }
