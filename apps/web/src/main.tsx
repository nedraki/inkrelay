import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PageMapper, type PaperDefinition, type PaperAction, type PaperCalibration, type PenSessionState, type SmartpenPage, type Stroke } from "@inkrelay/core";
import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { projectPageToExcalidraw, type ExcalidrawProjectionMode } from "@inkrelay/render-excalidraw";
import { locateCorrections } from "./language-review.js";
import { adjacentPage, adjacentSpreadPage, automaticSpread, groupNotebookPages, physicalNotebookId } from "./page-navigation.js";
import { createReplayTimeline, formatReplayTime, replayPointAt } from "./replay.js";
import "@fontsource-variable/manrope";
import "@fontsource-variable/literata";
import "@excalidraw/excalidraw/index.css";
import "./styles.css";

type PenSnapshot = {
  readonly bluetooth: { readonly enabled?: boolean; readonly available: boolean; readonly adapterName?: string; readonly scanning: boolean; readonly error?: string };
  readonly devices: readonly { readonly deviceId: string; readonly name: string; readonly address: string; readonly rssi?: number }[];
  readonly connection: "disconnected" | "connecting" | "negotiating" | "password_required" | "connected" | "disconnecting" | "error";
  readonly selectedDeviceId?: string;
  readonly deviceInfo?: { readonly deviceName: string; readonly firmwareVersion: string; readonly protocolVersion: string };
  readonly penStatus?: { readonly batteryPercent: number; readonly usedStoragePercent: number; readonly offlineDataEnabled: boolean };
  readonly offlineNotes: readonly unknown[];
  readonly sync: { readonly active: boolean; readonly completedNotes: number; readonly totalNotes: number; readonly receivedStrokes: number; readonly totalStrokes: number; readonly importedStrokes: number; readonly duplicateStrokes: number; readonly finishedAtMs?: number; readonly error?: string };
};
type PhysicalNotebook = { readonly instanceId: string; readonly paperIdentity: string; readonly displayName: string; readonly createdAtMs: number; readonly updatedAtMs: number; readonly archivedAtMs?: number };
type NotebookInstancesCatalog = { readonly schemaVersion: "inkrelay.notebook_instances.v3"; readonly instances: readonly PhysicalNotebook[]; readonly activeInstances: readonly { readonly paperIdentity: string; readonly instanceId: string }[]; readonly assignments: readonly unknown[]; readonly reassignments: readonly unknown[] };
type PhysicalNotebookCaptureRange = {
  readonly paperIdentity: string; readonly penId: string; readonly sessionId: string; readonly pageId: number;
  readonly startSequence: number; readonly endSequence: number; readonly startedAtMs: number; readonly endedAtMs: number;
  readonly eventCount: number; readonly strokeCount: number; readonly instanceId: string;
};
type Snapshot = { readonly state: PenSessionState; readonly pages: readonly SmartpenPage[]; readonly warnings: readonly string[]; readonly recentActions: readonly PaperAction[]; readonly workflows: readonly { readonly intentId: string; readonly kind: string }[]; readonly physicalNotebooks: NotebookInstancesCatalog; readonly pen: PenSnapshot };
type AppSettings = { readonly vaultPath: string; readonly source: "configured" | "saved"; readonly warning?: string };
type PaperProfile = { readonly notebookId: string; readonly displayName: string; readonly widthMm: number; readonly heightMm: number; readonly appPxPerMm: number; readonly calibration?: PaperCalibration; readonly revision: number };
type PaperCatalog = { readonly schemaVersion: "inkrelay.paper_catalog.v2"; readonly profiles: readonly PaperProfile[]; readonly definitions?: readonly PaperDefinition[]; readonly fallback: { readonly width: number; readonly height: number; readonly unit: "app_px" }; readonly observedNotebooks: readonly string[] };
type Zone = {
  readonly zoneId: string;
  readonly label: string;
  readonly pageScope: "all_pages" | { readonly notebookId: string; readonly pageIds: readonly number[] };
  readonly bounds: { x: number; y: number; width: number; height: number };
};
type LanguageCorrection = {
  readonly correctionId: string;
  readonly original: string;
  readonly replacement: string;
  readonly category: string;
  readonly explanation: string;
  readonly examples: readonly { readonly incorrect: string; readonly correct: string }[];
};
type LanguageReview = {
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
  readonly corrections: readonly LanguageCorrection[];
  readonly strengths: readonly string[];
  readonly nextSteps: readonly string[];
  readonly completedAtMs: number;
  readonly provenance: { readonly provider: string; readonly model: string; readonly pipelineVersion: string; readonly inputMode: "page_image" };
};
const emptyPen: PenSnapshot = { bluetooth: { available: false, scanning: false }, devices: [], connection: "disconnected", offlineNotes: [], sync: { active: false, completedNotes: 0, totalNotes: 0, receivedStrokes: 0, totalStrokes: 0, importedStrokes: 0, duplicateStrokes: 0 } };
const emptyNotebookInstances: NotebookInstancesCatalog = { schemaVersion: "inkrelay.notebook_instances.v3", instances: [], activeInstances: [], assignments: [], reassignments: [] };
const empty: Snapshot = { state: { currentColor: "#111111", currentWidth: 2, currentTool: "pen", importantPages: [] }, pages: [], warnings: [], recentActions: [], workflows: [], physicalNotebooks: emptyNotebookInstances, pen: emptyPen };
const AUTO_FOLLOW_ZOOM = 130;
const SPREAD_OVERRIDES_STORAGE_KEY = "inkrelay.spread-pairs.v1";
const INK_COLORS = ["#111111", "#e53935", "#249bd3", "#59a14f", "#f2c12e", "#b33b8f", "#f47b20", "#7b8580"] as const;
const INK_WIDTHS = [{ value: 1, label: "Fine" }, { value: 2, label: "Medium" }, { value: 5, label: "Bold" }] as const;
type SpreadOverride = { readonly leftPageId: number; readonly rightPageId: number };

function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [selected, setSelected] = useState("");
  const [zones, setZones] = useState<Zone[]>([]);
  const [showZones, setShowZones] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [selectedPen, setSelectedPen] = useState("");
  const [penPassword, setPenPassword] = useState("");
  const [zoom, setZoom] = useState(AUTO_FOLLOW_ZOOM);
  const [autoFollow, setAutoFollow] = useState(true);
  const [replayActive, setReplayActive] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);
  const [spreadMode, setSpreadMode] = useState(false);
  const [spreadOverrides, setSpreadOverrides] = useState<Record<string, SpreadOverride>>(() => loadSpreadOverrides());
  const [view, setView] = useState<"page" | ExcalidrawProjectionMode | "language">("page");
  const [captureOpen, setCaptureOpen] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>();
  const [vaultPath, setVaultPath] = useState("");
  const [savingVault, setSavingVault] = useState(false);
  const [vaultMessage, setVaultMessage] = useState("");
  const [paperCatalog, setPaperCatalog] = useState<PaperCatalog>();
  const [paperName, setPaperName] = useState("");
  const [paperWidthMm, setPaperWidthMm] = useState("");
  const [paperHeightMm, setPaperHeightMm] = useState("");
  const [savingPaper, setSavingPaper] = useState(false);
  const [paperMessage, setPaperMessage] = useState("");
  const [physicalNotebookName, setPhysicalNotebookName] = useState("");
  const [newPhysicalNotebookName, setNewPhysicalNotebookName] = useState("");
  const [creatingPhysicalNotebook, setCreatingPhysicalNotebook] = useState(false);
  const [savingPhysicalNotebook, setSavingPhysicalNotebook] = useState(false);
  const [physicalNotebookMessage, setPhysicalNotebookMessage] = useState("");
  const [captureRanges, setCaptureRanges] = useState<readonly PhysicalNotebookCaptureRange[]>([]);
  const [selectedCaptureRange, setSelectedCaptureRange] = useState("");
  const [reassignmentTarget, setReassignmentTarget] = useState("");
  const [reassigningCapture, setReassigningCapture] = useState(false);
  const [notebookMenu, setNotebookMenu] = useState("");
  const paperViewportRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const replayFollowTargetRef = useRef<{ readonly x: number; readonly y: number } | undefined>(undefined);

  useEffect(() => {
    void fetch("/api/state").then((result) => result.json()).then(setSnapshot);
    void fetch("/api/action-zones").then((result) => result.json()).then((config: { zones: Zone[] }) => setZones(config.zones));
    void fetch("/api/settings").then((result) => result.json()).then((value: AppSettings) => { setSettings(value); setVaultPath(value.vaultPath); });
    void fetch("/api/paper/profiles").then((result) => result.json()).then((value: PaperCatalog) => setPaperCatalog(value));
    const source = new EventSource("/api/events");
    source.onmessage = (event) => setSnapshot(JSON.parse(event.data) as Snapshot);
    return () => source.close();
  }, []);

  const archivedNotebookIds = useMemo(() => new Set(snapshot.physicalNotebooks.instances.filter((instance) => instance.archivedAtMs !== undefined).map((instance) => instance.instanceId)), [snapshot.physicalNotebooks.instances]);
  const archivedNotebooks = useMemo(() => snapshot.physicalNotebooks.instances.filter((instance) => instance.archivedAtMs !== undefined), [snapshot.physicalNotebooks.instances]);
  const visiblePages = useMemo(() => snapshot.pages.filter((candidate) => !isCommandSurface(candidate.notebookId) && !archivedNotebookIds.has(physicalNotebookId(candidate))), [snapshot.pages, archivedNotebookIds]);
  const notebooks = useMemo(() => groupNotebookPages(visiblePages), [visiblePages]);
  const latestVisiblePage = useMemo(() => visiblePages.reduce<SmartpenPage | undefined>((latest, candidate) => !latest || candidate.updatedAtMs > latest.updatedAtMs ? candidate : latest, undefined), [visiblePages]);
  useEffect(() => {
    if (latestVisiblePage && (!selected || (autoFollow && !replayActive && selected !== key(latestVisiblePage)))) setSelected(key(latestVisiblePage));
  }, [autoFollow, replayActive, latestVisiblePage?.notebookId, latestVisiblePage?.physicalNotebookId, latestVisiblePage?.pageId, latestVisiblePage?.updatedAtMs, selected]);
  useEffect(() => { if (!selectedPen && snapshot.pen.devices[0]) setSelectedPen(snapshot.pen.devices[0].deviceId); }, [selectedPen, snapshot.pen.devices]);
  const page = useMemo(() => visiblePages.find((candidate) => key(candidate) === selected) ?? visiblePages[0], [selected, visiblePages]);
  const notebook = useMemo(() => notebooks.find((candidate) => candidate.notebookId === (page ? physicalNotebookId(page) : "")) ?? notebooks[0], [notebooks, page]);
  const notebookPages = notebook?.pages ?? [];
  const automaticPageIds = automaticSpread(page?.pageId ?? 0);
  const spreadOverrideId = `${notebook?.notebookId ?? "empty"}:${automaticPageIds.leftPageId}`;
  const spreadPageIds = spreadOverrides[spreadOverrideId] ?? automaticPageIds;
  const leftSpreadPage = notebookPages.find((candidate) => candidate.pageId === spreadPageIds.leftPageId);
  const rightSpreadPage = notebookPages.find((candidate) => candidate.pageId === spreadPageIds.rightPageId);
  const spreadPageOptions = [...new Set([...notebookPages.map((candidate) => candidate.pageId), spreadPageIds.leftPageId, spreadPageIds.rightPageId])].sort((left, right) => left - right);
  const previousPage = page ? (spreadMode ? adjacentSpreadPage(notebookPages, page.pageId, -1) : adjacentPage(notebookPages, page.pageId, -1)) : undefined;
  const nextPage = page ? (spreadMode ? adjacentSpreadPage(notebookPages, page.pageId, 1) : adjacentPage(notebookPages, page.pageId, 1)) : undefined;
  const paperProfile = useMemo(() => page ? paperCatalog?.profiles.find((profile) => profile.notebookId === page.notebookId) : undefined, [page?.notebookId, paperCatalog]);
  const paperMapping = useMemo(() => {
    if (!page || !paperCatalog) return undefined;
    const mapper = new PageMapper(paperCatalog.fallback, paperCatalog.profiles);
    mapper.replaceDefinitions(paperCatalog.definitions ?? []);
    return mapper.mappingFor(page.notebookId, page.pageId);
  }, [page?.notebookId, page?.pageId, paperCatalog]);
  const paperProjectionKey = useMemo(() => String(stableElementSeed(JSON.stringify({ profiles: paperCatalog?.profiles, definitions: paperCatalog?.definitions }))), [paperCatalog]);
  const automaticPaper = paperMapping?.source === "nproj" || paperMapping?.source === "measured_reference";
  const physicalNotebooksForPaper = useMemo(() => page ? snapshot.physicalNotebooks.instances.filter((instance) => instance.paperIdentity === page.notebookId && instance.archivedAtMs === undefined) : [], [page?.notebookId, snapshot.physicalNotebooks.instances]);
  const activePhysicalNotebookId = page ? snapshot.physicalNotebooks.activeInstances.find((active) => active.paperIdentity === page.notebookId)?.instanceId ?? page.physicalNotebookId ?? page.notebookId : "";
  const activePhysicalNotebook = snapshot.physicalNotebooks.instances.find((instance) => instance.instanceId === activePhysicalNotebookId);
  const pageCaptureRanges = useMemo(() => page ? captureRanges.filter((range) => range.pageId === page.pageId && range.instanceId === physicalNotebookId(page)) : [], [captureRanges, page?.notebookId, page?.physicalNotebookId, page?.pageId]);
  const captureRange = pageCaptureRanges.find((range) => captureRangeKey(range) === selectedCaptureRange) ?? pageCaptureRanges[0];
  const reassignmentTargets = physicalNotebooksForPaper.filter((instance) => instance.instanceId !== captureRange?.instanceId);
  useEffect(() => {
    setPaperName(paperProfile?.displayName ?? "");
    setPaperWidthMm(paperProfile ? String(paperProfile.widthMm) : "");
    setPaperHeightMm(paperProfile ? String(paperProfile.heightMm) : "");
  }, [page?.notebookId, paperProfile?.revision]);
  useEffect(() => { setPaperMessage(""); }, [page?.notebookId]);
  useEffect(() => {
    setPhysicalNotebookName(activePhysicalNotebook?.displayName ?? "");
    setCreatingPhysicalNotebook(false);
    setNewPhysicalNotebookName("");
  }, [page?.notebookId, activePhysicalNotebook?.instanceId, activePhysicalNotebook?.updatedAtMs]);
  useEffect(() => { setPhysicalNotebookMessage(""); }, [page?.notebookId]);
  useEffect(() => {
    if (!captureOpen || !page) return;
    void fetch(`/api/notebooks/captures?paperIdentity=${encodeURIComponent(page.notebookId)}`)
      .then(async (response) => {
        const result = await response.json() as { ranges?: readonly PhysicalNotebookCaptureRange[]; error?: string };
        if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
        setCaptureRanges(result.ranges ?? []);
      })
      .catch((error) => setPhysicalNotebookMessage(error instanceof Error ? error.message : String(error)));
  }, [captureOpen, page?.notebookId, snapshot.physicalNotebooks.assignments.length, snapshot.physicalNotebooks.reassignments.length]);
  useEffect(() => {
    const nextRange = pageCaptureRanges[0];
    if (!captureRange || !pageCaptureRanges.some((range) => captureRangeKey(range) === selectedCaptureRange)) {
      setSelectedCaptureRange(nextRange ? captureRangeKey(nextRange) : "");
    }
  }, [page?.notebookId, page?.physicalNotebookId, page?.pageId, pageCaptureRanges]);
  useEffect(() => {
    if (!reassignmentTargets.some((instance) => instance.instanceId === reassignmentTarget)) setReassignmentTarget(reassignmentTargets[0]?.instanceId ?? "");
  }, [captureRange?.instanceId, physicalNotebooksForPaper]);
  useEffect(() => { setReplayActive(false); }, [page?.notebookId, page?.physicalNotebookId, page?.pageId]);
  const visibleZones = useMemo(() => page ? zones.filter((zone) => zone.pageScope === "all_pages" || (zone.pageScope.notebookId === page.notebookId && zone.pageScope.pageIds.includes(page.pageId))) : [], [page, zones]);

  const followPaperPoint = useCallback((point: { readonly x: number; readonly y: number }, behavior: ScrollBehavior = "auto"): void => {
    const viewport = paperViewportRef.current;
    const paper = paperRef.current;
    if (!viewport || !paper || !page) return;
    const x = paper.offsetLeft + point.x / page.width * paper.clientWidth;
    const y = paper.offsetTop + point.y / page.height * paper.clientHeight;
    viewport.scrollTo({ left: x - viewport.clientWidth / 2, top: y - viewport.clientHeight / 2, behavior });
  }, [page?.notebookId, page?.physicalNotebookId, page?.pageId, page?.width, page?.height]);

  useEffect(() => {
    if (!autoFollow || replayActive || !page) return;
    const point = page.strokes.at(-1)?.points.at(-1);
    if (!point) return;
    const frame = requestAnimationFrame(() => followPaperPoint(point, "smooth"));
    return () => cancelAnimationFrame(frame);
  }, [autoFollow, replayActive, page?.updatedAtMs, zoom, followPaperPoint]);

  const queueReplayFollow = useCallback((point: { readonly x: number; readonly y: number }): void => {
    replayFollowTargetRef.current = point;
  }, []);

  useEffect(() => {
    if (!autoFollow || !replayActive || !page) {
      replayFollowTargetRef.current = undefined;
      return;
    }
    let frame = 0;
    let previous = performance.now();
    const glide = (now: number): void => {
      const viewport = paperViewportRef.current;
      const paper = paperRef.current;
      const point = replayFollowTargetRef.current;
      if (viewport && paper && point) {
        const pageX = paper.offsetLeft + point.x / page.width * paper.clientWidth;
        const pageY = paper.offsetTop + point.y / page.height * paper.clientHeight;
        const visibleX = pageX - viewport.scrollLeft;
        const visibleY = pageY - viewport.scrollTop;
        const leftEdge = viewport.clientWidth * 0.25;
        const rightEdge = viewport.clientWidth * 0.75;
        const topEdge = viewport.clientHeight * 0.25;
        const bottomEdge = viewport.clientHeight * 0.75;
        let targetLeft = viewport.scrollLeft;
        let targetTop = viewport.scrollTop;
        if (visibleX < leftEdge) targetLeft = pageX - leftEdge;
        else if (visibleX > rightEdge) targetLeft = pageX - rightEdge;
        if (visibleY < topEdge) targetTop = pageY - topEdge;
        else if (visibleY > bottomEdge) targetTop = pageY - bottomEdge;
        const blend = 1 - Math.exp(-(now - previous) / 180);
        const left = viewport.scrollLeft + (targetLeft - viewport.scrollLeft) * blend;
        const top = viewport.scrollTop + (targetTop - viewport.scrollTop) * blend;
        if (Math.abs(left - viewport.scrollLeft) > 0.25 || Math.abs(top - viewport.scrollTop) > 0.25) viewport.scrollTo({ left, top, behavior: "auto" });
      }
      previous = now;
      frame = requestAnimationFrame(glide);
    };
    frame = requestAnimationFrame(glide);
    return () => cancelAnimationFrame(frame);
  }, [autoFollow, replayActive, page?.notebookId, page?.physicalNotebookId, page?.pageId, page?.width, page?.height, zoom]);

  function changeZoom(next: number): void {
    setAutoFollow(false);
    setZoom(Math.max(75, Math.min(300, next)));
  }

  function selectPage(next: SmartpenPage | undefined): void {
    if (!next) return;
    setSelected(key(next));
    setAutoFollow(false);
  }

  function selectNotebook(notebookId: string): void {
    const nextNotebook = notebooks.find((candidate) => candidate.notebookId === notebookId);
    const nextPage = nextNotebook?.pages.reduce<SmartpenPage | undefined>((latest, candidate) => !latest || candidate.updatedAtMs > latest.updatedAtMs ? candidate : latest, undefined);
    selectPage(nextPage);
  }

  function updateSpreadOverride(side: "left" | "right", pageId: number): void {
    const next = side === "left" ? { ...spreadPageIds, leftPageId: pageId } : { ...spreadPageIds, rightPageId: pageId };
    setSpreadOverrides((current) => {
      const updated = { ...current, [spreadOverrideId]: next };
      saveSpreadOverrides(updated);
      return updated;
    });
  }

  function resetSpreadOverride(): void {
    setSpreadOverrides((current) => {
      const updated = { ...current };
      delete updated[spreadOverrideId];
      saveSpreadOverrides(updated);
      return updated;
    });
  }

  async function command(path: string, body?: unknown): Promise<void> {
    setStatus("Working…");
    try {
      const response = await fetch(path, {
        method: "POST",
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setStatus(path.includes("export") ? "Export complete" : "Done");
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  }

  async function setInkStyle(update: { readonly color?: string; readonly width?: number }): Promise<void> {
    setStatus("Updating ink…");
    try {
      const response = await fetch("/api/ink/style", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(update) });
      const result = await response.json() as { state?: PenSessionState; error?: string };
      if (!response.ok || !result.state) throw new Error(result.error ?? `HTTP ${response.status}`);
      setSnapshot((current) => ({ ...current, state: result.state! }));
      setStatus("Ink style updated");
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  }

  async function saveVaultPath(): Promise<void> {
    setSavingVault(true);
    setVaultMessage("");
    try {
      const response = await fetch("/api/settings/obsidian", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ vaultPath }) });
      const result = await response.json() as AppSettings & { error?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setSettings(result);
      setVaultPath(result.vaultPath);
      setVaultMessage("Vault saved. Future exports will go here.");
      setStatus("Vault updated");
    } catch (error) { setVaultMessage(error instanceof Error ? error.message : String(error)); }
    finally { setSavingVault(false); }
  }

  async function savePaperProfile(): Promise<void> {
    if (!page) return;
    setSavingPaper(true);
    setPaperMessage("");
    try {
      const response = await fetch(`/api/paper/profiles/${encodeURIComponent(page.notebookId)}`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: paperName, widthMm: Number(paperWidthMm), heightMm: Number(paperHeightMm) })
      });
      const result = await response.json() as PaperCatalog & { error?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setPaperCatalog(result);
      setPaperMessage("Paper profile saved. Every page in this notebook now uses these dimensions.");
      setStatus("Paper profile updated");
    } catch (error) { setPaperMessage(error instanceof Error ? error.message : String(error)); }
    finally { setSavingPaper(false); }
  }

  async function importPaperMetadata(file: File): Promise<void> {
    setSavingPaper(true);
    setPaperMessage("");
    try {
      if (file.size > 2_000_000) throw new Error("Paper metadata exceeds 2 MB");
      const response = await fetch("/api/paper/metadata", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ xml: await file.text(), ...(page ? { notebookId: page.notebookId } : {}) })
      });
      const result = await response.json() as PaperCatalog & { error?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setPaperCatalog(result);
      setPaperMessage(paperProfile ? "Paper metadata imported. Your saved manual profile remains active." : "Paper metadata imported. Matching pages now map automatically without crosses.");
    } catch (error) { setPaperMessage(error instanceof Error ? error.message : String(error)); }
    finally { setSavingPaper(false); }
  }

  async function calibratePaperProfile(): Promise<void> {
    if (!page || !paperProfile) return;
    setSavingPaper(true);
    setPaperMessage("");
    try {
      const recent = page.strokes.filter((stroke) => stroke.semanticRole !== "action").slice(-4);
      if (recent.length !== 4) throw new Error("Four recent ink strokes are required: two strokes for each calibration cross.");
      const firstProjected = crossCentre(recent[0]!, recent[1]!);
      const secondProjected = crossCentre(recent[2]!, recent[3]!);
      const first = sourcePoint(firstProjected, paperProfile.calibration);
      const second = sourcePoint(secondProjected, paperProfile.calibration);
      const marginMm = 10;
      if (paperProfile.widthMm <= marginMm * 2 || paperProfile.heightMm <= marginMm * 2) throw new Error("Paper dimensions are too small for 10 mm calibration margins.");
      const targetFirst = { x: marginMm * paperProfile.appPxPerMm, y: marginMm * paperProfile.appPxPerMm };
      const targetSecond = { x: (paperProfile.widthMm - marginMm) * paperProfile.appPxPerMm, y: (paperProfile.heightMm - marginMm) * paperProfile.appPxPerMm };
      const scaleX = (targetSecond.x - targetFirst.x) / (second.x - first.x);
      const scaleY = (targetSecond.y - targetFirst.y) / (second.y - first.y);
      if (!(scaleX > 0) || !(scaleY > 0)) throw new Error("The first cross must be at the top-left and the second at the bottom-right.");
      const calibration: PaperCalibration = {
        kind: "axis_aligned_affine", scaleX, scaleY,
        offsetX: targetFirst.x - first.x * scaleX, offsetY: targetFirst.y - first.y * scaleY,
        anchors: [
          { sourceX: first.x, sourceY: first.y, paperXMm: marginMm, paperYMm: marginMm },
          { sourceX: second.x, sourceY: second.y, paperXMm: paperProfile.widthMm - marginMm, paperYMm: paperProfile.heightMm - marginMm }
        ]
      };
      const response = await fetch(`/api/paper/profiles/${encodeURIComponent(page.notebookId)}`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: paperProfile.displayName, widthMm: paperProfile.widthMm, heightMm: paperProfile.heightMm, appPxPerMm: paperProfile.appPxPerMm, calibration })
      });
      const result = await response.json() as PaperCatalog & { error?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setPaperCatalog(result);
      setPaperMessage("Paper calibrated. Existing and future pages now use the measured coordinate mapping.");
      setStatus("Paper calibrated");
    } catch (error) { setPaperMessage(error instanceof Error ? error.message : String(error)); }
    finally { setSavingPaper(false); }
  }

  async function activatePhysicalNotebook(instanceId: string): Promise<void> {
    setSavingPhysicalNotebook(true);
    setPhysicalNotebookMessage("");
    try {
      const response = await fetch(`/api/notebooks/${encodeURIComponent(instanceId)}/activate`, { method: "POST" });
      const result = await response.json() as { instance?: PhysicalNotebook; error?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setPhysicalNotebookMessage(`New writing will go to ${result.instance?.displayName ?? "the selected notebook"}.`);
      setStatus("Physical notebook switched");
    } catch (error) { setPhysicalNotebookMessage(error instanceof Error ? error.message : String(error)); }
    finally { setSavingPhysicalNotebook(false); }
  }

  async function renamePhysicalNotebook(): Promise<void> {
    if (!activePhysicalNotebook) return;
    setSavingPhysicalNotebook(true);
    setPhysicalNotebookMessage("");
    try {
      const response = await fetch(`/api/notebooks/${encodeURIComponent(activePhysicalNotebook.instanceId)}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: physicalNotebookName })
      });
      const result = await response.json() as { instance?: PhysicalNotebook; error?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setPhysicalNotebookMessage("Physical notebook name saved.");
      setStatus("Notebook named");
    } catch (error) { setPhysicalNotebookMessage(error instanceof Error ? error.message : String(error)); }
    finally { setSavingPhysicalNotebook(false); }
  }

  async function createPhysicalNotebook(): Promise<void> {
    if (!page) return;
    setSavingPhysicalNotebook(true);
    setPhysicalNotebookMessage("");
    try {
      const response = await fetch("/api/notebooks", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ paperIdentity: page.notebookId, displayName: newPhysicalNotebookName })
      });
      const result = await response.json() as { instance?: PhysicalNotebook; error?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setCreatingPhysicalNotebook(false);
      setNewPhysicalNotebookName("");
      setPhysicalNotebookMessage(`${result.instance?.displayName ?? "New notebook"} is active. Start writing or import it now.`);
      setStatus("New physical notebook ready");
    } catch (error) { setPhysicalNotebookMessage(error instanceof Error ? error.message : String(error)); }
    finally { setSavingPhysicalNotebook(false); }
  }

  async function reassignPhysicalNotebookCapture(): Promise<void> {
    if (!page || !captureRange || !reassignmentTarget) return;
    setReassigningCapture(true);
    setPhysicalNotebookMessage("");
    try {
      const response = await fetch("/api/notebooks/reassign", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          paperIdentity: captureRange.paperIdentity, penId: captureRange.penId, sessionId: captureRange.sessionId,
          pageId: captureRange.pageId, startSequence: captureRange.startSequence, endSequence: captureRange.endSequence,
          fromInstanceId: captureRange.instanceId, targetInstanceId: reassignmentTarget
        })
      });
      const result = await response.json() as { ranges?: readonly PhysicalNotebookCaptureRange[]; error?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setCaptureRanges(result.ranges ?? []);
      setSelected(`${reassignmentTarget}:${page.pageId}`);
      setPhysicalNotebookMessage("Captured writing moved. Canonical pen events were preserved and projections were rebuilt.");
      setStatus("Capture reassigned");
    } catch (error) { setPhysicalNotebookMessage(error instanceof Error ? error.message : String(error)); }
    finally { setReassigningCapture(false); }
  }

  async function setPhysicalNotebookArchived(instanceId: string, archived: boolean): Promise<void> {
    setNotebookMenu("");
    try {
      const response = await fetch(`/api/notebooks/${encodeURIComponent(instanceId)}/${archived ? "archive" : "restore"}`, { method: "POST" });
      const result = await response.json() as { catalog?: NotebookInstancesCatalog; error?: string };
      if (!response.ok || !result.catalog) throw new Error(result.error ?? `HTTP ${response.status}`);
      setSnapshot((current) => ({ ...current, physicalNotebooks: result.catalog! }));
      if (!archived) {
        const restoredPage = snapshot.pages.filter((candidate) => physicalNotebookId(candidate) === instanceId)
          .reduce<SmartpenPage | undefined>((latest, candidate) => !latest || candidate.updatedAtMs > latest.updatedAtMs ? candidate : latest, undefined);
        if (restoredPage) setSelected(key(restoredPage));
      }
      setStatus(archived ? "Notebook archived" : "Notebook restored");
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  }

  const closeDrawers = (): void => { setCaptureOpen(false); setSessionOpen(false); };
  return <main className="app-shell">
    <header className="app-header">
      <button className="wordmark" onClick={() => { setView("page"); closeDrawers(); }}><span>InkRelay</span><small>paper → thought</small></button>
      <div className="current-notebook"><span>Open notebook</span><strong>{notebook?.label ?? "Waiting for ink"}</strong></div>
      <div className="header-actions">
        <button className={`drawer-toggle ${sessionOpen ? "active" : ""}`} aria-expanded={sessionOpen} onClick={() => { setSessionOpen((value) => !value); setCaptureOpen(false); }}><span>Session</span>{snapshot.warnings.length > 0 && <b>{snapshot.warnings.length}</b>}</button>
        <div className="engine-state" title={`Local engine: ${status}`}><i /><span>{status === "Ready" ? "Saved locally" : status}</span></div>
      </div>
    </header>

    <section className="workspace-shell">
      <nav className="notebook-shelf" aria-label="Physical notebooks">
        <button className={`notes-launch ${captureOpen ? "active" : ""}`} aria-expanded={captureOpen} aria-controls="notes-drawer" onClick={() => { setCaptureOpen((value) => !value); setSessionOpen(false); }}><i className={`state-dot ${snapshot.pen.connection}`} /><span>Get notes</span><small>{snapshot.pen.connection === "connected" ? "pen ready" : "connect pen"}</small></button>
        <span className="notebook-shelf-title">My notebooks</span>
        <div className="notebook-list">
          {notebooks.map((item, index) => <div className="notebook-row" key={item.notebookId}>
            <button className={`notebook-book notebook-tone-${index % 3}`} aria-pressed={item.notebookId === notebook?.notebookId} onClick={() => { selectNotebook(item.notebookId); setNotebookMenu(""); }}><i aria-hidden="true" /><span><strong>{item.label}</strong><small>{item.pages.length} {item.pages.length === 1 ? "page" : "pages"}{item.notebookId === notebook?.notebookId && page ? ` · Page ${page.pageId}` : ""}</small></span></button>
            <button className="notebook-menu-toggle" aria-label={`Notebook actions for ${item.label}`} aria-expanded={notebookMenu === item.notebookId} onClick={() => setNotebookMenu((current) => current === item.notebookId ? "" : item.notebookId)}>•••</button>
            {notebookMenu === item.notebookId && <div className="notebook-menu"><button onClick={() => void setPhysicalNotebookArchived(item.notebookId, true)}>Archive notebook</button><small>Pages and Excalidraw edits are preserved.</small></div>}
          </div>)}
        </div>
        <button className="notebook-add" onClick={() => { setCaptureOpen(true); setSessionOpen(false); setCreatingPhysicalNotebook(true); }}>＋ New notebook</button>
        {archivedNotebooks.length > 0 && <details className="archived-notebooks"><summary>Archived notebooks <b>{archivedNotebooks.length}</b></summary><div>{archivedNotebooks.map((instance) => <div key={instance.instanceId}><span><strong>{instance.displayName}</strong><small>Removed from shelf</small></span><button onClick={() => void setPhysicalNotebookArchived(instance.instanceId, false)}>Restore</button></div>)}</div></details>}
      </nav>
      <div className="notebook-workspace">
        <section className={`canvas-card workspace-canvas${view === "language" ? " review-mode" : ""}${view === "faithful" || view === "hybrid" ? " excalidraw-mode" : ""}`}>
        <div className="workspace-bar">
          <div className="source-navigation">
            <div className="page-picker"><span>{view === "page" ? "Original paper" : view === "faithful" ? "Editable Excalidraw ink" : view === "hybrid" ? "Excalidraw diagram" : "Teacher notes"}</span><strong>{page ? `Page ${page.pageId}` : "Waiting for ink"}</strong></div>
            {page && <div className="page-navigator" aria-label={spreadMode && view !== "language" ? "Spread navigation" : "Page navigation"}>
              <button aria-label={spreadMode && view !== "language" ? "Previous spread" : "Previous page"} disabled={!previousPage} onClick={() => selectPage(previousPage)}>‹</button>
              {spreadMode && view !== "language" ? <div className="spread-page-selectors">
                <select aria-label="Left page" value={spreadPageIds.leftPageId} onChange={(event) => updateSpreadOverride("left", Number(event.target.value))}>{spreadPageOptions.map((pageId) => <option key={`left-${pageId}`} value={pageId}>Page {pageId}{notebookPages.some((candidate) => candidate.pageId === pageId) ? "" : " · blank"}</option>)}</select>
                <span aria-hidden="true">–</span>
                <select aria-label="Right page" value={spreadPageIds.rightPageId} onChange={(event) => updateSpreadOverride("right", Number(event.target.value))}>{spreadPageOptions.map((pageId) => <option key={`right-${pageId}`} value={pageId}>Page {pageId}{notebookPages.some((candidate) => candidate.pageId === pageId) ? "" : " · blank"}</option>)}</select>
                {spreadOverrides[spreadOverrideId] && <button className="pair-reset" title="Restore automatic even–odd pairing" aria-label="Restore automatic page pairing" onClick={resetSpreadOverride}>Auto</button>}
              </div> : <select aria-label="Current page" value={page.pageId} onChange={(event) => selectPage(notebookPages.find((candidate) => candidate.pageId === Number(event.target.value)))}>{notebookPages.map((item) => <option key={key(item)} value={item.pageId}>Page {item.pageId}</option>)}</select>}
              <button aria-label={spreadMode && view !== "language" ? "Next spread" : "Next page"} disabled={!nextPage} onClick={() => selectPage(nextPage)}>›</button>
            </div>}
          </div>
          <div className="workspace-actions">
            <span className="stroke-count">{spreadMode && view !== "language" ? (leftSpreadPage?.strokes.length ?? 0) + (rightSpreadPage?.strokes.length ?? 0) : page?.strokes.length ?? 0} strokes</span>
            {view !== "language" && <button className={`quiet-action spread-toggle ${spreadMode ? "active" : ""}`} aria-pressed={spreadMode} onClick={() => { setSpreadMode((value) => !value); setReplayActive(false); }}>Spread</button>}
            {view === "page" && <><div className="zoom-controls"><button aria-label="Zoom out" onClick={() => changeZoom(zoom - 25)}>−</button><button className="zoom-value" aria-label="Fit page" onClick={() => changeZoom(100)}>{zoom}%</button><button aria-label="Zoom in" onClick={() => changeZoom(zoom + 25)}>+</button></div><button className={`quiet-action ${autoFollow ? "active" : ""}`} aria-pressed={autoFollow} onClick={() => { setAutoFollow((value) => !value); if (!autoFollow) setZoom(AUTO_FOLLOW_ZOOM); }}>Follow</button><div className="replay-launch"><select aria-label="Replay speed" title="Replay speed" value={replaySpeed} onChange={(event) => setReplaySpeed(Number(event.target.value))}>{[0.5, 1, 2, 4].map((value) => <option key={value} value={value}>{value}×</option>)}</select><button className={replayActive ? "active" : ""} disabled={!page?.strokes.length} onClick={() => { const starting = !replayActive; setReplayActive(starting); if (starting) { if (autoFollow) setZoom(AUTO_FOLLOW_ZOOM); else paperViewportRef.current?.scrollTo({ top: 0, left: 0 }); } }}>{replayActive ? "Stop replay" : "Replay"}</button></div><button className={`quiet-action ${showZones ? "active" : ""}`} onClick={() => setShowZones((value) => !value)}>Zones</button></>}
            <button className="export-action" disabled={!page} onClick={() => page && void command("/api/export/obsidian", { notebookId: page.notebookId, physicalNotebookId: page.physicalNotebookId, pageId: page.pageId })}>{view === "language" ? "Send review to Obsidian" : "Send to Obsidian"}</button>
          </div>
        </div>
        {view === "language" ? <LanguageTeacher page={page} /> : view !== "page" ? <ExcalidrawProjection page={page} mode={view} {...(spreadMode ? { spread: { leftPage: leftSpreadPage, rightPage: rightSpreadPage, leftPageId: spreadPageIds.leftPageId, rightPageId: spreadPageIds.rightPageId } } : {})} /> : <div className={`paper-wrap${replayActive && autoFollow ? " replay-follow" : ""}`} ref={paperViewportRef}>{page ? spreadMode ? <div className="paper-spread" aria-label={`Pages ${spreadPageIds.leftPageId} and ${spreadPageIds.rightPageId}`}>
          <PaperSheet projectionKey={paperProjectionKey} page={leftSpreadPage} expectedPageId={spreadPageIds.leftPageId} fallbackPage={page} widthPx={Math.round(760 * zoom / 100)} activePage={page} paperRef={(node) => { if (leftSpreadPage && key(leftSpreadPage) === key(page)) paperRef.current = node; }} replayActive={replayActive} replaySpeed={replaySpeed} autoFollow={autoFollow} onFocusPoint={queueReplayFollow} onReplayClose={() => setReplayActive(false)} showZones={showZones} zones={visibleZones} />
          <div className="spread-fold" aria-hidden="true" />
          <PaperSheet projectionKey={paperProjectionKey} page={rightSpreadPage} expectedPageId={spreadPageIds.rightPageId} fallbackPage={page} widthPx={Math.round(760 * zoom / 100)} activePage={page} paperRef={(node) => { if (rightSpreadPage && key(rightSpreadPage) === key(page)) paperRef.current = node; }} replayActive={replayActive} replaySpeed={replaySpeed} autoFollow={autoFollow} onFocusPoint={queueReplayFollow} onReplayClose={() => setReplayActive(false)} showZones={showZones} zones={visibleZones} />
        </div> : <PaperSheet projectionKey={paperProjectionKey} page={page} expectedPageId={page.pageId} fallbackPage={page} widthPx={Math.round(760 * zoom / 100)} activePage={page} paperRef={(node) => { paperRef.current = node; }} replayActive={replayActive} replaySpeed={replaySpeed} autoFollow={autoFollow} onFocusPoint={queueReplayFollow} onReplayClose={() => setReplayActive(false)} showZones={showZones} zones={visibleZones} /> : <div className="empty-paper"><span>✦</span><strong>Paper becomes visible here</strong><p>Connect a pen for live writing, or bring in the notebook pages stored on it.</p><button onClick={() => setCaptureOpen(true)}>Get my notes</button></div>}</div>}
        <nav className="page-layer-tabs" aria-label="Notebook page layer">
          <button className={view === "page" ? "active" : ""} aria-pressed={view === "page"} onClick={() => { setView("page"); closeDrawers(); }}><span>Original</span><small>paper</small></button>
          <button className={view === "faithful" ? "active" : ""} aria-pressed={view === "faithful"} onClick={() => { setView("faithful"); closeDrawers(); }}><span>Editable ink</span><small>Excalidraw</small></button>
          <button className={view === "hybrid" ? "active" : ""} aria-pressed={view === "hybrid"} onClick={() => { setView("hybrid"); closeDrawers(); }}><span>Diagram</span><small>Excalidraw</small></button>
          <button className={view === "language" ? "active" : ""} aria-pressed={view === "language"} onClick={() => { setView("language"); closeDrawers(); }}><span>Teacher notes</span><small>review</small></button>
        </nav>
      </section>
      </div>

      {(captureOpen || sessionOpen) && <button className="drawer-scrim" aria-label="Close side panel" onClick={closeDrawers} />}
      <aside id="notes-drawer" className={`context-drawer capture-drawer ${captureOpen ? "open" : ""}`} aria-label="Get my notes" aria-hidden={!captureOpen} inert={!captureOpen}>
        <div className="drawer-head"><div><span>From paper to InkRelay</span><h2>Get my notes</h2></div><button aria-label="Close notes panel" onClick={() => setCaptureOpen(false)}>×</button></div>
        <div className="drawer-scroll">
          <section className="drawer-section pen-connect"><div className="section-title"><h3>Smartpen</h3><span className={`state-dot ${snapshot.pen.connection}`} /></div><div className="hardware-state"><strong>{snapshot.pen.bluetooth.available ? snapshot.pen.bluetooth.adapterName ?? "BlueZ ready" : snapshot.pen.bluetooth.enabled === false ? "Bluetooth disabled" : "Bluetooth unavailable"}</strong><small>{snapshot.pen.connection.replaceAll("_", " ")}</small></div>
            {snapshot.pen.bluetooth.error && <p className="hardware-error">{snapshot.pen.bluetooth.error}</p>}
            {snapshot.pen.connection === "disconnected" || snapshot.pen.connection === "error" ? <><div className="mode-note offline"><strong>Offline notebook mode</strong><span>Write without the computer, then connect to import.</span></div>{snapshot.pen.bluetooth.enabled !== false && !snapshot.pen.bluetooth.available && <button className="small-button primary" onClick={() => void command("/api/pens/bluetooth/retry")}>Retry Bluetooth</button>}<button className="small-button" disabled={snapshot.pen.bluetooth.enabled === false || snapshot.pen.bluetooth.scanning} onClick={() => void command("/api/pens/scan", { durationMs: 10_000 })}>{snapshot.pen.bluetooth.scanning ? "Scanning…" : "Scan for pens"}</button>{snapshot.pen.devices.length > 0 && <><select value={selectedPen} onChange={(event) => setSelectedPen(event.target.value)}>{snapshot.pen.devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.name} · {device.address}{device.rssi === undefined ? "" : ` · ${device.rssi} dBm`}</option>)}</select><button className="small-button primary" disabled={!selectedPen} onClick={() => void command("/api/pens/connect", { deviceId: selectedPen })}>Connect</button></>}</> : <button className="small-button" onClick={() => void command("/api/pens/disconnect")}>Disconnect</button>}
            {snapshot.pen.connection === "password_required" && <div className="password-row"><input aria-label="Pen password" type="password" maxLength={16} value={penPassword} onChange={(event) => setPenPassword(event.target.value)} placeholder="Pen password" /><button onClick={() => void command("/api/pens/authenticate", { password: penPassword })}>Unlock</button></div>}
            {snapshot.pen.connection === "connected" && <div className="pen-details"><div className="mode-note live"><strong>Live capture</strong><span>InkRelay is receiving new strokes now.</span></div><div><span>Battery</span><strong>{snapshot.pen.penStatus?.batteryPercent ?? "—"}%</strong></div><div><span>Pen storage</span><strong>{snapshot.pen.penStatus?.usedStoragePercent ?? "—"}% used</strong></div><div><span>Stored notebooks</span><strong>{snapshot.pen.offlineNotes.length}</strong></div>{snapshot.pen.penStatus && !snapshot.pen.penStatus.offlineDataEnabled && <p className="sync-error">Offline storage is disabled in the pen settings.</p>}<button className="small-button primary" disabled={snapshot.pen.sync.active || snapshot.pen.penStatus?.offlineDataEnabled === false} onClick={() => void command("/api/pens/offline/sync")}>{snapshot.pen.sync.active ? `Processing ${snapshot.pen.sync.importedStrokes + snapshot.pen.sync.duplicateStrokes}/${snapshot.pen.sync.totalStrokes || "…"} strokes` : "Import stored writing"}</button><button className="small-button" disabled={snapshot.pen.sync.active} onClick={() => void command("/api/pens/offline/refresh")}>Refresh stored list</button><p className="sync-safety">Imported writing stays on the pen for Neo Studio.</p>{snapshot.pen.sync.active && <p className="sync-progress">{snapshot.pen.sync.receivedStrokes}/{snapshot.pen.sync.totalStrokes || "…"} durably acknowledged</p>}{snapshot.pen.sync.finishedAtMs && !snapshot.pen.sync.error && <div className="sync-result"><strong>Import complete</strong><span>{snapshot.pen.sync.importedStrokes} new · {snapshot.pen.sync.duplicateStrokes} already imported</span></div>}{snapshot.pen.sync.error && <p className="sync-error">{snapshot.pen.sync.error}</p>}</div>}
          </section>
          <section className="drawer-section physical-notebook-settings">
            <div className="section-title"><h3>Physical notebook</h3><small>{physicalNotebooksForPaper.length || "—"}</small></div>
            {!page ? <p className="muted">Select a captured page before switching physical notebooks.</p> : <>
              <p className="muted">Choose which physical copy will receive the next writing for paper identity <code>{page.notebookId}</code>.</p>
              <label><span>Current physical notebook</span><select aria-label="Current physical notebook" value={activePhysicalNotebookId} disabled={savingPhysicalNotebook} onChange={(event) => void activatePhysicalNotebook(event.target.value)}>{physicalNotebooksForPaper.map((instance) => <option key={instance.instanceId} value={instance.instanceId}>{instance.displayName}</option>)}</select></label>
              {activePhysicalNotebook && <><label><span>Personal notebook name</span><input value={physicalNotebookName} maxLength={160} onChange={(event) => { setPhysicalNotebookName(event.target.value); setPhysicalNotebookMessage(""); }} placeholder="For example: French course — 2026" /></label><button className="small-button" disabled={savingPhysicalNotebook || !physicalNotebookName.trim() || physicalNotebookName.trim() === activePhysicalNotebook.displayName} onClick={() => void renamePhysicalNotebook()}>Save personal name</button></>}
              {!creatingPhysicalNotebook ? <button className="small-button primary notebook-new" onClick={() => { setCreatingPhysicalNotebook(true); setPhysicalNotebookMessage(""); }}>Start a new physical notebook</button> : <div className="new-notebook-form"><label><span>New physical notebook name</span><input autoFocus value={newPhysicalNotebookName} maxLength={160} onChange={(event) => setNewPhysicalNotebookName(event.target.value)} placeholder="For example: Work notes — Summer" /></label><div><button className="small-button" onClick={() => setCreatingPhysicalNotebook(false)}>Cancel</button><button className="small-button primary" disabled={savingPhysicalNotebook || !newPhysicalNotebookName.trim()} onClick={() => void createPhysicalNotebook()}>{savingPhysicalNotebook ? "Creating…" : "Create and switch"}</button></div></div>}
              <p className="switch-note">Switch before writing or importing. The next captured event creates the durable boundary.</p>
              {physicalNotebooksForPaper.length > 1 && <div className="capture-reassignment">
                <strong>Repair an assignment</strong>
                <p>Move one captured range from this page to another physical notebook. Source pen events stay unchanged.</p>
                {pageCaptureRanges.length === 0 ? <span>No movable capture ranges are present on this page.</span> : <>
                  <label><span>Captured range</span><select aria-label="Captured range to move" value={captureRange ? captureRangeKey(captureRange) : ""} disabled={reassigningCapture} onChange={(event) => setSelectedCaptureRange(event.target.value)}>{pageCaptureRanges.map((range) => <option key={captureRangeKey(range)} value={captureRangeKey(range)}>{range.strokeCount} {range.strokeCount === 1 ? "stroke" : "strokes"} · {new Date(range.startedAtMs).toLocaleString()} · seq {range.startSequence}–{range.endSequence}</option>)}</select></label>
                  <label><span>Move to</span><select aria-label="Target physical notebook" value={reassignmentTarget} disabled={reassigningCapture} onChange={(event) => setReassignmentTarget(event.target.value)}>{reassignmentTargets.map((instance) => <option key={instance.instanceId} value={instance.instanceId}>{instance.displayName}</option>)}</select></label>
                  <button className="small-button" disabled={reassigningCapture || !captureRange || !reassignmentTarget} onClick={() => void reassignPhysicalNotebookCapture()}>{reassigningCapture ? "Moving and rebuilding…" : "Move captured range"}</button>
                </>}
                <small>Existing Obsidian exports and language reviews are retained as history; export or review the corrected page again when needed.</small>
              </div>}
              {physicalNotebookMessage && <p className={physicalNotebookMessage.includes("required") || physicalNotebookMessage.includes("must") || physicalNotebookMessage.includes("changed") || physicalNotebookMessage.startsWith("HTTP") ? "settings-error" : "settings-success"}>{physicalNotebookMessage}</p>}
            </>}
          </section>
          <section className="drawer-section ink-style-settings"><div className="section-title"><h3>Digital ink</h3><small>Next strokes</small></div><fieldset><legend>Color</legend><div className="ink-color-options">{INK_COLORS.map((color) => <button key={color} type="button" aria-label={`Ink color ${color}`} aria-pressed={snapshot.state.currentColor.toLowerCase() === color} className={snapshot.state.currentColor.toLowerCase() === color ? "active" : ""} onClick={() => void setInkStyle({ color })}><i style={{ background: color }} /></button>)}</div></fieldset><fieldset><legend>Stroke</legend><div className="ink-width-options">{INK_WIDTHS.map((width) => <button key={width.value} type="button" aria-label={`${width.label} stroke, ${width.value}px`} aria-pressed={snapshot.state.currentWidth === width.value} className={snapshot.state.currentWidth === width.value ? "active" : ""} onClick={() => void setInkStyle({ width: width.value })}><i style={{ height: `${width.value}px`, background: snapshot.state.currentColor }} /><span>{width.label}</span></button>)}</div></fieldset><p>Applies to new pen strokes; existing ink keeps its recorded appearance.</p></section>
          <section className="drawer-section"><div className="section-title"><h3>Current notebook pages</h3><small>{notebookPages.length}</small></div>{notebookPages.length === 0 ? <p className="muted">No captured pages yet.</p> : <select aria-label="Captured page" value={page?.pageId} onChange={(event) => selectPage(notebookPages.find((candidate) => candidate.pageId === Number(event.target.value)))}>{notebookPages.map((item) => <option key={key(item)} value={item.pageId}>Page {item.pageId}</option>)}</select>}</section>
        </div>
      </aside>

      <aside className={`context-drawer session-drawer ${sessionOpen ? "open" : ""}`} aria-label="Session" aria-hidden={!sessionOpen} inert={!sessionOpen}>
        <div className="drawer-head"><div><span>Digital continuation</span><h2>Session</h2></div><button aria-label="Close session" onClick={() => setSessionOpen(false)}>×</button></div>
        <div className="drawer-scroll">
          <section className="drawer-section"><div className="section-title"><h3>Readiness</h3><small>local-first</small></div><Check ok={Boolean(page)} text="Page reconstructed" /><Check ok={Boolean(page?.strokes.length)} text="Stroke projection" /><Check ok={Boolean(page?.actions.length)} text="Action history" /><Check ok={true} text="Raw log protected" /></section>
          <section className="drawer-section paper-profile-settings">
            <div className="section-title"><h3>Paper product</h3><small>{paperProfile ? `saved profile r${paperProfile.revision}` : automaticPaper ? "automatic" : "unknown paper"}</small></div>
            {!page ? <p className="muted">Select a captured page to register its paper product.</p> : <>
              {automaticPaper ? <div className="settings-success"><strong>{paperMapping?.displayName}</strong><p>{(paperMapping!.width / 10).toFixed(1)} × {(paperMapping!.height / 10).toFixed(1)} mm · mapped automatically, no crosses needed.</p><p>{paperMapping?.source === "nproj" ? "From imported notebook metadata." : "From a previously measured product reference; interior pages are assumed uniform."}</p></div> : <p className="muted">{paperProfile ? "Your saved profile takes priority over automatic definitions." : "No matching page definition yet. Import notebook metadata to map it without drawing calibration crosses, or use the manual fallback below."}</p>}
              <p className="paper-identity"><span>Paper identity</span><code>{page.notebookId}</code></p>
              <details><summary>{automaticPaper ? "Manual override (replaces automatic mapping)" : "Manual dimensions and calibration"}</summary>
              <label><span>Paper product name</span><input type="text" value={paperName} maxLength={160} onChange={(event) => { setPaperName(event.target.value); setPaperMessage(""); }} placeholder="For example: Neo N Professional" /></label>
              <div className="paper-dimensions"><label><span>Width (mm)</span><input type="number" min="1" max="2000" step="0.1" inputMode="decimal" value={paperWidthMm} onChange={(event) => { setPaperWidthMm(event.target.value); setPaperMessage(""); }} placeholder="148" /></label><span aria-hidden="true">×</span><label><span>Height (mm)</span><input type="number" min="1" max="2000" step="0.1" inputMode="decimal" value={paperHeightMm} onChange={(event) => { setPaperHeightMm(event.target.value); setPaperMessage(""); }} placeholder="210" /></label></div>
              <p className="paper-scale">Orientation follows the entered width and height · canvas density: 10 app_px/mm</p>
              <button className="small-button primary" disabled={savingPaper || !paperName.trim() || !(Number(paperWidthMm) > 0) || !(Number(paperHeightMm) > 0)} onClick={() => void savePaperProfile()}>{savingPaper ? "Saving…" : paperProfile ? "Update paper product" : "Register this paper product"}</button>
              {paperProfile && <div className="paper-calibration"><strong>{paperProfile.calibration ? "Coordinate mapping calibrated" : "Coordinate mapping not calibrated"}</strong><p>For calibration, make the latest four strokes two crosses: top-left first, then bottom-right, each centred 10 mm from the page edges.</p><button className="small-button" disabled={savingPaper || page.strokes.filter((stroke) => stroke.semanticRole !== "action").length < 4} onClick={() => void calibratePaperProfile()}>{paperProfile.calibration ? "Recalibrate from latest crosses" : "Calibrate from latest crosses"}</button></div>}
              </details>
              {paperMessage && <p className={paperMessage.startsWith("Paper profile saved") || paperMessage.startsWith("Paper calibrated") || paperMessage.startsWith("Paper metadata imported") ? "settings-success" : "settings-error"}>{paperMessage}</p>}
              {!paperProfile && !automaticPaper && <p className="settings-warning">Unknown paper currently uses the {paperCatalog ? `${paperCatalog.fallback.width} × ${paperCatalog.fallback.height} app_px` : "global"} fallback canvas.</p>}
            </>}
            <details><summary>Import notebook definition</summary><p className="muted">Choose the notebook’s .nproj file once. Its page geometry stays on this computer. Saved manual profiles keep priority. Existing editable canvas scenes retain their cached positions.</p><label><span>Notebook metadata (.nproj)</span><input type="file" accept=".nproj,.xml" disabled={savingPaper} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importPaperMetadata(file); }} /></label></details>
            {!page && paperMessage && <p role="status">{paperMessage}</p>}
          </section>
          <section className="drawer-section vault-settings"><div className="section-title"><h3>Obsidian vault</h3><small>{settings?.source === "saved" ? "custom" : "default"}</small></div><p className="muted">Choose the existing vault folder that should receive the generated <code>Smartpen</code> notes.</p><label><span>Absolute folder path</span><input type="text" spellCheck={false} value={vaultPath} onChange={(event) => { setVaultPath(event.target.value); setVaultMessage(""); }} placeholder="/home/you/Documents/My Vault" /></label><button className="small-button primary" disabled={savingVault || !vaultPath.trim() || vaultPath.trim() === settings?.vaultPath} onClick={() => void saveVaultPath()}>{savingVault ? "Saving…" : "Use this vault"}</button>{vaultMessage && <p className={vaultMessage.startsWith("Vault saved") ? "settings-success" : "settings-error"}>{vaultMessage}</p>}{settings?.warning && <p className="settings-warning">{settings.warning}</p>}<p className="settings-current">Current: <code>{settings?.vaultPath ?? "Loading…"}</code></p></section>
          <section className="drawer-section"><div className="section-title"><h3>Workflow queue</h3><small>{snapshot.workflows.length}</small></div>{snapshot.workflows.length ? snapshot.workflows.map((workflow) => <div className="queued" key={workflow.intentId}><i /><span>{workflow.kind}</span><b>Queued</b></div>) : <p className="muted">No offline workflows requested.</p>}</section>
          <section className="drawer-section actions"><div className="section-title"><h3>Paper actions</h3><small>{snapshot.recentActions.length}</small></div>{snapshot.recentActions.length === 0 ? <p className="muted">No paper actions yet.</p> : [...snapshot.recentActions].reverse().slice(0, 20).map((action) => <div key={action.actionId}><time>{new Date(action.createdAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><span>{action.kind.replaceAll("_", " ")}</span></div>)}</section>
          <section className="drawer-section"><div className="section-title"><h3>Diagnostics</h3><small>{snapshot.warnings.length} warnings</small></div>{snapshot.warnings.length ? snapshot.warnings.slice(-5).map((warning) => <p className="warning" key={warning}>{warning}</p>) : <p className="muted">Everything looks quiet.</p>}<button className="text-danger" onClick={() => void command("/api/debug/clear")}>Clear projected debug state</button></section>
        </div>
      </aside>
    </section>
  </main>;
}

function PaperSheet({ projectionKey, page, expectedPageId, fallbackPage, widthPx, activePage, paperRef, replayActive, replaySpeed, autoFollow, onFocusPoint, onReplayClose, showZones, zones }: {
  projectionKey: string;
  page: SmartpenPage | undefined;
  expectedPageId: number;
  fallbackPage: SmartpenPage;
  widthPx: number;
  activePage: SmartpenPage;
  paperRef: (node: HTMLDivElement | null) => void;
  replayActive: boolean;
  replaySpeed: number;
  autoFollow: boolean;
  onFocusPoint: (point: { readonly x: number; readonly y: number }) => void;
  onReplayClose: () => void;
  showZones: boolean;
  zones: readonly Zone[];
}): React.JSX.Element {
  const source = page ?? fallbackPage;
  const active = Boolean(page && key(page) === key(activePage));
  const replaying = active && replayActive;
  return <div className={`paper spread-sheet${active ? " active-sheet" : ""}${page ? "" : " blank-sheet"}`} ref={paperRef} data-page-id={expectedPageId} style={{ width: `${widthPx}px`, aspectRatio: `${source.width} / ${source.height}` }}>
    {page ? <>
      <img className={replaying ? "replay-hidden" : ""} alt={`Handwriting for ${page.physicalNotebookName ?? page.notebookId} page ${page.pageId}`} src={`/api/pages/${encodeURIComponent(page.notebookId)}/${page.pageId}/svg?physicalNotebookId=${encodeURIComponent(page.physicalNotebookId ?? page.notebookId)}&v=${page.updatedAtMs}-${page.width}x${page.height}&mapping=${encodeURIComponent(projectionKey)}`} />
      {replaying && <ReplayOverlay page={page} speed={replaySpeed} {...(autoFollow ? { onFocusPoint } : {})} onClose={onReplayClose} />}
      {active && showZones && <svg className="zone-overlay" viewBox={`0 0 ${page.width} ${page.height}`}>{zones.map((zone) => <g key={zone.zoneId}><rect {...zone.bounds} /><text x={zone.bounds.x + 12} y={zone.bounds.y + 26}>{zone.label}</text></g>)}</svg>}
    </> : <div className="blank-page-label"><span>Page {expectedPageId}</span><small>No captured writing</small></div>}
  </div>;
}

function ReplayOverlay({ page, speed, onFocusPoint, onClose }: { page: SmartpenPage; speed: number; onFocusPoint?: (point: { readonly x: number; readonly y: number }) => void; onClose: () => void }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timeline = useMemo(() => createReplayTimeline(page), [page]);
  const [positionMs, setPositionMs] = useState(0);
  const [playing, setPlaying] = useState(true);
  const positionRef = useRef(0);

  useEffect(() => {
    positionRef.current = 0;
    setPositionMs(0);
    setPlaying(true);
  }, [page.notebookId, page.physicalNotebookId, page.pageId, page.updatedAtMs]);

  useEffect(() => {
    if (!playing || timeline.durationMs <= 0) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number): void => {
      const next = Math.min(timeline.durationMs, positionRef.current + (now - previous) * speed);
      previous = now;
      positionRef.current = next;
      setPositionMs(next);
      if (next >= timeline.durationMs) setPlaying(false);
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, timeline.durationMs]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, page.width, page.height);
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const entry of timeline.entries) {
      if (positionMs < entry.startMs) break;
      drawReplayStroke(context, entry.stroke, Math.min(1, (positionMs - entry.startMs) / entry.durationMs));
    }
  }, [page, positionMs, timeline]);

  useEffect(() => {
    const point = replayPointAt(timeline, positionMs);
    if (point) onFocusPoint?.(point);
  }, [timeline, positionMs, onFocusPoint]);

  const seek = (next: number): void => {
    positionRef.current = next;
    setPositionMs(next);
  };
  const restart = (): void => { seek(0); setPlaying(true); };
  const toggle = (): void => {
    if (!playing && positionRef.current >= timeline.durationMs) seek(0);
    setPlaying((value) => !value);
  };

  return <div className="replay-layer">
    <canvas ref={canvasRef} width={page.width} height={page.height} aria-label="Handwriting replay canvas" />
    <div className="replay-controls" role="group" aria-label="Handwriting replay controls">
      <button onClick={toggle}>{playing ? "Pause" : "Play"}</button>
      <button onClick={restart}>Restart</button>
      <span>{formatReplayTime(positionMs)} / {formatReplayTime(timeline.durationMs)}</span>
      <input aria-label="Replay timeline" type="range" min={0} max={Math.max(1, timeline.durationMs)} value={positionMs} onChange={(event) => { setPlaying(false); seek(Number(event.target.value)); }} />
      <button className="replay-close" onClick={onClose} aria-label="Close replay">×</button>
    </div>
  </div>;
}

function drawReplayStroke(context: CanvasRenderingContext2D, stroke: SmartpenPage["strokes"][number], progress: number): void {
  const points = stroke.points;
  const first = points[0];
  if (!first || progress <= 0) return;
  context.save();
  context.strokeStyle = stroke.style.color;
  context.globalAlpha = stroke.style.opacity;
  context.lineWidth = stroke.style.width;
  context.beginPath();
  context.moveTo(first.x, first.y);
  if (points.length === 1) {
    context.lineTo(first.x + 0.01, first.y + 0.01);
  } else {
    const sourceDuration = Math.max(1, points.at(-1)?.tMs ?? points.length - 1);
    const targetTime = progress * sourceDuration;
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1]!;
      const point = points[index]!;
      const previousTime = previous.tMs || (index - 1) / (points.length - 1) * sourceDuration;
      const pointTime = point.tMs || index / (points.length - 1) * sourceDuration;
      if (pointTime <= targetTime) { context.lineTo(point.x, point.y); continue; }
      if (targetTime > previousTime) {
        const amount = (targetTime - previousTime) / Math.max(1, pointTime - previousTime);
        context.lineTo(previous.x + (point.x - previous.x) * amount, previous.y + (point.y - previous.y) * amount);
      }
      break;
    }
  }
  context.stroke();
  context.restore();
}

type ExcalidrawSpread = {
  readonly leftPage: SmartpenPage | undefined;
  readonly rightPage: SmartpenPage | undefined;
  readonly leftPageId: number;
  readonly rightPageId: number;
};

function ExcalidrawProjection({ page, mode, spread }: { page: SmartpenPage | undefined; mode: ExcalidrawProjectionMode; spread?: ExcalidrawSpread }): React.JSX.Element {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const activeKey = page ? spread ? `inkrelay.excalidraw.${mode}.spread.${physicalNotebookId(page)}.${spread.leftPageId}-${spread.rightPageId}` : `inkrelay.excalidraw.${mode}.${key(page)}` : `inkrelay.excalidraw.${mode}.empty`;
  const lastKey = useRef("");
  const generated = useMemo(() => page ? spread ? projectSpreadToExcalidraw(page, spread, mode) : projectPageToExcalidraw(page, mode) : undefined, [page, spread?.leftPage, spread?.rightPage, spread?.leftPageId, spread?.rightPageId, mode]);
  const sceneRef = useRef<readonly ExcalidrawElement[]>([]);

  useEffect(() => {
    if (!api) return;
    const stored = loadStoredScene(activeKey);
    const current = lastKey.current === activeKey ? sceneRef.current : stored;
    const byId = new Map(current.map((element) => [element.id, element]));
    const projected = generated?.elements ?? [];
    const projectedIds = new Set(projected.map((element) => element.id));
    const merged = [
      ...projected.map((element) => {
        const cached = byId.get(element.id);
        return cached && projectionRendererVersion(cached) === 2 && !isSpreadBoundary(cached) && spreadPlacementOffset(cached) === spreadPlacementOffset(element) ? cached : element;
      }),
      ...current.filter((element) => !isInkRelayElement(element) && !projectedIds.has(element.id))
    ];
    lastKey.current = activeKey;
    sceneRef.current = merged;
    api.updateScene({ elements: merged, appState: { name: page ? spread ? `${page.physicalNotebookName ?? page.notebookId} · Pages ${spread.leftPageId}–${spread.rightPageId} · ${mode}` : `${page.physicalNotebookName ?? page.notebookId} · Page ${page.pageId} · ${mode}` : "InkRelay", viewBackgroundColor: spread ? "#e7e8e3" : "#ffffff" } });
    if (merged.length) requestAnimationFrame(() => api.scrollToContent(merged, { fitToViewport: true, viewportZoomFactor: 0.82, animate: false, maxZoom: 1.5 }));
  }, [activeKey, api, generated, mode, page?.notebookId, page?.physicalNotebookId, page?.pageId, spread?.leftPageId, spread?.rightPageId]);

  const recognized = generated?.recognized;
  const shapeCount = recognized ? recognized.rectangle + recognized.diamond + recognized.ellipse : 0;
  const connectorCount = recognized ? recognized.line + recognized.arrow : 0;
  return <div className="excalidraw-shell">
    <div className="projection-note"><strong>{mode === "faithful" ? "Faithful redraw" : "Hybrid diagram"}</strong><span>{mode === "faithful" ? "Each pen stroke remains editable freehand ink." : `Recognition complete · ${shapeCount} shape${shapeCount === 1 ? "" : "s"} · ${connectorCount} connector${connectorCount === 1 ? "" : "s"} · handwriting kept as ink · no OCR`}</span></div>
    <div className="excalidraw-stage"><Excalidraw excalidrawAPI={setApi} initialData={{ elements: [] }} UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }} onChange={(elements: readonly ExcalidrawElement[]) => {
      sceneRef.current = elements;
      if (lastKey.current === activeKey) saveStoredScene(activeKey, elements);
    }} /></div>
  </div>;
}

function projectSpreadToExcalidraw(fallbackPage: SmartpenPage, spread: ExcalidrawSpread, mode: ExcalidrawProjectionMode): ReturnType<typeof projectPageToExcalidraw> {
  const gap = 24;
  const leftWidth = spread.leftPage?.width ?? fallbackPage.width;
  const leftHeight = spread.leftPage?.height ?? fallbackPage.height;
  const rightWidth = spread.rightPage?.width ?? fallbackPage.width;
  const rightHeight = spread.rightPage?.height ?? fallbackPage.height;
  const leftElements = spread.leftPage ? projectPageToExcalidraw(spread.leftPage, mode) : undefined;
  const rightElements = spread.rightPage ? projectPageToExcalidraw(spread.rightPage, mode) : undefined;
  const boundaries = [
    excalidrawPageBoundary(physicalNotebookId(fallbackPage), spread.leftPageId, 0, 0, leftWidth, leftHeight),
    excalidrawPageBoundary(physicalNotebookId(fallbackPage), spread.rightPageId, leftWidth + gap, 0, rightWidth, rightHeight)
  ];
  const counts = { freedraw: 0, rectangle: 0, diamond: 0, ellipse: 0, line: 0, arrow: 0 };
  for (const projection of [leftElements, rightElements]) {
    if (!projection) continue;
    for (const kind of Object.keys(counts) as (keyof typeof counts)[]) counts[kind] += projection.recognized[kind];
  }
  return {
    elements: [...boundaries, ...(leftElements?.elements ?? []).map((element) => placeSpreadElement(element, 0)), ...(rightElements?.elements ?? []).map((element) => placeSpreadElement(element, leftWidth + gap))],
    recognized: counts
  };
}

function placeSpreadElement(element: ExcalidrawElement, offsetX: number): ExcalidrawElement {
  const customData = element.customData as { inkrelay?: Readonly<Record<string, unknown>> } | undefined;
  return { ...element, x: element.x + offsetX, customData: { ...customData, inkrelay: { ...customData?.inkrelay, spreadOffsetX: offsetX } } } as ExcalidrawElement;
}

function excalidrawPageBoundary(notebookId: string, pageId: number, x: number, y: number, width: number, height: number): ExcalidrawElement {
  const id = `inkrelay-paper-${notebookId}-${pageId}`.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
  const seed = stableElementSeed(id);
  return {
    id, type: "rectangle", x, y, width, height, angle: 0,
    strokeColor: "#d2d5ce", backgroundColor: "#fffefa", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100,
    groupIds: [], frameId: null, index: null, roundness: null, seed, version: 1, versionNonce: seed, isDeleted: false, boundElements: null, updated: 1, link: null, locked: true,
    customData: { inkrelay: { sourceStrokeIds: [], projection: "spread", kind: "page_boundary", rendererVersion: 2, notebookId, pageId } }
  } as unknown as ExcalidrawElement;
}

function stableElementSeed(value: string): number {
  let hash = 2166136261;
  for (const character of value) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0) || 1;
}

const LANGUAGES = ["Auto-detect", "English", "French", "Dutch", "Spanish", "German", "Italian", "Portuguese"] as const;

function LanguageTeacher({ page }: { page: SmartpenPage | undefined }): React.JSX.Element {
  const [language, setLanguage] = useState("Auto-detect");
  const [explanationLanguage, setExplanationLanguage] = useState("English");
  const [reviews, setReviews] = useState<readonly LanguageReview[]>([]);
  const [review, setReview] = useState<LanguageReview>();
  const [activeCorrectionId, setActiveCorrectionId] = useState("");
  const [worker, setWorker] = useState<{ status: string; model?: string; provider?: string; modelEndpoint?: string; error?: string }>({ status: "checking" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/language/status").then((response) => response.json()).then((result: { status: string; model?: string; provider?: string; modelEndpoint?: string; error?: string }) => setWorker(result)).catch((reason) => setWorker({ status: "unavailable", error: String(reason) }));
  }, []);

  useEffect(() => {
    setError("");
    setReviews([]);
    setReview(undefined);
    setActiveCorrectionId("");
    if (!page) return;
    let active = true;
    void fetch(`/api/language/reviews/${encodeURIComponent(page.notebookId)}/${page.pageId}?physicalNotebookId=${encodeURIComponent(page.physicalNotebookId ?? page.notebookId)}`)
      .then(async (response) => {
        const result = await response.json() as { reviews?: LanguageReview[]; latest?: LanguageReview | null; error?: string };
        if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
        if (!active) return;
        setReviews(result.reviews ?? []);
        setReview(result.latest ?? undefined);
        setActiveCorrectionId("");
      })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [page?.notebookId, page?.physicalNotebookId, page?.pageId, page?.updatedAtMs]);

  async function submit(): Promise<void> {
    if (!page || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/language/review", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ notebookId: page.notebookId, physicalNotebookId: page.physicalNotebookId, pageId: page.pageId, language, explanationLanguage })
      });
      const result = await response.json() as LanguageReview & { error?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setReview(result);
      setReviews((current) => [result, ...current.filter((candidate) => candidate.reviewId !== result.reviewId)]);
      setActiveCorrectionId("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  const activeCorrection = review?.corrections.find((correction) => correction.correctionId === activeCorrectionId);
  const stale = Boolean(page && review && page.updatedAtMs !== review.sourcePageUpdatedAtMs);
  const workerReady = worker.status === "ok";
  const modelLocation = worker.modelEndpoint ? isLocalModelEndpoint(worker.modelEndpoint) ? "Local model" : "Remote model" : "Model";

  return <div className={`language-teacher${review ? " has-review" : ""}`}>
    <section className="review-command">
      <div className="review-command-copy"><span>Language studio</span><h2>A thoughtful second read.</h2><p>Your source ink stays untouched. Compare the transcription with a revised draft, then select any marked phrase to understand the change.</p></div>
      <div className="review-command-form">
        <label><span>Written in</span><select value={language} onChange={(event) => setLanguage(event.target.value)}>{LANGUAGES.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label><span>Teach me in</span><select value={explanationLanguage} onChange={(event) => setExplanationLanguage(event.target.value)}>{LANGUAGES.slice(1).map((item) => <option key={item}>{item}</option>)}</select></label>
        <button disabled={!page || busy} onClick={() => void submit()}>{busy ? "Reading your page…" : stale ? "Review the new writing" : review ? "Review again" : "Review my essay"}<span aria-hidden="true">→</span></button>
      </div>
      <div className={`review-privacy ${workerReady ? "ready" : ""}`}><i /><span>{worker.status === "checking" ? "Checking the configured teacher" : workerReady ? `${modelLocation} · ${worker.model ?? worker.provider ?? "ready"}` : "Configured teacher unavailable"}</span></div>
    </section>
    {!page ? <div className="teacher-empty"><strong>No page selected</strong><span>Write or import a short essay first.</span></div> : error ? <div className="teacher-error"><strong>Review could not run</strong><span>{error}</span>{worker.error && <small>{worker.error}</small>}</div> : !review ? <div className="teacher-empty"><strong>Ready for an essay</strong><span>Choose the language and submit the selected handwritten page.</span></div> : <>
      <section className="review-meta">
        <div><strong>{review.detectedLanguage} writing</strong><span>Reviewed {new Date(review.completedAtMs).toLocaleString()} · {review.corrections.length} learning moment{review.corrections.length === 1 ? "" : "s"}</span></div>
        {reviews.length > 1 && <label>Review history<select value={review.reviewId} onChange={(event) => { const selectedReview = reviews.find((candidate) => candidate.reviewId === event.target.value); setReview(selectedReview); setActiveCorrectionId(""); }}>{reviews.map((candidate) => <option key={candidate.reviewId} value={candidate.reviewId}>{new Date(candidate.completedAtMs).toLocaleString()} · {candidate.corrections.length} corrections</option>)}</select></label>}
        {stale && <div className="stale-review">This page changed after the review. Submit it again for current feedback.</div>}
      </section>
      <section className="teacher-review-board">
        <div className="teacher-review-top">
          <article className="review-section original-review" aria-label="Interactive original transcription">
            <header className="review-section-head"><div><span>1 · Source reading</span><h3>Your original words</h3></div><small>{review.corrections.length > 0 ? "Select a warm mark" : "No changes marked"}</small></header>
            <div className="essay-copy original-copy"><AnnotatedOriginalEssay review={review} activeId={activeCorrectionId} onSelect={setActiveCorrectionId} /></div>
            <footer><span className="source-key" />Model transcription · your canonical ink remains unchanged</footer>
          </article>
          <aside className="review-section teacher-inspector" aria-label="Teacher explanation">
            <header className="review-section-head"><div><span>2 · Teacher notes</span><h3>{activeCorrection ? "Why this change?" : "Choose a learning moment"}</h3></div><small>{activeCorrection ? `${review.corrections.findIndex((item) => item.correctionId === activeCorrection.correctionId) + 1} / ${review.corrections.length}` : `${review.corrections.length} total`}</small></header>
            {review.corrections.length > 1 && <nav className="teacher-note-tabs" aria-label="Corrections">{review.corrections.map((correction, index) => <button key={correction.correctionId} aria-label={`Correction ${index + 1}: ${correction.original} to ${correction.replacement}`} aria-pressed={correction.correctionId === activeCorrectionId} className={correction.correctionId === activeCorrectionId ? "active" : ""} onClick={() => setActiveCorrectionId(correction.correctionId)}>{index + 1}</button>)}</nav>}
            <article className={`correction-detail${activeCorrection ? " selected" : ""}`}>{activeCorrection ? <><span className={`category tone-${correctionTone(activeCorrection.category)}`}>{activeCorrection.category}</span><div className="change-pair"><div><small>Your words</small><del>{activeCorrection.original || "Nothing added"}</del></div><span>→</span><div><small>Suggested</small><ins>{activeCorrection.replacement || "Delete this"}</ins></div></div><p>{activeCorrection.explanation}</p>{activeCorrection.examples.length > 0 && <div className="examples"><strong>Try another example</strong>{activeCorrection.examples.map((example, index) => <div key={`${activeCorrection.correctionId}-${index}`}><del>{example.incorrect}</del><span>→</span><ins>{example.correct}</ins></div>)}</div>}</> : review.corrections.length > 0 ? <div className="inspector-welcome"><i>↗</i><strong>Select a phrase in either essay</strong><p>The matching source and revision will light up together. The explanation, rule, and examples will appear here.</p><blockquote>{review.summary || "Your revision is ready to explore."}</blockquote></div> : <div className="inspector-welcome complete"><i>✓</i><strong>Review complete</strong><p>The model found no necessary corrections in this transcription.</p><blockquote>{review.summary || "Your writing is ready to read."}</blockquote></div>}</article>
          </aside>
        </div>
        <article className="review-section revised-review" aria-label="Interactive revised essay">
          <header className="review-section-head"><div><span>3 · Proposed revision</span><h3>A natural, corrected version</h3></div><small>{review.corrections.length > 0 ? "Select a green mark to cross-inspect" : "No changes needed"}</small></header>
          <div className="essay-copy revised-copy"><AnnotatedEssay review={review} activeId={activeCorrectionId} onSelect={setActiveCorrectionId} /></div>
          {review.corrections.length > 0 && <footer><span className="revision-key" />Linked suggestion · select from the original or revision</footer>}
        </article>
      </section>
      {(review.strengths.length > 0 || review.nextSteps.length > 0) && <section className="teacher-notes"><div><span className="note-symbol">✓</span><strong>Keep doing this</strong>{review.strengths.map((item) => <p key={item}>{item}</p>)}</div><div><span className="note-symbol">↗</span><strong>Your next focus</strong>{review.nextSteps.map((item) => <p key={item}>{item}</p>)}</div></section>}
    </>}
  </div>;
}

function AnnotatedEssay({ review, activeId, onSelect }: { review: LanguageReview; activeId: string; onSelect: (id: string) => void }): React.JSX.Element {
  return <AnnotatedReviewText text={review.correctedText} corrections={review.corrections} activeId={activeId} onSelect={onSelect} kind="revision" />;
}

function AnnotatedOriginalEssay({ review, activeId, onSelect }: { review: LanguageReview; activeId: string; onSelect: (id: string) => void }): React.JSX.Element {
  const sourceCorrections = review.corrections.map((correction) => ({ ...correction, replacement: correction.original }));
  return <AnnotatedReviewText text={review.originalText} corrections={sourceCorrections} activeId={activeId} onSelect={onSelect} kind="source" />;
}

function AnnotatedReviewText({ text, corrections, activeId, onSelect, kind }: { text: string; corrections: readonly LanguageCorrection[]; activeId: string; onSelect: (id: string) => void; kind: "source" | "revision" }): React.JSX.Element {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const { correction, correctionIndex, start, end } of locateCorrections(text, corrections)) {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(<button key={correction.correctionId} className={`revision-mark ${kind}-mark tone-${correctionTone(correction.category)}${correction.correctionId === activeId ? " active" : ""}`} aria-label={`Correction ${correctionIndex + 1}: ${correction.category}`} aria-pressed={correction.correctionId === activeId} onClick={() => onSelect(correction.correctionId)}><span>{text.slice(start, end)}</span><sup>{correctionIndex + 1}</sup></button>);
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <p>{parts}</p>;
}

function isLocalModelEndpoint(endpoint: string): boolean {
  try { return ["127.0.0.1", "localhost", "::1", "language-model", "host.docker.internal"].includes(new URL(endpoint).hostname); }
  catch { return false; }
}

function correctionTone(category: string): "spelling" | "grammar" | "punctuation" | "style" {
  const normalized = category.toLocaleLowerCase();
  if (normalized.includes("spell")) return "spelling";
  if (normalized.includes("punct") || normalized.includes("comma")) return "punctuation";
  if (normalized.includes("style") || normalized.includes("clarity") || normalized.includes("word")) return "style";
  return "grammar";
}

function isInkRelayElement(element: ExcalidrawElement): boolean {
  return Boolean((element.customData as { inkrelay?: unknown } | undefined)?.inkrelay);
}

function projectionRendererVersion(element: ExcalidrawElement): number | undefined {
  return (element.customData as { inkrelay?: { rendererVersion?: number } } | undefined)?.inkrelay?.rendererVersion;
}

function isSpreadBoundary(element: ExcalidrawElement): boolean {
  return (element.customData as { inkrelay?: { kind?: string } } | undefined)?.inkrelay?.kind === "page_boundary";
}

function spreadPlacementOffset(element: ExcalidrawElement): number | undefined {
  return (element.customData as { inkrelay?: { spreadOffsetX?: number } } | undefined)?.inkrelay?.spreadOffsetX;
}

function loadStoredScene(storageKey: string): readonly ExcalidrawElement[] {
  try {
    const value = localStorage.getItem(storageKey);
    return value ? JSON.parse(value) as ExcalidrawElement[] : [];
  } catch { return []; }
}

function saveStoredScene(storageKey: string, elements: readonly ExcalidrawElement[]): void {
  try { localStorage.setItem(storageKey, JSON.stringify(elements)); } catch { /* Browser storage is an optional edit cache. */ }
}

function loadSpreadOverrides(): Record<string, SpreadOverride> {
  try {
    const value = localStorage.getItem(SPREAD_OVERRIDES_STORAGE_KEY);
    return value ? JSON.parse(value) as Record<string, SpreadOverride> : {};
  } catch { return {}; }
}

function saveSpreadOverrides(overrides: Record<string, SpreadOverride>): void {
  try { localStorage.setItem(SPREAD_OVERRIDES_STORAGE_KEY, JSON.stringify(overrides)); } catch { /* Layout preferences may safely fall back to automatic pairing. */ }
}

function crossCentre(first: Stroke, second: Stroke): { readonly x: number; readonly y: number } {
  const firstBounds = strokeBounds(first);
  const secondBounds = strokeBounds(second);
  const firstVertical = firstBounds.height > firstBounds.width;
  const secondVertical = secondBounds.height > secondBounds.width;
  if (firstVertical === secondVertical) throw new Error("Each calibration cross must contain one horizontal and one vertical stroke.");
  const vertical = firstVertical ? firstBounds : secondBounds;
  const horizontal = firstVertical ? secondBounds : firstBounds;
  return { x: vertical.x + vertical.width / 2, y: horizontal.y + horizontal.height / 2 };
}

function sourcePoint(point: { readonly x: number; readonly y: number }, calibration?: PaperCalibration): { readonly x: number; readonly y: number } {
  if (!calibration) return point;
  return { x: (point.x - calibration.offsetX) / calibration.scaleX, y: (point.y - calibration.offsetY) / calibration.scaleY };
}

function strokeBounds(stroke: Stroke): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const xs = stroke.points.map((point) => point.x);
  const ys = stroke.points.map((point) => point.y);
  const x = Math.min(...xs); const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function Check({ ok, text }: { ok: boolean; text: string }): React.JSX.Element { return <div className={`check ${ok ? "ok" : ""}`}><i>{ok ? "✓" : "·"}</i>{text}</div>; }
function key(page: SmartpenPage): string { return `${page.physicalNotebookId ?? page.notebookId}:${page.pageId}`; }
function captureRangeKey(range: PhysicalNotebookCaptureRange): string {
  return `${range.penId}\u0000${range.sessionId}\u0000${range.pageId}\u0000${range.startSequence}\u0000${range.endSequence}\u0000${range.instanceId}`;
}
function isCommandSurface(notebookId: string): boolean { return notebookId === "NEO_3_1013_1"; }
function lineType(width: number): "Fine" | "Medium" | "Wide" { return width <= 1 ? "Fine" : width >= 5 ? "Wide" : "Medium"; }

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
