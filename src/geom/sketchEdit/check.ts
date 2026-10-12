// Check sketch for feature: what keeps the sketch's profile geometry (not
// construction, not points) from making clean closed regions, said in the
// user's terms ("open at l3's end", "l2 and l5 cross"), where it is, and a
// one-click fix where one is simple: two ends that nearly meet are merged;
// a zero-length or duplicate entity is deleted. Also the closed contours
// themselves, for the sketcher to shade lightly so the user sees what will
// extrude even while something else in the sketch is still wrong. Pure.

import type { Constraint, SketchEntity, Vec2 } from "../../doc/types";
import { constraintTargets } from "../axes";
import { buildProfile, sampleSeg, type Region } from "../profile";
import { dist2 } from "../vec";
import { curveOf, curvesOf, distanceTo, meet, sameCarrier, TOL, type Curve } from "./curve";
import { mapRefs, pointAtRef, settle, type Edit, type SketchState } from "./relations";

export type ProblemKind = "open" | "gap" | "branch" | "cross" | "touch" | "overlap" | "zero" | "duplicate";

export interface SketchProblem {
  kind: ProblemKind;
  /** What is wrong, in a few words ("open at l3's end"). */
  text: string;
  /** Where to draw its warning. */
  at: Vec2;
  /** The entities it is about. */
  entities: string[];
  /** The one-click fix, if there is one: what the button says. */
  fix?: string;
  /** The points a merge joins, or the entity a delete removes. */
  refs?: string[];
}

export interface SketchCheck {
  problems: SketchProblem[];
  /** Closed contours of the profile geometry, as polygons (sampled arcs): the shading. Holes come as their own loops, filled even-odd. */
  loops: Vec2[][];
}

/** Profile geometry: not construction (a reference is construction unless it says otherwise, as doc/sketch isConstruction has it), not a point. */
const profileGeometry = (e: SketchEntity) => !(e.construction ?? !!e.ref) && e.type !== "point";
const END_NAMES = ["start", "end"] as const;
const endWord = (name: string) => (name === "start" ? "start" : "end");

/** The tolerance two ends count as nearly together within (a gap a merge closes): 1% of the sketch's size, between 0.001 and 0.5 mm. */
export function gapTolerance(entities: SketchEntity[]): number {
  const pts = entities.filter(profileGeometry).flatMap((e) => curvesOf(e).flatMap((c) => (c.kind === "line" ? [c.a, c.b] : [[c.c[0] - c.r, c.c[1] - c.r] as Vec2, [c.c[0] + c.r, c.c[1] + c.r] as Vec2])));
  if (!pts.length) return 0.001;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  return Math.min(0.5, Math.max(0.001, size * 0.01));
}

/** Every problem with the sketch's profile, and its closed contours. */
export function checkSketch(entities: SketchEntity[], opts: { gap?: number } = {}): SketchCheck {
  const live = entities.filter(profileGeometry);
  const problems: SketchProblem[] = [];
  const gap = opts.gap ?? gapTolerance(entities);

  // Zero length, and duplicates (a second entity on top of one exactly).
  const zero = new Set<string>();
  for (const e of live) {
    const c = curveOf(e);
    if ((e.type === "line" || e.type === "arc" || e.type === "circle") && !c) {
      zero.add(e.id);
      const at = e.type === "circle" ? e.center : e.start;
      problems.push({ kind: "zero", text: `${e.id} has no ${e.type === "circle" ? "radius" : "length"}`, at, entities: [e.id], fix: `Delete ${e.id}`, refs: [e.id] });
    }
  }
  const dupes = new Set<string>();
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const [a, b] = [live[i], live[j]];
      if (zero.has(a.id) || zero.has(b.id) || dupes.has(a.id) || dupes.has(b.id)) continue;
      if (same(a, b)) {
        dupes.add(b.id);
        problems.push({ kind: "duplicate", text: `${b.id} lies on top of ${a.id}`, at: anchor(b), entities: [a.id, b.id], fix: `Delete ${b.id}`, refs: [b.id] });
      }
    }
  }
  const rest = live.filter((e) => !zero.has(e.id) && !dupes.has(e.id));

  // Ends: each line's and arc's two ends must meet exactly one other end.
  const ends = rest.flatMap((e) => (e.type === "line" || e.type === "arc" ? END_NAMES.map((n) => ({ ref: `${e.id}.${n}`, id: e.id, name: n, p: e[n] })) : []));
  const joinedAt = (i: number) => ends.filter((o, j) => j !== i && dist2(o.p, ends[i].p) <= 10 * TOL);
  const seenNode = new Set<number>();
  const gapped = new Set<number>();
  ends.forEach((end, i) => {
    const there = joinedAt(i);
    if (there.length === 0) {
      if (gapped.has(i)) return;
      // Nearly meeting another loose end: a gap a merge closes.
      const k = ends.findIndex((o, j) => j !== i && o.id !== end.id && dist2(o.p, end.p) <= gap && joinedAt(j).length === 0);
      if (k >= 0) {
        gapped.add(i).add(k);
        const o = ends[k];
        problems.push({
          kind: "gap",
          text: `${end.id}'s ${endWord(end.name)} and ${o.id}'s ${endWord(o.name)} nearly meet (${fmt(dist2(end.p, o.p))} mm apart)`,
          at: end.p,
          entities: [end.id, o.id],
          fix: "Merge them",
          refs: [end.ref, o.ref],
        });
        return;
      }
      problems.push({ kind: "open", text: `open at ${end.id}'s ${endWord(end.name)}`, at: end.p, entities: [end.id] });
    } else if (there.length > 1 && !seenNode.has(i)) {
      const group = [end, ...there];
      group.forEach((g) => seenNode.add(ends.indexOf(g)));
      problems.push({ kind: "branch", text: `${list(group.map((g) => g.id))} all meet at one point: a profile corner joins two`, at: end.p, entities: group.map((g) => g.id) });
    }
  });

  // Crossings, touches and overlaps between any two (or an entity and itself, never: lines and arcs can't).
  const curves = rest.flatMap((e) => curvesOf(e).map((c, n) => ({ id: e.id, c, n, of: curvesOf(e).length })));
  for (let i = 0; i < curves.length; i++) {
    for (let j = i + 1; j < curves.length; j++) {
      const A = curves[i];
      const B = curves[j];
      if (A.id === B.id) continue; // a rectangle's or slot's own sides meet at its corners
      if (sameCarrier(A.c, B.c)) {
        const o = overlapAt(A.c, B.c);
        if (o) problems.push({ kind: "overlap", text: `${A.id} and ${B.id} overlap`, at: o, entities: [A.id, B.id] });
        continue;
      }
      for (const p of meet(A.c, B.c, 10 * TOL)) {
        const endA = isEndOf(A.c, p);
        const endB = isEndOf(B.c, p);
        if (endA && endB) continue; // joined end to end: a corner
        if (endA || endB) {
          const [e, other, end] = endA ? [A.id, B.id, endA] : [B.id, A.id, endB];
          problems.push({ kind: "touch", text: `${e}'s ${end} touches ${other} part way along`, at: p, entities: [e, other] });
        } else problems.push({ kind: "cross", text: `${A.id} and ${B.id} cross`, at: p, entities: [A.id, B.id] });
      }
    }
  }
  return { problems: dedupe(problems), loops: loopsOf(rest) };
}

/**
 * Which of the curve's ends p is (a line's or an arc's): "start" or "end" as
 * its entity names them, "end" for a rectangle's or slot's side; null when p is not an end.
 */
function isEndOf(c: Curve, p: Vec2): "start" | "end" | null {
  let a: Vec2;
  let b: Vec2;
  if (c.kind === "line") [a, b] = [c.a, c.b];
  else if (c.kind === "arc") {
    a = [c.c[0] + c.r * Math.cos(c.start), c.c[1] + c.r * Math.sin(c.start)];
    b = [c.c[0] + c.r * Math.cos(c.start + c.sweep), c.c[1] + c.r * Math.sin(c.start + c.sweep)];
  } else return null;
  if (dist2(p, a) <= 10 * TOL) return "start";
  if (dist2(p, b) <= 10 * TOL) return "end";
  return null;
}

/** Where two curves on one carrier share more than a point, if they do: a point in the shared part. */
function overlapAt(A: Curve, B: Curve): Vec2 | null {
  const samples = (c: Curve): Vec2[] => {
    if (c.kind === "line") return [0.25, 0.5, 0.75].map((t) => [c.a[0] + (c.b[0] - c.a[0]) * t, c.a[1] + (c.b[1] - c.a[1]) * t]);
    if (c.kind === "circle") return [0, 1, 2, 3].map((k) => [c.c[0] + c.r * Math.cos((k * Math.PI) / 2), c.c[1] + c.r * Math.sin((k * Math.PI) / 2)]);
    return [0.25, 0.5, 0.75].map((t) => [c.c[0] + c.r * Math.cos(c.start + c.sweep * t), c.c[1] + c.r * Math.sin(c.start + c.sweep * t)]);
  };
  for (const [X, Y] of [[A, B], [B, A]]) for (const p of samples(X)) if (distanceTo(Y, p) <= 10 * TOL) return p;
  return null;
}

/** Two entities with the same geometry (a line either way round, an arc the same piece of the same circle). */
function same(a: SketchEntity, b: SketchEntity): boolean {
  const near = (p: Vec2, q: Vec2) => dist2(p, q) <= 10 * TOL;
  if (a.type === "line" && b.type === "line") return (near(a.start, b.start) && near(a.end, b.end)) || (near(a.start, b.end) && near(a.end, b.start));
  if (a.type === "circle" && b.type === "circle") return near(a.center, b.center) && Math.abs(a.radius - b.radius) <= 10 * TOL;
  if (a.type === "arc" && b.type === "arc") {
    if (!near(a.center, b.center)) return false;
    const fwd = (x: typeof a) => (x.clockwise ? [x.end, x.start] : [x.start, x.end]);
    const [p, q] = fwd(a);
    const [r, s] = fwd(b);
    return near(p, r) && near(q, s);
  }
  if (a.type === "rect" && b.type === "rect") return near(a.center, b.center) && Math.abs(a.w - b.w) <= 10 * TOL && Math.abs(a.h - b.h) <= 10 * TOL;
  if (a.type === "slot" && b.type === "slot") return ((near(a.center1, b.center1) && near(a.center2, b.center2)) || (near(a.center1, b.center2) && near(a.center2, b.center1))) && Math.abs(a.width - b.width) <= 10 * TOL;
  return false;
}

function anchor(e: SketchEntity): Vec2 {
  switch (e.type) {
    case "line":
      return [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2];
    case "arc":
      return e.start;
    case "circle":
    case "rect":
      return e.center;
    case "slot":
      return e.center1;
    case "point":
      return e.at;
  }
}

/** One problem per place and kind (two arcs of a slot crossing a line twice still say so twice: at two places). */
function dedupe(problems: SketchProblem[]): SketchProblem[] {
  const out: SketchProblem[] = [];
  for (const p of problems) if (!out.some((q) => q.kind === p.kind && q.text === p.text && dist2(q.at, p.at) <= 10 * TOL)) out.push(p);
  return out;
}

/**
 * The closed contours: with a clean profile, its regions' loops; otherwise
 * every circle, rectangle and slot, and each ring of lines and arcs whose
 * every joint joins exactly two ends (crossings or not).
 */
function loopsOf(live: SketchEntity[]): Vec2[][] {
  const profile = buildProfile(live);
  if (profile.ok) return profile.regions.flatMap((r: Region) => [r.outer, ...r.holes].map((l) => l.segs.flatMap((s) => sampleSeg(s, Math.PI / 48))));
  const out: Vec2[][] = [];
  for (const e of live) {
    if (e.type === "circle" || e.type === "rect" || e.type === "slot") {
      const segs = buildProfile([e]);
      if (segs.ok) out.push(...segs.regions.map((r) => r.outer.segs.flatMap((s) => sampleSeg(s, Math.PI / 48))));
    }
  }
  // Rings of lines and arcs: join ends that coincide; a component where every node has two ends is closed.
  const open = live.filter((e): e is Extract<SketchEntity, { type: "line" | "arc" }> => (e.type === "line" || e.type === "arc") && !!curveOf(e));
  const nodes: Vec2[] = [];
  const node = (p: Vec2) => {
    const i = nodes.findIndex((q) => dist2(p, q) <= 10 * TOL);
    if (i >= 0) return i;
    nodes.push(p);
    return nodes.length - 1;
  };
  const edges = open.map((e) => ({ e, a: node(e.start), b: node(e.end) }));
  const degree = nodes.map((_, i) => edges.filter((x) => x.a === i || x.b === i).length);
  const used = new Set<number>();
  edges.forEach((first, fi) => {
    if (used.has(fi) || degree[first.a] !== 2 || degree[first.b] !== 2) return;
    const ring: number[] = [];
    let at = first.a;
    let cur = fi;
    for (;;) {
      ring.push(cur);
      used.add(cur);
      const x = edges[cur];
      at = x.a === at ? x.b : x.a;
      if (degree[at] !== 2) return;
      const next = edges.findIndex((y, j) => j !== cur && (y.a === at || y.b === at));
      if (next < 0) return;
      if (next === fi) break;
      if (used.has(next)) return;
      cur = next;
    }
    // Walk the ring as polygons: each entity sampled the way the ring runs.
    let from = first.a;
    const poly: Vec2[] = [];
    for (const k of ring) {
      const { e, a, b } = edges[k];
      const ok = buildSeg(e);
      const pts = ok ?? [e.start, e.end];
      poly.push(...(a === from ? pts : [...pts].reverse()));
      from = a === from ? b : a;
    }
    out.push(poly);
  });
  return out;
}

function buildSeg(e: Extract<SketchEntity, { type: "line" | "arc" }>): Vec2[] | null {
  if (e.type === "line") return [e.start, e.end];
  const c = curveOf(e);
  if (!c || c.kind !== "arc") return null;
  const n = Math.max(2, Math.ceil(Math.abs(c.sweep) / (Math.PI / 48)));
  return Array.from({ length: n + 1 }, (_, i) => [c.c[0] + c.r * Math.cos(c.start + (c.sweep * i) / n), c.c[1] + c.r * Math.sin(c.start + (c.sweep * i) / n)] as Vec2);
}

/**
 * The one-click fix for a problem: a merge moves both ends to their middle
 * and joins them by a coincident relation (the sketcher solves after); a
 * delete removes the entity and its relations. Null when it has none.
 */
export function fixProblem(state: SketchState, problem: SketchProblem): Edit | null {
  if ((problem.kind === "zero" || problem.kind === "duplicate") && problem.refs?.[0]) {
    const id = problem.refs[0];
    return {
      entities: state.entities.filter((e) => e.id !== id),
      constraints: state.constraints.flatMap((k) => (constraintTargets(k).includes(id) ? dropFrom(k, id) : [k])),
      made: [],
      note: `${id} deleted`,
    };
  }
  if (problem.kind === "gap" && problem.refs?.length === 2) {
    const [r1, r2] = problem.refs;
    const p = pointAtRef(state.entities, r1);
    const q = pointAtRef(state.entities, r2);
    if (!p || !q) return null;
    const mid: Vec2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const moved = state.entities.map((e) => {
      let out = e;
      for (const ref of [r1, r2]) {
        const [id, name] = ref.split(".");
        if (out.id === id) out = { ...out, [name]: mid } as SketchEntity;
      }
      return out;
    });
    const join: Constraint = { type: "coincident", points: [r1, r2] };
    const owners = [r1, r2].map((r) => r.split(".")[0]);
    return { entities: moved, constraints: settle(moved, [...state.constraints, join], owners, new Set([join])), made: owners, note: "ends merged" };
  }
  return null;
}

/** A relation without entity `id`: an offset relation loses that pair only; anything else goes. */
function dropFrom(k: Constraint, id: string): Constraint[] {
  const m = mapRefs(k, (ref) => (ref.split(".")[0] === id ? null : ref), (x) => (x === id ? null : x));
  return m && k.type === "offset" ? [m] : [];
}

/** Every fix there is at once: merges and deletes (each problem's fix applied in turn, where it still applies). */
export function fixAll(state: SketchState): Edit | null {
  let s: SketchState = state;
  let changed = false;
  for (let i = 0; i < 50; i++) {
    const p = checkSketch(s.entities).problems.find((x) => x.fix);
    if (!p) break;
    const r = fixProblem(s, p);
    if (!r) break;
    s = r;
    changed = true;
  }
  return changed ? { ...s, made: [] } : null;
}

/** The first problem as the status line puts it, and how many more there are. */
export function problemSummary(check: SketchCheck): string | null {
  const [first, ...more] = check.problems;
  if (!first) return null;
  return more.length ? `${first.text} (and ${more.length} more)` : first.text;
}

function list(xs: string[]): string {
  return xs.length <= 2 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

function fmt(x: number): string {
  return String(Math.round(x * 1000) / 1000);
}
