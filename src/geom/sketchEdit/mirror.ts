// Mirror entities, as CAD users expect them: the picked lines, arcs, circles
// and points mirrored about a line (a centreline, any line, or the sketch's
// X or Y axis). With copy (the default) the originals stay and each copy is
// held to its original by a symmetric relation (entity to entity for lines,
// arcs and circles; point to point for sketch points), so editing one side
// moves the other. Where a copy's point lands on an original's (a half
// profile's ends on the centreline) the two are joined. Without copy the
// originals move to their mirror images and keep their relations where they
// still hold. Rectangles and slots are exploded first.

import type { Constraint, SketchEntity, Vec2 } from "../../doc/types";
import { AXIS_LINES, isAxisId } from "../axes";
import { add2, dist2, dot2, scale2, sub2 } from "../vec";
import { entityPoint } from "../curves";
import { TOL } from "./curve";
import { explodeAll } from "./explode";
import { freshIds, mapRefs, PREFIX, pointNames, settle, type Edit, type SketchState } from "./relations";

export interface MirrorOptions {
  /** Keep the originals and add mirrored copies (default), or move the originals over. */
  copy?: boolean;
}

/** The mirror line's two points: a line of the sketch or one of its axes. */
function mirrorLine(entities: SketchEntity[], about: string): [Vec2, Vec2] | string {
  const l = isAxisId(about) ? AXIS_LINES[about as keyof typeof AXIS_LINES] : entities.find((e) => e.id === about);
  if (!l) return `there is no line "${about}" to mirror about`;
  if (l.type !== "line") return `${about} is a ${l.type}: mirror about a line or centreline`;
  if (dist2(l.start, l.end) <= TOL) return `${about} has no length: it gives no direction to mirror about`;
  return [l.start, l.end];
}

/** p mirrored about the line through a and b. */
export function reflectPoint(p: Vec2, [a, b]: [Vec2, Vec2]): Vec2 {
  const d = sub2(b, a);
  const t = dot2(sub2(p, a), d) / dot2(d, d);
  const f = add2(a, scale2(d, t));
  return [2 * f[0] - p[0], 2 * f[1] - p[1]];
}

/**
 * An entity mirrored: a line's ends, a circle's centre, a point. An arc is
 * reversed by a mirror, so its mirrored start is the image of its end (and
 * it keeps turning the same way). `names` says where each point went.
 */
function mirrored(e: SketchEntity, line: [Vec2, Vec2], id: string): { entity: SketchEntity; names: Record<string, string> } | null {
  const m = (p: Vec2) => reflectPoint(p, line);
  const base = e.construction !== undefined ? { construction: e.construction } : {};
  switch (e.type) {
    case "line":
      return { entity: { id, type: "line", start: m(e.start), end: m(e.end), ...base }, names: { start: "start", end: "end" } };
    case "circle":
      return { entity: { id, type: "circle", center: m(e.center), radius: e.radius, ...base }, names: { center: "center" } };
    case "arc":
      return {
        entity: { id, type: "arc", center: m(e.center), start: m(e.end), end: m(e.start), ...(e.clockwise ? { clockwise: true } : {}), ...base },
        names: { center: "center", start: "end", end: "start" },
      };
    case "point":
      return { entity: { id, type: "point", at: m(e.at), ...base }, names: { at: "at" } };
    case "ellipse": {
      // A mirror turns the ellipse's sense: the point at parameter t lands on the image's point at −t, so an arc's ends swap.
      const arc = e.startAngle !== undefined && e.endAngle !== undefined ? { startAngle: -e.endAngle, endAngle: -e.startAngle } : {};
      return {
        entity: { id, type: "ellipse", center: m(e.center), major: m(e.major), minor: e.minor, ...arc, ...base },
        names: { center: "center", major: "major", minorEnd: "minorEnd", start: "end", end: "start" },
      };
    }
    case "spline": {
      // Its points mirrored in order; an end tangent's direction mirrored too.
      const [a, b] = line;
      const axis = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      const turn = (deg: number | undefined) => (deg === undefined ? {} : { v: 2 * axis - deg });
      const st = turn(e.startTangent);
      const et = turn(e.endTangent);
      return {
        entity: { id, type: "spline", points: e.points.map(m), ...(e.closed ? { closed: true } : {}), ...("v" in st ? { startTangent: st.v } : {}), ...("v" in et ? { endTangent: et.v } : {}), ...base },
        names: Object.fromEntries(e.points.map((_, i) => [`p${i}`, `p${i}`])),
      };
    }
    default:
      return null;
  }
}

/** Mirror entities `ids` about line `about` (an entity id, or "X" / "Y"). */
export function mirrorEntities(stateIn: SketchState, ids: string[], about: string, opts: MirrorOptions = {}): Edit | string {
  const copy = opts.copy ?? true;
  const line = mirrorLine(stateIn.entities, about);
  if (typeof line === "string") return line;
  const picked = ids.filter((id) => id !== about);
  if (!picked.length) return "pick the entities to mirror, then the line to mirror them about";
  for (const id of picked) {
    const e = stateIn.entities.find((x) => x.id === id);
    if (!e) return `there is no entity "${id}"`;
    if (e.ref) return `${id} follows the model (a reference): Convert Entities copies it first, then mirror the copy`;
  }
  const { state, ids: pieces } = explodeAll(stateIn, picked);
  const byId = new Map(state.entities.map((e) => [e.id, e]));
  const fresh = freshIds(state.entities);
  const made: SketchEntity[] = [];
  /** original id → its image's id and where each of its points went. */
  const images = new Map<string, { id: string; names: Record<string, string> }>();
  for (const id of pieces) {
    const e = byId.get(id)!;
    const m = mirrored(e, line, copy ? fresh(PREFIX[e.type]) : e.id);
    if (!m) continue;
    made.push(m.entity);
    images.set(id, { id: m.entity.id, names: m.names });
  }
  if (!made.length) return "nothing there can be mirrored: pick lines, arcs, circles, ellipses, splines or points";
  const imageRef = (ref: string): string | null => {
    const [owner, name] = ref.split(".");
    const im = images.get(owner);
    return im && name ? `${im.id}.${im.names[name] ?? name}` : null;
  };
  if (!copy) {
    // The originals move over; their own points renamed where an arc turned round.
    const entities = state.entities.map((e) => made.find((m) => m.id === e.id) ?? e);
    const constraints = state.constraints.flatMap((k) => {
      const m = mapRefs(k, (ref) => imageRef(ref) ?? ref);
      return m ? [m] : [];
    });
    return { entities, constraints: settle(entities, constraints, [...images.keys()]), made: made.map((e) => e.id) };
  }
  const hard: Constraint[] = [...images].map(([orig, im]): Constraint => {
    const e = byId.get(orig)!;
    return e.type === "point" ? { type: "symmetric", points: [`${orig}.at`, `${im.id}.at`], line: about } : { type: "symmetric", entities: [orig, im.id], line: about };
  });
  // An ellipse's and a spline's image is held by its points mirrored (and an ellipse's equal radii).
  for (const [i, k] of hard.entries()) {
    if (k.type !== "symmetric" || !k.entities) continue;
    const e = byId.get(k.entities[0])!;
    if (e.type !== "ellipse" && e.type !== "spline") continue;
    const im = k.entities[1];
    const names = e.type === "ellipse" ? ["center", "major"] : e.points.map((_, n) => `p${n}`);
    hard.splice(i, 1, ...names.map((n): Constraint => ({ type: "symmetric", points: [`${e.id}.${n}`, `${im}.${n}`], line: about })), ...(e.type === "ellipse" ? [{ type: "equal", entities: [e.id, im] } as Constraint] : []));
  }
  const entities = [...state.entities, ...made];
  // Where an image's point lands on a point of the originals (on the mirror line), the two join.
  const soft: Constraint[] = [];
  for (const m of made) {
    for (const name of pointNames(m)) {
      const ref = `${m.id}.${name}`;
      const p = pointOf(m, name);
      if (!p || name === "center") continue;
      for (const id of pieces) {
        const o = byId.get(id)!;
        for (const on of pointNames(o)) {
          const q = pointOf(o, on);
          if (q && on !== "center" && dist2(p, q) <= 10 * TOL) soft.push({ type: "coincident", points: [`${id}.${on}`, ref] });
        }
      }
    }
  }
  return { entities, constraints: settle(entities, [...state.constraints, ...hard], made.map((e) => e.id), new Set(hard)), soft, made: made.map((e) => e.id) };
}

function pointOf(e: SketchEntity, name: string): Vec2 | null {
  if (e.type === "ellipse" || e.type === "spline") return entityPoint(e, name) ?? null;
  const v = (e as unknown as Record<string, unknown>)[name];
  return Array.isArray(v) && v.length === 2 ? (v as Vec2) : null;
}
