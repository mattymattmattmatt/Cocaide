// 2D sketch constraint solver.
//
// Every number that defines an entity is an unknown; every constraint is one
// or two equations that must be zero. Newton steps with the minimum-norm
// update (dx = -Jᵀ(JJᵀ + λI)⁻¹ r) move the sketch as little as possible, so
// typing a dimension changes what it must and leaves the rest alone. Dragging
// pins the dragged handle to the cursor and solves the rest around it.
//
// The document still stores solved geometry: the rebuild checks constraints,
// it does not solve them. This module is what keeps the two in step.

import type { Constraint, SketchEntity, Vec2 } from "../doc/types";

const TOL = 1e-9;
/** Accepting tolerance; the rebuild checks constraints to 1e-6. */
const ACCEPT = 1e-7;

/**
 * A draggable handle: any point ref ("l1.end", "r1.center", "p1.at"), or
 * "<rect>.corner0".."corner3", "<circle>.edge" (sets the radius) and
 * "<entity>.body" (moves the whole entity).
 */
export type HandleRef = string;

export interface SolveOptions {
  /** Pin handles to these positions (a drag). */
  drag?: { handle: HandleRef; to: Vec2; from?: Vec2 }[];
  /**
   * Numbers that must not move: "r1.w", or "l1.start" (both coordinates), or
   * "l1.start.1" (one coordinate). Used for fields driven by expressions.
   */
  fixed?: string[];
}

export type SolveResult =
  | { ok: true; entities: SketchEntity[]; dof: number }
  | { ok: false; error: string };

type Fn = (x: Float64Array) => number;

interface Layout {
  x: Float64Array;
  /** "id.field" -> index of its first number. */
  at: Map<string, number>;
  entities: SketchEntity[];
}

const FIELDS: Record<SketchEntity["type"], [string, 1 | 2][]> = {
  line: [["start", 2], ["end", 2]],
  circle: [["center", 2], ["radius", 1]],
  arc: [["center", 2], ["start", 2], ["end", 2]],
  rect: [["center", 2], ["w", 1], ["h", 1]],
  slot: [["center1", 2], ["center2", 2], ["width", 1]],
  point: [["at", 2]],
};

function layout(entities: SketchEntity[]): Layout {
  const values: number[] = [];
  const at = new Map<string, number>();
  for (const e of entities) {
    for (const [field, n] of FIELDS[e.type]) {
      at.set(`${e.id}.${field}`, values.length);
      const v = (e as unknown as Record<string, number | Vec2>)[field];
      if (n === 1) values.push(v as number);
      else values.push(...(v as Vec2));
    }
  }
  return { x: Float64Array.from(values), at, entities };
}

function unpack(l: Layout, x: Float64Array): SketchEntity[] {
  return l.entities.map((e) => {
    const out = structuredClone(e) as unknown as Record<string, unknown>;
    for (const [field, n] of FIELDS[e.type]) {
      const i = l.at.get(`${e.id}.${field}`)!;
      out[field] = n === 1 ? x[i] : [x[i], x[i + 1]];
    }
    return out as unknown as SketchEntity;
  });
}

/** Accessor for a point ref: returns functions reading its x and y. */
function pointOf(l: Layout, ref: string): [Fn, Fn] {
  if (ref === "origin") return [() => 0, () => 0];
  const i = l.at.get(ref);
  if (i === undefined) throw new Error(`unknown point ${ref}`);
  return [(x) => x[i], (x) => x[i + 1]];
}

const len = (ax: Fn, ay: Fn, bx: Fn, by: Fn): Fn => (x) => Math.hypot(bx(x) - ax(x), by(x) - ay(x));

function entityById(l: Layout, id: string): SketchEntity {
  return l.entities.find((e) => e.id === id)!;
}

/** The two points a distance on an entity measures between. */
function span(l: Layout, id: string): [[Fn, Fn], [Fn, Fn]] {
  const e = entityById(l, id);
  return e.type === "slot" ? [pointOf(l, `${id}.center1`), pointOf(l, `${id}.center2`)] : [pointOf(l, `${id}.start`), pointOf(l, `${id}.end`)];
}

function radiusOf(l: Layout, id: string): Fn {
  const e = entityById(l, id);
  if (e.type === "circle") {
    const i = l.at.get(`${id}.radius`)!;
    return (x) => x[i];
  }
  const [cx, cy] = pointOf(l, `${id}.center`);
  const [sx, sy] = pointOf(l, `${id}.start`);
  return len(cx, cy, sx, sy);
}

/** Equations for the constraints plus the ones built into entities. */
function equations(l: Layout, constraints: Constraint[]): { fns: Fn[]; owners: number[] } {
  const fns: Fn[] = [];
  const owners: number[] = []; // constraint index per equation, -1 for built-in
  const push = (owner: number, ...f: Fn[]) => {
    fns.push(...f);
    for (let k = 0; k < f.length; k++) owners.push(owner);
  };
  const x0 = l.x;
  const sign = (f: Fn) => (f(x0) < 0 ? -1 : 1);
  const joined = coincidentGroups(constraints);

  for (const e of l.entities) {
    if (e.type === "arc") {
      const [cx, cy] = pointOf(l, `${e.id}.center`);
      const [sx, sy] = pointOf(l, `${e.id}.start`);
      const [ex, ey] = pointOf(l, `${e.id}.end`);
      const rs = len(cx, cy, sx, sy);
      const re = len(cx, cy, ex, ey);
      push(-1, (x) => rs(x) - re(x));
    }
  }

  constraints.forEach((k, i) => {
    switch (k.type) {
      case "coincident": {
        const [px, py] = pointOf(l, k.points[0]);
        const [qx, qy] = pointOf(l, k.points[1]);
        push(i, (x) => px(x) - qx(x), (x) => py(x) - qy(x));
        break;
      }
      case "horizontal":
      case "vertical": {
        const [[ax, ay], [bx, by]] = k.entity ? span(l, k.entity) : [pointOf(l, k.points![0]), pointOf(l, k.points![1])];
        push(i, k.type === "horizontal" ? (x) => by(x) - ay(x) : (x) => bx(x) - ax(x));
        break;
      }
      case "distance":
      case "distanceX":
      case "distanceY": {
        if (k.line !== undefined) {
          const d = offsetFrom(l, k.line, pointOf(l, k.point!));
          if (k.value === 0) push(i, d);
          else {
            const s = sign(d);
            push(i, (x) => s * d(x) - k.value);
          }
          break;
        }
        const target = k.entity ? entityById(l, k.entity) : null;
        if (target?.type === "rect") {
          const idx = l.at.get(`${k.entity}.${k.type === "distanceX" ? "w" : "h"}`)!;
          push(i, (x) => x[idx] - k.value);
          break;
        }
        const [[ax, ay], [bx, by]] = k.entity ? span(l, k.entity) : [pointOf(l, k.points![0]), pointOf(l, k.points![1])];
        if (k.type === "distance") {
          if (k.value === 0) push(i, (x) => bx(x) - ax(x), (x) => by(x) - ay(x));
          else {
            const d = len(ax, ay, bx, by);
            push(i, (x) => d(x) - k.value);
          }
        } else {
          const delta: Fn = k.type === "distanceX" ? (x) => bx(x) - ax(x) : (x) => by(x) - ay(x);
          const s = sign(delta); // keep the current side; the check uses the absolute value
          push(i, (x) => s * delta(x) - k.value);
        }
        break;
      }
      case "radius":
      case "diameter": {
        const r = radiusOf(l, k.entity);
        const f = k.type === "diameter" ? 2 : 1;
        push(i, (x) => f * r(x) - k.value);
        break;
      }
      case "equal": {
        const size = (id: string): Fn => {
          const e = entityById(l, id);
          if (e.type === "line") {
            const [[ax, ay], [bx, by]] = span(l, id);
            return len(ax, ay, bx, by);
          }
          return radiusOf(l, id);
        };
        const a = size(k.entities[0]);
        const b = size(k.entities[1]);
        push(i, (x) => a(x) - b(x));
        break;
      }
      case "parallel":
      case "perpendicular": {
        // The sine (parallel) or cosine (perpendicular) of the angle between them: scaled, so long and short lines weigh alike.
        const [ux, uy] = direction(l, k.entities[0]);
        const [vx, vy] = direction(l, k.entities[1]);
        push(
          i,
          k.type === "parallel"
            ? (x) => (ux(x) * vy(x) - uy(x) * vx(x)) / (Math.hypot(ux(x), uy(x)) * Math.hypot(vx(x), vy(x)))
            : (x) => (ux(x) * vx(x) + uy(x) * vy(x)) / (Math.hypot(ux(x), uy(x)) * Math.hypot(vx(x), vy(x))),
        );
        break;
      }
      case "collinear": {
        const [[ax, ay], [bx, by]] = span(l, k.entities[1]);
        push(i, offsetFrom(l, k.entities[0], [ax, ay]), offsetFrom(l, k.entities[0], [bx, by]));
        break;
      }
      case "angle": {
        // Signed, keeping the side the lines are on now; the check reads it unsigned.
        const [ux, uy] = direction(l, k.entities[0]);
        const [vx, vy] = direction(l, k.entities[1]);
        const theta: Fn = (x) => Math.atan2(ux(x) * vy(x) - uy(x) * vx(x), ux(x) * vx(x) + uy(x) * vy(x));
        const s = sign(theta);
        const want = (k.value * Math.PI) / 180;
        push(i, (x) => s * theta(x) - want);
        break;
      }
      case "tangent": {
        const [a, b] = k.entities.map((id) => entityById(l, id));
        // Joined end to end (a slot's sides, a tangent arc off a line), the touching point is that end: the
        // radius there is square to the line, or in line with the other arc's. Distance-equals-radius would
        // only hold there to second order, and the solver could neither count it nor converge on it.
        const shared = sharedEnd(a, b, joined);
        if (shared) {
          push(i, shared.round2 ? radiiInLine(l, shared.round, shared.at, shared.round2, shared.at2!) : radiusSquareTo(l, shared.round, shared.at, shared.line!));
          break;
        }
        if (a.type === "line" || b.type === "line") {
          const [line, round] = a.type === "line" ? [a, b] : [b, a];
          const d = offsetFrom(l, line.id, pointOf(l, `${round.id}.center`));
          const r = radiusOf(l, round.id);
          const s = sign(d);
          push(i, (x) => s * d(x) - r(x));
          break;
        }
        // Two circles or arcs: touching outside or inside, whichever they are nearer now.
        const [cx, cy] = pointOf(l, `${a.id}.center`);
        const [dx, dy] = pointOf(l, `${b.id}.center`);
        const D = len(cx, cy, dx, dy);
        const ra = radiusOf(l, a.id);
        const rb = radiusOf(l, b.id);
        const inside = Math.abs(D(x0) - Math.abs(ra(x0) - rb(x0))) < Math.abs(D(x0) - (ra(x0) + rb(x0)));
        if (inside) {
          const s = ra(x0) >= rb(x0) ? 1 : -1;
          push(i, (x) => D(x) - s * (ra(x) - rb(x)));
        } else push(i, (x) => D(x) - ra(x) - rb(x));
        break;
      }
      case "concentric": {
        const [px, py] = pointOf(l, `${k.entities[0]}.center`);
        const [qx, qy] = pointOf(l, `${k.entities[1]}.center`);
        push(i, (x) => px(x) - qx(x), (x) => py(x) - qy(x));
        break;
      }
      case "midpoint": {
        const [px, py] = pointOf(l, k.point);
        const [[ax, ay], [bx, by]] = span(l, k.entity);
        push(i, (x) => px(x) - (ax(x) + bx(x)) / 2, (x) => py(x) - (ay(x) + by(x)) / 2);
        break;
      }
      case "pointOn": {
        const p = pointOf(l, k.point);
        const e = entityById(l, k.entity);
        if (e.type === "line") push(i, offsetFrom(l, k.entity, p));
        else {
          const [cx, cy] = pointOf(l, `${k.entity}.center`);
          const d = len(cx, cy, p[0], p[1]);
          const r = radiusOf(l, k.entity);
          push(i, (x) => d(x) - r(x));
        }
        break;
      }
      case "symmetric": {
        // The midpoint of the two points is on the line, and the line between them crosses it square.
        const [px, py] = pointOf(l, k.points[0]);
        const [qx, qy] = pointOf(l, k.points[1]);
        const [ux, uy] = direction(l, k.line);
        const mid = offsetFrom(l, k.line, [(x) => (px(x) + qx(x)) / 2, (x) => (py(x) + qy(x)) / 2]);
        push(i, mid, (x) => ((qx(x) - px(x)) * ux(x) + (qy(x) - py(x)) * uy(x)) / Math.hypot(ux(x), uy(x)));
        break;
      }
      case "fix": {
        // Held at the numbers the solve starts from: the document's.
        const refs = k.entity ? FIELDS[entityById(l, k.entity).type].map(([field]) => `${k.entity}.${field}`) : [k.point!];
        for (const ref of refs) {
          const at = l.at.get(ref);
          if (at === undefined) continue;
          const width = ref === k.point ? 2 : FIELDS[entityById(l, ref.split(".")[0]).type].find(([f]) => f === ref.split(".")[1])![1];
          for (let c = 0; c < width; c++) {
            const v = x0[at + c];
            push(i, (x) => x[at + c] - v);
          }
        }
        break;
      }
    }
  });
  return { fns, owners };
}

/** Point refs joined by coincident relations, each mapped to one ref that stands for its group. */
function coincidentGroups(constraints: Constraint[]): (a: string, b: string) => boolean {
  const parent = new Map<string, string>();
  const find = (r: string): string => {
    let p = parent.get(r) ?? r;
    while (p !== (parent.get(p) ?? p)) p = parent.get(p)!;
    return p;
  };
  for (const k of constraints) if (k.type === "coincident") parent.set(find(k.points[0]), find(k.points[1]));
  return (a, b) => a === b || find(a) === find(b);
}

/**
 * Where a line and an arc, or two arcs, are joined end to end by coincident
 * relations: the arc end (and the line, or the other arc and its end) that
 * meet. Null when they aren't (a circle has no ends).
 */
function sharedEnd(
  a: SketchEntity,
  b: SketchEntity,
  joined: (p: string, q: string) => boolean,
): { round: string; at: string; line?: string; round2?: string; at2?: string } | null {
  const ends = (e: SketchEntity) => (e.type === "line" || e.type === "arc" ? [`${e.id}.start`, `${e.id}.end`] : []);
  if (a.type === "arc" && b.type === "arc") {
    for (const p of ends(a)) for (const q of ends(b)) if (joined(p, q)) return { round: a.id, at: p, round2: b.id, at2: q };
    return null;
  }
  const [line, round] = a.type === "line" ? [a, b] : [b, a];
  if (line.type !== "line" || round.type !== "arc") return null;
  for (const p of ends(round)) for (const q of ends(line)) if (joined(p, q)) return { round: round.id, at: p, line: line.id };
  return null;
}

/** The cosine between an arc's radius at one of its ends and a line: zero when the line touches the arc there. */
function radiusSquareTo(l: Layout, arc: string, end: string, line: string): Fn {
  const [cx, cy] = pointOf(l, `${arc}.center`);
  const [px, py] = pointOf(l, end);
  const [ux, uy] = direction(l, line);
  return (x) => {
    const rx = px(x) - cx(x);
    const ry = py(x) - cy(x);
    return (rx * ux(x) + ry * uy(x)) / (Math.hypot(rx, ry) * Math.hypot(ux(x), uy(x)));
  };
}

/** The sine between two arcs' radii at the ends where they meet: zero when their centres and that point are in line (they touch). */
function radiiInLine(l: Layout, a: string, endA: string, b: string, endB: string): Fn {
  const [ax, ay] = pointOf(l, `${a}.center`);
  const [px, py] = pointOf(l, endA);
  const [bx, by] = pointOf(l, `${b}.center`);
  const [qx, qy] = pointOf(l, endB);
  return (x) => {
    const r1x = px(x) - ax(x);
    const r1y = py(x) - ay(x);
    const r2x = qx(x) - bx(x);
    const r2y = qy(x) - by(x);
    return (r1x * r2y - r1y * r2x) / (Math.hypot(r1x, r1y) * Math.hypot(r2x, r2y));
  };
}

/** A line's direction, end minus start. */
function direction(l: Layout, id: string): [Fn, Fn] {
  const [[ax, ay], [bx, by]] = span(l, id);
  return [(x) => bx(x) - ax(x), (x) => by(x) - ay(x)];
}

/** A point's signed distance from a line (extended): positive on the line's left. */
function offsetFrom(l: Layout, line: string, [px, py]: [Fn, Fn]): Fn {
  const [[ax, ay], [bx, by]] = span(l, line);
  return (x) => {
    const ux = bx(x) - ax(x);
    const uy = by(x) - ay(x);
    return (ux * (py(x) - ay(x)) - uy * (px(x) - ax(x))) / Math.hypot(ux, uy);
  };
}

/** Equations that pin the dragged handles. */
function dragEquations(l: Layout, drag: NonNullable<SolveOptions["drag"]>): Fn[] {
  const fns: Fn[] = [];
  for (const d of drag) {
    const [id, name] = d.handle.split(".");
    const e = entityById(l, id);
    if (!e) throw new Error(`unknown handle ${d.handle}`);
    if (name === "body") {
      // Move every defining point by the drag delta.
      const from = d.from ?? d.to;
      const dx = d.to[0] - from[0];
      const dy = d.to[1] - from[1];
      for (const [field, n] of FIELDS[e.type]) {
        if (n !== 2) continue;
        const i = l.at.get(`${id}.${field}`)!;
        const tx = l.x[i] + dx;
        const ty = l.x[i + 1] + dy;
        fns.push((x) => x[i] - tx, (x) => x[i + 1] - ty);
      }
    } else if (name === "edge" && e.type === "circle") {
      const [cx, cy] = pointOf(l, `${id}.center`);
      const r = l.at.get(`${id}.radius`)!;
      fns.push((x) => x[r] - Math.hypot(d.to[0] - cx(x), d.to[1] - cy(x)));
    } else if (name.startsWith("corner") && e.type === "rect") {
      const k = Number(name.slice(6));
      const sx = k === 0 || k === 3 ? -1 : 1;
      const sy = k < 2 ? -1 : 1;
      const c = l.at.get(`${id}.center`)!;
      const w = l.at.get(`${id}.w`)!;
      const h = l.at.get(`${id}.h`)!;
      fns.push((x) => x[c] + (sx * x[w]) / 2 - d.to[0], (x) => x[c + 1] + (sy * x[h]) / 2 - d.to[1]);
    } else {
      const [px, py] = pointOf(l, d.handle);
      fns.push((x) => px(x) - d.to[0], (x) => py(x) - d.to[1]);
    }
  }
  return fns;
}

/**
 * Extra equations that keep what the user expects to stay still: the corner
 * opposite a dragged rect corner, the centre of a circle whose edge is
 * dragged. They are dropped if the constraints do not allow them.
 */
function anchorEquations(l: Layout, drag: NonNullable<SolveOptions["drag"]>): Fn[] {
  const fns: Fn[] = [];
  for (const d of drag) {
    const [id, name] = d.handle.split(".");
    const e = entityById(l, id);
    if (e?.type === "circle" && name === "edge") {
      const c = l.at.get(`${id}.center`)!;
      const [cx, cy] = [l.x[c], l.x[c + 1]];
      fns.push((x) => x[c] - cx, (x) => x[c + 1] - cy);
      continue;
    }
    if (e?.type !== "rect" || !name.startsWith("corner")) continue;
    const k = (Number(name.slice(6)) + 2) % 4;
    const sx = k === 0 || k === 3 ? -1 : 1;
    const sy = k < 2 ? -1 : 1;
    const c = l.at.get(`${id}.center`)!;
    const w = l.at.get(`${id}.w`)!;
    const h = l.at.get(`${id}.h`)!;
    const ox = l.x[c] + (sx * l.x[w]) / 2;
    const oy = l.x[c + 1] + (sy * l.x[h]) / 2;
    fns.push((x) => x[c] + (sx * x[w]) / 2 - ox, (x) => x[c + 1] + (sy * x[h]) / 2 - oy);
  }
  return fns;
}

export function solveSketch(entities: SketchEntity[], constraints: Constraint[], opts: SolveOptions = {}): SolveResult {
  const l = layout(entities);
  let base: Fn[];
  try {
    base = equations(l, constraints).fns;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  for (const ref of opts.fixed ?? []) {
    const parts = ref.split(".");
    const i = l.at.get(`${parts[0]}.${parts[1]}`);
    if (i === undefined) return { ok: false, error: `unknown field ${ref}` };
    const e = entityById(l, parts[0]);
    const width = FIELDS[e.type].find(([f]) => f === parts[1])![1];
    const comps = parts[2] !== undefined ? [Number(parts[2])] : Array.from({ length: width }, (_, k) => k);
    for (const k of comps) {
      const v = l.x[i + k];
      base.push((x) => x[i + k] - v);
    }
  }
  const attempts: Fn[][] = [];
  if (opts.drag?.length) {
    let pins: Fn[];
    try {
      pins = dragEquations(l, opts.drag);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const anchors = anchorEquations(l, opts.drag);
    if (anchors.length) attempts.push([...base, ...pins, ...anchors]);
    attempts.push([...base, ...pins]);
  } else {
    attempts.push(base);
  }

  for (const fns of attempts) {
    const x = newton(l.x, fns);
    if (!x) continue;
    // The drag pins are wishes; the constraints are not. Re-check the constraints alone.
    if (maxAbs(evaluate(base, x)) > ACCEPT) continue;
    const solved = unpack(l, x);
    const bad = invalidGeometry(solved);
    if (bad) return { ok: false, error: bad };
    return { ok: true, entities: solved, dof: freedom(x, base) };
  }
  return {
    ok: false,
    error: opts.drag?.length
      ? "the constraints do not let that move"
      : "the constraints conflict or cannot all be met; remove or change one",
  };
}

/** Degrees of freedom left in a sketch: unknowns minus independent equations. */
export function sketchDof(entities: SketchEntity[], constraints: Constraint[]): number {
  const l = layout(entities);
  return freedom(l.x, equations(l, constraints).fns);
}

/** True when adding `extra` takes away no freedom: it repeats or contradicts what the sketch already says. */
export function wouldOverDefine(entities: SketchEntity[], constraints: Constraint[], extra: Constraint): boolean {
  const l = layout(entities);
  const before = freedom(l.x, equations(l, constraints).fns);
  const after = freedom(l.x, equations(l, [...constraints, extra]).fns);
  return after === before;
}

/**
 * How defined a sketch is, as SOLIDWORKS colours it: which entities and
 * points can still move (blue), which cannot (black), and the degrees of
 * freedom left. An unknown can move when some motion the constraints allow
 * changes it: when it has a part in the Jacobian's null space.
 */
export interface SketchStatus {
  dof: number;
  /** Entity ids with any number still free. */
  free: Set<string>;
  /** Point refs ("l1.start") still free to move. */
  freePoints: Set<string>;
}

export function sketchStatus(entities: SketchEntity[], constraints: Constraint[]): SketchStatus {
  const l = layout(entities);
  const fns = equations(l, constraints).fns;
  const moves = freeUnknowns(l.x, fns);
  const free = new Set<string>();
  const freePoints = new Set<string>();
  for (const e of entities) {
    for (const [field, n] of FIELDS[e.type]) {
      const i = l.at.get(`${e.id}.${field}`)!;
      const loose = n === 1 ? moves[i] : moves[i] || moves[i + 1];
      if (!loose) continue;
      free.add(e.id);
      if (n === 2) freePoints.add(`${e.id}.${field}`);
    }
  }
  return { dof: freedom(l.x, fns), free, freePoints };
}

function invalidGeometry(entities: SketchEntity[]): string | null {
  for (const e of entities) {
    if (e.type === "circle" && e.radius <= 0) return `circle "${e.id}" would get a radius of ${round(e.radius)}`;
    if (e.type === "rect" && (e.w <= 0 || e.h <= 0)) return `rect "${e.id}" would get a size of ${round(e.w)} x ${round(e.h)}`;
    if (e.type === "slot" && e.width <= 0) return `slot "${e.id}" would get a width of ${round(e.width)}`;
    if (e.type === "line" && Math.hypot(e.end[0] - e.start[0], e.end[1] - e.start[1]) < 1e-9) return `line "${e.id}" would have zero length`;
  }
  return null;
}

// ---------------------------------------------------------------- numerics

function evaluate(fns: Fn[], x: Float64Array): Float64Array {
  return Float64Array.from(fns, (f) => f(x));
}

function maxAbs(r: Float64Array): number {
  let m = 0;
  for (const v of r) m = Math.max(m, Math.abs(v));
  return m;
}

function jacobian(fns: Fn[], x: Float64Array): Float64Array[] {
  const n = x.length;
  const rows = fns.map(() => new Float64Array(n));
  const probe = Float64Array.from(x);
  for (let j = 0; j < n; j++) {
    const h = 1e-6 * Math.max(1, Math.abs(x[j]));
    probe[j] = x[j] + h;
    const up = fns.map((f) => f(probe));
    probe[j] = x[j] - h;
    const down = fns.map((f) => f(probe));
    probe[j] = x[j];
    for (let i = 0; i < fns.length; i++) rows[i][j] = (up[i] - down[i]) / (2 * h);
  }
  return rows;
}

/** Minimum-norm damped Newton. Returns null if it does not converge. */
function newton(x0: Float64Array, fns: Fn[]): Float64Array | null {
  let x = Float64Array.from(x0);
  if (fns.length === 0) return x;
  let r = evaluate(fns, x);
  for (let iter = 0; iter < 100; iter++) {
    const err = maxAbs(r);
    if (err < TOL) return x;
    const J = jacobian(fns, x);
    const m = fns.length;
    // (J Jᵀ + λI) y = r
    const A = Array.from({ length: m }, (_, i) => {
      const row = new Float64Array(m);
      for (let k = 0; k < m; k++) {
        let s = 0;
        const a = J[i];
        const b = J[k];
        for (let j = 0; j < a.length; j++) s += a[j] * b[j];
        row[k] = s;
      }
      row[i] += 1e-12 + 1e-9 * row[i];
      return row;
    });
    const y = gaussSolve(A, Float64Array.from(r));
    if (!y) return null;
    const dx = new Float64Array(x.length);
    for (let i = 0; i < m; i++) for (let j = 0; j < x.length; j++) dx[j] -= J[i][j] * y[i];
    // Backtracking: take the largest step that reduces the residual.
    let step = 1;
    let accepted = false;
    for (let k = 0; k < 20; k++) {
      const trial = Float64Array.from(x, (v, j) => v + step * dx[j]);
      const rt = evaluate(fns, trial);
      if (norm(rt) < norm(r) || maxAbs(rt) < TOL) {
        x = trial;
        r = rt;
        accepted = true;
        break;
      }
      step /= 2;
    }
    if (!accepted) return maxAbs(r) < ACCEPT ? x : null;
  }
  return maxAbs(r) < ACCEPT ? x : null;
}

function norm(v: Float64Array): number {
  let s = 0;
  for (const a of v) s += a * a;
  return Math.sqrt(s);
}

function gaussSolve(A: Float64Array[], b: Float64Array): Float64Array | null {
  const n = b.length;
  const M = A.map((row) => Float64Array.from(row));
  const v = Float64Array.from(b);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    [v[c], v[p]] = [v[p], v[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) M[r][k] -= f * M[c][k];
      v[r] -= f * v[c];
    }
  }
  const out = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = v[r];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * out[k];
    out[r] = s / M[r][r];
  }
  return out;
}

/** Per unknown: can it move while the equations hold (to first order)? Reduced row echelon form of the Jacobian. */
function freeUnknowns(x: Float64Array, fns: Fn[]): boolean[] {
  const n = x.length;
  if (fns.length === 0) return new Array(n).fill(true);
  const J = jacobian(fns, x).map((row) => Float64Array.from(row));
  const scale = Math.max(1, ...J.map((row) => Math.max(...row.map(Math.abs))));
  const eps = 1e-7 * scale;
  const pivotRow = new Array<number>(n).fill(-1);
  const used = new Array(J.length).fill(false);
  for (let c = 0; c < n; c++) {
    let p = -1;
    let best = eps;
    for (let r = 0; r < J.length; r++) {
      if (!used[r] && Math.abs(J[r][c]) > best) {
        best = Math.abs(J[r][c]);
        p = r;
      }
    }
    if (p < 0) continue;
    used[p] = true;
    pivotRow[c] = p;
    const pv = J[p][c];
    for (let k = 0; k < n; k++) J[p][k] /= pv;
    for (let r = 0; r < J.length; r++) {
      if (r === p) continue;
      const f = J[r][c];
      if (f === 0) continue;
      for (let k = 0; k < n; k++) J[r][k] -= f * J[p][k];
    }
  }
  const freeCols = [...Array(n).keys()].filter((c) => pivotRow[c] < 0);
  // A pivot unknown moves when its row ties it to a free one.
  return Array.from({ length: n }, (_, c) => pivotRow[c] < 0 || freeCols.some((f) => Math.abs(J[pivotRow[c]][f]) > 1e-7));
}

/** Unknowns minus the rank of the Jacobian. */
function freedom(x: Float64Array, fns: Fn[]): number {
  if (fns.length === 0) return x.length;
  const J = jacobian(fns, x).map((row) => Float64Array.from(row));
  const n = x.length;
  let rank = 0;
  const scale = Math.max(1, ...J.map((row) => Math.max(...row.map(Math.abs))));
  const used = new Array(J.length).fill(false);
  for (let c = 0; c < n; c++) {
    let p = -1;
    let best = 1e-7 * scale;
    for (let r = 0; r < J.length; r++) {
      if (!used[r] && Math.abs(J[r][c]) > best) {
        best = Math.abs(J[r][c]);
        p = r;
      }
    }
    if (p < 0) continue;
    used[p] = true;
    rank++;
    for (let r = 0; r < J.length; r++) {
      if (r === p) continue;
      const f = J[r][c] / J[p][c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) J[r][k] -= f * J[p][k];
    }
  }
  return n - rank;
}

function round(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}
