// Plan symbols: a door's swing and a room's name and area. Both work in the
// view's own millimetres, so they scale and move with the plan.
//
// A door: the leaf drawn open and the arc its edge sweeps from shut (thin), a
// double door as two leaves meeting in the middle.
//
// A room: its name at a point inside it, and its area, worked out from the
// plan itself — the region round that point bounded by the view's visible
// lines (the walls' cut faces, the windows), a door on the plan closing its
// opening, and whatever stands in the room (a bench, an island) counted in.
// The region is found on a grid over the view (about 700 cells across) and
// the half cell under each bounding line is put back, so the area is good to
// well under one per cent on a house plan. A given outline is used instead.

import type { DoorAnnotation, RoomAnnotation, Vec2 } from "../../doc/types";
import type { ComposedView } from "../compose";
import { viewToSheet } from "../compose";
import type { Prim } from "../sheet";
import { failed, type AnnotationContext, type LayoutResult } from "./common";

const rad = (deg: number) => (deg * Math.PI) / 180;
const turn = (v: Vec2, a: number): Vec2 => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];

/** A door's hinge in the view (view mm): its own point, or the GeoRef point it names. */
function hingeOf(a: DoorAnnotation, ctx: AnnotationContext): Vec2 | null {
  if (Array.isArray(a.hinge)) return a.hinge;
  const g = ctx.resolve(a.hinge);
  if (!g) return null;
  return g.kind === "point" ? g.inView : g.kind === "circle" ? g.inView.c : null;
}

/** The leaves of a door in the view: each hinge, the way it runs shut, its width and which way it turns open (+1 counter-clockwise). */
export function doorLeaves(a: DoorAnnotation, hinge: Vec2): { hinge: Vec2; shut: Vec2; width: number; turn: 1 | -1 }[] {
  const u: Vec2 = [Math.cos(rad(a.angle ?? 0)), Math.sin(rad(a.angle ?? 0))];
  const s = a.swing === "right" ? -1 : 1;
  if (!a.double) return [{ hinge, shut: u, width: a.width, turn: s }];
  const far: Vec2 = [hinge[0] + u[0] * a.width, hinge[1] + u[1] * a.width];
  return [
    { hinge, shut: u, width: a.width / 2, turn: s },
    { hinge: far, shut: [-u[0], -u[1]], width: a.width / 2, turn: s === 1 ? -1 : 1 },
  ];
}

export function layoutDoor(a: DoorAnnotation, ctx: AnnotationContext, cv: ComposedView): LayoutResult | { problem: string } {
  const h = hingeOf(a, ctx);
  if (!h) return failed(`its hinge ${String(a.hinge)} is not in ${cv.id} any more`);
  const open = rad(a.open ?? 90);
  const prims: Prim[] = [];
  for (const l of doorLeaves(a, h)) {
    const v = turn(l.shut, l.turn * open);
    const tip: Vec2 = [l.hinge[0] + v[0] * l.width, l.hinge[1] + v[1] * l.width];
    prims.push({ k: "line", pts: [viewToSheet(cv, l.hinge), viewToSheet(cv, tip)], w: ctx.style.thin * 2 });
    const arc: Vec2[] = [];
    const steps = Math.max(8, Math.ceil((a.open ?? 90) / 5));
    for (let i = 0; i <= steps; i++) {
      const d = turn(l.shut, (l.turn * open * i) / steps);
      arc.push(viewToSheet(cv, [l.hinge[0] + d[0] * l.width, l.hinge[1] + d[1] * l.width]));
    }
    prims.push({ k: "line", pts: arc, w: ctx.style.thin });
  }
  return { prims, text: `${a.double ? "double door" : "door"} ${Math.round(a.width)}`, at: viewToSheet(cv, h), grips: [] };
}

// ------------------------------------------------------------------ rooms

/** The lines that bound rooms in a view (view mm): its visible edges, and each door's leaf shut across its opening. */
export function roomWalls(cv: ComposedView, doors: { a: DoorAnnotation; hinge: Vec2 }[]): Vec2[][] {
  const out: Vec2[][] = cv.edges.filter((e) => e.visible && e.pts.length >= 2).map((e) => e.pts);
  for (const d of doors) for (const l of doorLeaves(d.a, d.hinge)) out.push([l.hinge, [l.hinge[0] + l.shut[0] * l.width, l.hinge[1] + l.shut[1] * l.width]]);
  return out;
}

export interface RoomRegion {
  /** mm². */
  area: number;
  /** Its extent across, mm. */
  size: Vec2;
  /** Reached the edge of the view: not closed (a gap where a door has no symbol). */
  open: boolean;
}

/** The region of a plan round `at` bounded by `walls` (view mm), within `box`, on a grid of about `cells` across. */
export function roomRegion(walls: Vec2[][], box: { min: Vec2; max: Vec2 }, at: Vec2, cells = 700): RoomRegion {
  const span = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], 1);
  const cell = span / cells;
  const x0 = box.min[0] - 2 * cell;
  const y0 = box.min[1] - 2 * cell;
  const nx = Math.ceil((box.max[0] - box.min[0]) / cell) + 5;
  const ny = Math.ceil((box.max[1] - box.min[1]) / cell) + 5;
  const idx = (i: number, j: number) => j * nx + i;
  const wall = new Uint8Array(nx * ny);
  // Each line marked cell by cell (steps of a third of a cell, so no gap opens where it crosses a corner).
  for (const pl of walls)
    for (let k = 0; k + 1 < pl.length; k++) {
      const [a, b] = [pl[k], pl[k + 1]];
      const n = Math.max(1, Math.ceil((Math.hypot(b[0] - a[0], b[1] - a[1]) / cell) * 3));
      for (let t = 0; t <= n; t++) {
        const i = Math.floor((a[0] + ((b[0] - a[0]) * t) / n - x0) / cell);
        const j = Math.floor((a[1] + ((b[1] - a[1]) * t) / n - y0) / cell);
        if (i >= 0 && j >= 0 && i < nx && j < ny) wall[idx(i, j)] = 1;
      }
    }
  const fill = (start: number[], into: Uint8Array, may: (c: number) => boolean) => {
    const stack = start.filter((c) => may(c));
    for (const c of stack) into[c] = 1;
    let edge = false;
    while (stack.length) {
      const c = stack.pop()!;
      const i = c % nx;
      const j = (c - i) / nx;
      if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) edge = true;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const d = idx(ii, jj);
        if (!into[d] && may(d)) {
          into[d] = 1;
          stack.push(d);
        }
      }
    }
    return edge;
  };
  // The room: from the cell at `at` (or the nearest free one, should a line pass right through it).
  let si = Math.floor((at[0] - x0) / cell);
  let sj = Math.floor((at[1] - y0) / cell);
  if (wall[idx(si, sj)]) {
    const near = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]].find(([di, dj]) => !wall[idx(si + di, sj + dj)]);
    if (near) [si, sj] = [si + near[0], sj + near[1]];
  }
  const room = new Uint8Array(nx * ny);
  const open = fill([idx(si, sj)], room, (c) => !wall[c]);
  // What lies outside it, from the grid's edge over everything but the room: the rest (an island inside it) is the room's.
  const outside = new Uint8Array(nx * ny);
  const border: number[] = [];
  for (let i = 0; i < nx; i++) border.push(idx(i, 0), idx(i, ny - 1));
  for (let j = 0; j < ny; j++) border.push(idx(0, j), idx(nx - 1, j));
  if (!open) fill(border, outside, (c) => !room[c]);
  let count = 0;
  let rim = 0;
  let lo: Vec2 = [Infinity, Infinity];
  let hi: Vec2 = [-Infinity, -Infinity];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const c = idx(i, j);
      if (open ? !room[c] : outside[c]) {
        // A bounding line's cell beside the room: half of it is the room's.
        if (!open && wall[c] && ((i > 0 && !outside[c - 1]) || (i < nx - 1 && !outside[c + 1]) || (j > 0 && !outside[c - nx]) || (j < ny - 1 && !outside[c + nx]))) rim++;
        continue;
      }
      count++;
      lo = [Math.min(lo[0], i), Math.min(lo[1], j)];
      hi = [Math.max(hi[0], i), Math.max(hi[1], j)];
    }
  const area = (count + rim / 2) * cell * cell;
  if (!count) return { area, size: [0, 0], open };
  // Its extent: the grid's, each side moved onto the line it stops at (a wall's face) when one runs there.
  const ext: [Vec2, Vec2] = [
    [x0 + lo[0] * cell, x0 + (hi[0] + 1) * cell],
    [y0 + lo[1] * cell, y0 + (hi[1] + 1) * cell],
  ];
  const snapped = ext.map(([a0, a1], axis) => {
    const other = 1 - axis;
    const along: Vec2 = ext[other];
    const near = (v: number) => {
      let best = v;
      let bestD = 1.5 * cell;
      for (const pl of walls)
        for (let k = 0; k + 1 < pl.length; k++) {
          const [p, q] = [pl[k], pl[k + 1]];
          // A line square to this axis, across the room's extent the other way.
          if (Math.abs(p[axis] - q[axis]) > 1e-6 * span) continue;
          if (Math.max(p[other], q[other]) < along[0] || Math.min(p[other], q[other]) > along[1]) continue;
          const d = Math.abs(p[axis] - v);
          if (d < bestD) [best, bestD] = [p[axis], d];
        }
      return best;
    };
    return near(a1) - near(a0);
  });
  return { area, size: [snapped[0], snapped[1]], open };
}

/** A polygon's area (shoelace) and extent. */
function outlineRegion(pts: Vec2[]): RoomRegion {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { area: Math.abs(a) / 2, size: [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)], open: false };
}

const tens = (x: number) => String(Math.round(x / 10) * 10);

export function layoutRoom(a: RoomAnnotation, ctx: AnnotationContext, cv: ComposedView): LayoutResult | { problem: string } {
  const showArea = a.area !== false;
  let region: RoomRegion | null = null;
  if (a.outline) region = outlineRegion(a.outline);
  else if ((showArea || a.size) && cv.outline) {
    const doors = [...ctx.all.values()].flatMap((d) => {
      if (d.type !== "door" || d.view !== a.view || d.hidden) return [];
      const hinge = hingeOf(d, ctx);
      return hinge ? [{ a: d, hinge }] : [];
    });
    region = roomRegion(roomWalls(cv, doors), cv.outline, a.at);
  }
  const s = viewToSheet(cv, a.at);
  const h = a.height ?? 3.5;
  const small = Math.max(1.8, h * 0.72);
  const lines: { text: string; size: number; bold?: boolean }[] = [{ text: a.name, size: h, bold: true }];
  let problem: string | undefined;
  if (region?.open) problem = `${a.name} is not closed on the plan (an opening with no door on it?): its area is left off`;
  else if (region) {
    if (showArea) lines.push({ text: `${(region.area / 1e6).toFixed(1)} m²`, size: small });
    if (a.size) lines.push({ text: `${tens(region.size[0])} × ${tens(region.size[1])}`, size: small });
  }
  const prims: Prim[] = [];
  const total = lines.reduce((t, l) => t + l.size * 1.5, 0);
  let y = s[1] + total / 2;
  for (const l of lines) {
    y -= l.size * 1.5;
    prims.push({ k: "text", at: [s[0], y + l.size * 0.25], text: l.text, size: l.size, anchor: "middle", ...(l.bold ? { bold: true } : {}) });
  }
  return { prims, text: lines.map((l) => l.text).join(" "), at: s, grips: [], ...(problem ? { problem } : {}), ...(region && !region.open ? { value: region.area } : {}) };
}
