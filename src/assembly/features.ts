// What can be mated on a component, found on its part's faces (parts built
// here or imported from STEP alike): its flat faces, its holes and its bosses
// (round faces: concave or not), each with the selector a mate holds it by,
// where it is in the assembly; and the mates two components most likely
// want: a pin or boss into a hole of its size, holes of a size in line, and
// the faces that then meet, or two big faces flush. Pure.

import { nextComponentId, nextMateId } from "../doc/assembly";
import type { Assembly, AssemblyComponent, Mate, MateRef, MateType, Vec3 } from "../doc/types";
import { selectFaces } from "../kernel/selectors";
import { faceSelectorFor } from "../kernel/synthesize";
import type { FaceInfo } from "../kernel/topology";
import { solveAssembly } from "./model";
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
      /** A hole's floors: the flat faces at its inner end looking back up it (a counterbore's floor), what a head in it sits on. */
      floors?: MateRef[];
      /** A tapped hole's thread (its diameter is the tap drill's): what a bolt of `major` screws into. */
      thread?: { major: number; designation: string };
    };

/** A ref as text, keys sorted at every level: two refs to one face read the same however they were written. */
export function refKey(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(refKey).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${refKey((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

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
      const floors = c.concave ? endFaces(part.faces, f, true).flatMap((e) => ref(e) ?? []) : [];
      // A tapped hole: the drill of one of the part's tapped holes (patterns copy it, so by its size).
      const tapped = c.concave ? part.holes?.find((h) => h.thread && Math.abs(h.diameter - 2 * c.radius) < 1e-3)?.thread : undefined;
      round.push({
        kind: c.concave ? "hole" : "boss",
        ...(tapped ? { thread: { major: tapped.major, designation: tapped.designation } } : {}),
        ref: r,
        diameter: r3(2 * c.radius),
        axis: v3(apply(P.R, c.axis)),
        point: v3(pointTo(P, local)),
        length: r3(Math.abs(c.axial[1] - c.axial[0])),
        partial: c.span < 2 * Math.PI - 1e-6,
        ...(seats.length ? { seats: seats.map((x) => x.ref), seatNormals: seats.map((x) => x.normal) } : {}),
        ...(floors.length ? { floors } : {}),
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
export function endFaces(faces: FaceInfo[], round: FaceInfo, floors = false): FaceInfo[] {
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
    if (floors ? c.concave && inward : c.concave ? !inward : inward) out.push(f);
  }
  // Of faces in one plane (two counterbores' floors, say), the one round this face: its centre nearest the axis.
  const offAxis = (f: FaceInfo) => {
    const d = sub(f.centroid, c.origin);
    const t = dot(d, c.axis);
    return Math.hypot(d[0] - c.axis[0] * t, d[1] - c.axis[1] * t, d[2] - c.axis[2] * t);
  };
  const byPlane = new Map<string, FaceInfo>();
  for (const f of out) {
    const key = `${f.normal!.map((x) => Math.round(x * 1000)).join(",")}|${Math.round(dot(f.point ?? f.centroid, f.normal!) * 1000)}`;
    const had = byPlane.get(key);
    if (!had || offAxis(f) < offAxis(had)) byPlane.set(key, f);
  }
  return [...byPlane.values()].sort((a, b) => b.area - a.area);
}

/**
 * The holes something is in already: the hole side of each concentric mate whose other side is a boss (a pin, a
 * bolt's shank). A hole only lined up with another hole is still open: a bolt goes through both.
 */
export function occupiedHoles(asm: Assembly, partOf: (componentId: string) => PartTopology | undefined): MateRef[] {
  const round = (r: MateRef) => {
    const t = partOf(r.component);
    if (!t || !r.face) return undefined;
    const m = selectFaces(t.faces, r.face).matches;
    return m.length === 1 ? m[0].cylinder : undefined;
  };
  return (asm.mates ?? []).flatMap((m) => {
    if (m.type !== "concentric" || m.suppressed) return [];
    const ca = round(m.a);
    const cb = round(m.b);
    if (ca?.concave && cb && !cb.concave) return [m.a];
    if (cb?.concave && ca && !ca.concave) return [m.b];
    return [];
  });
}

/** The round faces of concentric mates other than those between `a` and `b`: holes some other pair lines up already. */
export function linedHoles(asm: Assembly, a: string, b: string): MateRef[] {
  return (asm.mates ?? []).filter((m) => m.type === "concentric" && !m.suppressed && !([m.a.component, m.b.component].includes(a) && [m.a.component, m.b.component].includes(b))).flatMap((m) => [m.a, m.b]);
}

export interface Clash {
  components: [string, string];
  volume: number;
  /** Why it is fine: a bolt's thread in its tapped hole (threads are cosmetic, so its shank overlaps the tap drill). */
  expected?: string;
}

/**
 * Overlaps as a user reads them: touching (a pin a hair over its hole, by the
 * numbers) left out, and a bolt in a tapped hole of its size marked expected,
 * not a clash — the thread is drawn, not modelled.
 */
export function sortClashes(asm: Assembly, clashes: { components: [string, string]; volume: number }[], partOf: (componentId: string) => PartTopology | undefined): Clash[] {
  const cyl = (r: MateRef) => {
    const t = partOf(r.component);
    if (!t || !r.face) return undefined;
    const m = selectFaces(t.faces, r.face).matches;
    return m.length === 1 && m[0].cylinder ? { c: m[0].cylinder, t } : undefined;
  };
  const threaded = (x: string, y: string) =>
    (asm.mates ?? []).some((m) => {
      if (m.type !== "concentric" || m.suppressed || !([m.a.component, m.b.component].includes(x) && [m.a.component, m.b.component].includes(y))) return false;
      const ca = cyl(m.a);
      const cb = cyl(m.b);
      if (!ca || !cb) return false;
      const [hole, boss] = ca.c.concave ? [ca, cb] : [cb, ca];
      if (!hole.c.concave || boss.c.concave) return false;
      const thread = hole.t.holes?.find((h) => h.thread && Math.abs(h.diameter - 2 * hole.c.radius) < 1e-3)?.thread;
      return !!thread && Math.abs(thread.major - 2 * boss.c.radius) < 0.3;
    });
  return clashes
    .filter((c) => c.volume >= 0.01)
    .map((c) => (threaded(c.components[0], c.components[1]) ? { ...c, expected: "a bolt in its tapped hole (the thread is cosmetic)" } : c));
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
export function suggestMates(a: AssemblyComponent, partA: PartTopology, b: AssemblyComponent, partB: PartTopology, opts: { taken?: MateRef[]; lined?: MateRef[] } = {}): MateSuggestion[] {
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
  const takenKeys = new Set((opts.taken ?? []).map(refKey));
  // Holes lined up with some other part's already: a third part's hole lined up there too would sit where that part is.
  const linedKeys = new Set((opts.lined ?? []).map(refKey));
  const round = (fs: MateFeature[]) => fs.filter((f): f is Extract<MateFeature, { kind: "hole" | "boss" }> => f.kind !== "plane" && !f.partial && !takenKeys.has(refKey(f.ref)));
  const dist = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  /** How far apart two axes are, across them (0: in line already). */
  const apart = (x: { point: Vec3; axis: Vec3 }, y: { point: Vec3 }) => {
    const d = sub(y.point, x.point);
    const along = dot(d, x.axis);
    return Math.hypot(d[0] - x.axis[0] * along, d[1] - x.axis[1] * along, d[2] - x.axis[2] * along);
  };
  void dist;
  /** What a hole takes: a tapped one, its thread's major diameter; a plain one, its own. */
  const takes = (f: { diameter: number; thread?: { major: number } }) => f.thread?.major ?? f.diameter;
  /** Whether a hole is a clearance hole for a bolt of `d` (ISO 273 close to loose, and a little more). */
  const clears = (hole: number, d: number) => hole >= d - 1e-6 && hole - d <= Math.max(0.6, 0.13 * d);
  const label = (f: { diameter: number; thread?: { designation: string } }) => (f.thread ? f.thread.designation.replace(/×.*/, "") + " tapped" : `Ø${f.diameter}`);
  for (const x of round(fa))
    for (const y of round(fb)) {
      const fit = Math.abs(takes(x) - takes(y));
      const hole = x.kind === "hole" ? x : y;
      const other = x.kind === "hole" ? y : x;
      // A boss (a pin, a bolt) into a hole that takes it: a bolt into a tapped hole of its size, or a pin into a hole a little over it.
      const pin = x.kind !== y.kind && (hole.thread ? Math.abs(hole.thread.major - other.diameter) < 0.3 : clears(hole.diameter, other.diameter));
      // Holes in line: of one size, or a clearance hole over a tapped one (a bolt goes through the one into the other).
      const inLine =
        x.kind === "hole" &&
        y.kind === "hole" &&
        (x.thread && y.thread ? x.thread.major === y.thread.major : x.thread ? clears(y.diameter, x.thread.major) : y.thread ? clears(x.diameter, y.thread.major) : fit < 1e-3);
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
      // A boss with no shoulder going into a hole with a floor (a bolt's head into a counterbore): it sits on the floor.
      const floorOf = (f: typeof x, o: typeof x) => (pin && f.kind === "hole" && f.floors?.length && !o.seats?.length ? { ref: f.floors[0] } : undefined);
      const pa = floorOf(x, y) ?? seat(x, ma, mb) ?? facing(fa, x.axis, ma, mb) ?? most(x, ma, mb);
      const pb = floorOf(y, x) ?? seat(y, mb, ma) ?? facing(fb, y.axis, mb, ma) ?? most(y, mb, ma);
      if (pa && pb) mates.push({ type: "coincident", a: pa.ref, b: pb.ref });
      // Holes in line as a pattern: the other holes of each part that line up too, as the first pair's do (the same
      // spacings), say a block's two bolt holes over a plate's two tapped ones. A second concentric then holds the turn.
      let pattern = 0;
      if (inLine) {
        const fits = (p: typeof x, q: typeof x) => p.kind === "hole" && q.kind === "hole" && (p.thread && q.thread ? p.thread.major === q.thread.major : p.thread ? clears(q.diameter, p.thread.major) : q.thread ? clears(p.diameter, q.thread.major) : Math.abs(p.diameter - q.diameter) < 1e-3);
        const across = (p: typeof x, q: typeof x) => (Math.abs(Math.abs(dot(p.axis, q.axis)) - 1) < 1e-3 ? apart(p, q) : NaN);
        let second: { x2: typeof x; y2: typeof x; d: number } | null = null;
        for (const x2 of round(fa)) {
          if (x2 === x || !fits(x2, y)) continue;
          const dA = across(x, x2);
          if (!(dA > 1e-3)) continue;
          const y2 = round(fb).find((q) => q !== y && fits(x2, q) && Math.abs(across(y, q) - dA) < 0.05);
          if (!y2) continue;
          pattern++;
          if (!second || dA > second.d) second = { x2, y2, d: dA };
        }
        if (second) mates.push({ type: "concentric", a: second.x2.ref, b: second.y2.ref });
      }
      const at = `[${hole.point.slice(0, 3).map((v) => Math.round(v * 10) / 10).join(", ")}]`;
      const what = pin
        ? `${x.kind === "boss" ? a.id : b.id}'s Ø${other.diameter} boss into ${x.kind === "hole" ? a.id : b.id}'s ${label(hole)} hole at ${at}`
        : x.thread || y.thread || x.diameter !== y.diameter
          ? `${a.id}'s ${label(x)} and ${b.id}'s ${label(y)} holes in line (at ${at})`
          : `${a.id}'s and ${b.id}'s Ø${x.diameter} holes in line (at ${at})`;
      const counted = pattern ? what.replace(/'s (M\d+ tapped|Ø[\d.]+)/g, `'s ${pattern + 1} $1`).replace(" holes in line", " holes in line as a pattern") : what;
      // The nearest pair first: of a pattern of holes, the one the part is over goes first.
      const gap = apart(x, y);
      const crowded = inLine && (linedKeys.has(refKey(x.ref)) || linedKeys.has(refKey(y.ref))) ? 2 : 0;
      out.push({ what: pa && pb ? `${counted}, and the faces they open onto together` : counted, score: (pin ? 3 : 2) - crowded + pattern * 1.5 - fit / 10 + (pa && pb ? 0.5 : 0) - Math.min(0.9, gap / 1000), mates, key: `${pin ? "pin" : "line"}|${x.kind === "boss" ? JSON.stringify(x.ref) : y.kind === "boss" ? JSON.stringify(y.ref) : y.ref.component}|${takes(x)}|${takes(y)}` } as MateSuggestion & { key: string });
    }
  // Two faces flush: of the flat faces that already face each other as the parts sit (normals opposed, the one in
  // front of the other), the biggest and nearest pair — a plate laid on a frame's top meets its rails' tops, not a side.
  const planes = (fs: MateFeature[]) => fs.filter((f): f is Extract<MateFeature, { kind: "plane" }> => f.kind === "plane");
  let flush: { pa: Extract<MateFeature, { kind: "plane" }>; pb: Extract<MateFeature, { kind: "plane" }>; score: number } | null = null;
  const span = Math.max(1, Math.hypot(...sub(mb, ma)));
  for (const pa of planes(fa))
    for (const pb of planes(fb)) {
      const opposed = -dot(pa.normal, pb.normal);
      if (opposed < 0.95) continue;
      const gap = dot(sub(pb.point, pa.point), pa.normal);
      if (gap < -1e-3) continue;
      // Across the normal: how far the faces' middles are apart (0: one right over the other).
      const d = sub(pb.point, pa.point);
      const across = Math.hypot(d[0] - pa.normal[0] * gap, d[1] - pa.normal[1] * gap, d[2] - pa.normal[2] * gap);
      const score = Math.sqrt(Math.min(pa.area, pb.area)) / (1 + gap / span + across / span);
      if (!flush || score > flush.score) flush = { pa, pb, score };
    }
  if (flush) out.push({ what: `${a.id}'s and ${b.id}'s facing faces flush`, score: 1, mates: [{ type: "coincident", a: flush.pa.ref, b: flush.pb.ref }] });
  else {
    // Nothing faces yet: their biggest faces turned toward each other.
    const pa = planes(fa).filter((f) => dot(f.normal, sub(mb, ma)) > 0).sort((x, y) => y.area - x.area)[0];
    const pb = planes(fb).filter((f) => dot(f.normal, sub(ma, mb)) > 0).sort((x, y) => y.area - x.area)[0];
    if (pa && pb) out.push({ what: `${a.id}'s and ${b.id}'s biggest facing faces flush`, score: 0.9, mates: [{ type: "coincident", a: pa.ref, b: pb.ref }] });
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

/**
 * A component in a hole, copied into every other hole of its size on the same
 * part (a bolt into each bolt hole): each copy shifted across to its hole and
 * given the original's mates, the hole swapped for its own. Holes something is
 * in already are left out. Null-free: why not, in words.
 */
export function holeCopies(asm: Assembly, id: string, partOf: (componentId: string) => PartTopology | undefined): { next: Assembly; copies: string[] } | string {
  const k = asm.components.find((x) => x.id === id);
  if (!k) return `no component "${id}"`;
  const faceIndex = (r: MateRef) => {
    const t = partOf(r.component);
    if (!t || !r.face) return -1;
    const m = selectFaces(t.faces, r.face).matches;
    return m.length === 1 ? m[0].index : -1;
  };
  // The concentric mate that puts it in a hole: its side round and convex (a shank), the other a hole.
  let found: { mate: Mate; hole: MateRef } | null = null;
  for (const m of asm.mates ?? []) {
    if (m.type !== "concentric" || m.suppressed) continue;
    const mine = m.a.component === id ? m.a : m.b.component === id ? m.b : null;
    const other = mine === m.a ? m.b : m.a;
    if (!mine || other.component === id) continue;
    const ti = partOf(id);
    const to = partOf(other.component);
    const fi = ti && mine.face ? selectFaces(ti.faces, mine.face).matches : [];
    const fo = to && other.face ? selectFaces(to.faces, other.face).matches : [];
    if (fi.length === 1 && fo.length === 1 && fi[0].cylinder && !fi[0].cylinder.concave && fo[0].cylinder?.concave) {
      found = { mate: m, hole: other };
      break;
    }
  }
  if (!found) return `${id} isn't in a hole: mate it concentric with a hole first (a bolt's shank in a bolt hole), then copy it to the others`;
  const host = asm.components.find((x) => x.id === found!.hole.component)!;
  const hostPart = partOf(host.id);
  if (!hostPart) return `${host.id}'s part has not been built`;
  const holes = mateFeatures(host, hostPart, 400).filter((f): f is Extract<MateFeature, { kind: "hole" | "boss" }> => f.kind === "hole" && !f.partial);
  const origIndex = faceIndex(found.hole);
  const orig = holes.find((h) => faceIndex(h.ref) === origIndex);
  if (!orig) return `${host.id}'s hole that ${id} is in can't be found again`;
  const occupied = new Set(occupiedHoles(asm, (c) => partOf(c)).map((r) => `${r.component}#${faceIndex(r)}`));
  const targets = holes.filter(
    (h) =>
      faceIndex(h.ref) !== origIndex &&
      !occupied.has(`${host.id}#${faceIndex(h.ref)}`) &&
      Math.abs(h.diameter - orig.diameter) < 1e-3 &&
      (h.thread?.major ?? 0) === (orig.thread?.major ?? 0) &&
      Math.abs(dot(h.axis, orig.axis)) > 0.999,
  );
  if (!targets.length) return `${host.id} has no other free Ø${orig.diameter} hole in line with this one's direction`;
  let next: Assembly = { ...asm, components: [...asm.components], mates: [...(asm.mates ?? [])] };
  const copies: string[] = [];
  const stem = id.replace(/-\d+$/, "");
  const mine = (asm.mates ?? []).filter((m) => !m.suppressed && (m.a.component === id || m.b.component === id));
  for (const h of targets) {
    const nid = nextComponentId(next, stem);
    // Across to the new hole (not along it: the copy keeps how deep the original sits).
    const d = sub(h.point, orig.point);
    const along = dot(d, orig.axis);
    const shift: Vec3 = [d[0] - orig.axis[0] * along, d[1] - orig.axis[1] * along, d[2] - orig.axis[2] * along];
    const at = (k.at ?? [0, 0, 0]).map((v, i) => Math.round((v + shift[i]) * 1e6) / 1e6) as Vec3;
    const copy: AssemblyComponent = { id: nid, part: k.part, at, ...(k.rotation ? { rotation: k.rotation } : {}) };
    next = { ...next, components: [...next.components, copy] };
    for (const m of mine) {
      const swap = (r: MateRef): MateRef => (m.id === found.mate.id && r === found.hole ? h.ref : r.component === id ? { ...r, component: nid } : r);
      const mate: Mate = { ...m, id: nextMateId(next, m.type), a: swap(m.a), b: swap(m.b) };
      next = { ...next, mates: [...(next.mates ?? []), mate] };
    }
    copies.push(nid);
  }
  return { next, copies };
}

/** holeCopies, solved: copies whose mates don't hold are left out (with their mates). */
export function copiesThatHold(
  asm: Assembly,
  id: string,
  partOf: (componentId: string) => PartTopology | undefined,
  views: Map<string, PartTopology>,
): { next: Assembly; copies: string[]; skipped: number } | string {
  const plan = holeCopies(asm, id, partOf);
  if (typeof plan === "string") return plan;
  const s = solveAssembly(plan.next, views);
  const failing = new Set(s.mates.filter((m) => !m.ok).map((m) => m.id));
  const bad = new Set(plan.copies.filter((c) => (plan.next.mates ?? []).some((m) => failing.has(m.id) && (m.a.component === c || m.b.component === c))));
  if (bad.size === plan.copies.length) return `no copy's mates would hold (${[...failing].join(", ")}): the other holes may sit on other faces than this one's mate uses`;
  const next: Assembly = { ...plan.next, components: plan.next.components.filter((k) => !bad.has(k.id)), mates: (plan.next.mates ?? []).filter((m) => !bad.has(m.a.component) && !bad.has(m.b.component)) };
  return { next, copies: plan.copies.filter((c) => !bad.has(c)), skipped: bad.size };
}
