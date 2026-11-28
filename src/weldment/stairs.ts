// The stair tool: a straight, L (quarter landing) or U (half landing) stair
// laid out by the riser and going rules from floor-to-floor height, as
// features of the part: two LVL stringers a flight, cut level on the floor
// (or landing) and plumb at the top, the treads housed into them, closed
// risers if asked, a framed landing, and a report (risers, going, 2R + G,
// pitch, headroom where the floor above is given). Pure.

import { apply, type Command, type RawDocument } from "../doc/commands";
import type { Vec3 } from "../doc/types";
import { ensureCopy } from "./library";
import { standardLibrary } from "./standard";

export type StairType = "straight" | "L" | "U";

export interface StairSpec {
  type: StairType;
  /** The foot of the stair: the first riser's line, at its middle, on the floor (mm). */
  origin: Vec3;
  /** The way up, degrees about Z from +X. */
  direction: number;
  /** Floor to floor, mm. */
  rise: number;
  /** Clear width of each flight between the stringers' outer faces, mm. */
  width: number;
  /** Going (tread depth, nosing to nosing), mm. */
  going: number;
  /** The tallest riser allowed, mm (the number of risers is the fewest under it). */
  maxRiser?: number;
  /** L and U: which way the stair turns at the landing. */
  turn?: "left" | "right";
  /** L and U: risers below the landing (default half). */
  landingAfter?: number;
  /** Tread thickness, mm. */
  tread?: number;
  /** How far the treads are let into the stringers, mm. */
  housing?: number;
  /** Stringer size, an LVL designation ("300x45 LVL"). */
  stringer?: string;
  /** Closed risers (18 boards) instead of open. */
  risers?: boolean;
  /** Nosing past the riser line, mm. */
  nosing?: number;
  /** The floor above: its structure's depth under its finished level, and how far the opening runs back from the top riser along the last flight (mm). Without it headroom is not checked. */
  above?: { depth: number; opening: number };
  /** Id prefix for the features (default "stair"). */
  id?: string;
}

export interface StairReport {
  risers: number;
  riser: number;
  going: number;
  /** 2R + G, mm (comfortable: 550 to 700). */
  stride: number;
  /** Pitch, degrees. */
  pitch: number;
  /** Treads (not counting landings). */
  treads: number;
  /** The run on plan along each flight, mm. */
  runs: number[];
  /** The least clear height over a nosing under the floor above, mm (null: not checked). */
  headroom: number | null;
  /** What breaks the rules, as sentences (riser 115-190, going 240-355, 2R+G 550-700, headroom 2000, at most 18 risers a flight). */
  warnings: string[];
}

const RULES = { minRiser: 115, maxRiser: 190, minGoing: 240, maxGoing: 355, minStride: 550, maxStride: 700, headroom: 2000, flight: 18 };

/** The numbers of a stair: risers, riser height, stride, pitch and what breaks the rules. Headroom is filled in by planStair. */
export function stairNumbers(spec: StairSpec): StairReport {
  const max = spec.maxRiser ?? RULES.maxRiser;
  const n = Math.max(2, Math.ceil(spec.rise / max - 1e-9));
  const r = spec.rise / n;
  const g = spec.going;
  const flights = flightRisers(spec, n);
  const warnings: string[] = [];
  if (r > RULES.maxRiser + 1e-6) warnings.push(`risers of ${r.toFixed(1)} are over ${RULES.maxRiser}`);
  if (r < RULES.minRiser - 1e-6) warnings.push(`risers of ${r.toFixed(1)} are under ${RULES.minRiser}`);
  if (g < RULES.minGoing) warnings.push(`a going of ${g} is under ${RULES.minGoing}`);
  if (g > RULES.maxGoing) warnings.push(`a going of ${g} is over ${RULES.maxGoing}`);
  const stride = 2 * r + g;
  if (stride < RULES.minStride || stride > RULES.maxStride) warnings.push(`2R + G is ${stride.toFixed(0)}, outside ${RULES.minStride} to ${RULES.maxStride}`);
  for (const [i, f] of flights.entries()) if (f > RULES.flight) warnings.push(`flight ${i + 1} has ${f} risers: at most ${RULES.flight} without a landing`);
  return {
    risers: n,
    riser: r,
    going: g,
    stride,
    pitch: (Math.atan2(r, g) * 180) / Math.PI,
    treads: flights.reduce((t, f) => t + f - 1, 0),
    runs: flights.map((f) => (f - 1) * g),
    headroom: null,
    warnings,
  };
}

/** Risers in each flight: one flight, or two split at the landing (the landing is a riser's top). */
function flightRisers(spec: StairSpec, n: number): number[] {
  if (spec.type === "straight") return [n];
  const a = Math.min(n - 1, Math.max(1, spec.landingAfter ?? Math.floor(n / 2)));
  return [a, n - a];
}

type Pt = [number, number];
const r1 = (x: number) => Math.round(x * 10) / 10 + 0;

/** A flight: where its first riser line's middle is, the way it goes, its first riser's foot height, its risers. */
interface Flight {
  at: Vec3;
  dir: number;
  z0: number;
  risers: number;
}

/**
 * The stair as commands for the part (one change), and its report. Its
 * features are in a folder "Stair"; the stringer size comes from the
 * standard library (the part gets a copy of LVL if it has none).
 */
export function planStair(doc: RawDocument, spec: StairSpec): { ok: true; doc: RawDocument; report: StairReport; features: string[]; commands: Command[] } | { ok: false; error: string } {
  if (!(spec.rise > 0) || !(spec.width >= 500) || !(spec.going > 0)) return { ok: false, error: "the stair needs a floor-to-floor height, a width of 500 or more and a going" };
  const report = stairNumbers(spec);
  const taken = new Set(doc.features.map((f) => String(f.id)));
  const used = (p: string) => [...taken].some((id) => id === p || id.startsWith(`${p}_`));
  // No id: the next free one ("stair", then "stair_2", "stair_3"...), so a second stair just works.
  let pre = spec.id ?? "stair";
  if (spec.id === undefined) for (let i = 2; used(pre); i++) pre = `stair_${i}`;
  else if (used(pre)) return { ok: false, error: `the part already has features named ${pre}_…: give the stair another id (or leave id out for the next free one)` };
  const T = spec.tread ?? 40;
  const H = spec.housing ?? 12;
  const nose = spec.nosing ?? 20;
  const size = spec.stringer ?? "300x45 LVL";
  const R = report.riser;
  const G = report.going;
  const W = spec.width;
  const lvl = standardLibrary().find((e) => e.id === "std:lvl" || e.name.split(" (")[0] === "LVL");
  if (!lvl) return { ok: false, error: "no LVL in the section library" };
  const sz = lvl.sizes.find((s) => s.designation === size);
  if (!sz) return { ok: false, error: `${size} is not an LVL size (sizes: ${lvl.sizes.map((s) => s.designation).join(", ")})` };
  const D = Number(sz.values.d);
  const B = Number(sz.values.b);
  const copy = ensureCopy(doc, lvl, size);
  if (!copy.ok) return copy;
  let next = copy.doc;
  const cmds: Command[] = [];
  const ids: string[] = [];
  const add = (feature: Record<string, unknown>) => {
    cmds.push({ type: "addFeature", feature } as Command);
    ids.push(String(feature.id));
  };

  // The flights, and the landing between them.
  const counts = flightRisers(spec, report.risers);
  const side = spec.turn === "left" ? 1 : -1; // +v is to the left of the way up
  const flights: Flight[] = [];
  const f1: Flight = { at: spec.origin, dir: spec.direction, z0: spec.origin[2], risers: counts[0] };
  flights.push(f1);
  const rad = (d: number) => (d * Math.PI) / 180;
  const along = (f: Flight, u: number, v: number, z: number): Vec3 => {
    const c = Math.cos(rad(f.dir));
    const s = Math.sin(rad(f.dir));
    return [r1(f.at[0] + c * u - s * v), r1(f.at[1] + s * u + c * v), r1(z)];
  };
  let landing: Pt[] | null = null;
  let landingZ = 0;
  if (counts.length === 2) {
    landingZ = f1.z0 + counts[0] * R;
    const u0 = (counts[0] - 1) * G; // the landing's front edge, flight 1's last riser line
    if (spec.type === "L") {
      // A square landing W x W; flight 2 leaves its side, turned a quarter.
      landing = [[u0, -W / 2], [u0 + W, -W / 2], [u0 + W, W / 2], [u0, W / 2]].map(([u, v]) => along(f1, u, v, 0).slice(0, 2) as Pt);
      const start = along(f1, u0 + W / 2, (side * W) / 2, landingZ);
      flights.push({ at: start, dir: f1.dir + 90 * side, z0: landingZ, risers: counts[1] });
    } else {
      // A half landing across both flights and the 100 gap between them; flight 2 comes back beside flight 1.
      const gap = 100;
      const vFar = side * (W + gap);
      landing = [[u0, -W / 2], [u0 + W, -W / 2], [u0 + W, W / 2], [u0, W / 2]]
        .map(([u, v]) => [u, side > 0 ? (v < 0 ? -W / 2 : vFar + W / 2) : v > 0 ? W / 2 : vFar - W / 2] as Pt)
        .map(([u, v]) => along(f1, u, v, 0).slice(0, 2) as Pt);
      const start = along(f1, u0, vFar, landingZ);
      flights.push({ at: start, dir: f1.dir + 180, z0: landingZ, risers: counts[1] });
    }
  }

  // Each flight: a floor plane for its stringers' feet, a plumb plane at its top, two stringers, the treads housed into them.
  flights.forEach((f, i) => {
    const k = flights.length > 1 ? `${pre}_f${i + 1}` : pre;
    const run = (f.risers - 1) * G;
    const floor = `${k}_foot_plane`;
    add({ id: floor, op: "plane", mode: "offset", refs: [{ datum: "Top" }], distance: r1(f.z0) });
    const head = `${k}_head_plane`;
    add({ id: head, op: "plane", mode: "threePoints", refs: [{ point: along(f, run, 0, f.z0) }, { point: along(f, run, 100, f.z0) }, { point: along(f, run, 0, f.z0 + 100) }] });
    // The stringers' centrelines: parallel to the nosing line, their top edge 60 over it so the treads are housed.
    const slope = R / G;
    const cos = 1 / Math.hypot(1, slope);
    const drop = (D / 2 - 60) / cos;
    const zLine = (u: number) => f.z0 + R + u * slope - drop;
    const u0 = -D;
    const u1 = run + D;
    const stringers: string[] = [];
    for (const [name, v] of [["left", W / 2 - B / 2], ["right", -(W / 2 - B / 2)]] as const) {
      const id = `${k}_stringer_${name}`;
      add({
        id, op: "member", profile: copy.name, size, from: along(f, u0, v, zLine(u0)), to: along(f, u1, v, zLine(u1)),
        cutStart: { to: { datum: floor } }, cutEnd: { to: { datum: head } },
      });
      stringers.push(id);
    }
    // Treads: let into the stringers by the housing (cut first, then the tread on the same outline).
    const half = W / 2 - B + H;
    for (let t = 1; t < f.risers; t++) {
      const top = f.z0 + t * R;
      const ua = (t - 1) * G - nose;
      const ub = t * G;
      const pts = [[ua, -half], [ub, -half], [ub, half], [ua, half]].map(([u, v]) => along(f, u, v, 0).slice(0, 2) as Pt);
      const tid = `${k}_tread_${String(t).padStart(2, "0")}`;
      add({ id: `${tid}_sk`, op: "sketch", plane: { type: "ref", ref: { datum: "Top" }, offset: r1(top - T) }, entities: pts.map((p, j) => ({ id: `l${j}`, type: "line", start: p, end: pts[(j + 1) % 4] })) });
      add({ id: `${tid}_housing`, op: "cut", sketch: `${tid}_sk`, distance: T, direction: [0, 0, 1], bodies: stringers });
      add({ id: tid, op: "extrude", sketch: `${tid}_sk`, distance: T, direction: [0, 0, 1], newBody: tid });
      if (spec.risers) {
        const rid = `${k}_riser_${String(t).padStart(2, "0")}`;
        const rp = [[ua + nose, -half], [ua + nose + 18, -half], [ua + nose + 18, half], [ua + nose, half]].map(([u, v]) => along(f, u, v, 0).slice(0, 2) as Pt);
        add({ id: `${rid}_sk`, op: "sketch", plane: { type: "ref", ref: { datum: "Top" }, offset: r1(top - T - R + T) }, entities: rp.map((p, j) => ({ id: `l${j}`, type: "line", start: p, end: rp[(j + 1) % 4] })) });
        add({ id: rid, op: "extrude", sketch: `${rid}_sk`, distance: r1(R - T), direction: [0, 0, 1], newBody: rid });
      }
    }
  });
  // The landing: a platform on two bearers under its edges.
  if (landing) {
    const lid = `${pre}_landing`;
    add({ id: `${lid}_sk`, op: "sketch", plane: { type: "ref", ref: { datum: "Top" }, offset: r1(landingZ - T) }, entities: landing.map((p, j) => ({ id: `l${j}`, type: "line", start: p, end: landing![(j + 1) % 4] })) });
    add({ id: lid, op: "extrude", sketch: `${lid}_sk`, distance: T, direction: [0, 0, 1], newBody: lid });
    const zb = landingZ - T - D / 2;
    const inset = B / 2 + 5;
    const [a, b, c, d] = landing;
    // Each bearer in from its edge by half its width (its face on the landing's edge): the front one clear of the lower
    // flight's stringers, cut plumb at that edge, and its top tread; the back one clear of the upper flight's.
    const ul = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const into: Pt = [((b[0] - a[0]) / ul) * inset, ((b[1] - a[1]) / ul) * inset];
    const move = ([p, q]: [Pt, Pt], k: number): [Pt, Pt] => [[p[0] + into[0] * k, p[1] + into[1] * k], [q[0] + into[0] * k, q[1] + into[1] * k]];
    const shrink = (p: Pt, q: Pt): [Pt, Pt] => {
      const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const ux = (q[0] - p[0]) / L;
      const uy = (q[1] - p[1]) / L;
      return [[p[0] + ux * inset, p[1] + uy * inset], [q[0] - ux * inset, q[1] - uy * inset]];
    };
    for (const [n, [p, q]] of [["front", move(shrink(d, a), 1)], ["back", move(shrink(b, c), -1)]] as const) {
      add({ id: `${lid}_bearer_${n}`, op: "member", profile: copy.name, size, from: [r1(p[0]), r1(p[1]), r1(zb)], to: [r1(q[0]), r1(q[1]), r1(zb)] });
    }
  }
  for (const cmd of cmds) {
    const r = apply(next, cmd);
    if (!r.ok) return { ok: false, error: `${(cmd as { feature?: { id?: string } }).feature?.id ?? "stair"}: ${r.error}` };
    next = r.doc;
  }
  const folderCmd = { type: "setFolder", id: `${pre}_folder`, folder: { name: spec.type === "straight" ? "Stair" : `Stair (${spec.type}, ${spec.turn ?? "right"} turn)`, features: ids } } as Command;
  const folder = apply(next, folderCmd);
  if (folder.ok) next = folder.doc;
  // The same change as commands, for an editor that keeps its own history: the profile copy first, if it was added.
  const profileCmd = copy.doc !== doc ? [{ type: "setProfile", name: copy.name, profile: (copy.doc.profiles as Record<string, unknown>)[copy.name] } as Command] : [];
  const commands = [...profileCmd, ...cmds, ...(folder.ok ? [folderCmd] : [])];

  // Headroom: over each nosing of the last flight that is under the floor above.
  if (spec.above) {
    const last = flights[flights.length - 1];
    const topZ = spec.origin[2] + spec.rise;
    const under = topZ - spec.above.depth;
    const run = (last.risers - 1) * G;
    let least = Infinity;
    for (let t = 1; t < last.risers; t++) {
      const u = (t - 1) * G;
      if (u < run - spec.above.opening) least = Math.min(least, under - (last.z0 + t * R));
    }
    report.headroom = Number.isFinite(least) ? Math.round(least) : null;
    if (report.headroom !== null && report.headroom < RULES.headroom) report.warnings.push(`headroom is ${report.headroom} over a nosing: at least ${RULES.headroom} (make the opening longer)`);
  }
  return { ok: true, doc: next, report, features: ids, commands };
}
