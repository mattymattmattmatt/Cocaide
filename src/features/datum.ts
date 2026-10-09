// Reference geometry (DatumRef) helpers that need no kernel: the default
// planes, axes and origin; what kind of thing a reference is when that is
// known without the model; finding the references inside a feature; and the
// plane frame of a resolved plane, which the sketcher shares with the rebuild.
//
// Pure, and imported by the document layer: it must not import values from
// src/doc, src/kernel or src/ui (see tests/registry.test.ts).

import type { DatumPlane, DatumRef, EdgeSelector, FaceSelector, RefPlane, Vec3 } from "../doc/types";
import { planeFrame, type Frame } from "../geom/frame";
import { add3, dot3, normalize3, scale3 } from "../geom/vec";

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
