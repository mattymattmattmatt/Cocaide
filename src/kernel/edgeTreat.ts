// Fillet and chamfer: which edges (selectors, every edge of some faces, every
// edge of the faces a feature made), with which size (a fillet's sets of radii,
// a radius that varies along each edge; a chamfer of equal distances, two
// distances or a distance and an angle), body by body. When OCCT refuses, each
// edge is tried alone to say which one fails and why ("edge 3 (straight, +Z,
// length 6, at [..]): radius 4 is too large for the 3 mm face beside it").

import type { TopoDS_Face, TopoDS_Shape } from "replicad-opencascadejs";
import type { ChamferFeature, EdgeChoice, FilletFeature, Vec3 } from "../doc/types";
import { cross3, dist3, dot3, formatDirection, len3, normalize3, roundTo, scale3, sub3 } from "../geom/vec";
import type { DescribedPart } from "./bodies";
import { isValidShape, volumeOf } from "./measure";
import type { OC, Scope } from "./oc";
import { OpError, VOLUME_EPS } from "./ops";
import { describeWanted, edgeSelectionError, selectEdges, selectFaces } from "./selectors";
import { faceSignature, type EdgeInfo, type FaceInfo } from "./topology";

/** One edge to treat and how. */
export interface Treatment {
  /** Index in the described part. */
  edge: number;
  /** Fillet: radius (and radius2 at its end); chamfer: distance (and distance2, or angle in degrees). */
  size: number;
  size2?: number;
  angle?: number;
  /** Where it came from, for messages ("sets[1]"; "" for the feature's own). */
  set: string;
}

/**
 * The edges a choice (the feature's own, or one of a fillet's sets) picks,
 * by index: its selectors' matches, every edge of its faces, every edge of
 * the faces its features made (`made(id)`: the face signatures that feature
 * made, or an OpError when it failed).
 */
export function chosenEdges(part: DescribedPart, ch: EdgeChoice, path: string, made: (id: string, path: string) => ReadonlySet<string>): number[] {
  const at = (k: string) => (path ? `${path}.${k}` : k);
  const chosen = new Set<number>();
  const selectors = ch.edges === undefined ? [] : Array.isArray(ch.edges) ? ch.edges : [ch.edges];
  selectors.forEach((sel, i) => {
    const where = Array.isArray(ch.edges) ? `${at("edges")}[${i}]` : at("edges");
    const result = selectEdges(part.edgeInfos, part.faceInfos, sel, where);
    const problem = edgeSelectionError(sel, result, where);
    if (problem) throw new OpError(problem);
    for (const e of result.matches) chosen.add(e.index);
  });
  const onFaces = (faces: Set<number>) => {
    for (const e of part.edgeInfos) if (!e.seam && e.faces.some((f) => faces.has(f))) chosen.add(e.index);
  };
  ch.faces?.forEach((sel, i) => {
    const where = `${at("faces")}[${i}]`;
    const found = selectFaces(part.faceInfos, sel);
    if (found.matches.length === 0) throw new OpError(`${where}: selector matched 0 faces (wanted ${describeWanted(sel, 1)} or more)`);
    if (found.tie) throw new OpError(`${where}: selector matched ${found.matches.length} faces tied for ${found.tie}${found.tie === "nearest" ? "" : " area"} (wanted ${describeWanted(sel, 1)})`);
    onFaces(new Set(found.matches.map((f) => f.index)));
  });
  ch.features?.forEach((id, i) => {
    const where = `${at("features")}[${i}]`;
    const sigs = made(id, where);
    const faces = new Set(part.faceInfos.filter((f) => sigs.has(faceSignature(f))).map((f) => f.index));
    if (faces.size === 0) throw new OpError(`${where}: none of the faces "${id}" made are left in the part (later features removed them)`);
    onFaces(faces);
  });
  return [...chosen];
}

/** Every edge the feature treats, with its size; an edge in two sets is an error. */
export function treatments(f: FilletFeature | ChamferFeature, part: DescribedPart, made: (id: string, path: string) => ReadonlySet<string>): Treatment[] {
  const out: Treatment[] = [];
  const seen = new Map<number, string>();
  const take = (ch: EdgeChoice, path: string, t: Omit<Treatment, "edge" | "set">) => {
    for (const edge of chosenEdges(part, ch, path, made)) {
      if (seen.has(edge)) {
        if (seen.get(edge) === path) continue;
        const name = (p: string) => (p ? p : "the feature's own edges");
        throw new OpError(`${describeEdge(part.edgeInfos[edge])} is in ${name(seen.get(edge)!)} and in ${name(path)}: give each edge one radius`);
      }
      seen.set(edge, path);
      out.push({ edge, set: path, ...t });
    }
  };
  if (f.op === "chamfer") {
    take(f, "", { size: f.distance, ...(f.distance2 !== undefined ? { size2: f.distance2 } : {}), ...(f.angle !== undefined ? { angle: f.angle } : {}) });
  } else {
    if (f.radius !== undefined) take(f, "", { size: f.radius, ...(f.radius2 !== undefined ? { size2: f.radius2 } : {}) });
    f.sets?.forEach((set, i) => take(set, `sets[${i}]`, { size: set.radius, ...(set.radius2 !== undefined ? { size2: set.radius2 } : {}) }));
  }
  return out;
}

/** One body with its edges filleted or chamfered. `name` is set in a part of several bodies, for messages. In scope `s`. */
export function treatBody(oc: OC, s: Scope, f: FilletFeature | ChamferFeature, part: DescribedPart, body: TopoDS_Shape, list: Treatment[], name: string | null): TopoDS_Shape {
  const where = name ? ` of body "${name}"` : "";
  const result = tryTreat(oc, s, f, part, body, list);
  if (!result) throw new OpError(diagnose(oc, s, f, part, body, list, where));
  if (!isValidShape(oc, s, result)) throw new OpError(`the ${f.op} produced an invalid solid${where}: try a smaller ${sizeWord(f)}`);
  const before = volumeOf(oc, s, body);
  if (Math.abs(volumeOf(oc, s, result) - before) <= VOLUME_EPS * Math.max(1, before)) throw new OpError(`the ${f.op} changed nothing${where}`);
  return result;
}

/** The body with the treatments, or null when OCCT refuses them. */
function tryTreat(oc: OC, s: Scope, f: FilletFeature | ChamferFeature, part: DescribedPart, body: TopoDS_Shape, list: Treatment[]): TopoDS_Shape | null {
  try {
    if (f.op === "fillet") {
      const b = s.track(new oc.BRepFilletAPI_MakeFillet(body, oc.ChFi3d_FilletShape.ChFi3d_Rational));
      for (const t of list) {
        const e = part.edges[t.edge];
        if (t.size2 !== undefined && Math.abs(t.size2 - t.size) > 1e-12) b.Add(t.size, t.size2, e);
        else b.Add(t.size, e);
      }
      b.Build(s.track(new oc.Message_ProgressRange()));
      return b.IsDone() ? s.track(b.Shape()) : null;
    }
    const b = s.track(new oc.BRepFilletAPI_MakeChamfer(body));
    for (const t of list) {
      const e = part.edges[t.edge];
      if (t.size2 === undefined && t.angle === undefined) b.Add(t.size, e);
      else {
        const face = firstFace(part, t.edge, (f as ChamferFeature).flip === true);
        if (t.angle !== undefined) b.AddDA(t.size, (t.angle * Math.PI) / 180, e, face);
        else b.Add(t.size, t.size2!, e, face);
      }
    }
    b.Build(s.track(new oc.Message_ProgressRange()));
    return b.IsDone() ? s.track(b.Shape()) : null;
  } catch {
    // OCCT throws on some impossible sizes rather than reporting them: the same as a refusal.
    return null;
  }
}

/** Why the treatment failed: each edge that fails alone, named, with the faces beside it; or that they fail together. */
function diagnose(oc: OC, s: Scope, f: FilletFeature | ChamferFeature, part: DescribedPart, body: TopoDS_Shape, list: Treatment[], where: string): string {
  const failing = list.length === 1 ? list : list.slice(0, 60).filter((t) => tryTreat(oc, s, f, part, body, [t]) === null);
  if (failing.length === 0) {
    return `the ${f.op} fails where its ${list.length} edges${where} meet (each works alone): try a smaller ${sizeWord(f)}, or treat them in separate features`;
  }
  const lines = failing.map((t) => {
    const info = part.edgeInfos[t.edge];
    const k = list.indexOf(t) + 1;
    const size = `${sizeWord(f)} ${sizeText(f, t)}`;
    const widths = info.faces.map((fi) => faceWidth(part, fi, info)).filter((w): w is number => w !== null);
    const narrow = widths.length ? Math.min(...widths) : null;
    const biggest = Math.max(t.size, t.size2 ?? 0);
    const label = `edge ${k}${list.length > 1 ? ` of ${list.length}` : ""} (${edgeWords(info)})${where}`;
    if (narrow !== null && biggest >= narrow - 1e-9) return `${label}: ${size} is too large for the ${roundTo(narrow, 4)} mm face beside it`;
    const across = widths.length ? ` (the faces beside it are ${widths.map((w) => roundTo(w, 4)).join(" and ")} mm across)` : "";
    return `${label}: ${size} fails on it${across}; try a smaller ${sizeWord(f)}`;
  });
  return lines.join("\n");
}

function sizeWord(f: FilletFeature | ChamferFeature): string {
  return f.op === "fillet" ? "radius" : "distance";
}

function sizeText(f: FilletFeature | ChamferFeature, t: Treatment): string {
  if (f.op === "fillet") return t.size2 !== undefined ? `${roundTo(t.size, 6)} to ${roundTo(t.size2, 6)}` : `${roundTo(t.size, 6)}`;
  if (t.angle !== undefined) return `${roundTo(t.size, 6)} at ${roundTo(t.angle, 6)}°`;
  return t.size2 !== undefined ? `${roundTo(t.size, 6)} by ${roundTo(t.size2, 6)}` : `${roundTo(t.size, 6)}`;
}

/** "straight, +Z, length 6, at [0, 0, 3]", "round, radius 3, at [..]", "curved, length 9.4, at [..]". */
export function edgeWords(e: EdgeInfo): string {
  const at = `at [${e.mid.map((x) => roundTo(x, 4)).join(", ")}]`;
  if (e.kind === "line") return `straight, ${formatDirection(e.direction!)}, length ${roundTo(e.length, 4)}, ${at}`;
  if (e.kind === "circle") return `round, radius ${roundTo(e.radius!, 4)}, ${at}`;
  return `curved, length ${roundTo(e.length, 4)}, ${at}`;
}

/** "the edge (straight, +Z, ...)": an edge as messages name it. */
function describeEdge(e: EdgeInfo): string {
  return `the edge (${edgeWords(e)})`;
}

/**
 * How far a face reaches away from an edge of it: the greatest distance of
 * the face's corners and edge midpoints from the edge's line (or circle).
 * Null for an edge that is neither straight nor round.
 */
export function faceWidth(part: DescribedPart, face: number, edge: EdgeInfo): number | null {
  const pts = part.edgeInfos.filter((e) => e.faces.includes(face)).flatMap((e) => [e.start, e.end, e.mid]);
  if (edge.kind === "line") {
    const u = normalize3(sub3(edge.end, edge.start));
    return Math.max(0, ...pts.map((p) => len3(cross3(sub3(p, edge.start), u))));
  }
  if (edge.kind === "circle" && edge.center && edge.axis) {
    const ax = normalize3(edge.axis);
    return Math.max(
      0,
      ...pts.map((p) => {
        const rel = sub3(p, edge.center!);
        const h = dot3(rel, ax);
        const rho = len3(sub3(rel, scale3(ax, h)));
        return Math.hypot(rho - edge.radius!, h);
      }),
    );
  }
  return null;
}

/**
 * The face of an edge that takes a chamfer's first distance: the one facing
 * most up (+Z, then +Y, then +X, by its outward normal beside the edge);
 * `flip` takes the other.
 */
export function firstFace(part: DescribedPart, edge: number, flip: boolean): TopoDS_Face {
  const info = part.edgeInfos[edge];
  const faces = [...new Set(info.faces)];
  if (faces.length < 2) return part.faces[faces[0]];
  const ranked = faces
    .map((fi) => ({ fi, n: normalBeside(part.faceInfos[fi], info) }))
    .sort((a, b) => {
      for (const k of [2, 1, 0]) if (Math.abs(a.n[k] - b.n[k]) > 1e-6) return b.n[k] - a.n[k];
      return a.fi - b.fi;
    });
  return part.faces[ranked[flip ? 1 : 0].fi];
}

/** A face's outward normal near an edge of it (planes and cylinders exactly; other faces roughly, toward their middle). */
function normalBeside(face: FaceInfo, edge: EdgeInfo): Vec3 {
  if (face.type === "plane" && face.normal) return normalize3(face.normal);
  if (face.type === "cylinder" && face.cylinder) {
    const c = face.cylinder;
    const rel = sub3(edge.mid, c.origin);
    const radial = sub3(rel, scale3(c.axis, dot3(rel, c.axis)));
    const n = len3(radial) > 1e-12 ? normalize3(radial) : ([0, 0, 1] as Vec3);
    return c.concave ? scale3(n, -1) : n;
  }
  const toward = sub3(face.centroid, edge.mid);
  return dist3(face.centroid, edge.mid) > 1e-12 ? normalize3(toward) : [0, 0, 1];
}

/** The edges of each body a feature treats, as OCCT edges, by body name. */
export function byBody(part: DescribedPart, list: Treatment[]): { name: string; list: Treatment[] }[] {
  return part.ranges
    .map((r) => ({ name: r.name, list: list.filter((t) => t.edge >= r.edges[0] && t.edge < r.edges[1]) }))
    .filter((b) => b.list.length > 0);
}

