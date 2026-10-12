// A rib's 2D shapes, pure (no kernel), in the sketch's coordinates:
//   - the chain with its end lines extended (the rib reaches the walls even
//     when the line stops short of them, as CAD users expect of a rib);
//   - for a rib in the sketch's plane: the region each piece of the chain
//     sweeps when moved a long way across the line (their union is the strip
//     the rib is cut from);
//   - for a rib standing out of the plane: the band of the line's thickness.

import type { Vec2 } from "../../doc/types";
import type { Loop, Region, Seg } from "../../geom/profile";
import { add2, cross2, dist2, len2, scale2, sub2 } from "../../geom/vec";
import { openBand } from "../revolve/band";
import type { Chain } from "../sweep/chain";
import { reverseSeg } from "../sweep/chain";
import type { RIB_SIDES } from "./doc";

/** The chain with its first and last pieces, when straight, made `by` longer outward. */
export function extendedChain(c: Chain, by: number): Chain {
  const segs = [...c.segs];
  const first = segs[0];
  if (first.kind === "line") {
    const u = scale2(sub2(first.a, first.b), 1 / dist2(first.a, first.b));
    segs[0] = { ...first, a: add2(first.a, scale2(u, by)) };
  }
  const k = segs.length - 1;
  const last = segs[k];
  if (last.kind === "line") {
    const u = scale2(sub2(last.b, last.a), 1 / dist2(last.a, last.b));
    segs[k] = { ...last, b: add2(last.b, scale2(u, by)) };
  }
  return { segs, closed: false };
}

/** The unit normal to the left of the chain's overall direction (start to end). */
export function chainLeft(c: Chain): Vec2 {
  const a = c.segs[0].a;
  const b = c.segs[c.segs.length - 1].b;
  const d = sub2(b, a);
  const l = len2(d);
  return [-d[1] / l, d[0] / l];
}

/** Green's theorem contribution of a segment: ½∮(x dy − y dx). */
function segArea(s: Seg): number {
  if (s.kind === "line") return 0.5 * cross2(s.a, s.b);
  const { c, r, a, b, sweep } = s;
  return 0.5 * (r * r * sweep + c[0] * (b[1] - a[1]) - c[1] * (b[0] - a[0]));
}

function ccwLoop(segs: Seg[]): Loop {
  const area = segs.reduce((t, s) => t + segArea(s), 0);
  return area >= 0 ? { segs, area } : { segs: segs.map(reverseSeg).reverse(), area: -area };
}

function moved(s: Seg, v: Vec2): Seg {
  if (s.kind === "line") return { ...s, a: add2(s.a, v), b: add2(s.b, v) };
  return { ...s, c: add2(s.c, v), a: add2(s.a, v), b: add2(s.b, v) };
}

/**
 * The regions the chain's pieces sweep when moved by `v` (each a closed
 * region: the piece, a side, the piece moved, the other side). Their union is
 * the whole strip the chain sweeps.
 */
export function sweptRegions(c: Chain, v: Vec2): Region[] {
  return c.segs.map((s) => {
    const m = moved(s, v);
    const segs: Seg[] = [s, { kind: "line", entity: s.entity, a: s.b, b: m.b }, reverseSeg(m), { kind: "line", entity: s.entity, a: m.a, b: s.a }];
    return { outer: ccwLoop(segs), holes: [] };
  });
}

/** The band of a rib standing out of the plane: the chain thickened across, centred or to one side (left of travel). */
export function ribBand(c: Chain, thickness: number, side: (typeof RIB_SIDES)[number]): Region {
  const [d1, d2] = side === "both" ? [-thickness / 2, thickness / 2] : side === "left" ? [0, thickness] : [-thickness, 0];
  return openBand(c.segs, d1, d2);
}
