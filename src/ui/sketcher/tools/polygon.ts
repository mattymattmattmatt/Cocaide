// Polygon, as SOLIDWORKS has it: 3 to 40 equal sides round a construction
// circle, inscribed (the corners on the circle) or circumscribed (the sides
// touching it: its diameter is the size across flats). Plain lines joined at
// the corners, so the sides trim and fillet like any others; it keeps its
// shape with 4 degrees of freedom: the centre, the size and the turn, and the
// turn too goes once a side is level (it snaps level or plumb when close).

import type { Constraint, SketchEntity, Vec2 } from "../../../doc/types";
import { angleOf, dist2, polar, sub2 } from "../../../geom/vec";
import { closedLoop, EPS } from "./shapes";
import type { Built, Click, IdMaker, SketchToolDef, ToolOptions } from "./types";

export const MIN_SIDES = 3;
export const MAX_SIDES = 40;

const sidesOf = (options: ToolOptions) => Math.min(MAX_SIDES, Math.max(MIN_SIDES, Math.round(Number(options.sides) || 6)));
const inscribed = (options: ToolOptions) => options.mode !== "circumscribed";

/**
 * The turn of the polygon from its second click: the angle of the first side's
 * normal-ish reference ("base"), such that side k runs at base + 2πk/n + π/2.
 * Inscribed, the click is a corner (base is half a step on from it);
 * circumscribed, it is the middle of a side (base is its angle).
 */
function baseOf(click: number, n: number, ins: boolean): number {
  return ins ? click + Math.PI / n : click;
}

/** The polygon's corners from its centre, its second click and its options. */
export function polygonCorners(c: Vec2, q: Vec2, options: ToolOptions): Vec2[] | null {
  const n = sidesOf(options);
  const rho = dist2(c, q);
  if (rho < EPS) return null;
  const phi = angleOf(sub2(q, c));
  // Inscribed, q is a corner; circumscribed, it is the middle of the first side.
  const R = inscribed(options) ? rho : rho / Math.cos(Math.PI / n);
  const first = inscribed(options) ? phi : phi - Math.PI / n;
  return Array.from({ length: n }, (_, k) => polar(c, R, first + (2 * Math.PI * k) / n));
}

/**
 * The turn nearest the pointer's at which a side is level or plumb, if the
 * corner (or side middle) would move less than `tol` to get there.
 */
function levelSnap(c: Vec2, p: Vec2, tol: number, options: ToolOptions): { p: Vec2; orient: "horizontal" | "vertical" } | null {
  const n = sidesOf(options);
  const rho = dist2(c, p);
  if (rho < EPS) return null;
  const ins = inscribed(options);
  const phi = angleOf(sub2(p, c));
  const base = baseOf(phi, n, ins);
  let best: { d: number; base: number; orient: "horizontal" | "vertical" } | null = null;
  for (let k = 0; k < n; k++) {
    // Side k is level when base + 2πk/n + π/2 is a multiple of π, plumb when base + 2πk/n is.
    for (const [orient, offset] of [["horizontal", Math.PI / 2], ["vertical", 0]] as const) {
      const raw = -offset - (2 * Math.PI * k) / n;
      const want = raw + Math.round((base - raw) / Math.PI) * Math.PI;
      const d = Math.abs(base - want);
      if (!best || d < best.d - 1e-12 || (Math.abs(d - best.d) <= 1e-12 && orient === "horizontal" && best.orient === "vertical")) best = { d, base: want, orient };
    }
  }
  if (!best || best.d * rho > tol) return null;
  const turned = ins ? best.base - Math.PI / n : best.base;
  return { p: polar(c, rho, turned), orient: best.orient };
}

/** The relation that fixes the turn: the lowest level side level, else the leftmost plumb side plumb. */
function turnRelation(lines: { id: string; start: Vec2; end: Vec2 }[], click?: Click): Constraint[] {
  const span = (l: { start: Vec2; end: Vec2 }) => Math.hypot(l.end[0] - l.start[0], l.end[1] - l.start[1]);
  const level = lines.filter((l) => Math.abs(l.end[1] - l.start[1]) < 1e-9 * span(l) + EPS);
  const plumb = lines.filter((l) => Math.abs(l.end[0] - l.start[0]) < 1e-9 * span(l) + EPS);
  const mid = (l: { start: Vec2; end: Vec2 }, k: 0 | 1) => (l.start[k] + l.end[k]) / 2;
  if (level.length && click?.orient !== "vertical") return [{ type: "horizontal", entity: level.reduce((a, b) => (mid(b, 1) < mid(a, 1) ? b : a)).id }];
  if (plumb.length) return [{ type: "vertical", entity: plumb.reduce((a, b) => (mid(b, 0) < mid(a, 0) ? b : a)).id }];
  return [];
}

function buildPolygon(clicks: Click[], options: ToolOptions, ids: IdMaker): Built | null {
  const [c, q] = clicks.map((k) => k.p);
  const corners = polygonCorners(c, q, options);
  if (!corners) return null;
  const { lines, relations } = closedLoop(ids, corners);
  const R = dist2(c, corners[0]);
  const ins = inscribed(options);
  const entities: SketchEntity[] = [...lines];
  // Circumscribed, the circle the user sees and sizes is the one the sides touch; the corners are on a second.
  const inner = ins ? null : ids("c");
  const outer = ids("c");
  if (inner) entities.push({ id: inner, type: "circle", center: c, radius: dist2(c, q), construction: true });
  entities.push({ id: outer, type: "circle", center: c, radius: R, construction: true });
  for (const l of lines) relations.push({ type: "pointOn", point: `${l.id}.start`, entity: outer });
  for (const l of lines.slice(1)) relations.push({ type: "equal", entities: [lines[0].id, l.id] });
  if (inner) relations.push({ type: "concentric", entities: [inner, outer] }, { type: "tangent", entities: [lines[0].id, inner] });
  return {
    entities,
    relations,
    roles: [{ point: `${inner ?? outer}.center` }, ins ? { point: `${lines[0].id}.start` } : { middle: lines[0].id }],
    inferred: turnRelation(lines, clicks[1]),
  };
}

export const tools: SketchToolDef[] = [
  {
    id: "sketch.polygon",
    name: "polygon",
    label: "Polygon",
    icon: "polygon",
    title: "Polygon: click the centre, then a corner (inscribed) or the middle of a side (circumscribed). Equal sides round a construction circle",
    clicks: 2,
    prompts: ["Click the centre", "Click a corner (inscribed) or a side's middle (circumscribed)"],
    options: [
      { kind: "number", key: "sides", label: "Sides", title: "How many sides: 3 to 40", default: 6, min: MIN_SIDES, max: MAX_SIDES, integer: true },
      {
        kind: "choice",
        key: "mode",
        label: "Circle",
        title: "Where the construction circle is",
        default: "inscribed",
        choices: [
          { value: "inscribed", label: "Inscribed", title: "The corners are on the circle" },
          { value: "circumscribed", label: "Circumscribed", title: "The sides touch the circle: its diameter is the size across flats" },
        ],
      },
    ],
    snap: (pts, p, tol, options) => (pts.length === 1 ? levelSnap(pts[0], p, tol, options) : null),
    build: (clicks, options, ids) => buildPolygon(clicks, options, ids),
  },
];
