// A section's cutting line, edited on the sheet: grips on the line as drawn
// (src/drafting/compose.ts ComposedView.cutLine), one at each end (dragged
// along the line: longer or shorter), one at each corner of an offset line
// (dragged anywhere), and one in the middle of the first stretch (dragged
// square to the line: the cut moves, and the section with it). A drag becomes
// the section view's new `line`, in its parent's view mm. Pure.

import type { ComposedView } from "../../drafting/compose";
import type { Vec2 } from "../../doc/types";
import { sheetToView } from "./tools/geometry";
import type { Grip } from "./tools/kinds";

const unit = (a: Vec2, b: Vec2): Vec2 => {
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
};

/** The grips of a section's cutting line as drawn; none for a view that is not a section with a line. */
export function cutLineGrips(section: Pick<ComposedView, "cutLine">): Grip[] {
  const pts = section.cutLine;
  if (!pts || pts.length < 2) return [];
  const last = pts.length - 1;
  const grips: Grip[] = pts.map((p, i) => {
    if (i === 0) return { id: "cut:0", at: p, along: unit(pts[1], pts[0]), label: "Drag to make the cutting line longer or shorter" };
    if (i === last) return { id: `cut:${i}`, at: p, along: unit(pts[last - 1], pts[last]), label: "Drag to make the cutting line longer or shorter" };
    return { id: `cut:${i}`, at: p, label: "Drag this corner of the cutting line" };
  });
  const d = unit(pts[0], pts[1]);
  const mid: Vec2 = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
  grips.push({ id: "cut:move", at: mid, along: [-d[1], d[0]], label: "Drag to move the cut (the section follows)" });
  return grips;
}

/**
 * The section's new line (parent view mm) after a grip moved `delta` sheet mm:
 * one point moved where it was dropped (an end from where it is drawn, so a
 * line drawn run past the dimensions shortens from there), or every point by
 * the drag. Null when the grip is not one of its line's.
 */
export function cutLineAfter(section: Pick<ComposedView, "cutLine">, stored: Vec2[], parent: Pick<ComposedView, "centre" | "origin" | "scale" | "breaks">, gripId: string, delta: Vec2): Vec2[] | null {
  const drawn = section.cutLine;
  if (!drawn || drawn.length !== stored.length) return null;
  const tenth = (v: number) => Math.round(v * 1000) / 1000;
  const r = (p: Vec2): Vec2 => [tenth(p[0]), tenth(p[1])];
  if (gripId === "cut:move") {
    const dv: Vec2 = [delta[0] / parent.scale, delta[1] / parent.scale];
    return stored.map((p) => r([p[0] + dv[0], p[1] + dv[1]]));
  }
  const m = /^cut:(\d+)$/.exec(gripId);
  if (!m) return null;
  const i = Number(m[1]);
  if (i >= stored.length) return null;
  const moved = sheetToView(parent, [drawn[i][0] + delta[0], drawn[i][1] + delta[1]]);
  return stored.map((p, k) => (k === i ? r(moved) : p));
}

/** A detail's grips on its parent: the centre (moves the circle) and a point on the rim (resizes it). */
export function detailRingGrips(detail: Pick<ComposedView, "detailRing">): Grip[] {
  const ring = detail.detailRing;
  if (!ring) return [];
  return [
    { id: "ring:centre", at: ring.c, label: "Drag to move the detail's circle" },
    { id: "ring:rim", at: [ring.c[0] + ring.r, ring.c[1]], label: "Drag to make the detail's circle bigger or smaller" },
  ];
}

/** The detail's new circle (parent view mm) after a grip moved `delta` sheet mm; null when the grip is not one of its circle's. */
export function detailRingAfter(detail: Pick<ComposedView, "detailRing">, parent: Pick<ComposedView, "centre" | "origin" | "scale" | "breaks">, gripId: string, delta: Vec2): { at: Vec2; r: number } | null {
  const ring = detail.detailRing;
  if (!ring) return null;
  const tenth = (v: number) => Math.round(v * 1000) / 1000;
  if (gripId === "ring:centre") {
    const at = sheetToView(parent, [ring.c[0] + delta[0], ring.c[1] + delta[1]]);
    return { at: [tenth(at[0]), tenth(at[1])], r: tenth(ring.r / parent.scale) };
  }
  if (gripId === "ring:rim") {
    const rim: Vec2 = [ring.c[0] + ring.r + delta[0], ring.c[1] + delta[1]];
    const r = Math.max(1, Math.hypot(rim[0] - ring.c[0], rim[1] - ring.c[1]) / parent.scale);
    const at = sheetToView(parent, ring.c);
    return { at: [tenth(at[0]), tenth(at[1])], r: tenth(r) };
  }
  return null;
}
