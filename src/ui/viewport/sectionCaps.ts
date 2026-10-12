// The section view's cap: where the clipping plane cuts the part, a flat
// hatched face, so the cut reads as solid material rather than a hollow
// shell. The usual stencil method: the part's back faces count up and its
// front faces count down behind the plane, so the stencil is non-zero exactly
// where the plane is inside material; a large quad on the plane is drawn only
// there. Works for any closed mesh, at no cost to the kernel.

import * as THREE from "three";

const VERTEX = `
varying vec3 vNormal;
void main() {
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** Diagonal hatching in screen space over the cap colour: reads as "cut material" at any zoom. */
const FRAGMENT = `
uniform vec3 color;
uniform vec3 hatch;
varying vec3 vNormal;
void main() {
  float s = step(0.55, fract((gl_FragCoord.x + gl_FragCoord.y) / 9.0));
  gl_FragColor = vec4(mix(color, hatch, s), 1.0);
}`;

export class SectionCaps {
  readonly group = new THREE.Group();
  private readonly back: THREE.MeshBasicMaterial;
  private readonly front: THREE.MeshBasicMaterial;
  private readonly cap: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;

  constructor(color: THREE.ColorRepresentation, hatch: THREE.ColorRepresentation) {
    const base = {
      depthWrite: false,
      depthTest: false,
      colorWrite: false,
      stencilWrite: true,
      stencilFunc: THREE.AlwaysStencilFunc,
    };
    this.back = new THREE.MeshBasicMaterial({
      ...base,
      side: THREE.BackSide,
      stencilFail: THREE.IncrementWrapStencilOp,
      stencilZFail: THREE.IncrementWrapStencilOp,
      stencilZPass: THREE.IncrementWrapStencilOp,
    });
    this.front = new THREE.MeshBasicMaterial({
      ...base,
      side: THREE.FrontSide,
      stencilFail: THREE.DecrementWrapStencilOp,
      stencilZFail: THREE.DecrementWrapStencilOp,
      stencilZPass: THREE.DecrementWrapStencilOp,
    });
    this.cap = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(color) }, hatch: { value: new THREE.Color(hatch) } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: THREE.DoubleSide,
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
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.cap);
    // The stencil is for this cap only: clear it once the cap is drawn.
    this.quad.onAfterRender = (renderer) => renderer.clearStencil();
    this.quad.renderOrder = 2.1;
    this.group.visible = false;
  }

  /**
   * Caps `geometry` (the visible part's triangles) where `plane` cuts it.
   * `size`: how far the quad reaches (the part's size is plenty). Null turns it off.
   */
  set(geometry: THREE.BufferGeometry | null, plane: THREE.Plane | null, size: number): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      if (child !== this.quad) (child as THREE.Mesh).geometry?.dispose();
    }
    this.group.visible = !!(geometry && plane);
    if (!geometry || !plane) return;
    this.back.clippingPlanes = [plane];
    this.front.clippingPlanes = [plane];
    const back = new THREE.Mesh(geometry, this.back);
    const front = new THREE.Mesh(geometry, this.front);
    back.renderOrder = 2;
    front.renderOrder = 2;
    this.group.add(back, front, this.quad);
    plane.coplanarPoint(this.quad.position);
    this.quad.lookAt(this.quad.position.clone().sub(plane.normal));
    this.quad.scale.setScalar(Math.max(1, size) * 4);
  }

  dispose(): void {
    this.set(null, null, 0);
    this.quad.geometry.dispose();
    this.back.dispose();
    this.front.dispose();
    this.cap.dispose();
  }
}
