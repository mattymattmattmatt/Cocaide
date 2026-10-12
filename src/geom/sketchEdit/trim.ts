// Trim, extend and split, as SOLIDWORKS has them.
//
// - Trim to closest: click a piece of a line, arc or circle; it is cut away
//   back to the nearest places other entities cross or touch it. With
//   nothing crossing, the whole entity goes. A trimmed circle becomes an arc.
// - Power trim: drag across entities; each piece the pointer crosses goes.
// - Extend: click near an end of a line or arc; it grows to the next entity
//   it meets.
// - Split: click a point on an entity; it becomes two, joined there (a
//   circle splits into two half circles, at the click and opposite it).
//
// Relations: a trimmed end's relations go (that point is gone) and the end
// that lands on another entity is related to it (coincident with its end
// there, else on it). A piece cut out of the middle leaves two pieces: the
// first keeps the id and the relations on the entity as a whole (its line
// or circle), the second the old end's relations, and it is held collinear
// (a line) or on the same circle (an arc) with the first. Relations that no
// longer hold on what is left go. A rectangle or slot entity is exploded
// into lines and arcs first.

import type { Constraint, PairConstraint, SketchEntity, Vec2 } from "../../doc/types";
import { removeEntities } from "../../doc/sketch";
import { constraintTargets } from "../axes";
import { dist2 } from "../vec";
import { arcPiece, carrierMeet, curveOf, curvesOf, distanceTo, lengthOf, meet, paramOf, pointAt, sameCarrier, TOL, within, type Curve } from "./curve";
import { explode, explodable } from "./explode";
import { freshIds, mapRefs, pointNames, refsAt, replaced, settle, type Edit, type SketchState } from "./relations";

/** Where another entity crosses or touches an entity: the parameter there, and what is there. */
export interface Cut {
  t: number;
  p: Vec2;
  /** The entities there, each with its point there if it has one ("l2.end"). */
  by: { id: string; ref: string | null }[];
}

/**
 * Where the other entities cross or touch entity `id`, in order along it: on
 * the entity itself, or with `extended` anywhere along its line (extended)
 * or circle. Sketch points lying on it count; entities lying along it do not.
 */
export function cutsOf(entities: SketchEntity[], id: string, opts: { extended?: boolean } = {}): Cut[] {
  const e = entities.find((x) => x.id === id);
  const c = e && curveOf(e);
  if (!c) return [];
  const found: { t: number; p: Vec2; id: string; ref: string | null }[] = [];
  const add = (p: Vec2, other: SketchEntity) => {
    const t = paramOf(c, p);
    if (!opts.extended && !within(c, t)) return;
    const ref = refsAt([other], p, 10 * TOL)[0] ?? null;
    found.push({ t, p, id: other.id, ref });
  };
  for (const other of entities) {
    if (other.id === id) continue;
    if (other.type === "point") {
      if (Math.abs(distanceTo(asCarrier(c), other.at)) <= 10 * TOL) add(other.at, other);
      continue;
    }
    for (const oc of curvesOf(other)) {
      if (sameCarrier(c, oc)) continue;
      for (const p of carrierMeet(c, oc)) if (within(oc, paramOf(oc, p)) && distanceTo(oc, p) <= 10 * TOL) add(p, other);
    }
  }
  // One cut per place, naming everything there.
  found.sort((a, b) => a.t - b.t);
  const out: Cut[] = [];
  for (const f of found) {
    const last = out[out.length - 1];
    if (last && dist2(last.p, f.p) <= 10 * TOL) {
      if (!last.by.some((b) => b.id === f.id)) last.by.push({ id: f.id, ref: f.ref });
    } else out.push({ t: f.t, p: f.p, by: [{ id: f.id, ref: f.ref }] });
  }
  return out;
}

/** The curve's whole carrier (a line, extended, as a long line; an arc as its circle). */
function asCarrier(c: Curve): Curve {
  if (c.kind === "arc") return { kind: "circle", c: c.c, r: c.r };
  if (c.kind === "line") {
    const d: Vec2 = [c.b[0] - c.a[0], c.b[1] - c.a[1]];
    return { kind: "line", a: [c.a[0] - 1e6 * d[0], c.a[1] - 1e6 * d[1]], b: [c.b[0] + 1e6 * d[0], c.b[1] + 1e6 * d[1]] };
  }
  return c;
}

/** The relations that tie a new end (pointRef) to what it landed on. */
function landing(entities: SketchEntity[], pointRef: string, cut: Cut | undefined): Constraint[] {
  if (!cut) return [];
  return cut.by.flatMap((b): Constraint[] => {
    if (b.ref) return [{ type: "coincident", points: [pointRef, b.ref] }];
    const other = entities.find((e) => e.id === b.id);
    return other && (other.type === "line" || other.type === "arc" || other.type === "circle") ? [{ type: "pointOn", point: pointRef, entity: b.id }] : [];
  });
}

/** A piece of an entity's curve, from parameter `from` to `to` (a circle's may run past 1, round again). */
interface Span {
  from: number;
  to: number;
}

/**
 * Entity `id` cut down to the spans (in order along it; at least one). The
 * first keeps the id; the others get new ids. Returns the new state and the
 * ids of the pieces in span order. Relations are carried as the module
 * comment says; `extra` are added (they hold by construction).
 */
function cutInto(state: SketchState, id: string, spans: Span[], extra: (pieces: string[]) => Constraint[]): { state: SketchState; pieces: string[] } {
  const e = state.entities.find((x) => x.id === id)!;
  const c = curveOf(e)!;
  const ids = freshIds(state.entities);
  const pieces = spans.map((_, i) => (i === 0 ? id : ids(e.type === "line" ? "l" : "a")));
  const base = { ...(e.construction !== undefined ? { construction: e.construction } : {}), ...(e.ref ? { ref: e.ref } : {}) };
  const made: SketchEntity[] = spans.map((s, i) =>
    c.kind === "line" ? { id: pieces[i], type: "line", start: pointAt(c, s.from), end: pointAt(c, s.to), ...base } : { id: pieces[i], type: "arc", ...arcPiece(c, s.from, s.to), ...base },
  );
  // Where the old points went: the start stays with the piece that starts there, the end with the one that ends there.
  const near = (a: number, b: number) => Math.abs(a - b) * lengthOf(c) <= 10 * TOL;
  const moved = new Map<string, string | null>();
  if (c.kind !== "circle") {
    const first = spans.findIndex((s) => near(s.from, 0));
    const last = spans.findIndex((s) => near(s.to, 1));
    moved.set(`${id}.start`, first >= 0 ? `${pieces[first]}.start` : null);
    moved.set(`${id}.end`, last >= 0 ? `${pieces[last]}.end` : null);
  }
  const entities = [...state.entities.flatMap((x) => (x.id === id ? made : [x]))];
  let constraints = state.constraints.flatMap((k) => {
    const m = mapRefs(k, (ref) => (moved.has(ref) ? moved.get(ref)! : ref));
    return m ? [m] : [];
  });
  // A tangent to the entity follows the piece it is joined to, where that is another piece.
  constraints = constraints.map((k) => (k.type === "tangent" && k.entities.includes(id) ? retarget(k, id, pieces, constraints) : k));
  // The other pieces stay on the first piece's line or circle.
  const carrier: Constraint[] = pieces.slice(1).flatMap((p): Constraint[] =>
    c.kind === "line" ? [{ type: "collinear", entities: [id, p] }] : [{ type: "coincident", points: [`${p}.center`, `${id}.center`] }, { type: "equal", entities: [p, id] }],
  );
  const added = [...carrier, ...extra(pieces)];
  constraints = settle(entities, [...constraints, ...added], pieces, new Set(added));
  return { state: { entities, constraints }, pieces };
}

/** A tangent relation moved from `id` to whichever of its pieces the other entity is joined to by a coincident relation. */
function retarget(k: PairConstraint, id: string, pieces: string[], constraints: Constraint[]): Constraint {
  const other = k.entities[0] === id ? k.entities[1] : k.entities[0];
  const piece = pieces.find((p) =>
    constraints.some((j) => j.type === "coincident" && j.points.some((r) => r.startsWith(`${p}.`) && !r.endsWith(".center")) && j.points.some((r) => r.startsWith(`${other}.`))),
  );
  return piece && piece !== id ? { type: "tangent", entities: [piece, other] } : k;
}

/** Explodes a rectangle or slot, and returns the piece of it nearest p. */
function explodedAt(state: SketchState, id: string, p: Vec2): { state: SketchState; id: string } | string {
  const r = explode(state, id);
  if (typeof r === "string") return r;
  const pieces = r.entities.filter((e) => r.made!.includes(e.id) && !e.construction === !(state.entities.find((x) => x.id === id)!.construction ?? false));
  let best: string | null = null;
  let bestD = Infinity;
  for (const e of pieces) {
    const c = curveOf(e);
    if (!c) continue;
    const d = distanceTo(c, p);
    if (d < bestD) [best, bestD] = [e.id, d];
  }
  return best ? { state: r, id: best } : `${id} has nothing to trim`;
}

/** The entity, or why the tool can't take it. */
function editable(state: SketchState, id: string, what: string): SketchEntity | string {
  const e = state.entities.find((x) => x.id === id);
  if (!e) return `there is no entity "${id}"`;
  if (e.ref) return `${id} follows the model (a reference): it can't be ${what}; Convert Entities makes a copy that can`;
  if (e.type === "point") return `${id} is a point: there is nothing to ${what === "trimmed" ? "trim" : what === "extended" ? "extend" : "split"}`;
  return e;
}

/**
 * Trim to closest: the piece of entity `id` at p (a point on it) is cut away
 * back to the nearest crossings, or the whole entity goes when nothing
 * crosses it.
 */
export function trimAt(state: SketchState, id: string, p: Vec2): Edit | string {
  const e = editable(state, id, "trimmed");
  if (typeof e === "string") return e;
  if (explodable(e)) {
    const x = explodedAt(state, id, p);
    return typeof x === "string" ? x : trimAt(x.state, x.id, p);
  }
  const c = curveOf(e);
  if (!c) return `${id} has no length to trim`;
  const all = cutsOf(state.entities, id);
  const eps = (10 * TOL) / lengthOf(c);
  if (c.kind === "circle") {
    if (all.length < 2) return removed(state, id, all.length ? `${id} touched only one entity: it was deleted` : `${id} crossed nothing: it was deleted`);
    // Keep the rest of the circle: from the next cut round to the one before the click.
    const u = paramOf(c, p);
    let i = all.findIndex((x) => x.t > u);
    if (i < 0) i = 0;
    const after = all[i];
    const before = all[(i - 1 + all.length) % all.length];
    const to = before.t > after.t ? before.t : before.t + 1;
    const arc: SketchEntity = { id, type: "arc", ...arcPiece(c, after.t, to), ...(e.construction !== undefined ? { construction: e.construction } : {}) };
    const entities = replaced(state.entities, arc);
    const extra = [...landing(state.entities, `${id}.start`, after), ...landing(state.entities, `${id}.end`, before)];
    return { entities, constraints: settle(entities, state.constraints, [id]), soft: extra, made: [id] };
  }
  const cuts = all.filter((x) => x.t > eps && x.t < 1 - eps);
  if (!cuts.length) return removed(state, id, `${id} crossed nothing: it was deleted`);
  const u = Math.max(0, Math.min(1, paramOf(c, p)));
  const next = cuts.findIndex((x) => x.t > u);
  if (next === 0) {
    // The first piece goes: it now starts at the first cut.
    const r = cutInto(state, id, [{ from: cuts[0].t, to: 1 }], () => []);
    return { ...r.state, soft: landing(state.entities, `${id}.start`, cuts[0]), made: r.pieces };
  }
  if (next < 0) {
    const last = cuts[cuts.length - 1];
    const r = cutInto(state, id, [{ from: 0, to: last.t }], () => []);
    return { ...r.state, soft: landing(state.entities, `${id}.end`, last), made: r.pieces };
  }
  // A piece in the middle goes: two are left.
  const [a, b] = [cuts[next - 1], cuts[next]];
  const r = cutInto(state, id, [{ from: 0, to: a.t }, { from: b.t, to: 1 }], () => []);
  return { ...r.state, soft: [...landing(state.entities, `${id}.end`, a), ...landing(state.entities, `${r.pieces[1]}.start`, b)], made: r.pieces };
}

/** The entity deleted with its relations, as Delete does it (an offset relation only loses that entity's pair). */
function removed(state: SketchState, id: string, note: string): Edit {
  return { ...removeEntities(state.entities, state.constraints, [id]), made: [], note };
}

/** Which entities a stroke from a to b crosses, and where, in the order the stroke meets them. */
export function crossings(entities: SketchEntity[], a: Vec2, b: Vec2): { id: string; p: Vec2 }[] {
  if (dist2(a, b) < 1e-12) return [];
  const stroke: Curve = { kind: "line", a, b };
  const out: { id: string; p: Vec2; s: number }[] = [];
  for (const e of entities) {
    if (e.type === "point" || e.ref) continue;
    for (const c of curvesOf(e)) for (const p of meet(stroke, c)) out.push({ id: e.id, p, s: paramOf(stroke, p) });
  }
  return out.sort((x, y) => x.s - y.s).map(({ id, p }) => ({ id, p }));
}

/**
 * Power trim: the pointer was dragged along `path`; every piece it crossed
 * is trimmed away, in the order it crossed them. Returns the sketch after,
 * the relations to keep where they add something, and what was trimmed.
 */
export function powerTrim(state: SketchState, path: Vec2[]): Edit & { trimmed: string[] } {
  let s: SketchState = state;
  const soft: Constraint[] = [];
  const trimmed: string[] = [];
  for (let i = 1; i < path.length; i++) {
    for (const x of crossings(s.entities, path[i - 1], path[i])) {
      const e = s.entities.find((y) => y.id === x.id);
      // An earlier crossing of this stroke may have trimmed it already.
      if (!e || !curvesOf(e).some((c) => distanceTo(c, x.p) <= 1e-7)) continue;
      const r = trimAt(s, x.id, x.p);
      if (typeof r === "string") continue;
      s = r;
      soft.push(...(r.soft ?? []));
      if (!trimmed.includes(x.id)) trimmed.push(x.id);
    }
  }
  return { ...s, soft: soft.filter((k) => constraintTargets(k).every((id) => s.entities.some((e) => e.id === id))), trimmed, made: [] };
}

/** How an end of a line or arc would extend: which end, to where, and what it meets there. */
export function extension(state: SketchState, id: string, near: Vec2): { end: "start" | "end"; t: number; cut: Cut } | string {
  const e = editable(state, id, "extended");
  if (typeof e === "string") return e;
  if (e.type !== "line" && e.type !== "arc") return `${id} is a ${e.type}: only lines and arcs extend`;
  const c = curveOf(e);
  if (!c) return `${id} has no length to extend`;
  const end = dist2(near, e.start) < dist2(near, e.end) ? "start" : "end";
  const eps = (10 * TOL) / lengthOf(c);
  const cuts = cutsOf(state.entities, id, { extended: true });
  let best: { t: number; cut: Cut; how: number } | null = null;
  for (const cut of cuts) {
    let how: number; // how far past the end, along the curve
    let t = cut.t;
    if (c.kind === "line") {
      how = end === "end" ? t - 1 : -t;
    } else {
      const full = (2 * Math.PI) / Math.abs((c as { sweep: number }).sweep);
      if (t <= 1 + eps || t >= full - eps) continue;
      how = end === "end" ? t - 1 : full - t;
      if (end === "start") t = t - full;
    }
    if (how > eps && (!best || how < best.how)) best = { t, cut, how };
  }
  if (!best) return `${id}'s ${end} meets nothing if it is extended`;
  return { end, t: best.t, cut: best.cut };
}

/** The entity as Extend would leave it, for the preview; null when it can't extend. */
export function extended(state: SketchState, id: string, near: Vec2): SketchEntity | null {
  const x = extension(state, id, near);
  const e = state.entities.find((y) => y.id === id);
  if (typeof x === "string" || !e) return null;
  const c = curveOf(e)!;
  const p = pointAt(c, x.t);
  return { ...e, [x.end]: p } as SketchEntity;
}

/** Extend: the end of line or arc `id` nearer `near` grows to the next entity it meets. */
export function extendAt(state: SketchState, id: string, near: Vec2): Edit | string {
  const x = extension(state, id, near);
  if (typeof x === "string") return x;
  const e = extended(state, id, near)!;
  const entities = replaced(state.entities, e);
  // The end moved: what held it where it was goes, unless it still holds.
  const constraints = settle(entities, state.constraints, [id]);
  return { entities, constraints, soft: landing(state.entities, `${id}.${x.end}`, x.cut), made: [id] };
}

/** Split: entity `id` becomes two at p (a point on it), joined there. A circle splits at p and opposite p. */
export function splitAt(state: SketchState, id: string, p: Vec2): Edit | string {
  const e = editable(state, id, "split");
  if (typeof e === "string") return e;
  if (explodable(e)) {
    const x = explodedAt(state, id, p);
    return typeof x === "string" ? x : splitAt(x.state, x.id, p);
  }
  const c = curveOf(e);
  if (!c) return `${id} has no length to split`;
  const u = paramOf(c, p);
  if (c.kind === "circle") {
    const r = cutIntoCircle(state, e as Extract<SketchEntity, { type: "circle" }>, u);
    return { ...r, made: r.made };
  }
  const eps = (10 * TOL) / lengthOf(c);
  if (!(u > eps && u < 1 - eps)) return `click inside ${id}, away from its ends: an end is already where it divides`;
  const r = cutInto(state, id, [{ from: 0, to: u }, { from: u, to: 1 }], (pieces) => [{ type: "coincident", points: [`${pieces[0]}.end`, `${pieces[1]}.start`] }]);
  return { ...r.state, made: r.pieces };
}

/** A circle split into two half circles, at parameter u and opposite it, joined at both. */
function cutIntoCircle(state: SketchState, e: Extract<SketchEntity, { type: "circle" }>, u: number): Edit {
  const c = curveOf(e) as Extract<Curve, { kind: "circle" }>;
  const id2 = freshIds(state.entities)("a");
  const base = e.construction !== undefined ? { construction: e.construction } : {};
  const a: SketchEntity = { id: e.id, type: "arc", ...arcPiece(c, u, u + 0.5), ...base };
  const b: SketchEntity = { id: id2, type: "arc", ...arcPiece(c, u + 0.5, u + 1), ...base };
  const entities = state.entities.flatMap((x) => (x.id === e.id ? [a, b] : [x]));
  const added: Constraint[] = [
    { type: "coincident", points: [`${e.id}.end`, `${id2}.start`] },
    { type: "coincident", points: [`${id2}.end`, `${e.id}.start`] },
    { type: "coincident", points: [`${id2}.center`, `${e.id}.center`] },
    { type: "equal", entities: [id2, e.id] },
  ];
  return { entities, constraints: settle(entities, [...state.constraints, ...added], [e.id, id2], new Set(added)), made: [e.id, id2] };
}

/** The entity under p (within tol) that trim, extend and split can take: the nearest. */
export function editableAt(entities: SketchEntity[], p: Vec2, tol: number): string | null {
  let best: string | null = null;
  let bestD = tol;
  for (const e of entities) {
    if (e.type === "point" || e.ref) continue;
    for (const c of curvesOf(e)) {
      const d = distanceTo(c, p);
      if (d <= bestD) [best, bestD] = [e.id, d];
    }
  }
  return best;
}

/** The piece Trim would take away at p, as a polyline-able entity (for the hover preview); null when it would take nothing. */
export function trimPreview(state: SketchState, id: string, p: Vec2): SketchEntity | null {
  const e = state.entities.find((x) => x.id === id);
  if (!e || e.type === "point" || e.ref) return null;
  let s: SketchState = state;
  let target = id;
  if (explodable(e)) {
    const x = explodedAt(state, id, p);
    if (typeof x === "string") return null;
    s = x.state;
    target = x.id;
  }
  const t = s.entities.find((x) => x.id === target)!;
  const c = curveOf(t);
  if (!c) return null;
  const all = cutsOf(s.entities, target);
  if (c.kind === "circle") {
    if (all.length < 2) return t;
    const u = paramOf(c, p);
    let i = all.findIndex((x) => x.t > u);
    if (i < 0) i = 0;
    const before = all[(i - 1 + all.length) % all.length];
    const after = all[i];
    return { id: "trim-preview", type: "arc", ...arcPiece(c, before.t, after.t > before.t ? after.t : after.t + 1) };
  }
  const eps = (10 * TOL) / lengthOf(c);
  const cuts = [0, ...all.filter((x) => x.t > eps && x.t < 1 - eps).map((x) => x.t), 1];
  const u = Math.max(0, Math.min(1, paramOf(c, p)));
  const i = Math.max(1, cuts.findIndex((x) => x > u));
  const [from, to] = [cuts[i - 1], cuts[i]];
  return c.kind === "line" ? { id: "trim-preview", type: "line", start: pointAt(c, from), end: pointAt(c, to) } : { id: "trim-preview", type: "arc", ...arcPiece(c, from, to) };
}

export { pointNames };
