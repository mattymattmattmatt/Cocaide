// Offset entities, as SOLIDWORKS has them: a chain of lines and arcs (or a
// circle) copied at a distance to one side, or both; the copies joined where
// they meet (lines extended or trimmed to meet; at a corner that opens up,
// the lines run on to meet, or with "round corners" an arc goes round it);
// an open chain offset both ways can have its ends capped with arcs or
// lines; the base can be made construction.
//
// Analytic: a line's offset is a line, an arc's an arc on the same centre.
// The offsets keep their relation to the base through one "offset" relation
// (doc/types OffsetConstraint): every copy at `value` from its base, on its
// side, so editing that one dimension moves the whole offset; the copies are
// joined by coincident relations, and a round corner or an arc cap is an
// arc centred on the base's corner (or end) with the value for radius.

import type { Constraint, SketchEntity, Vec2 } from "../../doc/types";
import { add2, angleOf, cross2, dist2, dot2, scale2, sub2, wrapAngle } from "../vec";
import { carrierMeet, curveOf, distanceTo, footOn, paramOf, pointAt, tangentAt, TOL, type Curve } from "./curve";
import { explodeAll } from "./explode";
import { freshIds, replaced, settle, type Edit, type SketchState } from "./relations";

/** One entity of a chain, and whether the chain runs along it end to start. */
export interface Link {
  id: string;
  reversed: boolean;
}

export interface Chain {
  links: Link[];
  closed: boolean;
}

type Open = Extract<SketchEntity, { type: "line" | "arc" }>;
const chainable = (e: SketchEntity | undefined): e is Open => e?.type === "line" || e?.type === "arc";
const close = (p: Vec2, q: Vec2) => dist2(p, q) <= 10 * TOL;

/**
 * The chain through entity `id`: the lines and arcs joined end to end with it
 * (two ends meeting at each joint, and of the same kind: profile or
 * construction), in order, running the way `id` runs. `among` limits it to
 * those entities. A circle is a closed chain of its own.
 */
export function chainOf(entities: SketchEntity[], id: string, among?: ReadonlySet<string>): Chain | string {
  const e = entities.find((x) => x.id === id);
  if (!e) return `there is no entity "${id}"`;
  if (e.type === "circle") return { links: [{ id, reversed: false }], closed: true };
  if (!chainable(e)) return `${id} is a ${e.type}: offset takes lines, arcs and circles`;
  const kind = !!e.construction;
  const pool = entities.filter((x): x is Open => chainable(x) && !!x.construction === kind && (!among || among.has(x.id)));
  const used = new Set([id]);
  const links: Link[] = [{ id, reversed: false }];
  const step = (at: Vec2): Link | null => {
    const there = pool.filter((x) => !used.has(x.id) && (close(x.start, at) || close(x.end, at)));
    const all = pool.filter((x) => close(x.start, at) || close(x.end, at));
    if (there.length !== 1 || all.length > 2) return null;
    return { id: there[0].id, reversed: !close(there[0].start, at) };
  };
  const ends = (l: Link): [Vec2, Vec2] => {
    const x = pool.find((y) => y.id === l.id)!;
    return l.reversed ? [x.end, x.start] : [x.start, x.end];
  };
  // Forward from its end, then back from its start.
  for (let next = step(ends(links[0])[1]); next; next = step(ends(links[links.length - 1])[1])) {
    used.add(next.id);
    links.push(next);
  }
  const closed = links.length > 1 && close(ends(links[links.length - 1])[1], ends(links[0])[0]) && pool.filter((x) => close(x.start, ends(links[0])[0]) || close(x.end, ends(links[0])[0])).length === 2;
  if (!closed) {
    for (let prev = step(ends(links[0])[0]); prev; prev = step(ends(links[0])[0])) {
      used.add(prev.id);
      links.unshift({ id: prev.id, reversed: !prev.reversed });
    }
  }
  // A single arc whose ends meet would be a circle; anything else open stays open.
  return { links, closed };
}

/** The base curves of a chain, each running the chain's way. */
function baseCurves(entities: SketchEntity[], chain: Chain): Curve[] {
  return chain.links.map((l) => {
    const c = curveOf(entities.find((e) => e.id === l.id)!)!;
    if (!l.reversed || c.kind === "circle") return c;
    if (c.kind === "line") return { kind: "line", a: c.b, b: c.a };
    return { kind: "arc", c: c.c, r: c.r, start: c.start + c.sweep, sweep: -c.sweep };
  });
}

/** Which side of the chain p is on: 1 on its left (the way it runs), -1 on its right. */
export function sideOf(entities: SketchEntity[], chain: Chain, p: Vec2): 1 | -1 {
  const curves = baseCurves(entities, chain);
  let best = curves[0];
  let bestD = Infinity;
  for (const c of curves) {
    const d = distanceTo(c, p);
    if (d < bestD) [best, bestD] = [c, d];
  }
  if (best.kind === "circle") return dist2(p, best.c) < best.r ? 1 : -1;
  const t = Math.max(0, Math.min(1, paramOf(best, p)));
  const f = pointAt(best, t);
  return cross2(tangentAt(best, t), sub2(p, f)) >= 0 ? 1 : -1;
}

/** For a closed chain: the side that is inside it (1: left). */
export function insideOf(entities: SketchEntity[], chain: Chain): 1 | -1 {
  const curves = baseCurves(entities, chain);
  if (curves.length === 1 && curves[0].kind === "circle") return 1;
  // The signed area: anticlockwise chains have their inside on the left.
  let area = 0;
  for (const c of curves) {
    if (c.kind === "line") area += cross2(c.a, c.b) / 2;
    else if (c.kind === "arc") {
      const a = pointAt(c, 0);
      const b = pointAt(c, 1);
      area += (c.r * c.r * c.sweep + c.c[0] * (b[1] - a[1]) - c.c[1] * (b[0] - a[0])) / 2;
    }
  }
  return area >= 0 ? 1 : -1;
}

export interface OffsetOptions {
  distance: number;
  /** 1: to the left of each chain (the way it runs); -1: to the right. Ignored with `both`. */
  side: 1 | -1;
  both?: boolean;
  /** An open chain offset both ways: its ends closed with arcs or lines. */
  cap?: "none" | "arcs" | "lines";
  /** Where the offsets of two lines leave a gap (the outside of a corner): run them on to meet (sharp), or put an arc round it. */
  corners?: "sharp" | "round";
  /** The base becomes construction geometry. */
  construction?: boolean;
  /** Take the whole chain through each picked entity (true), or the picked entities only. */
  chain?: boolean;
}

/** A piece of an offset as built: its curve the chain's way, its base (an entity, or a corner's point ref), and its entity. */
interface Piece {
  curve: Curve;
  /** The link it offsets, or -1 for a corner arc or cap. */
  link: number;
  base: string;
  entity: SketchEntity;
  /** The ref of its point where the chain enters it, and where it leaves (the offset's own). */
  in: string;
  out: string;
}

/** The chains the picks name: each picked entity's whole chain (or, without `chain`, the picked ones joined among themselves), each once. */
export function chainsOf(entities: SketchEntity[], ids: string[], whole = true): Chain[] | string {
  const among = whole ? undefined : new Set(ids);
  const chains: Chain[] = [];
  for (const id of ids) {
    if (chains.some((c) => c.links.some((l) => l.id === id))) continue;
    const c = chainOf(entities, id, among);
    if (typeof c === "string") return c;
    chains.push(c);
  }
  return chains;
}

/** Offset entities: every chain the picks name, at the distance, to its side or both. */
export function offsetEntities(stateIn: SketchState, ids: string[], opts: OffsetOptions): Edit | string {
  const d = opts.distance;
  if (!(d > 0)) return "the offset distance must be more than 0";
  if (!ids.length) return "pick a line, arc or circle to offset: its chain is taken";
  const ex = explodeAll(stateIn, ids);
  let state = ex.state;
  for (const id of ex.ids) {
    const e = state.entities.find((x) => x.id === id);
    if (e?.ref) return `${id} follows the model: Convert Entities copies it first, or offset the converted copy`;
  }
  const chains = chainsOf(state.entities, ex.ids.filter((id) => state.entities.find((e) => e.id === id)?.type !== "point"), opts.chain ?? true);
  if (typeof chains === "string") return chains;
  const ids2 = freshIds(state.entities);
  const made: SketchEntity[] = [];
  const bases: string[] = [];
  const offsets: string[] = [];
  const hard: Constraint[] = [];
  const join = (p: string, q: string) => hard.push({ type: "coincident", points: [p, q] });
  for (const chain of chains) {
    const sides: (1 | -1)[] = opts.both ? [1, -1] : [opts.side];
    const built: Piece[][] = [];
    for (const s of sides) {
      const pieces = offsetChain(state.entities, chain, s, d, opts.corners ?? "sharp", ids2);
      if (typeof pieces === "string") return pieces;
      built.push(pieces);
      for (let i = 0; i < pieces.length; i++) {
        made.push(pieces[i].entity);
        bases.push(pieces[i].base);
        offsets.push(pieces[i].entity.id);
        // A circle's offset is a circle: there is nothing to join.
        const next = pieces[i + 1] ?? (chain.closed && pieces.length > 1 ? pieces[0] : null);
        if (next) join(pieces[i].out, next.in);
      }
    }
    // An open chain offset both ways: its two ends capped.
    if (opts.both && !chain.closed && (opts.cap ?? "none") !== "none") {
      const curves = baseCurves(state.entities, chain);
      const [left, right] = built;
      const firstLink = chain.links[0];
      const lastLink = chain.links[chain.links.length - 1];
      for (const atEnd of [false, true]) {
        const c = atEnd ? curves[curves.length - 1] : curves[0];
        const q = pointAt(c, atEnd ? 1 : 0);
        const t = tangentAt(c, atEnd ? 1 : 0);
        const n: Vec2 = [-t[1], t[0]];
        const pl = add2(q, scale2(n, d));
        const pr = add2(q, scale2(n, -d));
        const lRef = atEnd ? left[left.length - 1].out : left[0].in;
        const rRef = atEnd ? right[right.length - 1].out : right[0].in;
        const link = atEnd ? lastLink : firstLink;
        const baseEnd = `${link.id}.${(atEnd !== link.reversed) ? "end" : "start"}`;
        if (opts.cap === "lines") {
          const capLine: SketchEntity = { id: ids2("l"), type: "line", start: pl, end: pr };
          made.push(capLine);
          join(`${capLine.id}.start`, lRef);
          join(`${capLine.id}.end`, rRef);
        } else {
          // Anticlockwise round the outside of the end: at the chain's end from right to left, at its start from left to right.
          const arc: SketchEntity = { id: ids2("a"), type: "arc", center: q, start: atEnd ? pr : pl, end: atEnd ? pl : pr };
          made.push(arc);
          bases.push(baseEnd);
          offsets.push(arc.id);
          join(`${arc.id}.${atEnd ? "end" : "start"}`, lRef);
          join(`${arc.id}.${atEnd ? "start" : "end"}`, rRef);
        }
      }
    }
  }
  const group: Constraint = { type: "offset", entities: bases, offsets, value: d };
  if (opts.construction) {
    const baseIds = new Set(chains.flatMap((c) => c.links.map((l) => l.id)));
    state = { ...state, entities: state.entities.map((e) => (baseIds.has(e.id) ? ({ ...e, construction: true } as SketchEntity) : e)) };
  }
  const entities = [...state.entities, ...made];
  const all = [group, ...hard];
  return { entities, constraints: settle(entities, [...state.constraints, ...all], made.map((e) => e.id), new Set(all)), made: made.map((e) => e.id) };
}

/** The offset pieces of one chain to one side, corners joined. */
function offsetChain(entities: SketchEntity[], chain: Chain, s: 1 | -1, d: number, corners: "sharp" | "round", ids: (p: string) => string): Piece[] | string {
  const curves = baseCurves(entities, chain);
  const raw: Curve[] = [];
  for (let i = 0; i < curves.length; i++) {
    const c = curves[i];
    if (c.kind === "line") {
      const t = tangentAt(c, 0);
      const shift = scale2([-t[1], t[0]], s * d);
      raw.push({ kind: "line", a: add2(c.a, shift), b: add2(c.b, shift) });
      continue;
    }
    // To the left of an anticlockwise arc is towards its centre.
    const ccw = c.kind === "circle" || c.sweep > 0;
    const r = c.r - s * d * (ccw ? 1 : -1);
    if (r <= TOL) return `the offset of ${chain.links[i].id} (R${round(c.r)}) ${d >= c.r ? `by ${round(d)} reaches its centre` : "vanishes"}: offset it by less than ${round(c.r)}, or the other way`;
    raw.push(c.kind === "circle" ? { kind: "circle", c: c.c, r } : { kind: "arc", c: c.c, r, start: c.start, sweep: c.sweep });
  }
  // Each piece's ends, the chain's way: moved where it meets its neighbour.
  const from: Vec2[] = raw.map((c) => (c.kind === "circle" ? pointAt(c, 0) : pointAt(c, 0)));
  const to: Vec2[] = raw.map((c) => (c.kind === "circle" ? pointAt(c, 0) : pointAt(c, 1)));
  const cornerArcs: { after: number; center: Vec2; a: Vec2; b: Vec2; ccw: boolean; base: string }[] = [];
  const n = curves.length;
  for (let i = 0; i < (chain.closed ? n : n - 1); i++) {
    if (n === 1) break;
    const j = (i + 1) % n;
    const t1 = tangentAt(curves[i], 1);
    const t2 = tangentAt(curves[j], 0);
    const turn = cross2(t1, t2);
    const P = pointAt(curves[i], 1);
    if (Math.abs(turn) < 1e-9 && dot2(t1, t2) > 0) continue; // tangent: the offsets meet already
    const inside = turn * s > 0;
    const meetAt = carrierMeet(raw[i], raw[j]).sort((p, q) => dist2(p, P) - dist2(q, P))[0];
    const link = chain.links[i];
    const baseRef = `${link.id}.${link.reversed ? "start" : "end"}`;
    if (inside || (corners === "sharp" && meetAt && dist2(meetAt, P) < 1e3 * d)) {
      if (!meetAt) return `the offsets of ${link.id} and ${chain.links[j].id} don't meet: offset by less`;
      to[i] = meetAt;
      from[j] = meetAt;
    } else {
      cornerArcs.push({ after: i, center: P, a: to[i], b: from[j], ccw: turn > 0, base: baseRef });
    }
  }
  // Each piece still runs the way its base does, with some length.
  for (let i = 0; i < n; i++) {
    const c = raw[i];
    if (c.kind === "line") {
      const base = curves[i] as Extract<Curve, { kind: "line" }>;
      if (dot2(sub2(to[i], from[i]), sub2(base.b, base.a)) <= 10 * TOL * dist2(base.a, base.b)) return `an offset of ${round(d)} is too big for ${chain.links[i].id}: its offset would turn inside out; offset by less`;
    } else if (c.kind === "arc") {
      const a0 = angleOf(sub2(from[i], c.c));
      const a1 = angleOf(sub2(to[i], c.c));
      const sweep = c.sweep > 0 ? wrapAngle(a1 - a0) : wrapAngle(a0 - a1);
      if (sweep <= 1e-9 || sweep > Math.abs(c.sweep) + Math.PI / 2) return `an offset of ${round(d)} is too big for ${chain.links[i].id}: its offset would turn inside out; offset by less`;
    }
  }
  const pieces: Piece[] = raw.map((c, i) => {
    const link = chain.links[i];
    const base = entities.find((e) => e.id === link.id)!;
    const id = ids(base.type === "line" ? "l" : base.type === "arc" ? "a" : "c");
    // The copy runs the way its base does: its start offsets the base's start.
    const [ps, pe] = link.reversed ? [to[i], from[i]] : [from[i], to[i]];
    let entity: SketchEntity;
    if (c.kind === "line") entity = { id, type: "line", start: ps, end: pe };
    else if (c.kind === "circle") entity = { id, type: "circle", center: c.c, radius: c.r };
    else entity = { id, type: "arc", center: c.c, start: ps, end: pe, ...((base as Open).type === "arc" && (base as Extract<SketchEntity, { type: "arc" }>).clockwise ? { clockwise: true } : {}) };
    return { curve: c, link: i, base: link.id, entity, in: `${id}.${link.reversed ? "end" : "start"}`, out: `${id}.${link.reversed ? "start" : "end"}` };
  });
  // Round corners go in between the pieces they join, the way the chain turns there.
  for (const k of [...cornerArcs].reverse()) {
    const id = ids("a");
    const entity: SketchEntity = { id, type: "arc", center: k.center, start: k.ccw ? k.a : k.b, end: k.ccw ? k.b : k.a };
    const arc: Piece = { curve: curveOf(entity)!, link: -1, base: k.base, entity, in: `${id}.${k.ccw ? "start" : "end"}`, out: `${id}.${k.ccw ? "end" : "start"}` };
    pieces.splice(k.after + 1, 0, arc);
  }
  return pieces;
}

/** The offset as it would be, for the preview: its entities only (empty when it can't be made). */
export function offsetPreview(state: SketchState, ids: string[], opts: OffsetOptions): SketchEntity[] {
  const r = offsetEntities(state, ids, opts);
  if (typeof r === "string") return [];
  const made = new Set(r.made);
  return r.entities.filter((e) => made.has(e.id));
}

/** The nearest point of the curve to p, and how far (for picking which side). */
export function nearestOn(c: Curve, p: Vec2): { at: Vec2; d: number } {
  const at = c.kind === "line" ? pointAt(c, Math.max(0, Math.min(1, paramOf(c, p)))) : footOn(c, p);
  return { at, d: dist2(at, p) };
}

export { replaced };

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
