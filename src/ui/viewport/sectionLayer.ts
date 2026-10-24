// The section view in a three.js scene: the clipping planes of the planes
// that are on (as three uses them: the normal into what is kept), applying
// them to materials as a corner cut (three's clipIntersection: a fragment
// goes only when it is on the cut side of every plane), and the planes drawn
// over the part as light translucent rectangles with a crisp border.
//
// For another view of the part (the sketcher's 3D view, say), showing the
// active section takes three steps:
//   const planes = clipPlanesOf(section);           // [] when off
//   clipObject(myGroup, planes);                    // every material under it
//   caps.set(capSources, planes, centre, size);     // a SectionCaps in the scene
// and `renderer.localClippingEnabled = true` (with `stencil: true` for caps).

import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import type { Vec3 } from "../../doc/types";
import { activePlanes, sectionPlane, sectionRect, type SectionView } from "../evaluate/section";

/** The clipping planes of the section's active planes (three keeps where the distance is ≥ 0); none while it is off. */
export function clipPlanesOf(view: SectionView | null): THREE.Plane[] {
  return activePlanes(view).map((s) => {
    const p = sectionPlane(s);
    return new THREE.Plane(new THREE.Vector3(...p.normal).negate(), p.constant);
  });
}

/** Clips one material by the planes, as a corner cut (cut only where on the cut side of all of them). */
export function clipMaterial(m: THREE.Material, planes: THREE.Plane[]): void {
  // The planes' numbers are uniforms, read every frame; only how many there are (and how they combine) needs a new shader.
  const structural = (m.clippingPlanes ?? []).length !== planes.length || m.clipIntersection !== planes.length > 1;
  m.clippingPlanes = planes.length ? planes : null;
  m.clipIntersection = planes.length > 1;
  if (structural) m.needsUpdate = true;
}

/** Clips every material under `root` (skipping those `skip` says to leave whole). */
export function clipObject(root: THREE.Object3D, planes: THREE.Plane[], skip?: (m: THREE.Material, o: THREE.Object3D) => boolean): void {
  root.traverse((o) => {
    const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    for (const m of [mat ?? []].flat()) if (!skip?.(m, o)) clipMaterial(m, planes);
  });
}

export interface SectionPlaneColors {
  fill: THREE.ColorRepresentation;
  border: THREE.ColorRepresentation;
  active: THREE.ColorRepresentation;
}

type Box = { min: Vec3; max: Vec3 };

/** The section's planes drawn over the part: a light rectangle each, its border crisp; the one the panel shows a little stronger. */
export class SectionPlanes {
  readonly group = new THREE.Group();
  private readonly resolution = new THREE.Vector2(1, 1);
  /** What is drawn now, per plane shown: so a moving plane only moves its points. */
  private drawn: { key: string; fill: THREE.Mesh; border: LineSegments2 }[] = [];

  constructor(private readonly colors: SectionPlaneColors) {
    this.group.name = "section-planes";
  }

  resize(w: number, h: number): void {
    this.resolution.set(w, h);
    for (const d of this.drawn) (d.border.material as LineMaterial).resolution.copy(this.resolution);
  }

  /** Draws the active planes of `view` (nothing while it is off or Show plane is unticked), sized to `box`. */
  set(view: SectionView | null, box: Box | null): void {
    const shown = !view || !view.on || !view.showPlane ? [] : view.planes.map((s, i) => ({ s, i })).filter(({ s }) => s.enabled !== false);
    const keys = shown.map(({ i }) => `${i}:${i === view!.active && view!.planes.length > 1 ? "active" : "plain"}`);
    if (keys.length !== this.drawn.length || keys.some((k, n) => k !== this.drawn[n].key)) this.build(keys);
    shown.forEach(({ s }, n) => {
      const { corners: [a, b, c, d] } = sectionRect(s, box);
      const pos = this.drawn[n].fill.geometry.getAttribute("position") as THREE.BufferAttribute;
      [a, b, c, a, c, d].forEach((p, k) => pos.setXYZ(k, p[0], p[1], p[2]));
      pos.needsUpdate = true;
      this.drawn[n].fill.geometry.computeBoundingSphere();
      (this.drawn[n].border.geometry as LineSegmentsGeometry).setPositions([a, b, b, c, c, d, d, a].flat());
    });
  }

  private build(keys: string[]): void {
    this.clear();
    for (const key of keys) {
      const active = key.endsWith("active");
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(18), 3));
      const fill = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: active ? this.colors.active : this.colors.fill,
          transparent: true,
          opacity: active ? 0.14 : 0.1,
          side: THREE.DoubleSide,
          depthWrite: false,
          // Over the cap it lies on.
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        }),
      );
      fill.renderOrder = 7;
      const lm = new LineMaterial({ color: new THREE.Color(active ? this.colors.active : this.colors.border).getHex(), linewidth: active ? 2.2 : 1.6, transparent: true, opacity: 0.9 });
      lm.resolution.copy(this.resolution);
      const border = new LineSegments2(new LineSegmentsGeometry(), lm);
      border.renderOrder = 7;
      this.group.add(fill, border);
      this.drawn.push({ key, fill, border });
    }
  }

  private clear(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      const o = child as THREE.Mesh;
      o.geometry?.dispose();
      (o.material as THREE.Material | undefined)?.dispose();
    }
    this.drawn = [];
  }

  dispose(): void {
    this.clear();
  }
}
