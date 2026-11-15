import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PenDotEvent } from "@inkrelay/core";
import { z } from "zod";

export const NOTEBOOK_INSTANCES_SCHEMA_VERSION = "inkrelay.notebook_instances.v3" as const;

export type PhysicalNotebook = {
  readonly instanceId: string;
  readonly paperIdentity: string;
  readonly displayName: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly archivedAtMs?: number;
};

export type NotebookAssignment = {
  readonly paperIdentity: string;
  readonly penId: string;
  readonly sessionId: string;
  readonly startSequence: number;
  readonly instanceId: string;
  readonly assignedAtMs: number;
};

export type NotebookReassignment = {
  readonly reassignmentId: string;
  readonly paperIdentity: string;
  readonly penId: string;
  readonly sessionId: string;
  readonly pageId: number;
  readonly startSequence: number;
  readonly endSequence: number;
  readonly fromInstanceId: string;
  readonly targetInstanceId: string;
  readonly reassignedAtMs: number;
};

export type NotebookInstancesCatalog = {
  readonly schemaVersion: typeof NOTEBOOK_INSTANCES_SCHEMA_VERSION;
  readonly instances: readonly PhysicalNotebook[];
  readonly activeInstances: readonly { readonly paperIdentity: string; readonly instanceId: string }[];
  readonly assignments: readonly NotebookAssignment[];
  readonly reassignments: readonly NotebookReassignment[];
};

const instanceSchema = z.object({
  instanceId: z.string().min(1).max(160), paperIdentity: z.string().min(1).max(160), displayName: z.string().trim().min(1).max(160),
  createdAtMs: z.number().int().nonnegative(), updatedAtMs: z.number().int().nonnegative(), archivedAtMs: z.number().int().nonnegative().optional()
}).strict();
const activeSchema = z.object({ paperIdentity: z.string().min(1), instanceId: z.string().min(1) }).strict();
const assignmentSchema = z.object({
  paperIdentity: z.string().min(1), penId: z.string().min(1), sessionId: z.string().min(1), startSequence: z.number().int().nonnegative(),
  instanceId: z.string().min(1), assignedAtMs: z.number().int().nonnegative()
}).strict();
const reassignmentSchema = z.object({
  reassignmentId: z.string().min(1), paperIdentity: z.string().min(1), penId: z.string().min(1), sessionId: z.string().min(1),
  pageId: z.number().int().nonnegative(), startSequence: z.number().int().nonnegative(), endSequence: z.number().int().nonnegative(),
  fromInstanceId: z.string().min(1), targetInstanceId: z.string().min(1), reassignedAtMs: z.number().int().nonnegative()
}).strict();
const catalogSchema = z.object({
  schemaVersion: z.literal(NOTEBOOK_INSTANCES_SCHEMA_VERSION), instances: z.array(instanceSchema),
  activeInstances: z.array(activeSchema), assignments: z.array(assignmentSchema), reassignments: z.array(reassignmentSchema)
}).strict();
const legacyCatalogSchema = z.object({
  schemaVersion: z.literal("inkrelay.notebook_instances.v1"), instances: z.array(instanceSchema),
  activeInstances: z.array(activeSchema), assignments: z.array(assignmentSchema)
}).strict();
const v2CatalogSchema = z.object({
  schemaVersion: z.literal("inkrelay.notebook_instances.v2"), instances: z.array(instanceSchema),
  activeInstances: z.array(activeSchema), assignments: z.array(assignmentSchema), reassignments: z.array(reassignmentSchema)
}).strict();

export type NotebookReassignmentInput = Omit<NotebookReassignment, "reassignmentId" | "reassignedAtMs">;
export type NotebookResolution = { readonly instance: PhysicalNotebook; readonly provenanceId: string };

export class NotebookInstanceStore {
  private catalog: NotebookInstancesCatalog = emptyCatalog();
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async initialize(): Promise<void> {
    try { this.catalog = validateCatalog(migrateCatalog(JSON.parse(await readFile(this.path, "utf8")))); }
    catch (error) { if (!isMissing(error)) throw error; }
  }

  snapshot(): NotebookInstancesCatalog { return structuredClone(this.catalog); }

  async ensureDefault(paperIdentity: string, now = Date.now()): Promise<PhysicalNotebook> {
    const existing = this.catalog.instances.find((instance) => instance.instanceId === paperIdentity);
    if (existing) return existing;
    return this.mutate(async (catalog) => {
      const concurrent = catalog.instances.find((instance) => instance.instanceId === paperIdentity);
      if (concurrent) return { value: concurrent, catalog };
      const instance: PhysicalNotebook = { instanceId: paperIdentity, paperIdentity, displayName: paperIdentity, createdAtMs: now, updatedAtMs: now };
      return { value: instance, catalog: {
        ...catalog, instances: [...catalog.instances, instance],
        activeInstances: [...catalog.activeInstances.filter((active) => active.paperIdentity !== paperIdentity), { paperIdentity, instanceId: instance.instanceId }]
      } };
    });
  }

  async create(paperIdentity: string, displayName: string, now = Date.now()): Promise<PhysicalNotebook> {
    const identity = paperIdentity.trim();
    const name = displayName.trim();
    if (!identity) throw new Error("paperIdentity is required");
    if (!name || name.length > 160) throw new Error("displayName must contain 1–160 characters");
    return this.mutate(async (catalog) => {
      const instance: PhysicalNotebook = { instanceId: `notebook_${randomUUID()}`, paperIdentity: identity, displayName: name, createdAtMs: now, updatedAtMs: now };
      return { value: instance, catalog: {
        ...catalog, instances: [...catalog.instances, instance],
        activeInstances: [...catalog.activeInstances.filter((active) => active.paperIdentity !== identity), { paperIdentity: identity, instanceId: instance.instanceId }]
      } };
    });
  }

  async rename(instanceId: string, displayName: string, now = Date.now()): Promise<PhysicalNotebook> {
    const name = displayName.trim();
    if (!name || name.length > 160) throw new Error("displayName must contain 1–160 characters");
    return this.mutate(async (catalog) => {
      const current = requiredInstance(catalog, instanceId);
      const updated: PhysicalNotebook = { ...current, displayName: name, updatedAtMs: now };
      return { value: updated, catalog: { ...catalog, instances: catalog.instances.map((instance) => instance.instanceId === instanceId ? updated : instance) } };
    });
  }

  async activate(instanceId: string): Promise<PhysicalNotebook> {
    return this.mutate(async (catalog) => {
      const instance = requiredInstance(catalog, instanceId);
      if (instance.archivedAtMs !== undefined) throw new Error("Restore the physical notebook before activating it");
      return { value: instance, catalog: {
        ...catalog,
        activeInstances: [...catalog.activeInstances.filter((active) => active.paperIdentity !== instance.paperIdentity), { paperIdentity: instance.paperIdentity, instanceId }]
      } };
    });
  }

  async archive(instanceId: string, now = Date.now()): Promise<PhysicalNotebook> {
    return this.mutate(async (catalog) => {
      const current = requiredInstance(catalog, instanceId);
      if (current.archivedAtMs !== undefined) return { value: current, catalog };
      const updated: PhysicalNotebook = { ...current, archivedAtMs: now, updatedAtMs: now };
      const replacement = catalog.instances.find((instance) => instance.paperIdentity === current.paperIdentity
        && instance.instanceId !== instanceId && instance.archivedAtMs === undefined);
      const wasActive = catalog.activeInstances.some((active) => active.paperIdentity === current.paperIdentity && active.instanceId === instanceId);
      const activeInstances = wasActive
        ? [...catalog.activeInstances.filter((active) => active.paperIdentity !== current.paperIdentity), ...(replacement ? [{ paperIdentity: current.paperIdentity, instanceId: replacement.instanceId }] : [])]
        : catalog.activeInstances;
      return { value: updated, catalog: { ...catalog, instances: catalog.instances.map((instance) => instance.instanceId === instanceId ? updated : instance), activeInstances } };
    });
  }

  async restore(instanceId: string, now = Date.now()): Promise<PhysicalNotebook> {
    return this.mutate(async (catalog) => {
      const current = requiredInstance(catalog, instanceId);
      if (current.archivedAtMs === undefined) return { value: current, catalog };
      const { archivedAtMs: _archivedAtMs, ...restoredFields } = current;
      const restored: PhysicalNotebook = { ...restoredFields, updatedAtMs: now };
      const hasActive = catalog.activeInstances.some((active) => active.paperIdentity === current.paperIdentity);
      return { value: restored, catalog: {
        ...catalog,
        instances: catalog.instances.map((instance) => instance.instanceId === instanceId ? restored : instance),
        activeInstances: hasActive ? catalog.activeInstances : [...catalog.activeInstances, { paperIdentity: current.paperIdentity, instanceId }]
      } };
    });
  }

  async reassign(input: NotebookReassignmentInput, now = Date.now()): Promise<NotebookReassignment> {
    if (input.startSequence > input.endSequence) throw new Error("startSequence must not exceed endSequence");
    if (input.fromInstanceId === input.targetInstanceId) throw new Error("Capture range is already assigned to the selected physical notebook");
    return this.mutate(async (catalog) => {
      const source = requiredInstance(catalog, input.fromInstanceId);
      const target = requiredInstance(catalog, input.targetInstanceId);
      if (source.archivedAtMs !== undefined || target.archivedAtMs !== undefined) {
        throw new Error("Restore archived physical notebooks before reassigning captured writing");
      }
      if (source.paperIdentity !== input.paperIdentity || target.paperIdentity !== input.paperIdentity) {
        throw new Error("Capture ranges can only move between physical notebooks with the same paper identity");
      }
      const reassignment = reassignmentSchema.parse({ ...input, reassignmentId: `reassignment_${randomUUID()}`, reassignedAtMs: now }) as NotebookReassignment;
      return { value: reassignment, catalog: { ...catalog, reassignments: [...catalog.reassignments, reassignment] } };
    });
  }

  async resolveRecorded(event: PenDotEvent): Promise<PhysicalNotebook> {
    return (await this.resolveRecordedWithProvenance(event)).instance;
  }

  async resolveRecordedWithProvenance(event: PenDotEvent): Promise<NotebookResolution> {
    const reassignment = latestReassignment(this.catalog, event);
    if (reassignment) return { instance: requiredInstance(this.catalog, reassignment.targetInstanceId), provenanceId: reassignment.reassignmentId };
    const assignment = latestAssignment(this.catalog, event);
    if (assignment) return {
      instance: requiredInstance(this.catalog, assignment.instanceId),
      provenanceId: `assignment:${assignment.penId}:${assignment.sessionId}:${assignment.startSequence}:${assignment.assignedAtMs}`
    };
    return { instance: await this.ensureDefault(event.notebookId, event.timestampMs), provenanceId: `default:${event.notebookId}` };
  }

  async assignIncoming(event: PenDotEvent): Promise<PhysicalNotebook> {
    await this.ensureDefault(event.notebookId, event.timestampMs);
    const reassignment = latestReassignment(this.catalog, event);
    if (reassignment) return requiredInstance(this.catalog, reassignment.targetInstanceId);
    let activeId = this.catalog.activeInstances.find((active) => active.paperIdentity === event.notebookId)?.instanceId;
    if (!activeId) activeId = (await this.restore(event.notebookId, event.timestampMs)).instanceId;
    const latest = latestAssignment(this.catalog, event);
    if (latest?.instanceId === activeId) return requiredInstance(this.catalog, activeId);
    return this.mutate(async (catalog) => {
      const instance = requiredInstance(catalog, activeId);
      const assignment: NotebookAssignment = {
        paperIdentity: event.notebookId, penId: event.penId, sessionId: event.sessionId,
        startSequence: event.sequence, instanceId: activeId, assignedAtMs: Date.now()
      };
      return { value: instance, catalog: { ...catalog, assignments: [...catalog.assignments, assignment] } };
    });
  }

  private async mutate<T>(operation: (catalog: NotebookInstancesCatalog) => Promise<{ readonly value: T; readonly catalog: NotebookInstancesCatalog }>): Promise<T> {
    const task = this.mutationTail.then(async () => {
      const update = await operation(this.catalog);
      this.catalog = validateCatalog(update.catalog);
      await this.write();
      return update.value;
    });
    this.mutationTail = task.then(() => undefined, () => undefined);
    return task;
  }

  private async write(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporaryPath, `${JSON.stringify(this.catalog, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.path);
  }
}

function latestAssignment(catalog: NotebookInstancesCatalog, event: PenDotEvent): NotebookAssignment | undefined {
  return catalog.assignments
    .filter((assignment) => assignment.paperIdentity === event.notebookId && assignment.penId === event.penId && assignment.sessionId === event.sessionId && assignment.startSequence <= event.sequence)
    .sort((left, right) => right.startSequence - left.startSequence || right.assignedAtMs - left.assignedAtMs)[0];
}

function latestReassignment(catalog: NotebookInstancesCatalog, event: PenDotEvent): NotebookReassignment | undefined {
  return catalog.reassignments
    .filter((reassignment) => reassignment.paperIdentity === event.notebookId && reassignment.penId === event.penId
      && reassignment.sessionId === event.sessionId && reassignment.pageId === event.pageId
      && reassignment.startSequence <= event.sequence && reassignment.endSequence >= event.sequence)
    .sort((left, right) => right.reassignedAtMs - left.reassignedAtMs
      || catalog.reassignments.lastIndexOf(right) - catalog.reassignments.lastIndexOf(left))[0];
}

function requiredInstance(catalog: NotebookInstancesCatalog, instanceId: string): PhysicalNotebook {
  const instance = catalog.instances.find((candidate) => candidate.instanceId === instanceId);
  if (!instance) throw new Error(`Unknown physical notebook ${instanceId}`);
  return instance;
}

function validateCatalog(input: unknown): NotebookInstancesCatalog {
  const catalog = catalogSchema.parse(input) as NotebookInstancesCatalog;
  const byId = new Map(catalog.instances.map((instance) => [instance.instanceId, instance]));
  const ids = new Set(byId.keys());
  if (ids.size !== catalog.instances.length) throw new Error("Physical notebook IDs must be unique");
  if (new Set(catalog.activeInstances.map((active) => active.paperIdentity)).size !== catalog.activeInstances.length) throw new Error("Only one physical notebook may be active for each paper identity");
  for (const active of catalog.activeInstances) {
    const instance = byId.get(active.instanceId);
    if (!instance) throw new Error(`Active physical notebook does not exist: ${active.instanceId}`);
    if (instance.paperIdentity !== active.paperIdentity) throw new Error(`Active physical notebook has the wrong paper identity: ${active.instanceId}`);
    if (instance.archivedAtMs !== undefined) throw new Error(`Archived physical notebook cannot be active: ${active.instanceId}`);
  }
  for (const assignment of catalog.assignments) {
    const instance = byId.get(assignment.instanceId);
    if (!instance) throw new Error(`Notebook assignment target does not exist: ${assignment.instanceId}`);
    if (instance.paperIdentity !== assignment.paperIdentity) throw new Error(`Notebook assignment has the wrong paper identity: ${assignment.instanceId}`);
  }
  if (new Set(catalog.reassignments.map((reassignment) => reassignment.reassignmentId)).size !== catalog.reassignments.length) {
    throw new Error("Notebook reassignment IDs must be unique");
  }
  for (const reassignment of catalog.reassignments) {
    const source = byId.get(reassignment.fromInstanceId);
    const target = byId.get(reassignment.targetInstanceId);
    if (!source || !target) throw new Error(`Notebook reassignment target or source does not exist: ${reassignment.reassignmentId}`);
    if (reassignment.startSequence > reassignment.endSequence) throw new Error(`Notebook reassignment has an invalid range: ${reassignment.reassignmentId}`);
    if (reassignment.fromInstanceId === reassignment.targetInstanceId) throw new Error(`Notebook reassignment source and target match: ${reassignment.reassignmentId}`);
    if (source.paperIdentity !== reassignment.paperIdentity || target.paperIdentity !== reassignment.paperIdentity) {
      throw new Error(`Notebook reassignment has the wrong paper identity: ${reassignment.reassignmentId}`);
    }
  }
  return catalog;
}

function migrateCatalog(input: unknown): unknown {
  const legacy = legacyCatalogSchema.safeParse(input);
  if (legacy.success) return { ...legacy.data, schemaVersion: NOTEBOOK_INSTANCES_SCHEMA_VERSION, reassignments: [] };
  const v2 = v2CatalogSchema.safeParse(input);
  return v2.success ? { ...v2.data, schemaVersion: NOTEBOOK_INSTANCES_SCHEMA_VERSION } : input;
}

function emptyCatalog(): NotebookInstancesCatalog { return { schemaVersion: NOTEBOOK_INSTANCES_SCHEMA_VERSION, instances: [], activeInstances: [], assignments: [], reassignments: [] }; }
function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
