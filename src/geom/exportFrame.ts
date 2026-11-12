// Where an exported file's axes go (Export bodies): a new origin, which way is
// up, which way the front faces, and the convention the receiving program
// uses (most CAD: Z up; many mesh tools and some CAD: Y up). Pure.

import type { Vec3 } from "../doc/types";
import { add3, cross3, dot3, normalize3, scale3, sub3 } from "./vec";

/** "zUp": up is the file's +Z and the front faces -Y (the usual CAD front view looks along +Y). "yUp": up is +Y and the front faces +Z. */
export type UpConvention = "zUp" | "yUp";

export interface ExportFrame {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

/** The six axis directions, by name, for the pickers. */
export const AXIS_DIRECTIONS: { id: string; label: string; dir: Vec3 }[] = [
  { id: "+Z", label: "+Z", dir: [0, 0, 1] },
  { id: "-Z", label: "−Z", dir: [0, 0, -1] },
  { id: "+Y", label: "+Y", dir: [0, 1, 0] },
  { id: "-Y", label: "−Y", dir: [0, -1, 0] },
  { id: "+X", label: "+X", dir: [1, 0, 0] },
  { id: "-X", label: "−X", dir: [-1, 0, 0] },
];

const clean = (v: Vec3): Vec3 => v.map((x) => (Math.abs(x) < 1e-12 ? 0 : Math.round(x * 1e12) / 1e12)) as Vec3;

/**
 * The frame (in model coordinates) that becomes the file's axes: origin
 * `origin`, `up` along the convention's up axis, `front` (made square to up)
 * facing the convention's front. A string says why not (up and front parallel).
 */
export function exportFrame(origin: Vec3, up: Vec3, front: Vec3, convention: UpConvention = "zUp"): ExportFrame | string {
  if (Math.hypot(...up) < 1e-12) return "Up has no direction";
  const u = normalize3(up);
  const laid = sub3(front, scale3(u, dot3(front, u)));
  if (Math.hypot(...laid) < 1e-6 * Math.max(1, Math.hypot(...front))) return "Front must not run along Up: pick a front direction square to it";
  const f = normalize3(laid);
  let x: Vec3, y: Vec3, z: Vec3;
  if (convention === "zUp") {
    z = u;
    y = scale3(f, -1);
    x = cross3(y, z);
  } else {
    y = u;
    z = f;
    x = cross3(y, z);
  }
  return { origin: clean(origin), x: clean(normalize3(x)), y: clean(normalize3(y)), z: clean(normalize3(z)) };
}

/** Is it the frame that changes nothing (the model's own axes and origin)? */
export function isIdentity(f: ExportFrame): boolean {
  const same = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-9;
  return same(f.origin, [0, 0, 0]) && same(f.x, [1, 0, 0]) && same(f.y, [0, 1, 0]) && same(f.z, [0, 0, 1]);
}

/** Where a model point lands in the file. */
export function toFile(f: ExportFrame, p: Vec3): Vec3 {
  const d = sub3(p, f.origin);
  return [dot3(d, f.x), dot3(d, f.y), dot3(d, f.z)];
}

/**
 * A box's special points for the origin: its centre, and the middle of its
 * bottom (lowest along `up`), in model coordinates.
 */
export function boxPoints(box: { min: Vec3; max: Vec3 }, up: Vec3): { centre: Vec3; bottom: Vec3 } {
  const centre = scale3(add3(box.min, box.max), 0.5);
  const u = normalize3(up);
  let low = Infinity;
  for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) low = Math.min(low, dot3(sub3([x, y, z], centre), u));
  return { centre: clean(centre), bottom: clean(add3(centre, scale3(u, low))) };
}
