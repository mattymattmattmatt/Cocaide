// Higher-level helpers that shorten common jobs. Each turns a short request
// into ordinary commands (the same ones a person's edits make), so what they
// write is plain, editable, parametric document JSON:
//
// - fullyDefine: the sketcher's Fully Define (src/geom/fullyDefine.ts) as one
//   command: the relations and dimensions a sketch is missing, measured from
//   its geometry as it is, so nothing moves.
// - holes: a Hole Wizard hole on a face, laid out on a bolt circle, a grid,
//   the face's corners or a list of points: the hole plus a circular or
//   linear pattern of it (or one hole with several centres).

import { nextId, type Command, type RawDocument } from "../../doc/commands";
import { documentParameters, resolveExpressions } from "../../doc/parameters";
import type { Constraint, SketchEntity, Vec2 } from "../../doc/types";
import { isObject } from "../../doc/validate";
import { fullyDefine } from "../../geom/fullyDefine";
import { to3D } from "../../geom/frame";
import { sketchStatus } from "../../geom/solver";
import type { KernelPort } from "../kernel";
import { isVec2, r3v, r6 } from "./common";
import { faceBox, faceFrame } from "./inspect";

export interface HelperMade {
  commands: Command[];
  /** What to tell the model about what it made. */
  info: Record<string, unknown>;
}

/** Fully Define Sketch as one edit: the missing relations and dimensions, measured as the sketch is. */
export function fullyDefineCommand(doc: RawDocument, input: unknown): HelperMade | string {
  const a = isObject(input) ? input : {};
  const id = typeof a.sketch === "string" ? a.sketch : "";
  const f = doc.features.find((x) => x.id === id);
  if (!f) return `fullyDefine: no feature "${id}"`;
  if (f.op !== "sketch") return `fullyDefine: "${id}" is a ${String(f.op)}, not a sketch`;
  const resolved = resolveExpressions(f, documentParameters(doc), []) as { entities?: SketchEntity[]; constraints?: Constraint[] };
  const entities = resolved.entities ?? [];
  const constraints = resolved.constraints ?? [];
  if (!entities.length) return `fullyDefine: ${id} is empty`;
  const datum = typeof a.datum === "string" ? a.datum : undefined;
  let r: ReturnType<typeof fullyDefine>;
  try {
    r = fullyDefine(entities, constraints, { datum, relations: a.relations !== false, dimensions: a.dimensions !== false });
  } catch (e) {
    return `fullyDefine: ${id}: ${(e as Error).message}`;
  }
  const raw = Array.isArray(f.constraints) ? f.constraints : [];
  const info = {
    sketch: id,
    added: r.add.map((constraint, j) => ({ index: raw.length + j, constraint })),
    dof: r.dof,
    ...(r.add.length === 0 ? { note: sketchStatus(entities, constraints).dof === 0 ? "already fully defined" : "nothing could be added" } : {}),
  };
  return { commands: r.add.length ? [{ type: "updateFeature", id, patch: { constraints: [...raw, ...r.add] } }] : [], info };
}

const HOLE_KEYS = ["size", "kind", "fit", "diameter", "depth", "counterbore", "countersink", "thread", "bodies"];

/** A hole (or several) on a face, laid out for you; see the module comment. */
export async function holesCommands(doc: RawDocument, kernel: KernelPort, input: unknown): Promise<HelperMade | string> {
  const a = isObject(input) ? input : {};
  if (!isObject(a.face)) return 'holes: "face" must be a flat face selector (take one from listFaces)';
  const extra = Object.keys(a).filter((k) => !["face", "at", "pattern", "id", ...HOLE_KEYS].includes(k));
  if (extra.length) return `holes: unknown field${extra.length > 1 ? "s" : ""} ${extra.join(", ")} (a hole takes ${HOLE_KEYS.join(", ")}; the layout goes in "at")`;
  const sel = await kernel.select(doc, a.face);
  if (!sel.ok) return `holes: face: ${sel.error}`;
  if (sel.kind !== "faces" || sel.indices.length !== 1) return `holes: face: the selector picks ${sel.indices.length} ${sel.kind}; it must pick exactly one flat face`;
  const frame = faceFrame(sel.faces[0]);
  if (!frame) return "holes: face: that face is not flat";
  const at = isObject(a.at) ? a.at : null;
  if (!at) return 'holes: "at" must be one of { "circle": { "center"?, "diameter", "count", "startAngle"? } }, { "grid": { "corner" | "center", "columns", "rows", "pitchX", "pitchY" } }, { "corners": { "inset" } }, { "points": [[x, y], ...] }, { "center": [x, y] }';
  const hole: Record<string, unknown> = { id: typeof a.id === "string" ? a.id : nextId(doc, "hole"), op: "hole", face: a.face };
  for (const k of HOLE_KEYS) if (a[k] !== undefined) hole[k] = a[k];
  if (hole.depth === undefined) hole.depth = "through";
  const pattern = a.pattern !== false;
  const num = (v: unknown, what: string): number => {
    const r = resolveExpressions(v, documentParameters(doc), []);
    if (typeof r !== "number" || !Number.isFinite(r)) throw new Error(`holes: ${what} must be a number (got ${JSON.stringify(v)})`);
    return r;
  };
  try {
    if (isVec2(at.center) && Object.keys(at).length === 1) {
      hole.center = at.center;
      return { commands: [{ type: "addFeature", feature: hole }], info: { hole: hole.id, count: 1 } };
    }
    if (Array.isArray(at.points)) {
      if (!at.points.length || !at.points.every(isVec2)) return "holes: at.points must be [[x, y], ...] in the face's frame";
      hole.centers = at.points;
      return { commands: [{ type: "addFeature", feature: hole }], info: { hole: hole.id, count: at.points.length } };
    }
    if (isObject(at.corners)) {
      const inset = num(at.corners.inset, "at.corners.inset");
      const topo = await kernel.topology(doc);
      const box = topo ? faceBox(topo, sel.indices[0], frame) : null;
      if (!box) return "holes: could not find the face's outline";
      const [[x0, y0], [x1, y1]] = box;
      if (2 * inset >= x1 - x0 || 2 * inset >= y1 - y0) return `holes: an inset of ${inset} leaves no room on a face ${r6(x1 - x0)} × ${r6(y1 - y0)}`;
      hole.centers = [
        [x0 + inset, y0 + inset],
        [x1 - inset, y0 + inset],
        [x1 - inset, y1 - inset],
        [x0 + inset, y1 - inset],
      ].map((p) => r3v(p));
      return { commands: [{ type: "addFeature", feature: hole }], info: { hole: hole.id, count: 4, centers: hole.centers, faceBox: box.map(r3v) } };
    }
    if (isObject(at.circle)) {
      const c = at.circle;
      const centre: Vec2 = isVec2(c.center) ? c.center : [0, 0];
      const d = num(c.diameter, "at.circle.diameter");
      const count = num(c.count, "at.circle.count");
      if (!Number.isInteger(count) || count < 1) return "holes: at.circle.count must be a whole number, 1 or more";
      const start = ((c.startAngle === undefined ? 0 : num(c.startAngle, "at.circle.startAngle")) * Math.PI) / 180;
      const place = (k: number): Vec2 => {
        const t = start + (2 * Math.PI * k) / count;
        return r3v([centre[0] + (d / 2) * Math.cos(t), centre[1] + (d / 2) * Math.sin(t)]) as Vec2;
      };
      if (!pattern || count === 1) {
        hole.centers = Array.from({ length: count }, (_, k) => place(k));
        return { commands: [{ type: "addFeature", feature: hole }], info: { hole: hole.id, count, centers: hole.centers } };
      }
      hole.center = place(0);
      const pat = { id: nextId(doc, "circularPattern"), op: "circularPattern", feature: hole.id, axis: { origin: r3v(to3D(frame, centre)), direction: r3v(frame.z) }, count };
      return { commands: [{ type: "addFeature", feature: hole }, { type: "addFeature", feature: pat }], info: { hole: hole.id, pattern: pat.id, count } };
    }
    if (isObject(at.grid)) {
      const g = at.grid;
      const cols = num(g.columns, "at.grid.columns");
      const rows = num(g.rows, "at.grid.rows");
      const px = num(g.pitchX ?? 0, "at.grid.pitchX");
      const py = num(g.pitchY ?? 0, "at.grid.pitchY");
      if (![cols, rows].every((n) => Number.isInteger(n) && n >= 1)) return "holes: at.grid.columns and rows must be whole numbers, 1 or more";
      if ((cols > 1 && !(px > 0)) || (rows > 1 && !(py > 0))) return "holes: at.grid needs pitchX (between columns) and pitchY (between rows) over 0";
      const centre: Vec2 = isVec2(g.center) ? g.center : [0, 0];
      const first: Vec2 = isVec2(g.corner) ? g.corner : [centre[0] - ((cols - 1) * px) / 2, centre[1] - ((rows - 1) * py) / 2];
      if (!pattern) {
        const centers: Vec2[] = [];
        for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) centers.push(r3v([first[0] + i * px, first[1] + j * py]) as Vec2);
        hole.centers = centers;
        return { commands: [{ type: "addFeature", feature: hole }], info: { hole: hole.id, count: centers.length } };
      }
      hole.center = r3v(first);
      if (cols * rows === 1) return { commands: [{ type: "addFeature", feature: hole }], info: { hole: hole.id, count: 1 } };
      const pat: Record<string, unknown> = { id: nextId(doc, "linearPattern"), op: "linearPattern", feature: hole.id };
      if (cols > 1) Object.assign(pat, { direction: r3v(frame.x), spacing: px, count: cols });
      if (rows > 1) Object.assign(pat, cols > 1 ? { direction2: r3v(frame.y), spacing2: py, count2: rows } : { direction: r3v(frame.y), spacing: py, count: rows });
      return { commands: [{ type: "addFeature", feature: hole }, { type: "addFeature", feature: pat }], info: { hole: hole.id, pattern: pat.id, count: cols * rows } };
    }
  } catch (e) {
    return (e as Error).message;
  }
  return 'holes: "at" must hold one of circle, grid, corners, points, center';
}
