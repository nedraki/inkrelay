import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { NeoPenManager } from "@inkrelay/adapters";
import {
  LanguageReviewCoordinator, LanguageReviewHttpClient, LanguageReviewStore, type LanguageReviewer
} from "@inkrelay/workflows";
import { InkRelayEngine } from "./engine.js";
import type { ServerConfig } from "./config.js";
import { AppSettingsStore } from "./settings-store.js";
import { PaperProfileStore } from "./paper-profile-store.js";
import { PaperDefinitionStore } from "./paper-definition-store.js";
import { MAX_NPROJ_BYTES, parseNeoPaperDefinition } from "@inkrelay/adapters";
import type { PaperCalibration } from "@inkrelay/core";

export type AppDependencies = { readonly languageReviewer?: LanguageReviewer };

export async function createApp(config: ServerConfig, dependencies: AppDependencies = {}): Promise<{ readonly app: FastifyInstance; readonly engine: InkRelayEngine }> {
  const app = Fastify({ logger: true });
  const settingsStore = new AppSettingsStore(resolve(config.canonicalDataPath, "..", "settings.json"), config.vaultPath);
  const settings = await settingsStore.load();
  const engine = new InkRelayEngine({ ...config, vaultPath: settings.vaultPath });
  const paperProfileStore = new PaperProfileStore(config.paperProfilesPath ?? resolve(config.canonicalDataPath, "..", "paper-profiles.json"));
  const paperCatalog = await paperProfileStore.load();
  const paperDefinitionStore = new PaperDefinitionStore(config.paperDefinitionsPath ?? resolve(config.canonicalDataPath, "..", "paper-definitions.json"), config.automaticPaperEnabled !== false);
  let paperDefinitions = await paperDefinitionStore.load();
  engine.setPaperDefinitions(paperDefinitions);
  engine.setPaperProfiles(paperCatalog.profiles);
  await engine.initialize();
  const penManager = new NeoPenManager((event) => engine.ingest(event));
  const liveClients = new Set<() => void>();
  app.addHook("preClose", async () => { for (const close of liveClients) close(); });
  app.addHook("onClose", async () => { await penManager.close(); });
  const languageReviewer = dependencies.languageReviewer ?? new LanguageReviewHttpClient(config.languageWorkerUrl, config.languageReviewTimeoutMs);
  const languageReviews = new LanguageReviewCoordinator(
    new LanguageReviewStore(resolve(config.canonicalDataPath, "..", "language-reviews")), languageReviewer
  );
  if (config.bluetoothEnabled) await penManager.initialize();
  const penSnapshot = () => {
    const snapshot = penManager.snapshot();
    return { ...snapshot, bluetooth: { ...snapshot.bluetooth, enabled: config.bluetoothEnabled } };
  };
  const combinedSnapshot = () => ({ ...engine.snapshot(), pen: penSnapshot() });
  await app.register(cors, { origin: true });

  app.get("/api/health", async () => ({ status: "ok", service: "inkrelay", version: "0.1.0" }));
  app.get("/api/settings", async () => settingsStore.load());
  app.put<{ Body: { vaultPath?: string } }>("/api/settings/obsidian", async (request, reply) => {
    if (typeof request.body?.vaultPath !== "string") return reply.code(400).send({ error: "vaultPath is required" });
    try {
      const updated = await settingsStore.saveVaultPath(request.body.vaultPath);
      engine.setVaultPath(updated.vaultPath);
      return updated;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get("/api/paper/profiles", async () => ({
    ...(await paperProfileStore.load()),
    definitions: paperDefinitions,
    fallback: engine.fallbackPageDimensions(),
    observedNotebooks: [...new Set(engine.snapshot().pages.map((page) => page.notebookId))].sort()
  }));
  // Imports are serialized with each other so an older request cannot replace
  // the in-memory catalog after a newer one has already been persisted.
  let paperImportTail: Promise<unknown> = Promise.resolve();
  app.post<{ Body: { xml?: string; notebookId?: string } }>("/api/paper/metadata", { bodyLimit: MAX_NPROJ_BYTES * 2 + 4096 }, async (request, reply) => {
    if (typeof request.body?.xml !== "string") return reply.code(400).send({ error: "xml is required" });
    const { xml, notebookId } = request.body;
    const task = paperImportTail.then(async () => {
      const parsed = parseNeoPaperDefinition(xml);
      if (notebookId !== undefined && notebookId !== parsed.notebookId) throw new Error(`Metadata belongs to ${parsed.notebookId}, not the selected paper`);
      paperDefinitions = await paperDefinitionStore.import(xml);
      engine.setPaperDefinitions(paperDefinitions);
      return { ...(await paperProfileStore.load()), definitions: paperDefinitions, importedNotebookId: parsed.notebookId,
        fallback: engine.fallbackPageDimensions(), observedNotebooks: [...new Set(engine.snapshot().pages.map((page) => page.notebookId))].sort() };
    });
    paperImportTail = task.catch(() => undefined);
    try { return await task; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.put<{ Params: { notebookId: string }; Body: { displayName?: string; widthMm?: number; heightMm?: number; appPxPerMm?: number; calibration?: PaperCalibration } }>("/api/paper/profiles/:notebookId", async (request, reply) => {
    const { displayName, widthMm, heightMm, appPxPerMm, calibration } = request.body ?? {};
    if (typeof displayName !== "string" || typeof widthMm !== "number" || typeof heightMm !== "number") {
      return reply.code(400).send({ error: "displayName, widthMm, and heightMm are required" });
    }
    try {
      const catalog = await paperProfileStore.upsert(request.params.notebookId, {
        displayName, widthMm, heightMm, ...(typeof appPxPerMm === "number" ? { appPxPerMm } : {}), ...(calibration ? { calibration } : {})
      });
      engine.setPaperProfiles(catalog.profiles);
      return {
        ...catalog,
        definitions: paperDefinitions,
        profile: catalog.profiles.find((profile) => profile.notebookId === request.params.notebookId),
        fallback: engine.fallbackPageDimensions(),
        observedNotebooks: [...new Set(engine.snapshot().pages.map((page) => page.notebookId))].sort()
      };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get("/api/notebooks", async () => engine.snapshot().physicalNotebooks);
  app.get<{ Querystring: { paperIdentity?: string } }>("/api/notebooks/captures", async (request, reply) => {
    if (typeof request.query.paperIdentity !== "string" || !request.query.paperIdentity.trim()) {
      return reply.code(400).send({ error: "paperIdentity is required" });
    }
    return { ranges: await engine.physicalNotebookCaptureRanges(request.query.paperIdentity) };
  });
  app.post<{ Body: { paperIdentity?: string; displayName?: string } }>("/api/notebooks", async (request, reply) => {
    const { paperIdentity, displayName } = request.body ?? {};
    if (typeof paperIdentity !== "string" || typeof displayName !== "string") return reply.code(400).send({ error: "paperIdentity and displayName are required" });
    try { return reply.code(201).send({ instance: await engine.createPhysicalNotebook(paperIdentity, displayName), catalog: engine.snapshot().physicalNotebooks }); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.put<{ Params: { instanceId: string }; Body: { displayName?: string } }>("/api/notebooks/:instanceId", async (request, reply) => {
    if (typeof request.body?.displayName !== "string") return reply.code(400).send({ error: "displayName is required" });
    try { return { instance: await engine.renamePhysicalNotebook(request.params.instanceId, request.body.displayName), catalog: engine.snapshot().physicalNotebooks }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post<{ Params: { instanceId: string } }>("/api/notebooks/:instanceId/activate", async (request, reply) => {
    try { return { instance: await engine.activatePhysicalNotebook(request.params.instanceId), catalog: engine.snapshot().physicalNotebooks }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post<{ Params: { instanceId: string } }>("/api/notebooks/:instanceId/archive", async (request, reply) => {
    try { return { instance: await engine.archivePhysicalNotebook(request.params.instanceId), catalog: engine.snapshot().physicalNotebooks }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post<{ Params: { instanceId: string } }>("/api/notebooks/:instanceId/restore", async (request, reply) => {
    try { return { instance: await engine.restorePhysicalNotebook(request.params.instanceId), catalog: engine.snapshot().physicalNotebooks }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post<{ Body: {
    paperIdentity?: string; penId?: string; sessionId?: string; pageId?: number; startSequence?: number; endSequence?: number;
    fromInstanceId?: string; targetInstanceId?: string;
  } }>("/api/notebooks/reassign", async (request, reply) => {
    const { paperIdentity, penId, sessionId, pageId, startSequence, endSequence, fromInstanceId, targetInstanceId } = request.body ?? {};
    if (typeof paperIdentity !== "string" || typeof penId !== "string" || typeof sessionId !== "string"
      || !Number.isInteger(pageId) || !Number.isInteger(startSequence) || !Number.isInteger(endSequence)
      || typeof fromInstanceId !== "string" || typeof targetInstanceId !== "string") {
      return reply.code(400).send({ error: "paperIdentity, penId, sessionId, integer page/range sequences, fromInstanceId, and targetInstanceId are required" });
    }
    try {
      const reassignment = await engine.reassignPhysicalNotebookCapture({
        paperIdentity, penId, sessionId, pageId: pageId as number, startSequence: startSequence as number, endSequence: endSequence as number,
        fromInstanceId, targetInstanceId
      });
      return { reassignment, catalog: engine.snapshot().physicalNotebooks, ranges: await engine.physicalNotebookCaptureRanges(paperIdentity) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post("/api/pen/dot", async (request, reply) => { const result = await engine.ingest(request.body); return reply.code(result.accepted ? 202 : 200).send(result); });
  app.post("/api/pen/events", async (request, reply) => {
    if (!Array.isArray(request.body)) return reply.code(400).send({ error: "Request body must be an array of PenDotEvent objects" });
    return reply.code(202).send(await engine.ingestMany(request.body));
  });
  app.post("/api/replay/sample", async (_request, reply) => {
    const content = await readFile(resolve(process.cwd(), "fixtures/sample-session.events.jsonl"), "utf8");
    const events = content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
    return reply.code(202).send(await engine.ingestMany(events));
  });
  app.post("/api/mock", async (_request, reply) => {
    const content = await readFile(resolve(process.cwd(), "fixtures/sample-session.events.jsonl"), "utf8");
    const events = content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
    return reply.code(202).send(await engine.ingestMany(events.slice(0, 6)));
  });
  app.post("/api/debug/clear", async () => { engine.clearDebugState(); return { cleared: true, canonicalLogsPreserved: true }; });
  app.post<{ Body: { notebookId?: string; physicalNotebookId?: string; pageId?: number } }>("/api/export/obsidian", async (request, reply) => {
    const notebookId = request.body?.notebookId;
    const pageId = request.body?.pageId;
    if (!notebookId || !Number.isInteger(pageId)) return reply.code(400).send({ error: "notebookId and integer pageId are required" });
    const physicalNotebookId = request.body?.physicalNotebookId;
    const pageExport = await engine.export(notebookId, pageId as number, physicalNotebookId);
    const latestReview = (await languageReviews.reviewsForPage(notebookId, pageId as number, physicalNotebookId))[0];
    const reviewExport = latestReview
      ? await engine.exportLanguageReview(notebookId, pageId as number, latestReview, physicalNotebookId)
      : undefined;
    return { ...pageExport, ...(reviewExport ? { languageReview: reviewExport } : {}) };
  });
  app.get<{ Params: { notebookId: string; pageId: string }; Querystring: { physicalNotebookId?: string } }>("/api/pages/:notebookId/:pageId", async (request, reply) => {
    const page = engine.page(request.params.notebookId, Number(request.params.pageId), request.query.physicalNotebookId);
    return page ?? reply.code(404).send({ error: "Page not found" });
  });
  app.get<{ Params: { notebookId: string; pageId: string }; Querystring: { physicalNotebookId?: string } }>("/api/pages/:notebookId/:pageId/svg", async (request, reply) => {
    const svg = engine.svg(request.params.notebookId, Number(request.params.pageId), request.query.physicalNotebookId);
    if (!svg) return reply.code(404).send({ error: "Page not found" });
    return reply.type("image/svg+xml").send(svg);
  });
  app.get("/api/actions/recent", async () => engine.snapshot().recentActions);
  app.put<{ Body: { color?: string; width?: number } }>("/api/ink/style", async (request, reply) => {
    try { return { state: await engine.updateInkStyle(request.body ?? {}) }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.get("/api/workflows", async () => ({ intents: engine.snapshot().workflows, execution: "queued" }));
  app.get("/api/language/status", async () => {
    try { return await languageReviews.health(); }
    catch (error) { return { status: "unavailable", error: error instanceof Error ? error.message : String(error) }; }
  });
  app.get<{ Params: { notebookId: string; pageId: string }; Querystring: { physicalNotebookId?: string } }>("/api/language/reviews/:notebookId/:pageId", async (request, reply) => {
    const pageId = Number(request.params.pageId);
    if (!Number.isInteger(pageId)) return reply.code(400).send({ error: "pageId must be an integer" });
    const reviews = await languageReviews.reviewsForPage(request.params.notebookId, pageId, request.query.physicalNotebookId);
    return { reviews, latest: reviews[0] ?? null };
  });
  app.post<{ Body: { notebookId?: string; physicalNotebookId?: string; pageId?: number; language?: string; explanationLanguage?: string } }>("/api/language/review", async (request, reply) => {
    const { notebookId, physicalNotebookId, pageId, language, explanationLanguage } = request.body ?? {};
    if (!notebookId || !Number.isInteger(pageId) || typeof language !== "string" || typeof explanationLanguage !== "string") {
      return reply.code(400).send({ error: "notebookId, integer pageId, language, and explanationLanguage are required" });
    }
    const page = engine.page(notebookId, pageId as number, physicalNotebookId);
    if (!page) return reply.code(404).send({ error: "Page not found" });
    return reply.code(200).send(await languageReviews.review(page, { language, explanationLanguage }));
  });
  app.get("/api/action-zones", async () => JSON.parse(await readFile(config.actionZonesPath, "utf8")) as unknown);
  app.get("/api/pens", async () => penSnapshot());
  app.post("/api/pens/bluetooth/retry", async (_request, reply) => {
    requireBluetooth(config);
    await penManager.initialize();
    const snapshot = penSnapshot();
    if (!snapshot.bluetooth.available) {
      return reply.code(503).send({ ...snapshot, error: snapshot.bluetooth.error ?? "Bluetooth is unavailable" });
    }
    return snapshot;
  });
  app.post<{ Body: { durationMs?: number } }>("/api/pens/scan", async (request) => { requireBluetooth(config); await penManager.scan(request.body?.durationMs ?? 10_000); return penSnapshot(); });
  app.post<{ Body: { deviceId?: string } }>("/api/pens/connect", async (request, reply) => {
    requireBluetooth(config);
    if (!request.body?.deviceId) return reply.code(400).send({ error: "deviceId is required" });
    await penManager.connect(request.body.deviceId); return penSnapshot();
  });
  app.post("/api/pens/disconnect", async () => { await penManager.disconnect(); return penSnapshot(); });
  app.post<{ Body: { password?: string } }>("/api/pens/authenticate", async (request, reply) => {
    if (!request.body?.password) return reply.code(400).send({ error: "password is required" });
    await penManager.authenticate(request.body.password); return penSnapshot();
  });
  app.post("/api/pens/offline/refresh", async () => { await penManager.refreshOfflineNotes(); return penSnapshot(); });
  app.post("/api/pens/offline/sync", async () => { await penManager.syncAll(); return penSnapshot(); });
  app.get("/api/state", async () => combinedSnapshot());
  app.get("/api/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (snapshot: unknown): void => { reply.raw.write(`data: ${JSON.stringify(snapshot)}\n\n`); };
    send(combinedSnapshot());
    const unsubscribeEngine = engine.subscribe(() => send(combinedSnapshot()));
    const unsubscribePen = penManager.subscribe(() => send(combinedSnapshot()));
    const close = (): void => { unsubscribeEngine(); unsubscribePen(); liveClients.delete(close); reply.raw.end(); };
    liveClients.add(close);
    reply.raw.on("close", close);
  });

  app.setErrorHandler((error, _request, reply) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    const explicitStatus = "statusCode" in normalized && typeof normalized.statusCode === "number" ? normalized.statusCode : undefined;
    const status = explicitStatus ?? ("issues" in normalized ? 400 : normalized.message.startsWith("Unknown page") ? 404 : 500);
    reply.code(status).send({ error: normalized.message });
  });

  const webDist = resolve(process.cwd(), "apps/web/dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.get("/*", (_request, reply) => reply.sendFile("index.html"));
  }
  return { app, engine };
}

function requireBluetooth(config: ServerConfig): void {
  if (!config.bluetoothEnabled) throw Object.assign(new Error("Bluetooth support is disabled by INKRELAY_BLUETOOTH_ENABLED=false"), { statusCode: 503 });
}
