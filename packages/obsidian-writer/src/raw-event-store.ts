import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PenDotEvent } from "@inkrelay/core";

export class RawEventStore {
  private readonly seenByPath = new Map<string, Map<string, PenDotEvent>>();
  constructor(private readonly root: string) {}

  async append(event: PenDotEvent): Promise<"appended" | "enriched" | "duplicate"> {
    const path = this.sessionPath(event.notebookId, event.pageId, event.sessionId);
    let seen = this.seenByPath.get(path);
    if (!seen) {
      seen = new Map<string, PenDotEvent>();
      try {
        const content = await readFile(path, "utf8");
        for (const line of content.split(/\r?\n/).filter(Boolean)) {
          const stored = JSON.parse(line) as PenDotEvent;
          seen.set(identity(stored), stored);
        }
      } catch (error) { if (!isMissing(error)) throw error; }
      this.seenByPath.set(path, seen);
    }
    const key = identity(event);
    const existing = seen.get(key);
    if (existing) {
      if (!existing.color && event.color) {
        const enriched = { ...existing, color: event.color };
        await appendFile(path, `${JSON.stringify(enriched)}\n`, { encoding: "utf8", flag: "a" });
        seen.set(key, enriched);
        return "enriched";
      }
      return "duplicate";
    }
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
    seen.set(key, event);
    return "appended";
  }

  async eventsForPage(notebookId: string, pageId: number): Promise<PenDotEvent[]> {
    const directory = join(this.root, safe(notebookId), pageFolder(pageId));
    let names: string[];
    try { names = await readdir(directory); } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const events: PenDotEvent[] = [];
    for (const name of names.filter((entry) => entry.endsWith(".events.jsonl")).sort()) {
      const content = await readFile(join(directory, name), "utf8");
      for (const line of content.split(/\r?\n/).filter(Boolean)) events.push(JSON.parse(line) as PenDotEvent);
    }
    return deduplicate(events);
  }

  async allEvents(): Promise<PenDotEvent[]> {
    const paths: string[] = [];
    await collectEventFiles(this.root, paths);
    const events: PenDotEvent[] = [];
    for (const path of paths.sort()) {
      const content = await readFile(path, "utf8");
      for (const line of content.split(/\r?\n/).filter(Boolean)) events.push(JSON.parse(line) as PenDotEvent);
    }
    return deduplicate(events);
  }

  sessionPath(notebookId: string, pageId: number, sessionId: string): string {
    return join(this.root, safe(notebookId), pageFolder(pageId), `${safe(sessionId)}.events.jsonl`);
  }
}

async function collectEventFiles(directory: string, output: string[]): Promise<void> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (isMissing(error)) return; throw error; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectEventFiles(path, output);
    else if (entry.isFile() && entry.name.endsWith(".events.jsonl")) output.push(path);
  }
}

function safe(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, "_"); }
function pageFolder(pageId: number): string { return `Page_${String(pageId).padStart(3, "0")}`; }
function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function identity(event: PenDotEvent): string { return `${event.penId}\u0000${event.sessionId}\u0000${event.sequence}`; }
function deduplicate(events: readonly PenDotEvent[]): PenDotEvent[] {
  const latest = new Map<string, PenDotEvent>();
  for (const event of events) latest.set(identity(event), event);
  return [...latest.values()].sort((a, b) => a.timestampMs - b.timestampMs || a.penId.localeCompare(b.penId) || a.sessionId.localeCompare(b.sessionId) || a.sequence - b.sequence);
}
