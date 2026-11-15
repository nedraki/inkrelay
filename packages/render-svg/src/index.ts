import type { SmartpenPage, Stroke } from "@inkrelay/core";

export const SVG_RENDERER_VERSION = "inkrelay.svg.v1" as const;

export class SVGRenderer {
  render(page: SmartpenPage): string {
    const paths = [...page.strokes]
      .filter((stroke) => stroke.semanticRole !== "action" && stroke.points.length > 0)
      .sort((a, b) => a.startedAtMs - b.startedAtMs || a.strokeId.localeCompare(b.strokeId))
      .map(renderStroke);
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${number(page.width)}" height="${number(page.height)}" viewBox="0 0 ${number(page.width)} ${number(page.height)}">`,
      ...paths.map((path) => `  ${path}`),
      `</svg>`,
      ""
    ].join("\n");
  }
}

function renderStroke(stroke: Stroke): string {
  const points = stroke.points;
  const first = points[0];
  if (!first) return "";
  let d = `M ${number(first.x)} ${number(first.y)}`;
  if (points.length === 1) d += ` L ${number(first.x)} ${number(first.y)}`;
  for (const point of points.slice(1)) d += ` L ${number(point.x)} ${number(point.y)}`;
  return `<path data-stroke-id="${xml(stroke.strokeId)}" d="${d}" fill="none" stroke="${xml(stroke.style.color)}" stroke-width="${number(stroke.style.width)}" stroke-opacity="${number(stroke.style.opacity)}" stroke-linecap="round" stroke-linejoin="round" />`;
}

function number(value: number): string { return Number(value.toFixed(4)).toString(); }
function xml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
