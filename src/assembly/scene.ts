// The assembly as one view for the viewport: each shown component's part
// (its rebuilt view: mesh, faces, edges) moved to its place and joined, each
// component a "body" of the joined view, so picking, highlighting and the
// bodies' colours work as they do on a part. What a face or edge of the
// joined view is, on its component's part, is kept alongside. Pure.

import type { Vec3 } from "../doc/types";
import type { MeshData } from "../kernel/mesh";
import type { EdgeInfo, FaceInfo } from "../kernel/topology";
import type { RebuildView } from "../worker/protocol";
import { apply, pointTo, type Placement } from "./transform";

export interface SceneComponent {
  id: string;
  placement: Placement;
  /** Its part, rebuilt (undefined while it builds, or when it can't be). */
  view: RebuildView | undefined;
  hidden?: boolean;
}

export interface Owner {
  component: string;
  /** The face's or edge's index on the component's part. */
  local: number;
}

export interface AssemblyScene {
  view: RebuildView;
  faceOwner: Owner[];
  edgeOwner: Owner[];
}

export function composeScene(components: SceneComponent[], name = "assembly"): AssemblyScene {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faceRanges: MeshData["faceRanges"] = [];
  const edges: number[] = [];
  const edgeRanges: MeshData["edgeRanges"] = [];
  const faces: FaceInfo[] = [];
  const edgeInfos: EdgeInfo[] = [];
  const bodies: RebuildView["bodies"] = [];
  const faceOwner: Owner[] = [];
  const edgeOwner: Owner[] = [];
  // Texture coordinates (a mesh part's; zeros for the rest) and texture images, only when some part has them.
  const anyUvs = components.some((k) => !k.hidden && k.view?.mesh?.uvs);
  const uvs: number[] = [];
  const textures: NonNullable<RebuildView["textures"]> = {};
  for (const k of components) {
    const v = k.view;
    if (k.hidden || !v) continue;
    const m: MeshData = v.mesh ?? { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(), faceRanges: [], edges: new Float32Array(), edgeRanges: [] };
    const P = k.placement;
    const vertexBase = positions.length / 3;
    const indexBase = indices.length;
    const segmentBase = edges.length / 6;
    const faceBase = faces.length;
    const edgeBase = edgeInfos.length;
    for (let i = 0; i < m.positions.length; i += 3) {
      const p = pointTo(P, [m.positions[i], m.positions[i + 1], m.positions[i + 2]]);
      positions.push(p[0], p[1], p[2]);
      const n = apply(P.R, [m.normals[i], m.normals[i + 1], m.normals[i + 2]]);
      normals.push(n[0], n[1], n[2]);
    }
    if (anyUvs) {
      if (m.uvs) for (let i = 0; i < m.uvs.length; i++) uvs.push(m.uvs[i]);
      else for (let i = 0; i < m.positions.length / 3; i++) uvs.push(0, 0);
    }
    if (v.textures) Object.assign(textures, v.textures);
    for (let i = 0; i < m.indices.length; i++) indices.push(m.indices[i] + vertexBase);
    for (const r of m.faceRanges) faceRanges.push({ start: r.start + indexBase, count: r.count });
    for (let i = 0; i < m.edges.length; i += 3) {
      const p = pointTo(P, [m.edges[i], m.edges[i + 1], m.edges[i + 2]]);
      edges.push(p[0], p[1], p[2]);
    }
    for (const r of m.edgeRanges) edgeRanges.push({ start: r.start + segmentBase, count: r.count });
    const pt = (p: Vec3) => pointTo(P, p);
    const dir = (d: Vec3) => apply(P.R, d);
    for (const f of v.faces) {
      const normal = f.normal ? dir(f.normal) : undefined;
      const point = f.point ? pt(f.point) : undefined;
      faces.push({
        ...f,
        index: f.index + faceBase,
        centroid: pt(f.centroid),
        ...(normal ? { normal } : {}),
        ...(point ? { point } : {}),
        ...(normal && point ? { offset: normal[0] * point[0] + normal[1] * point[1] + normal[2] * point[2] } : {}),
        ...(f.cylinder ? { cylinder: { ...f.cylinder, origin: pt(f.cylinder.origin), axis: dir(f.cylinder.axis) } } : {}),
        ...(f.body !== undefined ? { partBody: f.body } : {}),
        body: k.id,
      });
      faceOwner.push({ component: k.id, local: f.index });
    }
    for (const e of v.edges) {
      edgeInfos.push({
        ...e,
        index: e.index + edgeBase,
        start: pt(e.start),
        end: pt(e.end),
        mid: pt(e.mid),
        centroid: pt(e.centroid),
        ...(e.direction ? { direction: dir(e.direction) } : {}),
        ...(e.center ? { center: pt(e.center) } : {}),
        ...(e.axis ? { axis: dir(e.axis) } : {}),
        faces: e.faces.map((x) => x + faceBase),
        body: k.id,
      });
      edgeOwner.push({ component: k.id, local: e.index });
    }
    bodies.push({ name: k.id, faces: [faceBase, faces.length], edges: [edgeBase, edgeInfos.length] });
  }
  const mesh: MeshData | null = positions.length
    ? { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices), faceRanges, edges: new Float32Array(edges), edgeRanges, ...(anyUvs ? { uvs: new Float32Array(uvs) } : {}) }
    : null;
  return {
    view: { ok: true, name, errors: [], features: [], sketches: [], measurements: null, mesh, faces, edges: edgeInfos, bodies, datums: {}, ...(Object.keys(textures).length ? { textures } : {}) },
    faceOwner,
    edgeOwner,
  };
}
