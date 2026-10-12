// On-screen numeric input for the drawing tools (SOLIDWORKS's numeric input):
// while a line, circle or rectangle is being placed, typed values place its
// last click exactly and become its driving dimensions. Each TypedInput is
// plain data and pure functions; SketchCanvas opens the box and feeds them.

import type { Constraint, LineEntity, Vec2 } from "../../../doc/types";
import { EPS } from "./shapes";
import type { Built, Click, TypedInput } from "./types";

const tidy = (x: number) => Math.round(x * 1e9) / 1e9 + 0;
const at = (p: Vec2): Vec2 => [tidy(p[0]), tidy(p[1])];

/** The angle between a line's direction and +X, as the angle dimension reads it (0 to 180). */
function angleToX(l: LineEntity): number {
  return Math.abs((Math.atan2(l.end[1] - l.start[1], l.end[0] - l.start[0]) * 180) / Math.PI);
}

/** A line: its length, then its angle from +X (anticlockwise, degrees). */
export const LINE_TYPED: TypedInput = {
  fields: [
    { key: "length", label: "Length", unit: "mm" },
    { key: "angle", label: "Angle", unit: "°" },
  ],
  place(clicks: Click[], [length, angle], pointer: Vec2): Click | null {
    const a = clicks[clicks.length - 1].p;
    const d: Vec2 = [pointer[0] - a[0], pointer[1] - a[1]];
    const L = length ?? Math.hypot(d[0], d[1]);
    const t = angle !== undefined ? (angle * Math.PI) / 180 : Math.atan2(d[1], d[0]);
    if (!(L > EPS)) return null;
    // A typed angle on a quarter turn is level or plumb: that relation, not an angle.
    const q = angle === undefined ? null : (((angle % 180) + 180) % 180);
    const orient = q === null ? undefined : Math.abs(q) < 1e-9 || Math.abs(q - 180) < 1e-9 ? "horizontal" : Math.abs(q - 90) < 1e-9 ? "vertical" : undefined;
    const p: Vec2 = orient === "horizontal" ? [a[0] + Math.sign(Math.cos(t)) * L, a[1]] : orient === "vertical" ? [a[0], a[1] + Math.sign(Math.sin(t)) * L] : [a[0] + L * Math.cos(t), a[1] + L * Math.sin(t)];
    return { p: at(p), ref: null, ...(orient ? { orient } : {}) };
  },
  dimensions(built: Built, [length, angle]): Constraint[] {
    const l = built.entities.find((e): e is LineEntity => e.type === "line");
    if (!l) return [];
    const out: Constraint[] = [];
    if (length !== undefined) out.push({ type: "distance", entity: l.id, value: tidy(length) });
    if (angle !== undefined) {
      const a = tidy(angleToX(l));
      if (a > 1e-9 && a < 180 - 1e-9 && Math.abs(a - 90) > 1e-9) out.push({ type: "angle", entities: [l.id, "X"], value: a });
    }
    return out;
  },
};

/** A circle: its radius, the point on it toward the pointer. */
export const CIRCLE_TYPED: TypedInput = {
  fields: [{ key: "radius", label: "Radius", unit: "mm" }],
  place(clicks: Click[], [radius], pointer: Vec2): Click | null {
    const c = clicks[0].p;
    const d: Vec2 = [pointer[0] - c[0], pointer[1] - c[1]];
    const n = Math.hypot(d[0], d[1]);
    const r = radius ?? n;
    if (!(r > EPS)) return null;
    const u: Vec2 = n > EPS ? [d[0] / n, d[1] / n] : [1, 0];
    return { p: at([c[0] + r * u[0], c[1] + r * u[1]]), ref: null };
  },
  dimensions(built: Built, [radius]): Constraint[] {
    const c = built.entities.find((e) => e.type === "circle");
    return c && radius !== undefined ? [{ type: "radius", entity: c.id, value: tidy(radius) }] : [];
  },
};

/**
 * A rectangle: its width, then its height, toward the pointer's quarter from
 * the first click (a corner, or with `centre` the middle). The bottom side
 * takes the width and the right side the height.
 */
export function rectTyped(centre: boolean): TypedInput {
  return {
    fields: [
      { key: "width", label: "Width", unit: "mm" },
      { key: "height", label: "Height", unit: "mm" },
    ],
    place(clicks: Click[], [width, height], pointer: Vec2): Click | null {
      const a = clicks[0].p;
      const dx = pointer[0] - a[0];
      const dy = pointer[1] - a[1];
      const k = centre ? 0.5 : 1;
      const w = width !== undefined ? width * k : Math.abs(dx);
      const h = height !== undefined ? height * k : Math.abs(dy);
      if (!(w > EPS && h > EPS)) return null;
      return { p: at([a[0] + (Math.sign(dx) || 1) * w, a[1] + (Math.sign(dy) || 1) * h]), ref: null };
    },
    dimensions(built: Built, [width, height]): Constraint[] {
      // The four sides come first, anticlockwise from the bottom: the bottom is level, the next side plumb.
      const [bottom, right] = built.entities;
      const out: Constraint[] = [];
      if (width !== undefined && bottom) out.push({ type: "distance", entity: bottom.id, value: tidy(width) });
      if (height !== undefined && right) out.push({ type: "distance", entity: right.id, value: tidy(height) });
      return out;
    },
  };
}
