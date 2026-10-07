// Plane frames. Datum sketch planes and hole faces share one rule, so a 2D
// coordinate means the same thing in a sketch and in a hole's `center`.

import type { Vec2, Vec3 } from "../doc/types";
import { add3, cross3, dot3, normalize3, scale3, sub3 } from "./vec";

export interface Frame {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  /** Plane normal. */
  z: Vec3;
}

/**
 * x = xDir if given, else global X projected onto the plane (global Y when the
 * normal is parallel to X); y = z × x. Right-handed, so a counter-clockwise
 * loop in (x, y) winds counter-clockwise about the normal.
 */
export function planeFrame(normal: Vec3, origin: Vec3, xDir?: Vec3): Frame {
  const z = normalize3(normal);
  const ref: Vec3 = xDir ?? (Math.abs(z[0]) < 1 - 1e-9 ? [1, 0, 0] : [0, 1, 0]);
  const x = normalize3(sub3(ref, scale3(z, dot3(ref, z))));
  const y = cross3(z, x);
  return { origin: [...origin], x, y, z };
}

/** Frame for a face plane: origin is the global origin projected onto the plane. */
export function facePlaneFrame(normal: Vec3, pointOnPlane: Vec3): Frame {
  const z = normalize3(normal);
  const origin = scale3(z, dot3(pointOnPlane, z));
  return planeFrame(z, origin);
}

export function to3D(frame: Frame, p: Vec2): Vec3 {
  return add3(frame.origin, add3(scale3(frame.x, p[0]), scale3(frame.y, p[1])));
}

export function to2D(frame: Frame, p: Vec3): Vec2 {
  const d = sub3(p, frame.origin);
  return [dot3(d, frame.x), dot3(d, frame.y)];
}
