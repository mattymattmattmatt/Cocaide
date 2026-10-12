// sweep: a profile carried along a path (DESIGN §2.6). The profile is a
// sketch's closed profile, or just a circle of a diameter (a pipe, a wire, a
// spring: no profile sketch to draw), hollow when it has an inner diameter.
// The path is a chain of lines and arcs in another sketch, a chain of model
// edges, or an exact helix about an axis (a spring, a coil, a thread). The
// profile follows the path's turns (or keeps its orientation, "fixed"), and
// may twist along it. The operation fields make it a new body, add to one,
// cut (a swept cut: a groove, a thread) or intersect.
//
// The helix is part of the sweep, not a curve feature of its own: a sweep
// says everything about the spring in one feature, and the agent and the
// properties edit it in one place.

import type { DatumRef, EdgeSelector, FeatureBase } from "../../doc/types";
import type { FeatureDef, FeatureSelector } from "../defs";
import { isDatumRef } from "../datum";
import { OPERATION_KEYS, operationBodies, operationBodyFromId, operationOnlyBodies, validateOperation, type OperationFields } from "../operation";
import { endRadius, helixNumbers, MAX_TAPER, type HelixSpec } from "./helix";

export const ORIENTATIONS = ["follow", "fixed"] as const;
export type { HelixSpec };

/** What the profile follows. */
export type SweepPath = { sketch: string } | { edges: EdgeSelector[] } | { helix: HelixSpec };

export interface SweepFeature extends FeatureBase, OperationFields {
  op: "sweep";
  /** A sketch with a closed profile (one of profile and circle). */
  profile?: string;
  /** A circle of this diameter (mm), hollow inside `inner` (mm, a pipe's bore): a tube along the path. */
  circle?: { diameter: number; inner?: number };
  path: SweepPath;
  /** Degrees the profile turns about the path from start to end. */
  twist?: number;
  /** "follow" (default): the profile turns with the path; "fixed": it keeps its orientation (sliding, not turning). */
  orientation?: (typeof ORIENTATIONS)[number];
}

type Raw = Record<string, unknown>;

/** Which path the sweep follows. */
export function pathKind(path: unknown): "sketch" | "edges" | "helix" | null {
  if (typeof path !== "object" || path === null) return null;
  if ("helix" in path) return "helix";
  if ("edges" in path) return "edges";
  if ("sketch" in path) return "sketch";
  return null;
}

/** The face selectors in an edge selector, renamed by `f` (body names). */
function renameSelector(sel: unknown, rename: (name: unknown) => unknown): unknown {
  if (typeof sel !== "object" || sel === null || Array.isArray(sel)) return sel;
  const out: Raw = { ...(sel as Raw) };
  if (out.body !== undefined) out.body = rename(out.body);
  if (out.onFace !== undefined) out.onFace = renameSelector(out.onFace, rename);
  if (Array.isArray(out.between)) out.between = out.between.map((s) => renameSelector(s, rename));
  return out;
}

export const def: FeatureDef<SweepFeature> = {
  op: "sweep",
  validate(raw, c, x) {
    c.keys(raw, "", ["id", "op", "profile", "circle", "path", "twist", "orientation", ...OPERATION_KEYS]);
    let profile: string | undefined;
    let circle: SweepFeature["circle"];
    if (raw.profile !== undefined && raw.circle !== undefined) c.fail("", 'give "profile" (a sketch) or "circle" (a diameter), not both');
    else if (raw.profile === undefined && raw.circle === undefined) c.fail("", 'needs a profile: "profile": "<sketch id>" (a closed profile), or "circle": { "diameter": <mm> } for a round tube along the path');
    if (raw.profile !== undefined) profile = x.sketch(raw.profile, "profile");
    if (raw.circle !== undefined) {
      if (!x.isObject(raw.circle)) c.fail("circle", `must be { "diameter": <mm>, "inner": <mm> (optional, hollow) } (got ${x.describe(raw.circle)})`);
      else {
        c.keys(raw.circle, "circle", ["diameter", "inner"]);
        const diameter = c.num(raw.circle, "diameter", "circle", { positive: true });
        const inner = raw.circle.inner === undefined ? undefined : c.num(raw.circle, "inner", "circle", { positive: true });
        if (diameter !== undefined && inner !== undefined && inner >= diameter) c.fail("circle.inner", `the bore (${inner} mm) must be smaller than the diameter (${diameter} mm)`);
        if (diameter !== undefined) circle = { diameter, ...(inner !== undefined ? { inner } : {}) };
      }
    }
    const path = validatePath(raw, c, x, profile);
    let twist: number | undefined;
    if (raw.twist !== undefined) twist = c.num(raw, "twist", "", {});
    const orientation = raw.orientation === undefined ? undefined : x.oneOf(raw, "orientation", "", ORIENTATIONS);
    if (orientation === "fixed" && twist) c.fail("twist", 'a fixed profile keeps its orientation, so it cannot twist: use "orientation": "follow" (the default) to twist it');
    const operation = validateOperation(raw, c, x);
    if (c.errors.length || !path || !operation || (!profile && !circle)) return null;
    return {
      id: raw.id as string,
      op: "sweep",
      ...(profile ? { profile } : {}),
      ...(circle ? { circle } : {}),
      path,
      ...(twist ? { twist } : {}),
      ...(orientation ? { orientation } : {}),
      ...operation,
    };
  },
  references: (raw) => [
    ...(typeof raw.profile === "string" ? [raw.profile] : []),
    ...(pathKind(raw.path) === "sketch" && typeof (raw.path as Raw).sketch === "string" ? [(raw.path as Raw).sketch as string] : []),
  ],
  datumRefs: (raw) => {
    const helix = pathKind(raw.path) === "helix" ? ((raw.path as Raw).helix as Raw) : undefined;
    return helix && isDatumRef(helix.axis) ? [{ path: "path.helix.axis", ref: helix.axis }] : [];
  },
  selectors: (f) => ("edges" in f.path ? f.path.edges.map((edge, i): FeatureSelector => ({ path: `path.edges[${i}]`, edge, many: true })) : []),
  renameBodies: (raw, rename) => {
    if (pathKind(raw.path) !== "edges") return {};
    const path = raw.path as Raw;
    return { path: { ...path, edges: Array.isArray(path.edges) ? path.edges.map((s) => renameSelector(s, rename)) : path.edges } };
  },
  bodies: operationBodies<SweepFeature>(),
  onlyBodies: (raw, inScope) => operationOnlyBodies(raw, inScope),
  bodyFromId: operationBodyFromId,
  patternable: true,
  measurementKeys: ["twist"],
  reference: `## sweep
{ "id": "sweep_1", "op": "sweep", "profile": "sketch_1", "path": { "sketch": "sketch_2" } }
{ "id": "spring", "op": "sweep", "circle": { "diameter": 2 }, "path": { "helix": { "axis": { "datum": "Z" }, "radius": 10, "pitch": 5, "turns": 4 } } }
Carries a profile along a path. The profile (one of): "profile": "<sketch id>", a sketch's closed profile (its holes stay
holes: a tube from a ring); or "circle": { "diameter": mm, "inner": mm (optional bore: a hollow pipe) }, a round
section placed square to the path at its start (no sketch needed: pipes, wires, springs). Volume of a circle sweep =
π/4 x (diameter² - inner²) x path length (a straight or smoothly curved path; Pappus for each arc).
"path" (one of):
- { "sketch": "<sketch id>" }: one chain of lines and arcs (open, or closed: a circle, a rectangle, a closed run) in
  another sketch. With a profile sketch the path must START ON THE PROFILE'S PLANE: an open path runs from whichever end
  lies on that plane; a closed path starts where it crosses it, nearest the profile. Draw the profile on a plane through
  the path's end (a "normalToEdge" plane, or Front/Right where the path starts), usually centred on that end.
- { "edges": [<edge selector>, ...] }: model edges joined end to end into one chain (same rule for the profile's plane).
- { "helix": { "axis": <DatumRef axis: { "datum": "Z" }, an axis feature, a straight or circular edge, a cylinder face>,
  "radius": mm, and two of "pitch" (mm per turn), "turns", "height" (mm along the axis), "leftHanded": true (optional),
  "reverse": true (optional: climb the other way),
  "taper": degrees (optional: a conical helix, its radius growing along the axis; negative shrinks),
  "startAngle": degrees (circle sweeps only) } }: an exact helix starting at the axis point (for { "datum": "Z" } the
  origin) and climbing along the axis direction; about a cylinder face it starts at one end of the cylinder and climbs
  along it (reverse: from the other end); about a circular edge it starts at the edge's centre and climbs into the round
  face the edge bounds (reverse: away from it). With "circle" it starts at "startAngle"
  from the axis frame's x (world X, or world Y for an axis along X). With a profile sketch it starts AT THE PROFILE: at its
  centre's angle and height about the axis (sketch the profile on a plane through the axis, e.g. Front for the Z axis,
  at x = radius). Spring volume = π/4 x d² x turns x sqrt((2π x radius)² + pitch²).
"twist": degrees the profile turns about the path from start to end (a smooth path only: no sharp corners).
"orientation": "follow" (default: the profile turns with the path) | "fixed" (it slides without turning; volume = profile
area x how far the path moves along the profile's normal).
Sharp corners in a path are rounded (the profile turns about the corner). Operation fields: "operation": "new" | "add" |
"remove" (a swept cut: a groove, an O-ring gland, a thread) | "intersect" (default: add to the part's body if there is
one, else a new body); "body", "bodies", "newBody" as for revolve. A pattern or mirror can repeat it.
`,
};

function validatePath(raw: Raw, c: Parameters<FeatureDef["validate"]>[1], x: Parameters<FeatureDef["validate"]>[2], profile: string | undefined): SweepPath | null {
  const p = raw.path;
  const shapes = '{ "sketch": "<sketch id>" }, { "edges": [<edge selector>, ...] } or { "helix": { "axis": ..., "radius": ..., "pitch": ..., "turns": ... } }';
  if (p === undefined) {
    c.fail("path", `needed: what the profile follows, ${shapes}`);
    return null;
  }
  if (!x.isObject(p)) {
    c.fail("path", `must be ${shapes} (got ${x.describe(p)})`);
    return null;
  }
  const kinds = (["sketch", "edges", "helix"] as const).filter((k) => p[k] !== undefined);
  if (kinds.length !== 1) {
    c.keys(p, "path", ["sketch", "edges", "helix"]);
    c.fail("path", kinds.length ? `give one of "sketch", "edges" and "helix", not ${kinds.map((k) => `"${k}"`).join(" and ")}` : `must be ${shapes}`);
    return null;
  }
  const kind = kinds[0];
  c.keys(p, "path", [kind]);
  if (kind === "sketch") {
    const sketch = x.sketch(p.sketch, "path.sketch");
    if (sketch !== undefined && sketch === profile) c.fail("path.sketch", `is the profile's sketch too: the path is a chain in another sketch (or use "circle" and sweep a round section along "${sketch}")`);
    return sketch ? { sketch } : null;
  }
  if (kind === "edges") {
    const edges = x.edgeSelectors(p.edges, "path.edges");
    return edges ? { edges: Array.isArray(edges) ? edges : [edges] } : null;
  }
  const h = p.helix;
  if (!x.isObject(h)) {
    c.fail("path.helix", `must be { "axis": <axis>, "radius": <mm>, "pitch": <mm>, "turns": <n> } (got ${x.describe(h)})`);
    return null;
  }
  const at = "path.helix";
  const before = c.errors.length;
  c.keys(h, at, ["axis", "radius", "pitch", "turns", "height", "leftHanded", "reverse", "taper", "startAngle"]);
  let axis: DatumRef | null = null;
  if (h.axis === undefined) c.fail(`${at}.axis`, 'needed: the axis it winds about ({ "datum": "Z" }, an axis feature, a straight or circular edge, a cylinder)');
  else axis = x.datumRef(h.axis, `${at}.axis`, "axis");
  const radius = c.num(h, "radius", at, { positive: true });
  const pitch = h.pitch === undefined ? undefined : c.num(h, "pitch", at, { positive: true });
  const turns = h.turns === undefined ? undefined : c.num(h, "turns", at, { positive: true });
  const height = h.height === undefined ? undefined : c.num(h, "height", at, { positive: true });
  const leftHanded = x.bool(h, "leftHanded", at);
  const reverse = x.bool(h, "reverse", at);
  const taper = h.taper === undefined ? undefined : c.num(h, "taper", at, {});
  const startAngle = h.startAngle === undefined ? undefined : c.num(h, "startAngle", at, {});
  if (taper !== undefined && Math.abs(taper) >= MAX_TAPER) c.fail(`${at}.taper`, `must be less than ${MAX_TAPER}° either way (got ${taper})`);
  if (startAngle !== undefined && profile !== undefined) c.fail(`${at}.startAngle`, "a helix with a profile sketch starts at the profile; move the profile (or leave startAngle out)");
  if (c.errors.length > before || !axis || radius === undefined) return null;
  const numbers = helixNumbers({ pitch, turns, height });
  if (typeof numbers === "string") {
    c.fail(at, numbers);
    return null;
  }
  if (taper && endRadius(radius, numbers.height, taper) <= 0) {
    c.fail(`${at}.taper`, `a ${taper}° taper over ${numbers.height} mm takes the radius below zero (it would be ${Math.round(endRadius(radius, numbers.height, taper) * 1e3) / 1e3} mm at the end): make it gentler, or the helix shorter`);
    return null;
  }
  return {
    helix: {
      axis,
      radius,
      ...(pitch !== undefined ? { pitch } : {}),
      ...(turns !== undefined ? { turns } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(leftHanded ? { leftHanded } : {}),
      ...(reverse ? { reverse } : {}),
      ...(taper ? { taper } : {}),
      ...(startAngle !== undefined ? { startAngle } : {}),
    },
  };
}
