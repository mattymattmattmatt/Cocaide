// The helix a sweep can follow (a spring, a coil, a thread), pure: its
// numbers (any two of pitch, turns and height give the third) and its points.
// The kernel builds it exactly, as a line on a cylinder (or, tapered, on a
// cone) unrolled flat: see src/kernel/paths.ts.

import type { DatumRef, Vec3 } from "../../doc/types";
import { add3, cross3, normalize3, scale3 } from "../../geom/vec";

/** A helix about an axis (DESIGN §2.6): radius, and two of pitch, turns and height. */
export interface HelixSpec {
  /** The axis it winds about: a default axis, an axis feature, a straight or circular edge, a cylinder. */
  axis: DatumRef;
  /** mm from the axis (at the start, when tapered). */
  radius: number;
  /** mm it climbs per turn. */
  pitch?: number;
  /** How many turns (need not be whole). */
  turns?: number;
  /** mm it climbs in all, along the axis. */
  height?: number;
  /** Wind clockwise looking down the axis (a left-hand thread); default right-handed. */
  leftHanded?: boolean;
  /** Degrees: the radius grows (or, negative, shrinks) along the axis at this angle (a conical spring). */
  taper?: number;
  /** Degrees about the axis where it starts, from the axis frame's x direction; only for a circle sweep (a profile sketch sets the start itself). */
  startAngle?: number;
}

/** The steepest taper allowed (degrees either way). */
export const MAX_TAPER = 80;

/** The helix's pitch, turns and height, from the two given; or why they do not fit. */
export function helixNumbers(h: Pick<HelixSpec, "pitch" | "turns" | "height">): { pitch: number; turns: number; height: number } | string {
  const given = (["pitch", "turns", "height"] as const).filter((k) => h[k] !== undefined);
  if (given.length < 2) return `give two of "pitch", "turns" and "height" (got ${given.length ? `only "${given[0]}"` : "none"})`;
  if (given.length > 2) return `give two of "pitch", "turns" and "height", not all three: the third follows from them`;
  if (h.pitch === undefined) return { pitch: h.height! / h.turns!, turns: h.turns!, height: h.height! };
  if (h.turns === undefined) return { pitch: h.pitch, turns: h.height! / h.pitch, height: h.height! };
  return { pitch: h.pitch, turns: h.turns, height: h.pitch * h.turns };
}

/** The radius at the end of a tapered helix (the start radius untapered). */
export function endRadius(radius: number, height: number, taper = 0): number {
  return radius + height * Math.tan((taper * Math.PI) / 180);
}

/** A frame about the axis: x and y square to it, the helix starting along x. */
export interface AxisFrame {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

/** A frame for an axis: x from the default rule (the world X, or Y for an axis along X), turned by `startAngle`. */
export function axisFrame(origin: Vec3, direction: Vec3, startAngle = 0): AxisFrame {
  const z = normalize3(direction);
  const ref: Vec3 = Math.abs(z[0]) < 1 - 1e-9 ? [1, 0, 0] : [0, 1, 0];
  const dotRef = ref[0] * z[0] + ref[1] * z[1] + ref[2] * z[2];
  const x0 = normalize3(add3(ref, scale3(z, -dotRef)));
  const y0 = cross3(z, x0);
  const a = (startAngle * Math.PI) / 180;
  const x = add3(scale3(x0, Math.cos(a)), scale3(y0, Math.sin(a)));
  return { origin: [...origin], x, y: cross3(z, x), z };
}

/** The point `t` turns along the helix (t from 0 to turns). */
export function helixPoint(frame: AxisFrame, radius: number, pitch: number, t: number, opts: { leftHanded?: boolean; taper?: number } = {}): Vec3 {
  const z = pitch * t;
  const r = endRadius(radius, z, opts.taper);
  const a = 2 * Math.PI * t * (opts.leftHanded ? -1 : 1);
  return add3(frame.origin, add3(add3(scale3(frame.x, r * Math.cos(a)), scale3(frame.y, r * Math.sin(a))), scale3(frame.z, z)));
}

/** The length of an untapered helix: each turn the hypotenuse of its circumference and pitch. */
export function helixLength(radius: number, pitch: number, turns: number): number {
  return turns * Math.hypot(2 * Math.PI * radius, pitch);
}
