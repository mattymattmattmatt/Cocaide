// Sketch fillet and sketch chamfer, as SOLIDWORKS has them.
//
// A corner is where two lines or arcs end at one point (or, for two lines
// picked that don't meet, where they would meet if extended). A fillet
// shortens both and puts in an arc of the radius tangent to both: tangent
// and coincident relations hold it there, and one radius dimension drives
// every fillet made at once (the others are equal to the first, SOLIDWORKS's
// "equal radius"). A chamfer cuts the corner with a line, set back by two
// distances or by a distance and an angle, each a dimension.
//
// "Keep constrained corners": what was related or dimensioned to the old
// corner moves to a construction point left there (a virtual sharp, on both
// entities extended), so a dimension to the corner keeps its meaning. A
// chamfer always leaves one: its dimensions run from it.

import type { Constraint, SketchEntity, Vec2 } from "../../doc/types";
import { add2, cross2, dist2, dot2, scale2, sub2 } from "../vec";
import { carrierMeet, curveOf, footOn, paramOf, tangentAt, TOL, type Curve } from "./curve";
import { explodeAll } from "./explode";
import { freshIds, mapRefs, pointAtRef, replaced, settle, type Edit, type SketchState } from "./relations";

type End = "start" | "end";

/** A corner: entity a's end and entity b's end, at `at` (where they meet, or would if extended). */
export interface Corner {
  a: string;
  aEnd: End;
  b: string;
  bEnd: End;
  at: Vec2;
}

const roundable = (e: SketchEntity | undefined): e is Extract<SketchEntity, { type: "line" | "arc" }> => e?.type === "line" || e?.type === "arc";
const other = (end: End): End => (end === "start" ? "end" : "start");
const close = (p: Vec2, q: Vec2) => dist2(p, q) <= 10 * TOL;

/**
 * The corners a selection names: each point picked where exactly two lines
 * or arcs end; each pair of picked lines and arcs that end at one point; or
 * two picked lines that don't meet, where they would. Rectangles and slots
 * picked are exploded first (the state that comes back has them as lines).
 */
export function cornersOf(stateIn: SketchState, picks: { entities: string[]; points: string[] }): { state: SketchState; corners: Corner[] } | string {
  const { state, ids } = explodeAll(stateIn, picks.entities);
  const byId = new Map(state.entities.map((e) => [e.id, e]));
  const corners: Corner[] = [];
  const add = (c: Corner) => {
    if (!corners.some((k) => close(k.at, c.at))) corners.push(c);
  };
  const endsAt = (p: Vec2) =>
    state.entities.flatMap((e) => (roundable(e) ? (["start", "end"] as End[]).filter((n) => close(e[n], p)).map((n) => ({ id: e.id, end: n })) : []));
  for (const ref of picks.points) {
    const p = pointAtRef(state.entities, ref);
    if (!p) return `there is no point ${ref}`;
    const there = endsAt(p);
    if (there.length !== 2) return there.length < 2 ? `${ref} is not a corner: pick a point where two lines or arcs meet` : `${there.map((t) => t.id).join(", ")} all meet at ${ref}: pick two of them instead`;
    add({ a: there[0].id, aEnd: there[0].end, b: there[1].id, bEnd: there[1].end, at: p });
  }
  const picked = ids.filter((id) => roundable(byId.get(id)));
  for (const id of ids) {
    const e = byId.get(id);
    if (e && !roundable(e) && e.type !== "point") return `${id} is a ${e.type}: corners are where lines and arcs meet`;
  }
  let shared = false;
  for (let i = 0; i < picked.length; i++) {
    for (let j = i + 1; j < picked.length; j++) {
      const a = byId.get(picked[i]) as Extract<SketchEntity, { type: "line" | "arc" }>;
      const b = byId.get(picked[j]) as Extract<SketchEntity, { type: "line" | "arc" }>;
      for (const aEnd of ["start", "end"] as End[])
        for (const bEnd of ["start", "end"] as End[])
          if (close(a[aEnd], b[bEnd])) {
            shared = true;
            add({ a: a.id, aEnd, b: b.id, bEnd, at: a[aEnd] });
          }
    }
  }
  if (!shared && picked.length === 2) {
    const [a, b] = picked.map((id) => byId.get(id)!) as Extract<SketchEntity, { type: "line" | "arc" }>[];
    if (a.type !== "line" || b.type !== "line") return `${a.id} and ${b.id} don't meet: pick a corner where they end together`;
    const p = carrierMeet(curveOf(a)!, curveOf(b)!)[0];
    if (!p) return `${a.id} and ${b.id} are parallel: they have no corner`;
    const near = (l: Extract<SketchEntity, { type: "line" }>): End => (dist2(l.start, p) < dist2(l.end, p) ? "start" : "end");
    add({ a: a.id, aEnd: near(a), b: b.id, bEnd: near(b), at: p });
  }
  if (!corners.length) return picks.points.length || picks.entities.length ? "no corner there: pick the point where two lines or arcs meet, or the two of them" : "pick corners: the points where two lines or arcs meet, or the entities";
  return { state, corners };
}

/** The unit direction that leaves the corner along the entity (towards its other end). */
function away(e: Extract<SketchEntity, { type: "line" | "arc" }>, end: End): Vec2 {
  const c = curveOf(e)!;
  const t = tangentAt(c, end === "start" ? 0 : 1);
  return end === "start" ? t : scale2(t, -1);
}

/** The curve `d` to the given side (unit normal n at the corner) of the entity's line or circle. */
function offsetCarrier(c: Curve, at: Vec2, n: Vec2, d: number): Curve | string {
  if (c.kind === "line") {
    const u = sub2(c.b, c.a);
    const p = add2(at, scale2(n, d));
    return { kind: "line", a: p, b: add2(p, u) };
  }
  const outward = dot2(n, sub2(at, c.c)) > 0;
  const r = c.r + (outward ? d : -d);
  if (r <= TOL) return `the radius is bigger than the arc's (R${round(c.r)}) on its inside`;
  return { kind: "circle", c: c.c, r };
}

/** Is q on the entity between its corner end (moved to q) and its other end, leaving it some length? */
function fits(e: Extract<SketchEntity, { type: "line" | "arc" }>, end: End, corner: Vec2, q: Vec2): boolean {
  const far = e[other(end)];
  if (e.type === "line") return dot2(sub2(q, far), sub2(corner, far)) > 10 * TOL * dist2(corner, far) && dist2(q, far) > 10 * TOL;
  const c = curveOf(e)!;
  const u = paramOf(c, q);
  const eps = (10 * TOL) / (dist2(e.start, e.center) * Math.abs((c as { sweep: number }).sweep));
  return u > eps && u < 1 - eps;
}

/** The relations on the old corner points, carried onto a virtual sharp (keep) or dropped. */
function carryCorner(state: SketchState, k: Corner, v: string | null): { constraints: Constraint[]; sharp: SketchEntity | null; holdSharp: Constraint[] } {
  const corner = new Set([`${k.a}.${k.aEnd}`, `${k.b}.${k.bEnd}`]);
  const lengthOf = new Map([
    [k.a, `${k.a}.${other(k.aEnd)}`],
    [k.b, `${k.b}.${other(k.bEnd)}`],
  ]);
  let used = false;
  const constraints = state.constraints.flatMap((c): Constraint[] => {
    // A line's length becomes the distance from its other end to the sharp.
    if (v && c.type === "distance" && c.entity && lengthOf.has(c.entity) && state.entities.find((e) => e.id === c.entity)?.type === "line") {
      used = true;
      return [{ type: "distance", points: [lengthOf.get(c.entity)!, `${v}.at`], value: c.value }];
    }
    const m = mapRefs(c, (ref) => (corner.has(ref) ? (v ? `${v}.at` : null) : ref));
    if (!m) return [];
    if (v && JSON.stringify(m) !== JSON.stringify(c) && !(m.type === "coincident" && m.points[0] === m.points[1])) used = true;
    return [m];
  });
  if (!v || !used) return { constraints: v ? constraints.filter((c) => !JSON.stringify(c).includes(`"${v}.at"`)) : constraints, sharp: null, holdSharp: [] };
  return {
    constraints,
    sharp: { id: v, type: "point", at: k.at, construction: true },
    holdSharp: [
      { type: "pointOn", point: `${v}.at`, entity: k.a },
      { type: "pointOn", point: `${v}.at`, entity: k.b },
    ],
  };
}

/** One fillet of radius r at the corner: the new state and the arc's id. */
function filletOne(state: SketchState, k: Corner, r: number, keep: boolean): { state: SketchState; arc: string; hard: Constraint[] } | string {
  const a = state.entities.find((e) => e.id === k.a);
  const b = state.entities.find((e) => e.id === k.b);
  if (!roundable(a) || !roundable(b)) return `the corner of ${k.a} and ${k.b} is not between lines or arcs`;
  for (const e of [a, b]) if (e.ref) return `${e.id} follows the model (a reference): it can't be trimmed for a fillet`;
  const da = away(a, k.aEnd);
  const db = away(b, k.bEnd);
  if (Math.abs(cross2(da, db)) < 1e-9) return `${a.id} and ${b.id} run on in line at ${pt(k.at)}: there is no corner to round`;
  // Each entity's normal at the corner, towards the other one: the fillet's centre is on that side of both.
  const towards = (d: Vec2, o: Vec2): Vec2 => {
    const n: Vec2 = [-d[1], d[0]];
    return dot2(n, o) >= 0 ? n : scale2(n, -1);
  };
  const ca = curveOf(a)!;
  const cb = curveOf(b)!;
  const oa = offsetCarrier(ca, k.at, towards(da, db), r);
  const ob = offsetCarrier(cb, k.at, towards(db, da), r);
  if (typeof oa === "string") return `${a.id}: ${oa}`;
  if (typeof ob === "string") return `${b.id}: ${ob}`;
  const centres = carrierMeet(oa, ob).sort((p, q) => dist2(p, k.at) - dist2(q, k.at));
  const o = centres[0];
  if (!o) return `no arc of radius ${round(r)} touches both ${a.id} and ${b.id}`;
  const ta = footOn(ca, o);
  const tb = footOn(cb, o);
  for (const [e, end, t] of [[a, k.aEnd, ta], [b, k.bEnd, tb]] as const) {
    if (!fits(e, end, k.at, t)) return `a radius of ${round(r)} is too big for ${e.id} (${e.type === "line" ? `${round(dist2(e.start, e.end))} mm long` : "the arc is too short"}): use a smaller radius`;
  }
  const ids = freshIds(state.entities);
  const arcId = ids("a");
  const ccw = cross2(sub2(ta, o), sub2(tb, o)) > 0;
  const fillet: SketchEntity = { id: arcId, type: "arc", center: o, start: ccw ? ta : tb, end: ccw ? tb : ta };
  const carried = carryCorner(state, k, keep ? ids("p") : null);
  const moved = [{ ...a, [k.aEnd]: ta } as SketchEntity, { ...b, [k.bEnd]: tb } as SketchEntity];
  const entities = [...replaced(state.entities, ...moved), fillet, ...(carried.sharp ? [carried.sharp] : [])];
  const hard: Constraint[] = [
    { type: "coincident", points: [`${a.id}.${k.aEnd}`, `${arcId}.${ccw ? "start" : "end"}`] },
    { type: "coincident", points: [`${b.id}.${k.bEnd}`, `${arcId}.${ccw ? "end" : "start"}`] },
    { type: "tangent", entities: [a.id, arcId] },
    { type: "tangent", entities: [b.id, arcId] },
    ...carried.holdSharp,
  ];
  return { state: { entities, constraints: [...carried.constraints, ...hard] }, arc: arcId, hard };
}

/**
 * Fillets of radius r at the corners, made at once: the first carries the
 * radius dimension, the others are equal to it. The corners come from
 * cornersOf.
 */
export function filletCorners(state: SketchState, corners: Corner[], r: number, opts: { keepCorners?: boolean } = {}): Edit | string {
  if (!(r > 0)) return "the radius must be more than 0";
  let s = state;
  const arcs: string[] = [];
  const hard: Constraint[] = [];
  for (const k of corners) {
    const done = filletOne(s, k, r, opts.keepCorners ?? true);
    if (typeof done === "string") return done;
    s = done.state;
    arcs.push(done.arc);
    hard.push(...done.hard);
  }
  const sizes: Constraint[] = arcs.map((id, i) => (i === 0 ? { type: "radius", entity: id, value: r } : { type: "equal", entities: [id, arcs[0]] }));
  const constraints = settle(s.entities, [...s.constraints, ...sizes], changedBy(corners, arcs, s), new Set([...hard, ...sizes]));
  return { entities: s.entities, constraints, made: arcs };
}

/** What a set of corner edits changed: the entities at the corners, what was made, and the virtual sharps. */
function changedBy(corners: Corner[], made: string[], s: SketchState): string[] {
  return [...corners.flatMap((k) => [k.a, k.b]), ...made, ...s.entities.filter((e) => e.type === "point" && e.construction).map((e) => e.id)];
}

export type ChamferMode = { kind: "distances"; d1: number; d2: number } | { kind: "angle"; d: number; angle: number };

/** One chamfer at the corner (lines only): the new state, its line, and the relations that hold it. */
function chamferOne(state: SketchState, k: Corner, mode: ChamferMode): { state: SketchState; line: string } | string {
  const a = state.entities.find((e) => e.id === k.a);
  const b = state.entities.find((e) => e.id === k.b);
  if (a?.type !== "line" || b?.type !== "line") return `a chamfer cuts a corner between two lines (${k.a} and ${k.b} are not both lines)`;
  for (const e of [a, b]) if (e.ref) return `${e.id} follows the model (a reference): it can't be trimmed for a chamfer`;
  const da = away(a, k.aEnd);
  const db = away(b, k.bEnd);
  const theta = Math.acos(Math.max(-1, Math.min(1, dot2(da, db))));
  if (theta < 1e-9 || Math.PI - theta < 1e-9) return `${a.id} and ${b.id} run on in line: there is no corner to cut`;
  let d1: number;
  let d2: number;
  if (mode.kind === "distances") [d1, d2] = [mode.d1, mode.d2];
  else {
    const alpha = (mode.angle * Math.PI) / 180;
    const beta = Math.PI - theta - alpha;
    if (!(alpha > 0) || beta <= 1e-9) return `an angle of ${round(mode.angle)}° can't cut this corner (it is ${round((theta * 180) / Math.PI)}°): use less than ${round(180 - (theta * 180) / Math.PI)}°`;
    d1 = mode.d;
    d2 = (mode.d * Math.sin(alpha)) / Math.sin(beta);
  }
  if (!(d1 > 0) || !(d2 > 0)) return "the chamfer distances must be more than 0";
  const pa = add2(k.at, scale2(da, d1));
  const pb = add2(k.at, scale2(db, d2));
  for (const [e, end, p, d] of [[a, k.aEnd, pa, d1], [b, k.bEnd, pb, d2]] as const) {
    if (!fits(e, end, k.at, p)) return `a chamfer of ${round(d)} is too big for ${e.id} (${round(dist2(e.start, e.end))} mm long): use less`;
  }
  const ids = freshIds(state.entities);
  const lineId = ids("l");
  // The chamfer's dimensions run from the corner: it always keeps a virtual sharp.
  const sharpId = ids("p");
  const carried = carryCorner(state, k, sharpId);
  const v = carried.sharp ?? { id: sharpId, type: "point" as const, at: k.at, construction: true };
  const holdSharp: Constraint[] = carried.sharp
    ? carried.holdSharp
    : [
        { type: "pointOn", point: `${v.id}.at`, entity: a.id },
        { type: "pointOn", point: `${v.id}.at`, entity: b.id },
      ];
  // The angle dimension reads as typed: the chamfer runs whichever way makes its angle to the first line the one asked for (not 180° less it).
  const angleTo = (from: Vec2, to: Vec2) => (Math.acos(Math.max(-1, Math.min(1, dot2(unit(sub2(to, from)), unit(sub2(a.end, a.start)))))) * 180) / Math.PI;
  const flip = mode.kind === "angle" && Math.abs(angleTo(pb, pa) - mode.angle) < Math.abs(angleTo(pa, pb) - mode.angle);
  const [startEnd, endEnd] = flip ? (["end", "start"] as const) : (["start", "end"] as const);
  const chamfer: SketchEntity = { id: lineId, type: "line", start: flip ? pb : pa, end: flip ? pa : pb };
  const entities = [...replaced(state.entities, { ...a, [k.aEnd]: pa }, { ...b, [k.bEnd]: pb }), chamfer, v];
  const between = flip ? angleTo(pb, pa) : angleTo(pa, pb);
  const dims: Constraint[] =
    mode.kind === "distances"
      ? [
          { type: "distance", points: [`${v.id}.at`, `${a.id}.${k.aEnd}`], value: d1 },
          { type: "distance", points: [`${v.id}.at`, `${b.id}.${k.bEnd}`], value: d2 },
        ]
      : [
          { type: "distance", points: [`${v.id}.at`, `${a.id}.${k.aEnd}`], value: d1 },
          { type: "angle", entities: [lineId, a.id], value: Math.round(between * 1e9) / 1e9 },
        ];
  const hard: Constraint[] = [
    { type: "coincident", points: [`${a.id}.${k.aEnd}`, `${lineId}.${startEnd}`] },
    { type: "coincident", points: [`${b.id}.${k.bEnd}`, `${lineId}.${endEnd}`] },
    ...holdSharp,
    ...dims,
  ];
  const constraints = settle(entities, [...carried.constraints, ...hard], [a.id, b.id, lineId, v.id], new Set(hard));
  return { state: { entities, constraints }, line: lineId };
}

/** Chamfers at the corners, each set back by two distances or by a distance and an angle (each a dimension from the corner's virtual sharp). */
export function chamferCorners(state: SketchState, corners: Corner[], mode: ChamferMode): Edit | string {
  let s = state;
  const lines: string[] = [];
  for (const k of corners) {
    const done = chamferOne(s, k, mode);
    if (typeof done === "string") return done;
    s = done.state;
    lines.push(done.line);
  }
  return { ...s, made: lines };
}

const unit = (v: Vec2): Vec2 => scale2(v, 1 / (Math.hypot(v[0], v[1]) || 1));

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function pt(p: Vec2): string {
  return `[${round(p[0])}, ${round(p[1])}]`;
}
