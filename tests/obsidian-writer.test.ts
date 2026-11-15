import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ObsidianWriter } from "@inkrelay/obsidian-writer";
import { event, page } from "./helpers.js";

describe("ObsidianWriter", () => {
  it("publishes a versioned generation and never overwrites user notes", async () => {
    const vault = await mkdtemp(join(tmpdir(), "inkrelay-writer-"));
    const writer = new ObsidianWriter(vault);
    const result = await writer.exportPage(page(), [event(1, "pen_down")]);
    for (const path of [result.markdownPath, result.notesPath, result.manifestPath, result.svgPath, result.strokesPath, result.actionsPath, result.eventsPath]) {
      expect((await readFile(path, "utf8")).length).toBeGreaterThan(0);
    }
    expect(result.markdownPath).toBe(join(vault, "Smartpen", "Notebooks", "NB01", "Page_012.md"));
    expect(await readFile(result.markdownPath, "utf8")).toContain(`generation_id: ${result.generationId}`);
    expect(JSON.parse(await readFile(result.manifestPath, "utf8"))).toMatchObject({
      schema_version: "inkrelay.obsidian_export.v1",
      generation_id: result.generationId,
      files: { visual: { path: `Smartpen/Attachments/NB01/Page_012.${result.generationId}.svg`, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } }
    });

    await writeFile(result.notesPath, "Keep this user-owned sentence.\n");
    const repeated = await writer.exportPage(page(), [event(1, "pen_down")]);
    expect(repeated.generationId).toBe(result.generationId);
    expect(await readFile(result.notesPath, "utf8")).toBe("Keep this user-owned sentence.\n");
  });

  it("copies protected manual text from a legacy export without changing the legacy file", async () => {
    const vault = await mkdtemp(join(tmpdir(), "inkrelay-writer-migration-"));
    const legacyPath = join(vault, "Smartpen", "Notebook_01", "Page_012.md");
    const legacy = "Before\n<!-- inkrelay:manual:start -->\nKeep this sentence.\n<!-- inkrelay:manual:end -->\nAfter\n";
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, legacy);

    const result = await new ObsidianWriter(vault).exportPage(page(), [event(1, "pen_down")]);
    expect(await readFile(result.notesPath, "utf8")).toContain("Keep this sentence.");
    expect(await readFile(legacyPath, "utf8")).toBe(legacy);
    expect(await readFile(result.markdownPath, "utf8")).toContain("Legacy export retained");
  });

  it("uses collision-resistant folders and deterministic full-path navigation", async () => {
    const vault = await mkdtemp(join(tmpdir(), "inkrelay-writer-names-"));
    const writer = new ObsidianWriter(vault);
    const first = await writer.exportPage(page({ notebookId: "A/B", pageId: 0, strokes: [] }), []);
    const second = await writer.exportPage(page({ notebookId: "A?B", pageId: 0, strokes: [] }), []);
    expect(dirname(first.markdownPath)).not.toBe(dirname(second.markdownPath));
    const markdown = await readFile(first.markdownPath, "utf8");
    expect(markdown).toContain("Previous page: —");
    expect(markdown).toMatch(/\[\[Smartpen\/Notebooks\/A_B--[a-f0-9]{8}\/Page_001\|Next page\]\]/);
  });

  it("does not publish the Markdown note when generation publication fails", async () => {
    const vault = await mkdtemp(join(tmpdir(), "inkrelay-writer-failure-"));
    const writer = new ObsidianWriter(vault);
    const result = await writer.exportPage(page(), [event(1, "pen_down")]);
    await writeFile(result.markdownPath, "visible note remains unchanged\n");
    await unlink(result.manifestPath);
    await mkdir(result.manifestPath);

    await expect(writer.exportPage(page(), [event(1, "pen_down")])).rejects.toThrow();
    expect(await readFile(result.markdownPath, "utf8")).toBe("visible note remains unchanged\n");
  });

  it("exports physical copies into separate folders while preserving the source paper identity", async () => {
    const vault = await mkdtemp(join(tmpdir(), "inkrelay-writer-physical-copy-"));
    const result = await new ObsidianWriter(vault).exportPage(page({ physicalNotebookId: "copy-work", physicalNotebookName: "Work notes" }), [event(1, "pen_down")]);
    expect(result.markdownPath).toBe(join(vault, "Smartpen", "Notebooks", "copy-work", "Page_012.md"));
    expect(await readFile(result.markdownPath, "utf8")).toContain('notebook_id: "NB01"');
    expect(await readFile(result.markdownPath, "utf8")).toContain('physical_notebook_id: "copy-work"');
    expect(await readFile(result.markdownPath, "utf8")).toContain("# Work notes — Page 12");
  });

  it("exports a generated language review with transcription, corrections, and corrected essay", async () => {
    const vault = await mkdtemp(join(tmpdir(), "inkrelay-writer-review-"));
    const source = page();
    const result = await new ObsidianWriter(vault).exportLanguageReview(source, {
      schemaVersion: "inkrelay.language_review.v1", reviewId: "review_123", notebookId: source.notebookId,
      pageId: source.pageId, sourcePageUpdatedAtMs: source.updatedAtMs, requestedLanguage: "English",
      explanationLanguage: "English", detectedLanguage: "English", originalText: "She go home.",
      correctedText: "She goes home.", summary: "One agreement correction.", completedAtMs: 3_000,
      corrections: [{ correctionId: "c1", original: "go", replacement: "goes", category: "agreement", explanation: "Third-person singular takes goes.", examples: [{ incorrect: "He walk.", correct: "He walks." }] }],
      strengths: ["Clear meaning."], nextSteps: ["Practise present tense."],
      provenance: { provider: "test", model: "vision-test", pipelineVersion: "v1", inputMode: "page_image" }
    });
    expect(result.reviewPath).toBe(join(vault, "Smartpen", "Reviews", "NB01", "Page_012 Review.md"));
    const markdown = await readFile(result.reviewPath, "utf8");
    expect(markdown).toContain("## Original text\n");
    expect(markdown).toContain("She go home.");
    expect(markdown).toContain("**go → goes**");
    expect(markdown).toContain("## Natural corrected version\n\nShe goes home.");
    expect(markdown).toContain("[[Smartpen/Notebooks/NB01/Page_012|Open the handwritten source page]]");
  });
});
