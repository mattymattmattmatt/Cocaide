// Linear and circular sketch patterns, as CAD users expect them: copies of the
// picked entities (the seed) in a row, or round a centre; instances can be
// skipped. Each copy is equal to its seed entity (a line parallel to it too)
// and keeps the seed's own relations. One dimension drives the spacing:
//
// - Linear: a chain of construction lines runs from the seed's key point (a
//   circle's or arc's centre, a line's start, a point) through every place,
//   skipped ones too: the lines collinear and equal to the first, whose
//   length is the spacing dimension; its direction level, plumb, or an angle
//   dimension to the X axis.
// - Circular: construction spokes from the centre to every place, equal to
//   the first; equal construction chords between neighbouring places keep
//   the steps equal; the angle between the first two spokes is the angle
//   dimension.
//
// Editing the spacing (or the angle) moves every copy at once.

import type { Constraint, SketchEntity, Vec2 } from "../../doc/types";
import { isAxisId } from "../axes";
import { add2, dist2, polar, sub2 } from "../vec";
import { TOL } from "./curve";
import { explodeAll } from "./explode";
import { freshIds, mapRefs, pointAtRef, PREFIX, settle, type Edit, type SketchState } from "./relations";

export interface LinearPatternOptions {
  /** Instances, the seed included (2 or more). */
  count: number;
  /** Centre to centre, mm. */
  spacing: number;
  /** The row's direction, degrees anticlockwise from the sketch's x. */
  angle: number;
  /** Instance numbers left out (the seed is 1). */
  skip?: number[];
}

export interface CircularPatternOptions {
  count: number;
  /** The centre: a point ref ("origin", "c1.center", "p2.at"). */
  center: string;
  /** Degrees the instances span (360: all the way round, equally spaced). Negative turns clockwise. */
  total: number;
  skip?: number[];
}

/** A transformation of the plane, applied to every point of a copy. */
type Move = (p: Vec2) => Vec2;

/** The point a pattern's places are measured to: a circle's or arc's centre, a line's start, a point. */
function keyRef(e: SketchEntity): string {
  if (e.type === "circle" || e.type === "arc" || e.type === "rect") return `${e.id}.center`;
  if (e.type === "line") return `${e.id}.start`;
  if (e.type === "slot") return `${e.id}.center1`;
  return `${e.id}.at`;
}

/** The entity moved; `scaleRadius` is never needed (patterns are rigid). An arc turns with its ends, so its direction stays. */
function moved(e: SketchEntity, f: Move, id: string): SketchEntity {
  const base = e.construction !== undefined ? { construction: e.construction } : {};
  switch (e.type) {
    case "line":
      return { id, type: "line", start: f(e.start), end: f(e.end), ...base };
    case "circle":
      return { id, type: "circle", center: f(e.center), radius: e.radius, ...base };
    case "arc":
      return { id, type: "arc", center: f(e.center), start: f(e.start), end: f(e.end), ...(e.clockwise ? { clockwise: true } : {}), ...base };
    case "point":
      return { id, type: "point", at: f(e.at), ...base };
    case "rect":
      return { id, type: "rect", center: f(e.center), w: e.w, h: e.h, ...base };
    case "slot":
      return { id, type: "slot", center1: f(e.center1), center2: f(e.center2), width: e.width, ...base };
  }
}

/** The seed: the picked entities (rectangles and slots exploded), checked. */
function seedOf(stateIn: SketchState, ids: string[]): { state: SketchState; seed: SketchEntity[] } | string {
  if (!ids.length) return "pick the entities to pattern";
  for (const id of ids) {
    const e = stateIn.entities.find((x) => x.id === id);
    if (!e) return `there is no entity "${id}"`;
    if (e.ref) return `${id} follows the model (a reference): Convert Entities copies it first, then pattern the copy`;
  }
  const { state, ids: pieces } = explodeAll(stateIn, ids);
  const seed = pieces.map((id) => state.entities.find((e) => e.id === id)!).filter(Boolean);
  return { state, seed };
}

/** Which instances (2..count) are made. */
function instances(count: number, skip: number[] = []): number[] {
  const out: number[] = [];
  for (let k = 2; k <= count; k++) if (!skip.includes(k)) out.push(k);
  return out;
}

/**
 * The copies, one per instance: each seed entity moved, its relations to
 * the seed (equal, and parallel for a line), and the seed's own relations
 * among its entities copied (kept where they add something). Returns the
 * entities made, the hard and soft relations, and each instance's key point.
 */
function copies(state: SketchState, seed: SketchEntity[], moves: Map<number, Move>, fresh: (p: string) => string) {
  const made: SketchEntity[] = [];
  const hard: Constraint[] = [];
  const soft: Constraint[] = [];
  const keys = new Map<number, string>();
  const seedIds = new Set(seed.map((e) => e.id));
  const own = state.constraints.filter((k) => {
    const named = [...("points" in k && k.points ? k.points : []), ...("point" in k && k.point ? [k.point] : [])].map((r) => r.split(".")[0]);
    const ents = [...("entity" in k && k.entity ? [k.entity] : []), ...("entities" in k && k.entities ? k.entities : []), ...("line" in k && k.line ? [k.line] : [])];
    const all = [...named, ...ents].filter((id) => id !== "origin" && !isAxisId(id));
    // The seed's relations among its own entities; not its dimensions (equal to the seed carries the sizes).
    return all.length > 0 && all.every((id) => seedIds.has(id)) && !("value" in k) && k.type !== "fix";
  });
  for (const [k, f] of moves) {
    const ids = new Map<string, string>();
    for (const e of seed) {
      const c = moved(e, f, fresh(PREFIX[e.type]));
      ids.set(e.id, c.id);
      made.push(c);
      if (e.type === "line" || e.type === "arc" || e.type === "circle") hard.push({ type: "equal", entities: [c.id, e.id] });
      if (e.type === "line") soft.push({ type: "parallel", entities: [c.id, e.id] });
    }
    keys.set(k, `${ids.get(seed[0].id)}${keyRef(seed[0]).slice(seed[0].id.length)}`);
    for (const r of own) {
      const m = mapRefs(
        r,
        (ref) => {
          const [owner, name] = ref.split(".");
          return ids.has(owner) ? `${ids.get(owner)}.${name}` : ref;
        },
        (id) => ids.get(id) ?? id,
      );
      if (m) soft.push(m);
    }
  }
  return { made, hard, soft, keys };
}

/** A linear sketch pattern of the picked entities. */
export function linearPattern(stateIn: SketchState, ids: string[], opts: LinearPatternOptions): Edit | string {
  const count = Math.round(opts.count);
  if (!(count >= 2)) return "a pattern needs 2 instances or more (the seed is the first)";
  if (!(opts.spacing > 0)) return "the spacing must be more than 0";
  const s = seedOf(stateIn, ids);
  if (typeof s === "string") return s;
  const { state, seed } = s;
  const a = (opts.angle * Math.PI) / 180;
  const step: Vec2 = [opts.spacing * Math.cos(a), opts.spacing * Math.sin(a)];
  const made = instances(count, opts.skip);
  if (!made.length) return "every instance is skipped: there is nothing to make";
  const fresh = freshIds(state.entities);
  const moves = new Map(made.map((k): [number, Move] => [k, (p) => [p[0] + (k - 1) * step[0], p[1] + (k - 1) * step[1]]]));
  const c = copies(state, seed, moves, fresh);
  // The construction chain through every place.
  const key = pointAtRef(state.entities, keyRef(seed[0]))!;
  const chain: SketchEntity[] = [];
  const rel: Constraint[] = [];
  for (let k = 1; k < count; k++) {
    const id = fresh("l");
    chain.push({ id, type: "line", start: add2(key, [(k - 1) * step[0], (k - 1) * step[1]]), end: add2(key, [k * step[0], k * step[1]]), construction: true });
    rel.push(k === 1 ? { type: "coincident", points: [`${id}.start`, keyRef(seed[0])] } : { type: "coincident", points: [`${id}.start`, `${chain[k - 2].id}.end`] });
    if (k > 1) rel.push({ type: "collinear", entities: [id, chain[0].id] }, { type: "equal", entities: [id, chain[0].id] });
    if (c.keys.has(k + 1)) rel.push({ type: "coincident", points: [`${id}.end`, c.keys.get(k + 1)!] });
  }
  const first = chain[0].id;
  const deg = ((opts.angle % 360) + 360) % 360;
  const near = (x: number) => Math.abs(deg - x) < 1e-9;
  rel.push({ type: "distance", entity: first, value: opts.spacing });
  if (near(0) || near(180) || near(360)) rel.push({ type: "horizontal", entity: first });
  else if (near(90) || near(270)) rel.push({ type: "vertical", entity: first });
  else rel.push({ type: "angle", entities: [first, "X"], value: Math.round(Math.acos(Math.cos(a)) * (180 / Math.PI) * 1e9) / 1e9 });
  return finish(state, [...c.made, ...chain], [...c.hard, ...rel], c.soft);
}

/** A circular sketch pattern of the picked entities round a centre point. */
export function circularPattern(stateIn: SketchState, ids: string[], opts: CircularPatternOptions): Edit | string {
  const count = Math.round(opts.count);
  if (!(count >= 2)) return "a pattern needs 2 instances or more (the seed is the first)";
  if (!opts.total || Math.abs(opts.total) > 360) return "the total angle must be over 0° and at most 360°";
  const s = seedOf(stateIn, ids);
  if (typeof s === "string") return s;
  const { state, seed } = s;
  const centre = pointAtRef(state.entities, opts.center);
  if (!centre) return `there is no point ${opts.center} to pattern round`;
  const full = Math.abs(Math.abs(opts.total) - 360) < 1e-9;
  const stepDeg = full ? opts.total / count : opts.total / (count - 1);
  const step = (stepDeg * Math.PI) / 180;
  const key = pointAtRef(state.entities, keyRef(seed[0]))!;
  const r = dist2(key, centre);
  if (r <= TOL) return `the seed's ${keyRef(seed[0])} is on the centre: it would not move; pick another centre`;
  const made = instances(count, opts.skip);
  if (!made.length) return "every instance is skipped: there is nothing to make";
  const fresh = freshIds(state.entities);
  const turn = (k: number): Move => {
    const t = (k - 1) * step;
    const [cos, sin] = [Math.cos(t), Math.sin(t)];
    return (p) => {
      const d = sub2(p, centre);
      return [centre[0] + d[0] * cos - d[1] * sin, centre[1] + d[0] * sin + d[1] * cos];
    };
  };
  const c = copies(state, seed, new Map(made.map((k) => [k, turn(k)])), fresh);
  const a0 = Math.atan2(key[1] - centre[1], key[0] - centre[0]);
  const spokes: SketchEntity[] = [];
  const rel: Constraint[] = [];
  const at = (k: number) => polar(centre, r, a0 + (k - 1) * step);
  for (let k = 1; k <= count; k++) {
    const id = fresh("l");
    spokes.push({ id, type: "line", start: centre, end: at(k), construction: true });
    rel.push({ type: "coincident", points: [`${id}.start`, opts.center] });
    if (k === 1) rel.push({ type: "coincident", points: [`${id}.end`, keyRef(seed[0])] });
    else {
      rel.push({ type: "equal", entities: [id, spokes[0].id] });
      if (c.keys.has(k)) rel.push({ type: "coincident", points: [`${id}.end`, c.keys.get(k)!] });
    }
  }
  // Equal chords between neighbouring places keep the steps equal; one angle dimension drives them.
  const chords: SketchEntity[] = [];
  for (let k = 1; k < count; k++) {
    if (count === 2) break;
    const id = fresh("l");
    chords.push({ id, type: "line", start: at(k), end: at(k + 1), construction: true });
    rel.push({ type: "coincident", points: [`${id}.start`, `${spokes[k - 1].id}.end`] }, { type: "coincident", points: [`${id}.end`, `${spokes[k].id}.end`] });
    if (k > 1) rel.push({ type: "equal", entities: [id, chords[0].id] });
  }
  // The angle between the first two spokes as an angle relation reads it (0° to 180°: a step over 180° is 360° less it); a half turn holds them in line.
  const turned = Math.abs(stepDeg);
  const angle = turned > 180 ? 360 - turned : turned;
  if (Math.abs(angle - 180) < 1e-9) rel.push({ type: "collinear", entities: [spokes[0].id, spokes[1].id] });
  else if (angle > 1e-9) rel.push({ type: "angle", entities: [spokes[0].id, spokes[1].id], value: Math.round(angle * 1e9) / 1e9 });
  // Hold the spokes where they are against the centre spinning the pattern: nothing; the seed's own position does that.
  return finish(state, [...c.made, ...spokes, ...chords], [...c.hard, ...rel], c.soft);
}

function finish(state: SketchState, made: SketchEntity[], hard: Constraint[], soft: Constraint[]): Edit {
  const entities = [...state.entities, ...made];
  return { entities, constraints: settle(entities, [...state.constraints, ...hard], made.map((e) => e.id), new Set(hard)), soft, made: made.filter((e) => !e.construction || e.type !== "line").map((e) => e.id) };
}

/** Where each instance would go, for the preview and for picking an instance to skip: its number and key point. */
export function patternPlaces(state: SketchState, ids: string[], kind: "linear" | "circular", opts: LinearPatternOptions | CircularPatternOptions): { k: number; at: Vec2 }[] {
  const first = state.entities.find((e) => e.id === ids[0]);
  if (!first) return [];
  const key = pointAtRef(state.entities, keyRef(first));
  if (!key) return [];
  const out: { k: number; at: Vec2 }[] = [];
  const count = Math.round(opts.count);
  if (kind === "linear") {
    const o = opts as LinearPatternOptions;
    const a = (o.angle * Math.PI) / 180;
    for (let k = 2; k <= count; k++) out.push({ k, at: [key[0] + (k - 1) * o.spacing * Math.cos(a), key[1] + (k - 1) * o.spacing * Math.sin(a)] });
  } else {
    const o = opts as CircularPatternOptions;
    const centre = pointAtRef(state.entities, o.center);
    if (!centre) return [];
    const full = Math.abs(Math.abs(o.total) - 360) < 1e-9;
    const step = ((full ? o.total / count : o.total / (count - 1)) * Math.PI) / 180;
    const r = dist2(key, centre);
    const a0 = Math.atan2(key[1] - centre[1], key[0] - centre[0]);
    for (let k = 2; k <= count; k++) out.push({ k, at: polar(centre, r, a0 + (k - 1) * step) });
  }
  return out;
}
