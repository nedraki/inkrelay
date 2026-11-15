import type { SmartpenPage, Stroke, StrokePoint } from "./types.js";

export type PageDimensions = { readonly width: number; readonly height: number; readonly unit: "app_px" };
export type PaperTransform = { readonly scaleX: number; readonly scaleY: number; readonly offsetX: number; readonly offsetY: number };
export type PaperDefinition = {
  readonly notebookId: string;
  readonly displayName: string;
  readonly provenance: { readonly kind: "measured_reference" | "nproj"; readonly reference: string; readonly digest: string };
  readonly pages: readonly {
    readonly firstPage: number; readonly lastPage: number;
    readonly widthMm: number; readonly heightMm: number;
    readonly transform: PaperTransform;
  }[];
};
export type PaperMapping = PageDimensions & {
  readonly source: "manual" | "measured_reference" | "nproj" | "fallback";
  readonly displayName?: string;
  readonly transform?: PaperTransform;
  readonly provenance?: PaperDefinition["provenance"];
};
export type PaperProfile = {
  readonly notebookId: string;
  readonly displayName: string;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly appPxPerMm: number;
  readonly calibration?: PaperCalibration | undefined;
  readonly revision: number;
};

export type PaperCalibration = {
  readonly kind: "axis_aligned_affine";
  readonly scaleX: number;
  readonly scaleY: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly anchors: readonly [PaperCalibrationAnchor, PaperCalibrationAnchor];
};

export type PaperCalibrationAnchor = {
  readonly sourceX: number;
  readonly sourceY: number;
  readonly paperXMm: number;
  readonly paperYMm: number;
};

export const PAPER_CATALOG_SCHEMA_VERSION = "inkrelay.paper_catalog.v2" as const;
export type PaperCatalog = {
  readonly schemaVersion: typeof PAPER_CATALOG_SCHEMA_VERSION;
  readonly profiles: readonly PaperProfile[];
};

export class PageMapper {
  private profiles = new Map<string, PaperProfile>();
  private definitions = new Map<string, PaperDefinition>();

  constructor(private readonly defaults: PageDimensions = { width: 1480, height: 2100, unit: "app_px" }, profiles: readonly PaperProfile[] = []) {
    this.replaceProfiles(profiles);
  }

  mappingFor(notebookId: string, pageId: number): PaperMapping {
    const profile = this.profiles.get(notebookId);
    if (!profile) {
      const definition = this.definitions.get(notebookId);
      const page = definition?.pages.find((item) => pageId >= item.firstPage && pageId <= item.lastPage);
      if (!definition || !page) return { ...this.defaults, source: "fallback" };
      return { width: Math.round(page.widthMm * 10), height: Math.round(page.heightMm * 10), unit: "app_px",
        source: definition.provenance.kind, displayName: definition.displayName,
        transform: page.transform, provenance: definition.provenance };
    }
    return {
      width: Math.round(profile.widthMm * profile.appPxPerMm),
      height: Math.round(profile.heightMm * profile.appPxPerMm),
      unit: "app_px", source: "manual", displayName: profile.displayName,
      ...(profile.calibration ? { transform: profile.calibration } : {})
    };
  }

  dimensionsFor(notebookId: string, pageId: number): PageDimensions {
    const { width, height, unit } = this.mappingFor(notebookId, pageId);
    return { width, height, unit };
  }

  profileFor(notebookId: string): PaperProfile | undefined { return this.profiles.get(notebookId); }
  replaceProfiles(profiles: readonly PaperProfile[]): void { this.profiles = new Map(profiles.map((profile) => [profile.notebookId, profile])); }
  replaceDefinitions(definitions: readonly PaperDefinition[]): void { this.definitions = new Map(definitions.map((definition) => [definition.notebookId, definition])); }
  projectStroke(notebookId: string, stroke: Stroke): Stroke {
    const calibration = this.mappingFor(notebookId, stroke.pageId).transform;
    return calibration ? mapStroke(stroke, (point) => applyCalibration(point, calibration)) : stroke;
  }
  reprojectStroke(notebookId: string, stroke: Stroke, previous?: PaperProfile): Stroke {
    return this.reprojectWithTransform(notebookId, stroke, previous?.calibration);
  }
  reprojectWithTransform(notebookId: string, stroke: Stroke, previous?: PaperTransform): Stroke {
    const next = this.mappingFor(notebookId, stroke.pageId).transform;
    if (!previous && !next) return stroke;
    return mapStroke(stroke, (point) => {
      const source = previous ? removeCalibration(point, previous) : point;
      return next ? applyCalibration(source, next) : source;
    });
  }
  fallbackDimensions(): PageDimensions { return { ...this.defaults }; }
  projectionMode(): "single-page" { return "single-page"; }
}

function mapStroke(stroke: Stroke, transform: (point: StrokePoint) => StrokePoint): Stroke {
  return { ...stroke, points: stroke.points.map(transform) };
}

function applyCalibration(point: StrokePoint, calibration: PaperTransform): StrokePoint {
  return { ...point, x: point.x * calibration.scaleX + calibration.offsetX, y: point.y * calibration.scaleY + calibration.offsetY };
}

function removeCalibration(point: StrokePoint, calibration: PaperTransform): StrokePoint {
  return { ...point, x: (point.x - calibration.offsetX) / calibration.scaleX, y: (point.y - calibration.offsetY) / calibration.scaleY };
}

export function emptyPage(notebookId: string, pageId: number, dimensions: PageDimensions, atMs: number): SmartpenPage {
  return { notebookId, pageId, ...dimensions, strokes: [], actions: [], createdAtMs: atMs, updatedAtMs: atMs };
}

// Extension boundaries: SpreadMapper and CalibrationProfile live in types.ts.
