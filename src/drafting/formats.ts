// Sheet formats and templates (Phase Q): the paper's size and orientation,
// its border, the zone grid along it, the title block and the revision block,
// drawn as primitives. Four templates:
//
// - "iso": an ISO 5457 border (20 mm filing margin, 10 mm elsewhere) with a
//   zone grid and centring marks, and an ISO 7200 title block 180 mm wide:
//   the identification (title, drawing number, revision, sheet, size) along
//   the bottom, who drew, checked and approved it with the general tolerance
//   and the company above, material, finish, mass, scale and the projection
//   symbol on top. A revision block grows above it when there are revisions.
// - "ansi": an ASME Y14.1 border with zones lettered from the bottom and
//   numbered from the right, a title block with the "unless otherwise
//   specified" tolerance block, the name/date column, the company, the
//   title, size, drawing number, revision, scale, weight and sheet; the
//   revision block in the top right corner.
// - "minimal": a border and one strip.
// - "classic": Phase L's block, unchanged, which old drawings keep.
//
// Every field reads its text through the property links (src/drafting/props.ts).

import type { Drawing, Projection, SheetFormat, TitleField, Vec2 } from "../doc/types";
import { SHEET_SIZES } from "../doc/types";
import { resolveProps, type PropContext } from "./props";
import type { Box, Prim } from "./sheet";
import { CAP, LINE, TEXT, textWidth } from "./text";

/** The paper, mm: width and height, the orientation applied. */
export function paperSize(format: Pick<SheetFormat, "size" | "orientation">): [number, number] {
  const [w, h] = SHEET_SIZES[format.size] ?? SHEET_SIZES.A3;
  return format.orientation === "portrait" ? [h, w] : [w, h];
}

export interface FormatContext {
  format: SheetFormat;
  projection: Projection;
  drawing: Drawing;
  props: PropContext;
  /** "1:2". */
  scaleText: string;
  sheetNumber: number;
  sheetCount: number;
}

export interface FormatLayout {
  width: number;
  height: number;
  /** Inside the border. */
  frame: Box;
  titleBlock: Box;
  /** The revision block, when drawn. */
  revisionBlock?: Box;
  prims: Prim[];
}

const OWNER = "titleBlock";

/** A field's text: what the sheet's format says (its links resolved), else the template's default link. */
export function fieldText(ctx: FormatContext, field: TitleField): string {
  const set = ctx.format[field];
  const given = set !== undefined ? resolveProps(set, ctx.props) : "";
  if (set !== undefined) return given;
  const p = ctx.props;
  const latest = ctx.drawing.revisions?.at(-1)?.rev;
  const defaults: Partial<Record<TitleField, string>> = {
    title: p.part.description || p.model.name || "",
    number: p.drawing.number ?? p.part.partNumber ?? "",
    revision: latest ?? p.part.revision ?? "",
    drawnBy: p.part.author ?? "",
    material: p.model.material ?? "",
    mass: p.model.mass ?? "",
    finish: p.part.finish ?? "",
    company: p.drawing.company ?? p.part.company ?? "",
  };
  return defaults[field] ?? "";
}

/** The border, zones, title block and revision block of a sheet. */
export function drawFormat(ctx: FormatContext): FormatLayout {
  const [width, height] = paperSize(ctx.format);
  const template = ctx.format.template ?? (ctx.drawing.standard === "ASME" ? "ansi" : "iso");
  if (template === "ansi") return ansi(ctx, width, height);
  if (template === "minimal") return minimal(ctx, width, height);
  return iso(ctx, width, height);
}

// ------------------------------------------------------------ pieces

interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  value?: string;
  /** Font size of the value (default TEXT.cell). */
  size?: number;
  bold?: boolean;
  centre?: boolean;
  /** No box drawn round it. */
  open?: boolean;
}

function line(prims: Prim[], pts: Vec2[], w: number = LINE.thin, owner = OWNER): void {
  prims.push({ k: "line", pts, w, owner });
}

function rect(prims: Prim[], b: Box, w: number, owner = OWNER): void {
  line(prims, [b.min, [b.max[0], b.min[1]], b.max, [b.min[0], b.max[1]], b.min], w, owner);
}

function text(prims: Prim[], at: Vec2, t: string, size: number, anchor: "start" | "middle" | "end" = "start", bold = false, owner = OWNER): void {
  if (t) prims.push({ k: "text", at, text: t, size, anchor, ...(bold ? { bold: true } : {}), owner });
}

/** Shortens text to fit a width, with "...". */
export function fit(t: string, width: number, size: number, bold = false): string {
  if (textWidth(t, size, bold) <= width) return t;
  let s = t;
  while (s.length > 1 && textWidth(`${s}...`, size, bold) > width) s = s.slice(0, -1);
  return `${s}...`;
}

/** Cells: a thin box each, a small label in its top left, the value under it (shrunk to fit). */
function cells(prims: Prim[], list: Cell[]): void {
  for (const c of list) {
    if (!c.open) rect(prims, { min: [c.x, c.y], max: [c.x + c.w, c.y + c.h] }, LINE.thin);
    if (c.label) text(prims, [c.x + 1.2, c.y + c.h - TEXT.label * CAP - 1], c.label, TEXT.label);
    if (c.value) {
      let size = c.size ?? TEXT.cell;
      // Shrink a long value a little before cutting it short.
      while (size > TEXT.cell * 0.7 && textWidth(c.value, size, c.bold) > c.w - 3) size *= 0.92;
      const room = c.label ? c.h - TEXT.label * CAP - 2 : c.h;
      const y = c.y + Math.max(1.4, (room - size * CAP) / 2);
      const v = fit(c.value, c.w - 3, size, c.bold);
      if (c.centre) text(prims, [c.x + c.w / 2, y], v, size, "middle", c.bold);
      else text(prims, [c.x + 1.6, y], v, size, "start", c.bold);
    }
  }
}

/**
 * ISO 128's projection symbol, a truncated cone seen from the side and from
 * its small end. Third-angle puts the end view on the side it is seen from,
 * so the cone narrows toward it; first-angle on the opposite side. `at` is
 * the side view's left middle; `k` scales it (1: 5.2 mm cone, 2.6 mm radius).
 */
export function projectionSymbol(prims: Prim[], at: Vec2, projection: Projection, k = 1, owner = OWNER): void {
  const [x, y] = at;
  const big = 2.6 * k;
  const small = 1.3 * k;
  const long = 5.2 * k;
  const gap = 3.5 * k;
  if (projection === "third") {
    prims.push({ k: "line", pts: [[x, y - small], [x + long, y - big], [x + long, y + big], [x, y + small]], closed: true, w: LINE.thin, owner });
    const cx = x + long + gap + big;
    prims.push({ k: "circle", c: [cx, y], r: big, w: LINE.thin, owner });
    prims.push({ k: "circle", c: [cx, y], r: small, w: LINE.thin, owner });
    centreCross(prims, [cx, y], big + 1, owner);
    line(prims, [[x - 1, y], [x + long + 1, y]], LINE.thin * 0.8, owner);
  } else {
    const cx = x + big;
    prims.push({ k: "circle", c: [cx, y], r: big, w: LINE.thin, owner });
    prims.push({ k: "circle", c: [cx, y], r: small, w: LINE.thin, owner });
    centreCross(prims, [cx, y], big + 1, owner);
    const sx = x + 2 * big + gap;
    prims.push({ k: "line", pts: [[sx, y - big], [sx + long, y - small], [sx + long, y + small], [sx, y + big]], closed: true, w: LINE.thin, owner });
    line(prims, [[sx - 1, y], [sx + long + 1, y]], LINE.thin * 0.8, owner);
  }
}

/** The projection symbol's width at scale k. */
export function projectionSymbolWidth(k = 1): number {
  return (5.2 + 3.5 + 5.2) * k;
}

function centreCross(prims: Prim[], c: Vec2, r: number, owner: string): void {
  line(prims, [[c[0] - r, c[1]], [c[0] + r, c[1]]], LINE.thin * 0.8, owner);
  line(prims, [[c[0], c[1] - r], [c[0], c[1] + r]], LINE.thin * 0.8, owner);
}

/**
 * The zone grid between the frame and a line 5 mm outside it: fields about
 * `field` mm, an even number along each side; ISO numbers left to right and
 * letters top to bottom, ASME numbers right to left and letters bottom to top.
 * Centring marks at the middle of each side.
 */
function zones(prims: Prim[], width: number, height: number, frame: Box, field: number, style: "iso" | "ansi"): void {
  const outer: Box = { min: [frame.min[0] - 5, frame.min[1] - 5], max: [frame.max[0] + 5, frame.max[1] + 5] };
  rect(prims, outer, LINE.thin, "sheet");
  const fw = frame.max[0] - frame.min[0];
  const fh = frame.max[1] - frame.min[1];
  const cols = Math.max(2, 2 * Math.round(fw / (2 * field)));
  const rows = Math.max(2, 2 * Math.round(fh / (2 * field)));
  const size = 3.4;
  const letters = "ABCDEFGHJKLMNPRSTUVWXYZ";
  for (let i = 0; i <= cols; i++) {
    const x = frame.min[0] + (fw * i) / cols;
    if (i > 0 && i < cols) {
      line(prims, [[x, frame.max[1]], [x, outer.max[1]]], LINE.thin, "sheet");
      line(prims, [[x, frame.min[1]], [x, outer.min[1]]], LINE.thin, "sheet");
    }
    if (i < cols) {
      const cx = frame.min[0] + (fw * (i + 0.5)) / cols;
      const n = String(style === "iso" ? i + 1 : cols - i);
      text(prims, [cx, frame.max[1] + 2.5 - (size * CAP) / 2], n, size, "middle", false, "sheet");
      text(prims, [cx, frame.min[1] - 2.5 - (size * CAP) / 2], n, size, "middle", false, "sheet");
    }
  }
  for (let j = 0; j <= rows; j++) {
    const y = frame.min[1] + (fh * j) / rows;
    if (j > 0 && j < rows) {
      line(prims, [[frame.min[0], y], [outer.min[0], y]], LINE.thin, "sheet");
      line(prims, [[frame.max[0], y], [outer.max[0], y]], LINE.thin, "sheet");
    }
    if (j < rows) {
      const cy = frame.min[1] + (fh * (j + 0.5)) / rows - (size * CAP) / 2;
      const l = letters[style === "iso" ? rows - 1 - j : j] ?? "?";
      text(prims, [frame.min[0] - 2.5, cy], l, size, "middle", false, "sheet");
      text(prims, [frame.max[0] + 2.5, cy], l, size, "middle", false, "sheet");
    }
  }
  // Centring marks: from the paper's edge to the frame, mid-side, thick.
  const mx = width / 2;
  const my = height / 2;
  line(prims, [[mx, 0], [mx, frame.min[1]]], LINE.border, "sheet");
  line(prims, [[mx, height], [mx, frame.max[1]]], LINE.border, "sheet");
  line(prims, [[0, my], [frame.min[0], my]], LINE.border, "sheet");
  line(prims, [[width, my], [frame.max[0], my]], LINE.border, "sheet");
}

/** The zone a sheet point is in ("C4"), by the same grid; null outside the frame. */
export function zoneAt(p: Vec2, ctx: { format: SheetFormat; drawing: Drawing }): string | null {
  const [width, height] = paperSize(ctx.format);
  const template = ctx.format.template ?? (ctx.drawing.standard === "ASME" ? "ansi" : "iso");
  if (template !== "iso" && template !== "ansi") return null;
  const frame = template === "iso" ? isoFrame(width, height) : ansiFrame(width, height);
  const field = template === "iso" ? 50 : 105;
  const fw = frame.max[0] - frame.min[0];
  const fh = frame.max[1] - frame.min[1];
  if (p[0] < frame.min[0] || p[0] > frame.max[0] || p[1] < frame.min[1] || p[1] > frame.max[1]) return null;
  const cols = Math.max(2, 2 * Math.round(fw / (2 * field)));
  const rows = Math.max(2, 2 * Math.round(fh / (2 * field)));
  const i = Math.min(cols - 1, Math.floor(((p[0] - frame.min[0]) / fw) * cols));
  const j = Math.min(rows - 1, Math.floor(((p[1] - frame.min[1]) / fh) * rows));
  const letters = "ABCDEFGHJKLMNPRSTUVWXYZ";
  return template === "iso" ? `${letters[rows - 1 - j]}${i + 1}` : `${letters[j]}${cols - i}`;
}

function isoFrame(width: number, height: number): Box {
  return { min: [20, 10], max: [width - 10, height - 10] };
}

function ansiFrame(width: number, height: number): Box {
  return { min: [12, 12], max: [width - 12, height - 12] };
}

/** The general tolerance as the title block shows it. */
function toleranceText(d: Drawing): string {
  return d.generalTolerance ?? "";
}

// ------------------------------------------------------------ ISO

function iso(ctx: FormatContext, width: number, height: number): FormatLayout {
  const prims: Prim[] = [];
  const frame = isoFrame(width, height);
  rect(prims, frame, LINE.border, "sheet");
  zones(prims, width, height, frame, 50, "iso");
  const W = 180;
  const x0 = frame.max[0] - W;
  const y0 = frame.min[1];
  const f = (k: TitleField) => fieldText(ctx, k);
  const list: Cell[] = [];
  // Bottom: the identification.
  const title = f("title");
  const subtitle = f("subtitle");
  list.push({ x: x0, y: y0, w: 110, h: 20, label: "TITLE", open: true });
  list.push({ x: x0 + 110, y: y0 + 9, w: 70, h: 11, label: "DRAWING NO.", value: f("number"), size: 5.6, bold: true });
  list.push({ x: x0 + 110, y: y0, w: 18, h: 9, label: "REV", value: f("revision"), centre: true, bold: true });
  list.push({ x: x0 + 128, y: y0, w: 26, h: 9, label: "SHEET", value: `${ctx.sheetNumber} / ${ctx.sheetCount}`, centre: true });
  list.push({ x: x0 + 154, y: y0, w: 26, h: 9, label: "SIZE", value: ctx.format.size, centre: true });
  // Middle: tolerances and units, who and when, the company.
  const y1 = y0 + 20;
  list.push({ x: x0, y: y1 + 9, w: 52, h: 9, label: "GENERAL TOLERANCES", value: toleranceText(ctx.drawing) || "—" });
  list.push({ x: x0, y: y1, w: 52, h: 9, label: "UNITS", value: `${ctx.drawing.units === "in" ? "inch" : "mm"} · do not scale` });
  const who: [string, TitleField, TitleField][] = [
    ["DRAWN", "drawnBy", "date"],
    ["CHECKED", "checkedBy", "checkedDate"],
    ["APPROVED", "approvedBy", "approvedDate"],
  ];
  const rx = x0 + 52;
  who.forEach(([role, name, date], i) => {
    const y = y1 + 12 - i * 6;
    list.push({ x: rx, y, w: 20, h: 6, value: role, size: TEXT.label * 1.1 });
    list.push({ x: rx + 20, y, w: 32, h: 6, value: f(name), size: TEXT.cell * 0.85 });
    list.push({ x: rx + 52, y, w: 24, h: 6, value: f(date), size: TEXT.cell * 0.85 });
  });
  list.push({ x: x0 + 128, y: y1, w: 52, h: 18, label: "", value: f("company"), size: 5, bold: true, centre: true });
  // Top: what it is made of, how heavy, the scale, the projection.
  const y2 = y1 + 18;
  list.push({ x: x0, y: y2, w: 62, h: 10, label: "MATERIAL", value: f("material") });
  list.push({ x: x0 + 62, y: y2, w: 48, h: 10, label: "FINISH", value: f("finish") });
  list.push({ x: x0 + 110, y: y2, w: 28, h: 10, label: "MASS", value: f("mass") });
  list.push({ x: x0 + 138, y: y2, w: 20, h: 10, label: "SCALE", value: ctx.scaleText, centre: true, bold: true });
  list.push({ x: x0 + 158, y: y2, w: 22, h: 10 });
  cells(prims, list);
  // The title, large, and its second line.
  const tsize = 7.6;
  const tfit = fit(title, 106, tsize, true);
  text(prims, [x0 + 2, y0 + (subtitle ? 9.4 : 6.2)], tfit, textWidth(title, tsize, true) > 106 ? 6 : tsize, "start", true);
  if (subtitle) text(prims, [x0 + 2, y0 + 3], fit(subtitle, 106, TEXT.cell), TEXT.cell);
  projectionSymbol(prims, [x0 + 158 + 2.2, y2 + 5], ctx.projection, 0.95);
  const titleBlock: Box = { min: [x0, y0], max: [frame.max[0], y2 + 10] };
  rect(prims, titleBlock, LINE.visible);
  // Revisions: a block over the title block, newest at the bottom, when there are any.
  let revisionBlock: Box | undefined;
  const revs = ctx.drawing.revisions ?? [];
  if (revs.length) {
    const cols: [string, number, (r: (typeof revs)[number]) => string][] = [
      ["REV", 14, (r) => r.rev],
      ["DESCRIPTION", 88, (r) => r.description ?? ""],
      ["ZONE", 16, (r) => r.zone ?? ""],
      ["DATE", 30, (r) => r.date ?? ""],
      ["BY", 32, (r) => [r.by, r.approved].filter(Boolean).join(" / ")],
    ];
    revisionBlock = revisionTable(prims, cols, revs, x0, titleBlock.max[1], false);
  }
  return { width, height, frame, titleBlock, ...(revisionBlock ? { revisionBlock } : {}), prims };
}

/** The revision table: a header row and a row per revision, from `y` up (or down from it, `down`). */
function revisionTable<T>(prims: Prim[], cols: [string, number, (r: T) => string][], rows: T[], x0: number, y: number, down: boolean, title?: string): Box {
  const H = 6;
  const W = cols.reduce((a, c) => a + c[1], 0);
  const all = [null, ...(down ? rows : [...rows].reverse())];
  const n = all.length + (title ? 1 : 0);
  const top = down ? y : y + n * H;
  const box: Box = { min: [x0, top - n * H], max: [x0 + W, top] };
  rect(prims, box, LINE.visible);
  let ry = top;
  if (title) {
    text(prims, [x0 + W / 2, ry - H + 1.8], title, TEXT.cell, "middle", true);
    ry -= H;
    line(prims, [[x0, ry], [x0 + W, ry]]);
  }
  // The header is next to the title block (ISO: at the bottom) or under the title (ASME: at the top).
  const order = down ? all : [...all.slice(1), null];
  for (const r of order) {
    let x = x0;
    for (const [head, w, get] of cols) {
      const t = r === null ? head : get(r);
      text(prims, [x + (r === null ? w / 2 : 1.4), ry - H + 1.9], fit(t, w - 2.5, r === null ? TEXT.label * 1.15 : TEXT.cell * 0.85, r === null), r === null ? TEXT.label * 1.15 : TEXT.cell * 0.85, r === null ? "middle" : "start", r === null);
      x += w;
      if (x < x0 + W - 1e-6) line(prims, [[x, ry], [x, ry - H]]);
    }
    ry -= H;
    if (ry > box.min[1] + 1e-6) line(prims, [[x0, ry], [x0 + W, ry]], r === null ? LINE.visible : LINE.thin);
  }
  return box;
}

// ------------------------------------------------------------ ANSI

function ansi(ctx: FormatContext, width: number, height: number): FormatLayout {
  const prims: Prim[] = [];
  const frame = ansiFrame(width, height);
  rect(prims, frame, LINE.border, "sheet");
  zones(prims, width, height, frame, 105, "ansi");
  const f = (k: TitleField) => fieldText(ctx, k);
  const W = 178;
  const H = 52;
  const x0 = frame.max[0] - W;
  const y0 = frame.min[1];
  const list: Cell[] = [];
  // Left: the tolerance block, the material and finish.
  const lw = 64;
  list.push({ x: x0, y: y0 + 22, w: lw, h: 30, open: true });
  list.push({ x: x0, y: y0 + 14, w: lw, h: 8, label: "MATERIAL", value: f("material") });
  list.push({ x: x0, y: y0 + 6, w: lw, h: 8, label: "FINISH", value: f("finish") });
  list.push({ x: x0, y: y0, w: lw, h: 6, value: "DO NOT SCALE DRAWING", size: TEXT.label * 1.15, centre: true, bold: true });
  // Middle: who and when.
  const mx = x0 + lw;
  const mw = 44;
  list.push({ x: mx, y: y0 + 46, w: 20, h: 6, open: true });
  list.push({ x: mx + 20, y: y0 + 46, w: 14, h: 6, value: "NAME", size: TEXT.label, centre: true, bold: true });
  list.push({ x: mx + 34, y: y0 + 46, w: 10, h: 6, value: "DATE", size: TEXT.label, centre: true, bold: true });
  const who: [string, TitleField | null, TitleField | null][] = [
    ["DRAWN", "drawnBy", "date"],
    ["CHECKED", "checkedBy", "checkedDate"],
    ["ENG APPR.", "approvedBy", "approvedDate"],
    ["MFG APPR.", null, null],
  ];
  who.forEach(([role, name, date], i) => {
    const y = y0 + 40 - i * 6;
    list.push({ x: mx, y, w: 20, h: 6, value: role, size: TEXT.label * 1.05 });
    list.push({ x: mx + 20, y, w: 14, h: 6, value: name ? f(name) : "", size: TEXT.label * 1.1 });
    list.push({ x: mx + 34, y, w: 10, h: 6, value: date ? f(date) : "", size: TEXT.label * 0.95 });
  });
  list.push({ x: mx, y: y0, w: mw, h: 22, label: "COMMENTS:" });
  // Right: the company, the title, the identification.
  const rx = mx + mw;
  const rw = W - lw - mw;
  list.push({ x: rx, y: y0 + 38, w: rw, h: 14, value: f("company"), size: 5.4, bold: true, centre: true });
  list.push({ x: rx, y: y0 + 18, w: rw, h: 20, label: "TITLE:", open: false });
  list.push({ x: rx, y: y0 + 7, w: 12, h: 11, label: "SIZE", value: ctx.format.size.replace("ANSI ", ""), centre: true, bold: true });
  list.push({ x: rx + 12, y: y0 + 7, w: rw - 28, h: 11, label: "DWG. NO.", value: f("number"), size: 5.2, bold: true });
  list.push({ x: rx + rw - 16, y: y0 + 7, w: 16, h: 11, label: "REV", value: f("revision"), centre: true, bold: true });
  list.push({ x: rx, y: y0, w: 22, h: 7, value: `SCALE: ${ctx.scaleText}`, size: TEXT.label * 1.05 });
  list.push({ x: rx + 22, y: y0, w: 26, h: 7, value: `WEIGHT: ${f("mass")}`, size: TEXT.label * 1.05 });
  list.push({ x: rx + 48, y: y0, w: rw - 48, h: 7, value: `SHEET ${ctx.sheetNumber} OF ${ctx.sheetCount}`, size: TEXT.label * 1.05 });
  cells(prims, list);
  // The tolerance block's lines.
  const units = ctx.drawing.units === "in" ? "INCHES" : "MILLIMETERS";
  const tol = toleranceText(ctx.drawing);
  const lines = ["UNLESS OTHERWISE SPECIFIED:", `DIMENSIONS ARE IN ${units}`, "TOLERANCES:", ...(tol ? splitTol(tol) : ["—"])];
  lines.forEach((l, i) => text(prims, [x0 + 1.6, y0 + 52 - 3.6 - i * 3.6], fit(l, lw - 3, TEXT.label * 1.05, i === 0), TEXT.label * 1.05, "start", i === 0));
  text(prims, [x0 + 1.6, y0 + 25.2], `${ctx.projection === "third" ? "THIRD" : "FIRST"} ANGLE PROJECTION`, TEXT.label * 1.05);
  projectionSymbol(prims, [x0 + lw - projectionSymbolWidth(0.9) - 3, y0 + 26.2], ctx.projection, 0.9);
  // The title.
  const title = f("title");
  const subtitle = f("subtitle");
  const tsize = 6.4;
  text(prims, [rx + rw / 2, y0 + 18 + (subtitle ? 9 : 6.5)], fit(title, rw - 4, tsize, true), tsize, "middle", true);
  if (subtitle) text(prims, [rx + rw / 2, y0 + 20.5], fit(subtitle, rw - 4, TEXT.cell), TEXT.cell, "middle");
  const titleBlock: Box = { min: [x0, y0], max: [frame.max[0], y0 + H] };
  rect(prims, titleBlock, LINE.visible);
  // Revisions: in the top right corner, the header always there.
  const cols: [string, number, (r: NonNullable<Drawing["revisions"]>[number]) => string][] = [
    ["ZONE", 14, (r) => r.zone ?? ""],
    ["REV", 12, (r) => r.rev],
    ["DESCRIPTION", 76, (r) => r.description ?? ""],
    ["DATE", 22, (r) => r.date ?? ""],
    ["APPROVED", 24, (r) => r.approved ?? r.by ?? ""],
  ];
  const rwid = cols.reduce((a, c) => a + c[1], 0);
  const revisionBlock = revisionTable(prims, cols, ctx.drawing.revisions ?? [], frame.max[0] - rwid, frame.max[1], true, "REVISIONS");
  return { width, height, frame, titleBlock, revisionBlock, prims };
}

/** "X.X ±0.5, X.XX ±0.1, ANG ±0.5°" as lines. */
function splitTol(t: string): string[] {
  return t.split(/\s*[,;]\s*/).filter(Boolean).slice(0, 4);
}

// ------------------------------------------------------------ minimal

function minimal(ctx: FormatContext, width: number, height: number): FormatLayout {
  const prims: Prim[] = [];
  const frame: Box = { min: [10, 10], max: [width - 10, height - 10] };
  rect(prims, frame, LINE.border, "sheet");
  const f = (k: TitleField) => fieldText(ctx, k);
  const x0 = frame.max[0] - 180;
  const y0 = frame.min[1];
  const H = 14;
  cells(prims, [
    { x: x0, y: y0, w: 78, h: H, label: "TITLE", value: f("title"), size: 5.2, bold: true },
    { x: x0 + 78, y: y0, w: 42, h: H, label: "DRAWING NO.", value: f("number"), bold: true },
    { x: x0 + 120, y: y0, w: 14, h: H, label: "REV", value: f("revision"), centre: true },
    { x: x0 + 134, y: y0, w: 22, h: H, label: "SCALE", value: ctx.scaleText, centre: true },
    { x: x0 + 156, y: y0, w: 24, h: H, label: "SHEET", value: `${ctx.sheetNumber} / ${ctx.sheetCount}`, centre: true },
  ]);
  const titleBlock: Box = { min: [x0, y0], max: [frame.max[0], y0 + H] };
  rect(prims, titleBlock, LINE.visible);
  return { width, height, frame, titleBlock, prims };
}
