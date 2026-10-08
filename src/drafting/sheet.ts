// A composed sheet is a display list: lines, circles and text in sheet mm
// (origin at the lower left, y up). The app draws it as SVG, export writes it
// as SVG or PDF, and the checks read its boxes. Every primitive names the
// view or annotation it belongs to, so a click on the sheet finds its owner.

import type { Vec2 } from "../doc/types";

export type Prim =
  | {
      k: "line";
      pts: Vec2[];
      /** Line weight, mm. */
      w: number;
      dash?: number[];
      closed?: boolean;
      /** Filled (arrowheads), closed. */
      fill?: boolean;
      owner?: string;
    }
  | { k: "circle"; c: Vec2; r: number; w: number; fill?: boolean; owner?: string }
  | {
      k: "text";
      /** The baseline's start, middle or end, by anchor. */
      at: Vec2;
      text: string;
      size: number;
      anchor: "start" | "middle" | "end";
      /** Degrees, counter-clockwise. */
      angle?: number;
      bold?: boolean;
      owner?: string;
    };

export interface Box {
  min: Vec2;
  max: Vec2;
}

export function boxOf(points: Vec2[]): Box | null {
  if (points.length === 0) return null;
  const min: Vec2 = [Infinity, Infinity];
  const max: Vec2 = [-Infinity, -Infinity];
  for (const p of points) {
    min[0] = Math.min(min[0], p[0]);
    min[1] = Math.min(min[1], p[1]);
    max[0] = Math.max(max[0], p[0]);
    max[1] = Math.max(max[1], p[1]);
  }
  return { min, max };
}

export function union(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  return { min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1])], max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1])] };
}

export function grow(b: Box, d: number | [number, number, number, number]): Box {
  const [l, bo, r, t] = typeof d === "number" ? [d, d, d, d] : d;
  return { min: [b.min[0] - l, b.min[1] - bo], max: [b.max[0] + r, b.max[1] + t] };
}

/** True when the boxes share more than a hairline. */
export function overlaps(a: Box, b: Box, tol = 0.01): boolean {
  return a.min[0] < b.max[0] - tol && b.min[0] < a.max[0] - tol && a.min[1] < b.max[1] - tol && b.min[1] < a.max[1] - tol;
}

export function inside(a: Box, outer: Box, tol = 0.01): boolean {
  return a.min[0] >= outer.min[0] - tol && a.min[1] >= outer.min[1] - tol && a.max[0] <= outer.max[0] + tol && a.max[1] <= outer.max[1] + tol;
}

export function size(b: Box): Vec2 {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1]];
}

export function centre(b: Box): Vec2 {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2];
}

/** The box a primitive covers, text included (from its font metrics). */
export function primBox(p: Prim, width: (text: string, size: number, bold?: boolean) => number): Box | null {
  if (p.k === "line") return boxOf(p.pts);
  if (p.k === "circle") return { min: [p.c[0] - p.r, p.c[1] - p.r], max: [p.c[0] + p.r, p.c[1] + p.r] };
  const w = width(p.text, p.size, p.bold);
  const x0 = p.anchor === "start" ? 0 : p.anchor === "middle" ? -w / 2 : -w;
  const corners: Vec2[] = [
    [x0, -0.22 * p.size],
    [x0 + w, -0.22 * p.size],
    [x0, 0.75 * p.size],
    [x0 + w, 0.75 * p.size],
  ];
  const a = ((p.angle ?? 0) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return boxOf(corners.map(([x, y]) => [p.at[0] + x * c - y * s, p.at[1] + x * s + y * c]));
}
