// What a part is for, read from its model (Phase Q wave Q3B): the design
// intent the detailing plan tolerances by. Every reading says why, so the
// plan card and the agent can show it and the user can overrule it.
//
// - Holes from the Hole Wizard: tapped (a thread callout), clearance for a
//   screw (ISO 273 close/normal/loose: a plain size under the general
//   tolerance), counterbored or countersunk clearance; a plain hole named for
//   a dowel or pin, or a small blind plain hole of a whole millimetre size,
//   is a dowel hole (H7, the dowel m6); named for a bearing, a bearing seat
//   (H7, the shaft k6); named for a guide, slide or bush, a sliding fit
//   (H7/g6).
// - Bores that are not holes (a turned or extruded bore, full round): a
//   bearing seat when its diameter is a rolling bearing's outside diameter,
//   else a bore for a shaft; both H7.
// - Patterns: holes copied by a circular or linear pattern, or alike holes of
//   several features, are one pattern (one callout, one position tolerance).
// - The part: a weldment (members), a round part (one axis, round outline),
//   or prismatic; its mounting face is the face the holes go through.

import type { RawDocument } from "../../doc/commands";
import type { Vec3 } from "../../doc/types";
import { validateDocument } from "../../doc/validate";
import { holeSignature } from "../../drafting/autodim";
import { ISO_METRIC } from "../../features/hole/standards";
import type { Measurements } from "../../kernel/measure";
import type { HoleRecord } from "../../kernel/rebuild";
import type { PartTopology } from "../kernel";

export const HOLE_PURPOSES = ["tapped", "clearance", "counterbored", "countersunk", "dowel", "bearing", "sliding", "bore", "plain"] as const;
export type HolePurpose = (typeof HOLE_PURPOSES)[number];

/** One kind of hole (alike holes of the feature and its copies, or of several features). */
export interface HoleIntent {
  /** The hole features (the first is what a callout names). */
  features: string[];
  /** Those and the patterns and mirrors copying them: what made the holes' edges. */
  makers: string[];
  purpose: HolePurpose;
  /** The bore, mm (a tapped hole's thread major diameter). */
  diameter: number;
  /** How many holes, copies included. */
  count: number;
  pattern: "single" | "circular" | "linear" | "group";
  /** The screw it is for ("M6"), or the thread ("M6×1"). */
  size?: string;
  /** The hole's own tolerance class ("H7"), and the fit it makes with what goes in ("H7/m6"). */
  fit?: string;
  pair?: string;
  /** The axis, into the part. */
  axis: Vec3;
  why: string;
}

/** A bore that is not a hole feature: a turned or extruded round hole. */
export interface BoreIntent {
  feature: string;
  diameter: number;
  axis: Vec3;
  centre: Vec3;
  purpose: "bearing" | "bore";
  fit: string;
  pair: string;
  why: string;
}

export interface DesignIntent {
  kind: "weldment" | "round" | "prismatic";
  /** In a word or two: "flange", "plate", "frame". */
  what: string;
  material?: string;
  /** The main axis of a round part. */
  axis?: Vec3;
  holes: HoleIntent[];
  bores: BoreIntent[];
  /** The mounting face's outward normal: the face the holes go into the part from (else the largest flat face). */
  mounting: Vec3 | null;
  /** The size, mm, the plan picks form tolerances by. */
  size: number;
  /** Members, joints and welds of a weldment. */
  members: string[];
  joints: { id: string; node: string; type: string; members: string[] }[];
  welds: string[];
  summary: string;
}

/** Rolling bearings' outside diameters (deep-groove 60, 62, 63, 68, 69 series and 6xx miniatures), mm. */
export const BEARING_ODS = [10, 13, 16, 19, 22, 24, 26, 28, 30, 32, 35, 37, 40, 42, 47, 52, 55, 62, 68, 72, 75, 80, 85, 90, 100, 110, 120, 125, 130, 140, 150, 160];

/** ISO 273 clearance holes (close, normal/medium, loose) for M3–M24. */
export function clearanceFor(diameter: number): { size: string; fit: "close" | "normal" | "loose" } | null {
  for (const s of ISO_METRIC) for (const fit of ["normal", "close", "loose"] as const) if (Math.abs(s.clearance[fit] - diameter) < 1e-6) return { size: s.size, fit };
  return null;
}

const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** The design intent of the part (holes from the rebuild's hole records, bores from its faces). */
export function inferIntent(doc: RawDocument, m: Measurements | null, holes: HoleRecord[], topo: PartTopology | null): DesignIntent {
  const v = validateDocument(doc);
  const feats = v.features.flatMap((f) => (f.feature ? [f.feature as unknown as Record<string, unknown> & { id: string; op: string }] : []));
  const featureById = new Map(feats.map((f) => [f.id, f]));
  const members = (m?.members ?? []).map((x) => x.id);
  const joints = feats.filter((f) => f.op === "joint").map((f) => ({ id: f.id, node: String(f.node ?? ""), type: String(f.type ?? ""), members: Array.isArray(f.members) ? (f.members as string[]) : [] }));
  const material = v.material?.name;
  const size = m?.boundingBox ? Math.max(...m.boundingBox.size) : 100;

  if (members.length) {
    return {
      kind: "weldment",
      what: "welded frame",
      ...(material ? { material } : {}),
      holes: [],
      bores: [],
      mounting: null,
      size,
      members,
      joints,
      welds: v.welds.map((w) => w.id),
      summary: `a welded frame of ${members.length} members (${[...new Set((m?.members ?? []).map((x) => x.designation))].join(", ")}), ${joints.length} joints, ${v.welds.length} welds in the weld table`,
    };
  }

  // Patterns: which hole each pattern copies.
  const patternOf = new Map<string, "circular" | "linear">();
  for (const f of feats) {
    if (f.op !== "circularPattern" && f.op !== "linearPattern" && f.op !== "mirror") continue;
    const seeds = Array.isArray(f.features) ? (f.features as string[]) : typeof f.feature === "string" ? [f.feature] : [];
    for (const s of seeds) patternOf.set(s, f.op === "circularPattern" ? "circular" : "linear");
  }
  const named = (id: string) => `${id} ${String(featureById.get(id)?.name ?? "")}`.toLowerCase();

  // Alike holes together, as the callouts group them.
  const groups = new Map<string, HoleRecord[]>();
  for (const h of holes) groups.set(holeSignature(h), [...(groups.get(holeSignature(h)) ?? []), h]);
  const holeIntents: HoleIntent[] = [];
  for (const list of groups.values()) {
    const h = list[0];
    const count = list.reduce((t, x) => t + x.copies + 1, 0);
    const pattern: HoleIntent["pattern"] = list.length > 1 ? "group" : patternOf.get(h.feature) ?? (count > 1 ? "linear" : "single");
    const name = list.map((x) => named(x.feature)).join(" ");
    const copies = (f: string) => feats.filter((g) => (Array.isArray(g.features) ? (g.features as string[]).includes(f) : g.feature === f)).map((g) => g.id);
    const base = { features: list.map((x) => x.feature), makers: [...new Set(list.flatMap((x) => [x.feature, ...copies(x.feature)]))], diameter: r2(h.thread?.major ?? h.diameter), count, pattern, axis: h.axis };
    const clearance = clearanceFor(h.diameter);
    let intent: HoleIntent;
    if (h.thread) intent = { ...base, purpose: "tapped", size: h.thread.designation, why: `tapped ${h.thread.designation} - ${h.thread.class} from the Hole Wizard: called out as its thread` };
    else if (/dowel|\bpin\b|_pin|pin_/.test(name)) intent = { ...base, purpose: "dowel", fit: "H7", pair: "H7/m6", why: `named for a dowel: a dowel hole H7, the dowel m6 (transition fit H7/m6)` };
    else if (/bearing/.test(name)) intent = { ...base, purpose: "bearing", fit: "H7", pair: "H7/k6", why: "named for a bearing: a bearing seat H7 (the shaft k6)" };
    else if (/guide|slid|bush/.test(name)) intent = { ...base, purpose: "sliding", fit: "H7", pair: "H7/g6", why: "named for a guide: a sliding fit H7/g6" };
    else if (h.counterbore) intent = { ...base, purpose: "counterbored", ...(h.size || clearance ? { size: h.size ?? clearance!.size } : {}), why: `counterbored clearance for ${h.size ?? clearance?.size ?? "a cap screw"} (ISO 273 ${clearance?.fit === "close" ? "fine" : clearance?.fit === "loose" ? "coarse" : "medium"}): a plain size, located by position` };
    else if (h.countersink) intent = { ...base, purpose: "countersunk", ...(h.size || clearance ? { size: h.size ?? clearance!.size } : {}), why: `countersunk clearance for ${h.size ?? clearance?.size ?? "a countersunk screw"}: a plain size, located by position` };
    else if (h.size || clearance) intent = { ...base, purpose: "clearance", size: h.size ?? clearance!.size, why: `clearance for ${h.size ?? clearance!.size} (ISO 273 ${(clearance?.fit ?? "normal") === "normal" ? "medium" : clearance!.fit === "close" ? "fine" : "coarse"} series): a plain size under the general tolerance, located by position` };
    else if (!h.through && Number.isInteger(r2(h.diameter)) && h.diameter <= 16) intent = { ...base, purpose: "dowel", fit: "H7", pair: "H7/m6", why: `a blind plain Ø${r2(h.diameter)} hole, a standard dowel size: H7 for an m6 dowel` };
    else if (BEARING_ODS.some((d) => near(d, h.diameter, 1e-6)) && h.diameter >= 16) intent = { ...base, purpose: "bearing", fit: "H7", pair: "H7/k6", why: `Ø${r2(h.diameter)} is a rolling bearing's outside diameter: a bearing seat H7` };
    else intent = { ...base, purpose: "plain", why: "a plain hole: its size under the general tolerance" };
    holeIntents.push(intent);
  }

  // Bores: full round concave faces no hole feature made, one per axis and size.
  const holeMakers = new Set([...holes.map((h) => h.feature), ...feats.filter((f) => [...patternOf.keys()].some((s) => (Array.isArray(f.features) ? (f.features as string[]).includes(s) : f.feature === s))).map((f) => f.id)]);
  const bores: BoreIntent[] = [];
  for (const f of topo?.faces ?? []) {
    const c = f.cylinder;
    if (f.type !== "cylinder" || !c || !c.concave || c.span < 2 * Math.PI - 0.01) continue;
    const maker = f.createdBy ?? "";
    if (holeMakers.has(maker)) continue;
    const op = featureById.get(maker)?.op;
    if (op === "fillet" || op === "chamfer") continue;
    const d = r2(2 * c.radius);
    if (bores.some((b) => near(b.diameter, d, 0.01) && near(Math.abs(b.axis[0] * c.axis[0] + b.axis[1] * c.axis[1] + b.axis[2] * c.axis[2]), 1, 1e-6))) continue;
    const bearing = BEARING_ODS.some((x) => near(x, d, 1e-6)) || /bearing/.test(named(maker));
    bores.push({
      feature: maker,
      diameter: d,
      axis: c.axis,
      centre: c.origin,
      purpose: bearing ? "bearing" : "bore",
      fit: "H7",
      pair: bearing ? "H7/k6" : "H7/k6",
      why: bearing ? `Ø${d} is a rolling bearing's outside diameter: a bearing seat H7 (the shaft k6)` : `a bore Ø${d} for a shaft: H7 (a k6 shaft locates, g6 slides)`,
    });
  }

  // Round: the outline is round about one axis that a bore or the largest round face shares.
  const bb = m?.boundingBox?.size;
  const convex = (topo?.faces ?? []).filter((f) => f.type === "cylinder" && f.cylinder && !f.cylinder.concave && f.cylinder.span > 2 * Math.PI - 0.01).sort((a, b) => b.cylinder!.radius - a.cylinder!.radius)[0];
  let axis: Vec3 | undefined;
  if (convex && bb) {
    const ax = convex.cylinder!.axis.map(Math.abs);
    const i = ax.indexOf(Math.max(...ax));
    const across = [0, 1, 2].filter((k) => k !== i).map((k) => bb[k]);
    if (across.every((s) => near(s, 2 * convex.cylinder!.radius, 0.02 * s))) axis = convex.cylinder!.axis;
  }
  // The mounting face: where the holes go in from (opposite their axis), else down.
  const into = holeIntents[0]?.axis;
  const mounting: Vec3 | null = into ? [into[0], into[1], into[2]] : [0, 0, -1];
  const kind = axis ? "round" : "prismatic";
  const what = kind === "round" ? (holeIntents.some((h) => h.pattern === "circular") ? "flange" : "turned part") : bb && Math.min(...bb) < 0.25 * Math.max(...bb) ? "plate" : "block";
  const parts = [
    `a ${kind === "round" ? "round" : "prismatic"} ${what}${bb ? ` ${bb.map(r2).join(" × ")} mm` : ""}${material ? `, ${material}` : ""}`,
    ...holeIntents.map((h) => `${h.count}× Ø${h.diameter} ${h.purpose}${h.size ? ` ${h.size}` : ""}${h.pattern !== "single" ? ` (${h.pattern} pattern)` : ""}`),
    ...bores.map((b) => `bore Ø${b.diameter} (${b.purpose})`),
  ];
  return { kind, what, ...(material ? { material } : {}), ...(axis ? { axis } : {}), holes: holeIntents, bores, mounting, size, members: [], joints: [], welds: [], summary: parts.join("; ") };
}
