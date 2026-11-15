import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NotebookInstanceStore } from "../apps/server/src/notebook-instance-store.js";
import { event } from "./helpers.js";

describe("physical notebook identities", () => {
  it("records a durable sequence boundary when identical paper is switched", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkrelay-notebook-instances-"));
    const path = join(root, "notebook-instances.json");
    const store = new NotebookInstanceStore(path);
    await store.initialize();

    const firstEvent = event(1, "pen_down");
    expect((await store.assignIncoming(firstEvent)).instanceId).toBe("NB01");
    const secondCopy = await store.create("NB01", "Work notes — Summer", 2_000);
    expect((await store.assignIncoming(event(4, "pen_down"))).instanceId).toBe(secondCopy.instanceId);
    expect((await store.resolveRecorded(event(2, "pen_move"))).instanceId).toBe("NB01");
    expect((await store.resolveRecorded(event(4, "pen_down"))).instanceId).toBe(secondCopy.instanceId);

    const restarted = new NotebookInstanceStore(path);
    await restarted.initialize();
    expect((await restarted.resolveRecorded(event(2, "pen_move"))).instanceId).toBe("NB01");
    expect((await restarted.resolveRecorded(event(5, "pen_move"))).instanceId).toBe(secondCopy.instanceId);
  });

  it("migrates v1 metadata and keeps an auditable capture-range reassignment across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkrelay-notebook-reassignment-"));
    const path = join(root, "notebook-instances.json");
    await writeFile(path, JSON.stringify({
      schemaVersion: "inkrelay.notebook_instances.v1",
      instances: [
        { instanceId: "NB01", paperIdentity: "NB01", displayName: "French", createdAtMs: 1, updatedAtMs: 1 },
        { instanceId: "work", paperIdentity: "NB01", displayName: "Work", createdAtMs: 2, updatedAtMs: 2 }
      ],
      activeInstances: [{ paperIdentity: "NB01", instanceId: "work" }],
      assignments: [{ paperIdentity: "NB01", penId: "pen-test", sessionId: "session-test", startSequence: 1, instanceId: "NB01", assignedAtMs: 1 }]
    }));
    const store = new NotebookInstanceStore(path);
    await store.initialize();
    expect(store.snapshot()).toMatchObject({ schemaVersion: "inkrelay.notebook_instances.v3", reassignments: [] });

    await store.reassign({
      paperIdentity: "NB01", penId: "pen-test", sessionId: "session-test", pageId: 12,
      startSequence: 1, endSequence: 3, fromInstanceId: "NB01", targetInstanceId: "work"
    }, 3_000);
    expect((await store.resolveRecorded(event(2, "pen_move"))).instanceId).toBe("work");
    expect((await store.resolveRecorded(event(4, "pen_down"))).instanceId).toBe("NB01");

    const restarted = new NotebookInstanceStore(path);
    await restarted.initialize();
    expect((await restarted.resolveRecorded(event(3, "pen_up"))).instanceId).toBe("work");
    expect(restarted.snapshot().reassignments).toHaveLength(1);
  });

  it("archives and restores notebook metadata without changing recorded assignments", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkrelay-notebook-archive-"));
    const path = join(root, "notebook-instances.json");
    const store = new NotebookInstanceStore(path);
    await store.initialize();

    await store.assignIncoming(event(1, "pen_down"));
    const work = await store.create("NB01", "Work", 2_000);
    const archived = await store.archive(work.instanceId, 3_000);
    expect(archived.archivedAtMs).toBe(3_000);
    expect(store.snapshot().activeInstances).toContainEqual({ paperIdentity: "NB01", instanceId: "NB01" });
    expect((await store.resolveRecorded(event(1, "pen_down"))).instanceId).toBe("NB01");
    await expect(store.activate(work.instanceId)).rejects.toThrow("Restore");
    await store.archive("NB01", 3_500);
    expect(store.snapshot().activeInstances).toEqual([]);
    expect((await store.assignIncoming(event(2, "pen_move"))).instanceId).toBe("NB01");
    expect(store.snapshot().instances.find((instance) => instance.instanceId === "NB01")?.archivedAtMs).toBeUndefined();

    const restarted = new NotebookInstanceStore(path);
    await restarted.initialize();
    expect(restarted.snapshot().schemaVersion).toBe("inkrelay.notebook_instances.v3");
    expect(restarted.snapshot().instances).toEqual(expect.arrayContaining([expect.objectContaining({ instanceId: work.instanceId, archivedAtMs: 3_000 })]));
    expect((await restarted.restore(work.instanceId, 4_000)).archivedAtMs).toBeUndefined();
    await expect(restarted.activate(work.instanceId)).resolves.toMatchObject({ instanceId: work.instanceId });
  });

  it("migrates v2 catalogs to the archive-capable schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkrelay-notebook-v2-migration-"));
    const path = join(root, "notebook-instances.json");
    await writeFile(path, JSON.stringify({
      schemaVersion: "inkrelay.notebook_instances.v2",
      instances: [{ instanceId: "NB01", paperIdentity: "NB01", displayName: "French", createdAtMs: 1, updatedAtMs: 1 }],
      activeInstances: [{ paperIdentity: "NB01", instanceId: "NB01" }], assignments: [], reassignments: []
    }));
    const store = new NotebookInstanceStore(path);
    await store.initialize();
    expect(store.snapshot()).toMatchObject({ schemaVersion: "inkrelay.notebook_instances.v3", instances: [{ instanceId: "NB01" }] });
    expect(store.snapshot().instances[0]?.archivedAtMs).toBeUndefined();
  });
});
