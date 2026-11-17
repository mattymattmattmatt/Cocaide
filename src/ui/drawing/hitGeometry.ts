// Distances for hit tests on the sheet: from a point to a segment, and to a
// box (0 inside). Pure.

import type { Vec2 } from "../../doc/types";
import type { Box } from "../../drafting/sheet";

/** How far `p` is from the segment a–b. */
export function segDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const ab: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const l2 = ab[0] * ab[0] + ab[1] * ab[1];
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2));
  return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t);
}

/** How far `p` is from a box: 0 inside it. */
export function boxDistance(b: Box, p: Vec2): number {
  const dx = Math.max(b.min[0] - p[0], 0, p[0] - b.max[0]);
  const dy = Math.max(b.min[1] - p[1], 0, p[1] - b.max[1]);
  return Math.hypot(dx, dy);
}
