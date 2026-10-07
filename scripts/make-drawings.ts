// Drawing fixtures for Phase F: a dimensioned drawing of the spec's bracket
// (80 x 40 x 6 plate, one Ø6.6 through hole at 70, 20 from the lower-left
// corner), third-angle, with a title block. One SVG becomes:
//   bracket.pdf         vector PDF, with a text layer (printed by Chromium)
//   bracket-scan.png    a clean raster scan at 200 dpi (no text layer)
//   bracket-blurry.png  a blurry, low-resolution scan
//
//   npx tsx scripts/make-drawings.ts     (writes examples/drawings/)

import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const OUT = "examples/drawings";
const S = 1.5; // drawing scale 3:2

// Paper is A4 landscape in mm, y down. Part coordinates are mm, y up.
const TOP = { x: 40, y: 95 }; // lower-left corner of the part in the top view
const FRONT = { x: 40, y: 134 }; // bottom-left of the part in the front view
const W = 80;
const H = 40;
const T = 6;
const HOLE = { x: 70, y: 20, d: 6.6 };

const P = (x: number, y: number, o = TOP) => [o.x + x * S, o.y - y * S] as const;

function arrow(x: number, y: number, dx: number, dy: number): string {
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const a = 2.5;
  const w = 0.8;
  return `<path d="M${x},${y} L${x - ux * a - uy * w},${y - uy * a + ux * w} L${x - ux * a + uy * w},${y - uy * a - ux * w} Z" class="ink"/>`;
}

/** A linear dimension between two points, offset to a line, with its text. */
function dim(x1: number, y1: number, x2: number, y2: number, text: string, opts: { vertical?: boolean; at: number; textOffset?: number }): string {
  const out: string[] = [];
  if (opts.vertical) {
    const x = opts.at;
    out.push(`<line x1="${x1 + 1}" y1="${y1}" x2="${x + 1.5 * Math.sign(x - x1)}" y2="${y1}" class="thin"/>`);
    out.push(`<line x1="${x2 + 1}" y1="${y2}" x2="${x + 1.5 * Math.sign(x - x2)}" y2="${y2}" class="thin"/>`);
    out.push(`<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" class="thin"/>`);
    out.push(arrow(x, y1, 0, y1 - y2), arrow(x, y2, 0, y2 - y1));
    const ty = (y1 + y2) / 2;
    out.push(`<text x="${x - (opts.textOffset ?? 1.5)}" y="${ty}" transform="rotate(-90 ${x - (opts.textOffset ?? 1.5)} ${ty})" text-anchor="middle">${text}</text>`);
  } else {
    const y = opts.at;
    out.push(`<line x1="${x1}" y1="${y1 - 1}" x2="${x1}" y2="${y - 1.5 * Math.sign(y1 - y)}" class="thin"/>`);
    out.push(`<line x1="${x2}" y1="${y2 - 1}" x2="${x2}" y2="${y - 1.5 * Math.sign(y2 - y)}" class="thin"/>`);
    out.push(`<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" class="thin"/>`);
    out.push(arrow(x1, y, x1 - x2, 0), arrow(x2, y, x2 - x1, 0));
    out.push(`<text x="${(x1 + x2) / 2}" y="${y - (opts.textOffset ?? 1.2)}" text-anchor="middle">${text}</text>`);
  }
  return out.join("\n");
}

export function bracketSvg(): string {
  const [x0, y0] = P(0, 0);
  const [x1, y1] = P(W, H);
  const [hx, hy] = P(HOLE.x, HOLE.y);
  const r = (HOLE.d / 2) * S;
  const [fx0, fy0] = P(0, 0, FRONT);
  const [fx1, fy1] = P(W, T, FRONT);
  const fhx = FRONT.x + HOLE.x * S;
  const g: string[] = [];

  // Top view.
  g.push(`<rect x="${x0}" y="${y1}" width="${x1 - x0}" height="${y0 - y1}" class="thick"/>`);
  g.push(`<circle cx="${hx}" cy="${hy}" r="${r}" class="thick"/>`);
  g.push(`<line x1="${hx - r - 3}" y1="${hy}" x2="${hx + r + 3}" y2="${hy}" class="centre"/>`);
  g.push(`<line x1="${hx}" y1="${hy - r - 3}" x2="${hx}" y2="${hy + r + 3}" class="centre"/>`);
  g.push(dim(x0, y1, x1, y1, String(W), { at: y1 - 10 }));
  g.push(dim(x0, y0, x0, y1, String(H), { vertical: true, at: x0 - 10 }));
  g.push(dim(x0, y0, hx, y0, String(HOLE.x), { at: y0 + 9, textOffset: -4.3 }));
  g.push(dim(x1, y0, x1, hy, String(HOLE.y), { vertical: true, at: x1 + 9, textOffset: -3.8 }));
  // Hole callout with a leader.
  const lx = hx + r * Math.cos(Math.PI / 4);
  const ly = hy - r * Math.sin(Math.PI / 4);
  g.push(`<line x1="${lx}" y1="${ly}" x2="${lx + 12}" y2="${ly - 12}" class="thin"/><line x1="${lx + 12}" y1="${ly - 12}" x2="${lx + 18}" y2="${ly - 12}" class="thin"/>`);
  g.push(arrow(lx, ly, -12, 12));
  g.push(`<text x="${lx + 19}" y="${ly - 11}">Ø${HOLE.d} THRU</text>`);
  g.push(`<text x="${(x0 + x1) / 2}" y="${y0 + 17}" text-anchor="middle" class="label">TOP VIEW</text>`);

  // Front view, below the top view (third angle). The hole shows as hidden lines.
  g.push(`<rect x="${fx0}" y="${fy1}" width="${fx1 - fx0}" height="${fy0 - fy1}" class="thick"/>`);
  g.push(`<line x1="${fhx - r}" y1="${fy1}" x2="${fhx - r}" y2="${fy0}" class="hidden"/><line x1="${fhx + r}" y1="${fy1}" x2="${fhx + r}" y2="${fy0}" class="hidden"/>`);
  g.push(`<line x1="${fhx}" y1="${fy1 - 3}" x2="${fhx}" y2="${fy0 + 3}" class="centre"/>`);
  g.push(dim(fx1, fy0, fx1, fy1, String(T), { vertical: true, at: fx1 + 9, textOffset: -3.8 }));
  g.push(`<text x="${(fx0 + fx1) / 2}" y="${fy0 + 10}" text-anchor="middle" class="label">FRONT VIEW</text>`);

  // Title block, with the third-angle symbol.
  const tb = { x: 187, y: 152, w: 100, h: 48 };
  g.push(`<rect x="${tb.x}" y="${tb.y}" width="${tb.w}" height="${tb.h}" class="thick"/>`);
  for (const dy of [12, 22, 30, 38]) g.push(`<line x1="${tb.x}" y1="${tb.y + dy}" x2="${tb.x + tb.w}" y2="${tb.y + dy}" class="thin"/>`);
  g.push(`<text x="${tb.x + 3}" y="${tb.y + 8.5}" class="title">BRACKET</text>`);
  g.push(`<text x="${tb.x + 3}" y="${tb.y + 18.5}">DWG NO. CD-0001   SCALE 3:2</text>`);
  g.push(`<text x="${tb.x + 3}" y="${tb.y + 27.5}">MATERIAL: S275 STEEL</text>`);
  g.push(`<text x="${tb.x + 3}" y="${tb.y + 35.5}">UNITS: mm   TOLERANCES ±0.1</text>`);
  g.push(`<text x="${tb.x + 3}" y="${tb.y + 44.5}">THIRD ANGLE PROJECTION</text>`);
  const sx = tb.x + 80;
  const sy = tb.y + 43;
  g.push(`<path d="M${sx},${sy - 2} L${sx + 6},${sy - 3.5} L${sx + 6},${sy + 3.5} L${sx},${sy + 2} Z" class="thin"/>`);
  g.push(`<circle cx="${sx + 12}" cy="${sy}" r="3.5" class="thin"/><circle cx="${sx + 12}" cy="${sy}" r="2" class="thin"/>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="297mm" height="210mm" viewBox="0 0 297 210">
<style>
  text { font-family: Helvetica, Arial, sans-serif; font-size: 3.5px; fill: #000; }
  .label { font-size: 3px; letter-spacing: 0.2px; }
  .title { font-size: 5px; font-weight: bold; }
  .thick { fill: none; stroke: #000; stroke-width: 0.5; }
  .thin { fill: none; stroke: #000; stroke-width: 0.18; }
  .hidden { fill: none; stroke: #000; stroke-width: 0.25; stroke-dasharray: 1.5 0.8; }
  .centre { fill: none; stroke: #000; stroke-width: 0.18; stroke-dasharray: 4 0.8 0.8 0.8; }
  .ink { fill: #000; }
</style>
<rect x="0" y="0" width="297" height="210" fill="#fff"/>
<rect x="8" y="8" width="281" height="194" class="thick"/>
${g.join("\n")}
</svg>`;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const svg = bracketSvg();
  writeFileSync(`${OUT}/bracket.svg`, svg);
  const html = (filter = "") => `<!doctype html><html><head><style>@page { size: 297mm 210mm; margin: 0 } html, body { margin: 0 } svg { display: block; ${filter} }</style></head><body>${svg}</body></html>`;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html());
    writeFileSync(`${OUT}/bracket.pdf`, await page.pdf({ width: "297mm", height: "210mm", printBackground: true }));

    // 200 dpi: one CSS px is 1/96 in.
    const scan = await browser.newPage({ viewport: { width: 1123, height: 794 }, deviceScaleFactor: 200 / 96 });
    await scan.setContent(html());
    writeFileSync(`${OUT}/bracket-scan.png`, await scan.screenshot({ type: "png" }));

    // A bad scan: out of focus and low resolution.
    const blurry = await browser.newPage({ viewport: { width: 1123, height: 794 }, deviceScaleFactor: 0.6 });
    await blurry.setContent(html("filter: blur(4.5px);"));
    writeFileSync(`${OUT}/bracket-blurry.png`, await blurry.screenshot({ type: "png" }));
  } finally {
    await browser.close();
  }
  console.log(`wrote ${OUT}/bracket.svg, bracket.pdf, bracket-scan.png, bracket-blurry.png`);
}

if (process.argv[1]?.endsWith("make-drawings.ts")) void main();
