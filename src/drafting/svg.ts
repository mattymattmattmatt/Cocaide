// The sheet as SVG: what the app shows and what "Export SVG" writes. Sheet
// coordinates are mm with y up; SVG's are y down, so every y is flipped here.
// Each view and annotation is a group with its id, so the app can find what
// was clicked and the checks' names match what is on screen.

import type { ComposedSheet } from "./compose";
import type { Prim } from "./sheet";

export const SHEET_FONT = "Helvetica, Arial, 'Liberation Sans', sans-serif";

export interface SvgOptions {
  /** Ids drawn highlighted. */
  selected?: string[];
  /** Ids drawn as problems. */
  failed?: string[];
}

export function sheetSVG(sheet: ComposedSheet, opts: SvgOptions = {}): string {
  const H = sheet.height;
  const n = (x: number) => String(Math.round(x * 1000) / 1000 + 0);
  const y = (v: number) => n(H - v);
  const pts = (p: [number, number][]) => p.map(([a, b]) => `${n(a)},${y(b)}`).join(" ");
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const prim = (p: Prim): string => {
    if (p.k === "line") {
      const stroke = `stroke-width="${n(p.w)}"${p.dash ? ` stroke-dasharray="${p.dash.map(n).join(" ")}"` : ""}`;
      const fill = p.fill ? `fill="currentColor"` : `fill="none"`;
      return p.closed || p.fill ? `<polygon points="${pts(p.pts)}" ${fill} ${stroke}/>` : `<polyline points="${pts(p.pts)}" fill="none" ${stroke}/>`;
    }
    if (p.k === "circle") return `<circle cx="${n(p.c[0])}" cy="${y(p.c[1])}" r="${n(p.r)}" stroke-width="${n(p.w)}" fill="${p.fill ? "currentColor" : "none"}"/>`;
    const anchor = p.anchor === "start" ? "" : ` text-anchor="${p.anchor}"`;
    const rot = p.angle ? ` transform="rotate(${n(-p.angle)} ${n(p.at[0])} ${y(p.at[1])})"` : "";
    return `<text x="${n(p.at[0])}" y="${y(p.at[1])}" font-size="${n(p.size)}"${anchor}${p.bold ? ` font-weight="bold"` : ""}${rot} fill="currentColor" stroke="none">${esc(p.text)}</text>`;
  };
  const groups: string[] = [];
  let owner: string | undefined;
  let open = false;
  const selected = new Set(opts.selected ?? []);
  const failed = new Set(opts.failed ?? []);
  for (const p of sheet.prims) {
    if (!open || p.owner !== owner) {
      if (open) groups.push("</g>");
      owner = p.owner;
      const cls = [owner && selected.has(owner) ? "selected" : "", owner && failed.has(owner) ? "failed" : ""].filter(Boolean).join(" ");
      groups.push(`<g${owner ? ` data-id="${esc(owner)}"` : ""}${cls ? ` class="${cls}"` : ""}>`);
      open = true;
    }
    groups.push(prim(p));
  }
  if (open) groups.push("</g>");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(sheet.width)}mm" height="${n(H)}mm" viewBox="0 0 ${n(sheet.width)} ${n(H)}" font-family="${SHEET_FONT}" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" color="#000">`,
    `<rect width="${n(sheet.width)}" height="${n(H)}" fill="#fff" stroke="none"/>`,
    ...groups,
    `</svg>`,
  ].join("\n");
}
