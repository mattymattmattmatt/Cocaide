// Where each view looks from, and where its neighbours go on the sheet. A view
// is an orthographic projection: a point's place in the view is its dot with
// the view's right and up directions. The kernel's hidden-line projection uses
// the same frame, so a node, a member end or a hole lands on the lines drawn.

import type { Projection as SheetProjection, Vec2, Vec3, ViewLook } from "../doc/types";

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

const FRAMES: Record<ViewLook, ViewFrame> = {
  front: { eye: [0, -1, 0], right: [1, 0, 0], up: [0, 0, 1] },
  back: { eye: [0, 1, 0], right: [-1, 0, 0], up: [0, 0, 1] },
  top: { eye: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0] },
  bottom: { eye: [0, 0, -1], right: [1, 0, 0], up: [0, -1, 0] },
  right: { eye: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1] },
  left: { eye: [-1, 0, 0], right: [0, -1, 0], up: [0, 0, 1] },
  // From the front, right and above: the corner nearest is (max x, min y, max z).
  iso: { eye: [s3, -s3, s3], right: [s2, s2, 0], up: [-s6, s6, 2 * s6] },
};

export function viewFrame(look: ViewLook): ViewFrame {
  return FRAMES[look];
}

/** A point of the part, in the view (model mm, x right, y up). */
export function inView(p: Vec3, f: ViewFrame): Vec2 {
  return [p[0] * f.right[0] + p[1] * f.right[1] + p[2] * f.right[2], p[0] * f.up[0] + p[1] * f.up[1] + p[2] * f.up[2]];
}

/** A direction of the part, in the view; its length is how much of it the view shows. */
export function dirInView(d: Vec3, f: ViewFrame): Vec2 {
  return inView(d, f);
}

/** The model direction a direction on the view is. */
export function toModel(d: Vec2, f: ViewFrame): Vec3 {
  return [f.right[0] * d[0] + f.up[0] * d[1], f.right[1] * d[0] + f.up[1] * d[1], f.right[2] * d[0] + f.up[2] * d[1]];
}

/** Views that look square at the part: a length along the view is a true length. */
export function isOrthographic(look: ViewLook): boolean {
  return look !== "iso";
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
