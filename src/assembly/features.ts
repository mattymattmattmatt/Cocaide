// What can be mated on a component, found on its part's faces (parts built
// here or imported from STEP alike): its flat faces, its holes and its bosses
// (round faces: concave or not), each with the selector a mate holds it by,
// where it is in the assembly; and the mates two components most likely
// want: a pin or boss into a hole of its size, holes of a size in line, and
// the faces that then meet, or two big faces flush. Pure.

import type { AssemblyComponent, MateRef, MateType, Vec3 } from "../doc/types";
import { faceSelectorFor } from "../kernel/synthesize";
import type { FaceInfo } from "../kernel/topology";
import type { PartTopology } from "./resolve";
import { apply, placementOf, pointTo } from "./transform";

export type MateFeature =
  | { kind: "plane"; ref: MateRef; normal: Vec3; point: Vec3; area: number }
  | {
      kind: "hole" | "boss";
      ref: MateRef;
      diameter: number;
      axis: Vec3;
      point: Vec3;
      length: number;
      partial: boolean;
      /** A boss's shoulder: the flat face it stands out of, square to it (what sits on the face a hole opens onto). A hole's mouths: the flat faces it opens onto. */
      seats?: MateRef[];
      /** The seats' outward normals, in the assembly. */
      seatNormals?: Vec3[];
    };

const r3 = (x: number) => Math.round(x * 1000) / 1000 + 0;
const v3 = (v: Vec3): Vec3 => v.map(r3) as Vec3;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** The component's mateable faces, biggest first: flat faces, then holes and bosses. `limit` per kind. */
export function mateFeatures(k: AssemblyComponent, part: PartTopology, limit = 24): MateFeature[] {
  const P = placementOf(k);
  const ref = (f: FaceInfo): MateRef | null => {
    const s = faceSelectorFor(part.faces, f.index);
    return s.ok ? { component: k.id, face: s.selector } : null;
  };
  const planes: MateFeature[] = [];
  const round: MateFeature[] = [];
  for (const f of [...part.faces].sort((a, b) => b.area - a.area)) {
    if (f.type === "plane" && f.normal && planes.length < limit) {
      const r = ref(f);
      if (r) planes.push({ kind: "plane", ref: r, normal: v3(apply(P.R, f.normal)), point: v3(pointTo(P, f.centroid)), area: r3(f.area) });
    } else if (f.cylinder && round.length < limit) {
      const c = f.cylinder;
      const r = ref(f);
      if (!r) continue;
      // The axis's point at the middle of the face's length.
      const mid = (c.axial[0] + c.axial[1]) / 2;
      const local: Vec3 = [c.origin[0] + c.axis[0] * mid, c.origin[1] + c.axis[1] * mid, c.origin[2] + c.axis[2] * mid];
      const seats = endFaces(part.faces, f).flatMap((e) => {
        const sr = ref(e);
        return sr ? [{ ref: sr, normal: v3(apply(P.R, e.normal!)) }] : [];
      });
      round.push({
        kind: c.concave ? "hole" : "boss",
        ref: r,
        diameter: r3(2 * c.radius),
        axis: v3(apply(P.R, c.axis)),
        point: v3(pointTo(P, local)),
        length: r3(Math.abs(c.axial[1] - c.axial[0])),
        partial: c.span < 2 * Math.PI - 1e-6,
        ...(seats.length ? { seats: seats.map((x) => x.ref), seatNormals: seats.map((x) => x.normal) } : {}),
      });
    }
  }
  return [...planes, ...round];
}

/**
 * The flat faces at a round face's ends, square to its axis: for a boss, its
 * shoulders (the face it stands out of: its normal along the boss, toward
 * its other end); for a hole, its mouths (the faces it opens onto: normals
 * away from it). Biggest first.
 */
export function endFaces(faces: FaceInfo[], round: FaceInfo): FaceInfo[] {
  const c = round.cylinder!;
  const ends = [c.axial[0], c.axial[1]].map((t) => [c.origin[0] + c.axis[0] * t, c.origin[1] + c.axis[1] * t, c.origin[2] + c.axis[2] * t] as Vec3);
  const lo = Math.min(c.axial[0], c.axial[1]);
  const hi = Math.max(c.axial[0], c.axial[1]);
  const out: FaceInfo[] = [];
  for (const f of faces) {
    if (f.type !== "plane" || !f.normal) continue;
    const along = dot(f.normal, c.axis);
    if (Math.abs(Math.abs(along) - 1) > 1e-6) continue;
    const p = f.point ?? f.centroid;
    const at = ends.findIndex((e) => Math.abs(dot(sub(p, e), f.normal!)) < 1e-4);
    if (at < 0) continue;
    // Which way the face looks along the axis, from the end it is at: toward the round face's other end, or away.
    const t = at === 0 ? c.axial[0] : c.axial[1];
    const inward = (t === lo && along > 0) || (t === hi && along < 0);
    if (c.concave ? !inward : inward) out.push(f);
  }
  return out.sort((a, b) => b.area - a.area);
}

export interface MateSuggestion {
  /** What it is, in words: "pin-1's Ø10 boss into base-1's Ø10.2 hole". */
  what: string;
  score: number;
  mates: { type: MateType; a: MateRef; b: MateRef; aligned?: boolean }[];
}

/** The faces of a component square to an axis (normal along it, either way), with which way they face. */
function squareTo(features: MateFeature[], axis: Vec3): Extract<MateFeature, { kind: "plane" }>[] {
  return features.filter((f): f is Extract<MateFeature, { kind: "plane" }> => f.kind === "plane" && Math.abs(Math.abs(dot(f.normal, axis)) - 1) < 1e-3);
}

/** The middle of a component's faces (where it is, roughly). */
function middle(features: MateFeature[]): Vec3 {
  const n = features.length || 1;
  return [0, 1, 2].map((i) => features.reduce((s, f) => s + f.point[i], 0) / n) as Vec3;
}

/**
 * The mates two components most likely want, best first: a boss into a hole
 * of its size (concentric, and the shoulder on the face the hole opens onto),
 * holes of one size in line (concentric, and the faces they open onto
 * together), or their biggest faces flush.
 */
export function suggestMates(a: AssemblyComponent, partA: PartTopology, b: AssemblyComponent, partB: PartTopology, opts: { taken?: MateRef[] } = {}): MateSuggestion[] {
  const fa = mateFeatures(a, partA, 40);
  const fb = mateFeatures(b, partB, 40);
  const ma = middle(fa);
  const mb = middle(fb);
  const out: MateSuggestion[] = [];
  /** The face of `on` square to `axis` that faces the other component (its normal toward `toward`), the biggest. */
  const facing = (on: MateFeature[], axis: Vec3, from: Vec3, toward: Vec3) =>
    squareTo(on, axis)
      .filter((p) => dot(p.normal, sub(toward, from)) > 0)
      .sort((x, y) => y.area - x.area)[0];
  // Round faces a concentric mate holds already (a hole with a pin in it) are taken.
  const takenKeys = new Set((opts.taken ?? []).map((r) => JSON.stringify(r)));
  const round = (fs: MateFeature[]) => fs.filter((f): f is Extract<MateFeature, { kind: "hole" | "boss" }> => f.kind !== "plane" && !f.partial && !takenKeys.has(JSON.stringify(f.ref)));
  const dist = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  /** How far apart two axes are, across them (0: in line already). */
  const apart = (x: { point: Vec3; axis: Vec3 }, y: { point: Vec3 }) => {
    const d = sub(y.point, x.point);
    const along = dot(d, x.axis);
    return Math.hypot(d[0] - x.axis[0] * along, d[1] - x.axis[1] * along, d[2] - x.axis[2] * along);
  };
  void dist;
  for (const x of round(fa))
    for (const y of round(fb)) {
      const fit = Math.abs(x.diameter - y.diameter);
      const tol = Math.max(0.6, 0.06 * Math.max(x.diameter, y.diameter));
      const pin = x.kind !== y.kind && fit <= tol && (x.kind === "hole" ? x.diameter >= y.diameter - 1e-6 : y.diameter >= x.diameter - 1e-6);
      const inLine = x.kind === "hole" && y.kind === "hole" && fit < 1e-3;
      if (!pin && !inLine) continue;
      const mates: MateSuggestion["mates"] = [{ type: "concentric", a: x.ref, b: y.ref }];
      // The faces that meet along the axis: a boss's shoulder on the mouth of the hole facing it; two holes' mouths facing each other.
      // A boss's shoulder; a hole's mouth facing the other component (none: a countersink or counterbore there —
      // then the biggest face square to the axis facing it, the face a head sits on).
      const seat = (f: typeof x, from: Vec3, toward: Vec3): { ref: MateRef } | undefined => {
        if (!f.seats?.length) return undefined;
        if (f.kind === "boss") return { ref: f.seats[0] };
        const i = f.seatNormals!.findIndex((n) => dot(n, sub(toward, from)) > 0);
        return i >= 0 ? { ref: f.seats[i] } : undefined;
      };
      /** Failing both (the parts side by side): the mouth turned most toward the other. */
      const most = (f: typeof x, from: Vec3, toward: Vec3): { ref: MateRef } | undefined => {
        if (!f.seats?.length) return undefined;
        let best = 0;
        f.seatNormals!.forEach((n, i) => {
          if (dot(n, sub(toward, from)) > dot(f.seatNormals![best], sub(toward, from))) best = i;
        });
        return { ref: f.seats[best] };
      };
      const pa = seat(x, ma, mb) ?? facing(fa, x.axis, ma, mb) ?? most(x, ma, mb);
      const pb = seat(y, mb, ma) ?? facing(fb, y.axis, mb, ma) ?? most(y, mb, ma);
      if (pa && pb) mates.push({ type: "coincident", a: pa.ref, b: pb.ref });
      const hole = x.kind === "hole" ? x : y;
      const at = `[${hole.point.slice(0, 3).map((v) => Math.round(v * 10) / 10).join(", ")}]`;
      const what = pin
        ? `${x.kind === "boss" ? a.id : b.id}'s Ø${x.kind === "boss" ? x.diameter : y.diameter} boss into ${x.kind === "hole" ? a.id : b.id}'s Ø${x.kind === "hole" ? x.diameter : y.diameter} hole at ${at}`
        : `${a.id}'s and ${b.id}'s Ø${x.diameter} holes in line (at ${at})`;
      // The nearest pair first: of a pattern of holes, the one the part is over goes first.
      const gap = apart(x, y);
      out.push({ what: pa && pb ? `${what}, and the faces they open onto together` : what, score: (pin ? 3 : 2) - fit / 10 + (pa && pb ? 0.5 : 0) - Math.min(0.9, gap / 1000), mates, key: `${pin ? "pin" : "line"}|${x.kind === "boss" ? JSON.stringify(x.ref) : JSON.stringify(y.ref.component)}|${Math.min(x.diameter, y.diameter)}` } as MateSuggestion & { key: string });
    }
  // Their biggest faces flush, facing each other.
  const pa = fa.filter((f): f is Extract<MateFeature, { kind: "plane" }> => f.kind === "plane" && dot(f.normal, sub(mb, ma)) > 0).sort((x, y) => y.area - x.area)[0];
  if (pa) {
    const pb = fb.filter((f): f is Extract<MateFeature, { kind: "plane" }> => f.kind === "plane" && dot(f.normal, sub(ma, mb)) > 0).sort((x, y) => y.area - x.area)[0];
    if (pb) out.push({ what: `${a.id}'s and ${b.id}'s biggest facing faces flush`, score: 1, mates: [{ type: "coincident", a: pa.ref, b: pb.ref }] });
  }
  // Of a pattern of holes, the nearest free one for each boss (and each size of holes in line): keep the best few.
  out.sort((x, y) => y.score - x.score);
  const seen = new Set<string>();
  return out
    .filter((s) => {
      const key = (s as MateSuggestion & { key?: string }).key ?? s.what;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((s) => {
      const { key: _k, ...rest } = s as MateSuggestion & { key?: string };
      void _k;
      return rest;
    })
    .slice(0, 8);
}
