// Flipping a mate: the other way round. What "flip" does depends on the mate and
// what it holds: two flat faces face to face or the same way (coincident,
// distance); two directions the same way or opposite (parallel, concentric,
// coincident axes or edges); an angle measured the other way (θ ↔ 180° − θ); a
// distance to the other side of the first face; a tangent on the other side of
// the flat face, or one round face inside the other. Pure.

import type { Mate, Vec3 } from "../doc/types";
import type { MateGeom, SolverMate } from "./solve";
import { apply, type Placement } from "./transform";

export interface MateFlips {
  /** The main flip: its button's words, the mate's way round now, and the change it makes. */
  flip: { label: string; now: string; patch: Partial<Mate> } | null;
  /** Distance only: to the other side of the first face. */
  side: { now: string; patch: Partial<Mate> } | null;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dirOf = (g: MateGeom, p?: Placement): Vec3 | null => {
  const v = g.kind === "plane" ? g.n : g.kind === "axis" ? g.d : null;
  return v && p ? apply(p.R, v) : v;
};

/**
 * The flips a mate has. `held` is the mate as the solver holds it (its geometry: plane, axis or point), when found;
 * `placements` where its components are now (for an old mate that was "either way": which way it is now).
 */
export function mateFlips(m: Mate, held?: SolverMate, placements?: Map<string, Placement>): MateFlips {
  const ka = held?.a.geom.kind;
  const kb = held?.b.geom.kind;
  const planes = ka === "plane" && kb === "plane";
  const axes = ka === "axis" && kb === "axis";
  const planeAxis = (ka === "plane" && kb === "axis") || (ka === "axis" && kb === "plane");
  // Two directions: aligned ↔ opposed; one that was either way becomes the other way from how it sits now.
  const directions = (): MateFlips["flip"] => {
    if (m.aligned) return { label: "Flip", now: "Aligned (the same way)", patch: { aligned: undefined, opposed: true } };
    if (m.opposed) return { label: "Flip", now: "Anti-aligned (opposite ways)", patch: { aligned: true, opposed: undefined } };
    const u = held ? dirOf(held.a.geom, placements?.get(held.a.component)) : null;
    const v = held ? dirOf(held.b.geom, placements?.get(held.b.component)) : null;
    const same = u && v ? dot(u, v) >= 0 : true;
    return { label: "Flip", now: "Either way round", patch: same ? { aligned: undefined, opposed: true } : { aligned: true, opposed: undefined } };
  };
  let flip: MateFlips["flip"] = null;
  let side: MateFlips["side"] = null;
  switch (m.type) {
    case "coincident":
    case "distance":
      if (planes || !held) flip = { label: "Flip", now: m.aligned ? "Aligned (facing the same way)" : "Face to face", patch: { aligned: m.aligned ? undefined : true } };
      else if (axes) flip = directions();
      if (m.type === "distance" && (planes || planeAxis || !held || ka === "point" || kb === "point") && !axes) side = { now: m.flip ? "On the other side" : "In front of the first face", patch: { flip: m.flip ? undefined : true } };
      break;
    case "parallel":
      if (!planeAxis) flip = directions();
      break;
    case "concentric":
      flip = directions();
      break;
    case "angle":
      flip = { label: "Flip", now: `${m.value ?? 0}° (the other way: ${Math.round((180 - (m.value ?? 0)) * 1000) / 1000}°)`, patch: { value: Math.round((180 - (m.value ?? 0)) * 1000) / 1000 } };
      break;
    case "tangent":
      flip = { label: "Flip", now: axes ? (m.flip ? "One inside the other" : "Side by side") : m.flip ? "Behind the flat face" : "In front of the flat face", patch: { flip: m.flip ? undefined : true } };
      break;
    case "perpendicular":
      break;
  }
  return { flip, side };
}

/** A new mate's way round, as its two things sit now: directions the same way or not; a tangent's side. */
export function startingWay(type: Mate["type"], a: { kind: string; normal?: Vec3; point?: Vec3; radius?: number }, b: { kind: string; normal?: Vec3; point?: Vec3; radius?: number }): Partial<Mate> {
  const same = a.normal && b.normal ? dot(a.normal, b.normal) >= 0 : true;
  if (type === "concentric" || (type === "parallel" && a.kind === b.kind) || (type === "coincident" && a.kind === "axis" && b.kind === "axis")) return same ? { aligned: true } : { opposed: true };
  if (type === "tangent") {
    const plane = a.kind === "plane" ? a : b.kind === "plane" ? b : null;
    const round = a.kind === "axis" ? a : b;
    if (plane?.normal && plane.point && round.point) return dot([round.point[0] - plane.point[0], round.point[1] - plane.point[1], round.point[2] - plane.point[2]], plane.normal) < 0 ? { flip: true } : {};
    if (a.radius !== undefined && b.radius !== undefined && a.point && b.point && a.normal) {
      const v: Vec3 = [b.point[0] - a.point[0], b.point[1] - a.point[1], b.point[2] - a.point[2]];
      const along = dot(v, a.normal);
      const off = Math.hypot(v[0] - a.normal[0] * along, v[1] - a.normal[1] * along, v[2] - a.normal[2] * along);
      return Math.abs(off - Math.abs(a.radius - b.radius)) < Math.abs(off - (a.radius + b.radius)) ? { flip: true } : {};
    }
  }
  return {};
}
