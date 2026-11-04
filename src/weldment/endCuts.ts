// How a member's ends are cut (Phase Q), in the profile's own frame: the
// angle from square, which way the cut leans (across the section's x or y,
// or skew), whether the two cuts lie in one plane or are twisted, and
// whether two members are the same piece cut alike — turned end for end or
// over where the section's symmetry allows it, never mirrored (a left- and a
// right-hand piece of an angle are different parts).
//
// Pure: works on the rebuild's member measurements (src/kernel/cutlist.ts
// measures the end faces' normals on the trimmed body).

import type { Vec2, Vec3 } from "../doc/types";
import type { MemberMeasurement, SectionSymmetry } from "../kernel/measure";

/** One end's cut, in the profile's frame. */
export interface EndCut {
  /** Degrees from square, to 0.1°. */
  angle: number;
  /**
   * Which way the cut face leans: its outward normal's part across the
   * section, as a unit vector in the profile's (x, y). [0, 0] for a square end.
   */
  lean: Vec2;
  /**
   * The axis the lean is along: "y" leans up the section (the angle is seen
   * on the faces at ±x, looking along x), "x" across it, "skew" neither.
   */
  toward: "x" | "y" | "skew" | null;
}

/** How the two ends' cuts sit to each other. */
export type EndRelation = "square" | "oneEnd" | "samePlane" | "twisted";

export interface MemberCuts {
  ends: [EndCut, EndCut];
  relation: EndRelation;
  /** Same plane: the cuts lean the same way (a trapezoid, like a picture frame's piece) or opposite ways (a parallelogram). */
  shape?: "trapezoid" | "parallelogram";
  /** Twisted: the angle between the two cuts' lean directions, degrees. */
  twist?: number;
  mitre: boolean;
  cope: boolean;
  notch: boolean;
}

/** Angles within this are the same cut, degrees. */
export const ANGLE_TOLERANCE = 0.1;
/** Below this the end is square, degrees. */
const SQUARE = 0.05;
/** Leans whose directions differ by less than this (as unit vectors) are the same, about 1°. */
const LEAN_TOLERANCE = 0.02;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const tenth = (x: number) => Math.round(x * 10) / 10 + 0;

/** A member's end cuts. A measurement from before Phase Q (no normals or axes) reads as square-or-angled with no lean. */
export function memberCuts(m: MemberMeasurement): MemberCuts {
  const ends = [0, 1].map((k) => endCut(m, k as 0 | 1)) as [EndCut, EndCut];
  const angled = ends.filter((e) => e.angle > SQUARE).length;
  const out: MemberCuts = {
    ends,
    relation: angled === 0 ? "square" : angled === 1 ? "oneEnd" : "samePlane",
    mitre: angled > 0,
    cope: !!m.copes?.some(Boolean),
    notch: !!m.endFaces?.some((n) => n > 1),
  };
  if (angled === 2) {
    const [a, b] = [ends[0].lean, ends[1].lean];
    if (a[0] === 0 && a[1] === 0) return out; // no frame to tell: taken as one plane
    const cross = a[0] * b[1] - a[1] * b[0];
    const d = a[0] * b[0] + a[1] * b[1];
    if (Math.abs(cross) < LEAN_TOLERANCE) out.shape = d > 0 ? "trapezoid" : "parallelogram";
    else {
      out.relation = "twisted";
      out.twist = tenth((Math.acos(Math.max(-1, Math.min(1, Math.abs(d)))) * 180) / Math.PI);
    }
  }
  return out;
}

function endCut(m: MemberMeasurement, k: 0 | 1): EndCut {
  const angle = tenth(m.angles[k]);
  const n = m.normals?.[k];
  if (!n || !m.axes || angle <= SQUARE) return { angle, lean: [0, 0], toward: angle <= SQUARE ? null : "skew" };
  const lx = dot(n, m.axes.x);
  const ly = dot(n, m.axes.y);
  const l = Math.hypot(lx, ly);
  if (l < 1e-9) return { angle, lean: [0, 0], toward: null };
  const lean: Vec2 = [round4(lx / l), round4(ly / l)];
  const toward = Math.abs(lean[1]) > 1 - 1e-4 ? "y" : Math.abs(lean[0]) > 1 - 1e-4 ? "x" : "skew";
  return { angle, lean, toward };
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4 + 0;

/** A transform of a piece onto itself: a 2×2 matrix on the section and whether it turns the piece end for end. */
interface Motion {
  m: [number, number, number, number];
  swap: boolean;
}

/**
 * The ways a length of this section can be turned and still be the same bar:
 * end for end about its y axis needs it mirror-symmetric across y (x to -x),
 * about x needs it symmetric across x, a quarter turn about the line needs a
 * square section. Closed under composition (at most 16 motions).
 */
export function motionsOf(sym: SectionSymmetry | undefined): Motion[] {
  const gens: Motion[] = [];
  if (sym?.mirrorX) gens.push({ m: [-1, 0, 0, 1], swap: true });
  if (sym?.mirrorY) gens.push({ m: [1, 0, 0, -1], swap: true });
  if (sym?.quarter) gens.push({ m: [0, -1, 1, 0], swap: false });
  const all: Motion[] = [{ m: [1, 0, 0, 1], swap: false }];
  const key = (x: Motion) => `${x.m.join(",")}|${x.swap}`;
  const seen = new Set(all.map(key));
  for (let i = 0; i < all.length; i++) {
    for (const g of gens) {
      const a = all[i].m;
      const b = g.m;
      const c: Motion = { m: [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3]], swap: all[i].swap !== g.swap };
      if (!seen.has(key(c))) {
        seen.add(key(c));
        all.push(c);
      }
    }
  }
  return all;
}

/** Are two members' cuts the same piece's (lengths and profiles are compared elsewhere)? */
export function sameCuts(a: MemberCuts, b: MemberCuts, sym: SectionSymmetry | undefined): boolean {
  if (a.cope !== b.cope || a.notch !== b.notch) return false;
  const close = (x: EndCut, y: EndCut, lean: Vec2) => Math.abs(x.angle - y.angle) <= ANGLE_TOLERANCE + 1e-9 && (x.angle <= SQUARE || Math.hypot(x.lean[0] - lean[0], x.lean[1] - lean[1]) < LEAN_TOLERANCE);
  if (sym?.round) {
    // Any turn about the line: only the angles and the angle between the leans count.
    const twist = (c: MemberCuts) => {
      const [p, q] = [c.ends[0].lean, c.ends[1].lean];
      return (Math.acos(Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1]))) * 180) / Math.PI;
    };
    const angles = (c: MemberCuts) => [c.ends[0].angle, c.ends[1].angle];
    const [a0, a1] = angles(a);
    const [b0, b1] = angles(b);
    const sameAngles = (Math.abs(a0 - b0) <= ANGLE_TOLERANCE && Math.abs(a1 - b1) <= ANGLE_TOLERANCE) || (Math.abs(a0 - b1) <= ANGLE_TOLERANCE && Math.abs(a1 - b0) <= ANGLE_TOLERANCE);
    return sameAngles && Math.abs(twist(a) - twist(b)) <= 1;
  }
  for (const g of motionsOf(sym)) {
    const [e0, e1] = g.swap ? [b.ends[1], b.ends[0]] : b.ends;
    const t = (l: Vec2): Vec2 => [g.m[0] * l[0] + g.m[1] * l[1], g.m[2] * l[0] + g.m[3] * l[1]];
    if (close(a.ends[0], e0, t(e0.lean)) && close(a.ends[1], e1, t(e1.lean))) return true;
  }
  return false;
}

/**
 * A section's symmetry from its outline (points in its own x, y). Mirror
 * symmetry is about the outline box's middle lines; a quarter turn about its
 * centre; round when every point is as far from the centre.
 */
export function sectionSymmetry(outline: Vec2[]): SectionSymmetry {
  if (outline.length < 3) return { mirrorX: false, mirrorY: false, quarter: false, round: false };
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const tol = Math.max(1e-6, size * 2e-3);
  // A sample of the points, each tested against every edge of the outline (closed).
  const step = Math.max(1, Math.floor(outline.length / 64));
  const sample = outline.filter((_, i) => i % step === 0);
  const onOutline = (p: Vec2) => {
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i];
      const b = outline[(i + 1) % outline.length];
      if (segmentDistance(p, a, b) <= tol) return true;
    }
    return false;
  };
  const holds = (f: (p: Vec2) => Vec2) => sample.every((p) => onOutline(f(p)));
  // Round: the outline's points and the middles of its edges all as far from the centre (a polygon's corners alone may be).
  const radii = outline.flatMap((p, i) => {
    const q = outline[(i + 1) % outline.length];
    return [Math.hypot(p[0] - cx, p[1] - cy), Math.hypot((p[0] + q[0]) / 2 - cx, (p[1] + q[1]) / 2 - cy)];
  });
  const round = Math.max(...radii) - Math.min(...radii) <= tol;
  return {
    mirrorX: round || holds(([x, y]) => [2 * cx - x, y]),
    mirrorY: round || holds(([x, y]) => [x, 2 * cy - y]),
    quarter: round || holds(([x, y]) => [cx - (y - cy), cy + (x - cx)]),
    round,
  };
}

function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

/** "45°", "square". */
export function angleText(a: number): string {
  return a <= SQUARE ? "square" : `${tenth(a)}°`;
}

/** The ends in a few words: "45° / 45°, same plane (trapezoid)", "45° / 30°, twisted 90°", "square". */
export function cutsText(c: MemberCuts): string {
  const [a, b] = c.ends;
  if (c.relation === "square") return "square" + extrasText(c);
  const angles = `${angleText(a.angle)} / ${angleText(b.angle)}`;
  if (c.relation === "oneEnd") return angles + extrasText(c);
  if (c.relation === "twisted") return `${angles}, twisted ${c.twist}°` + extrasText(c);
  return `${angles}${c.shape ? `, same plane (${c.shape})` : ", same plane"}` + extrasText(c);
}

function extrasText(c: MemberCuts): string {
  const x = [c.cope ? "coped" : "", c.notch ? "notched" : ""].filter(Boolean);
  return x.length ? `, ${x.join(", ")}` : "";
}

/**
 * Where an end's angle is seen: on the faces the cut's lean runs across.
 * A lean up the section (y) shows on the sides at ±x, which are as wide as
 * the section is high: "on the 100 face" for an RHS 100×50 standing up.
 */
export function faceText(e: EndCut, envelope?: [number, number]): string {
  if (!e.toward || e.toward === "skew" || !envelope) return e.toward === "skew" ? "skew" : "";
  const w = e.toward === "y" ? envelope[1] : envelope[0];
  return `on ${Math.round(w * 10) / 10} face`;
}
