import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { LanguageReviewCoordinator, LanguageReviewStore, WorkflowStore, intentFromAction, type LanguageReviewer } from "@inkrelay/workflows";
import type { PaperAction } from "@inkrelay/core";
import { page } from "./helpers.js";

describe("workflow outbox", () => {
  it("turns AI paper actions into idempotent durable queued intents", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkrelay-workflow-"));
    const action: PaperAction = { actionId: "act_1", kind: "ai_stub", notebookId: "NB01", physicalNotebookId: "copy-a", pageId: 12, createdAtMs: 1000, payload: { futureAction: "summarize" } };
    const intent = intentFromAction(action, 2000);
    expect(intent).toMatchObject({ kind: "summarize", physicalNotebookId: "copy-a", requestedAtMs: 1000, importedAtMs: 2000 });
    const store = new WorkflowStore(root);
    expect(await store.enqueue(intent!)).toBe(true);
    expect(await store.enqueue(intent!)).toBe(false);
    expect(await store.intents()).toHaveLength(1);
    expect(await store.runs()).toMatchObject([{ status: "queued", attempts: 0 }]);
    expect((await readFile(join(root, "workflows.intents.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("appends and resolves a newer routing projection for a reassigned capture", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkrelay-workflow-reassignment-"));
    const store = new WorkflowStore(root);
    const action: PaperAction = { actionId: "act_reassigned", kind: "ai_stub", notebookId: "NB01", physicalNotebookId: "wrong-copy", pageId: 12, createdAtMs: 1000, payload: { futureAction: "summarize" } };
    await store.enqueue(intentFromAction(action, 2000)!);
    await store.enqueue(intentFromAction({ ...action, physicalNotebookId: "correct-copy" }, 3000)!);
    expect(await store.intents()).toMatchObject([{ intentId: "intent_act_reassigned", physicalNotebookId: "correct-copy" }]);
    expect((await readFile(join(root, "workflows.intents.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2);
    expect(await store.runs()).toHaveLength(1);
  });
});

describe("language review projection", () => {
  it("persists one validated review for an unchanged page and preserves source links", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkrelay-language-review-"));
    let calls = 0;
    const reviewer: LanguageReviewer = {
      // Older workers reported only model and endpoint. The coordinator must retain
      // deterministic caching while the worker container is being upgraded.
      health: async () => ({ status: "ok", model: "gemma-test", modelEndpoint: "http://model.test/v1" }),
      review: async () => {
        calls++;
        return {
          schemaVersion: "inkrelay.language_worker_result.v1", detectedLanguage: "English",
          originalText: "They was ready.", correctedText: "They were ready.", summary: "One agreement error.",
          corrections: [{ original: "was", replacement: "were", category: "agreement", explanation: "A plural subject takes were.", examples: [] }],
          strengths: [], nextSteps: [], provenance: { provider: "test", model: "gemma-test", pipelineVersion: "test-v1", inputMode: "page_image" }
        };
      }
    };
    const coordinator = new LanguageReviewCoordinator(new LanguageReviewStore(root), reviewer);
    const source = page();
    const first = await coordinator.review(source, { language: "English", explanationLanguage: "English" }, 3_000);
    const repeated = await coordinator.review(source, { language: "English", explanationLanguage: "English" }, 4_000);
    expect(repeated.reviewId).toBe(first.reviewId);
    expect(calls).toBe(1);
    expect(first.sourceStrokeIds).toEqual([source.strokes[0]!.strokeId]);
    expect(first.corrections[0]).toMatchObject({ correctionId: `${first.reviewId}_c001`, replacement: "were" });
    expect(await coordinator.reviewsForPage("NB01", 12)).toHaveLength(1);
  });

  it("creates a new durable review when the configured model endpoint changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkrelay-language-model-switch-"));
    let model = "model-a";
    let endpoint = "http://first.test/v1";
    let calls = 0;
    const reviewer: LanguageReviewer = {
      health: async () => ({ status: "ok", provider: "compatible", model, pipelineVersion: "test-v1", modelEndpoint: endpoint }),
      review: async () => {
        calls++;
        return {
          schemaVersion: "inkrelay.language_worker_result.v1", detectedLanguage: "English",
          originalText: "They was ready.", correctedText: "They were ready.", summary: "One agreement error.",
          corrections: [], strengths: [], nextSteps: [],
          provenance: { provider: "compatible", model, pipelineVersion: "test-v1", inputMode: "page_image" }
        };
      }
    };
    const coordinator = new LanguageReviewCoordinator(new LanguageReviewStore(root), reviewer);
    const source = page();
    const first = await coordinator.review(source, { language: "English", explanationLanguage: "English" });
    model = "model-b";
    endpoint = "https://cloud.example/v1";
    const second = await coordinator.review(source, { language: "English", explanationLanguage: "English" });
    expect(second.reviewId).not.toBe(first.reviewId);
    expect(second.provenance.model).toBe("model-b");
    expect(calls).toBe(2);
    expect(await coordinator.reviewsForPage("NB01", 12)).toHaveLength(2);
  });

  it("keeps reviews for physical copies with the same paper identity separate", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkrelay-language-physical-copy-"));
    const reviewer: LanguageReviewer = {
      health: async () => ({ status: "ok", model: "test", modelEndpoint: "http://model.test/v1" }),
      review: async () => ({
        schemaVersion: "inkrelay.language_worker_result.v1", detectedLanguage: "English", originalText: "Text.", correctedText: "Text.", summary: "Clear.",
        corrections: [], strengths: [], nextSteps: [], provenance: { provider: "test", model: "test", pipelineVersion: "v1", inputMode: "page_image" }
      })
    };
    const coordinator = new LanguageReviewCoordinator(new LanguageReviewStore(root), reviewer);
    await coordinator.review(page({ physicalNotebookId: "copy-a", physicalNotebookName: "Copy A" }), { language: "English", explanationLanguage: "English" });
    await coordinator.review(page({ physicalNotebookId: "copy-b", physicalNotebookName: "Copy B" }), { language: "English", explanationLanguage: "English" });
    expect(await coordinator.reviewsForPage("NB01", 12, "copy-a")).toHaveLength(1);
    expect(await coordinator.reviewsForPage("NB01", 12, "copy-b")).toHaveLength(1);
  });
});
