// Where a sketch's plane is, in the UI: a written-out plane is itself; a
// plane by reference (a default plane, a plane feature, a face) is worked out
// from the last rebuild, with the same rules as the kernel (refPlaneFrame,
// facePlane), so the sketcher draws where the rebuild will put the sketch.
// An existing sketch's frame is the one the rebuild placed it on, when it
// built; a new one (not rebuilt yet) is worked out here.
//
// Pure: Vitest covers it in node.

import type { DatumRef, PlaneSpec, Vec3 } from "../../doc/types";
import { DEFAULT_DATUMS, facePlane, isRefPlane, refPlaneFrame, xDirProblem, type Datum, type PlaneDatum } from "../../features/datum";
import { planeFrame, type Frame } from "../../geom/frame";
import { formatDirection } from "../../geom/vec";
import { describeWanted, selectFaces, selectionError } from "../../kernel/selectors";
import type { RebuildView } from "../../worker/protocol";

type Raw = Record<string, unknown>;

/** The plane a reference stands for in the last rebuild, or why there is none. */
export function planeOfRef(ref: DatumRef, view: Pick<RebuildView, "faces" | "datums"> | null): PlaneDatum | string {
  if ("datum" in ref) {
    const d: Datum | undefined = Object.hasOwn(DEFAULT_DATUMS, ref.datum) ? DEFAULT_DATUMS[ref.datum] : view && Object.hasOwn(view.datums ?? {}, ref.datum) ? view.datums[ref.datum] : undefined;
    if (!d) return `${ref.datum} has not built: fix it (or wait for the rebuild), then sketch on it`;
    return d.kind === "plane" ? d : `${ref.datum} is ${d.kind === "axis" ? "an axis" : "a point"}, not a plane: pick a plane or a flat face`;
  }
  if ("face" in ref) {
    if (!view) return "the part has not rebuilt yet: wait for it";
    const found = selectFaces(view.faces, ref.face);
    const problem = selectionError(ref.face, found, 1);
    if (problem) return `the face is not there: ${problem}`;
    const f = found.matches[0];
    if (f.type !== "plane" || !f.normal || !f.point) return `${describeWanted(ref.face, 1).replace(/^1 /, "the ")} is curved: a sketch needs a flat face`;
    return facePlane(f.normal, f.point);
  }
  return "an edge or a point is not a plane: pick a plane or a flat face";
}

/** The frame a plane spec stands for in the last rebuild (with its offset, flip and xDir), or why there is none. */
export function planeSpecFrameIn(spec: PlaneSpec, view: Pick<RebuildView, "faces" | "datums"> | null): Frame | string {
  if (!isRefPlane(spec)) return planeFrame(spec.normal, spec.origin, spec.xDir);
  const plane = planeOfRef(spec.ref, view);
  if (typeof plane === "string") return plane;
  if (spec.xDir) {
    const problem = xDirProblem(plane.normal, spec.xDir);
    if (problem) return `xDir ${problem} (the plane's normal is ${formatDirection(plane.normal)})`;
  }
  return refPlaneFrame(plane, spec);
}

/**
 * The frame a sketch in the document sits on: where the last rebuild put it
 * (a sketch on a face is where that face was at the sketch's place in the
 * history), else worked out from its plane on the last rebuild.
 */
export function sketchFrameIn(sketch: Raw | undefined, view: Pick<RebuildView, "faces" | "datums" | "sketches"> | null): Frame | string {
  if (!sketch || sketch.op !== "sketch") return "no such sketch";
  const built = view?.sketches.find((s) => s.id === sketch.id);
  if (built) return built.frame;
  const spec = sketch.plane as PlaneSpec | undefined;
  if (!spec || typeof spec !== "object") return `${String(sketch.id)} has no plane`;
  return planeSpecFrameIn(spec, view);
}

/** A sketch's normal as the last rebuild has it (a written-out plane's own), or null. */
export function sketchNormal(sketch: Raw | undefined, view: Pick<RebuildView, "faces" | "datums" | "sketches"> | null): Vec3 | null {
  const f = sketchFrameIn(sketch, view);
  return typeof f === "string" ? null : f.z;
}

/** The planes a sketch may be placed on by reference: the default ones, then each plane feature before it. */
export function planeChoices(before: Raw[]): { id: string; label: string }[] {
  return [
    { id: "Top", label: "Top plane (XY)" },
    { id: "Front", label: "Front plane (XZ)" },
    { id: "Right", label: "Right plane (YZ)" },
    ...before.filter((g) => g.op === "plane").map((g) => ({ id: String(g.id), label: String(g.id) })),
  ];
}
