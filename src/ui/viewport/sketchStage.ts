// The sketch plane in the 3D view while a sketch is open (Phase P wave 2A):
// a faint rectangle on the plane, a little larger than the part and the
// sketch seen square onto it, with a crisp border; the part in front hides
// it. The rectangle's size is worked out in a pure function (planeRect).

import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import type { Vec2, Vec3 } from "../../doc/types";
import { to2D, to3D, type Frame } from "../../geom/frame";
import { planeBounds } from "../sketcher/planeView";

/**
 * The corners (world, counter-clockwise about the normal) of the rectangle on
 * the plane that holds the points (flat xyz: the part's box corners, the
 * sketch's points) seen square on, with a margin of an eighth of its size (at
 * least `least` mm); round the plane's origin, `least` each way, with none.
 */
export function planeRect(frame: Frame, points: ArrayLike<number>, least = 10): [Vec3, Vec3, Vec3, Vec3] {
  const { min, max } = planeBounds(frame, points, least);
  const [x0, y0, x1, y1] = [min[0], min[1], max[0], max[1]];
  return [to3D(frame, [x0, y0]), to3D(frame, [x1, y0]), to3D(frame, [x1, y1]), to3D(frame, [x0, y1])];
}

/**
 * Where a view square onto the sketch plane looks, and its scale (mm per
 * pixel), framed as the flat sketch page always was (on its 800 × 600 page,
 * whatever the view's size, so a sketch opens at the zoom, and the grid step,
 * it always had): the points (flat xyz: the part, the sketch) seen square on,
 * with the plane's origin, take 1/1.4 of the page each way (at least 20 mm);
 * with none, 120 mm across the page's height, round the origin.
 */
export function facingFit(frame: Frame, points: ArrayLike<number>, width = 800, height = 600): { center: Vec3; wpp: number } {
  let min: Vec2 = [0, 0];
  let max: Vec2 = [0, 0];
  let any = false;
  for (let i = 0; i + 2 < points.length; i += 3) {
    const p = to2D(frame, [points[i], points[i + 1], points[i + 2]]);
    min = [Math.min(min[0], p[0]), Math.min(min[1], p[1])];
    max = [Math.max(max[0], p[0]), Math.max(max[1], p[1])];
    any = true;
  }
  if (!any) return { center: [...frame.origin], wpp: 120 / Math.min(width, height) };
  const w = Math.max(max[0] - min[0], 20);
  const h = Math.max(max[1] - min[1], 20);
  return { center: to3D(frame, [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2]), wpp: Math.max((w * 1.4) / width, (h * 1.4) / height) };
}

/** The eight corners of a box, flat xyz. */
export function boxCorners(min: Vec3, max: Vec3): number[] {
  const out: number[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push(x, y, z);
  return out;
}

/** The plane drawn: a faint fill and a border, under whatever of the part is in front of it. */
export class SketchPlaneLayer {
  readonly group = new THREE.Group();
  private readonly fill: THREE.Mesh;
  private readonly border: LineSegments2;

  constructor(colors: { fill: THREE.ColorRepresentation; border: THREE.ColorRepresentation }) {
    this.group.name = "sketch-plane";
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(18), 3));
    this.fill = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: colors.fill, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    );
    this.fill.renderOrder = 2;
    const lm = new LineMaterial({ color: new THREE.Color(colors.border).getHex(), linewidth: 1.4, transparent: true, opacity: 0.55, dashed: false });
    this.border = new LineSegments2(new LineSegmentsGeometry(), lm);
    this.border.renderOrder = 2;
    this.group.add(this.fill, this.border);
    this.group.visible = false;
  }

  resize(w: number, h: number): void {
    (this.border.material as LineMaterial).resolution.set(w, h);
  }

  /** Shows the rectangle on `frame` round the points (flat xyz), or hides it (null). */
  set(frame: Frame | null, points: ArrayLike<number> = []): void {
    this.group.visible = !!frame;
    if (!frame) return;
    const [a, b, c, d] = planeRect(frame, points);
    const pos = this.fill.geometry.getAttribute("position") as THREE.BufferAttribute;
    [a, b, c, a, c, d].forEach((p, k) => pos.setXYZ(k, p[0], p[1], p[2]));
    pos.needsUpdate = true;
    this.fill.geometry.computeBoundingSphere();
    (this.border.geometry as LineSegmentsGeometry).setPositions([a, b, b, c, c, d, d, a].flat());
  }

  dispose(): void {
    this.fill.geometry.dispose();
    (this.fill.material as THREE.Material).dispose();
    this.border.geometry.dispose();
    (this.border.material as THREE.Material).dispose();
  }
}
