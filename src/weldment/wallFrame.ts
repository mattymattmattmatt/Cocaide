// The wall frame tool: a timber wall frame from its length, height and
// openings, as a framer sets it out: a bottom plate broken at the doors, a
// double top plate, studs at the spacing, king and jack studs at each
// opening, a doubled lintel under the plates where the wall is external or
// carries load (else a flat head), sills, cripples under and over, noggings
// between the studs, and plasterboard linings with the openings cut out. Its
// lines go on a sketch on a vertical plane through the wall's base line and
// the members on them (Members from sketch), so the joints are made and the
// frame follows the sketch. Pure.

import { apply, type Command, type RawDocument } from "../doc/commands";
import type { Vec3 } from "../doc/types";
import { ensureCopy } from "./library";
import { addSketchMembers, type SketchLine } from "./sketchFrame";
import { standardLibrary } from "./standard";

export interface WallOpening {
  /** Rough opening along the wall from its start, mm. */
  x0: number;
  x1: number;
  /** Rough opening sill height (a window); none for a door. */
  sill?: number;
  /** Rough opening head height. */
  head: number;
  name?: string;
}

export interface WallFrameSpec {
  /** Feature id prefix (default "wall"). */
  id?: string;
  /** Where the wall starts (its centreline, at the bottom of the bottom plate), mm. */
  origin: Vec3;
  /** The way it runs, degrees about Z from +X. The outside is on the right of that way (the lining goes on the left). */
  direction: number;
  length: number;
  height: number;
  openings: WallOpening[];
  /** Stud spacing, mm (600). */
  spacing?: number;
  /** Studs, plates and noggings: an MGP10 size ("90x45 MGP10"). */
  stud?: string;
  /** Lintels: an LVL size ("240x45 LVL"), doubled. */
  lintel?: string;
  /** External, or carrying load: openings get the doubled lintel under the plates; else a flat head. */
  loadBearing?: boolean;
  /** Nogging height (default half the height). */
  nogging?: number;
  /** 10 plasterboard on the inside, both sides, or none (default: inside on a load-bearing wall, both otherwise). */
  lining?: "inside" | "both" | "none";
}

export interface WallReport {
  members: number;
  studs: number;
  noggings: number;
  lintels: number;
  /** Linear metres of each size. */
  metres: Record<string, number>;
  warnings: string[];
}

type Pt = [number, number];
type Ln = [string, Pt, Pt];
const r1 = (x: number) => Math.round(x * 10) / 10 + 0;

function sizeValues(family: string, designation: string): { d: number; b: number } | null {
  const e = standardLibrary().find((x) => x.name.split(" (")[0] === family);
  const s = e?.sizes.find((x) => x.designation === designation);
  return s ? { d: Number(s.values.d), b: Number(s.values.b) } : null;
}

/** The frame's lines by kind, in the wall's own coordinates (u along from its start, v up), and what breaks the set-out. */
export function wallLines(spec: WallFrameSpec): { plates: Ln[]; studs: Ln[]; lintels: Ln[]; flats: Ln[]; warnings: string[] } {
  const stud = sizeValues("MGP10", spec.stud ?? "90x45 MGP10") ?? { d: 90, b: 45 };
  const lin = sizeValues("LVL", spec.lintel ?? "240x45 LVL") ?? { d: 240, b: 45 };
  const t = stud.b; // plate and stud thickness
  const L = spec.length;
  const H = spec.height;
  const sp = spec.spacing ?? 600;
  const lintelled = spec.loadBearing !== false;
  const warnings: string[] = [];
  const plates: Ln[] = [];
  const studs: Ln[] = [];
  const lintels: Ln[] = [];
  const flats: Ln[] = [];
  const tpLow = H - 1.5 * t;
  const lintelV = H - 2 * t - lin.d / 2;
  const lintelBottom = H - 2 * t - lin.d;
  const ops = [...spec.openings].sort((a, b) => a.x0 - b.x0);
  ops.forEach((o, i) => {
    if (o.x1 <= o.x0) warnings.push(`opening ${o.name ?? i + 1} has no width`);
    if (o.x0 < 2.5 * t + 10 || o.x1 > L - 2.5 * t - 10) warnings.push(`opening ${o.name ?? i + 1} is too near the end of the wall for its king stud`);
    if (lintelled && o.head > lintelBottom + 0.5) warnings.push(`opening ${o.name ?? i + 1}'s head (${o.head}) is above the lintel's underside (${r1(lintelBottom)}): lower it, or use a shallower lintel`);
    if (!lintelled && o.head > tpLow - 1.5 * t) warnings.push(`opening ${o.name ?? i + 1}'s head is too near the top plate for a head`);
    if (o.sill !== undefined && o.sill >= o.head) warnings.push(`opening ${o.name ?? i + 1}'s sill is not below its head`);
    const next = ops[i + 1];
    if (next && next.x0 - o.x1 < 6 * t) warnings.push(`openings ${o.name ?? i + 1} and ${next.name ?? i + 2} are too close for their studs`);
  });
  // Bottom plate, broken at the doors.
  let u = 0;
  let k = 0;
  for (const d of ops.filter((o) => o.sill === undefined)) {
    if (d.x0 - u > 1) plates.push([`bp${k++}`, [u, t / 2], [d.x0, t / 2]]);
    u = d.x1;
  }
  if (L - u > 1) plates.push([`bp${k++}`, [u, t / 2], [L, t / 2]]);
  plates.push(["tp_low", [0, tpLow], [L, tpLow]], ["tp_high", [0, H - t / 2], [L, H - t / 2]]);
  const vert: { u: number; v0: number; v1: number; id: string }[] = [];
  const full = (uu: number, id: string) => vert.push({ u: uu, v0: t / 2, v1: tpLow, id });
  full(t / 2, "stud_s");
  full(L - t / 2, "stud_e");
  const busy: [number, number][] = [[0, t / 2 + 2 * t], [L - t / 2 - 2 * t, L]];
  ops.forEach((o, i) => {
    const n = o.name ?? `o${i + 1}`;
    const kingL = o.x0 - 1.5 * t;
    const kingR = o.x1 + 1.5 * t;
    if (kingL - t / 2 > 1.5 * t + 1) full(kingL, `king_${n}_l`);
    if (kingR + t / 2 < L - 1.5 * t - 1) full(kingR, `king_${n}_r`);
    busy.push([o.x0 - 3.5 * t, o.x1 + 3.5 * t]);
    const top = lintelled ? lintelV : o.head + t / 2;
    vert.push({ u: o.x0 - t / 2, v0: t / 2, v1: top, id: `jack_${n}_l` }, { u: o.x1 + t / 2, v0: t / 2, v1: top, id: `jack_${n}_r` });
    if (lintelled) {
      lintels.push([`lintel_${n}`, [o.x0 - t, lintelV], [o.x1 + t, lintelV]]);
      if (o.head < lintelBottom - 40) flats.push([`head_${n}`, [o.x0 - t / 2, o.head + t / 2], [o.x1 + t / 2, o.head + t / 2]]);
    } else flats.push([`head_${n}`, [o.x0 - 1.5 * t, o.head + t / 2], [o.x1 + 1.5 * t, o.head + t / 2]]);
    if (o.sill !== undefined) flats.push([`sill_${n}`, [o.x0 - t / 2, o.sill - t / 2], [o.x1 + t / 2, o.sill - t / 2]]);
    for (let c = Math.ceil((o.x0 + 60) / sp) * sp; c < o.x1 - 60; c += sp) {
      if (o.sill !== undefined) vert.push({ u: c, v0: t / 2, v1: o.sill - t / 2, id: `cripple_${n}_${c}_lo` });
      const headTop = lintelled ? (o.head < lintelBottom - 40 ? lintelV : null) : tpLow;
      if (headTop !== null && headTop - (o.head + t / 2) > 150) vert.push({ u: c, v0: o.head + t / 2, v1: headTop, id: `cripple_${n}_${c}_hi` });
    }
  });
  const isBusy = (x: number) => busy.some(([a, b]) => x > a && x < b);
  for (let c = sp; c < L - 60; c += sp) if (!isBusy(c) && !vert.some((v) => Math.abs(v.u - c) < 2 * t)) full(c, `stud_${c}`);
  for (const v of vert) studs.push([v.id, [r1(v.u), r1(v.v0)], [r1(v.u), r1(v.v1)]]);
  const nz = spec.nogging ?? Math.round(H / 2);
  const across = vert.filter((v) => v.v0 < nz - 30 && v.v1 > nz + 30).sort((a, b) => a.u - b.u);
  for (let i = 0; i + 1 < across.length; i++) {
    const a = across[i].u;
    const b = across[i + 1].u;
    if (b - a < 150) continue;
    const mid = (a + b) / 2;
    if (ops.some((o) => mid > o.x0 && mid < o.x1 && (o.sill ?? 0) < nz && o.head > nz)) continue;
    flats.push([`nog_${i + 1}`, [r1(a), nz], [r1(b), nz]]);
  }
  return { plates, studs, lintels, flats, warnings };
}

/** The numbers of a wall frame (counts, metres of each size) and its warnings, before it is built. */
export function wallNumbers(spec: WallFrameSpec): WallReport {
  const l = wallLines(spec);
  const len = (ls: Ln[]) => ls.reduce((t, [, a, b]) => t + Math.hypot(b[0] - a[0], b[1] - a[1]), 0) / 1000;
  const stud = spec.stud ?? "90x45 MGP10";
  const lintel = spec.lintel ?? "240x45 LVL";
  const metres: Record<string, number> = { [stud]: Math.round((len(l.plates) + len(l.studs) + len(l.flats)) * 10) / 10 };
  if (l.lintels.length) metres[lintel] = Math.round(len(l.lintels) * 2 * 10) / 10;
  return {
    members: l.plates.length + l.studs.length + l.flats.length + l.lintels.length * 2,
    studs: l.studs.length,
    noggings: l.flats.filter(([id]) => id.startsWith("nog")).length,
    lintels: l.lintels.length * 2,
    metres,
    warnings: l.warnings,
  };
}

/**
 * The wall frame in the part: the plane, the sketch and its members and
 * joints, the linings, in a folder; the part gets copies of MGP10 and LVL if
 * it has none. The commands make the same change, for an editor that keeps
 * its own history.
 */
export function planWallFrame(doc: RawDocument, spec: WallFrameSpec): { ok: true; doc: RawDocument; commands: Command[]; report: WallReport; features: string[] } | { ok: false; error: string } {
  if (!(spec.length >= 300) || !(spec.height >= 600)) return { ok: false, error: "the wall needs a length of 300 or more and a height of 600 or more" };
  const pre = spec.id ?? "wall";
  if (doc.features.some((f) => String(f.id) === pre || String(f.id).startsWith(`${pre}_`))) return { ok: false, error: `the part already has features named ${pre}_…: give the wall another id` };
  const studSize = spec.stud ?? "90x45 MGP10";
  const lintelSize = spec.lintel ?? "240x45 LVL";
  const stud = sizeValues("MGP10", studSize);
  if (!stud) return { ok: false, error: `${studSize} is not an MGP10 size` };
  if (!sizeValues("LVL", lintelSize)) return { ok: false, error: `${lintelSize} is not an LVL size` };
  const lib = standardLibrary();
  const mgp = ensureCopy(doc, lib.find((e) => e.name.split(" (")[0] === "MGP10")!, studSize);
  if (!mgp.ok) return mgp;
  const lvl = ensureCopy(mgp.doc, lib.find((e) => e.name.split(" (")[0] === "LVL")!, lintelSize);
  if (!lvl.ok) return lvl;
  let next = lvl.doc;
  const lines = wallLines(spec);
  const report = wallNumbers(spec);
  // A vertical plane through the base line: its x along the wall, y up; the outside on the -normal side.
  const rad = (spec.direction * Math.PI) / 180;
  const o = spec.origin;
  const q = (x: number) => Math.round(x * 1e9) / 1e9 + 0;
  const xDir: Vec3 = [q(Math.cos(rad)), q(Math.sin(rad)), 0];
  // Written out (no plane feature to rebuild first): x along the wall, the normal (x cross up) to the outside.
  const planeSpec = { type: "datum", origin: o, normal: [q(Math.sin(rad)), q(-Math.cos(rad)), 0], xDir };
  const sketch = `${pre}_frame`;
  const step = (cmd: Command): string | null => {
    const r = apply(next, cmd);
    if (!r.ok) return r.error;
    next = r.doc;
    return null;
  };
  const all = [...lines.plates, ...lines.lintels, ...lines.studs, ...lines.flats];
  for (const cmd of [
    { type: "addFeature", feature: { id: sketch, op: "sketch", plane: planeSpec, entities: all.map(([id, a, b]) => ({ id, type: "line", start: a, end: b })) } },
  ] as Command[]) {
    const e = step(cmd);
    if (e) return { ok: false, error: e };
  }
  // The members, a group at a time (as a framer would pick them): plates, lintels (doubled), studs, then the flats between them.
  const pick = (ls: Ln[], named = true): SketchLine[] => ls.map(([entity]) => ({ sketch, entity, ...(named ? { id: `${pre}_${entity}` } : {}) }));
  const groups: [SketchLine[], Record<string, unknown>][] = [
    [pick(lines.plates), { profile: mgp.name, size: studSize, rotation: 90, corners: "none" }],
    [pick(lines.lintels).map((l) => ({ ...l, id: `${l.id}_a` })), { profile: lvl.name, size: lintelSize, align: [1, 0], runThrough: "posts" }],
    [pick(lines.lintels).map((l) => ({ ...l, id: `${l.id}_b` })), { profile: lvl.name, size: lintelSize, align: [-1, 0], runThrough: "posts" }],
    // A vertical member's section is set square to world Y: turned with the wall, its depth goes across it.
    [pick(lines.studs), { profile: mgp.name, size: studSize, runThrough: "rails", ...(spec.direction % 360 ? { rotation: spec.direction } : {}) }],
    [pick(lines.flats), { profile: mgp.name, size: studSize, rotation: 90, runThrough: "posts" }],
  ];
  for (const [ls, opts] of groups) {
    if (!ls.length) continue;
    const r = addSketchMembers(next, { line: "centre", corners: "butt", folder: false, lines: ls, ...opts } as never);
    if (!r.ok) return { ok: false, error: r.error };
    next = r.doc;
  }
  // The linings: the outline notched at the doors, the windows cut out.
  const lining = spec.lining ?? (spec.loadBearing === false ? "both" : "inside");
  if (lining !== "none") {
    const poly: Pt[] = [[0, 0]];
    for (const d of [...spec.openings].filter((x) => x.sill === undefined).sort((a, b) => a.x0 - b.x0)) poly.push([d.x0, 0], [d.x0, d.head], [d.x1, d.head], [d.x1, 0]);
    poly.push([spec.length, 0], [spec.length, spec.height], [0, spec.height]);
    const ents: Record<string, unknown>[] = poly.map((p, i) => ({ id: `ol${i}`, type: "line", start: p, end: poly[(i + 1) % poly.length] }));
    spec.openings.forEach((w, i) => {
      if (w.sill !== undefined) ents.push({ id: `op${i}`, type: "rect", center: [r1((w.x0 + w.x1) / 2), r1((w.sill + w.head) / 2)], w: r1(w.x1 - w.x0), h: r1(w.head - w.sill) });
    });
    const inside: Pt = [spec.openings.some((w) => w.sill === undefined && w.x0 < 10) ? spec.length - 5 : 5, spec.height - 5];
    const half = stud.d / 2;
    // The inside is the plane's normal turned round (the outside is on the right of the way the wall runs).
    const cmds: Command[] = [
      { type: "addFeature", feature: { id: `${pre}_lining_sk`, op: "sketch", plane: planeSpec, entities: ents } } as Command,
      { type: "addFeature", feature: { id: `${pre}_lining_in`, op: "extrude", sketch: `${pre}_lining_sk`, distance: 10, startOffset: -half, direction: insideOf(rad), newBody: `${pre}_lining_in`, regions: [inside] } } as Command,
    ];
    if (lining === "both") cmds.push({ type: "addFeature", feature: { id: `${pre}_lining_out`, op: "extrude", sketch: `${pre}_lining_sk`, distance: 10, startOffset: half, newBody: `${pre}_lining_out`, regions: [inside] } } as Command);
    for (const c of cmds) {
      const e = step(c);
      if (e) return { ok: false, error: e };
    }
  }
  const before = new Set(doc.features.map((f) => String(f.id)));
  const ids = next.features.map((f) => String(f.id)).filter((id) => !before.has(id));
  const folderCmd = { type: "setFolder", id: `${pre}_folder`, folder: { name: `Wall frame ${pre}`, features: ids } } as Command;
  const e = step(folderCmd);
  if (e) return { ok: false, error: e };
  return { ok: true, doc: next, commands: commandsBetween(doc, next), report, features: ids };
}

/** The way into the wall's inside: the plane's normal (way x up) turned round. */
function insideOf(rad: number): Vec3 {
  const q = (x: number) => Math.round(x * 1e9) / 1e9 + 0;
  return [q(-Math.sin(rad)), q(Math.cos(rad)), 0];
}

/** An additive change as commands: profiles set, nodes set, features added in order, folders set. */
export function commandsBetween(before: RawDocument, after: RawDocument): Command[] {
  const out: Command[] = [];
  const bp = (before.profiles ?? {}) as Record<string, unknown>;
  for (const [name, p] of Object.entries((after.profiles ?? {}) as Record<string, unknown>)) if (JSON.stringify(bp[name]) !== JSON.stringify(p)) out.push({ type: "setProfile", name, profile: p } as Command);
  const bn = (before.nodes ?? {}) as Record<string, unknown>;
  for (const [name, at] of Object.entries((after.nodes ?? {}) as Record<string, unknown>)) if (JSON.stringify(bn[name]) !== JSON.stringify(at)) out.push({ type: "setNode", name, at } as Command);
  // Features in order, the nodes just before the first member (they follow sketch points, so after the sketches).
  const nodes = out.splice(out.findIndex((c) => c.type === "setNode") >= 0 ? out.findIndex((c) => c.type === "setNode") : out.length);
  const had = new Set(before.features.map((f) => String(f.id)));
  let placed = false;
  for (const f of after.features) {
    if (had.has(String(f.id))) continue;
    if (!placed && f.op === "member") {
      out.push(...nodes);
      placed = true;
    }
    out.push({ type: "addFeature", feature: f } as Command);
  }
  if (!placed) out.push(...nodes);
  const bf = new Map(((before.folders ?? []) as { id: string }[]).map((f) => [f.id, JSON.stringify(f)]));
  for (const f of (after.folders ?? []) as { id: string }[]) if (bf.get(f.id) !== JSON.stringify(f)) {
    const { id, ...folder } = f as { id: string } & Record<string, unknown>;
    out.push({ type: "setFolder", id, folder } as Command);
  }
  return out;
}
