// The look of a feature session's preview (Phase P wave 2): over the part as
// it stands before the feature, the material the feature adds is drawn in the
// accent colour, and the material it removes as a translucent red ghost (its
// faces where they show, fainter through the part, and its edges), so what
// the feature does reads at a glance. A preview that failed keeps the last one
// that built, with a red marker at the feature (an HTML tag that says why).

import * as THREE from "three";
import type { Vec3 } from "../../doc/types";
import type { MeshData } from "../../kernel/mesh";

export interface PreviewLook {
  /** The material the feature adds, and the material it removes (null: none). */
  added: MeshData | null;
  removed: MeshData | null;
  /** The feature failed: where to mark it, and why (the meshes are the last that built). */
  failed?: { at: Vec3; text: string } | null;
}

/** The colours: the accent, the ghost's red (CSS tokens --preview-add, --preview-remove when the page sets them). */
export interface PreviewColours {
  add: THREE.Color;
  remove: THREE.Color;
}

/** Draws a session's preview into its group; `marker` is an HTML element the view places over the failure. */
export class PreviewLayer {
  readonly group = new THREE.Group();
  private marker: HTMLElement;
  private markerAt: Vec3 | null = null;

  constructor(
    host: HTMLElement,
    private readonly colours: PreviewColours,
  ) {
    this.marker = document.createElement("div");
    this.marker.className = "preview-failed";
    this.marker.dataset.testid = "preview-failed";
    this.marker.style.display = "none";
    host.appendChild(this.marker);
  }

  private clear() {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      c.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
    }
  }

  private geometry(m: MeshData): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    g.computeBoundingSphere();
    return g;
  }

  private edges(m: MeshData, color: THREE.Color, opacity: number, depthTest: boolean): THREE.LineSegments {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(m.edges, 3));
    const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest, depthWrite: false }));
    line.renderOrder = depthTest ? 7 : 8;
    return line;
  }

  /** What to draw now; `clip` the section's planes (the preview is cut with the part). */
  set(look: PreviewLook | null, clip: THREE.Plane[] = []) {
    this.clear();
    const clipping = { clippingPlanes: clip, clipIntersection: clip.length > 1 };
    if (look?.added) {
      // What it adds: solid, in the accent colour, a little in front where it meets the part's own faces.
      const mesh = new THREE.Mesh(
        this.geometry(look.added),
        new THREE.MeshStandardMaterial({ color: this.colours.add.clone().lerp(new THREE.Color(0xffffff), 0.3), metalness: 0.1, roughness: 0.5, transparent: true, opacity: 0.88, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2, ...clipping }),
      );
      mesh.renderOrder = 2;
      this.group.add(mesh, this.edges(look.added, this.colours.add.clone().multiplyScalar(0.6), 0.9, true));
    }
    if (look?.removed) {
      const g = this.geometry(look.removed);
      // What it removes: a red ghost, stronger where its faces show, fainter through the part in front of it.
      const front = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: this.colours.remove, transparent: true, opacity: 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, side: THREE.DoubleSide, ...clipping }));
      front.renderOrder = 6;
      const through = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: this.colours.remove, transparent: true, opacity: 0.16, depthWrite: false, depthTest: false, side: THREE.DoubleSide, ...clipping }));
      through.renderOrder = 7;
      this.group.add(front, through, this.edges(look.removed, this.colours.remove, 0.95, true), this.edges(look.removed, this.colours.remove, 0.35, false));
    }
    this.markerAt = look?.failed?.at ?? null;
    this.marker.textContent = look?.failed ? `!  ${look.failed.text}` : "";
    this.marker.title = look?.failed?.text ?? "";
    this.marker.style.display = look?.failed ? "" : "none";
  }

  /** After each render: the failure marker over its point. */
  place(camera: THREE.Camera, w: number, h: number) {
    if (!this.markerAt) return;
    const v = new THREE.Vector3(...this.markerAt).project(camera);
    this.marker.style.display = v.z < 1 ? "" : "none";
    this.marker.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
  }

  /** Is anything drawn (for the tests): what it adds, removes, and the failure marker. */
  shown(): { added: boolean; removed: boolean; failed: boolean } {
    const meshes = this.group.children.filter((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh[];
    return {
      added: meshes.some((m) => (m.material as THREE.Material).type === "MeshStandardMaterial"),
      removed: meshes.some((m) => (m.material as THREE.Material).type === "MeshBasicMaterial"),
      failed: !!this.markerAt,
    };
  }

  dispose() {
    this.clear();
    this.marker.remove();
  }
}
