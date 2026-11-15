import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  PAPER_CATALOG_SCHEMA_VERSION,
  type PaperCalibration, type PaperCatalog,
  type PaperProfile
} from "@inkrelay/core";

const anchorSchema = z.object({
  sourceX: z.number().finite(), sourceY: z.number().finite(),
  paperXMm: z.number().finite().nonnegative().max(2_000), paperYMm: z.number().finite().nonnegative().max(2_000)
}).strict();

const calibrationSchema = z.object({
  kind: z.literal("axis_aligned_affine"),
  scaleX: z.number().finite().positive().max(100), scaleY: z.number().finite().positive().max(100),
  offsetX: z.number().finite().min(-100_000).max(100_000), offsetY: z.number().finite().min(-100_000).max(100_000),
  anchors: z.tuple([anchorSchema, anchorSchema])
}).strict();

const profileSchema = z.object({
  notebookId: z.string().trim().min(1).max(160),
  displayName: z.string().trim().min(1).max(160),
  widthMm: z.number().finite().positive().max(2_000),
  heightMm: z.number().finite().positive().max(2_000),
  appPxPerMm: z.number().finite().positive().max(1_000),
  calibration: calibrationSchema.optional(),
  revision: z.number().int().positive()
}).strict();

const catalogSchema = z.object({
  schemaVersion: z.literal(PAPER_CATALOG_SCHEMA_VERSION),
  profiles: z.array(profileSchema)
}).strict();

const legacyCatalogSchema = z.object({ schemaVersion: z.literal("inkrelay.paper_catalog.v1"), profiles: z.array(profileSchema) }).strict();

export type PaperProfileInput = {
  readonly displayName: string;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly appPxPerMm?: number;
  readonly calibration?: PaperCalibration;
};

export class PaperProfileStore {
  constructor(private readonly path: string) {}

  async load(): Promise<PaperCatalog> {
    try {
      const input: unknown = JSON.parse(await readFile(this.path, "utf8"));
      const catalog = migrateCatalog(input);
      const identities = new Set<string>();
      for (const profile of catalog.profiles) {
        if (identities.has(profile.notebookId)) throw new Error(`Duplicate paper profile for ${profile.notebookId}`);
        identities.add(profile.notebookId);
      }
      return catalog;
    } catch (error) {
      if (isMissing(error)) return { schemaVersion: PAPER_CATALOG_SCHEMA_VERSION, profiles: [] };
      throw error;
    }
  }

  async upsert(notebookId: string, input: PaperProfileInput): Promise<PaperCatalog> {
    const identity = notebookId.trim();
    if (!identity) throw new Error("notebookId is required");
    const catalog = await this.load();
    const previous = catalog.profiles.find((profile) => profile.notebookId === identity);
    const profile: PaperProfile = profileSchema.parse({
      notebookId: identity,
      displayName: input.displayName,
      widthMm: input.widthMm,
      heightMm: input.heightMm,
      appPxPerMm: input.appPxPerMm ?? previous?.appPxPerMm ?? 10,
      ...(input.calibration ?? previous?.calibration ? { calibration: input.calibration ?? previous!.calibration } : {}),
      revision: (previous?.revision ?? 0) + 1
    });
    const profiles = [...catalog.profiles.filter((candidate) => candidate.notebookId !== identity), profile]
      .sort((left, right) => left.notebookId.localeCompare(right.notebookId));
    const updated: PaperCatalog = { schemaVersion: PAPER_CATALOG_SCHEMA_VERSION, profiles };
    await this.write(updated);
    return updated;
  }

  private async write(catalog: PaperCatalog): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporaryPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.path);
  }
}

function migrateCatalog(input: unknown): PaperCatalog {
  const current = catalogSchema.safeParse(input);
  if (current.success) return current.data;
  const legacy = legacyCatalogSchema.parse(input);
  return { schemaVersion: PAPER_CATALOG_SCHEMA_VERSION, profiles: legacy.profiles };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
