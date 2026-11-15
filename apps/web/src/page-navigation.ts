import type { SmartpenPage } from "@inkrelay/core";

export type NotebookPages = {
  readonly notebookId: string;
  readonly label: string;
  readonly pages: readonly SmartpenPage[];
};

export type SpreadPageIds = {
  readonly leftPageId: number;
  readonly rightPageId: number;
};

export function physicalNotebookId(page: SmartpenPage): string {
  return page.physicalNotebookId ?? page.notebookId;
}

export function groupNotebookPages(pages: readonly SmartpenPage[]): readonly NotebookPages[] {
  const groups = new Map<string, SmartpenPage[]>();
  for (const page of pages) {
    const id = physicalNotebookId(page);
    const group = groups.get(id);
    if (group) group.push(page);
    else groups.set(id, [page]);
  }
  return [...groups.entries()].map(([notebookId, notebookPages]) => ({
    notebookId,
    label: notebookPages[0]?.physicalNotebookName ?? notebookPages[0]?.notebookId ?? notebookId,
    pages: [...notebookPages].sort((left, right) => left.pageId - right.pageId)
  })).sort((left, right) => left.label.localeCompare(right.label, undefined, { numeric: true }));
}

export function automaticSpread(pageId: number): SpreadPageIds {
  const leftPageId = pageId % 2 === 0 ? pageId : pageId - 1;
  return { leftPageId, rightPageId: leftPageId + 1 };
}

export function spreadAnchors(pages: readonly SmartpenPage[]): readonly number[] {
  return [...new Set(pages.map((page) => automaticSpread(page.pageId).leftPageId))].sort((left, right) => left - right);
}

export function adjacentPage(pages: readonly SmartpenPage[], pageId: number, direction: -1 | 1): SmartpenPage | undefined {
  const sorted = [...pages].sort((left, right) => left.pageId - right.pageId);
  const index = sorted.findIndex((page) => page.pageId === pageId);
  return index < 0 ? sorted[0] : sorted[index + direction];
}

export function adjacentSpreadPage(pages: readonly SmartpenPage[], pageId: number, direction: -1 | 1): SmartpenPage | undefined {
  const anchors = spreadAnchors(pages);
  const currentAnchor = automaticSpread(pageId).leftPageId;
  const index = anchors.indexOf(currentAnchor);
  const targetAnchor = index < 0 ? anchors[0] : anchors[index + direction];
  if (targetAnchor === undefined) return undefined;
  return pages.find((page) => automaticSpread(page.pageId).leftPageId === targetAnchor);
}
