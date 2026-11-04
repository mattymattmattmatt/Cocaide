// Where each view looks from, and where its neighbours go on the sheet. A view
// is an orthographic projection: a point's place in the view is its dot with
// the view's right and up directions. The kernel's hidden-line projection uses
// the same frame, so a node, a member end or a hole lands on the lines drawn.
//
// Phase Q: every kind of view has its frame from here. A model view's from its
// look (or a custom eye and up); a projected view's from its parent's, turned
// a quarter toward the side it is drawn on (third angle) or away (first); a
// section's from the side of its cutting line the viewer stands on; an
// auxiliary view's from the side of an edge; a detail's is its parent's.

import type { ProjectDirection, Projection as SheetProjection, Vec2, Vec3, ViewLook } from "../doc/types";

export interface ViewFrame {
  /** From the part toward the viewer. */
  eye: Vec3;
  right: Vec3;
  /** eye × right. */
  up: Vec3;
}

const s2 = Math.SQRT1_2;
const s3 = 1 / Math.sqrt(3);
const s6 = 1 / Math.sqrt(6);

const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const clean = (v: Vec3): Vec3 => v.map((x) => (Math.abs(x) < 1e-12 ? 0 : Math.abs(Math.abs(x) - 1) < 1e-12 ? Math.sign(x) : x)) as Vec3;

/** Trimetric: from 30° round from the front toward the right, 24° above (as the 3D view's). */
const TRI_AZ = (30 * Math.PI) / 180;
const TRI_EL = (24 * Math.PI) / 180;

const FRAMES: Record<ViewLook, ViewFrame> = {
  front: { eye: [0, -1, 0], right: [1, 0, 0], up: [0, 0, 1] },
  back: { eye: [0, 1, 0], right: [-1, 0, 0], up: [0, 0, 1] },
  top: { eye: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0] },
  bottom: { eye: [0, 0, -1], right: [1, 0, 0], up: [0, -1, 0] },
  right: { eye: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1] },
  left: { eye: [-1, 0, 0], right: [0, -1, 0], up: [0, 0, 1] },
  // From the front, right and above: the corner nearest is (max x, min y, max z).
  iso: { eye: [s3, -s3, s3], right: [s2, s2, 0], up: [-s6, s6, 2 * s6] },
  // The drawing-office dimetric: X and Z full size, Y half.
  dimetric: frameFrom(unit([1, -Math.sqrt(7), 1]), [0, 0, 1]),
  trimetric: frameFrom([Math.cos(TRI_EL) * Math.sin(TRI_AZ), -Math.cos(TRI_EL) * Math.cos(TRI_AZ), Math.sin(TRI_EL)], [0, 0, 1]),
};

export function viewFrame(look: ViewLook): ViewFrame {
  return FRAMES[look];
}

/**
 * The frame looking from `eye`, with `up` (or as near it as square to the
 * eye allows) up the sheet. Looking straight along up, +Y (or −Y) is up.
 */
export function frameFrom(eye: Vec3, up: Vec3 = [0, 0, 1]): ViewFrame {
  const e = unit(eye);
  let u = up;
  if (Math.abs(dot(unit(u), e)) > 0.9999) u = Math.abs(e[2]) > 0.9999 ? [0, e[2] > 0 ? 1 : -1, 0] : [0, 0, 1];
  const right = unit(cross(u, e));
  return { eye: clean(e), right: clean(right), up: clean(cross(e, right)) };
}

/** A point of the part, in the view (model mm, x right, y up). */
export function inView(p: Vec3, f: ViewFrame): Vec2 {
  return [p[0] * f.right[0] + p[1] * f.right[1] + p[2] * f.right[2], p[0] * f.up[0] + p[1] * f.up[1] + p[2] * f.up[2]];
}

/** How far toward the viewer a point is. */
export function depthOf(p: Vec3, f: ViewFrame): number {
  return dot(p, f.eye);
}

/** A direction of the part, in the view; its length is how much of it the view shows. */
export function dirInView(d: Vec3, f: ViewFrame): Vec2 {
  return inView(d, f);
}

/** The model direction a direction on the view is. */
export function toModel(d: Vec2, f: ViewFrame): Vec3 {
  return [f.right[0] * d[0] + f.up[0] * d[1], f.right[1] * d[0] + f.up[1] * d[1], f.right[2] * d[0] + f.up[2] * d[1]];
}

/** A point of the view at `depth` toward the viewer, in the model. */
export function toModelPoint(p: Vec2, f: ViewFrame, depth = 0): Vec3 {
  return add(toModel(p, f), scale(f.eye, depth));
}

/** Named looks that look square at the part: a length along the view is a true length. */
export function isOrthographic(look: ViewLook): boolean {
  return look !== "iso" && look !== "dimetric" && look !== "trimetric";
}

/** True when the frame looks along a model axis (its lengths are true along the view). */
export function isSquareFrame(f: ViewFrame): boolean {
  return f.eye.some((x) => Math.abs(Math.abs(x) - 1) < 1e-9);
}

/** The unit vector a projected view is from its parent, on the sheet. */
export const DIRECTION_VECTORS: Record<ProjectDirection, Vec2> = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, 1],
  down: [0, -1],
  upLeft: [-1, 1],
  upRight: [1, 1],
  downLeft: [-1, -1],
  downRight: [1, -1],
};

/**
 * The frame of a view looking from side `d` (unit, on the sheet) of its
 * parent, turned a quarter about the parent's axis across d: what the parent
 * shows on that side faces the viewer. The parent's eye turns to point away
 * from d: in the top view of a front view, the front of the part is at the
 * bottom, toward the front view.
 */
export function quarterTurn(parent: ViewFrame, d: Vec2): ViewFrame {
  const [dx, dy] = d;
  const D = toModel([dx, dy], parent);
  const P = toModel([-dy, dx], parent);
  const back = scale(parent.eye, -1);
  return {
    eye: clean(D),
    right: clean(add(scale(back, dx), scale(P, -dy))),
    up: clean(add(scale(back, dy), scale(P, dx))),
  };
}

/**
 * A projected view's frame. Third angle: the view drawn on a side looks from
 * that side (the top view above the front). First angle: from the other side
 * (the top view below the front). A corner gives the iso from that corner.
 */
export function projectedFrame(parent: ViewFrame, direction: ProjectDirection, projection: SheetProjection): ViewFrame {
  const v = DIRECTION_VECTORS[direction];
  const side: Vec2 = projection === "third" ? v : [-v[0], -v[1]];
  if (v[0] !== 0 && v[1] !== 0) {
    // From the corner: the parent's eye, plus a step toward the side and a step up or down.
    return frameFrom(add(parent.eye, toModel(side, parent)), parent.up);
  }
  return quarterTurn(parent, side);
}

/** Left of a direction on the sheet (a quarter turn counter-clockwise). */
export function leftOf(d: Vec2): Vec2 {
  return [-d[1], d[0]];
}

function unit2(v: Vec2): Vec2 {
  const l = Math.hypot(v[0], v[1]);
  return [v[0] / l, v[1] / l];
}

/**
 * Which side of a cutting line the viewer stands on, on the parent: left of
 * its first segment, or right with `flip`. The material on that side is cut
 * away; the section arrows point the other way, the way the viewer looks.
 */
export function sectionSide(line: Vec2[], flip = false): Vec2 {
  const d = unit2([line[1][0] - line[0][0], line[1][1] - line[0][1]]);
  const n = leftOf(d);
  return flip ? [-n[0], -n[1]] : n;
}

/** A section view's frame: looking at the cut from the side the material was cut away. */
export function sectionFrame(parent: ViewFrame, line: Vec2[], flip = false): ViewFrame {
  return quarterTurn(parent, sectionSide(line, flip));
}

/** An auxiliary view's frame: looking square at an edge of the parent (a to b on the parent), from its left (or right with flip). */
export function auxiliaryFrame(parent: ViewFrame, a: Vec2, b: Vec2, flip = false): ViewFrame {
  return sectionFrame(parent, [a, b], flip);
}

/**
 * Where a view goes relative to the front, in the projection: [dx, dy] in
 * view steps. Third-angle puts each view on the side it looks from (the top
 * above the front); first-angle on the opposite side.
 */
export function placeFromFront(look: ViewLook, projection: SheetProjection): Vec2 | null {
  const third: Partial<Record<ViewLook, Vec2>> = { front: [0, 0], top: [0, 1], bottom: [0, -1], right: [1, 0], left: [-1, 0], back: [2, 0] };
  const at = third[look];
  if (!at) return null;
  if (projection === "third" || look === "front") return at;
  // First angle mirrors the neighbours. The back stays at the far right, beside the view from the left.
  return look === "back" ? [2, 0] : [-at[0], -at[1]];
}

/** True when two frames are the same within rounding. */
export function sameFrame(a: ViewFrame, b: ViewFrame): boolean {
  const near = (u: Vec3, v: Vec3) => Math.abs(u[0] - v[0]) + Math.abs(u[1] - v[1]) + Math.abs(u[2] - v[2]) < 1e-9;
  return near(a.eye, b.eye) && near(a.right, b.right) && near(a.up, b.up);
}
