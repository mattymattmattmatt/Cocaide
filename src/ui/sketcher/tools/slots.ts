// Slot ▾: Straight slot and Centrepoint slot, as SOLIDWORKS has them. A slot
// is two lines and two arcs joined end to end, each line tangent to both
// arcs, the arcs equal, their centres on the ends of a construction
// centreline: it trims, fillets and dimensions like any lines and arcs, and
// keeps its shape with 5 degrees of freedom (both centres and the width).
// The Length option says what the first clicks are: the arc centres, or the
// slot's overall ends.

import type { Constraint, SketchEntity, Vec2 } from "../../../doc/types";
import { dist2, sub2 } from "../../../geom/vec";
import { along, EPS, line, oriented, perp, unit } from "./shapes";
import type { Built, ClickRole, FlyoutDef, IdMaker, SketchToolDef, ToolOption, ToolOptions } from "./types";

const SLOT: FlyoutDef = { id: "slot", label: "Slot" };

const LENGTH: ToolOption = {
  kind: "choice",
  key: "length",
  label: "Length",
  title: "What the clicks along the slot are",
  default: "centres",
  choices: [
    { value: "centres", label: "Centre to centre", title: "The clicks are the centres of the end arcs" },
    { value: "overall", label: "Overall", title: "The clicks are the ends of the slot" },
  ],
};

/** The distance from p to the segment a-b. */
function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub2(b, a);
  const l2 = ab[0] * ab[0] + ab[1] * ab[1];
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2));
  return dist2(p, [a[0] + t * ab[0], a[1] + t * ab[1]]);
}

/**
 * The slot from a to b (its arc centres, or with `overall` its ends) as wide
 * as twice w's distance from the segment between them. Null when it would be
 * flat, or shorter overall than it is wide.
 */
function slotShape(ids: IdMaker, a: Vec2, b: Vec2, w: Vec2, overall: boolean): { entities: SketchEntity[]; relations: Constraint[]; line: string; arcs: [string, string] } | null {
  const length = dist2(a, b);
  const r = segDist(w, a, b);
  if (length < EPS || r < EPS || (overall && length <= 2 * r + EPS)) return null;
  const u = unit(sub2(b, a));
  const n = perp(u);
  const c1 = overall ? along(a, u, r) : a;
  const c2 = overall ? along(b, u, -r) : b;
  const la = line(ids("l"), along(c1, n, -r), along(c2, n, -r));
  const a1 = ids("a");
  const lb = line(ids("l"), along(c2, n, r), along(c1, n, r));
  const a2 = ids("a");
  const cl = line(ids("l"), c1, c2, true);
  const entities: SketchEntity[] = [
    la,
    { id: a1, type: "arc", center: c2, start: la.end, end: lb.start },
    lb,
    { id: a2, type: "arc", center: c1, start: lb.end, end: la.start },
    cl,
  ];
  const relations: Constraint[] = [
    { type: "coincident", points: [`${la.id}.end`, `${a1}.start`] },
    { type: "coincident", points: [`${a1}.end`, `${lb.id}.start`] },
    { type: "coincident", points: [`${lb.id}.end`, `${a2}.start`] },
    { type: "coincident", points: [`${a2}.end`, `${la.id}.start`] },
    { type: "coincident", points: [`${a1}.center`, `${cl.id}.end`] },
    { type: "coincident", points: [`${a2}.center`, `${cl.id}.start`] },
    { type: "tangent", entities: [la.id, a1] },
    { type: "tangent", entities: [la.id, a2] },
    { type: "tangent", entities: [lb.id, a1] },
    { type: "tangent", entities: [lb.id, a2] },
    { type: "equal", entities: [a1, a2] },
  ];
  return { entities, relations, line: cl.id, arcs: [a1, a2] };
}

/** The slot's first span while its width is placed: from the first click to the pointer. */
const span = (a: Vec2, b: Vec2): SketchEntity[] => (dist2(a, b) < EPS ? [] : [line("preview", a, b, true)]);

const overall = (options: ToolOptions) => options.length === "overall";

export const tools: SketchToolDef[] = [
  {
    id: "sketch.slot",
    name: "slot",
    label: "Straight slot",
    icon: "slot",
    title: "Straight slot: click one end, the other, then how wide. Lines and arcs that trim and dimension like any others",
    flyout: SLOT,
    clicks: 3,
    options: [LENGTH],
    prompts: ["Click where the slot starts", "Click where it ends", "Click how wide it is"],
    alignTo: (pts) => (pts.length === 1 ? pts[0] : undefined),
    preview: (clicks, options, ids, ctx) => (clicks.length === 2 ? span(clicks[0].p, clicks[1].p) : (tools[0].build(clicks, options, ids, ctx)?.entities ?? [])),
    build: (clicks, options, ids): Built | null => {
      const [a, b, w] = clicks.map((k) => k.p);
      const s = slotShape(ids, a, b, w, overall(options));
      if (!s) return null;
      const ends: ClickRole[] = overall(options) ? [{ on: s.arcs[1] }, { on: s.arcs[0] }] : [{ point: `${s.line}.start` }, { point: `${s.line}.end` }];
      return { entities: s.entities, relations: s.relations, roles: [...ends, null], inferred: oriented(s.line, a, b, clicks[1]) };
    },
  },
  {
    id: "sketch.slotCenter",
    name: "slot-center",
    label: "Centrepoint slot",
    icon: "slotCenter",
    title: "Centrepoint slot: click the middle, one end, then how wide; it runs the same length both ways from a point at its middle",
    flyout: SLOT,
    clicks: 3,
    options: [LENGTH],
    prompts: ["Click the middle of the slot", "Click one end: the other mirrors it", "Click how wide it is"],
    alignTo: (pts) => (pts.length === 1 ? pts[0] : undefined),
    preview: (clicks, options, ids, ctx) =>
      clicks.length === 2 ? span(mirror(clicks[0].p, clicks[1].p), clicks[1].p) : (tools[1].build(clicks, options, ids, ctx)?.entities ?? []),
    build: (clicks, options, ids): Built | null => {
      const [m, b, w] = clicks.map((k) => k.p);
      const s = slotShape(ids, mirror(m, b), b, w, overall(options));
      if (!s) return null;
      const centre = ids("p");
      return {
        entities: [...s.entities, { id: centre, type: "point", at: m }],
        relations: [...s.relations, { type: "midpoint", point: `${centre}.at`, entity: s.line }],
        roles: [{ point: `${centre}.at` }, overall(options) ? { on: s.arcs[0] } : { point: `${s.line}.end` }, null],
        inferred: oriented(s.line, m, b, clicks[1]),
      };
    },
  },
];

/** b mirrored through m. */
function mirror(m: Vec2, b: Vec2): Vec2 {
  return [2 * m[0] - b[0], 2 * m[1] - b[1]];
}
