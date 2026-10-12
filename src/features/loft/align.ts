// Loft sections lined up, pure (no kernel). A loft joins each section's
// loop to the next; how the loops are drawn must not twist it:
//   - every loop runs the same way round as seen along the loft (a loop
//     drawn the other way, or on a plane facing back, is reversed);
//   - each loop starts at the corner nearest (in direction from its centre)
//     to where the previous one starts, as the usual default connectors
//     do; a circle starts at the point in that direction.

import type { Vec2, Vec3 } from "../../doc/types";
import { to3D, type Frame } from "../../geom/frame";
import { sampleSeg, type Loop, type Seg } from "../../geom/profile";
import { angleOf, cross2, dot3, len3, normalize3, polar, scale3, sub3 } from "../../geom/vec";
import { reverseSeg } from "../sweep/chain";

/** A loop in its sketch's frame. */
export interface PlacedLoop {
  frame: Frame;
  loop: Loop;
}

/** The loop's area centroid in its plane (arcs sampled finely). */
export function loopCentroid(loop: Loop): Vec2 {
  const pts = loop.segs.flatMap((s, i) => {
    const p = sampleSeg(s, Math.PI / 180);
    return i === 0 ? p : p.slice(1);
  });
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const k = cross2(pts[i], pts[i + 1]);
    a += k;
    cx += (pts[i][0] + pts[i + 1][0]) * k;
    cy += (pts[i][1] + pts[i + 1][1]) * k;
  }
  if (Math.abs(a) < 1e-15) return pts[0];
  return [cx / (3 * a), cy / (3 * a)];
}

/** The loop the other way round. */
export function reversedLoop(loop: Loop): Loop {
  return { segs: loop.segs.map(reverseSeg).reverse(), area: -loop.area };
}

/**
 * The loop started as near as it can be to the direction `want` (in its own
 * plane, from its centroid): at the corner whose direction is nearest, or,
 * for a whole circle, at the point that way.
 */
export function startToward(loop: Loop, want: Vec2): Loop {
  const c = loopCentroid(loop);
  if (Math.hypot(want[0], want[1]) < 1e-12) return loop;
  if (loop.segs.length === 1 && loop.segs[0].kind === "arc") {
    const s = loop.segs[0];
    const at = angleOf(want);
    const p = polar(s.c, s.r, at);
    return { segs: [{ ...s, a: p, b: p, start: at }], area: loop.area };
  }
  const score = (seg: Seg) => {
    const d = [seg.a[0] - c[0], seg.a[1] - c[1]] as Vec2;
    return (d[0] * want[0] + d[1] * want[1]) / (Math.hypot(...d) * Math.hypot(...want) || 1);
  };
  let best = 0;
  loop.segs.forEach((seg, i) => {
    if (score(seg) > score(loop.segs[best]) + 1e-9) best = i;
  });
  return { segs: [...loop.segs.slice(best), ...loop.segs.slice(0, best)], area: loop.area };
}

/** A sketch point in the model. */
const at3 = (frame: Frame, p: Vec2) => to3D(frame, p);

/**
 * The loops lined up for a loft, in order: each running the same way round
 * as the first looks along the loft, each starting toward where the one
 * before it starts. `points` are the pointed ends (a section that is a point),
 * used only for the direction of travel.
 */
export function alignLoops(sections: (PlacedLoop | { point: Vec3 })[]): (PlacedLoop | { point: Vec3 })[] {
  const centre = (x: PlacedLoop | { point: Vec3 }): Vec3 => ("point" in x ? x.point : at3(x.frame, loopCentroid(x.loop)));
  const centres = sections.map(centre);
  const out: (PlacedLoop | { point: Vec3 })[] = [];
  let previousNormal: Vec3 | null = null;
  let previousStart: Vec3 | null = null;
  sections.forEach((sec, k) => {
    if ("point" in sec) {
      out.push(sec);
      return;
    }
    // Which way the loft travels here.
    const ahead = k + 1 < sections.length ? sub3(centres[k + 1], centres[k]) : sub3(centres[k], centres[k - 1]);
    let loop = sec.loop.area >= 0 ? sec.loop : reversedLoop(sec.loop);
    let normal: Vec3 = sec.frame.z;
    const along = len3(ahead) > 1e-9 ? dot3(normalize3(ahead), normal) : 0;
    const flip = Math.abs(along) > 1e-6 ? along < 0 : previousNormal ? dot3(previousNormal, normal) < 0 : false;
    if (flip) {
      loop = reversedLoop(loop);
      normal = scale3(normal, -1);
    }
    if (previousStart) {
      const d = sub3(previousStart, centres[k - 1]);
      loop = startToward(loop, [dot3(d, sec.frame.x), dot3(d, sec.frame.y)]);
    }
    previousNormal = normal;
    previousStart = at3(sec.frame, loop.segs[0].a);
    out.push({ frame: sec.frame, loop });
  });
  return out;
}

/** The point a loop's start is at, for tests: in the model. */
export const loopStart = (p: PlacedLoop): Vec3 => at3(p.frame, p.loop.segs[0].a);
