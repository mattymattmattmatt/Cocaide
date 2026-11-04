// Dragging views on the sheet (Phase Q wave Q2B), as pure maths: a view
// made from its parent and lined up with it (a projected view, a section
// cut square to the sheet) slides along the line it shares with the parent
// only; the views made from a view go with it when it moves; a view snaps to
// the centres and edges of the others; and it is kept off the title block,
// the tables and the paper's edge. Holding Alt places it exactly where it
// is dropped.

import type { DrawingView, Projection, Vec2 } from "../../doc/types";
import { viewKind } from "../../doc/drawing";
import type { Box } from "../../drafting/sheet";
import { DIRECTION_VECTORS, sectionSide } from "../../drafting/views";

/** How a view may move: along x (0) or y (1) of the sheet, or anywhere (null). */
export interface Alignment {
  axis: 0 | 1 | null;
  /** The view it is lined up with. */
  parent?: string;
  /** The side of its parent it sits on (a unit step on the sheet). */
  side?: Vec2;
}

/**
 * The sheet direction a view sits from its parent when it is lined up with it
 * (as the composer lines it up), or null: projected to a side (not a corner),
 * a section whose cutting line is square to the sheet. A view whose alignment
 * is broken (`free`) has none.
 */
export function attachSide(view: DrawingView, projection: Projection): Vec2 | null {
  if (!view.parent || (view as { free?: boolean }).free) return null;
  const kind = viewKind(view);
  if (kind === "projected") {
    const d = DIRECTION_VECTORS[view.direction ?? "right"];
    return d[0] !== 0 && d[1] !== 0 ? null : d;
  }
  if (kind === "section" && view.line && view.line.length >= 2 && !view.aligned) {
    const n = sectionSide(view.line, view.flip);
    const d: Vec2 = projection === "third" ? n : [-n[0], -n[1]];
    if (Math.abs(Math.abs(d[0]) - 1) < 1e-9 || Math.abs(Math.abs(d[1]) - 1) < 1e-9) return [Math.round(d[0]) + 0, Math.round(d[1]) + 0];
  }
  return null;
}

/** How a view may be dragged: a view on its parent's right slides left and right (x), one above it up and down (y). */
export function alignmentOf(view: DrawingView, views: DrawingView[], projection: Projection): Alignment {
  const side = attachSide(view, projection);
  if (!side || !views.some((v) => v.id === view.parent)) return { axis: null };
  return { axis: side[0] !== 0 ? 0 : 1, parent: view.parent, side };
}

/** A drag kept to the view's line: only the part along its axis. */
export function constrain(delta: Vec2, a: Alignment): Vec2 {
  if (a.axis === null) return delta;
  return a.axis === 0 ? [delta[0], 0] : [0, delta[1]];
}

/** How far a drag goes across the view's line, mm (what is refused). */
export function across(delta: Vec2, a: Alignment): number {
  if (a.axis === null) return 0;
  return Math.abs(a.axis === 0 ? delta[1] : delta[0]);
}

/** True when a drag is mostly across the line: the user is trying to pull the view off it. */
export function pulledOff(delta: Vec2, a: Alignment, min = 3): boolean {
  if (a.axis === null) return false;
  const along = Math.abs(a.axis === 0 ? delta[0] : delta[1]);
  return across(delta, a) > Math.max(min, along);
}

/** The views lined up with this one, and theirs, that go with it when it moves (not itself). */
export function followers(id: string, views: DrawingView[], projection: Projection): string[] {
  const out: string[] = [];
  const walk = (parent: string) => {
    for (const v of views) {
      if (v.parent !== parent || out.includes(v.id) || v.id === id) continue;
      if (!attachSide(v, projection)) continue;
      out.push(v.id);
      walk(v.id);
    }
  };
  walk(id);
  return out;
}

/** A guide line drawn while a view snaps: x = value (axis 0) or y = value (axis 1), sheet mm. */
export interface Guide {
  axis: 0 | 1;
  at: number;
  /** The view snapped to. */
  to: string;
}

/**
 * Snaps a box being dragged (moved by `delta`) to the other views: its centre
 * or an edge in line with theirs, within `tol` mm, across and down
 * separately. Along a locked axis only (when `axis` is set).
 */
export function snapToViews(box: Box, delta: Vec2, others: { id: string; box: Box }[], tol: number, axis: 0 | 1 | null = null): { delta: Vec2; guides: Guide[] } {
  const out: Vec2 = [delta[0], delta[1]];
  const guides: Guide[] = [];
  for (const ax of [0, 1] as const) {
    if (axis !== null && axis !== ax) continue;
    const mine = [box.min[ax] + delta[ax], (box.min[ax] + box.max[ax]) / 2 + delta[ax], box.max[ax] + delta[ax]];
    let best: { d: number; at: number; to: string } | null = null;
    for (const o of others) {
      const theirs = [o.box.min[ax], (o.box.min[ax] + o.box.max[ax]) / 2, o.box.max[ax]];
      for (let i = 0; i < 3; i++) {
        // Centre to centre, or an edge to the same edge.
        const d = theirs[i] - mine[i];
        if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: theirs[i], to: o.id };
      }
    }
    if (best) {
      out[ax] += best.d;
      guides.push({ axis: ax, at: best.at, to: best.to });
    }
  }
  return { delta: out, guides };
}

function overlap(a: Box, b: Box): boolean {
  return a.min[0] < b.max[0] && b.min[0] < a.max[0] && a.min[1] < b.max[1] && b.min[1] < a.max[1];
}

function moved(b: Box, d: Vec2): Box {
  return { min: [b.min[0] + d[0], b.min[1] + d[1]], max: [b.max[0] + d[0], b.max[1] + d[1]] };
}

/**
 * The smallest further move that keeps a box (moved by `delta`) inside the
 * frame and off every blocked box (title block, revision block, tables), a
 * `gap` from them. Along a locked axis only. When nothing near is free, the
 * delta is kept as it is (the checks will say what overlaps).
 */
export function keepOff(box: Box, delta: Vec2, blocked: Box[], frame: Box, gap = 2, axis: 0 | 1 | null = null): Vec2 {
  const ok = (d: Vec2) => {
    const b = moved(box, d);
    const inFrame = b.min[0] >= frame.min[0] - 1e-6 && b.min[1] >= frame.min[1] - 1e-6 && b.max[0] <= frame.max[0] + 1e-6 && b.max[1] <= frame.max[1] + 1e-6;
    return inFrame && !blocked.some((x) => overlap(b, { min: [x.min[0] - gap, x.min[1] - gap], max: [x.max[0] + gap, x.max[1] + gap] }));
  };
  if (ok(delta)) return delta;
  // Candidates: pushed into the frame, and pushed to each side of each blocked box it hits.
  const cands: Vec2[] = [];
  const b = moved(box, delta);
  const into: Vec2 = [
    b.min[0] < frame.min[0] ? frame.min[0] - b.min[0] : b.max[0] > frame.max[0] ? frame.max[0] - b.max[0] : 0,
    b.min[1] < frame.min[1] ? frame.min[1] - b.min[1] : b.max[1] > frame.max[1] ? frame.max[1] - b.max[1] : 0,
  ];
  const base: Vec2 = [delta[0] + into[0], delta[1] + into[1]];
  cands.push(base);
  const bb = moved(box, base);
  for (const x of blocked) {
    const g = { min: [x.min[0] - gap, x.min[1] - gap], max: [x.max[0] + gap, x.max[1] + gap] } as Box;
    if (!overlap(bb, g)) continue;
    cands.push([base[0] + (g.min[0] - bb.max[0]), base[1]], [base[0] + (g.max[0] - bb.min[0]), base[1]], [base[0], base[1] + (g.min[1] - bb.max[1])], [base[0], base[1] + (g.max[1] - bb.min[1])]);
  }
  const allowed = cands.filter((d) => (axis === null || d[1 - axis] === delta[1 - axis]) && ok(d));
  if (!allowed.length) return delta;
  allowed.sort((p, q) => Math.hypot(p[0] - delta[0], p[1] - delta[1]) - Math.hypot(q[0] - delta[0], q[1] - delta[1]));
  return allowed[0];
}

/** A number to a tenth of a millimetre, as the document keeps places. */
export function tenth(x: number): number {
  return Math.round(x * 10) / 10 + 0;
}
