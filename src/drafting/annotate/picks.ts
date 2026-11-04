// Making annotations from what the user picked on the sheet, and moving
// them (Phase Q; the API the sheet editor and its annotation tools build on).
//
//   dimensionFromPicks(sheet, refs, at)   GeoRefs picked + where the text goes → a dimension, or why not
//   holeFromPick, gdtFromPick, datumFromPick, surfaceFromPick, weldFromPick, balloonFromPick,
//   centerMarkFromPick, centerlineFromPicks, threadFromPick, noteAt, leaderFromPick
//   dragGrip(annotation, grip, to, sheet)  a grip dragged to a sheet point → the annotation moved
//   hitAnnotation(sheet, p, tol)           which annotation is under a sheet point
//   rememberPlaces(drawing, composed)      each drawn annotation's place kept as its `last`
//
// Every function takes the composed sheet (src/drafting/compose.ts) and
// returns plain annotation objects for setAnnotation; none edits anything.

import { parseGeoRef } from "../../doc/drawing";
import type {
  Annotation,
  BalloonAnnotation,
  CenterlineAnnotation,
  CenterMarkAnnotation,
  CosmeticThreadAnnotation,
  DatumAnnotation,
  DimensionAnnotation,
  Drawing,
  GdtAnnotation,
  GdtRow,
  GeoRef,
  HoleAnnotation,
  LeaderAnnotation,
  NoteAnnotation,
  SurfaceAnnotation,
  Vec2,
  WeldAnnotation,
  WeldSymbolSide,
} from "../../doc/types";
import type { ComposedDrawing, ComposedSheet } from "../compose";
import { findComposedView, resolveGeoRef, type ResolvedGeoRef } from "../georef";
import { inside, type Box } from "../sheet";
import type { Grip } from "./common";
import { dist, dot, sub, unit } from "./common";

type Model = ComposedSheet | ComposedDrawing;

function sheetsOf(m: Model): ComposedSheet[] {
  return "sheets" in m ? m.sheets : [m];
}

/** The view a set of GeoRefs is in, or why they can't make one annotation. */
function oneView(m: Model, refs: GeoRef[]): { view: string; centre: Vec2 } | string {
  if (!refs.length) return "pick something in a view first";
  const views = new Set(refs.map((r) => parseGeoRef(r)?.view));
  if (views.has(undefined)) return `${refs.find((r) => !parseGeoRef(r))} is not a GeoRef`;
  if (views.size > 1) return "the picks are in different views: an annotation's are all in one";
  const view = [...views][0]!;
  const f = findComposedView(sheetsOf(m), view);
  if (!f) return `no view ${view} on the sheet`;
  return { view, centre: f.cv.centre };
}

const rel = (c: Vec2, p: Vec2): Vec2 => [Math.round((p[0] - c[0]) * 10) / 10 + 0, Math.round((p[1] - c[1]) * 10) / 10 + 0];

/**
 * A dimension from picks, inferred as the smart dimension tool does:
 * one circle → its diameter (an arc: its radius); one straight edge → its
 * length (horizontal, vertical or aligned by where the text is dragged);
 * two parallel edges → their distance; two edges at an angle → the angle;
 * a point and an edge → the point's distance from it; two points → their
 * distance (horizontal or vertical by the drag, aligned when dragged square
 * off their line); three points → the angle at the middle one; a cylinder's
 * two sides → its diameter. `at` (sheet mm) is where the text goes.
 */
export function dimensionFromPicks(m: Model, refs: GeoRef[], at: Vec2, opts: { kind?: DimensionAnnotation["kind"]; id?: string } = {}): Omit<DimensionAnnotation, "id"> | string {
  const v = oneView(m, refs);
  if (typeof v === "string") return v;
  const sheets = sheetsOf(m);
  const g = refs.map((r) => resolveGeoRef(sheets, r));
  const bad = g.findIndex((x) => !x);
  if (bad >= 0) return `${refs[bad]} is not in ${v.view}`;
  const r = g as ResolvedGeoRef[];
  const base = { type: "dimension" as const, view: v.view, at: rel(v.centre, at) };
  const isLine = (x: ResolvedGeoRef) => x.kind === "edge" && x.shape === "line" && !!x.a && !!x.b;
  const dirOf = (x: ResolvedGeoRef) => (x.kind === "edge" && x.a && x.b ? unit(sub(x.b, x.a)) : ([1, 0] as Vec2));
  if (opts.kind && opts.kind !== "linear") return { ...base, kind: opts.kind, refs };
  if (r.length === 1) {
    const x = r[0];
    if (x.kind === "circle") return { ...base, kind: "diameter", refs };
    if (x.kind === "edge" && x.arc) return { ...base, kind: "radius", refs };
    if (x.kind === "edge" && x.a && x.b) return { ...base, refs, ...linearDirection(x.a, x.b, at) };
    return "pick an edge, a circle, or two points";
  }
  if (r.length === 2) {
    const [x, y] = r;
    if (isLine(x) && isLine(y)) {
      const c = Math.abs(dirOf(x)[0] * dirOf(y)[1] - dirOf(x)[1] * dirOf(y)[0]);
      if (c > 1e-4) return { ...base, kind: "angular", refs };
      // A cylinder's two outlines ("…s0a", "…s0b"): its diameter.
      const kx = x.key ?? "";
      const ky = y.key ?? "";
      if (kx.slice(0, -1) === ky.slice(0, -1) && /s\d+[ab]$/.test(kx)) return { ...base, kind: "diameter", refs };
      return { ...base, refs };
    }
    const pt = (z: ResolvedGeoRef): Vec2 | null => (z.kind === "point" ? z.at : z.kind === "circle" ? z.c : null);
    const p = pt(x);
    const q = pt(y);
    if (p && q) return { ...base, from: refs[0], to: refs[1], ...linearDirection(p, q, at) };
    if ((isLine(x) && (q || y.kind === "circle")) || (isLine(y) && (p || x.kind === "circle"))) {
      // A circle and an edge: from its centre.
      const fix = (z: ResolvedGeoRef, ref: string) => (z.kind === "circle" ? ref.replace(/:e/, ":c") : ref);
      return { ...base, refs: [fix(x, refs[0]), fix(y, refs[1])] };
    }
    return "pick two points, two edges, or a point and an edge";
  }
  if (r.length === 3 && r.every((x) => x.kind === "point")) return { ...base, kind: "angular", refs };
  return "a dimension is on one or two picks (three points for an angle)";
}

/** Horizontal, vertical or aligned, by where the text is dragged relative to the two points. */
function linearDirection(p: Vec2, q: Vec2, at: Vec2): { direction?: DimensionAnnotation["direction"] } {
  const minX = Math.min(p[0], q[0]);
  const maxX = Math.max(p[0], q[0]);
  const minY = Math.min(p[1], q[1]);
  const maxY = Math.max(p[1], q[1]);
  const slanted = Math.abs(q[0] - p[0]) > 1e-6 && Math.abs(q[1] - p[1]) > 1e-6;
  if (!slanted) return {};
  const withinX = at[0] > minX && at[0] < maxX;
  const withinY = at[1] > minY && at[1] < maxY;
  if (withinX && !withinY) return { direction: "horizontal" };
  if (withinY && !withinX) return { direction: "vertical" };
  return { direction: "aligned" };
}

/** A hole callout on a picked circle of a hole feature (or its pattern copy). */
export function holeFromPick(m: Model, ref: GeoRef, at?: Vec2): Omit<HoleAnnotation, "id"> | string {
  const v = oneView(m, [ref]);
  if (typeof v === "string") return v;
  const g = resolveGeoRef(sheetsOf(m), ref);
  if (!g || g.kind !== "circle") return "pick a hole's circle, seen end on";
  const sheet = sheetsOf(m).find((s) => s.views.some((x) => x.id === v.view))!;
  const feature = g.feature && sheet.points.holes.has(g.feature) ? g.feature : [...sheet.points.holes.values()].find((h) => Math.abs(h.diameter / 2 - g.radius) < 1e-3 || Math.abs((h.counterbore?.diameter ?? 0) / 2 - g.radius) < 1e-3 || Math.abs((h.countersink?.diameter ?? 0) / 2 - g.radius) < 1e-3)?.feature;
  if (!feature) return `${ref} is not a hole of a hole feature: dimension its diameter instead`;
  return { type: "hole", view: v.view, hole: feature, on: ref.replace(":c", ":e"), ...(at ? { at: rel(v.centre, at) } : {}) };
}

/** A cosmetic thread callout on a tapped hole's or a thread's edge. */
export function threadFromPick(m: Model, ref: GeoRef, at?: Vec2): Omit<CosmeticThreadAnnotation, "id"> | string {
  const h = holeFromPick(m, ref, at);
  if (typeof h === "string") return h;
  return { type: "cosmeticThread", view: h.view, hole: h.hole, on: ref, ...(h.at ? { at: h.at } : {}) };
}

/** A feature control frame on a picked feature, or under a picked dimension. */
export function gdtFromPick(m: Model, target: { ref?: GeoRef; dimension?: string; view?: string }, rows: GdtRow[], at?: Vec2): Omit<GdtAnnotation, "id"> | string {
  if (!rows.length) return "a frame needs a row: a characteristic and its tolerance";
  if (target.dimension) {
    const d = sheetsOf(m).flatMap((s) => s.annotations).find((a) => a.id === target.dimension);
    if (!d || d.type !== "dimension" || !d.view) return `no dimension ${target.dimension} on the sheet`;
    return { type: "gdt", view: d.view, rows, dimension: target.dimension };
  }
  if (!target.ref) return "pick the feature or a dimension";
  const v = oneView(m, [target.ref]);
  if (typeof v === "string") return v;
  return { type: "gdt", view: v.view, rows, on: target.ref, ...(at ? { at: rel(v.centre, at) } : {}) };
}

/** A datum feature symbol on a picked edge (a surface seen edge on) or dimension. */
export function datumFromPick(m: Model, target: { ref?: GeoRef; dimension?: string }, label: string, at?: Vec2): Omit<DatumAnnotation, "id"> | string {
  if (!/^[A-HJ-NPR-Z]{1,2}$/.test(label)) return `"${label}" is not a datum letter (I, O and Q are not used)`;
  if (target.dimension) {
    const d = sheetsOf(m).flatMap((s) => s.annotations).find((a) => a.id === target.dimension);
    if (!d || !d.view) return `no dimension ${target.dimension} on the sheet`;
    return { type: "datum", view: d.view, label, dimension: target.dimension };
  }
  if (!target.ref) return "pick the datum feature's edge or its dimension";
  const v = oneView(m, [target.ref]);
  if (typeof v === "string") return v;
  const g = resolveGeoRef(sheetsOf(m), target.ref);
  if (!g || g.kind === "circle") return "a datum stands on a surface seen edge on (a straight edge), or on a size's dimension";
  return { type: "datum", view: v.view, label, on: target.ref, ...(at ? { at: rel(v.centre, at) } : {}) };
}

/** The next free datum letter on the drawing. */
export function nextDatumLabel(m: Model): string {
  const used = new Set(sheetsOf(m).flatMap((s) => s.annotations.filter((a) => a.type === "datum").map((a) => a.text.replace(/^datum /, ""))));
  for (const l of "ABCDEFGHJKLMNPRSTUVWXYZ") if (!used.has(l)) return l;
  return "AA";
}

/** A surface texture symbol on a picked edge. */
export function surfaceFromPick(m: Model, ref: GeoRef, spec: Pick<SurfaceAnnotation, "symbol" | "values" | "process" | "lay" | "allowance" | "allAround"> = {}, at?: Vec2): Omit<SurfaceAnnotation, "id"> | string {
  const v = oneView(m, [ref]);
  if (typeof v === "string") return v;
  return { type: "surface", view: v.view, on: ref, symbol: spec.symbol ?? "removal", ...spec, ...(at ? { at: rel(v.centre, at) } : {}) };
}

/** A weld symbol pointing at a picked joint edge. */
export function weldFromPick(m: Model, ref: GeoRef, sides: { arrowSide?: WeldSymbolSide; otherSide?: WeldSymbolSide }, at?: Vec2): Omit<WeldAnnotation, "id"> | string {
  if (!sides.arrowSide && !sides.otherSide) return "a weld symbol has a weld on the arrow side, the other side or both";
  const v = oneView(m, [ref]);
  if (typeof v === "string") return v;
  return { type: "weld", view: v.view, on: ref, ...sides, ...(at ? { at: rel(v.centre, at) } : {}) };
}

/** A balloon for the body or member a picked edge belongs to. */
export function balloonFromPick(m: Model, ref: GeoRef, at?: Vec2): Omit<BalloonAnnotation, "id"> | string {
  const v = oneView(m, [ref]);
  if (typeof v === "string") return v;
  const g = resolveGeoRef(sheetsOf(m), ref);
  if (!g?.body) return `${ref} belongs to no body`;
  const sheet = sheetsOf(m).find((s) => s.views.some((x) => x.id === v.view))!;
  const member = sheet.points.members.find((x) => x.body === g.body);
  return { type: "balloon", view: v.view, ...(member ? { member: member.id } : { body: g.body }), on: ref, ...(at ? { at: rel(v.centre, at) } : {}) };
}

export function centerMarkFromPick(m: Model, ref: GeoRef): Omit<CenterMarkAnnotation, "id"> | string {
  const v = oneView(m, [ref]);
  if (typeof v === "string") return v;
  const g = resolveGeoRef(sheetsOf(m), ref);
  if (!g || !(g.kind === "circle" || (g.kind === "edge" && g.arc) || (g.kind === "point" && g.of === "centre"))) return "pick a circle or an arc";
  return { type: "centerMark", view: v.view, at: g.kind === "edge" ? ref.replace(":e", ":c") : ref };
}

export function centerlineFromPicks(m: Model, a: GeoRef, b: GeoRef): Omit<CenterlineAnnotation, "id"> | string {
  const v = oneView(m, [a, b]);
  if (typeof v === "string") return v;
  return { type: "centerline", view: v.view, between: [a, b] };
}

/** A note at a sheet point, with leaders to picked GeoRefs. */
export function noteAt(at: Vec2, text: string, leaders: GeoRef[] = []): Omit<NoteAnnotation, "id"> {
  return { type: "note", text, at, ...(leaders.length ? { leaders: leaders.map((to) => ({ to })) } : {}) };
}

export function leaderFromPick(m: Model, ref: GeoRef, at: Vec2, text?: string): Omit<LeaderAnnotation, "id"> | string {
  const v = oneView(m, [ref]);
  if (typeof v === "string") return v;
  return { type: "leader", view: v.view, to: ref, at: rel(v.centre, at), ...(text ? { text } : {}) };
}

// ------------------------------------------------------------ moving

/**
 * An annotation with one of its grips dragged to `to` (sheet mm): its text or
 * symbol (`at`, from its view's centre), a linear dimension's line (`offset`:
 * how far from the view, the side by where it was dragged), a vertex of a
 * cloud or a line (`pts`), a leader's bend (`via`).
 */
export function dragGrip<A extends Annotation>(a: A, grip: Grip, to: Vec2, m: Model): A {
  const view = "view" in a && a.view ? findComposedView(sheetsOf(m), a.view)?.cv : undefined;
  const c: Vec2 = view ? view.centre : [0, 0];
  const r = (p: Vec2) => rel(c, p);
  const next = { ...a } as Record<string, unknown>;
  if (grip.field === "at") next.at = r(to);
  else if (grip.field === "offset" && view?.box) {
    // Square out from the view's nearest side.
    const b = view.box;
    const dx = to[0] < b.min[0] ? to[0] - b.min[0] : to[0] > b.max[0] ? to[0] - b.max[0] : 0;
    const dy = to[1] < b.min[1] ? to[1] - b.min[1] : to[1] > b.max[1] ? to[1] - b.max[1] : 0;
    const d = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
    next.offset = Math.round(d * 10) / 10 || (d >= 0 ? 0.1 : -0.1);
    delete next.at;
  } else if (grip.field === "pts" && Array.isArray(next.pts) && grip.index !== undefined) {
    const pts = [...(next.pts as Vec2[])];
    pts[grip.index] = r(to);
    next.pts = pts;
  } else if (grip.field === "via" && Array.isArray(next.via) && grip.index !== undefined) {
    const via = [...(next.via as Vec2[])];
    via[grip.index] = r(to);
    next.via = via;
  }
  delete next.last;
  return next as A;
}

/** The annotation under a sheet point: the nearest whose text box or lines are within `tol` mm, text first. */
export function hitAnnotation(sheet: ComposedSheet, p: Vec2, tol = 1.5): string | null {
  let best: { id: string; d: number } | null = null;
  const grow = (b: Box, d: number): Box => ({ min: [b.min[0] - d, b.min[1] - d], max: [b.max[0] + d, b.max[1] + d] });
  for (const a of sheet.annotations) {
    if (a.textBox && inside({ min: p, max: p }, grow(a.textBox, tol))) return a.id;
  }
  for (const prim of sheet.prims) {
    if (!prim.owner || prim.k !== "line" || !sheet.annotations.some((a) => a.id === prim.owner)) continue;
    for (let i = 1; i < prim.pts.length; i++) {
      const d = segDist(p, prim.pts[i - 1], prim.pts[i]);
      if (d <= tol && (!best || d < best.d)) best = { id: prim.owner, d };
    }
  }
  return best?.id ?? null;
}

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return dist(p, [a[0] + ab[0] * t, a[1] + ab[1] * t]);
}

/**
 * The drawing with each drawn dimension's place kept as its `last` (sheet mm
 * from its view's centre, and what it read), so that if its target goes in a
 * rebuild it is drawn there in the warning colour. Null when nothing changed.
 */
export function rememberPlaces(drawing: Drawing, composed: ComposedDrawing | ComposedSheet[]): Drawing | null {
  const sheets = Array.isArray(composed) ? composed : composed.sheets;
  const places = new Map(sheets.flatMap((s) => s.annotations.filter((a) => a.place && !a.problem).map((a) => [a.id, a.place!] as const)));
  let changed = false;
  const next: Drawing = {
    ...drawing,
    sheets: drawing.sheets.map((s) => ({
      ...s,
      annotations: s.annotations.map((a) => {
        if (a.type !== "dimension") return a;
        const p = places.get(a.id);
        if (!p) return a;
        const last = { pts: p.pts, text: p.text };
        if (JSON.stringify(a.last) === JSON.stringify(last)) return a;
        changed = true;
        return { ...a, last };
      }),
    })),
  };
  return changed ? next : null;
}
