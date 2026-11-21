// Nodes that follow a sketch: a frame drawn as a layout sketch, its members on
// the sketch's lines. A node written { "sketch": "layout", "point": "l1.end" }
// is wherever that point of that sketch is, so editing the sketch moves the
// members and their joints with it. Pure: the sketch's plane is worked out
// from the document (a written plane, a default plane, or a plane feature
// offset from one of those), with no kernel, so the frame validates as any
// other does. A sketch on a face would need the solid, and is refused with
// the reason.

import type { NodeLink, Vec2, Vec3 } from "../doc/types";
import { defaultDatum, flipPlane, offsetPlane, refPlaneFrame, datumPlaneDatum, xDirProblem, type PlaneDatum } from "../features/datum";
import { to3D, type Frame } from "../geom/frame";
import { sketch3dPoint } from "../geom/sketch3d";
import { resolveExpressions, type Parameters } from "../doc/parameters";

export type { NodeLink };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isVec = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && Number.isFinite(x));

/** Whether a node's value is a link to a sketch point (rather than [x, y, z]). */
export function isNodeLink(v: unknown): v is NodeLink {
  return isObject(v) && "sketch" in v;
}

/** "layout's l1.end": how a message names the point. */
export function linkText(link: NodeLink): string {
  return link.t !== undefined ? `${link.sketch}'s ${link.point} at ${Math.round(link.t * 1000) / 10}%` : `${link.sketch}'s ${link.point}`;
}

/** The named points of an entity type, as a link writes them. */
export const LINK_POINTS: Readonly<Record<string, readonly string[]>> = {
  line: ["start", "end", "mid"],
  arc: ["start", "end", "center"],
  circle: ["center"],
  point: ["at"],
  slot: ["center1", "center2"],
};

/**
 * `needsFrame`: the sketch's plane comes from the solid (a face, a plane made
 * from edges or faces): the rebuild works out where the sketch is and passes
 * its frame in `frames`, so the node is known then.
 */
export type Resolved = { ok: true; at: Vec3 } | { ok: false; error: string; needsFrame?: true };

/** Where sketches are, as the kernel resolved them (their frames, by sketch id): for sketches on faces. */
export type SketchFrames = Readonly<Record<string, Frame>>;

/** A rebuild's sketches as frames by id (what the UI passes validation). */
export function framesOf(sketches: readonly { id: string; frame: Frame }[] | undefined): SketchFrames | undefined {
  return sketches?.length ? Object.fromEntries(sketches.map((k) => [k.id, k.frame])) : undefined;
}

/** A plane that only the solid can say where it is, and why. */
type FromSolid = { solid: string };

/**
 * Where a linked node is: the sketch point in 3D. `features` is the document's
 * feature list as written (expressions are evaluated with `params`).
 */
export function resolveNodeLink(features: readonly unknown[], link: unknown, params: Parameters = {}, frames?: SketchFrames, depth = 0): Resolved {
  if (!isObject(link)) return { ok: false, error: `must be [x, y, z] or { "sketch": <sketch id>, "point": "<entity>.<point>" }` };
  const extra = Object.keys(link).filter((k) => k !== "sketch" && k !== "point" && k !== "t");
  if (extra.length) return { ok: false, error: `a point that follows a sketch has only "sketch", "point" and "t" (not ${extra.map((k) => `"${k}"`).join(", ")})` };
  if (typeof link.sketch !== "string" || !link.sketch) return { ok: false, error: `"sketch" must be a sketch's id` };
  const along = link.t !== undefined;
  if (along && (typeof link.t !== "number" || !(link.t >= 0 && link.t <= 1))) return { ok: false, error: `"t" is how far along the line, 0 (its start) to 1 (its end) (got ${JSON.stringify(link.t)})` };
  if (typeof link.point !== "string" || !(along ? /^[^.]+$/ : /^[^.]+\.[^.]+$/).test(link.point)) {
    return { ok: false, error: along ? `with "t", "point" is a line's id, like "l1" (got ${JSON.stringify(link.point)})` : `"point" must be "<entity>.<point>", like "l1.end" (got ${JSON.stringify(link.point)})` };
  }
  if (depth > 8) return { ok: false, error: `follows ${String(link.sketch)}, which follows back round to it` };
  const l = link as unknown as NodeLink;
  if (along) {
    // That far along a line: between its two ends.
    const a = resolveNodeLink(features, { sketch: l.sketch, point: `${l.point}.start` }, params, frames, depth + 1);
    const b = resolveNodeLink(features, { sketch: l.sketch, point: `${l.point}.end` }, params, frames, depth + 1);
    if (!a.ok) return a;
    if (!b.ok) return b;
    const t = l.t!;
    return { ok: true, at: a.at.map((x, k) => Math.round((x + t * (b.at[k] - x)) * 1e9) / 1e9 + 0) as Vec3 };
  }
  const raw = features.find((f) => isObject(f) && f.id === l.sketch);
  if (!isObject(raw)) return { ok: false, error: `follows ${linkText(l)}, but there is no sketch "${l.sketch}"` };
  if (raw.op === "sketch3d") {
    // A 3D sketch: its points are in space already (some following other sketches in turn).
    const follow = (x: unknown) => resolveNodeLink(features, x, params, frames, depth + 1);
    const p = sketch3dPoint(resolveExpressions(raw, params, []) as Record<string, unknown>, l.point, follow);
    return typeof p === "string" ? { ok: false, error: `follows ${linkText(l)}, but ${p}` } : { ok: true, at: p };
  }
  if (raw.op !== "sketch") return { ok: false, error: `follows ${linkText(l)}, but ${l.sketch} is a ${String(raw.op)}, not a sketch` };
  const [entityId, at] = l.point.split(".");
  const entities = Array.isArray(raw.entities) ? raw.entities : [];
  const rawEntity = entities.find((e) => isObject(e) && e.id === entityId);
  if (!isObject(rawEntity)) return { ok: false, error: `follows ${linkText(l)}, but ${l.sketch} has no ${entityId} any more: link it to another point or give it coordinates` };
  const e = resolveExpressions(rawEntity, params, []) as Record<string, unknown>;
  const p = entityPoint(e, at);
  if (typeof p === "string") return { ok: false, error: `follows ${linkText(l)}: ${p}` };
  let frame = sketchFrame(features, raw, params);
  if (typeof frame === "object" && "solid" in frame) {
    // On a face (or a plane made from the part): where the rebuild found it.
    const known = frames?.[l.sketch];
    if (!known) return { ok: false, error: `follows ${linkText(l)}, but ${l.sketch} is ${frame.solid}, and it didn't build, so where its points are isn't known`, needsFrame: true };
    frame = known;
  }
  if (typeof frame === "string") return { ok: false, error: `follows ${linkText(l)}, but ${frame}` };
  return { ok: true, at: to3D(frame, p).map((x) => Math.round(x * 1e9) / 1e9 + 0) as Vec3 };
}

/** The point of an entity, in the sketch; a string says why there isn't one. */
function entityPoint(e: Record<string, unknown>, at: string): Vec2 | string {
  const type = String(e.type);
  const allowed = LINK_POINTS[type];
  if (!allowed) return `a ${type} has no point a node can follow (use a line's start, end or mid, an arc's or a circle's center, or a point)`;
  if (!allowed.includes(at)) return `a ${type} has ${allowed.map((a) => `"${a}"`).join(", ")}, not "${at}"`;
  const v = (k: string): Vec2 | string => (isVec(e[k], 2) ? (e[k] as Vec2) : `its ${k} is not two numbers`);
  if (type === "line" && at === "mid") {
    const s = v("start");
    const t = v("end");
    if (typeof s === "string") return s;
    if (typeof t === "string") return t;
    return [(s[0] + t[0]) / 2, (s[1] + t[1]) / 2];
  }
  if (type === "slot") {
    // A slot is its two centres and a width.
    return v(at === "center1" ? "center1" : "center2");
  }
  return v(at);
}

/** The frame a sketch is drawn on, or why it can't be worked out without the solid. */
function sketchFrame(features: readonly unknown[], raw: Record<string, unknown>, params: Parameters): Frame | FromSolid | string {
  const plane = resolveExpressions(raw.plane, params, []);
  if (!isObject(plane)) return `${String(raw.id)} has no plane`;
  if (plane.type === "datum") {
    if (!isVec(plane.normal, 3) || !isVec(plane.origin, 3)) return `${String(raw.id)}'s plane is not written right`;
    const d = datumPlaneDatum({ type: "datum", normal: plane.normal as Vec3, origin: plane.origin as Vec3, ...(isVec(plane.xDir, 3) ? { xDir: plane.xDir as Vec3 } : {}) });
    return refPlaneFrame(d);
  }
  if (plane.type !== "ref" || !isObject(plane.ref)) return `${String(raw.id)}'s plane is not written right`;
  const base = planeOfRef(features, plane.ref, params, new Set([String(raw.id)]));
  if (typeof base === "string" || "solid" in base) return base;
  const xDir = isVec(plane.xDir, 3) ? (plane.xDir as Vec3) : undefined;
  if (xDir && xDirProblem(base.normal, xDir)) return `${String(raw.id)}'s xDir ${xDirProblem(base.normal, xDir)}`;
  return refPlaneFrame(base, { offset: typeof plane.offset === "number" ? plane.offset : undefined, flip: plane.flip === true, xDir });
}

/** A referenced plane: a default plane, or a plane feature offset (or flipped) from one, as far back as it goes. */
function planeOfRef(features: readonly unknown[], ref: Record<string, unknown>, params: Parameters, seen: Set<string>): PlaneDatum | FromSolid | string {
  if ("face" in ref) return { solid: "on a face" };
  if (typeof ref.datum !== "string") return { solid: "on a plane made from the part" };
  const d = defaultDatum(ref.datum);
  if (d) return d.kind === "plane" ? d : `${ref.datum} is not a plane`;
  if (seen.has(ref.datum)) return `${ref.datum} refers back to itself`;
  seen.add(ref.datum);
  const f = features.find((x) => isObject(x) && x.id === ref.datum);
  if (!isObject(f)) return `there is no plane "${ref.datum}"`;
  const r = resolveExpressions(f, params, []) as Record<string, unknown>;
  const mode = r.mode ?? "offset";
  if (r.op !== "plane" || mode !== "offset" || !Array.isArray(r.refs) || !isObject(r.refs[0])) return { solid: `on ${ref.datum}, a plane made from the part` };
  const base = planeOfRef(features, r.refs[0] as Record<string, unknown>, params, seen);
  if (typeof base === "string" || "solid" in base) return base;
  const p = offsetPlane(base, typeof r.distance === "number" ? r.distance : 0);
  return r.flip === true ? flipPlane(p) : p;
}
