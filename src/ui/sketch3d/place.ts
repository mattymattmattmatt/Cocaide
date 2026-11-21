// Drawing a 3D sketch in the view: each click lands on a work plane (XY, XZ
// or YZ, Tab cycles) through the point drawn from, snapped to a grid whose
// step suits the zoom (so a line drawn roughly along an axis lands on it), or
// onto an existing point. Pure: the viewport supplies the ray hit and the
// screen distances.

import type { Vec3 } from "../../doc/types";

export type WorkPlane = "XY" | "XZ" | "YZ";
export const WORK_PLANES: readonly WorkPlane[] = ["XY", "XZ", "YZ"];
export const PLANE_NORMAL: Record<WorkPlane, Vec3> = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };
/** The two axes (indices) that lie in each plane. */
export const PLANE_AXES: Record<WorkPlane, [number, number]> = { XY: [0, 1], XZ: [0, 2], YZ: [1, 2] };

export const nextPlane = (p: WorkPlane): WorkPlane => WORK_PLANES[(WORK_PLANES.indexOf(p) + 1) % WORK_PLANES.length];

/** A round grid step (1, 2 or 5 × 10ⁿ mm) at least `px` pixels wide at this zoom. */
export function niceStep(worldPerPixel: number, px = 14): number {
  const want = Math.max(worldPerPixel * px, 1e-3);
  const p = 10 ** Math.floor(Math.log10(want));
  for (const k of [1, 2, 5, 10]) if (k * p >= want - 1e-12) return k * p;
  return 10 * p;
}

/**
 * Where a click on the plane puts the next point: the hit snapped to the grid
 * measured from `base` (the point drawn from, or the origin), in the plane's
 * two axes; the third stays the base's.
 */
export function snapToGrid(hit: Vec3, base: Vec3, plane: WorkPlane, step: number): Vec3 {
  const out: Vec3 = [...base];
  for (const k of PLANE_AXES[plane]) out[k] = base[k] + Math.round((hit[k] - base[k]) / step) * step;
  return out.map((x) => Math.round(x * 1e6) / 1e6 + 0) as Vec3;
}

/** The ray from the eye through the pointer, met with the plane through `base`; null when it runs along the plane. */
export function rayPlane(origin: Vec3, dir: Vec3, base: Vec3, plane: WorkPlane): Vec3 | null {
  const n = PLANE_NORMAL[plane];
  const k = n.findIndex((x) => x !== 0);
  if (Math.abs(dir[k]) < 1e-9) return null;
  const t = (base[k] - origin[k]) / dir[k];
  if (t < 0) return null;
  return [origin[0] + t * dir[0], origin[1] + t * dir[1], origin[2] + t * dir[2]];
}

/** "Δ 250, 0, 300 · 390.51 mm": what the tip says about the line being drawn. */
export function deltaText(from: Vec3 | null, to: Vec3): string {
  const r = (x: number) => String(Math.round(x * 100) / 100 + 0);
  if (!from) return `${to.map(r).join(", ")}`;
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  return `Δ ${d.map(r).join(", ")} · ${r(Math.hypot(...d))} mm`;
}
