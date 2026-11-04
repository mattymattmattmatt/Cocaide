// The hole table (Phase Q): every hole a view sees as a circle, tagged by
// size — A for the smallest, B for the next ... — and numbered within its
// size along X then Y (A1, A2, B1), with its X and Y measured in the view
// from an origin (a corner of the view's outline or a point the drawing
// names), and its size from the hole feature that made it (Ø6.6 THRU,
// M6×1 - 6H). Pure: the kernel's hole measurements and records in, rows out.

import type { Vec2, Vec3 } from "../../doc/types";
import { threadCallout } from "../../features/hole/standards";
import type { HoleMeasurement } from "../../kernel/measure";
import type { HoleRecord } from "../../kernel/rebuild";
import type { Prim } from "../sheet";
import { inView, type ViewFrame } from "../views";

/** A hole as a view sees it. */
export interface HoleInView {
  /** Its centre in the view, model mm (the view's right and up). */
  center: Vec2;
  diameter: number;
  /** Its widest wall (a counterbore's, a countersink's), mm: where a tag goes clear of it. */
  outer?: number;
  /** "Ø6.6 THRU", "M6×1 - 6H × 12 DEEP", "Ø9 × 10 DEEP, CBORE Ø15 × 8". */
  size: string;
}

export interface HoleTableRow {
  tag: string;
  /** From the origin, model mm, to 0.01. */
  x: number;
  y: number;
  size: string;
  diameter: number;
  center: Vec2;
  /** Its widest wall, mm. */
  outer: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100 + 0;
const fmt = (x: number) => String(Math.round(x * 100) / 100 + 0);

/** The size a hole record calls out, one line, no counts: what its row says. */
export function holeSize(h: Pick<HoleRecord, "diameter" | "depth" | "through" | "counterbore" | "countersink" | "thread">): string {
  if (h.thread) {
    // The table writes the depth in words: the depth symbol is a drawn glyph, not a character every reader has.
    const t = threadCallout({ ...h.thread, depth: "through" }).replace(/ THRU$/, "");
    return h.thread.depth === "through" ? `${t} THRU` : `${t} × ${fmt(h.thread.depth)} DEEP`;
  }
  const parts = [`Ø${fmt(h.diameter)} ${h.through ? "THRU" : `× ${fmt(h.depth)} DEEP`}`];
  if (h.counterbore) parts.push(`CBORE Ø${fmt(h.counterbore.diameter)} × ${fmt(h.counterbore.depth)}`);
  if (h.countersink) parts.push(`CSK Ø${fmt(h.countersink.diameter)} × ${fmt(h.countersink.angle)}°`);
  return parts.join(", ");
}

/**
 * The holes a view looks straight into: each measured hole whose axis runs
 * along the view direction, at its centre in the view, sized by the hole
 * record of its diameter and direction (the one whose entry is on its axis
 * first). A hole no record made (a cut circle) is sized from its diameter.
 */
export function holesInView(holes: HoleMeasurement[], records: HoleRecord[], frame: ViewFrame): HoleInView[] {
  const out: HoleInView[] = [];
  const seen: Vec2[] = [];
  for (const h of holes) {
    if (Math.abs(dot(h.axis, frame.eye)) < 1 - 1e-6) continue;
    const center = inView(h.axisPoint, frame);
    // Coaxial walls of one hole (drill and counterbore) are measured as one hole; two bodies' walls on one axis are one in the view.
    if (seen.some((p) => Math.hypot(p[0] - center[0], p[1] - center[1]) < 1e-3)) continue;
    seen.push(center);
    const fit = records.filter((r) => Math.abs(Math.abs(dot(r.axis, h.axis)) - 1) < 1e-6 && Math.abs(r.diameter - h.diameter) < 0.01);
    const onAxis = fit.find((r) => distanceToAxis(r.entry, h.axisPoint, h.axis) < 1e-3) ?? fit[0];
    const outer = Math.max(h.diameter, ...h.diameters, onAxis?.counterbore?.diameter ?? 0, onAxis?.countersink?.diameter ?? 0);
    out.push({ center, diameter: h.diameter, outer, size: onAxis ? holeSize(onAxis) : `Ø${fmt(h.diameter)}` });
  }
  return out;
}

/**
 * The rows: tags by size (smallest first: A, B ... Z, AA), numbered along X
 * then Y within a size, X and Y from the origin. `origin` is in the view,
 * model mm.
 */
export function holeTable(holes: HoleInView[], origin: Vec2): HoleTableRow[] {
  const sizes = [...new Map(holes.map((h) => [h.size, h.diameter])).entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  const rows: HoleTableRow[] = [];
  sizes.forEach(([size], k) => {
    const letter = tagLetters(k);
    holes
      .filter((h) => h.size === size)
      .map((h) => ({ h, x: r2(h.center[0] - origin[0]), y: r2(h.center[1] - origin[1]) }))
      .sort((a, b) => a.x - b.x || a.y - b.y)
      .forEach(({ h, x, y }, i) => rows.push({ tag: `${letter}${i + 1}`, x, y, size, diameter: h.diameter, center: h.center, outer: h.outer ?? h.diameter }));
  });
  return rows;
}

/** 0 → A, 25 → Z, 26 → AA. */
export function tagLetters(k: number): string {
  let n = k + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** A corner of the view's outline (model mm in the view) as the origin: "@lowerLeft" and so on. Null for anything else. */
export function outlineOrigin(origin: string | undefined, outline: { min: Vec2; max: Vec2 } | null): Vec2 | null {
  if (!outline) return null;
  switch (origin ?? "@lowerLeft") {
    case "@lowerLeft":
      return [outline.min[0], outline.min[1]];
    case "@upperLeft":
      return [outline.min[0], outline.max[1]];
    case "@lowerRight":
      return [outline.max[0], outline.min[1]];
    case "@upperRight":
      return [outline.max[0], outline.max[1]];
    default:
      return null;
  }
}

export const OUTLINE_ORIGINS = ["@lowerLeft", "@upperLeft", "@lowerRight", "@upperRight"] as const;

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function distanceToAxis(p: Vec3, at: Vec3, axis: Vec3): number {
  const d: Vec3 = [p[0] - at[0], p[1] - at[1], p[2] - at[2]];
  const t = dot(d, axis);
  return Math.hypot(d[0] - axis[0] * t, d[1] - axis[1] * t, d[2] - axis[2] * t);
}

/** Where a view is on the sheet: its centre there, the point of the view drawn at it (model mm), and its scale. Wave Q1A's ComposedView has these. */
export interface PlacedView {
  centre: Vec2;
  origin: Vec2;
  scale: number;
}

/**
 * The tags beside the holes on the view (A1 up and to the right of its
 * hole, clear of its rim), and the origin's mark: what links the view to
 * its hole table. Owned by the table's id.
 */
export function holeTagPrims(rows: HoleTableRow[], view: PlacedView, origin: Vec2, owner: string, size = 3.5): Prim[] {
  const at = (p: Vec2): Vec2 => [view.centre[0] + (p[0] - view.origin[0]) * view.scale, view.centre[1] + (p[1] - view.origin[1]) * view.scale];
  const out: Prim[] = [];
  for (const r of rows) {
    const c = at(r.center);
    const rim = (r.outer / 2) * view.scale;
    const d = rim * Math.SQRT1_2 + 1.2;
    out.push({ k: "text", at: [c[0] + d, c[1] + d], text: r.tag, size, anchor: "start", owner });
  }
  // The origin: a small cross and "0,0", the datum the X and Y are measured from.
  const o = at(origin);
  out.push({ k: "line", pts: [[o[0] - 2.5, o[1]], [o[0] + 2.5, o[1]]], w: 0.25, owner });
  out.push({ k: "line", pts: [[o[0], o[1] - 2.5], [o[0], o[1] + 2.5]], w: 0.25, owner });
  out.push({ k: "text", at: [o[0] - 1, o[1] - 1 - size * 0.72], text: "0,0", size: size * 0.85, anchor: "end", owner });
  return out;
}
