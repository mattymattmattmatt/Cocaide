// A mate's references found on its components' parts: a face selector run
// on the part's faces (a flat face: its plane; a round face: its axis), an
// edge selector on its edges (straight: its line; round: its axis), a
// default plane or axis by name. In the part's own frame. Pure.

import type { MateRef } from "../doc/types";
import { describeWanted, selectEdges, selectFaces } from "../kernel/selectors";
import type { EdgeInfo, FaceInfo } from "../kernel/topology";
import type { MateGeom } from "./solve";

export interface PartTopology {
  faces: FaceInfo[];
  edges: EdgeInfo[];
  /** The part's drilled holes, when it was built here (a STEP part has none): a tapped one's drill and thread. */
  holes?: { diameter: number; thread?: { major: number; designation: string } }[];
}

const DATUMS: Record<string, MateGeom> = {
  Top: { kind: "plane", p: [0, 0, 0], n: [0, 0, 1] },
  Front: { kind: "plane", p: [0, 0, 0], n: [0, -1, 0] },
  Right: { kind: "plane", p: [0, 0, 0], n: [1, 0, 0] },
  X: { kind: "axis", p: [0, 0, 0], d: [1, 0, 0] },
  Y: { kind: "axis", p: [0, 0, 0], d: [0, 1, 0] },
  Z: { kind: "axis", p: [0, 0, 0], d: [0, 0, 1] },
  Origin: { kind: "point", p: [0, 0, 0] },
};

/** The geometry a mate holds, in its part's frame; or why it can't be found. */
export function mateGeometry(ref: MateRef, part: PartTopology | undefined): MateGeom | string {
  if (ref.datum) return DATUMS[ref.datum] ?? `no default plane or axis "${ref.datum}"`;
  if (!part) return `${ref.component}'s part has not been built`;
  if (ref.face) {
    const r = selectFaces(part.faces, ref.face);
    if (r.matches.length !== 1) return `${ref.component}: the face selector matched ${r.matches.length} faces (wanted ${describeWanted(ref.face, 1)}): pick the face again`;
    const f = r.matches[0];
    if (f.type === "plane" && f.normal) return { kind: "plane", p: f.point ?? f.centroid, n: f.normal };
    if (f.cylinder) return { kind: "axis", p: f.cylinder.origin, d: f.cylinder.axis };
    return `${ref.component}: that face is neither flat nor round, so it has no plane or axis to mate`;
  }
  if (ref.edge) {
    const r = selectEdges(part.edges, part.faces, ref.edge);
    if (r.error) return `${ref.component}: ${r.error}`;
    if (r.matches.length !== 1) return `${ref.component}: the edge selector matched ${r.matches.length} edges: pick the edge again`;
    const e = r.matches[0];
    if (e.kind === "line" && e.direction) return { kind: "axis", p: e.start, d: e.direction };
    if (e.kind === "circle" && e.center && e.axis) return { kind: "axis", p: e.center, d: e.axis };
    return `${ref.component}: that edge is neither straight nor round, so it has no axis to mate`;
  }
  return `the mate names nothing of ${ref.component}`;
}
