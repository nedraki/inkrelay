import { describe, expect, it } from "vitest";
import { adjacentPage, adjacentSpreadPage, automaticSpread, groupNotebookPages, spreadAnchors } from "../apps/web/src/page-navigation.js";
import { page } from "./helpers.js";

describe("paper navigation", () => {
  it("groups pages by physical notebook and sorts pages numerically", () => {
    const groups = groupNotebookPages([
      page({ notebookId: "paper", physicalNotebookId: "copy-b", physicalNotebookName: "Work", pageId: 12 }),
      page({ notebookId: "paper", physicalNotebookId: "copy-a", physicalNotebookName: "Course", pageId: 82 }),
      page({ notebookId: "paper", physicalNotebookId: "copy-a", physicalNotebookName: "Course", pageId: 3 })
    ]);
    expect(groups.map((group) => [group.notebookId, group.label, group.pages.map((item) => item.pageId)])).toEqual([
      ["copy-a", "Course", [3, 82]],
      ["copy-b", "Work", [12]]
    ]);
  });

  it("uses the conventional even-left and odd-right spread", () => {
    expect(automaticSpread(4)).toEqual({ leftPageId: 4, rightPageId: 5 });
    expect(automaticSpread(5)).toEqual({ leftPageId: 4, rightPageId: 5 });
    expect(automaticSpread(1)).toEqual({ leftPageId: 0, rightPageId: 1 });
  });

  it("navigates captured pages without walking through uncaptured gaps", () => {
    const pages = [page({ pageId: 3 }), page({ pageId: 4 }), page({ pageId: 82 })];
    expect(adjacentPage(pages, 4, 1)?.pageId).toBe(82);
    expect(adjacentPage(pages, 4, -1)?.pageId).toBe(3);
    expect(spreadAnchors(pages)).toEqual([2, 4, 82]);
    expect(adjacentSpreadPage(pages, 4, 1)?.pageId).toBe(82);
    expect(adjacentSpreadPage(pages, 4, -1)?.pageId).toBe(3);
  });
});
