// Extrude and cut's 2D work, pure (no kernel), in sketch coordinates: which
// regions of the sketch the feature pushes out.
//   - Selected contours: a point inside a region picks the area bounded by the
//     innermost loop around it, less the loops directly inside that one. So
//     one sketch of a plate with a circle in it gives the plate (a point in
//     the ring) or the disc (a point in the circle): one sketch, several
//     features.
//   - Flip side to cut: everything in a rectangle around the part except the
//     regions (the loops' nesting turned inside out).
//   - Thin: an open chain or the loops thickened into a wall (the revolve's
//     band geometry: lines offset to lines, arcs to concentric arcs).

import type { SketchEntity, Vec2 } from "../../doc/types";
import { reverseLoop, sampleSeg, windingNumber, type Loop, type Region, type Seg } from "../../geom/profile";
import { add2, angleOf, dist2, dot2, len2, scale2, sub2, wrapAngle } from "../../geom/vec";
import { BandError, closedBands, openBand, openChain, wallOffsets, type ThinSide } from "../revolve/band";

export class RegionError extends Error {}

/** A loop counter-clockwise, as an outer boundary. */
const ccw = (l: Loop): Loop => (l.area >= 0 ? l : reverseLoop(l));
/** A loop clockwise, as a hole. */
const cw = (l: Loop): Loop => (l.area <= 0 ? l : reverseLoop(l));

/** Every loop of the regions, counter-clockwise, with how deep each is nested and the loop it is directly inside. */
export function nestedLoops(regions: readonly Region[]): { loop: Loop; depth: number; parent: number }[] {
  const loops = regions.flatMap((r) => [r.outer, ...r.holes]).map(ccw);
  const inside = (i: number, j: number) => i !== j && windingNumber(loops[j], loops[i].segs[0].a) !== 0;
  const containers = loops.map((_, i) => loops.map((_, j) => j).filter((j) => inside(i, j)));
  return loops.map((loop, i) => {
    const depth = containers[i].length;
    const parent = containers[i].find((j) => containers[j].length === depth - 1) ?? -1;
    return { loop, depth, parent };
  });
}

/** The area bounded by loop `i` less the loops directly inside it. */
function regionOfLoop(nest: ReturnType<typeof nestedLoops>, i: number): Region {
  return { outer: nest[i].loop, holes: nest.flatMap((n) => (n.parent === i ? [cw(n.loop)] : [])) };
}

/**
 * The regions picked by points inside them: for each point, the innermost
 * loop around it less the loops directly inside that. Two points in the same
 * region pick it once. A point in no region (outside every loop, or on a
 * line) is a RegionError naming it (`path` "regions[1]").
 */
export function pickRegions(regions: readonly Region[], seeds: readonly Vec2[], path = "regions"): Region[] {
  if (regions.length === 0) throw new RegionError(`${path}: the sketch has no closed region to pick from`);
  const nest = nestedLoops(regions);
  const picked: number[] = [];
  seeds.forEach((p, k) => {
    const on = nest.findIndex((n) => n.loop.segs.some((s) => onSeg(s, p)));
    if (on >= 0) throw new RegionError(`${path}[${k}]: [${fmt(p)}] is on the sketch's lines: give a point inside the region`);
    const around = nest.map((n, i) => ({ i, depth: n.depth, wn: windingNumber(n.loop, p) })).filter((x) => x.wn !== 0);
    if (around.length === 0) throw new RegionError(`${path}[${k}]: [${fmt(p)}] is outside every closed loop of the sketch`);
    const innermost = around.sort((a, b) => b.depth - a.depth)[0].i;
    if (!picked.includes(innermost)) picked.push(innermost);
  });
  return picked.map((i) => regionOfLoop(nest, i));
}

/**
 * What lies inside the rectangle but outside the regions (flip side to cut):
 * the rectangle less the outermost loops, and each hole's area less the
 * islands in it. The rectangle must hold every loop.
 */
export function complementRegions(regions: readonly Region[], min: Vec2, max: Vec2): Region[] {
  const nest = nestedLoops(regions);
  const rect: Loop = rectLoop(min, max);
  const outer: Region = { outer: rect, holes: nest.flatMap((n) => (n.depth === 0 ? [cw(n.loop)] : [])) };
  return [outer, ...nest.flatMap((n, i) => (n.depth % 2 === 1 ? [regionOfLoop(nest, i)] : []))];
}

/** A counter-clockwise rectangle loop from its corners. */
export function rectLoop(min: Vec2, max: Vec2): Loop {
  const pts: Vec2[] = [min, [max[0], min[1]], max, [min[0], max[1]]];
  const segs: Seg[] = pts.map((a, i) => ({ kind: "line", entity: "flipSide", a, b: pts[(i + 1) % 4] }));
  return { segs, area: (max[0] - min[0]) * (max[1] - min[1]) };
}

/** Points along every loop of the regions (arcs finely sampled): where the extrude's rays start. */
export function regionPoints(regions: readonly Region[]): Vec2[] {
  return regions.flatMap((r) => [r.outer, ...r.holes]).flatMap((l) => l.segs.flatMap((s) => sampleSeg(s, Math.PI / 90)));
}

/**
 * Which side of an open chain is its outside: +1 when it is to the left of
 * the chain's travel. The outside of a bent chain (an L, a U) is its convex
 * side, away from the middle of the chain; a straight one has none, so it is
 * the left (the chain runs from its end with the lowest coordinates).
 */
export function openOutside(chain: readonly Seg[]): 1 | -1 {
  const pts = chain.flatMap((s) => sampleSeg(s, Math.PI / 32));
  const centre = scale2(pts.reduce((t, p) => add2(t, p), [0, 0] as Vec2), 1 / pts.length);
  let away = 0;
  let total = 0;
  for (const s of chain) {
    const q = sampleSeg(s, Math.PI / 32);
    for (let k = 1; k < q.length; k++) {
      const t = sub2(q[k], q[k - 1]);
      const l = len2(t);
      if (l <= 0) continue;
      const n: Vec2 = [-t[1] / l, t[0] / l];
      away += dot2(n, sub2(scale2(add2(q[k], q[k - 1]), 0.5), centre)) * l;
      total += l;
    }
  }
  return away < -1e-9 * Math.max(1, total * total) ? -1 : 1;
}

/**
 * The regions a thin feature pushes out: the loops of the (picked) closed
 * regions each made a wall, or the one open chain of the sketch's lines and
 * arcs made a band. `side` "outside" is away from what a loop encloses, or
 * an open chain's convex side; "mid" splits the wall about the line.
 */
export function thinRegions(closed: readonly Region[], entities: readonly SketchEntity[], thickness: number, side: ThinSide = "outside"): Region[] {
  try {
    if (closed.length > 0) return closedBands(closed, thickness, side);
    const chain = openChain(entities);
    const [d1, d2] = wallOffsets(thickness, side, openOutside(chain));
    return [openBand(chain, d1, d2)];
  } catch (e) {
    if (e instanceof BandError) throw new RegionError(`thin: ${e.message}`);
    throw e;
  }
}

/** The area the regions enclose (outer loops less holes). */
export function areaOf(regions: readonly Region[]): number {
  return regions.reduce((t, r) => t + r.outer.area + r.holes.reduce((h, l) => h + l.area, 0), 0);
}

/** Is p on the segment (within tolerance)? */
function onSeg(s: Seg, p: Vec2): boolean {
  const tol = 1e-6;
  if (s.kind === "line") {
    const d = sub2(s.b, s.a);
    const l = len2(d);
    const t = dot2(sub2(p, s.a), d) / (l * l);
    return t >= -tol && t <= 1 + tol && dist2(add2(s.a, scale2(d, t)), p) <= tol;
  }
  if (Math.abs(dist2(p, s.c) - s.r) > tol) return false;
  if (Math.abs(s.sweep) >= 2 * Math.PI - 1e-12) return true;
  const angle = angleOf(sub2(p, s.c));
  const t = s.sweep > 0 ? wrapAngle(angle - s.start) : wrapAngle(s.start - angle);
  return t <= Math.abs(s.sweep) + 1e-9 || t >= 2 * Math.PI - 1e-9;
}

function fmt(p: Vec2): string {
  return p.map((x) => Math.round(x * 1e4) / 1e4).join(", ");
}
