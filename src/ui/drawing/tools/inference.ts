// What Smart Dimension makes of the picks (Phase Q wave Q3A): the
// inference rules of a professional drafting package, on top of the
// engine's dimensionFromPicks. One edge: its length (horizontal, vertical or
// aligned by where the pointer is); a circle: its diameter, an arc: its
// radius (the Ø/R toggle swaps them); two points or two circles' centres:
// their distance across, up or along by the pointer; two parallel edges:
// their distance; two edges at an angle: the angle of the quadrant the
// pointer is in; a point and an edge: the point's distance square from it;
// a cylinder's two outlines: its diameter. Chain, baseline and ordinate
// sets come from an origin and points. Pure: no React, no document.

import type { DimensionAnnotation, DimensionDirection, DimensionKind, GeoRef, Vec2 } from "../../../doc/types";
import type { ComposedSheet } from "../../../drafting/compose";
import { dimensionFromPicks } from "../../../drafting/annotate";
import { resolveGeoRef } from "../../../drafting/georef";
import type { SnapKind } from "../snap";

/** A pick on the sheet, as the snap index gives it. */
export interface DimPick {
  ref: GeoRef;
  kind: SnapKind;
  view: string;
  at: Vec2;
}

export type NewDimension = Omit<DimensionAnnotation, "id">;

export interface InferOptions {
  /** A circle or an arc written as a diameter or a radius (default: circle Ø, arc R). */
  radial?: "diameter" | "radius";
  /** Lock a linear dimension's direction (the pointer decides when unset). */
  direction?: DimensionDirection;
}

const POINT_KINDS: SnapKind[] = ["vertex", "centre", "midpoint", "quadrant"];
const isPoint = (p: DimPick) => POINT_KINDS.includes(p.kind);
const isRound = (p: DimPick) => p.kind === "circle" || p.kind === "arc";
/** A circle's or arc's centre, as a GeoRef ("front:ehole_1/c0" → "front:chole_1/c0"). */
export const centreRef = (ref: GeoRef) => ref.replace(/:e/, ":c");

/**
 * A dimension from the picks and where the pointer is (the text goes there),
 * or why there is none. `at` is sheet mm.
 */
export function inferDimension(sheet: ComposedSheet, picks: DimPick[], at: Vec2, opts: InferOptions = {}): NewDimension | string {
  if (!picks.length) return "Click an edge, a circle or a point";
  const views = new Set(picks.map((p) => p.view));
  if (views.size > 1) return "Pick in one view: a dimension's ends are in the same view";
  if (picks.length === 1) {
    const p = picks[0];
    if (isRound(p)) {
      const g = resolveGeoRef([sheet], p.ref);
      const arc = g?.kind === "edge" && !!g.arc;
      const kind: DimensionKind = (opts.radial ?? (arc ? "radius" : "diameter")) === "radius" ? "radius" : "diameter";
      const r = dimensionFromPicks(sheet, [p.ref], at, { kind });
      return typeof r === "string" ? capital(r) : r;
    }
    if (isPoint(p)) return "Click a second point (or an edge) to dimension the distance";
  }
  // Two circles (or a circle and a point): centre to centre.
  let refs = picks.map((p) => p.ref);
  if (picks.length === 2 && picks.some(isRound) && picks.every((p) => isRound(p) || isPoint(p))) refs = picks.map((p) => (isRound(p) ? centreRef(p.ref) : p.ref));
  const r = dimensionFromPicks(sheet, refs, at);
  if (typeof r === "string") return capital(r);
  if (opts.direction && (r.kind ?? "linear") === "linear") return { ...r, direction: opts.direction };
  return r;
}

/** The view's box a pointer is outside of, and on which side: what a set's direction and side come from. */
function sideOf(box: { min: Vec2; max: Vec2 }, p: Vec2): { dir: "horizontal" | "vertical"; sign: 1 | -1 } | null {
  if (p[1] > box.max[1]) return { dir: "horizontal", sign: 1 };
  if (p[1] < box.min[1]) return { dir: "horizontal", sign: -1 };
  if (p[0] > box.max[0]) return { dir: "vertical", sign: 1 };
  if (p[0] < box.min[0]) return { dir: "vertical", sign: -1 };
  return null;
}

/**
 * A chain, baseline or ordinate set: an origin (a point, or a side of the
 * view like "@left") and the points measured from it, laid out across
 * (dimension line above or below the view) or up (left or right) by where the
 * pointer is; inside the view, by which way the points spread.
 */
export function setFromPicks(sheet: ComposedSheet, mode: "chain" | "baseline" | "ordinate", origin: string, points: string[], at: Vec2): NewDimension | string {
  if (!points.length) return mode === "chain" ? "Click the next point of the chain" : "Click the points to measure from the origin";
  const view = origin.includes(":") ? origin.split(":")[0] : points.find((p) => p.includes(":"))?.split(":")[0];
  const cv = sheet.views.find((v) => v.id === view);
  if (!cv?.box) return "Pick points in a view";
  if (new Set([origin, ...points].filter((p) => p.includes(":")).map((p) => p.split(":")[0])).size > 1) return "Pick in one view: a set's points are in the same view";
  const side = sideOf(cv.box, at);
  let direction: DimensionDirection;
  let sign: 1 | -1 = -1;
  if (side) {
    direction = side.dir;
    sign = side.sign;
  } else {
    const pos = [origin, ...points].map((r) => (r.includes(":") ? resolveGeoRef([sheet], r) : null)).map((g) => (g?.kind === "point" ? g.at : g?.kind === "circle" ? g.c : null)).filter((p): p is Vec2 => !!p);
    const sx = pos.length ? Math.max(...pos.map((p) => p[0])) - Math.min(...pos.map((p) => p[0])) : 1;
    const sy = pos.length ? Math.max(...pos.map((p) => p[1])) - Math.min(...pos.map((p) => p[1])) : 0;
    direction = sx >= sy ? "horizontal" : "vertical";
  }
  const axis = direction === "horizontal" ? 1 : 0;
  const edge = sign > 0 ? cv.box.max[axis] : cv.box.min[axis];
  const gap = Math.max(4, Math.abs(at[axis] - edge));
  return { type: "dimension", view: view!, kind: mode, origin, points, direction, offset: Math.round(sign * gap * 10) / 10 };
}

/** A linear dimension turned into a baseline or ordinate set from its first point (or a set back into one dimension). */
export function convertDimension(a: DimensionAnnotation, to: "linear" | "baseline" | "ordinate" | "chain"): NewDimension | string {
  const { id: _id, ...rest } = a;
  void _id;
  const kind = a.kind ?? "linear";
  if (to === kind) return rest;
  const strip = (o: Record<string, unknown>) => {
    for (const k of ["from", "to", "refs", "origin", "points", "member", "at", "last", "major", "jog"]) delete o[k];
    return o;
  };
  if (to === "linear") {
    if (!(kind === "baseline" || kind === "ordinate" || kind === "chain") || !a.origin || !a.points?.length) return "Only a chain, baseline or ordinate set turns back into a dimension";
    const o = strip({ ...rest }) as NewDimension;
    return { ...o, kind: "linear", from: a.origin, to: a.points[a.points.length - 1] };
  }
  if (kind === "linear" && a.from !== undefined && a.to !== undefined) {
    const o = strip({ ...rest }) as NewDimension;
    return { ...o, kind: to, origin: a.from, points: [a.to], ...(a.direction && a.direction !== "aligned" ? { direction: a.direction } : {}) };
  }
  if ((kind === "baseline" || kind === "ordinate" || kind === "chain") && a.origin && a.points) {
    const o = strip({ ...rest }) as NewDimension;
    return { ...o, kind: to, origin: a.origin, points: a.points, ...(a.direction && a.direction !== "aligned" ? { direction: a.direction } : {}) };
  }
  return "Only a dimension between two points turns into a set (an edge's or a circle's has one end)";
}

/** Ø ↔ R on a circle's or an arc's dimension: the patch, or null when it isn't one. */
export function radialSwap(a: DimensionAnnotation, to: "diameter" | "radius"): Partial<DimensionAnnotation> | null {
  if ((a.kind !== "diameter" && a.kind !== "radius") || a.refs?.length !== 1) return null;
  return a.kind === to ? {} : { kind: to };
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
