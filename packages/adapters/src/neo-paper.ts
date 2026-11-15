import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { PaperDefinition } from "@inkrelay/core";

// Nproj geometry is in 72-dpi points. Canonical InkRelay coordinates remain
// ten times the Ncode cell position; do not change the transport conversion.
const MM_PER_POINT = 25.4 / 72;
const POINTS_PER_NCODE = 56 / 600 * 72;
export const MAX_NPROJ_BYTES = 2_000_000;

/** Read geometry only. Symbols, commands, URLs, scripts and resources are inert. */
export function parseNeoPaperDefinition(xml: string): PaperDefinition {
  if (Buffer.byteLength(xml, "utf8") > MAX_NPROJ_BYTES) throw new Error("Paper metadata exceeds 2 MB");
  if (/<!ENTITY|<!DOCTYPE[^>]*(?:SYSTEM|PUBLIC|\[)/i.test(xml)) throw new Error("External or custom XML entities are not supported");
  if (XMLValidator.validate(xml) !== true) throw new Error("Invalid paper metadata XML");
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", parseTagValue: false,
    parseAttributeValue: false, isArray: (name) => name === "page_item", processEntities: true }).parse(xml);
  const root = object(parsed.nproj, "nproj");
  if (!/^2\.\d+$/.test(String(root.version))) throw new Error("Only nproj version 2.x is supported");
  const book = object(root.book, "book");
  const section = integer(book.section, "section", 0, 255);
  const owner = integer(book.owner, "owner", 0, 0xffffff);
  const code = integer(book.code, "code", 0, 0x7fffffff);
  const segment = book.segment_info === undefined ? undefined : object(book.segment_info, "segment_info");
  const startPage = typeof book.start_page === "object" && book.start_page ? object(book.start_page, "start_page")["#text"] : book.start_page;
  const start = integer(segment?.ncode_start_page ?? startPage, "start page", 0, 0x7fffffff);
  const pages = object(root.pages, "pages");
  const items = pages.page_item;
  if (!Array.isArray(items) || !items.length || items.length > 10_000) throw new Error("Expected 1–10000 page definitions");
  if (pages.count !== undefined && integer(pages.count, "page count", 1, 10_000) !== items.length) throw new Error("Page count does not match page definitions");
  if (segment?.ncode_end_page !== undefined && integer(segment.ncode_end_page, "end page", start, 0x7fffffff) !== start + items.length - 1) throw new Error("Segment page range does not match page definitions");
  const notebookId = `NEO_${section}_${owner}_${code}`;
  return {
    notebookId, displayName: typeof book.title === "string" && book.title.trim() ? book.title.trim().slice(0, 160) : notebookId,
    provenance: { kind: "nproj", reference: `nproj ${root.version}; book revision ${book.revision ?? "unspecified"}`,
      digest: createHash("sha256").update(xml).digest("hex") },
    pages: items.map((value, index) => {
      const item = object(value, "page_item");
      if (integer(item.number, "page number", 0, 10_000) !== index) throw new Error("Page definitions must be ordered and numbered from zero");
      if (item.rotate_angle !== undefined && number(item.rotate_angle, "rotation") !== 0) throw new Error("Rotated paper metadata is not supported");
      const x1 = number(item.x1, "x1"), y1 = number(item.y1, "y1");
      const x2 = number(item.x2, "x2"), y2 = number(item.y2, "y2");
      // Match NoteServer.extractMarginInfo: left, top, right, bottom, in points.
      const margins = typeof item.crop_margin === "string" ? item.crop_margin.split(",") : [];
      if (margins.length !== 4) throw new Error("Four crop margins are required");
      const [left, top, right, bottom] = margins.map((value) => number(value, "crop margin")) as [number, number, number, number];
      if ([left, top, right, bottom].some((margin) => margin < 0)) throw new Error("Crop margins cannot be negative");
      const widthMm = (x2 - x1 - left - right) * MM_PER_POINT;
      const heightMm = (y2 - y1 - top - bottom) * MM_PER_POINT;
      if (!(widthMm > 0 && widthMm <= 2000 && heightMm > 0 && heightMm <= 2000)) throw new Error("Invalid cropped paper dimensions");
      const pageId = start + index;
      if (!Number.isSafeInteger(pageId) || pageId > 0x7fffffff) throw new Error("Page range is too large");
      const scale = POINTS_PER_NCODE * MM_PER_POINT;
      return { firstPage: pageId, lastPage: pageId, widthMm, heightMm,
        transform: { scaleX: scale, scaleY: scale, offsetX: -(x1 + left) * MM_PER_POINT * 10, offsetY: -(y1 + top) * MM_PER_POINT * 10 } };
    })
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected one ${label} element`);
  return value as Record<string, unknown>;
}
function number(value: unknown, label: string): number {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${label}`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > 100_000) throw new Error(`Invalid ${label}`);
  return parsed;
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) throw new Error(`Invalid ${label}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${label}`);
  return parsed;
}
