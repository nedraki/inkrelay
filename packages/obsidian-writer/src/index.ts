import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { PaperAction, PenDotEvent, SmartpenPage } from "@inkrelay/core";
import { SVG_RENDERER_VERSION, SVGRenderer } from "@inkrelay/render-svg";
export { RawEventStore } from "./raw-event-store.js";

export const OBSIDIAN_PAGE_SCHEMA_VERSION = "inkrelay.obsidian_page.v1" as const;
export const OBSIDIAN_EXPORT_SCHEMA_VERSION = "inkrelay.obsidian_export.v1" as const;

export type ExportResult = {
  readonly generationId: string;
  readonly markdownPath: string;
  readonly notesPath: string;
  readonly manifestPath: string;
  readonly svgPath: string;
  readonly strokesPath: string;
  readonly actionsPath: string;
  readonly eventsPath: string;
};

export type LanguageReviewProjection = {
  readonly schemaVersion: "inkrelay.language_review.v1";
  readonly reviewId: string;
  readonly notebookId: string;
  readonly physicalNotebookId?: string;
  readonly pageId: number;
  readonly sourcePageUpdatedAtMs: number;
  readonly requestedLanguage: string;
  readonly explanationLanguage: string;
  readonly detectedLanguage: string;
  readonly originalText: string;
  readonly correctedText: string;
  readonly summary: string;
  readonly corrections: readonly {
    readonly correctionId: string;
    readonly original: string;
    readonly replacement: string;
    readonly category: string;
    readonly explanation: string;
    readonly examples: readonly { readonly incorrect: string; readonly correct: string }[];
  }[];
  readonly strengths: readonly string[];
  readonly nextSteps: readonly string[];
  readonly completedAtMs: number;
  readonly provenance: {
    readonly provider: string;
    readonly model: string;
    readonly pipelineVersion: string;
    readonly inputMode: "page_image";
  };
};

export type LanguageReviewExportResult = { readonly reviewPath: string; readonly reviewId: string };

type ExportContents = {
  readonly svg: string;
  readonly strokes: string;
  readonly actions: string;
  readonly events: string;
};

export class ObsidianWriter {
  constructor(private readonly vaultPath: string, private readonly renderer = new SVGRenderer()) {}

  async exportPage(page: SmartpenPage, events: readonly PenDotEvent[]): Promise<ExportResult> {
    const orderedEvents = orderEvents(events);
    const contents = exportContents(page, orderedEvents, this.renderer);
    const generationId = digest(JSON.stringify({
      schemaVersion: OBSIDIAN_EXPORT_SCHEMA_VERSION,
      rendererVersion: SVG_RENDERER_VERSION,
      page,
      events: orderedEvents
    })).slice(0, 16);
    const result = exportPaths(this.vaultPath, page, generationId);
    const legacyMarkdownPath = legacyPagePath(this.vaultPath, page);
    const legacyEligible = projectedNotebookId(page) === page.notebookId;
    const legacyExists = legacyEligible && await exists(legacyMarkdownPath);

    await Promise.all([
      result.svgPath,
      result.strokesPath,
      result.actionsPath,
      result.eventsPath,
      result.manifestPath,
      result.markdownPath,
      result.notesPath
    ].map((path) => mkdir(dirname(path), { recursive: true })));

    // Prepare a complete immutable generation before changing the visible note.
    await Promise.all([
      atomicWrite(result.svgPath, contents.svg),
      atomicWrite(result.strokesPath, contents.strokes),
      atomicWrite(result.actionsPath, contents.actions),
      atomicWrite(result.eventsPath, contents.events)
    ]);
    await atomicWrite(result.manifestPath, manifest(page, orderedEvents, generationId, result, contents));
    await ensureUserNotes(result.notesPath, page, legacyEligible ? legacyMarkdownPath : undefined);
    await atomicWrite(result.markdownPath, markdown(page, orderedEvents, generationId, result, legacyExists));
    return result;
  }

  async exportLanguageReview(page: SmartpenPage, review: LanguageReviewProjection): Promise<LanguageReviewExportResult> {
    if (review.notebookId !== page.notebookId || review.pageId !== page.pageId
      || (review.physicalNotebookId ?? review.notebookId) !== projectedNotebookId(page)) {
      throw new Error("Language review does not belong to the selected physical page");
    }
    const notebook = notebookFolder(projectedNotebookId(page));
    const reviewPath = join(this.vaultPath, "Smartpen", "Reviews", notebook, `Page_${pad(page.pageId)} Review.md`);
    await mkdir(dirname(reviewPath), { recursive: true });
    await atomicWrite(reviewPath, languageReviewMarkdown(page, review, notebook));
    return { reviewPath, reviewId: review.reviewId };
  }
}

function exportPaths(vaultPath: string, page: SmartpenPage, generationId: string): ExportResult {
  const notebook = notebookFolder(projectedNotebookId(page));
  const pageName = `Page_${pad(page.pageId)}`;
  const root = join(vaultPath, "Smartpen");
  const generationRoot = join(root, "Data", notebook, pageName, "generations", generationId);
  return {
    generationId,
    markdownPath: join(root, "Notebooks", notebook, `${pageName}.md`),
    notesPath: join(root, "Notebooks", notebook, `${pageName} Notes.md`),
    manifestPath: join(generationRoot, "manifest.json"),
    svgPath: join(root, "Attachments", notebook, `${pageName}.${generationId}.svg`),
    strokesPath: join(generationRoot, "strokes.json"),
    actionsPath: join(generationRoot, "actions.json"),
    eventsPath: join(generationRoot, "events.jsonl")
  };
}

function exportContents(page: SmartpenPage, events: readonly PenDotEvent[], renderer: SVGRenderer): ExportContents {
  return {
    svg: renderer.render(page),
    strokes: `${JSON.stringify(strokeSidecar(page), null, 2)}\n`,
    actions: `${JSON.stringify(actionSidecar(page), null, 2)}\n`,
    events: events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : "")
  };
}

function manifest(page: SmartpenPage, events: readonly PenDotEvent[], generationId: string, result: ExportResult, contents: ExportContents): string {
  const root = vaultRoot(result.markdownPath);
  return `${JSON.stringify({
    schema_version: OBSIDIAN_EXPORT_SCHEMA_VERSION,
    generation_id: generationId,
    renderer_version: SVG_RENDERER_VERSION,
    notebook_id: page.notebookId,
    physical_notebook_id: projectedNotebookId(page),
    physical_notebook_name: page.physicalNotebookName ?? page.notebookId,
    page_id: page.pageId,
    source_updated_at: new Date(page.updatedAtMs).toISOString(),
    event_count: events.length,
    stroke_count: page.strokes.length,
    action_count: page.actions.length,
    files: {
      visual: fileRecord(root, result.svgPath, contents.svg),
      strokes: fileRecord(root, result.strokesPath, contents.strokes),
      actions: fileRecord(root, result.actionsPath, contents.actions),
      events: fileRecord(root, result.eventsPath, contents.events)
    }
  }, null, 2)}\n`;
}

function fileRecord(root: string, path: string, content: string): { readonly path: string; readonly sha256: string; readonly bytes: number } {
  return { path: vaultRelative(root, path), sha256: digest(content), bytes: Buffer.byteLength(content, "utf8") };
}

function markdown(page: SmartpenPage, events: readonly PenDotEvent[], generationId: string, result: ExportResult, legacyExists: boolean): string {
  const important = page.actions.some((action) => action.kind === "mark_important");
  const ai = page.actions.filter((action) => action.kind === "ai_stub");
  const notebook = notebookFolder(projectedNotebookId(page));
  const root = vaultRoot(result.markdownPath);
  const visualPath = vaultRelative(root, result.svgPath);
  const notesPath = withoutMarkdownExtension(vaultRelative(root, result.notesPath));
  const manifestPath = vaultRelative(root, result.manifestPath);
  const actionLines = page.actions.length ? page.actions.map(actionLine).join("\n") : "- None";
  const aiLines = ai.length ? ai.map((action) => `- ${timestamp(action.createdAtMs)} — ${String(action.payload.futureAction ?? "queued workflow")}`).join("\n") : "_No workflows requested._";
  const titleNotebook = page.physicalNotebookName ?? (/^NB(\d+)$/i.test(page.notebookId) ? `Notebook ${page.notebookId.slice(2)}` : page.notebookId);
  const previous = page.pageId > 0 ? `[[Smartpen/Notebooks/${notebook}/Page_${pad(page.pageId - 1)}|Previous page]]` : "Previous page: —";
  const next = `[[Smartpen/Notebooks/${notebook}/Page_${pad(page.pageId + 1)}|Next page]]`;
  return `---
schema_version: ${OBSIDIAN_PAGE_SCHEMA_VERSION}
type: smartpen-page
notebook_id: ${yaml(page.notebookId)}
physical_notebook_id: ${yaml(projectedNotebookId(page))}
physical_notebook_name: ${yaml(titleNotebook)}
page_id: ${page.pageId}
created_at: ${new Date(page.createdAtMs).toISOString()}
updated_at: ${new Date(page.updatedAtMs).toISOString()}
generation_id: ${generationId}
renderer_version: ${SVG_RENDERER_VERSION}
event_count: ${events.length}
stroke_count: ${page.strokes.length}
action_count: ${page.actions.length}
layout_mode: single-page
important: ${important}
visual_file: ${yaml(`[[${visualPath}]]`)}
notes_file: ${yaml(`[[${notesPath}]]`)}
data_manifest: ${yaml(manifestPath)}
has_ocr: false
has_ai_summary: false
tags:
  - smartpen
  - handwritten${important ? "\n  - important" : ""}
---

# ${titleNotebook} — Page ${page.pageId}

> [!info] Generated by InkRelay
> The handwriting and metadata on this page are regenerated from canonical ink. Add your own text in the linked notes section below.

## Handwritten page

![[${visualPath}]]

## Notes

![[${notesPath}]]

## Future AI candidates

${aiLines}

## Paper actions

${actionLines}

## Export provenance

- Generation: \`${generationId}\`
- Renderer: \`${SVG_RENDERER_VERSION}\`
- Source events: ${events.length}
- Manifest: \`${manifestPath}\`${legacyExists ? `
- Legacy export retained: \`${vaultRelative(root, legacyPagePath(root, page))}\`` : ""}

## Navigation

${previous} · ${next}
`;
}

function languageReviewMarkdown(page: SmartpenPage, review: LanguageReviewProjection, notebook: string): string {
  const sourcePage = `Smartpen/Notebooks/${notebook}/Page_${pad(page.pageId)}`;
  const titleNotebook = page.physicalNotebookName ?? page.notebookId;
  const stale = review.sourcePageUpdatedAtMs !== page.updatedAtMs;
  const corrections = review.corrections.length === 0
    ? "_No corrections were proposed._"
    : review.corrections.map((correction, index) => {
      const examples = correction.examples.length === 0 ? "" : `\n\n   **Examples**\n${correction.examples.map((example) => `   - ${inlineMarkdown(example.incorrect)} → ${inlineMarkdown(example.correct)}`).join("\n")}`;
      return `${index + 1}. **${inlineMarkdown(correction.original || "[insertion]")} → ${inlineMarkdown(correction.replacement || "[delete]")}**\n\n   Category: ${inlineMarkdown(correction.category)}\n\n   ${correction.explanation.trim()}${examples}`;
    }).join("\n\n");
  const strengths = review.strengths.length ? review.strengths.map((item) => `- ${item}`).join("\n") : "_None recorded._";
  const nextSteps = review.nextSteps.length ? review.nextSteps.map((item) => `- ${item}`).join("\n") : "_None recorded._";
  return `---
schema_version: inkrelay.obsidian_language_review.v1
type: smartpen-language-review
review_id: ${yaml(review.reviewId)}
notebook_id: ${yaml(review.notebookId)}
physical_notebook_id: ${yaml(projectedNotebookId(page))}
page_id: ${page.pageId}
source_page: ${yaml(`[[${sourcePage}]]`)}
source_page_updated_at: ${new Date(review.sourcePageUpdatedAtMs).toISOString()}
review_completed_at: ${new Date(review.completedAtMs).toISOString()}
detected_language: ${yaml(review.detectedLanguage)}
model_provider: ${yaml(review.provenance.provider)}
model: ${yaml(review.provenance.model)}
pipeline_version: ${yaml(review.provenance.pipelineVersion)}
stale: ${stale}
tags:
  - smartpen
  - language-review
---

# Language review — ${titleNotebook}, Page ${page.pageId}

> [!info] Model-generated review
> This note is a generated projection of InkRelay review \`${review.reviewId}\`. The physical ink remains canonical. [[${sourcePage}|Open the handwritten source page]].
${stale ? "\n> [!warning] The page changed after this review was generated.\n" : ""}
## Original text

> [!note] Model transcription
> This is the model's reading of the handwriting, not a replacement for the original ink.

${review.originalText.trim()}

## Corrections

${corrections}

## Natural corrected version

${review.correctedText.trim()}

## Teacher summary

${review.summary.trim()}

## Strengths

${strengths}

## Next steps

${nextSteps}

## Review provenance

- Provider: \`${review.provenance.provider}\`
- Model: \`${review.provenance.model}\`
- Pipeline: \`${review.provenance.pipelineVersion}\`
- Requested language: ${review.requestedLanguage}
- Explanation language: ${review.explanationLanguage}
- Completed: ${new Date(review.completedAtMs).toISOString()}
`;
}

async function ensureUserNotes(path: string, page: SmartpenPage, legacyPath?: string): Promise<void> {
  if (await exists(path)) return;
  const legacyManual = legacyPath ? await existingManualContent(legacyPath) : "";
  const titleNotebook = page.physicalNotebookName ?? (/^NB(\d+)$/i.test(page.notebookId) ? `Notebook ${page.notebookId.slice(2)}` : page.notebookId);
  const content = `# Notes — ${titleNotebook}, Page ${page.pageId}\n\n${legacyManual}${legacyManual ? "\n" : ""}`;
  try { await writeFile(path, content, { encoding: "utf8", flag: "wx" }); }
  catch (error) { if (!isAlreadyExists(error)) throw error; }
}

const MANUAL_START = "<!-- inkrelay:manual:start -->";
const MANUAL_END = "<!-- inkrelay:manual:end -->";

async function existingManualContent(path: string): Promise<string> {
  try {
    const current = await readFile(path, "utf8");
    const start = current.indexOf(MANUAL_START);
    const end = current.indexOf(MANUAL_END);
    if (start >= 0 && end > start) return current.slice(start + MANUAL_START.length, end).trim();
  } catch (error) { if (!isMissing(error)) throw error; }
  return "";
}

function legacyPagePath(vaultPath: string, page: SmartpenPage): string {
  return join(vaultPath, "Smartpen", legacyNotebookFolder(page.notebookId), `Page_${pad(page.pageId)}.md`);
}

function strokeSidecar(page: SmartpenPage): unknown {
  return { schema_version: "smartpen.strokes.v1", notebook_id: page.notebookId, physical_notebook_id: projectedNotebookId(page), page_id: page.pageId, page: { width: page.width, height: page.height, unit: page.unit, source_unit: "app_px" }, strokes: page.strokes };
}
function actionSidecar(page: SmartpenPage): unknown { return { schema_version: "smartpen.actions.v1", notebook_id: page.notebookId, physical_notebook_id: projectedNotebookId(page), page_id: page.pageId, actions: page.actions }; }
function actionLine(action: PaperAction): string { return `- ${timestamp(action.createdAtMs)} — ${action.kind.replaceAll("_", " ")}${action.payload.label ? `: ${String(action.payload.label)}` : ""}`; }
function timestamp(ms: number): string { return new Date(ms).toISOString(); }
function pad(value: number): string { return String(value).padStart(3, "0"); }
function notebookFolder(id: string): string {
  if (/^[a-zA-Z0-9_-]+$/.test(id)) return id;
  return `${safe(id)}--${digest(id).slice(0, 8)}`;
}
function projectedNotebookId(page: SmartpenPage): string { return page.physicalNotebookId ?? page.notebookId; }
function legacyNotebookFolder(id: string): string { const match = /^(.*?)(\d+)$/.exec(id); return match ? `${match[1] === "NB" ? "Notebook" : safe(match[1] ?? id)}_${match[2]}` : `Notebook_${safe(id)}`; }
function safe(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, "_"); }
function yaml(value: string): string { return JSON.stringify(value); }
function inlineMarkdown(value: string): string { return value.replace(/\s+/g, " ").replace(/([*_`])/g, "\\$1").trim(); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function vaultRoot(markdownPath: string): string { return join(markdownPath, "..", "..", "..", ".."); }
function vaultRelative(root: string, path: string): string { return relative(root, path).split(sep).join("/"); }
function withoutMarkdownExtension(path: string): string { return path.endsWith(".md") ? path.slice(0, -3) : path; }
function orderEvents(events: readonly PenDotEvent[]): PenDotEvent[] { return [...events].sort((a, b) => a.timestampMs - b.timestampMs || a.penId.localeCompare(b.penId) || a.sessionId.localeCompare(b.sessionId) || a.sequence - b.sequence); }
async function exists(path: string): Promise<boolean> { try { await access(path, constants.F_OK); return true; } catch (error) { if (isMissing(error)) return false; throw error; } }
async function atomicWrite(path: string, content: string): Promise<void> { const temp = `${path}.tmp-${process.pid}-${randomUUID()}`; await writeFile(temp, content, "utf8"); await rename(temp, path); }
function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function isAlreadyExists(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "EEXIST"; }
