// What stays selected when a rebuild replaces the solid. Face, edge and vertex
// indices belong to the solid they were picked on, so they are dropped; but a
// whole body picked in the Bodies panel is a body by name, and it stays picked
// as that body's faces in the new solid. Without this, a body clicked while a
// rebuild is still on its way (just after an edit) is forgotten when the
// rebuild lands, and the next tool silently works on another body.
//
// Planes, axes and points are ids: they stay picked while they exist.
// Pure, so Vitest covers it in node.

import type { BodyRange } from "../../kernel/bodies";
import { EMPTY_SELECTION, type Selection } from "./selection";

/** The body whose faces are exactly the selected faces (all of them, nothing else), in these bodies. */
export function wholeBodySelected(sel: Selection, bodies: readonly BodyRange[]): string | null {
  if (sel.faces.length === 0 || sel.edges.length > 0 || (sel.vertices ?? []).length > 0) return null;
  const faces = new Set(sel.faces);
  const body = bodies.find((b) => b.faces[1] - b.faces[0] === faces.size && sel.faces.every((i) => i >= b.faces[0] && i < b.faces[1]));
  return body ? body.name : null;
}

/** The faces of a body, by its range. */
export function bodyFaces(b: BodyRange): number[] {
  return Array.from({ length: b.faces[1] - b.faces[0] }, (_, i) => b.faces[0] + i);
}

/**
 * The selection after a rebuild: a whole body picked on the old solid becomes
 * the same body's faces on the new one (when it still exists); the planes,
 * axes and points that still exist stay; everything else is dropped.
 */
export function carrySelection(
  sel: Selection,
  before: { bodies: readonly BodyRange[] } | null,
  after: { bodies: readonly BodyRange[] },
  datumExists: (id: string) => boolean,
): Selection {
  const datums = (sel.datums ?? []).filter(datumExists);
  const name = before ? wholeBodySelected(sel, before.bodies) : null;
  const body = name === null ? undefined : after.bodies.find((b) => b.name === name);
  if (body) return { faces: bodyFaces(body), edges: [], ...(datums.length ? { datums } : {}) };
  return datums.length ? { faces: [], edges: [], datums } : EMPTY_SELECTION;
}

type Vec3 = readonly [number, number, number] | readonly number[];
interface SolidShape {
  faces: readonly { type: string; area: number; centroid: Vec3 }[];
  edges: readonly { length: number; mid: Vec3 }[];
}

/**
 * Is the new solid the old one again (a rebuild of the same part: an OK that
 * changed nothing, a session closed)? Every face and edge where it was, in
 * the same order: the selection's indices still mean what they did, so it
 * stays as it is.
 */
export function sameSolid(before: SolidShape | null, after: SolidShape): boolean {
  if (!before || before.faces.length !== after.faces.length || before.edges.length !== after.edges.length) return false;
  const near = (a: Vec3, b: Vec3) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 1e-9;
  return (
    before.faces.every((f, i) => f.type === after.faces[i].type && Math.abs(f.area - after.faces[i].area) < 1e-9 && near(f.centroid, after.faces[i].centroid)) &&
    before.edges.every((e, i) => Math.abs(e.length - after.edges[i].length) < 1e-9 && near(e.mid, after.edges[i].mid))
  );
}
