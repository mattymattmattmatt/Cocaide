// Geometric tolerancing on the sheet (Phase Q): feature control frames
// (ISO 1101 / ASME Y14.5: the 14 characteristics, Ø and SØ zones, Ⓜ Ⓛ Ⓟ
// Ⓕ Ⓣ Ⓢ Ⓤ, CZ, datums with their modifiers, composite and stacked frames,
// "6×" and notes above and below), datum feature symbols (a letter in a
// frame, a triangle on the surface, its dimension or its frame), datum
// targets (point, line, area) and the rules a checker applies to a frame.

import type { Annotation, DatumAnnotation, DatumTargetAnnotation, GdtAnnotation, GdtRow, Vec2 } from "../../doc/types";
import type { ComposedView } from "../compose";
import type { Box, Prim } from "../sheet";
import { glyph, GDT_CHARACTERISTICS, type GdtCharacteristic } from "../symbols/glyphs";
import { parseRich, richPrims, richWidth } from "../symbols/richtext";
import { CAP, PHANTOM_DASH } from "../text";
import { numberText } from "../tolerance";
import { add, arrowHead, dist, dot, failed, fromCentre, len, mul, perp, sub, unit, type AnnotationContext, type AnnotationLayout, type LayoutResult } from "./common";
import { findSpot } from "./placement";
import type { DraftStyle } from "./style";

/** What each characteristic is, for the rules and the property panel. */
export const CHARACTERISTIC_INFO: Record<GdtCharacteristic, { label: string; group: "form" | "orientation" | "location" | "runout" | "profile"; datums: "none" | "required" | "optional"; size: "never" | "may" | "always" }> = {
  straightness: { label: "Straightness", group: "form", datums: "none", size: "may" },
  flatness: { label: "Flatness", group: "form", datums: "none", size: "never" },
  circularity: { label: "Circularity (roundness)", group: "form", datums: "none", size: "never" },
  cylindricity: { label: "Cylindricity", group: "form", datums: "none", size: "never" },
  profileLine: { label: "Profile of a line", group: "profile", datums: "optional", size: "never" },
  profileSurface: { label: "Profile of a surface", group: "profile", datums: "optional", size: "never" },
  angularity: { label: "Angularity", group: "orientation", datums: "required", size: "may" },
  perpendicularity: { label: "Perpendicularity", group: "orientation", datums: "required", size: "may" },
  parallelism: { label: "Parallelism", group: "orientation", datums: "required", size: "may" },
  position: { label: "Position", group: "location", datums: "optional", size: "always" },
  concentricity: { label: "Concentricity (coaxiality)", group: "location", datums: "required", size: "always" },
  symmetry: { label: "Symmetry", group: "location", datums: "required", size: "always" },
  circularRunout: { label: "Circular run-out", group: "runout", datums: "required", size: "never" },
  totalRunout: { label: "Total run-out", group: "runout", datums: "required", size: "never" },
};
export { GDT_CHARACTERISTICS };

/** The tolerance compartment's text: "Ø0.1Ⓜ", "0.05/100", "0.5Ⓤ0.2", "Ø0.2ⓂⓅ25 CZ". */
export function zoneText(r: GdtRow): string {
  let s = `${r.spherical ? "SØ" : r.diameter ? "Ø" : ""}${numberText(r.tolerance)}`;
  if (r.per !== undefined) s += `/${numberText(r.per)}`;
  const mods = r.modifiers ?? [];
  if (mods.includes("U")) s += `Ⓤ${r.unequal !== undefined ? numberText(r.unequal) : ""}`;
  if (r.material) s += r.material === "M" ? "Ⓜ" : "Ⓛ";
  for (const m of mods) {
    if (m === "U") continue;
    if (m === "P") s += `Ⓟ${r.projected !== undefined ? numberText(r.projected) : ""}`;
    else if (m === "F") s += "Ⓕ";
    else if (m === "T") s += "Ⓣ";
    else if (m === "S") s += "Ⓢ";
    else if (m === "E") s += "Ⓔ";
    else if (m === "I") s += "Ⓘ";
    else s += ` ${m}`;
  }
  return s;
}

/** A frame's row as one line of text: "⌖ Ø0.1Ⓜ | A | B | C". */
export function rowText(r: GdtRow): string {
  return [r.characteristic, zoneText(r), ...(r.datums ?? []).map((d) => `${d.label}${d.modifier ? `(${d.modifier})` : ""}`)].join(" | ");
}

/** The frame drawn with its lower left corner at the origin: its primitives, width and height. */
export function framePrims(a: Pick<GdtAnnotation, "rows" | "composite" | "count" | "above" | "below">, style: DraftStyle): { prims: Prim[]; w: number; h: number; top: number; bottom: number } {
  const h = style.h;
  const H = 2 * h;
  const size = style.font;
  const pad = 0.8 * h;
  const w = style.symbol;
  const rows = a.rows;
  const composite = !!a.composite && rows.length > 1 && rows.every((r) => r.characteristic === rows[0].characteristic);
  const zone = rows.map((r) => richWidth(parseRich(zoneText(r)), size) + 2 * pad);
  const datumCells = rows.map((r) => (r.datums ?? []).map((d) => Math.max(H, richWidth(parseRich(`${d.label}${d.modifier === "M" ? "Ⓜ" : d.modifier === "L" ? "Ⓛ" : d.modifier === "S" ? "Ⓢ" : ""}`), size) + 2 * pad)));
  const zoneW = Math.max(H, ...zone);
  const maxDatums = Math.max(0, ...datumCells.map((c) => c.length));
  // Datum columns line up row to row.
  const colW = Array.from({ length: maxDatums }, (_, i) => Math.max(H, ...datumCells.map((c) => c[i] ?? 0)));
  const prims: Prim[] = [];
  const height = rows.length * H;
  const rowWidth = (r: number) => H + zoneW + colW.slice(0, datumCells[r].length).reduce((s, x) => s + x, 0);
  const W = Math.max(...rows.map((_, i) => rowWidth(i)));
  rows.forEach((r, i) => {
    const y0 = height - (i + 1) * H;
    const rw = rowWidth(i);
    // The row's box.
    prims.push({ k: "line", pts: [[0, y0], [rw, y0], [rw, y0 + H], [0, y0 + H]], closed: true, w });
    // The characteristic: one cell for a composite frame's rows together.
    if (!composite || i === 0) {
      const ch = composite ? height : H;
      const cy = composite ? 0 : y0;
      prims.push(...glyph(r.characteristic, (H - 1.25 * h) / 2, cy + (ch - h) / 2, h, { w }));
    }
    prims.push({ k: "line", pts: [[H, y0], [H, y0 + H]], w });
    const zt = parseRich(zoneText(r));
    prims.push(...richPrims(zt, [H + zoneW / 2, y0 + (H - h) / 2], { size, anchor: "middle", stroke: w }));
    let x = H + zoneW;
    prims.push({ k: "line", pts: [[x, y0], [x, y0 + H]], w });
    (r.datums ?? []).forEach((d, j) => {
      const cw = colW[j];
      const t = `${d.label}${d.modifier === "M" ? "Ⓜ" : d.modifier === "L" ? "Ⓛ" : d.modifier === "S" ? "Ⓢ" : ""}`;
      prims.push(...richPrims(parseRich(t), [x + cw / 2, y0 + (H - h) / 2], { size, anchor: "middle", stroke: w }));
      x += cw;
      if (j < (r.datums ?? []).length - 1) prims.push({ k: "line", pts: [[x, y0], [x, y0 + H]], w });
    });
  });
  if (composite) {
    // The shared symbol cell has no line between its rows: cover it by redrawing the left column as one.
    for (let i = 1; i < rows.length; i++) {
      const y = height - i * H;
      prims.push({ k: "line", pts: [[0.01, y], [H - 0.01, y]], w: w * 2.2, color: "#ffffff" });
    }
    prims.push({ k: "line", pts: [[0, 0], [0, height]], w }, { k: "line", pts: [[H, 0], [H, height]], w });
  }
  let top = height;
  let bottom = 0;
  const above = [a.count && a.count > 1 ? `${a.count}×` : "", a.above ?? ""].filter(Boolean).join(" ");
  if (above) {
    prims.push(...richPrims(parseRich(above), [0, height + 1.2], { size, stroke: w }));
    top = height + 1.2 + size * CAP;
  }
  if (a.below) {
    prims.push(...richPrims(parseRich(a.below), [0, -1.2 - size * CAP], { size, stroke: w }));
    bottom = -1.4 - size * CAP - 0.22 * size;
  }
  return { prims, w: W, h: height, top, bottom };
}

function moved(prims: Prim[], by: Vec2): Prim[] {
  const t = (p: Vec2): Vec2 => [p[0] + by[0], p[1] + by[1]];
  return prims.map((p) => (p.k === "line" ? { ...p, pts: p.pts.map(t) } : p.k === "circle" ? { ...p, c: t(p.c) } : p.k === "area" ? { ...p, loops: p.loops.map((l) => l.map(t)) } : { ...p, at: t(p.at) }));
}

/** Where a GeoRef is on the sheet for a leader's tip: an edge's nearest point to `near` (its middle by default), a circle's rim, a point. */
export function tipOf(ctx: AnnotationContext, ref: string, near?: Vec2): { tip: Vec2; normal: Vec2; kind: "edge" | "circle" | "point"; c?: Vec2; r?: number } | null {
  const g = ctx.resolve(ref);
  if (!g) return null;
  if (g.kind === "point") return { tip: g.at, normal: [Math.SQRT1_2, Math.SQRT1_2], kind: "point" };
  if (g.kind === "circle") {
    const u = near ? unit(sub(near, g.c)) : ([Math.SQRT1_2, Math.SQRT1_2] as Vec2);
    return { tip: add(g.c, mul(u, g.r)), normal: u, kind: "circle", c: g.c, r: g.r };
  }
  if (g.a && g.b) {
    const d = sub(g.b, g.a);
    const l = len(d);
    const t = near ? Math.max(0.15, Math.min(0.85, dot(sub(near, g.a), d) / (l * l))) : 0.5;
    const p = add(g.a, mul(d, t));
    let n = unit(perp(d));
    const cv = ctx.view(g.view);
    if (cv?.box) {
      const c: Vec2 = [(cv.box.min[0] + cv.box.max[0]) / 2, (cv.box.min[1] + cv.box.max[1]) / 2];
      if (dot(sub(p, c), n) < 0) n = mul(n, -1);
    }
    return { tip: p, normal: n, kind: "edge" };
  }
  const pts = g.pts.flat();
  if (!pts.length) return null;
  return { tip: pts[Math.floor(pts.length / 2)], normal: [0, 1], kind: "edge" };
}

export function layoutGdt(a: GdtAnnotation, ctx: AnnotationContext, cv: ComposedView): LayoutResult | { problem: string } {
  const style = ctx.style;
  if (!a.rows.length) return failed("a feature control frame has one or more rows");
  const f = framePrims(a, style);
  let origin: Vec2;
  const prims: Prim[] = [];
  let dim: AnnotationLayout | undefined;
  if (a.dimension) {
    dim = ctx.layouts.get(a.dimension);
    if (!dim || dim.problem) return failed(`its dimension ${a.dimension} isn't drawn${dim?.problem ? `: ${dim.problem}` : ""}`);
  }
  if (a.at) origin = add(cv.centre, a.at);
  else if (dim && a.extension === undefined && dim.under && dim.textBox) {
    // Under the dimension's text, centred on it (ISO 1101: the frame below the size it tolerances).
    const tb = dim.textBox;
    origin = [(tb.min[0] + tb.max[0]) / 2 - f.w / 2, tb.min[1] - 0.8 - f.h];
  } else {
    const target = dim && a.extension !== undefined ? extensionTip(dim, a.extension) : a.on ? tipOf(ctx, a.on)?.tip : undefined;
    if (!target) return failed(a.on ? `${a.on} is not in ${cv.id} any more` : "a frame is on a feature (on), a dimension (dimension), or placed (at)");
    const shape = (knee: Vec2, dir: 1 | -1): Box => (dir > 0 ? { min: [knee[0], knee[1] - f.h / 2 + f.bottom], max: [knee[0] + f.w, knee[1] + f.h / 2 + (f.top - f.h)] } : { min: [knee[0] - f.w, knee[1] - f.h / 2 + f.bottom], max: [knee[0], knee[1] + f.h / 2 + (f.top - f.h)] });
    const s = findSpot(ctx.occ, { tip: target, viewBox: cv.box, shape, owner: a.id, prefer: [0.8, 0.6], rings: [8, 13, 20, 28] });
    const knee = s?.knee ?? add(target, [10, 10]);
    const dir = s?.dir ?? 1;
    origin = dir > 0 ? [knee[0], knee[1] - f.h / 2] : [knee[0] - f.w, knee[1] - f.h / 2];
  }
  prims.push(...moved(f.prims, origin));
  // The leader: from the frame's nearer end, its middle, to the feature.
  const leaderTo = dim && a.extension !== undefined ? extensionTip(dim, a.extension) : !dim && a.on ? tipOf(ctx, a.on, add(origin, [f.w / 2, f.h / 2])) : null;
  if (leaderTo) {
    const tip = "tip" in (leaderTo as object) ? (leaderTo as { tip: Vec2 }).tip : (leaderTo as Vec2);
    const left: Vec2 = [origin[0], origin[1] + f.h - style.h];
    const right: Vec2 = [origin[0] + f.w, origin[1] + f.h - style.h];
    const from = dist(left, tip) <= dist(right, tip) ? left : right;
    const knee: Vec2 = [from[0] + (from === left ? -3 : 3), from[1]];
    const pts = Math.abs(tip[1] - from[1]) < 0.5 ? [from, tip] : [from, knee, tip];
    prims.push({ k: "line", pts, w: style.thin }, ...arrowHead(tip, sub(tip, pts[pts.length - 2]), style, a.arrow ?? "closed"));
  }
  const box: Box = { min: [origin[0], origin[1] + f.bottom], max: [origin[0] + f.w, origin[1] + f.top] };
  const text = a.rows.map(rowText).join(" / ");
  return { prims, textBox: box, text, at: origin, grips: [{ name: "frame", at: [origin[0], origin[1]], field: "at" }], place: { pts: [fromCentre(cv, origin)], text } };
}

/** How far a datum may slide along its edge from where it stands (to stay on the surface). */
function edgeReach(ctx: AnnotationContext, ref: string, base: Vec2, along: Vec2): number {
  const g = ctx.resolve(ref);
  if (!g || g.kind !== "edge" || !g.a || !g.b) return 4;
  const ta = dot(sub(g.a, base), along);
  const tb = dot(sub(g.b, base), along);
  return Math.max(2, Math.min(Math.abs(ta), Math.abs(tb)) * 0.8);
}

/** A point on a dimension's extension line (its middle), for a frame or a datum on it. */
function extensionTip(dim: AnnotationLayout, i: 0 | 1): Vec2 | undefined {
  const e = dim.extensions?.[i] ?? dim.extensions?.[0];
  return e ? mul(add(e[0], e[1]), 0.5) : undefined;
}

/**
 * A datum feature symbol: the letter in a square frame, a stem, and a
 * triangle (filled; open on request) standing on the surface, on the
 * dimension line's end (a feature of size), or under a frame.
 */
export function layoutDatum(a: DatumAnnotation, ctx: AnnotationContext, cv: ComposedView): LayoutResult | { problem: string } {
  const style = ctx.style;
  const H = 2 * style.h;
  const tri = 0.55 * H;
  let base: Vec2;
  let n: Vec2;
  if (a.gdt) {
    const g = ctx.layouts.get(a.gdt);
    if (!g?.textBox) return failed(`its frame ${a.gdt} isn't drawn`);
    base = [g.textBox.min[0] + H / 2, g.textBox.min[1]];
    n = [0, -1];
  } else if (a.dimension) {
    const d = ctx.layouts.get(a.dimension);
    if (!d?.line || d.problem) return failed(`its dimension ${a.dimension} isn't drawn`);
    // On the dimension line's first end, in line with it.
    const [p, q] = d.line;
    const u = unit(sub(p, q));
    base = add(p, mul(u, style.arrow.length * 0.2));
    n = u;
  } else if (a.on) {
    const t = tipOf(ctx, a.on, a.at ? add(cv.centre, a.at) : undefined);
    if (!t) return failed(`${a.on} is not in ${cv.id} any more`);
    base = t.tip;
    n = t.normal;
  } else return failed("a datum is on a surface (on), a dimension (dimension) or a frame (gdt)");
  const stem = Math.max(4, a.at ? dot(sub(add(cv.centre, a.at), base), n) - H / 2 : 5 + tri);
  let boxC = add(base, mul(n, tri + stem + H / 2 - tri));
  if (a.at && !a.gdt && !a.dimension) {
    boxC = add(cv.centre, a.at);
  } else if (!a.at) {
    // Slide along the surface (within its middle) and out to a free place: nothing over it, its stem crossing as little as can be.
    const along = perp(n);
    const reach = a.on ? edgeReach(ctx, a.on, base, along) : 6;
    let best: { c: Vec2; base: Vec2; cost: number } | null = null;
    for (const out of [stem, stem + 4, stem + 9, stem + 15]) {
      for (let k = 0; k <= 12; k++) {
        const t = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (reach / 6);
        const b0 = add(base, mul(along, t));
        const c = add(b0, mul(n, tri + out));
        const b: Box = { min: [c[0] - H / 2 - 0.5, c[1] - H / 2 - 0.5], max: [c[0] + H / 2 + 0.5, c[1] + H / 2 + 0.5] };
        if (!ctx.occ.inFrame(b)) continue;
        let cost = ctx.occ.overlap(b, { ignore: [a.id], kinds: ["text", "symbol", "balloon", "label", "table", "title"] }) * 50;
        cost += ctx.occ.overlap(b, { views: true, kinds: ["view"], ignore: [a.id] }) * 2;
        cost += ctx.occ.linesThrough(b, [a.id]) * 8 + ctx.occ.crossings(b0, c, [a.id]) * 6 + ctx.occ.textCrossed(b0, c, [a.id]) * 60 + Math.abs(t) * 0.3 + (out - stem) * 0.5;
        if (!best || cost < best.cost) best = { c, base: b0, cost };
      }
    }
    if (best) {
      boxC = best.c;
      base = best.base;
    }
  }
  const prims: Prim[] = [];
  const side = perp(n);
  const t0 = add(base, mul(side, tri / 1.15));
  const t1 = sub(base, mul(side, tri / 1.15));
  const apex = add(base, mul(n, tri));
  prims.push({ k: "line", pts: [t0, t1, apex], closed: true, w: style.thin, ...(a.open ? {} : { fill: true }) });
  // The stem to the frame's nearest side.
  const frameEdge = add(boxC, mul(n, -H / 2));
  prims.push({ k: "line", pts: [apex, Math.abs(n[0]) > 0.7 || Math.abs(n[1]) > 0.7 ? frameEdge : sub(boxC, mul(unit(sub(boxC, apex)), H / 2))], w: style.thin });
  const box: Box = { min: [boxC[0] - H / 2, boxC[1] - H / 2], max: [boxC[0] + H / 2, boxC[1] + H / 2] };
  prims.push({ k: "line", pts: [box.min, [box.max[0], box.min[1]], box.max, [box.min[0], box.max[1]]], closed: true, w: style.symbol });
  prims.push(...richPrims(parseRich(a.label), [boxC[0], boxC[1] - style.h / 2], { size: style.font, anchor: "middle", stroke: style.symbol }));
  return { prims, textBox: box, text: `datum ${a.label}`, at: boxC, grips: [{ name: "frame", at: boxC, field: "at" }], place: { pts: [fromCentre(cv, base), fromCentre(cv, boxC)], text: a.label } };
}

/** A datum target: its symbol (a circle split across: size over label), a leader, and the target on the part (×, a phantom line, a hatched area). */
export function layoutDatumTarget(a: DatumTargetAnnotation, ctx: AnnotationContext, cv: ComposedView): LayoutResult | { problem: string } {
  const style = ctx.style;
  const t = tipOf(ctx, a.on);
  if (!t) return failed(`${a.on} is not in ${cv.id} any more`);
  const D = 2.6 * 2 * style.h * 0.75;
  const prims: Prim[] = [];
  const p = t.kind === "circle" && t.c ? t.c : t.tip;
  const x = 1.5;
  if (a.target === "point") {
    prims.push({ k: "line", pts: [add(p, [-x, -x]), add(p, [x, x])], w: style.symbol }, { k: "line", pts: [add(p, [-x, x]), add(p, [x, -x])], w: style.symbol });
  } else if (a.target === "line") {
    const l = (a.length ?? 20) * cv.scale;
    const u = perp(t.normal);
    prims.push({ k: "line", pts: [sub(p, mul(u, l / 2)), add(p, mul(u, l / 2))], w: style.symbol, dash: PHANTOM_DASH });
    prims.push({ k: "line", pts: [add(p, [-x, -x]), add(p, [x, x])], w: style.symbol }, { k: "line", pts: [add(p, [-x, x]), add(p, [x, -x])], w: style.symbol });
  } else {
    const size = a.size ?? 6;
    if (Array.isArray(size)) {
      const [w, h] = size.map((s) => (s * cv.scale) / 2);
      prims.push({ k: "line", pts: [add(p, [-w, -h]), add(p, [w, -h]), add(p, [w, h]), add(p, [-w, h])], closed: true, w: style.thin, dash: PHANTOM_DASH });
      for (let k = -w - h; k < w + h; k += 1.2) {
        const a0: Vec2 = [Math.max(-w, k - h), 0];
        a0[1] = a0[0] - k;
        const b0: Vec2 = [Math.min(w, k + h), 0];
        b0[1] = b0[0] - k;
        if (b0[0] - a0[0] > 0.1) prims.push({ k: "line", pts: [add(p, a0), add(p, b0)], w: style.thin * 0.7 });
      }
    } else {
      const r = (size * cv.scale) / 2;
      prims.push({ k: "circle", c: p, r, w: style.thin, dash: PHANTOM_DASH });
      for (let k = -r + 0.8; k < r; k += 1.2) {
        const hw = Math.sqrt(Math.max(0, r * r - k * k));
        // 45° hatch inside the circle, as chords.
        const c0 = add(p, [(k - hw) * Math.SQRT1_2 + 0, 0]);
        void c0;
        const u: Vec2 = [Math.SQRT1_2, Math.SQRT1_2];
        const v: Vec2 = [-Math.SQRT1_2, Math.SQRT1_2];
        prims.push({ k: "line", pts: [add(p, add(mul(v, k), mul(u, -hw))), add(p, add(mul(v, k), mul(u, hw)))], w: style.thin * 0.7 });
      }
    }
  }
  // The symbol, out from the part, with a leader to the target.
  let c: Vec2;
  if (a.at) c = add(cv.centre, a.at);
  else {
    const s = findSpot(ctx.occ, { tip: p, viewBox: cv.box, shape: (k) => ({ min: [k[0] - D / 2, k[1] - D / 2], max: [k[0] + D / 2, k[1] + D / 2] }), owner: a.id, rings: [D / 2 + 6, D / 2 + 12, D / 2 + 20], slanted: true });
    c = s?.knee ?? add(p, mul(t.normal, D));
  }
  const u = unit(sub(p, c));
  prims.push({ k: "line", pts: [add(c, mul(u, D / 2)), p], w: style.thin });
  prims.push({ k: "circle", c, r: D / 2, w: style.thin });
  prims.push({ k: "line", pts: [[c[0] - D / 2, c[1]], [c[0] + D / 2, c[1]]], w: style.thin });
  const small = style.small;
  const sizeT = a.target === "area" && a.size !== undefined ? (Array.isArray(a.size) ? `${numberText(a.size[0])}×${numberText(a.size[1])}` : `Ø${numberText(a.size)}`) : "";
  if (sizeT) prims.push(...richPrims(parseRich(sizeT), [c[0], c[1] + D / 4 - (small * CAP) / 2], { size: small, anchor: "middle" }));
  prims.push(...richPrims(parseRich(a.label), [c[0], c[1] - D / 4 - (small * CAP) / 2], { size: small, anchor: "middle" }));
  const box: Box = { min: [c[0] - D / 2, c[1] - D / 2], max: [c[0] + D / 2, c[1] + D / 2] };
  return { prims, textBox: box, text: `datum target ${a.label}${sizeT ? ` ${sizeT}` : ""}`, at: c, grips: [{ name: "symbol", at: c, field: "at" }] };
}

/**
 * What a checker would say about a frame: a form tolerance takes no datum,
 * an orientation, run-out, concentricity or symmetry tolerance needs one,
 * position and concentricity are for features of size, Ⓜ and Ⓛ only on a
 * feature of size, Ø only on an axis's zone, its datums on the drawing, each
 * once. Empty when it is good.
 */
export function gdtProblems(a: GdtAnnotation, ctx: { datums: Set<string>; standard: "ISO" | "ASME"; sizeFeature?: boolean }): string[] {
  const out: string[] = [];
  a.rows.forEach((r, i) => {
    const info = CHARACTERISTIC_INFO[r.characteristic];
    if (!info) return;
    const at = a.rows.length > 1 ? `row ${i + 1}: ` : "";
    const datums = r.datums ?? [];
    if (info.datums === "none" && datums.length) out.push(`${at}${info.label.toLowerCase()} is a form tolerance: it takes no datum (leave out ${datums.map((d) => d.label).join(", ")})`);
    if (info.datums === "required" && !datums.length) out.push(`${at}${info.label.toLowerCase()} needs a datum to be ${info.group === "runout" ? "measured about" : "related to"}`);
    if (r.characteristic === "position" && !datums.length && a.rows.length === 1) out.push(`${at}position without datums locates the features only to each other: add the datums it is measured from`);
    if (info.size === "always" && ctx.sizeFeature === false) out.push(`${at}${info.label.toLowerCase()} is for a feature of size (a hole, a pin, a slot): attach it to the size's dimension or the circle`);
    if (r.material && info.size === "never") out.push(`${at}Ⓜ and Ⓛ apply to features of size only: not to ${info.label.toLowerCase()}`);
    if (r.material && ctx.sizeFeature === false) out.push(`${at}Ⓜ and Ⓛ apply to features of size: this frame is on a surface`);
    if (r.diameter && !["position", "straightness", "concentricity", "perpendicularity", "parallelism", "angularity"].includes(r.characteristic)) out.push(`${at}a Ø zone is for an axis (position, straightness of an axis, orientation of an axis): not ${info.label.toLowerCase()}`);
    if (ctx.standard === "ASME" && (r.characteristic === "concentricity" || r.characteristic === "symmetry")) out.push(`${at}ASME Y14.5-2018 has no ${r.characteristic}: use position (or profile) instead`);
    if (!(r.tolerance > 0)) out.push(`${at}its tolerance must be more than 0`);
    const seen = new Set<string>();
    for (const d of datums) {
      for (const part of d.label.split("-")) {
        if (!ctx.datums.has(part)) out.push(`${at}datum ${part} is not on the drawing: add its datum feature symbol`);
      }
      if (seen.has(d.label)) out.push(`${at}datum ${d.label} is named twice`);
      seen.add(d.label);
      if (d.modifier && (r.characteristic === "circularRunout" || r.characteristic === "totalRunout")) out.push(`${at}run-out's datums take no material modifier`);
    }
  });
  return out;
}

/** The datum letters a drawing's annotations set up. */
export function datumLabels(annotations: Iterable<Annotation>): Set<string> {
  const out = new Set<string>();
  for (const a of annotations) {
    if (a.type === "datum") out.add(a.label);
    if (a.type === "datumTarget") out.add(a.label.replace(/\d+$/, ""));
  }
  return out;
}
