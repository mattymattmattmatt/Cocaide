// Notes and free drawing on the sheet (Phase Q): rich text with linked
// properties read live ($PRP, $PRPMODEL, $PRPSHEET), leaders (straight,
// bent, splines, several, with closed, open, dot or no arrowheads), the
// numbered general notes block ("NOTES: 1. Break all sharp edges ..."),
// framed notes, single texts, leaders, lines, sketching (lines, arcs,
// circles, rectangles, polylines, text) and revision clouds with their
// revision's triangle.

import type { Leader, LeaderAnnotation, LineAnnotation, NoteAnnotation, RevisionCloudAnnotation, SketchAnnotation, SketchLine, TextAnnotation, Vec2 } from "../../doc/types";
import type { ComposedView } from "../compose";
import { resolveProps } from "../props";
import { boxOf, type Box, type Prim } from "../sheet";
import { parseRich, plainText, richBlock, richWidth } from "../symbols/richtext";
import { CAP, CENTER_DASH, HIDDEN_DASH, LINE, PHANTOM_DASH } from "../text";
import { add, dist, failed, fontFor, leaderPrims, sub, toSheetAt, type AnnotationContext, type LayoutResult } from "./common";
import { tipOf } from "./gdt";
import { findSpot } from "./placement";

function lineStyle(l: SketchLine | undefined): { w: number; dash?: number[] } {
  switch (l) {
    case "thick":
      return { w: LINE.visible };
    case "center":
      return { w: LINE.thin, dash: CENTER_DASH };
    case "hidden":
      return { w: LINE.thin, dash: HIDDEN_DASH };
    case "phantom":
      return { w: LINE.thin, dash: PHANTOM_DASH };
    default:
      return { w: LINE.thin };
  }
}

/** A leader's tip on the sheet: a GeoRef's place, or a point (from the view's centre, or the sheet's corner). */
function leaderTip(ctx: AnnotationContext, cv: ComposedView | undefined, to: Leader["to"], from: Vec2): Vec2 | null {
  if (typeof to === "string") return tipOf(ctx, to, from)?.tip ?? null;
  return toSheetAt(cv, to);
}

/** A note: its lines (numbered under a title for general notes), its leaders from the nearer side of its text. */
export function layoutNote(a: NoteAnnotation, ctx: AnnotationContext): LayoutResult | { problem: string } {
  const cv = a.view ? ctx.view(a.view) : undefined;
  if (a.view && !cv) return failed(`its view ${a.view} is not on the sheet`);
  const style = ctx.style;
  const size = a.height !== undefined ? fontFor(a.height) : style.classic ? 4.2 : style.note;
  const resolved = resolveProps(a.text, ctx.data.props);
  let lines = resolved.split("\n");
  if (a.numbered) {
    let n = 0;
    lines = lines.map((l) => (l.trim() ? `${++n}. ${l.replace(/^\s*\d+[.)]\s*/, "")}` : l));
  }
  const at = toSheetAt(cv, a.at);
  const prims: Prim[] = [];
  let y = at[1];
  let box: Box | null = null;
  const wrap = (t: string) => `${a.bold ? "**" : ""}${a.italic ? "*" : ""}${a.underline ? "__" : ""}${t}${a.underline ? "__" : ""}${a.italic ? "*" : ""}${a.bold ? "**" : ""}`;
  if (a.title) {
    const b = richBlock(wrap(`**${a.title}**`), [at[0], y], { size: size * 1.1, angle: a.angle ?? 0 });
    prims.push(...b.prims);
    y -= size * 1.1 * 1.6;
  }
  const indent = a.numbered ? richWidth(parseRich("10. "), size) : 0;
  lines.forEach((l) => {
    const m = a.numbered ? /^(\d+\. )(.*)$/.exec(l) : null;
    if (m) {
      prims.push(...richBlock(m[1], [at[0], y], { size, angle: a.angle ?? 0 }).prims);
      prims.push(...richBlock(wrap(m[2]), [at[0] + indent, y], { size, angle: a.angle ?? 0 }).prims);
    } else prims.push(...richBlock(wrap(l), [at[0] + (a.numbered ? indent : 0), y], { size, angle: a.angle ?? 0 }).prims);
    y -= size * 1.4;
  });
  box = boxOf(prims.flatMap((p) => (p.k === "text" ? [p.at, [p.at[0] + 0.1, p.at[1] + size * CAP]] : p.k === "line" ? p.pts : p.k === "circle" ? [p.c] : [])));
  // Text width: the box above holds only starts; measure each line.
  const width = Math.max(a.title ? richWidth(parseRich(`**${a.title}**`), size * 1.1) : 0, ...lines.map((l) => richWidth(parseRich(l), size) + (a.numbered ? indent : 0)));
  const top = at[1] + size * CAP + (a.title ? 0 : 0);
  const bottom = y + size * 1.4 - 0.25 * size;
  box = { min: [at[0], Math.min(bottom, box?.min[1] ?? bottom)], max: [at[0] + width, top] };
  if (a.frame) {
    const b = { min: [box.min[0] - 1.5, box.min[1] - 1.5] as Vec2, max: [box.max[0] + 1.5, box.max[1] + 1.5] as Vec2 };
    prims.push({ k: "line", pts: [b.min, [b.max[0], b.min[1]], b.max, [b.min[0], b.max[1]]], closed: true, w: style.thin });
    box = b;
  }
  for (const l of a.leaders ?? []) {
    const tip = leaderTip(ctx, cv, l.to, [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2]);
    if (!tip) return failed(`its leader's ${typeof l.to === "string" ? l.to : "point"} is not on the sheet`);
    const via = (l.via ?? []).map((p) => toSheetAt(cv, p));
    const next = via[0] ?? tip;
    const left = next[0] < (box.min[0] + box.max[0]) / 2;
    const firstLine = at[1] + (size * CAP) / 2;
    const from: Vec2 = [left ? box.min[0] - 1 : box.max[0] + 1, firstLine];
    const landing: Vec2 = [from[0] + (left ? -2.5 : 2.5), from[1]];
    prims.push(...leaderPrims(from, [landing, ...via], tip, style, l.arrow ?? "closed", l.spline));
  }
  return { prims, textBox: box, text: plainText(resolved), at, grips: [{ name: "text", at, field: "at" }] };
}

export function layoutText(a: TextAnnotation, ctx: AnnotationContext): LayoutResult | { problem: string } {
  const cv = a.view ? ctx.view(a.view) : undefined;
  const size = a.height !== undefined ? fontFor(a.height) : ctx.style.font;
  const at = toSheetAt(cv, a.at);
  const t = resolveProps(a.text, ctx.data.props);
  const b = richBlock(a.bold ? `**${t}**` : t, at, { size, angle: a.angle ?? 0, anchor: a.anchor ?? "start" });
  const w = b.width;
  const x0 = a.anchor === "middle" ? at[0] - w / 2 : a.anchor === "end" ? at[0] - w : at[0];
  return { prims: b.prims, textBox: { min: [x0, at[1] - 0.25 * size - (b.lines - 1) * 1.5 * size], max: [x0 + w, at[1] + size * CAP] }, text: plainText(t), at, grips: [{ name: "text", at, field: "at" }] };
}

export function layoutLeader(a: LeaderAnnotation, ctx: AnnotationContext): LayoutResult | { problem: string } {
  const cv = a.view ? ctx.view(a.view) : undefined;
  const style = ctx.style;
  let at: Vec2;
  let tip: Vec2 | null;
  if (a.at) {
    at = toSheetAt(cv, a.at);
    tip = leaderTip(ctx, cv, a.to, at);
  } else {
    // Not placed: out of its view near what it points at, its text clear of everything.
    tip = leaderTip(ctx, cv, a.to, cv ? cv.centre : [0, 0]);
    const w = a.text ? richWidth(parseRich(resolveProps(a.text, ctx.data.props)), style.font) + 2 : 2;
    const s = tip ? findSpot(ctx.occ, { tip, viewBox: cv?.box ?? null, shape: (k, d) => (d > 0 ? { min: [k[0], k[1] - style.font], max: [k[0] + w, k[1] + style.font * CAP] } : { min: [k[0] - w, k[1] - style.font], max: [k[0], k[1] + style.font * CAP] }), owner: a.id, rings: [6, 10, 16] }) : null;
    at = s?.knee ?? (tip ? add(tip, [8, 8]) : [0, 0]);
  }
  if (!tip) return failed(`${typeof a.to === "string" ? a.to : "its point"} is not on the sheet`);
  const prims: Prim[] = [];
  let textBox: Box | undefined;
  const via = (a.via ?? []).map((p) => toSheetAt(cv, p));
  if (a.text) {
    const size = style.font;
    const right = (via[0] ?? tip)[0] < at[0];
    const t = resolveProps(a.text, ctx.data.props);
    const w = richWidth(parseRich(t), size);
    const b = richBlock(t, [right ? at[0] + 1 : at[0] - 1, at[1] - (size * CAP) / 2], { size, anchor: right ? "start" : "end" });
    prims.push(...b.prims);
    textBox = { min: [right ? at[0] : at[0] - w - 1, at[1] - size], max: [right ? at[0] + w + 1 : at[0], at[1] + size * CAP] };
  }
  prims.push(...leaderPrims(at, via, tip, style, a.arrow ?? "closed", a.spline));
  return { prims, ...(textBox ? { textBox } : {}), text: a.text ? plainText(a.text) : "leader", at, grips: [{ name: "text", at, field: "at" }, ...via.map((v, i) => ({ name: "vertex" as const, at: v, field: "via" as const, index: i }))] };
}

export function layoutLine(a: LineAnnotation, ctx: AnnotationContext): LayoutResult | { problem: string } {
  const cv = a.view ? ctx.view(a.view) : undefined;
  const [p, q] = a.pts.map((x) => toSheetAt(cv, x));
  if (dist(p, q) < 1e-6) return failed("its two ends are the same place");
  return { prims: [{ k: "line", pts: [p, q], ...lineStyle(a.line) }], text: "line", at: p, grips: [0, 1].map((i) => ({ name: "end" as const, at: i ? q : p, field: "pts" as const, index: i })) };
}

export function layoutSketch(a: SketchAnnotation, ctx: AnnotationContext): LayoutResult | { problem: string } {
  const cv = a.view ? ctx.view(a.view) : undefined;
  const T = (p: Vec2) => toSheetAt(cv, p);
  const prims: Prim[] = [];
  for (const it of a.items) {
    if (it.kind === "text") {
      prims.push(...richBlock(resolveProps(it.text, ctx.data.props), T(it.at), { size: it.height !== undefined ? fontFor(it.height) : ctx.style.font, angle: it.angle ?? 0 }).prims);
      continue;
    }
    const st = lineStyle(it.line);
    if (it.kind === "line") prims.push({ k: "line", pts: [T(it.a), T(it.b)], ...st });
    else if (it.kind === "circle") prims.push({ k: "circle", c: T(it.c), r: it.r, ...st });
    else if (it.kind === "rect") {
      const [a0, b0] = [T(it.a), T(it.b)];
      prims.push({ k: "line", pts: [a0, [b0[0], a0[1]], b0, [a0[0], b0[1]]], closed: true, ...st });
    } else if (it.kind === "polyline") prims.push({ k: "line", pts: it.pts.map(T), ...(it.closed ? { closed: true } : {}), ...st });
    else {
      const c = T(it.c);
      let span = it.end - it.start;
      if (span <= 0) span += 360;
      const n = Math.max(8, Math.ceil(span / 6));
      prims.push({ k: "line", pts: Array.from({ length: n + 1 }, (_, i) => { const t = ((it.start + (span * i) / n) * Math.PI) / 180; return [c[0] + it.r * Math.cos(t), c[1] + it.r * Math.sin(t)] as Vec2; }), ...st });
    }
  }
  return { prims, text: `sketch, ${a.items.length} item${a.items.length === 1 ? "" : "s"}`, grips: [] };
}

/** A revision cloud: arcs bulging out along its outline, and its revision's letter in a triangle by it. */
export function layoutRevisionCloud(a: RevisionCloudAnnotation, ctx: AnnotationContext): LayoutResult | { problem: string } {
  const cv = a.view ? ctx.view(a.view) : undefined;
  const pts = a.pts.map((p) => toSheetAt(cv, p));
  if (pts.length < 3) return failed("a revision cloud's outline has three or more points");
  const arc = a.arc ?? 6;
  // Counter-clockwise, so the arcs bulge out (to the right of each edge's direction).
  let area = 0;
  for (let i = 0; i < pts.length; i++) area += pts[i][0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * pts[i][1];
  const loop = area < 0 ? [...pts].reverse() : pts;
  const out: Vec2[] = [];
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i];
    const q = loop[(i + 1) % loop.length];
    const l = dist(p, q);
    const n = Math.max(1, Math.round(l / arc));
    for (let k = 0; k < n; k++) {
      const s0 = add(p, [((q[0] - p[0]) * k) / n, ((q[1] - p[1]) * k) / n]);
      const s1 = add(p, [((q[0] - p[0]) * (k + 1)) / n, ((q[1] - p[1]) * (k + 1)) / n]);
      const mid: Vec2 = [(s0[0] + s1[0]) / 2, (s0[1] + s1[1]) / 2];
      const d = sub(s1, s0);
      const r = Math.hypot(d[0], d[1]) / 2;
      const nOut: Vec2 = [d[1] / (2 * r), -d[0] / (2 * r)];
      for (let j = 0; j <= 8; j++) {
        const t = Math.PI * (j / 8);
        // A half circle from s0 to s1, bulging outward.
        out.push([mid[0] - (d[0] / 2) * Math.cos(t) + nOut[0] * r * Math.sin(t), mid[1] - (d[1] / 2) * Math.cos(t) + nOut[1] * r * Math.sin(t)]);
      }
    }
  }
  const prims: Prim[] = [{ k: "line", pts: out, closed: true, w: LINE.visible * 0.7 }];
  if (a.rev) {
    const b = boxOf(pts)!;
    const c = a.at ? toSheetAt(cv, a.at) : ([b.max[0] + 4, b.max[1] + 4] as Vec2);
    const s = 7;
    prims.push({ k: "line", pts: [[c[0] - s / 2, c[1] - s * 0.29], [c[0] + s / 2, c[1] - s * 0.29], [c[0], c[1] + s * 0.58]], closed: true, w: LINE.thin });
    prims.push({ k: "text", at: [c[0], c[1] - s * 0.22], text: a.rev, size: ctx.style.note, anchor: "middle" });
  }
  return { prims, text: `revision cloud${a.rev ? ` ${a.rev}` : ""}`, grips: pts.map((p, i) => ({ name: "vertex" as const, at: p, field: "pts" as const, index: i })) };
}
