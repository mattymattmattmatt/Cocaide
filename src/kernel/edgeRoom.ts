// How much room a face leaves beside one of its edges: from the edge, across
// the face, to the nearest other edge of it. A fillet's radius or a chamfer's
// distance on that edge has to fit in it. The face's full reach (its farthest
// point) is not it: the long face of an L-shaped profile reaches 60 mm from
// the edge along its thin leg, but leaves only the leg's 6 mm beside it.
//
// Pure: works on EdgeInfo and FaceInfo, so the kernel's messages and the
// app's smart defaults read the same number.

import type { Vec3 } from "../doc/types";
import { add3, cross3, dist3, dot3, len3, normalize3, scale3, sub3 } from "../geom/vec";
import type { EdgeInfo } from "./topology";

/** Points along an edge: a straight one or an arc evenly, others at its ends and middle. */
function samples(e: EdgeInfo): Vec3[] {
  const out: Vec3[] = [];
  if (e.kind === "line") {
    for (let k = 0; k <= 8; k++) out.push(add3(e.start, scale3(sub3(e.end, e.start), k / 8)));
    return out;
  }
  if (e.kind === "circle" && e.center && e.axis && e.radius) {
    // In the circle's plane: x toward the start, y a quarter turn on; the arc runs from the start through the middle to the end.
    const ax = normalize3(e.axis);
    const x = normalize3(sub3(e.start, e.center));
    const y = cross3(ax, x);
    const angle = (p: Vec3) => {
      const a = Math.atan2(dot3(sub3(p, e.center!), y), dot3(sub3(p, e.center!), x));
      return a < 0 ? a + 2 * Math.PI : a;
    };
    const closed = dist3(e.start, e.end) < 1e-9;
    const mid = angle(e.mid);
    const end = closed ? 2 * Math.PI : angle(e.end);
    // The arc goes the way that passes its middle.
    const sweep = closed ? 2 * Math.PI : mid <= end ? end : end - 2 * Math.PI;
    for (let k = 0; k <= 16; k++) {
      const a = (sweep * k) / 16;
      out.push(add3(e.center, add3(scale3(x, e.radius * Math.cos(a)), scale3(y, e.radius * Math.sin(a)))));
    }
    return out;
  }
  return [e.start, e.mid, e.end];
}

const NEAR = 1e-6;

/** Do two edges share an end? */
function touching(a: EdgeInfo, b: EdgeInfo): boolean {
  return [a.start, a.end].some((p) => [b.start, b.end].some((q) => dist3(p, q) < 1e-6));
}

/**
 * The room face `face` leaves beside `edge` (mm): the least distance, square
 * to the edge, from it to another edge of the face that does not meet it (a
 * straight edge: only what lies alongside it; a round one: from its circle,
 * radially and along its axis). Infinity when nothing bounds the face across
 * the edge (or the edge is neither straight nor round).
 */
export function roomBeside(edges: readonly EdgeInfo[], face: number, edge: EdgeInfo): number {
  const others = edges.filter((o) => o.index !== edge.index && !o.seam && o.faces.includes(face) && !touching(o, edge));
  const pts = others.flatMap(samples);
  let least = Infinity;
  if (edge.kind === "line") {
    const span = dist3(edge.start, edge.end);
    if (span < NEAR) return Infinity;
    const u = normalize3(sub3(edge.end, edge.start));
    for (const p of pts) {
      const rel = sub3(p, edge.start);
      const t = dot3(rel, u);
      if (t < -NEAR || t > span + NEAR) continue;
      const d = len3(cross3(rel, u));
      if (d > NEAR) least = Math.min(least, d);
    }
    return least;
  }
  if (edge.kind === "circle" && edge.center && edge.axis && edge.radius !== undefined) {
    const ax = normalize3(edge.axis);
    for (const p of pts) {
      const rel = sub3(p, edge.center);
      const h = dot3(rel, ax);
      const rho = len3(sub3(rel, scale3(ax, h)));
      const d = Math.hypot(rho - edge.radius, h);
      if (d > NEAR) least = Math.min(least, d);
    }
    return least;
  }
  return Infinity;
}

/** The least room beside an edge, over the faces it bounds; Infinity when none is known. */
export function roomAt(edges: readonly EdgeInfo[], edge: EdgeInfo): number {
  return Math.min(Infinity, ...[...new Set(edge.faces)].map((f) => roomBeside(edges, f, edge)));
}
