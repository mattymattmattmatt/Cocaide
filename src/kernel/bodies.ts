// A part's bodies: named solids, in the order they were first made (Phase H).
// Whatever looks at the whole part (selectors, the mesh, measurements,
// export) sees one shape: the body itself when there is one, else a compound
// of them. Faces and edges come out body by body, so each body's are a
// contiguous index range and every face or edge knows its body.

import type { TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from "replicad-opencascadejs";
import { type OC, type Scope } from "./oc";
import { countSubShapes, describeEdges, describeFaces, listEdges, type EdgeInfo, type FaceInfo } from "./topology";

export type Bodies = Map<string, TopoDS_Shape>;

export interface BodyRange {
  name: string;
  /** Face indices [start, end) of this body in the part's face order. */
  faces: [number, number];
  /** Edge indices [start, end) in the part's unique-edge order. */
  edges: [number, number];
}

/** The whole part as one shape, or null with no bodies. A compound is tracked in `s`. */
export function partShape(oc: OC, s: Scope, bodies: Bodies | TopoDS_Shape[]): TopoDS_Shape | null {
  const shapes = Array.isArray(bodies) ? bodies : [...bodies.values()];
  if (shapes.length === 0) return null;
  if (shapes.length === 1) return shapes[0];
  return compound(oc, s, shapes);
}

export function compound(oc: OC, s: Scope, shapes: TopoDS_Shape[]): TopoDS_Shape {
  const builder = s.track(new oc.TopoDS_Builder());
  const c = s.track(new oc.TopoDS_Compound());
  builder.MakeCompound(c);
  for (const sh of shapes) builder.Add(c, sh);
  return c;
}

/** Each body's face and edge index ranges in the part's order. */
export function bodyRanges(oc: OC, s: Scope, bodies: Bodies): BodyRange[] {
  const out: BodyRange[] = [];
  let f = 0;
  let e = 0;
  for (const [name, shape] of bodies) {
    const nf = countSubShapes(oc, s, shape, "face");
    const ne = listEdges(oc, s, shape).edges.length;
    out.push({ name, faces: [f, f + nf], edges: [e, e + ne] });
    f += nf;
    e += ne;
  }
  return out;
}

export interface DescribedPart {
  shape: TopoDS_Shape;
  faces: TopoDS_Face[];
  faceInfos: FaceInfo[];
  edges: TopoDS_Edge[];
  edgeInfos: EdgeInfo[];
  ranges: BodyRange[];
}

/** Faces and edges of the whole part, each labelled with its body. Everything is tracked in `s`. */
export function describePart(oc: OC, s: Scope, bodies: Bodies, withEdges = true): DescribedPart {
  const shape = partShape(oc, s, bodies)!;
  const { faces, infos: faceInfos } = describeFaces(oc, s, shape);
  const { edges, infos: edgeInfos } = withEdges ? describeEdges(oc, s, shape, faces) : { edges: [], infos: [] };
  const ranges = bodyRanges(oc, s, bodies);
  labelBodies({ faces: faceInfos, edges: edgeInfos }, ranges);
  return { shape, faces, faceInfos, edges, edgeInfos, ranges };
}

/** Marks each face and edge with the body it belongs to. */
export function labelBodies(topo: { faces: FaceInfo[]; edges: EdgeInfo[] }, ranges: BodyRange[]): void {
  for (const r of ranges) {
    for (let i = r.faces[0]; i < r.faces[1]; i++) if (topo.faces[i]) topo.faces[i].body = r.name;
    for (let i = r.edges[0]; i < r.edges[1]; i++) if (topo.edges[i]) topo.edges[i].body = r.name;
  }
}
