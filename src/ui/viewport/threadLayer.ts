// Cosmetic threads in the 3D view: each thread feature's and tapped hole's
// thread drawn on its round face as the usual band, a light sleeve with the
// helix wound over it, a hair off the face so it shows. The band covers the
// thread's length from where it starts; a pattern's copies of a tapped hole
// get theirs on each copy's face (the faces of the same radius and axis).
// A modelled thread is the real shape already and gets no band.
// threadBands is pure (Vitest covers it); ThreadLayer draws them.

import * as THREE from "three";
import type { Vec3 } from "../../doc/types";
import type { HoleRecord } from "../../kernel/rebuild";
import type { FaceInfo } from "../../kernel/topology";

/** One band to draw: from `start` along unit `axis` for `length`, on a face of `radius`. */
export interface ThreadBand {
  feature: string;
  start: Vec3;
  axis: Vec3;
  length: number;
  radius: number;
  pitch: number;
  internal: boolean;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const unit = (a: Vec3): Vec3 => mul(a, 1 / (Math.hypot(...a) || 1));

/**
 * The bands of the cosmetic threads: one per round face a thread record is
 * on (its own face; with pattern copies, every face like it). A modelled
 * thread is cut already and gets none.
 */
export function threadBands(holes: readonly HoleRecord[], faces: readonly FaceInfo[]): ThreadBand[] {
  const out: ThreadBand[] = [];
  for (const h of holes) {
    if (!h.thread || h.thread.modelled) continue;
    const internal = !h.thread.external;
    const radius = internal ? h.diameter / 2 : h.thread.major / 2;
    const axis = unit(h.axis);
    const length = h.thread.depth === "through" ? h.depth : Math.min(h.thread.depth, h.depth);
    for (const f of faces) {
      const c = f.cylinder;
      if (f.type !== "cylinder" || !c || c.concave !== internal || Math.abs(c.radius - radius) > 1e-4) continue;
      const a = unit(c.axis);
      if (Math.abs(Math.abs(dot(a, axis)) - 1) > 1e-6) continue;
      const ends = [add(c.origin, mul(a, c.axial[0])), add(c.origin, mul(a, c.axial[1]))];
      // The end the thread starts from: the one it runs away from (least along its axis).
      const start = dot(ends[0], axis) <= dot(ends[1], axis) ? ends[0] : ends[1];
      if (h.copies === 0) {
        // Its own face only: the record's entry lies on this face's axis, at its end.
        const off = sub(h.entry, start);
        const across = sub(off, mul(axis, dot(off, axis)));
        if (Math.hypot(...across) > 1e-3 || Math.abs(dot(off, axis)) > 1e-3) continue;
      }
      const faceLength = c.axial[1] - c.axial[0];
      out.push({ feature: h.feature, start, axis, length: Math.min(length, faceLength), radius, pitch: h.thread.pitch, internal });
    }
  }
  return out;
}

/** The view's cosmetic thread bands. */
export class ThreadLayer {
  readonly group = new THREE.Group();
  private bands: ThreadBand[] = [];

  constructor() {
    this.group.name = "threads";
  }

  /** How many bands are drawn (the e2e hook reads it). */
  count(): number {
    return this.bands.length;
  }

  set(bands: ThreadBand[]): void {
    this.bands = bands;
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      const m = child as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    }
    for (const b of bands) {
      // A hair off the face, toward the side it is seen from: into the hole, out from the shaft.
      const r = b.radius * (b.internal ? 0.992 : 1.008);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...b.axis));
      const sleeve = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r, b.length, 48, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xc8901e, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
      );
      sleeve.quaternion.copy(q);
      sleeve.position.set(...add(b.start, mul(b.axis, b.length / 2)));
      sleeve.renderOrder = 3;
      // The helix over it: a turn a pitch (at most 200 drawn, spread over the length).
      const turns = Math.min(200, Math.max(1, b.length / b.pitch));
      const steps = Math.ceil(turns * 24);
      const pts: THREE.Vector3[] = [];
      const u = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      const v = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      const z = new THREE.Vector3(...b.axis);
      const o = new THREE.Vector3(...b.start);
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * turns * 2 * Math.PI;
        pts.push(o.clone().addScaledVector(u, r * Math.cos(t)).addScaledVector(v, r * Math.sin(t)).addScaledVector(z, (b.length * i) / steps));
      }
      const helix = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x9a6510, transparent: true, opacity: 0.85 }));
      helix.renderOrder = 3;
      this.group.add(sleeve, helix);
    }
  }
}
