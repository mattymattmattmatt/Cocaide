// The annotation engine (Phase Q wave Q2A): lays every annotation of a
// sheet out, one module per kind, in an order that lets each keep clear of
// what came before it (centre marks, then dimensions row by row, callouts,
// frames and datums on them, symbols, balloons, notes), and draws one whose
// target is gone where it was last, in the warning colour.
//
//   layoutAnnotation(a, ctx)   one annotation → AnnotationLayout
//   layoutSheetAnnotations(…)  all of a sheet's, in order, filling the occupancy
//
// See ./picks for creating annotations from picks and dragging their grips,
// ./schema for their property panels.

import type { Annotation, DimensionAnnotation, Vec2 } from "../../doc/types";
import type { Prim } from "../sheet";
import { primBox, union, type Box } from "../sheet";
import { textWidth } from "../text";
import { layoutBalloon } from "./balloon";
import { layoutCenterline, layoutCenterMark } from "./centers";
import { coloured, hungBox, type AnnotationContext, type AnnotationLayout, type LayoutResult } from "./common";
import { layoutDimension, type Measure } from "./dimension";
import { framePrims, layoutDatum, layoutDatumTarget, layoutGdt } from "./gdt";
import { layoutHole, layoutThread } from "./hole";
import { layoutLeader, layoutLine, layoutNote, layoutRevisionCloud, layoutSketch, layoutText } from "./notes";
import { layoutSurface } from "./surface";
import { layoutWeld } from "./weld";

export * from "./common";
export * from "./style";
export * from "./placement";
export * from "./dimension";
export * from "./hole";
export * from "./gdt";
export * from "./surface";
export * from "./weld";
export * from "./balloon";
export * from "./notes";
export * from "./centers";

/** The colour a dangling annotation is drawn in (its target gone): at its last place, never deleted. */
export const DANGLING = "#c0392b";

/** The order kinds are laid out in: each keeps clear of the ones before. */
const ORDER: Annotation["type"][] = ["centerMark", "centerline", "dimension", "hole", "cosmeticThread", "gdt", "datum", "datumTarget", "surface", "weld", "balloon", "note", "leader", "text", "line", "sketch", "revisionCloud", "table"];

/** One annotation on the sheet. `measure` is a dimension's, measured before the views were placed. */
export function layoutAnnotation(a: Annotation, ctx: AnnotationContext, measure?: Measure | { problem: string }): AnnotationLayout {
  const base = { id: a.id, type: a.type, ...("view" in a && a.view ? { view: a.view } : {}) };
  const r = run(a, ctx, measure);
  if ("problem" in r && !("prims" in r)) {
    const cv = "view" in a && a.view ? ctx.view(a.view) : undefined;
    const last = (a as { last?: { pts: Vec2[]; text: string } }).last;
    if (cv && last && last.pts.length) {
      // Where it was, in the warning colour: the user sees what lost its target.
      const pts = last.pts.map((p) => [cv.centre[0] + p[0], cv.centre[1] + p[1]] as Vec2);
      const prims: Prim[] = [];
      if (a.type === "dimension" && pts.length >= 4) {
        prims.push({ k: "line", pts: [pts[0], pts[2]], w: ctx.style.thin }, { k: "line", pts: [pts[1], pts[3]], w: ctx.style.thin }, { k: "line", pts: [pts[2], pts[3]], w: ctx.style.thin });
      } else prims.push({ k: "line", pts, w: ctx.style.thin });
      const mid = pts.length >= 4 ? ([(pts[2][0] + pts[3][0]) / 2, (pts[2][1] + pts[3][1]) / 2 + 1] as Vec2) : pts[pts.length - 1];
      prims.push({ k: "text", at: mid, text: last.text, size: ctx.style.font, anchor: "middle" });
      const red = coloured(prims, DANGLING);
      return { ...base, prims: red, box: boxOfPrims(red), text: last.text, grips: [], problem: r.problem, dangling: true };
    }
    return { ...base, prims: [], box: null, text: "", grips: [], problem: r.problem };
  }
  const res = r as LayoutResult;
  return { ...base, ...res, box: res.box ?? boxOfPrims(res.prims), grips: res.grips ?? [] };
}

function run(a: Annotation, ctx: AnnotationContext, measure?: Measure | { problem: string }): LayoutResult | { problem: string } {
  if (a.type === "note") return layoutNote(a, ctx);
  if (a.type === "text") return layoutText(a, ctx);
  if (a.type === "leader") return layoutLeader(a, ctx);
  if (a.type === "line") return layoutLine(a, ctx);
  if (a.type === "sketch") return layoutSketch(a, ctx);
  if (a.type === "revisionCloud") return layoutRevisionCloud(a, ctx);
  if (a.type === "table") return { problem: "tables are laid out by the sheet" };
  if (a.type === "surface" && (a.general || !a.view)) return layoutSurface(a, ctx, undefined);
  const cv = ctx.view(a.view!);
  if (!cv || !cv.outline || !cv.box) return { problem: `its view ${a.view} shows nothing` };
  switch (a.type) {
    case "dimension":
      if (!measure) return { problem: "not measured" };
      return "problem" in measure ? measure : layoutDimension(a as DimensionAnnotation, ctx, cv, measure);
    case "hole":
      return layoutHole(a, ctx, cv);
    case "cosmeticThread":
      return layoutThread(a, ctx, cv);
    case "gdt":
      return layoutGdt(a, ctx, cv);
    case "datum":
      return layoutDatum(a, ctx, cv);
    case "datumTarget":
      return layoutDatumTarget(a, ctx, cv);
    case "surface":
      return layoutSurface(a, ctx, cv);
    case "weld":
      return layoutWeld(a, ctx, cv);
    case "balloon":
      return layoutBalloon(a, ctx, cv);
    case "centerMark":
      return layoutCenterMark(a, ctx, cv);
    case "centerline":
      return layoutCenterline(a, ctx, cv);
  }
}

export function boxOfPrims(prims: Prim[]): Box | null {
  return prims.reduce<Box | null>((acc, p) => union(acc, primBox(p, textWidth)), null);
}

/**
 * Lays out a sheet's annotations in order, each adding what it drew to the
 * occupancy so the next keeps clear of it. Dimensions go nearest row first.
 */
export function layoutSheetAnnotations(annotations: Annotation[], ctx: AnnotationContext, measures: Map<string, Measure | { problem: string }>): Map<string, AnnotationLayout> {
  const rank = (a: Annotation) => {
    const i = ORDER.indexOf(a.type);
    const row = a.type === "dimension" ? (ctx.row(a.id)?.row ?? 0) : 0;
    // A dimension a frame or datum rides on comes before them anyway (dimensions are before frames). A datum fixed
    // to a dimension's line comes before one that finds its own place on a surface, which then keeps clear of it.
    const free = a.type === "datum" && !a.dimension && !a.gdt ? 1 : 0;
    return i * 1000 + row + free;
  };
  const sorted = annotations.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i);
  // Frames that hang under their host's text: the host is placed where they fit, and their room is kept for them.
  const hung = new Map<string, { w: number; h: number; top: number; bottom: number; ids: string[] }>();
  for (const a of annotations) {
    if (a.type !== "gdt" || !a.dimension || a.at || a.extension !== undefined || a.hidden || hung.has(a.dimension)) continue;
    const f = framePrims(a, ctx.style);
    hung.set(a.dimension, { w: f.w, h: f.h, top: f.top, bottom: f.bottom, ids: [a.id] });
  }
  ctx.hung = hung;
  for (const { a } of sorted) {
    if (a.type === "table") continue;
    const l = layoutAnnotation(a, ctx, measures.get(a.id));
    ctx.layouts.set(a.id, l);
    if (!l.prims.length) continue;
    ctx.occ.addPrims(l.prims, a.id, a.type === "dimension" ? "dimension" : "leader");
    if (l.textBox) ctx.occ.addBox(l.textBox, a.type === "balloon" ? "balloon" : "text", a.id);
    const h = hung.get(a.id);
    const room = h && l.textBox && !l.problem ? hungBox(ctx, a.id, l.textBox) : null;
    if (room) ctx.occ.addBox(room, "text", h!.ids[0]);
  }
  return ctx.layouts;
}
export * from "./picks";
export * from "./schema";
