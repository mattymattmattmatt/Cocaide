// The section view's caps: where the clipping planes cut the part, flat
// hatched faces, so the cut reads as solid material rather than a hollow
// shell. The usual stencil method, once per plane: the part's back faces
// count up and its front faces count down, clipped by that plane alone, so
// the stencil is non-zero exactly where the plane is inside material; a large
// quad on the plane is drawn only there, and only where it is on the cut side
// of every other plane (with two or three planes the removed region is their
// corner, and the cap of each plane is its share of that corner's walls).
// One colour for every body, or each body's own. Works for any closed mesh,
// at no cost to the kernel. Moving a plane (dragging its arrow) only moves
// numbers: the materials stay, so nothing is recompiled while you drag.

import * as THREE from "three";

const VERTEX = `
#include <clipping_planes_pars_vertex>
void main() {
  #include <begin_vertex>
  #include <project_vertex>
  #include <clipping_planes_vertex>
}`;

/** Diagonal hatching in screen space over the cap colour: reads as "cut material" at any zoom. */
const FRAGMENT = `
#include <clipping_planes_pars_fragment>
uniform vec3 color;
uniform vec3 hatch;
void main() {
  #include <clipping_planes_fragment>
  float s = step(0.55, fract((gl_FragCoord.x + gl_FragCoord.y) / 9.0));
  gl_FragColor = vec4(mix(color, hatch, s), 1.0);
}`;

/** What a cap is made from: some of the part's triangles (a body, or every cut body), and their cap colours. */
export interface CapSource {
  geometry: THREE.BufferGeometry;
  color: THREE.ColorRepresentation;
  hatch: THREE.ColorRepresentation;
}

interface Built {
  sources: CapSource[];
  /** The caps' own copies of the planes, which their materials point at. */
  planes: THREE.Plane[];
  /** Per plane: the other planes turned round (the cap is only on their cut side). */
  others: THREE.Plane[][];
  /** Per plane, per source: the cap's quad. */
  quads: THREE.Mesh[][];
  materials: THREE.Material[];
}

export class SectionCaps {
  readonly group = new THREE.Group();
  private readonly quadGeometry = new THREE.PlaneGeometry(1, 1);
  private built: Built | null = null;

  constructor() {
    this.group.visible = false;
  }

  /**
   * Caps the sources where `planes` cut them. `planes` are the clipping
   * planes as the part uses them (three keeps where the distance is ≥ 0: the
   * normal points into what is kept). `centre` and `size`: where the part is
   * and how far a quad must reach to cover it. No planes or no sources turn
   * the caps off.
   */
  set(sources: CapSource[], planes: THREE.Plane[], centre: THREE.Vector3, size: number): void {
    const on = sources.length > 0 && planes.length > 0;
    this.group.visible = on;
    if (!on) return this.clear();
    const b = this.built;
    const same =
      b &&
      b.planes.length === planes.length &&
      b.sources.length === sources.length &&
      b.sources.every((s, i) => s.geometry === sources[i].geometry && new THREE.Color(s.color).equals(new THREE.Color(sources[i].color)) && new THREE.Color(s.hatch).equals(new THREE.Color(sources[i].hatch)));
    if (!same) this.build(sources, planes.length);
    const built = this.built!;
    planes.forEach((p, i) => {
      built.planes[i].copy(p);
      let k = 0;
      planes.forEach((q, j) => {
        if (j !== i) built.others[i][k++].copy(q).negate();
      });
      for (const quad of built.quads[i]) {
        // On the plane, over the part's middle, facing along it.
        quad.position.copy(centre).addScaledVector(p.normal, -p.distanceToPoint(centre));
        quad.lookAt(quad.position.clone().sub(p.normal));
        quad.scale.setScalar(Math.max(1, size) * 4);
      }
    });
  }

  private build(sources: CapSource[], count: number): void {
    this.clear();
    const planes = Array.from({ length: count }, () => new THREE.Plane());
    const others = planes.map(() => Array.from({ length: count - 1 }, () => new THREE.Plane()));
    const quads: THREE.Mesh[][] = [];
    const materials: THREE.Material[] = [];
    let order = 2;
    planes.forEach((plane, i) => {
      quads.push([]);
      for (const src of sources) {
        const back = new THREE.MeshBasicMaterial(stencil(THREE.BackSide, THREE.IncrementWrapStencilOp, plane));
        const front = new THREE.MeshBasicMaterial(stencil(THREE.FrontSide, THREE.DecrementWrapStencilOp, plane));
        const cap = new THREE.ShaderMaterial({
          uniforms: { color: { value: new THREE.Color(src.color) }, hatch: { value: new THREE.Color(src.hatch) } },
          vertexShader: VERTEX,
          fragmentShader: FRAGMENT,
          side: THREE.DoubleSide,
          clipping: true,
          clippingPlanes: others[i],
          stencilWrite: true,
          stencilRef: 0,
          stencilFunc: THREE.NotEqualStencilFunc,
          stencilFail: THREE.ReplaceStencilOp,
          stencilZFail: THREE.ReplaceStencilOp,
          stencilZPass: THREE.ReplaceStencilOp,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        });
        materials.push(back, front, cap);
        const bm = new THREE.Mesh(src.geometry, back);
        const fm = new THREE.Mesh(src.geometry, front);
        bm.renderOrder = order;
        fm.renderOrder = order;
        const quad = new THREE.Mesh(this.quadGeometry, cap);
        quad.renderOrder = order + 0.005;
        // The stencil is for this cap only: clear it once the cap is drawn.
        quad.onAfterRender = (renderer) => renderer.clearStencil();
        quads[i].push(quad);
        this.group.add(bm, fm, quad);
        order += 0.01;
      }
    });
    this.built = { sources: [...sources], planes, others, quads, materials };
  }

  private clear(): void {
    for (const child of [...this.group.children]) this.group.remove(child);
    for (const m of this.built?.materials ?? []) m.dispose();
    this.built = null;
  }

  dispose(): void {
    this.clear();
    this.quadGeometry.dispose();
  }
}

function stencil(side: THREE.Side, op: THREE.StencilOp, plane: THREE.Plane): THREE.MeshBasicMaterialParameters {
  return {
    depthWrite: false,
    depthTest: false,
    colorWrite: false,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    side,
    stencilFail: op,
    stencilZFail: op,
    stencilZPass: op,
    clippingPlanes: [plane],
  };
}
