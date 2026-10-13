// The AI's inspection tools, written once over (document, KernelPort) and
// served by both hosts: the right-click agent (src/ask/agent.ts, kernel in
// the worker) and the MCP session (src/agent/session.ts, kernel in Node).
// Read-only: none of these changes the document.
//
// Every face and edge they list comes with a ready-to-use selector that picks
// it alone, so the model never writes a selector by hand or guesses an index.

import type { RawDocument } from "../../doc/commands";
import { dependants, references } from "../../doc/commands";
import { dimensionNames } from "../../doc/dimensions";
import { documentParameters, resolveExpressions } from "../../doc/parameters";
import type { Constraint, SketchEntity, Vec2, Vec3 } from "../../doc/types";
import { isObject } from "../../doc/validate";
import { DEFAULT_DATUMS, type Datum } from "../../features/datum";
import { measureConstraint } from "../../geom/constraints";
import { entityPoint, pointNames } from "../../geom/curves";
import { facePlaneFrame, to2D, to3D, type Frame } from "../../geom/frame";
import { buildProfile } from "../../geom/profile";
import { add3, cross3, dot3, len3, normalize3, scale3, sub3 } from "../../geom/vec";
import type { MeasureRef } from "../../kernel/evaluate";
import { edgeSummary, faceSummary, measurementSummary } from "../../kernel/inspect";
import { edgeSelectorFor, edgesSelectorFor, faceSelectorFor } from "../../kernel/synthesize";
import type { EdgeInfo, FaceInfo } from "../../kernel/topology";
import { VIEWS, type Camera } from "../../render/raster";
import { describeConstraint } from "../../ui/sketcher/draft";
import { sketchHealth } from "../../ui/sketcher/status";
import type { CheckResult, KernelPort, PartTopology } from "../kernel";
import { bodyFeatures, partOutline, referenceGeometry } from "../packet";
import { argsOf, fail, isVec2, isVec3, limitOf, r3v, r6, str, type Outcome } from "./common";

const FACE_TYPES = ["plane", "cylinder", "cone", "other"] as const;
const EDGE_KINDS = ["line", "circle", "other"] as const;
/** Two directions closer than this (cosine) count as the same. */
const PARALLEL = 1 - 1e-6;

async function noSolid(doc: RawDocument, kernel: KernelPort, tool: string): Promise<Outcome> {
  const check = await kernel.check(doc);
  return fail(`${tool}: there is no solid yet${check.errors.length ? ` (${check.errors.join("; ")})` : ""}`);
}

function knownFeature(doc: RawDocument, id: string, tool: string, what: string): string | null {
  return doc.features.some((f) => f.id === id) ? null : `${tool}: ${what}: no feature "${id}" (features: ${doc.features.map((f) => String(f.id)).join(", ") || "none"})`;
}

// ------------------------------------------------------------------ faces

/** A planar face's sketch frame (the one a sketch on it and a hole's center use): origin = the global origin projected onto it. */
export function faceFrame(f: FaceInfo): Frame | null {
  return f.type === "plane" && f.normal ? facePlaneFrame(f.normal, f.point ?? f.centroid) : null;
}

const frameOut = (fr: Frame) => ({ origin: r3v(fr.origin), x: r3v(fr.x), y: r3v(fr.y), normal: r3v(fr.z) });

/** The box around a planar face in its own frame, from its edges (ends, middles, round edges' extremes). */
export function faceBox(topo: PartTopology, index: number, fr: Frame): [Vec2, Vec2] | null {
  const pts: Vec2[] = [];
  for (const e of topo.edges) {
    if (!e.faces.includes(index)) continue;
    for (const p of [e.start, e.end, e.mid]) pts.push(to2D(fr, p));
    if (e.kind === "circle" && e.center && e.radius !== undefined) {
      const c = to2D(fr, e.center);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) pts.push([c[0] + dx * e.radius, c[1] + dy * e.radius]);
    }
  }
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [
    [Math.min(...xs), Math.min(...ys)],
    [Math.max(...xs), Math.max(...ys)],
  ];
}

function faceRow(topo: PartTopology, i: number): Record<string, unknown> {
  const f = topo.faces[i];
  const sel = faceSelectorFor(topo.faces, i);
  const row: Record<string, unknown> = { ...(sel.ok ? { selector: sel.selector } : { selectorProblem: sel.error }), ...faceSummary(f) };
  if (f.cylinder) {
    row.axisPoint = r3v(f.cylinder.origin);
    if (f.cylinder.span < 2 * Math.PI - 1e-6) row.spanDegrees = r6((f.cylinder.span * 180) / Math.PI);
  }
  if (f.body) row.body = f.body;
  const by = topo.faceOrigins[i];
  if (by) row.madeBy = by;
  const fr = faceFrame(f);
  if (fr) {
    // Where a sketch on it, or a hole's center, puts its 2D coordinates.
    const box = faceBox(topo, i, fr);
    row.frame = { ...frameOut(fr), centroid2D: r3v(to2D(fr, f.centroid)), ...(box ? { box2D: box.map(r3v) } : {}) };
  }
  return row;
}

export async function listFaces(doc: RawDocument, kernel: KernelPort, input: unknown): Promise<Outcome> {
  const a = argsOf(input);
  if (a.type !== undefined && !FACE_TYPES.includes(a.type as never)) return fail(`listFaces: type must be one of ${FACE_TYPES.join(", ")}`);
  if (a.normal !== undefined && !isVec3(a.normal)) return fail("listFaces: normal must be [x, y, z]");
  if (a.near !== undefined && !isVec3(a.near)) return fail("listFaces: near must be [x, y, z]");
  if (typeof a.madeBy === "string") {
    const bad = knownFeature(doc, a.madeBy, "listFaces", "madeBy");
    if (bad) return fail(bad);
  }
  const topo = await kernel.topology(doc);
  if (!topo) return noSolid(doc, kernel, "listFaces");
  const n = isVec3(a.normal) ? normalize3(a.normal) : null;
  let idx = topo.faces.map((_, i) => i);
  idx = idx.filter((i) => {
    const f = topo.faces[i];
    if (a.type && f.type !== a.type) return false;
    if (typeof a.body === "string" && f.body !== undefined && f.body !== a.body) return false;
    if (n && !(f.normal && dot3(f.normal, n) > PARALLEL)) return false;
    if (typeof a.madeBy === "string" && topo.faceOrigins[i] !== a.madeBy) return false;
    return true;
  });
  const near = isVec3(a.near) ? a.near : null;
  idx.sort((i, j) => (near ? len3(sub3(topo.faces[i].centroid, near)) - len3(sub3(topo.faces[j].centroid, near)) : topo.faces[j].area - topo.faces[i].area));
  const limit = limitOf(a.limit, 40);
  return {
    ok: true,
    matched: idx.length,
    ...(idx.length > limit ? { shown: limit, note: `the first ${limit} ${near ? "nearest" : "largest"}; narrow with type, normal, madeBy or near` } : {}),
    faces: idx.slice(0, limit).map((i) => faceRow(topo, i)),
  };
}

// ------------------------------------------------------------------ edges

/**
 * How the two faces meet along an edge, read from a flat face beside it:
 * convex (an outside corner: a fillet rounds it off), concave (an inside
 * corner: a fillet fills it), smooth (they run on tangent), or unknown.
 */
export function edgeShape(topo: PartTopology, e: EdgeInfo): "convex" | "concave" | "smooth" | undefined {
  if (e.faces.length !== 2) return undefined;
  const [fa, fb] = e.faces.map((i) => topo.faces[i]);
  const pair = fa.type === "plane" && fa.normal ? [fa, fb] : fb.type === "plane" && fb.normal ? [fb, fa] : null;
  if (!pair) return undefined;
  const [p, q] = pair;
  const n = p.normal!;
  if (q.type === "plane" && q.normal && dot3(q.normal, n) > PARALLEL) return "smooth";
  if (q.cylinder) {
    // The cylinder's outward normal where the edge is: along the plane's, the faces run on tangent.
    const rel = sub3(e.mid, q.cylinder.origin);
    const radial = sub3(rel, scale3(q.cylinder.axis, dot3(rel, q.cylinder.axis)));
    if (len3(radial) > 1e-9) {
      const out = scale3(normalize3(radial), q.cylinder.concave ? -1 : 1);
      if (dot3(out, n) > PARALLEL) return "smooth";
    }
  }
  const d = dot3(n, sub3(q.centroid, p.point ?? p.centroid));
  if (Math.abs(d) < 1e-9) return undefined;
  return d < 0 ? "convex" : "concave";
}

function edgeRow(topo: PartTopology, i: number): Record<string, unknown> {
  const e = topo.edges[i];
  const sel = edgeSelectorFor(topo.edges, topo.faces, i);
  const row: Record<string, unknown> = { ...(sel.ok ? { selector: sel.selector } : { selectorProblem: sel.error }), ...edgeSummary(e), mid: r3v(e.mid) };
  if (e.direction) row.direction = r3v(e.direction);
  if (e.axis) row.axis = r3v(e.axis);
  const shape = edgeShape(topo, e);
  if (shape) row.corner = shape;
  row.between = e.faces.map((fi) => {
    const f = topo.faces[fi];
    return { type: f.type, ...(f.normal ? { normal: r3v(f.normal) } : {}), ...(f.cylinder ? { radius: r6(f.cylinder.radius) } : {}), ...(topo.faceOrigins[fi] ? { madeBy: topo.faceOrigins[fi] } : {}) };
  });
  if (e.body) row.body = e.body;
  return row;
}

export async function listEdges(doc: RawDocument, kernel: KernelPort, input: unknown): Promise<Outcome> {
  const a = argsOf(input);
  if (a.kind !== undefined && !EDGE_KINDS.includes(a.kind as never)) return fail(`listEdges: kind must be one of ${EDGE_KINDS.join(", ")}`);
  if (a.direction !== undefined && !isVec3(a.direction)) return fail("listEdges: direction must be [x, y, z]");
  if (a.near !== undefined && !isVec3(a.near)) return fail("listEdges: near must be [x, y, z]");
  if (a.corner !== undefined && !["convex", "concave", "smooth"].includes(a.corner as string)) return fail('listEdges: corner must be "convex", "concave" or "smooth"');
  if (typeof a.madeBy === "string") {
    const bad = knownFeature(doc, a.madeBy, "listEdges", "madeBy");
    if (bad) return fail(bad);
  }
  const topo = await kernel.topology(doc);
  if (!topo) return noSolid(doc, kernel, "listEdges");
  let onFace: Set<number> | null = null;
  if (a.onFace !== undefined) {
    const r = await kernel.select(doc, a.onFace);
    if (!r.ok) return fail(`listEdges: onFace: ${r.error}`);
    if (r.kind !== "faces") return fail("listEdges: onFace must be a face selector");
    onFace = new Set(r.indices);
  }
  const d = isVec3(a.direction) ? normalize3(a.direction) : null;
  let idx = topo.edges.map((_, i) => i).filter((i) => !topo.edges[i].seam);
  idx = idx.filter((i) => {
    const e = topo.edges[i];
    if (a.kind && e.kind !== a.kind) return false;
    if (typeof a.body === "string" && e.body !== undefined && e.body !== a.body) return false;
    if (d && !(e.direction && Math.abs(dot3(e.direction, d)) > PARALLEL)) return false;
    if (typeof a.radius === "number" && !(e.radius !== undefined && Math.abs(e.radius - a.radius) <= 1e-6)) return false;
    if (onFace && !e.faces.some((f) => onFace!.has(f))) return false;
    if (typeof a.madeBy === "string" && !e.faces.some((f) => topo.faceOrigins[f] === a.madeBy)) return false;
    if (a.corner && edgeShape(topo, e) !== a.corner) return false;
    return true;
  });
  const near = isVec3(a.near) ? a.near : null;
  idx.sort((i, j) => (near ? len3(sub3(topo.edges[i].centroid, near)) - len3(sub3(topo.edges[j].centroid, near)) : topo.edges[j].length - topo.edges[i].length));
  const limit = limitOf(a.limit, 40);
  const out: Outcome = {
    ok: true,
    matched: idx.length,
    ...(idx.length > limit ? { shown: limit, note: `the first ${limit} ${near ? "nearest" : "longest"}; narrow with kind, direction, onFace, madeBy, corner or near` } : {}),
    edges: idx.slice(0, limit).map((i) => edgeRow(topo, i)),
  };
  // Every edge listed, as one selector where one query picks exactly them ("all the edges of that face"), else a list.
  if (idx.length > 1 && idx.length <= limit) {
    const all = edgesSelectorFor(topo.edges, topo.faces, idx);
    if (all.ok) out.allSelector = all.selector;
  }
  return out;
}

// ------------------------------------------------------------------ measuring between two things

interface Operand {
  ref: MeasureRef;
  /** What it is, for the answer. */
  what: string;
  /** A plane's normal, a line's or an axis's direction. */
  direction?: Vec3;
  kind: "plane" | "line" | "axis" | "point" | "surface" | "curve";
  /** An axis line it has (a cylinder's, a circle's, an axis datum's), for the distance between axes. */
  axis?: { origin: Vec3; direction: Vec3 };
}

async function operand(doc: RawDocument, kernel: KernelPort, v: unknown, name: string, check: () => Promise<CheckResult>): Promise<Operand | string> {
  if (isVec3(v)) return { ref: { kind: "point", at: v }, what: `the point [${v.join(", ")}]`, kind: "point" };
  if (!isObject(v)) return `${name} must be a face or edge selector, a point [x, y, z], { "datum": <name or id> } or { "sketch": <id>, "point": "l1.end" }`;
  if (typeof v.datum === "string") {
    const d: Datum | undefined = DEFAULT_DATUMS[v.datum] ?? (await check()).datums?.[v.datum];
    if (!d) return `${name}: no plane, axis or point "${v.datum}" (the defaults are Top, Front, Right, X, Y, Z, Origin; else a plane, axis or point feature that built)`;
    if (d.kind === "plane") return { ref: { kind: "plane", origin: d.origin, normal: d.normal }, what: `plane ${v.datum}`, direction: d.normal, kind: "plane" };
    if (d.kind === "axis") return { ref: { kind: "axis", origin: d.origin, direction: d.direction }, what: `axis ${v.datum}`, direction: d.direction, kind: "axis", axis: { origin: d.origin, direction: d.direction } };
    return { ref: { kind: "point", at: d.at }, what: `point ${v.datum}`, kind: "point" };
  }
  if (typeof v.sketch === "string") {
    const at = await sketchPoint(doc, kernel, v.sketch, str(v.point));
    if (typeof at === "string") return `${name}: ${at}`;
    return { ref: { kind: "point", at }, what: `${v.sketch} ${str(v.point)}`, kind: "point" };
  }
  const r = await kernel.select(doc, v);
  if (!r.ok) return `${name}: ${r.error}`;
  if (r.indices.length !== 1) return `${name}: the selector picks ${r.indices.length} ${r.kind}; it must pick exactly one (take one from listFaces or listEdges)`;
  if (r.kind === "faces") {
    const f = r.faces[0];
    if (f.type === "plane" && f.normal) return { ref: { kind: "face", index: r.indices[0] }, what: "a flat face", direction: f.normal, kind: "plane" };
    if (f.cylinder) return { ref: { kind: "face", index: r.indices[0] }, what: `a cylindrical face (radius ${r6(f.cylinder.radius)})`, kind: "surface", axis: { origin: f.cylinder.origin, direction: f.cylinder.axis }, direction: f.cylinder.axis };
    return { ref: { kind: "face", index: r.indices[0] }, what: `a ${f.type} face`, kind: "surface" };
  }
  const e = r.edges[0];
  if (e.kind === "line" && e.direction) return { ref: { kind: "edge", index: r.indices[0] }, what: `a straight edge (length ${r6(e.length)})`, direction: e.direction, kind: "line" };
  if (e.kind === "circle" && e.center && e.axis) return { ref: { kind: "edge", index: r.indices[0] }, what: `a round edge (radius ${r6(e.radius ?? 0)})`, kind: "curve", axis: { origin: e.center, direction: e.axis }, direction: e.axis };
  return { ref: { kind: "edge", index: r.indices[0] }, what: "an edge", kind: "curve" };
}

/** A sketch point ("l1.end", "c1.center", "p1.at", "origin") in world coordinates, as the sketch is now. */
async function sketchPoint(doc: RawDocument, kernel: KernelPort, sketch: string, ref: string): Promise<Vec3 | string> {
  const s = await sketchData(doc, kernel, sketch);
  if (typeof s === "string") return s;
  if (!s.frame) return `sketch "${sketch}" did not build, so its points are nowhere`;
  if (ref === "origin") return s.frame.origin;
  const [id, field] = ref.split(".");
  const e = (s.entities as SketchEntity[]).find((x) => x.id === id);
  if (!e) return `sketch "${sketch}" has no entity "${id}"`;
  // The shared resolver: an ellipse's minor end and arc ends and a spline's p0, p1, … are worked out, not stored.
  const p = field === undefined ? undefined : entityPoint(e, field);
  if (!isVec2(p)) return `"${ref}" is not a point of ${id} (a ${e.type}: ${pointNames(e).map((n) => `${id}.${n}`).join(", ")})`;
  return to3D(s.frame, p);
}

/** The angle between two lines' directions, 0..90 (directions either way round), in degrees. */
function lineAngle(a: Vec3, b: Vec3): number {
  const c = Math.min(1, Math.abs(dot3(normalize3(a), normalize3(b))));
  return (Math.acos(c) * 180) / Math.PI;
}

/** The shortest distance between two endless lines. */
function lineDistance(a: { origin: Vec3; direction: Vec3 }, b: { origin: Vec3; direction: Vec3 }): number {
  const u = normalize3(a.direction);
  const v = normalize3(b.direction);
  const w = sub3(b.origin, a.origin);
  const n = cross3(u, v);
  if (len3(n) < 1e-9) return len3(sub3(w, scale3(u, dot3(w, u))));
  return Math.abs(dot3(w, normalize3(n)));
}

export async function measureBetween(doc: RawDocument, kernel: KernelPort, input: unknown): Promise<Outcome> {
  const a = argsOf(input);
  let checked: CheckResult | null = null;
  const check = async () => (checked ??= await kernel.check(doc));
  const A = await operand(doc, kernel, a.a, "a", check);
  if (typeof A === "string") return fail(`measureBetween: ${A}`);
  const B = await operand(doc, kernel, a.b, "b", check);
  if (typeof B === "string") return fail(`measureBetween: ${B}`);
  let closest;
  try {
    const r = await kernel.inspect(doc, { kind: "distance", a: A.ref, b: B.ref });
    if (r.kind !== "distance") return fail("measureBetween: unexpected kernel reply");
    closest = r.closest;
  } catch (e) {
    return fail(`measureBetween: ${(e as Error).message}`);
  }
  const out: Outcome = {
    ok: true,
    a: A.what,
    b: B.what,
    distance: r6(closest.distance),
    pointA: r3v(closest.a),
    pointB: r3v(closest.b),
    delta: r3v(sub3(closest.b, closest.a)),
  };
  if (A.direction && B.direction) {
    const angle = r6(lineAngle(A.direction, B.direction));
    out.angle = angle;
    out.parallel = angle < 1e-4;
    out.perpendicular = Math.abs(angle - 90) < 1e-4;
    if (A.kind === "plane" && B.kind === "plane") {
      // Two flat faces or planes: the angle between their normals too (180 for faces that face each other).
      out.normalsAngle = r6((Math.acos(Math.max(-1, Math.min(1, dot3(normalize3(A.direction), normalize3(B.direction))))) * 180) / Math.PI);
      if (out.parallel) out.note = "parallel planes: distance is the gap between them";
    }
  }
  if (A.axis && B.axis) out.axisDistance = r6(lineDistance(A.axis, B.axis));
  else if (A.axis && B.kind === "point") out.axisDistance = r6(lineDistance(A.axis, { origin: (B.ref as { at: Vec3 }).at, direction: A.axis.direction }));
  else if (B.axis && A.kind === "point") out.axisDistance = r6(lineDistance(B.axis, { origin: (A.ref as { at: Vec3 }).at, direction: B.axis.direction }));
  return out;
}

// ------------------------------------------------------------------ sketches

interface SketchData {
  feature: Record<string, unknown>;
  entities: SketchEntity[];
  constraints: Constraint[];
  frame: Frame | null;
  ok: boolean;
  open?: string;
  solved: boolean;
}

async function sketchData(doc: RawDocument, kernel: KernelPort, id: string): Promise<SketchData | string> {
  const f = doc.features.find((x) => x.id === id);
  if (!f) return `no feature "${id}"`;
  if (f.op !== "sketch") return `"${id}" is a ${String(f.op)}, not a sketch`;
  const resolved = resolveExpressions(f, documentParameters(doc), []) as { entities?: SketchEntity[]; constraints?: Constraint[] };
  const check = await kernel.check(doc);
  const solved = check.solvedSketches?.[id];
  const written = resolved.entities ?? [];
  const entities = solved && solved.length === written.length ? solved : written;
  let frame: Frame | null = null;
  let ok = false;
  let open: string | undefined;
  try {
    const r = await kernel.inspect(doc, { kind: "sketchFrames" });
    const k = r.kind === "sketchFrames" ? r.sketches.find((x) => x.id === id) : undefined;
    if (k) {
      frame = k.frame;
      ok = k.ok;
      open = k.open;
    }
  } catch {
    // the sketch did not build: no frame
  }
  return { feature: f, entities, constraints: resolved.constraints ?? [], frame, ok, open, solved: entities !== written };
}

export async function getSketch(doc: RawDocument, kernel: KernelPort, input: unknown): Promise<Outcome> {
  const id = str(argsOf(input).id) || str(argsOf(input).sketch);
  const s = await sketchData(doc, kernel, id);
  if (typeof s === "string") return fail(`getSketch: ${s}`);
  const raw = (Array.isArray(s.feature.constraints) ? s.feature.constraints : []) as Record<string, unknown>[];
  const names = dimensionNames(raw);
  const constraints = s.constraints.map((k, index) => {
    const row: Record<string, unknown> = { index, ...raw[index] };
    if (names[index]) row.name = names[index];
    try {
      row.label = describeConstraint(k);
    } catch {
      // a malformed constraint: the sketch's error says why
    }
    try {
      const m = measureConstraint(s.entities, k);
      if ("value" in k) row.measured = r6(m.actual);
      if (!(k as { driven?: boolean }).driven && Math.abs(m.actual - m.expected) > 1e-6) row.holds = false;
    } catch {
      row.holds = false;
    }
    return row;
  });
  const health = sketchHealth(s.entities, s.constraints);
  const profile = buildProfile(s.entities);
  const status: Record<string, unknown> = { state: health.state, text: health.text, dof: health.dof, fullyDefined: health.state === "full" };
  if (health.freePoints.size) status.freePoints = [...health.freePoints].slice(0, 30);
  if (health.conflicting.length) status.conflicting = health.conflicting;
  return {
    ok: true,
    id,
    plane: s.feature.plane,
    ...(s.frame ? { frame: frameOut(s.frame) } : {}),
    built: s.ok,
    status,
    profile: profile.ok
      ? { closed: true, regions: profile.regions.length, area: r6(profile.area), loops: profile.regions.map((g) => ({ area: r6(g.outer.area - g.holes.reduce((t, h) => t + Math.abs(h.area), 0)), holes: g.holes.length })) }
      : { closed: false, problem: s.open ?? profile.error },
    entities: s.entities.map(rounded),
    ...(s.solved ? { note: "it references the model: these are the entities as the rebuild solved them, where the model is now" } : {}),
    constraints,
    axes: 'relations and dimensions may name the sketch axes "X" and "Y" as lines, and "origin" as a point',
  };
}

function rounded(e: SketchEntity): Record<string, unknown> {
  const r = (v: unknown): unknown => (typeof v === "number" ? r6(v) : Array.isArray(v) ? v.map(r) : v);
  return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, k === "ref" ? v : r(v)]));
}

// ------------------------------------------------------------------ planes, datums

export async function facePlane(doc: RawDocument, kernel: KernelPort, input: unknown): Promise<Outcome> {
  const a = argsOf(input);
  if (!isObject(a.face)) return fail("facePlane: face must be a face selector (take one from listFaces)");
  const r = await kernel.select(doc, a.face);
  if (!r.ok) return fail(`facePlane: ${r.error}`);
  if (r.kind !== "faces" || r.indices.length !== 1) return fail(`facePlane: the selector picks ${r.indices.length} ${r.kind}; it must pick exactly one flat face`);
  const f = r.faces[0];
  const fr0 = faceFrame(f);
  if (!fr0) return fail(`facePlane: that is a ${f.type} face; a sketch or a hole needs a flat one`);
  const offset = typeof a.offset === "number" ? a.offset : 0;
  const fr: Frame = { ...fr0, origin: add3(fr0.origin, scale3(fr0.z, offset)) };
  const out: Outcome = {
    ok: true,
    plane: { type: "ref", ref: { face: a.face }, ...(offset ? { offset } : {}) },
    frame: frameOut(fr),
    datum: { type: "datum", normal: r3v(fr.z), origin: r3v(fr.origin), xDir: r3v(fr.x) },
    centroid2D: r3v(to2D(fr, f.centroid)),
    note: 'Sketch on it with "plane": the plane above (it follows the face). A hole on it takes "face": the selector, and its "center" is in this frame (offset 0).',
  };
  const topo = await kernel.topology(doc);
  if (topo) {
    const box = faceBox(topo, r.indices[0], fr);
    if (box) out.box2D = box.map(r3v);
  }
  if (Array.isArray(a.points)) {
    const bad = a.points.find((p) => !isVec3(p));
    if (bad !== undefined) return fail("facePlane: points must be [[x, y, z], ...]");
    out.points2D = (a.points as Vec3[]).map((p) => r3v(to2D(fr, p)));
  }
  return out;
}

export async function listDatums(doc: RawDocument, kernel: KernelPort): Promise<Outcome> {
  const check = await kernel.check(doc);
  const out = (d: Datum) =>
    d.kind === "plane" ? { kind: "plane", origin: r3v(d.origin), normal: r3v(d.normal), xDir: r3v(d.xDir) } : d.kind === "axis" ? { kind: "axis", origin: r3v(d.origin), direction: r3v(d.direction) } : { kind: "point", at: r3v(d.at) };
  return {
    ok: true,
    defaults: Object.fromEntries(Object.entries(DEFAULT_DATUMS).map(([k, d]) => [k, out(d)])),
    features: (referenceGeometry(doc, check).features as unknown[]) ?? [],
    use: '{ "datum": "<name or id>" } wherever a plane, axis or point is wanted; a sketch on one: "plane": { "type": "ref", "ref": { "datum": "Top" } }',
  };
}

// ------------------------------------------------------------------ features, the part

/** One feature: its JSON, rebuild status, values with expressions worked out, what it uses and what uses it. */
export function featureInfo(doc: RawDocument, check: CheckResult, id: string): Outcome {
  const f = doc.features.find((x) => x.id === id);
  if (!f) return fail(`getFeature: no feature "${id}" (features: ${doc.features.map((x) => String(x.id)).join(", ")})`);
  const s = check.features.find((x) => x.id === id);
  const out: Outcome = { ok: true, feature: f, status: s ? { ok: s.ok, ...(s.error ? { error: s.error } : {}), ...(s.suppressed ? { suppressed: true } : {}) } : null };
  const resolved = resolveExpressions(f, documentParameters(doc), []);
  if (JSON.stringify(resolved) !== JSON.stringify(f)) out.resolved = resolved;
  const uses = references(f);
  if (uses.length) out.uses = uses;
  const usedBy = dependants(doc.features, id);
  if (usedBy.length) out.usedBy = usedBy;
  const d = check.datums?.[id];
  if (d) out.now = d;
  return out;
}

export async function partSummary(doc: RawDocument, kernel: KernelPort): Promise<Outcome> {
  const check = await kernel.check(doc);
  const out: Outcome = { ok: true, ...partOutline(doc, check) };
  const m = check.measurements;
  if (!m) {
    out.solid = false;
    if (check.errors.length) out.errors = check.errors;
    return out;
  }
  const summary = measurementSummary(m);
  let centres = new Map<string, Vec3>();
  try {
    const r = await kernel.inspect(doc, { kind: "mass" });
    if (r.kind === "mass") centres = new Map(r.mass.bodies.map((b) => [b.name, b.centre]));
  } catch {
    // mass properties are a nicety here
  }
  out.measurements = { volume: summary.volume, surfaceArea: summary.surfaceArea, boundingBox: summary.boundingBox, mass: summary.mass, holeCount: summary.holeCount, holeDiameters: summary.holeDiameters, solids: summary.solids, faces: summary.faces };
  out.bodies = m.bodies.map((b) => ({
    name: b.name,
    volume: r6(b.volume),
    ...(b.boundingBox ? { min: r3v(b.boundingBox.min), max: r3v(b.boundingBox.max), size: r3v(b.boundingBox.size) } : {}),
    ...(centres.get(b.name) ? { centreOfMass: r3v(centres.get(b.name)!) } : {}),
    holeCount: b.holeCount,
    madeBy: bodyFeatures(doc, b.name),
  }));
  if (m.interference.length) out.interference = m.interference;
  if (check.errors.length) out.errors = check.errors;
  return out;
}

// ------------------------------------------------------------------ pictures

export interface ShotRequest {
  camera: Camera;
  view: string;
  width: number;
  height: number;
  highlightFaces?: number[];
  highlightEdges?: number[];
  hiddenEdges: boolean;
  frame: boolean;
}

/** Reads screenshot arguments: a named view or a direction, an optional highlight selector. */
export async function shotRequest(doc: RawDocument, kernel: KernelPort, input: unknown, cameras: Record<string, Camera> = VIEWS): Promise<ShotRequest | string> {
  const a = argsOf(input);
  let camera: Camera;
  let view: string;
  if (Array.isArray(a.direction)) {
    if (!isVec3(a.direction) || a.direction.every((x) => x === 0)) return "screenshot: direction must be a non-zero [x, y, z]";
    camera = { direction: a.direction, up: isVec3(a.up) ? a.up : undefined };
    view = `direction [${a.direction.join(", ")}]`;
  } else {
    view = typeof a.view === "string" ? a.view : "iso";
    if (!(view in cameras)) return `screenshot: unknown view "${view}" (views: ${Object.keys(cameras).join(", ")}; or pass direction)`;
    camera = cameras[view];
  }
  const size = (v: unknown, d: number) => (typeof v === "number" && v >= 64 ? Math.min(1200, Math.round(v)) : d);
  const req: ShotRequest = { camera, view, width: size(a.width, 640), height: size(a.height, 480), hiddenEdges: a.hiddenEdges === true, frame: false };
  if (a.highlight !== undefined) {
    const r = await kernel.select(doc, a.highlight);
    if (!r.ok) return `screenshot: highlight: ${r.error}`;
    if (r.kind === "faces") req.highlightFaces = r.indices;
    else req.highlightEdges = r.indices;
    req.frame = a.zoom === true;
  }
  return req;
}
