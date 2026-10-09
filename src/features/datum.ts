// Reference geometry (DatumRef) helpers that need no kernel: the default
// planes, axes and origin; what kind of thing a reference is when that is
// known without the model; finding the references inside a feature; and the
// plane frame of a resolved plane, which the sketcher shares with the rebuild.
//
// Pure, and imported by the document layer: it must not import values from
// src/doc, src/kernel or src/ui (see tests/registry.test.ts).

import type { DatumPlane, DatumRef, EdgeSelector, FaceSelector, RefPlane, Vec3 } from "../doc/types";
import type { Checker } from "../doc/validate";
import { planeFrame, type Frame } from "../geom/frame";
import { add3, cross3, dot3, normalize3, scale3, sub3 } from "../geom/vec";
import type { AskKernel, ValidateKit } from "./defs";

export type { DatumRef, RefPlane };

/** What a reference resolves to. */
export type DatumKind = "plane" | "axis" | "point";

/** A resolved plane: unit normal, a point on it, and its unit x axis (in the plane). */
export interface PlaneDatum {
  kind: "plane";
  origin: Vec3;
  normal: Vec3;
  xDir: Vec3;
}
/** A resolved axis: a point on it and its unit direction. */
export interface AxisDatum {
  kind: "axis";
  origin: Vec3;
  direction: Vec3;
}
export interface PointDatum {
  kind: "point";
  at: Vec3;
}
/** Reference geometry resolved at rebuild time into plain frames. */
export type Datum = PlaneDatum | AxisDatum | PointDatum;
export type DatumOf<K extends DatumKind> = Extract<Datum, { kind: K }>;

/** The default reference geometry, by name. Feature ids may not use these names. */
export const DEFAULT_DATUMS: Readonly<Record<string, Datum>> = {
  Top: { kind: "plane", origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
  Front: { kind: "plane", origin: [0, 0, 0], normal: [0, -1, 0], xDir: [1, 0, 0] },
  Right: { kind: "plane", origin: [0, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] },
  Origin: { kind: "point", at: [0, 0, 0] },
  X: { kind: "axis", origin: [0, 0, 0], direction: [1, 0, 0] },
  Y: { kind: "axis", origin: [0, 0, 0], direction: [0, 1, 0] },
  Z: { kind: "axis", origin: [0, 0, 0], direction: [0, 0, 1] },
};
export const RESERVED_DATUMS: readonly string[] = Object.keys(DEFAULT_DATUMS);

/** The default plane, axis or origin of this name, if it is one. */
export function defaultDatum(name: string): Datum | undefined {
  return Object.hasOwn(DEFAULT_DATUMS, name) ? DEFAULT_DATUMS[name] : undefined;
}

/** The ops that make reference geometry, and what each makes. Their results go in the rebuild's `datums`. */
export const DATUM_OPS: Readonly<Record<string, DatumKind>> = { plane: "plane", axis: "axis", point: "point" };

/** "a plane", "an axis", "a point". */
export function aKind(kind: DatumKind): string {
  return kind === "axis" ? "an axis" : `a ${kind}`;
}

/** "a plane or an axis". */
export function aKinds(kinds: readonly DatumKind[]): string {
  return kinds.map(aKind).join(" or ");
}

/**
 * What a reference can be, as far as the document alone says: a default or a
 * reference feature is one kind; a face is a plane or an axis (planar or
 * round); an edge is an axis, or a point (a circle's centre, or with `at`).
 * `earlier` maps earlier feature ids to their ops. Empty when the reference
 * cannot be any kind (an unknown or non-reference feature).
 */
export function possibleKinds(ref: DatumRef, earlier?: ReadonlyMap<string, string>): DatumKind[] {
  if ("datum" in ref) {
    const d = defaultDatum(ref.datum);
    if (d) return [d.kind];
    const op = earlier?.get(ref.datum);
    const kind = op !== undefined && Object.hasOwn(DATUM_OPS, op) ? DATUM_OPS[op] : undefined;
    return kind ? [kind] : [];
  }
  if ("face" in ref) return ["plane", "axis"];
  if ("edge" in ref) return ref.at ? ["point"] : ["axis", "point"];
  return ["point"];
}

/** Looks like a DatumRef: an object with one of datum, face, edge or point. */
export function isDatumRef(v: unknown): v is DatumRef {
  return typeof v === "object" && v !== null && !Array.isArray(v) && ["datum", "face", "edge", "point"].some((k) => k in v);
}

/** Looks like a plane given by reference: { "type": "ref", "ref": ... }. */
export function isRefPlane(v: unknown): v is RefPlane {
  return typeof v === "object" && v !== null && (v as { type?: unknown }).type === "ref";
}

/** A DatumRef inside a feature, by identity, with its field path ("axis", "refs[1]", "plane.ref"). */
export interface DatumRefAt {
  path: string;
  ref: DatumRef;
}

/**
 * The DatumRefs in these fields of a raw feature, by identity (so a caller
 * may rewrite them in place on its own copy): a field may hold one reference,
 * a list of them, or a plane given by reference ({ "type": "ref", "ref" }).
 * What a registry op's `datumRefs` usually returns: datumRefsAt(raw, "axis").
 */
export function datumRefsAt(raw: Record<string, unknown>, ...keys: string[]): DatumRefAt[] {
  const out: DatumRefAt[] = [];
  const take = (v: unknown, path: string) => {
    if (isRefPlane(v)) take(v.ref, `${path}.ref`);
    else if (isDatumRef(v)) out.push({ path, ref: v });
  };
  for (const k of keys) {
    const v = raw[k];
    if (Array.isArray(v)) v.forEach((x, i) => take(x, `${k}[${i}]`));
    else take(v, k);
  }
  return out;
}

/** The feature ids these references name ({ datum: id }, not the defaults). */
export function datumFeatureIds(refs: readonly DatumRefAt[]): string[] {
  return refs.flatMap(({ ref }) => (isDatumRef(ref) && "datum" in ref && typeof ref.datum === "string" && !defaultDatum(ref.datum) ? [ref.datum] : []));
}

/** The face and edge selectors inside these references, with their field paths. */
export function datumSelectors(refs: readonly DatumRefAt[]): { path: string; face?: FaceSelector; edge?: EdgeSelector }[] {
  return refs.flatMap(({ path, ref }): { path: string; face?: FaceSelector; edge?: EdgeSelector }[] => {
    if (!isDatumRef(ref)) return [];
    if ("face" in ref && typeof ref.face === "object" && ref.face !== null) return [{ path: `${path}.face`, face: ref.face }];
    if ("edge" in ref && typeof ref.edge === "object" && ref.edge !== null) return [{ path: `${path}.edge`, edge: ref.edge }];
    return [];
  });
}

/** The face or edge selector of a reference passed through `f` (a body rename), in place. */
export function mapDatumSelector(ref: DatumRef, f: (selector: unknown) => unknown): void {
  if ("face" in ref) ref.face = f(ref.face) as FaceSelector;
  else if ("edge" in ref) ref.edge = f(ref.edge) as EdgeSelector;
}

/**
 * The DatumRefs of a raw feature, wherever the built-in ops hold them (a
 * sketch's, a mirror's or a split's plane by reference; and the fields
 * DESIGN §2.4 and §2.6 give them: a sketch entity's "ref", an extrude's
 * "upTo" and "direction2.upTo", a linear pattern's "along", a circular
 * pattern's "axis.ref"), else a registry op's datumRefs (its def's hook).
 * Their { datum } ids are references; their selectors follow body renames.
 */
export function featureDatumRefs(raw: Record<string, unknown>, registry?: (raw: Record<string, unknown>) => DatumRefAt[]): DatumRefAt[] {
  const inside = (key: string, inner: string) => {
    const v = raw[key];
    return typeof v === "object" && v !== null && !Array.isArray(v) ? datumRefsAt(v as Record<string, unknown>, inner).map((r) => ({ ...r, path: `${key}.${r.path}` })) : [];
  };
  switch (raw.op) {
    case "sketch": {
      const entities = Array.isArray(raw.entities) ? raw.entities : [];
      const refs = entities.flatMap((e, i) => (typeof e === "object" && e !== null && isDatumRef((e as { ref?: unknown }).ref) ? [{ path: `entities[${i}].ref`, ref: (e as { ref: DatumRef }).ref }] : []));
      return [...datumRefsAt(raw, "plane"), ...refs];
    }
    case "mirror":
    case "split":
      return datumRefsAt(raw, "plane");
    case "extrude":
    case "cut":
      return [...datumRefsAt(raw, "upTo"), ...inside("direction2", "upTo")];
    case "linearPattern":
      return datumRefsAt(raw, "along");
    case "circularPattern":
      return inside("axis", "ref");
    default:
      return registry ? registry(raw) : [];
  }
}

// ---------------------------------------------------------------- frames

/** Why `xDir` cannot be a plane's x axis ("must not be parallel to the plane normal"), or null when it can. */
export function xDirProblem(normal: Vec3, xDir: Vec3): string | null {
  const l = Math.hypot(...xDir);
  if (l < 1e-12) return "must not be the zero vector";
  return Math.abs(dot3(normalize3(normal), scale3(xDir, 1 / l))) > 1 - 1e-9 ? "must not be parallel to the plane normal" : null;
}

/**
 * The frame of a resolved plane as a sketch (or a mirror, split) uses it:
 * moved `offset` along the plane's normal, turned over by `flip` (normal
 * reversed, x kept, so y reverses too), x along `xDir` when given (projected
 * onto the plane), else the plane's own x.
 */
export function refPlaneFrame(plane: PlaneDatum, opts: { offset?: number; flip?: boolean; xDir?: Vec3 } = {}): Frame {
  const n = normalize3(plane.normal);
  const origin = add3(plane.origin, scale3(n, opts.offset ?? 0));
  return planeFrame(opts.flip ? scale3(n, -1) : n, origin, opts.xDir ?? plane.xDir);
}

/** The plane of a planar face: its outward normal, the global origin projected onto it, x by the datum-plane rule. */
export function facePlane(normal: Vec3, pointOnPlane: Vec3): PlaneDatum {
  const n = normalize3(normal);
  const frame = planeFrame(n, scale3(n, dot3(pointOnPlane, n)));
  return { kind: "plane", origin: frame.origin, normal: n, xDir: frame.x };
}

/** A written-out plane as a resolved one (its x by the datum-plane rule when it has none). */
export function datumPlaneDatum(p: DatumPlane): PlaneDatum {
  const frame = planeFrame(p.normal, p.origin, p.xDir);
  return { kind: "plane", origin: frame.origin, normal: frame.z, xDir: frame.x };
}

/** A frame written out as a datum plane, e.g. for the sketcher to draw on a sketch placed by reference. */
export function frameAsDatumPlane(frame: Frame): DatumPlane {
  return { type: "datum", normal: [...frame.z], origin: [...frame.origin], xDir: [...frame.x] };
}

// ---------------------------------------------------------------- constructions
//
// The geometry of the plane, axis and point features, on resolved frames: pure,
// so each rule is tested with numbers worked out by hand. A construction that
// has no answer (parallel planes have no line in common) returns null; the
// kernel says what to pick instead, naming the references.

/** Directions closer than this (as 1 - |cos|) are parallel; lengths under LENGTH_EPS mm are zero. */
const ANGLE_EPS = 1e-9;
const LENGTH_EPS = 1e-6;

/** Tiny rounding noise (6e-17) as 0, and -0 as 0, so frames read as they were worked out. */
function clean(v: Vec3): Vec3 {
  return v.map((x) => (Math.abs(x) < 1e-12 ? 0 : x) + 0) as Vec3;
}

/** A plane through `origin` with this normal; its x axis is `xHint` laid into the plane, or the datum-plane rule when the hint is along the normal. */
export function planeDatum(origin: Vec3, normal: Vec3, xHint?: Vec3): PlaneDatum {
  const n = normalize3(normal);
  let x: Vec3 | null = null;
  if (xHint) {
    const laid = sub3(xHint, scale3(n, dot3(xHint, n)));
    if (Math.hypot(...laid) > 1e-6) x = normalize3(laid);
  }
  return { kind: "plane", origin: clean(origin), normal: clean(n), xDir: clean(x ?? planeFrame(n, origin).x) };
}

/** `v` turned `deg` degrees about the unit direction `d`, right-handed (thumb along d, fingers the way it turns). */
export function rotateAbout(v: Vec3, d: Vec3, deg: number): Vec3 {
  const k = normalize3(d);
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // Rodrigues: v cos + (k x v) sin + k (k.v)(1 - cos).
  return clean(add3(add3(scale3(v, c), scale3(cross3(k, v), s)), scale3(k, dot3(k, v) * (1 - c))));
}

/** The plane moved `distance` mm along its normal (back, when negative); its x kept. */
export function offsetPlane(p: PlaneDatum, distance: number): PlaneDatum {
  return planeDatum(add3(p.origin, scale3(normalize3(p.normal), distance)), p.normal, p.xDir);
}

/** The plane turned over: its normal reversed, its origin and x kept (so its y reverses too). */
export function flipPlane(p: PlaneDatum): PlaneDatum {
  return planeDatum(p.origin, scale3(p.normal, -1), p.xDir);
}

/** The plane parallel to `p` through `at`: `p` moved along its normal until it reaches the point. */
export function throughPointPlane(p: PlaneDatum, at: Vec3): PlaneDatum {
  return offsetPlane(p, dot3(sub3(at, p.origin), normalize3(p.normal)));
}

/** Does the axis lie in the plane or run parallel to it? */
export function axisAlongPlane(axis: AxisDatum, p: PlaneDatum): boolean {
  return Math.abs(dot3(normalize3(axis.direction), normalize3(p.normal))) < 1e-6;
}

/**
 * The plane through the axis at `deg` degrees to `p`: `p`, carried parallel
 * to itself onto the axis, then turned about the axis, right-handed (a positive
 * angle turns the normal the way the fingers of a right hand curl with the
 * thumb along the axis: 30° about X from Top gives the normal [0, -sin 30°,
 * cos 30°]). Its origin is the axis point nearest p's origin; its x is p's x
 * turned the same way. Null when the axis is neither in the plane nor parallel to it.
 */
export function anglePlane(p: PlaneDatum, axis: AxisDatum, deg: number): PlaneDatum | null {
  if (!axisAlongPlane(axis, p)) return null;
  const d = normalize3(axis.direction);
  const origin = add3(axis.origin, scale3(d, dot3(sub3(p.origin, axis.origin), d)));
  return planeDatum(origin, rotateAbout(normalize3(p.normal), d, deg), rotateAbout(p.xDir, d, deg));
}

/**
 * The plane through three points: origin the first, normal (b - a) x (c - a)
 * (so the points run counter-clockwise seen from the normal's side), x from
 * the first point toward the second. Null when they lie on one line.
 */
export function threePointPlane(a: Vec3, b: Vec3, c: Vec3): PlaneDatum | null {
  const ab = sub3(b, a);
  const ac = sub3(c, a);
  const n = cross3(ab, ac);
  // Collinear (or two points the same): the cross product is tiny next to the sides it is made from.
  if (Math.hypot(...n) <= LENGTH_EPS * Math.max(1, Math.hypot(...ab) * Math.hypot(...ac))) return null;
  return planeDatum(a, n, ab);
}

/**
 * The plane half way between two planes. Parallel ones (the two faces of a
 * plate, facing either way): the plane between them, with the first one's
 * normal and x. Ones that meet: the plane through their line that halves the
 * angle between them, the one of the two such planes nearer to parallel with
 * both (for two faces at a box edge, the one that halves the material's
 * corner); its normal leans the first plane's way, its x is the first one's
 * laid into it, and its origin is the point of the line nearest the first
 * plane's origin.
 */
export function midPlane(a: PlaneDatum, b: PlaneDatum): PlaneDatum {
  const n1 = normalize3(a.normal);
  const n2 = normalize3(b.normal);
  const cos = dot3(n1, n2);
  if (1 - Math.abs(cos) < ANGLE_EPS) return offsetPlane(a, dot3(sub3(b.origin, a.origin), n1) / 2);
  const line = planesLine(a, b, a.origin)!;
  // Normals within 90°: the bisector of n1 and n2; else (and at 90°, a box edge) the plane of equal signed distance.
  const n = cos > 1e-12 ? add3(n1, n2) : sub3(n1, n2);
  return planeDatum(line.origin, n, a.xDir);
}

/** The line two planes meet in: its origin the point of it nearest `near`, its direction n1 x n2. Null for parallel planes. */
export function planesLine(a: PlaneDatum, b: PlaneDatum, near: Vec3 = [0, 0, 0]): AxisDatum | null {
  const n1 = normalize3(a.normal);
  const n2 = normalize3(b.normal);
  const d = cross3(n1, n2);
  const dd = dot3(d, d);
  if (dd < 1e-12) return null;
  const h1 = dot3(n1, a.origin);
  const h2 = dot3(n2, b.origin);
  // A point on both planes: (h1 (n2 x d) + h2 (d x n1)) / |d|^2.
  const p = scale3(add3(scale3(cross3(n2, d), h1), scale3(cross3(d, n1), h2)), 1 / dd);
  const u = normalize3(d);
  return { kind: "axis", origin: clean(add3(p, scale3(u, dot3(sub3(near, p), u)))), direction: clean(u) };
}

/** Where an axis crosses a plane; null when it runs parallel to it. */
export function axisPlanePoint(axis: AxisDatum, p: PlaneDatum): Vec3 | null {
  const d = normalize3(axis.direction);
  const n = normalize3(p.normal);
  const along = dot3(d, n);
  if (Math.abs(along) < 1e-9) return null;
  return clean(add3(axis.origin, scale3(d, dot3(sub3(p.origin, axis.origin), n) / along)));
}

/** The axis through two points, from the first to the second; null when they are the same point. */
export function twoPointAxis(a: Vec3, b: Vec3): AxisDatum | null {
  const d = sub3(b, a);
  if (Math.hypot(...d) < LENGTH_EPS) return null;
  return { kind: "axis", origin: clean(a), direction: clean(normalize3(d)) };
}

/** The axis turned end for end. */
export function flipAxis(a: AxisDatum): AxisDatum {
  return { kind: "axis", origin: a.origin, direction: clean(scale3(a.direction, -1)) };
}

/** A resolved frame with its noise cleaned, as the rebuild keeps it. */
export function cleanDatum(d: Datum): Datum {
  if (d.kind === "plane") return { kind: "plane", origin: clean(d.origin), normal: clean(d.normal), xDir: clean(d.xDir) };
  if (d.kind === "axis") return { kind: "axis", origin: clean(d.origin), direction: clean(d.direction) };
  return { kind: "point", at: clean(d.at) };
}

// ---------------------------------------------------------------- modes
//
// The plane, axis and point features each take a mode and a list of
// references. A mode says how many references it takes, what each may be,
// and which fields it uses; checkModeRefs checks a feature against it, with
// messages that say what to pick.

/** How a reference may be written: { datum }, { face }, { edge } or { point }. */
export type RefForm = "datum" | "face" | "edge" | "point";

export interface RefSlot {
  /** What goes here, for messages: "a plane", "an axis in or parallel to the plane". */
  what: string;
  /** The kinds it may resolve to, as far as the document says; none: any reference of the allowed forms. */
  kinds?: DatumKind[];
  /** The forms allowed here (default any). */
  forms?: RefForm[];
  /** An edge here is the whole edge: no "at". */
  wholeEdge?: boolean;
}

export interface ModeSpec {
  /** Its references, in order. */
  refs: RefSlot[];
  /** How many of the last references may be left out. */
  optional?: number;
  /** The fields it uses beside refs ("distance", "angle", "t", "at"); another mode's are refused. */
  fields: string[];
  /** What it makes, in a line: for the agent's reference and the property editor. */
  about: string;
}

/** The form a reference is written in. */
export function refForm(ref: DatumRef): RefForm {
  return "datum" in ref ? "datum" : "face" in ref ? "face" : "edge" in ref ? "edge" : "point";
}

/** "2 references (a plane, then an axis in or parallel to it)". */
export function modeTakes(spec: ModeSpec): string {
  const n = spec.refs.length;
  if (n === 0) return "no references";
  const min = n - (spec.optional ?? 0);
  const count = min === n ? `${n}` : `${min} or ${n}`;
  const list = spec.refs.map((r, i) => (i >= min ? `optionally ${r.what}` : r.what)).join(", then ");
  return `${count} reference${n === 1 ? "" : "s"} (${list})`;
}

/**
 * A plane, axis or point feature's `refs` checked against its mode: how many,
 * and each one's form and kind ("refs[1]: Top is a plane, but an axis is
 * needed here"). Fields only other modes use are refused ("distance: only
 * mode "offset" uses it"). Reports on `c`; returns the references, or null.
 */
export function checkModeRefs(raw: Record<string, unknown>, c: Checker, x: ValidateKit, op: string, mode: string, modes: Readonly<Record<string, ModeSpec>>): DatumRef[] | null {
  const spec = modes[mode];
  const before = c.errors.length;
  for (const field of new Set(Object.values(modes).flatMap((m) => m.fields))) {
    if (raw[field] === undefined || spec.fields.includes(field)) continue;
    const users = Object.entries(modes)
      .filter(([, m]) => m.fields.includes(field))
      .map(([k]) => `"${k}"`);
    c.fail(field, `only mode ${users.join(" or ")} uses it (this ${op} is mode "${mode}"); remove it`);
  }
  const n = spec.refs.length;
  const min = n - (spec.optional ?? 0);
  if (n === 0) {
    if (raw.refs !== undefined && !(Array.isArray(raw.refs) && raw.refs.length === 0)) c.fail("refs", `mode "${mode}" takes no references; remove them`);
    return c.errors.length > before ? null : [];
  }
  if (!Array.isArray(raw.refs)) {
    c.fail("refs", `must be a list: mode "${mode}" takes ${modeTakes(spec)} (got ${x.describe(raw.refs)})`);
    return null;
  }
  if (raw.refs.length < min || raw.refs.length > n) {
    c.fail("refs", `mode "${mode}" takes ${modeTakes(spec)}, got ${raw.refs.length}`);
    return null;
  }
  const refs: DatumRef[] = [];
  raw.refs.forEach((v, i) => {
    const slot = spec.refs[i];
    const path = `refs[${i}]`;
    const ref = x.datumRef(v, path, slot.kinds);
    if (!ref) return;
    if (slot.forms && !slot.forms.includes(refForm(ref))) {
      c.fail(path, `mode "${mode}" takes ${slot.what} here, written ${slot.forms.map(formExample).join(" or ")} (got ${refText(ref)})`);
      return;
    }
    if (slot.wholeEdge && "edge" in ref && ref.at !== undefined) {
      c.fail(`${path}.at`, `mode "${mode}" takes the whole edge here: leave "at" out`);
      return;
    }
    refs.push(ref);
  });
  return c.errors.length > before ? null : refs;
}

/**
 * A registry def's askFrom for the reference features: from a right-clicked
 * face or edge the ask may add one made from it (a plane offset from the
 * face), so one of its refs must pick that face or edge.
 */
export async function askFromRefs(f: Record<string, unknown>, target: { kind: "face" | "edge"; index: number }, k: AskKernel, op: string): Promise<string | null> {
  const refs = Array.isArray(f.refs) ? (f.refs as Record<string, unknown>[]) : [];
  for (const r of refs) {
    const sel = typeof r === "object" && r !== null ? (target.kind === "face" ? r.face : r.edge) : undefined;
    if (sel === undefined) continue;
    const got = await k.select(sel);
    if (got.ok && got.kind === (target.kind === "face" ? "faces" : "edges") && got.indices.length === 1 && got.indices[0] === target.index) return null;
  }
  return `a ${op} from here must be made from the ${target.kind} you right-clicked: put the packet's selection in its refs ({ "${target.kind}": <selector> })`;
}

function formExample(f: RefForm): string {
  return f === "datum" ? '{ "datum": <id> }' : f === "face" ? '{ "face": <face selector> }' : f === "edge" ? '{ "edge": <edge selector> }' : '{ "point": [x, y, z] }';
}

/** A reference as validation messages name it: "Top", "a face", "the start of an edge", "the point [1, 2, 3]". */
export function refText(ref: DatumRef): string {
  if ("datum" in ref) return ref.datum;
  if ("face" in ref) return "a face";
  if ("edge" in ref) return ref.at ? `the ${ref.at === "mid" ? "middle" : ref.at} of an edge` : "an edge";
  return `the point [${ref.point.join(", ")}]`;
}
