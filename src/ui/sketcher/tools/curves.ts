// Ellipse ▾: Ellipse (centre, the end of its major axis, then a point it
// passes through) and Partial ellipse (the same, then where the arc ends; it
// turns the way you sweep). With Axes on (the default) each comes with its
// major and minor axes as construction lines held to it, so they can be
// related and dimensioned like any line (an angle to the X axis, symmetric
// about one).
//
// Spline: click the points it passes through; double-click (click the last
// point again) or Enter to finish, or click the first point to close it into
// a smooth loop.

import type { Constraint, EllipseEntity, SketchEntity, SplineEntity, Vec2 } from "../../../doc/types";
import { DEG, ellipseGeom, ellipseLocal, ellipseParam, ellipsePoint, type EllipseGeom } from "../../../geom/curves";
import { dist2 } from "../../../geom/vec";
import { EPS, line, turning } from "./shapes";
import type { Click, ClickRole, FlyoutDef, IdMaker, SketchToolDef, ToolOption, ToolOptions } from "./types";

/** One button for the free curves (the toolbar has room for one more): Spline, Ellipse, Partial ellipse. */
const CURVE: FlyoutDef = { id: "curve", label: "Curve" };

const AXES: ToolOption = { kind: "toggle", key: "axes", label: "Axes", title: "Draw its major and minor axes as construction lines, held to it (relate and dimension them as lines)", default: "on" };

/**
 * The minor radius of the ellipse about `c` with its major end at `m` that
 * passes through q: in its own frame q is (x, y), and x²/a² + y²/b² = 1. A
 * point beyond the major end (|x| ≥ a) passes nothing: its distance from the
 * major axis is taken instead.
 */
export function minorThrough(c: Vec2, m: Vec2, q: Vec2): number {
  const g = ellipseGeom({ center: c, major: m, minor: 1 });
  const [x, y] = ellipseLocal(g, q);
  const k = 1 - (x / g.a) ** 2;
  return k > 0.01 ? Math.abs(y) / Math.sqrt(k) : Math.abs(y);
}

/** The construction axes of an ellipse and the relations that hold them to it (they add no freedom). */
function axesOf(e: EllipseEntity, ids: IdMaker): { entities: SketchEntity[]; relations: Constraint[] } {
  const g = ellipseGeom(e);
  const major = line(ids("l"), ellipsePoint(g, Math.PI), e.major, true);
  const minor = line(ids("l"), ellipsePoint(g, -Math.PI / 2), ellipsePoint(g, Math.PI / 2), true);
  return {
    entities: [major, minor],
    relations: [
      { type: "midpoint", point: `${e.id}.center`, entity: major.id },
      { type: "coincident", points: [`${major.id}.end`, `${e.id}.major`] },
      { type: "midpoint", point: `${e.id}.center`, entity: minor.id },
      { type: "coincident", points: [`${minor.id}.end`, `${e.id}.minorEnd`] },
    ],
  };
}

/** An ellipse (with its axes when asked) from centre, major end and a point on it. */
function ellipseFrom(clicks: Click[], options: ToolOptions, ids: IdMaker, arc?: { start: number; end: number }) {
  const [c, m, q] = clicks.map((k) => k.p);
  if (dist2(c, m) < EPS) return null;
  const minor = minorThrough(c, m, q);
  if (minor < EPS) return null;
  const e: EllipseEntity = { id: ids("el"), type: "ellipse", center: c, major: m, minor, ...(arc ? { startAngle: arc.start, endAngle: arc.end } : {}) };
  const axes = options.axes === "off" ? { entities: [], relations: [] } : axesOf(e, ids);
  const inferred: Constraint[] = clicks[1].orient ? [{ type: clicks[1].orient, entity: e.id }] : [];
  return { e, entities: [e, ...axes.entities], relations: axes.relations, inferred };
}

/** Degrees, rounded to a millionth: the document's angles. */
const deg = (rad: number) => Math.round((rad / DEG) * 1e6) / 1e6;

const drawn: SketchToolDef[] = [
  {
    id: "sketch.ellipse",
    name: "ellipse",
    label: "Ellipse",
    icon: "ellipse",
    title: "Ellipse: click the centre, the end of the major axis, then a point it passes through (that sets the minor radius)",
    flyout: CURVE,
    clicks: 3,
    prompts: ["Click the centre", "Click the end of the major axis", "Click a point the ellipse passes through"],
    options: [AXES],
    alignTo: (pts) => (pts.length === 1 ? pts[0] : undefined),
    preview: (clicks, options, ids) => {
      if (clicks.length === 2) {
        // The major axis so far, and the circle it would be with equal radii.
        const [c, m] = clicks.map((k) => k.p);
        const r = dist2(c, m);
        return r < EPS ? [] : [line(ids("l"), c, m, true), { id: ids("c"), type: "circle", center: c, radius: r, construction: true }];
      }
      return ellipseFrom(clicks, options, ids)?.entities ?? [];
    },
    build: (clicks, options, ids) => {
      const made = ellipseFrom(clicks, options, ids);
      if (!made) return null;
      const { e } = made;
      return { entities: made.entities, relations: made.relations, inferred: made.inferred, roles: [{ point: `${e.id}.center` }, { point: `${e.id}.major` }, { on: e.id }] };
    },
  },
  {
    id: "sketch.ellipseArc",
    name: "ellipse-arc",
    label: "Partial ellipse",
    icon: "ellipseArc",
    title: "Partial ellipse: click the centre, the end of the major axis, where the arc starts (that sets the minor radius), then sweep round and click where it ends",
    flyout: CURVE,
    clicks: 4,
    prompts: ["Click the centre", "Click the end of the major axis", "Click where the arc starts", "Sweep round and click where it ends"],
    options: [AXES],
    alignTo: (pts) => (pts.length === 1 ? pts[0] : undefined),
    preview: (clicks, options, ids, ctx) => {
      if (clicks.length < 4) return drawn[0].preview!(clicks, options, ids, ctx);
      return drawn[1].build(clicks, options, ids, ctx)?.entities ?? [];
    },
    build: (clicks, options, ids, ctx) => {
      const [c, m, s, q] = clicks.map((k) => k.p);
      if (dist2(c, m) < EPS) return null;
      const minor = minorThrough(c, m, s);
      if (minor < EPS) return null;
      const g: EllipseGeom = ellipseGeom({ center: c, major: m, minor });
      const t0 = ellipseParam(g, s);
      const t1 = ellipseParam(g, q);
      if (Math.abs(Math.sin((t1 - t0) / 2)) < 1e-6) return null;
      // Stored counter-clockwise from start to end: swept the other way, the ends swap.
      const clockwise = turning(c, s, [...(ctx.trail ?? []), q]) < 0;
      const arc = clockwise ? { start: deg(t1), end: deg(t0) } : { start: deg(t0), end: deg(t1) };
      const made = ellipseFrom([clicks[0], clicks[1], { ...clicks[2], p: ellipsePoint(g, t0) }], options, ids, arc);
      if (!made) return null;
      const { e } = made;
      const [first, last] = clockwise ? ["end", "start"] : ["start", "end"];
      const roles: ClickRole[] = [{ point: `${e.id}.center` }, { point: `${e.id}.major` }, { point: `${e.id}.${first}` }, dist2(ellipsePoint(g, t1), q) < 1e-6 ? { point: `${e.id}.${last}` } : null];
      return { entities: made.entities, relations: made.relations, inferred: made.inferred, roles };
    },
  },
  {
    id: "sketch.spline",
    name: "spline",
    label: "Spline",
    icon: "spline",
    title: "Spline: click the points it passes through; double-click or Enter to finish, or click the first point to close it",
    clicks: 2,
    flyout: CURVE,
    open: true,
    prompts: ["Click where the spline starts", "Click the next point: double-click or Enter to finish, the first point to close it"],
    // Back on the first point (after two more), it closes.
    snap: (pts, p, tol) => (pts.length >= 3 && dist2(p, pts[0]) <= tol ? { p: pts[0] } : null),
    preview: (clicks, _options, ids) => {
      const s = splineFrom(clicks, ids("sp"));
      return s ? [s] : [];
    },
    build: (clicks, _options, ids) => {
      const id = ids("sp");
      const s = splineFrom(clicks, id);
      if (!s) return null;
      // Each click is a point of it; a closing click lands on its first point.
      const roles: ClickRole[] = clicks.map((_, i) => (i < s.points.length ? { point: `${id}.p${i}` } : null));
      return { entities: [s], relations: [], roles };
    },
  },
];

/** Spline first: the flyout's default. */
export const tools: SketchToolDef[] = [drawn[2], drawn[0], drawn[1]];

/**
 * The spline through the clicks: a click on the one before it (the second
 * click of a double-click) adds nothing, and a last click back on the first
 * point (after at least two others) closes it. Null with fewer than two points.
 */
export function splineFrom(clicks: Click[], id: string): SplineEntity | null {
  const pts: Vec2[] = [];
  for (const k of clicks) if (!pts.length || dist2(pts[pts.length - 1], k.p) > EPS) pts.push(k.p);
  const closed = pts.length >= 4 && dist2(pts[0], pts[pts.length - 1]) <= EPS;
  if (closed) pts.pop();
  if (pts.length < 2) return null;
  return { id, type: "spline", points: pts, ...(closed ? { closed: true } : {}) };
}
