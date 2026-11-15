import { access, mkdtemp, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { LanguageReviewer } from "@inkrelay/workflows";
import { createApp } from "../apps/server/src/app.js";
import { event } from "./helpers.js";

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

describe("local API", () => {
  it("ingests, reads, renders, exports, and reports actions", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkrelay-api-"));
    const languageReviewer: LanguageReviewer = {
      health: async () => ({
        status: "ok", provider: "test", model: "test-vision-model", pipelineVersion: "test-v1", modelEndpoint: "http://model.test/v1"
      }),
      review: async () => ({
        schemaVersion: "inkrelay.language_worker_result.v1",
        detectedLanguage: "English", originalText: "She go home.", correctedText: "She goes home.",
        summary: "Good short sentence with one agreement error.",
        corrections: [{
          original: "go", replacement: "goes", category: "subject–verb agreement",
          explanation: "A third-person singular subject takes goes in the present tense.",
          examples: [{ incorrect: "He walk home.", correct: "He walks home." }]
        }],
        strengths: ["The meaning is clear."], nextSteps: ["Practise third-person present-tense verbs."],
        provenance: { provider: "test", model: "test-vision-model", pipelineVersion: "test-v1", inputMode: "page_image" }
      })
    };
    const config = {
      canonicalDataPath: join(root, "raw"), vaultPath: join(root, "vault"), actionZonesPath: resolve("config/action-zones.json"),
      port: 0, host: "127.0.0.1", pythonServiceUrl: "http://127.0.0.1:8321",
      languageWorkerUrl: "http://127.0.0.1:8321", languageReviewTimeoutMs: 180_000, bluetoothEnabled: false
    };
    ({ app } = await createApp(config, { languageReviewer }));
    const events = [event(1, "pen_down"), event(2, "pen_move"), event(3, "pen_up")];
    expect((await app.inject({ method: "POST", url: "/api/pen/events", payload: events })).statusCode).toBe(202);
    expect((await app.inject({ method: "GET", url: "/api/pages/NB01/12" })).json().strokes).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/paper/profiles" })).json()).toMatchObject({ schemaVersion: "inkrelay.paper_catalog.v2", profiles: [], observedNotebooks: ["NB01"] });
    const paperProfile = await app.inject({ method: "PUT", url: "/api/paper/profiles/NB01", payload: { displayName: "Official test notebook", widthMm: 210, heightMm: 148 } });
    expect(paperProfile.statusCode).toBe(200);
    expect(paperProfile.json().profile).toMatchObject({ notebookId: "NB01", widthMm: 210, heightMm: 148, revision: 1 });
    expect((await app.inject({ method: "GET", url: "/api/pages/NB01/12" })).json()).toMatchObject({ width: 2100, height: 1480 });
    const calibration = { kind: "axis_aligned_affine", scaleX: 2, scaleY: 2, offsetX: 0, offsetY: 0, anchors: [{ sourceX: 100, sourceY: 100, paperXMm: 10, paperYMm: 10 }, { sourceX: 900, sourceY: 600, paperXMm: 200, paperYMm: 138 }] };
    expect((await app.inject({ method: "PUT", url: "/api/paper/profiles/NB01", payload: { displayName: "Official test notebook", widthMm: 210, heightMm: 148, calibration } })).json().profile).toMatchObject({ revision: 2, calibration });
    expect((await app.inject({ method: "GET", url: "/api/pages/NB01/12" })).json().strokes[0].points[0]).toMatchObject({ x: 802, y: 602 });
    expect((await app.inject({ method: "PUT", url: "/api/paper/profiles/NB01", payload: { displayName: "", widthMm: -1, heightMm: 148 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/notebooks" })).json().instances).toMatchObject([{ instanceId: "NB01", paperIdentity: "NB01" }]);
    expect((await app.inject({ method: "PUT", url: "/api/notebooks/NB01", payload: { displayName: "French course" } })).json().instance.displayName).toBe("French course");
    const newNotebook = await app.inject({ method: "POST", url: "/api/notebooks", payload: { paperIdentity: "NB01", displayName: "Work notes" } });
    expect(newNotebook.statusCode).toBe(201);
    const newNotebookId = newNotebook.json().instance.instanceId as string;
    const archivedNotebook = await app.inject({ method: "POST", url: `/api/notebooks/${encodeURIComponent(newNotebookId)}/archive` });
    expect(archivedNotebook.statusCode).toBe(200);
    expect(archivedNotebook.json().instance.archivedAtMs).toEqual(expect.any(Number));
    expect((await app.inject({ method: "POST", url: `/api/notebooks/${encodeURIComponent(newNotebookId)}/restore` })).json().instance.archivedAtMs).toBeUndefined();
    expect((await app.inject({ method: "POST", url: `/api/notebooks/${encodeURIComponent(newNotebookId)}/activate` })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/pen/events", payload: [event(4, "pen_down"), event(5, "pen_move"), event(6, "pen_up")] })).statusCode).toBe(202);
    expect((await app.inject({ method: "GET", url: `/api/pages/NB01/12?physicalNotebookId=${encodeURIComponent(newNotebookId)}` })).json()).toMatchObject({ physicalNotebookId: newNotebookId, physicalNotebookName: "Work notes", strokes: [{ strokeId: expect.any(String) }] });
    expect((await app.inject({ method: "GET", url: "/api/pages/NB01/12" })).json().strokes).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/pages/NB01/12/svg" })).headers["content-type"]).toContain("image/svg+xml");
    expect((await app.inject({ method: "POST", url: "/api/export/obsidian", payload: { notebookId: "NB01", pageId: 12 } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/settings" })).json()).toMatchObject({ vaultPath: join(root, "vault"), source: "configured" });
    const customVault = join(root, "custom-vault");
    await mkdir(customVault);
    expect((await app.inject({ method: "PUT", url: "/api/settings/obsidian", payload: { vaultPath: customVault } })).json()).toMatchObject({ vaultPath: customVault, source: "saved" });
    expect((await app.inject({ method: "POST", url: "/api/export/obsidian", payload: { notebookId: "NB01", pageId: 12 } })).statusCode).toBe(200);
    await expect(access(join(customVault, "Smartpen", "Notebooks", "NB01", "Page_012.md"))).resolves.toBeUndefined();
    expect((await app.inject({ method: "PUT", url: "/api/settings/obsidian", payload: { vaultPath: "relative/vault" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/health" })).json().status).toBe("ok");
    expect((await app.inject({ method: "PUT", url: "/api/ink/style", payload: { color: "#249bd3", width: 5 } })).json().state).toMatchObject({ currentColor: "#249bd3", currentWidth: 5 });
    expect((await app.inject({ method: "PUT", url: "/api/ink/style", payload: { width: 0 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/pens" })).json().bluetooth).toMatchObject({ available: false, enabled: false });
    expect((await app.inject({ method: "POST", url: "/api/pens/bluetooth/retry" })).statusCode).toBe(503);
    expect((await app.inject({ method: "POST", url: "/api/pens/scan", payload: { durationMs: 1000 } })).statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: "/api/language/status" })).json()).toMatchObject({ status: "ok", model: "test-vision-model" });
    const firstReview = await app.inject({ method: "POST", url: "/api/language/review", payload: { notebookId: "NB01", pageId: 12, language: "English", explanationLanguage: "English" } });
    expect(firstReview.statusCode).toBe(200);
    expect(firstReview.json()).toMatchObject({ schemaVersion: "inkrelay.language_review.v1", originalText: "She go home.", corrections: [{ replacement: "goes" }] });
    const repeatedReview = await app.inject({ method: "POST", url: "/api/language/review", payload: { notebookId: "NB01", pageId: 12, language: "English", explanationLanguage: "English" } });
    expect(repeatedReview.json().reviewId).toBe(firstReview.json().reviewId);
    const reviews = (await app.inject({ method: "GET", url: "/api/language/reviews/NB01/12" })).json();
    expect(reviews.reviews).toHaveLength(1);
    expect(reviews.latest.reviewId).toBe(firstReview.json().reviewId);
    const reviewExport = await app.inject({ method: "POST", url: "/api/export/obsidian", payload: { notebookId: "NB01", pageId: 12 } });
    expect(reviewExport.statusCode).toBe(200);
    expect(reviewExport.json().languageReview.reviewId).toBe(firstReview.json().reviewId);
    const reviewMarkdown = await readFile(join(customVault, "Smartpen", "Reviews", "NB01", "Page_012 Review.md"), "utf8");
    expect(reviewMarkdown).toContain("## Original text\n\n> [!note] Model transcription");
    expect(reviewMarkdown).toContain("She go home.");
    expect(reviewMarkdown).toContain("## Natural corrected version\n\nShe goes home.");

    await app.close();
    app = undefined;
    ({ app } = await createApp(config, { languageReviewer }));
    expect((await app.inject({ method: "GET", url: "/api/pages/NB01/12" })).json()).toMatchObject({ width: 2100, height: 1480, strokes: [{ strokeId: expect.any(String) }] });
    expect((await app.inject({ method: "GET", url: `/api/pages/NB01/12?physicalNotebookId=${encodeURIComponent(newNotebookId)}` })).json().strokes).toHaveLength(1);
    const captureResponse = await app.inject({ method: "GET", url: "/api/notebooks/captures?paperIdentity=NB01" });
    expect(captureResponse.statusCode).toBe(200);
    const misplaced = (captureResponse.json().ranges as Array<Record<string, unknown>>).find((range) => range.instanceId === "NB01")!;
    const reassignment = await app.inject({
      method: "POST", url: "/api/notebooks/reassign",
      payload: { ...misplaced, fromInstanceId: "NB01", targetInstanceId: newNotebookId }
    });
    expect(reassignment.statusCode).toBe(200);
    expect(reassignment.json().reassignment).toMatchObject({ fromInstanceId: "NB01", targetInstanceId: newNotebookId });
    expect((await app.inject({ method: "GET", url: "/api/pages/NB01/12" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/pages/NB01/12?physicalNotebookId=${encodeURIComponent(newNotebookId)}` })).json().strokes).toHaveLength(2);
  });
});
