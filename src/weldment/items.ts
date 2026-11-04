// The cut list, version 2 (Phase Q): every body of the part as an item a
// workshop can cut, order and paint from. Members are grouped when they are
// the same piece — same profile and size, material, length within the
// tolerance, the same end cuts with their orientation (src/weldment/endCuts.ts)
// and the same typed text; plates (end caps, gussets, base plates) and other
// bodies are items of their own. Item numbers are kept across rebuilds from
// the numbers last given (doc.cutList.items): an item keeps the number of the
// entry that shares the most members with it.
//
// Pure: reads the rebuild's measurements and the document; the old Phase L
// list (src/weldment/cutlist.ts) stays as it was for old drawings.

import { cutListSettings, DEFAULT_TOLERANCE, type CutListItemEntry, type CutListProps, type CutListSettings } from "../doc/cutListSettings";
import type { ProfileDef } from "../doc/types";
import { validateDocument } from "../doc/validate";
import { sectionAt } from "../geom/section";
import type { BodyMeasurement, Measurements, MemberMeasurement } from "../kernel/measure";
import { cutsText, faceText, memberCuts, sameCuts, type MemberCuts } from "./endCuts";

export type CutItemKind = "member" | "plate" | "body";

export interface CutItem {
  item: number;
  kind: CutItemKind;
  quantity: number;
  /** Member ids for a member item; body names for plates and other bodies. In part order. */
  members: string[];
  /** The bodies on the item (a member's body may be named apart from it). */
  bodies: string[];
  /** What the list shows: the typed description, else `autoDescription`. */
  description: string;
  /** "SHS 40x40x3", "End cap PL 3", "Gusset PL 6", "Base plate PL 10". */
  autoDescription: string;
  /** The profile family ("SHS"), "PL" for a plate, the body's name for another body. */
  profile: string;
  /** The standard the section is from ("AS/NZS 1163"), when its family names one. */
  standard: string;
  /** "SHS 40x40x3", "PL 6", or the body's size for another body ("120 × 80 × 40"). */
  designation: string;
  /** "steel AS/NZS 1163" and its grade "C350L0", read from the material's name. */
  material: string;
  grade: string;
  /** mm. A member: its cut length, long point to long point (the mean of its members, to 0.1). A plate: its laid-flat length. */
  length: number;
  /** A plate's laid-flat width and thickness, mm; another body's two other sizes. */
  width?: number;
  thickness?: number;
  /** A member's end cuts, with their orientation. */
  cuts?: MemberCuts;
  /** "45° / 45°, same plane (trapezoid)"; a plate: its holes ("2 holes"). */
  endsText: string;
  /** Where each end's angle is seen: "on 40 face". */
  faces: [string, string];
  /** kg. */
  massEach: number;
  massTotal: number;
  /** The whole surface, mm², each and for all: what is painted. */
  areaEach: number;
  areaTotal: number;
  /** A plate's plan area each, mm² (the outline less its holes). */
  plateArea?: number;
  finish: string;
  weldPrep: string;
  group: string;
  notes: string;
  /** Custom properties, the item's and its members' together. */
  properties: Record<string, string>;
}

export interface ProfileTotal {
  designation: string;
  pieces: number;
  /** mm, all pieces. */
  length: number;
  massKg: number;
}

export interface PlateTotal {
  thickness: number;
  material: string;
  pieces: number;
  /** mm², plan area of all pieces. */
  area: number;
  massKg: number;
}

export interface CutListResult {
  items: CutItem[];
  totals: {
    quantity: number;
    massKg: number;
    /** m², every item's surface. */
    paintArea: number;
    byProfile: ProfileTotal[];
    plates: PlateTotal[];
  };
  /** Every custom property name used, for columns. */
  propertyNames: string[];
  settings: CutListSettings;
}

export interface CutListInput {
  measurements: Pick<Measurements, "members" | "bodies"> | null;
  profiles: Record<string, ProfileDef>;
  settings: CutListSettings;
  /** The part's finish (its properties), the default for every item. */
  finish?: string;
  /** What made each non-member body, by body name: "endCap", "gusset", ... (for the description). */
  sources?: Record<string, string>;
}

const tenth = (x: number) => Math.round(x * 10) / 10 + 0;

/** The cut list of a raw document and its rebuild's measurements. */
export function cutListOf(doc: unknown, measurements: Pick<Measurements, "members" | "bodies"> | null): CutListResult {
  const v = validateDocument(doc);
  const sources: Record<string, string> = {};
  for (const f of v.features) {
    const x = f.feature as { id?: string; op?: string; newBody?: string } | null;
    if (!x?.op || !x.id) continue;
    sources[x.newBody ?? x.id] ??= x.op;
  }
  return cutListItems({ measurements, profiles: v.profiles, settings: v.cutList ?? cutListSettings(doc), finish: v.properties.finish, sources });
}

interface Group {
  kind: CutItemKind;
  key: string;
  members: string[];
  bodies: string[];
  lengths: number[];
  masses: number[];
  areas: number[];
  cuts?: MemberCuts;
  symmetry?: MemberMeasurement["symmetry"];
  first: MemberMeasurement | null;
  body: BodyMeasurement | null;
  memberProps: CutListProps;
}

export function cutListItems(input: CutListInput): CutListResult {
  const { measurements: m, settings } = input;
  const tol = settings.tolerance ?? DEFAULT_TOLERANCE;
  const memberText = settings.members ?? {};
  const bodyOf = new Map((m?.bodies ?? []).map((b) => [b.name, b]));
  const groups: Group[] = [];
  const memberBodies = new Set<string>();
  // Members: alike pieces are one group.
  for (const mm of m?.members ?? []) {
    memberBodies.add(mm.body);
    const body = bodyOf.get(mm.body) ?? null;
    const props = memberText[mm.id] ?? (mm.body !== mm.id ? memberText[mm.body] : undefined) ?? {};
    const cuts = memberCuts(mm);
    const key = JSON.stringify([mm.profile, mm.designation, body?.material ?? "", props]);
    const same = groups.find((g) => g.kind === "member" && g.key === key && Math.abs(g.lengths[0] - mm.length) <= tol + 1e-9 && sameCuts(g.cuts!, cuts, mm.symmetry));
    if (same) {
      same.members.push(mm.id);
      same.bodies.push(mm.body);
      same.lengths.push(mm.length);
      same.masses.push(mm.massKg);
      same.areas.push(mm.area ?? body?.area ?? 0);
    } else
      groups.push({ kind: "member", key, members: [mm.id], bodies: [mm.body], lengths: [mm.length], masses: [mm.massKg], areas: [mm.area ?? body?.area ?? 0], cuts, symmetry: mm.symmetry, first: mm, body, memberProps: props });
  }
  // Plates and other bodies.
  for (const b of m?.bodies ?? []) {
    if (memberBodies.has(b.name)) continue;
    const props = memberText[b.name] ?? {};
    const kind: CutItemKind = b.plate ? "plate" : "body";
    const size = b.plate ? [...b.plate.size].sort((x, y) => y - x) : [...(b.boundingBox?.size ?? [0, 0, 0])].sort((x, y) => y - x);
    const key = JSON.stringify(
      b.plate
        ? ["plate", tenth(b.plate.thickness), size.map(tenth), Math.round(b.plate.area), b.plate.holes, b.material, input.sources?.[b.name] ?? "", props]
        : ["body", size.map(tenth), Math.round(b.volume), b.material, props],
    );
    const same = groups.find((g) => g.key === key);
    if (same) {
      same.members.push(b.name);
      same.bodies.push(b.name);
      same.masses.push(b.massKg);
      same.areas.push(b.area ?? 0);
      same.lengths.push(size[0]);
    } else groups.push({ kind, key, members: [b.name], bodies: [b.name], lengths: [size[0]], masses: [b.massKg], areas: [b.area ?? 0], first: null, body: b, memberProps: props });
  }
  // The default order: members by size and length, then plates thickest first, then other bodies.
  const order = groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => {
      const k = KIND_ORDER[a.g.kind] - KIND_ORDER[b.g.kind];
      if (k) return k;
      if (a.g.kind === "member") {
        const d = a.g.first!.designation.localeCompare(b.g.first!.designation, undefined, { numeric: true });
        return d || mean(b.g.lengths) - mean(a.g.lengths) || (b.g.cuts?.ends[0].angle ?? 0) - (a.g.cuts?.ends[0].angle ?? 0) || a.i - b.i;
      }
      if (a.g.kind === "plate") return b.g.body!.plate!.thickness - a.g.body!.plate!.thickness || b.g.body!.plate!.area - a.g.body!.plate!.area || a.i - b.i;
      return a.i - b.i;
    })
    .map((x) => x.g);
  const numbers = numberGroups(order, settings.items ?? []);
  const items = order.map((g) => toItem(g, numbers.get(g)!, input)).sort((a, b) => a.item - b.item);
  return { items, totals: totalsOf(items), propertyNames: [...new Set(items.flatMap((i) => Object.keys(i.properties)))], settings };
}

const KIND_ORDER: Record<CutItemKind, number> = { member: 0, plate: 1, body: 2 };

/**
 * Item numbers: each group takes the number of the kept entry that shares the
 * most of its members (each entry once, the biggest overlaps first); the rest
 * take new numbers after every kept one, in the default order.
 */
function numberGroups(groups: Group[], entries: CutListItemEntry[]): Map<Group, { n: number; entry?: CutListItemEntry }> {
  const out = new Map<Group, { n: number; entry?: CutListItemEntry }>();
  const pairs: { g: Group; e: CutListItemEntry; overlap: number; gi: number }[] = [];
  groups.forEach((g, gi) => {
    const mine = new Set(g.members);
    for (const e of entries) {
      const overlap = e.members.filter((x) => mine.has(x)).length;
      if (overlap) pairs.push({ g, e, overlap, gi });
    }
  });
  pairs.sort((a, b) => b.overlap - a.overlap || a.e.item - b.e.item || a.gi - b.gi);
  const usedEntries = new Set<CutListItemEntry>();
  for (const p of pairs) {
    if (out.has(p.g) || usedEntries.has(p.e)) continue;
    out.set(p.g, { n: p.e.item, entry: p.e });
    usedEntries.add(p.e);
  }
  let next = Math.max(0, ...entries.map((e) => e.item)) + 1;
  for (const g of groups) if (!out.has(g)) out.set(g, { n: next++ });
  return out;
}

function toItem(g: Group, numbered: { n: number; entry?: CutListItemEntry }, input: CutListInput): CutItem {
  const e = numbered.entry;
  const typed: CutListProps = { ...(e ?? {}), ...g.memberProps, properties: { ...(e?.properties ?? {}), ...(g.memberProps.properties ?? {}) } };
  const quantity = g.members.length;
  const massTotal = sum(g.masses);
  const areaTotal = sum(g.areas);
  const materialName = g.body?.material ?? "";
  const { material, grade } = splitGrade(materialName);
  const base = {
    item: numbered.n,
    kind: g.kind,
    quantity,
    members: g.members,
    bodies: g.bodies,
    material,
    grade,
    massEach: massTotal / quantity,
    massTotal,
    areaEach: areaTotal / quantity,
    areaTotal,
    finish: typed.finish ?? input.finish ?? "",
    weldPrep: typed.weldPrep ?? "",
    group: typed.group ?? "",
    notes: typed.notes ?? "",
    properties: typed.properties ?? {},
  };
  if (g.kind === "member") {
    const mm = g.first!;
    const def = input.profiles[mm.profile];
    const { family, standard } = splitStandard(def?.name ?? mm.profile);
    const envelope = def ? envelopeOf(def, mm.designation) : undefined;
    const auto = mm.designation;
    return {
      ...base,
      description: typed.description ?? auto,
      autoDescription: auto,
      profile: family,
      standard,
      designation: mm.designation,
      // A profile's own material note, where the body takes the part's: "steel AS/NZS 1163-C350L0".
      ...(def?.material && !materialName ? splitGrade(def.material) : {}),
      length: tenth(mean(g.lengths)),
      cuts: g.cuts,
      endsText: cutsText(g.cuts!),
      faces: [faceText(g.cuts!.ends[0], envelope), faceText(g.cuts!.ends[1], envelope)],
    };
  }
  const b = g.body!;
  if (g.kind === "plate") {
    const p = b.plate!;
    const [l, w] = [...p.size].sort((x, y) => y - x);
    const what = PLATE_NAMES[input.sources?.[b.name] ?? ""] ?? "Plate";
    const designation = `PL ${tenth(p.thickness)}`;
    const auto = `${what} ${designation} × ${tenth(w)} × ${tenth(l)}`;
    return {
      ...base,
      description: typed.description ?? auto,
      autoDescription: auto,
      profile: "PL",
      standard: "",
      designation,
      length: tenth(l),
      width: tenth(w),
      thickness: tenth(p.thickness),
      endsText: p.holes ? `${p.holes} hole${p.holes === 1 ? "" : "s"}` : "",
      faces: ["", ""],
      plateArea: p.area,
    };
  }
  const size = [...(b.boundingBox?.size ?? [0, 0, 0])].sort((x, y) => y - x);
  return {
    ...base,
    description: typed.description ?? b.name,
    autoDescription: b.name,
    profile: b.name,
    standard: "",
    designation: size.map((x) => tenth(x)).join(" × "),
    length: tenth(size[0]),
    width: tenth(size[1]),
    thickness: tenth(size[2]),
    endsText: "",
    faces: ["", ""],
  };
}

const PLATE_NAMES: Record<string, string> = { endCap: "End cap", gusset: "Gusset", extrude: "Plate", import: "Plate" };

function totalsOf(items: CutItem[]): CutListResult["totals"] {
  const byProfile = new Map<string, ProfileTotal>();
  const plates = new Map<string, PlateTotal>();
  for (const i of items) {
    if (i.kind === "member") {
      const t = byProfile.get(i.designation) ?? { designation: i.designation, pieces: 0, length: 0, massKg: 0 };
      t.pieces += i.quantity;
      t.length += i.length * i.quantity;
      t.massKg += i.massTotal;
      byProfile.set(i.designation, t);
    } else if (i.kind === "plate") {
      const key = `${i.thickness}|${i.material}`;
      const t = plates.get(key) ?? { thickness: i.thickness!, material: i.material, pieces: 0, area: 0, massKg: 0 };
      t.pieces += i.quantity;
      t.area += (i.plateArea ?? 0) * i.quantity;
      t.massKg += i.massTotal;
      plates.set(key, t);
    }
  }
  return {
    quantity: sum(items.map((i) => i.quantity)),
    massKg: sum(items.map((i) => i.massTotal)),
    paintArea: sum(items.map((i) => i.areaTotal)) / 1e6,
    byProfile: [...byProfile.values()].sort((a, b) => a.designation.localeCompare(b.designation, undefined, { numeric: true })),
    plates: [...plates.values()].sort((a, b) => b.thickness - a.thickness),
  };
}

/** "SHS (AS/NZS 1163)" → SHS from AS/NZS 1163. */
export function splitStandard(name: string): { family: string; standard: string } {
  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(name);
  return m ? { family: m[1], standard: m[2] } : { family: name, standard: "" };
}

/** "steel AS/NZS 1163-C350L0" → steel AS/NZS 1163, grade C350L0. A name without a "-grade" is all material. */
export function splitGrade(name: string): { material: string; grade: string } {
  const m = /^(.*\S)-([A-Za-z]?\d[\w.]*)$/.exec(name.trim());
  return m ? { material: m[1], grade: m[2] } : { material: name, grade: "" };
}

function envelopeOf(def: ProfileDef, designation: string): [number, number] | undefined {
  try {
    const r = sectionAt(def, designation);
    return r.ok ? r.props.envelope : undefined;
  } catch {
    return undefined;
  }
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
function mean(xs: number[]): number {
  return xs.length ? sum(xs) / xs.length : 0;
}

/**
 * The item number a body or member is on: what a balloon shows. Null when
 * the cut list has neither (a body the rebuild did not make).
 */
export function itemNumberFor(list: CutListResult, bodyOrMember: string): number | null {
  for (const i of list.items) if (i.members.includes(bodyOrMember) || i.bodies.includes(bodyOrMember)) return i.item;
  return null;
}

/** The item a body or member is on. */
export function itemFor(list: CutListResult, bodyOrMember: string): CutItem | null {
  return list.items.find((i) => i.members.includes(bodyOrMember) || i.bodies.includes(bodyOrMember)) ?? null;
}

/**
 * The item numbers as they are now, kept: every item with its members and
 * its typed text. What the panel writes when a person edits an item (or
 * presses Keep numbering), so later rebuilds keep the numbers.
 */
export function keptNumbering(list: CutListResult): CutListItemEntry[] {
  const kept = new Map((list.settings.items ?? []).map((e) => [e.item, e]));
  return list.items.map((i) => {
    const e = kept.get(i.item);
    const props: CutListProps = {};
    if (e) for (const k of ["description", "finish", "notes", "weldPrep", "group", "properties"] as const) if (e[k] !== undefined) (props as Record<string, unknown>)[k] = e[k];
    return { item: i.item, members: [...i.members], ...props };
  });
}

/**
 * The `setCutList` patch that sets an item's text (merged; "" or null
 * removes a field; `properties` merged by name, "" or null removes one) and
 * keeps every item's number. Null when there is no such item.
 */
export function itemTextPatch(list: CutListResult, item: number, text: Record<string, unknown>): { items: CutListItemEntry[] } | null {
  if (!list.items.some((i) => i.item === item)) return null;
  const items = keptNumbering(list).map((e) => {
    if (e.item !== item) return e;
    const next: Record<string, unknown> = { ...e };
    for (const [k, v] of Object.entries(text)) {
      if (k === "properties" && v && typeof v === "object") {
        const props: Record<string, string> = { ...(e.properties ?? {}) };
        for (const [name, x] of Object.entries(v as Record<string, unknown>)) {
          if (x === null || x === undefined || (typeof x === "string" && !x.trim())) delete props[name];
          else props[name] = String(x);
        }
        if (Object.keys(props).length) next.properties = props;
        else delete next.properties;
      } else if (v === null || v === undefined || (typeof v === "string" && !v.trim())) delete next[k];
      else next[k] = v;
    }
    return next as unknown as CutListItemEntry;
  });
  return { items };
}

/** The `setCutList` patch that numbers the items afresh in the default order, keeping each item's text. */
export function renumberPatch(list: CutListResult): { items: CutListItemEntry[] } {
  // The default order is the order the items would have with nothing kept.
  const byKind = [...list.items].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || defaultCompare(a, b));
  const kept = keptNumbering(list);
  const textOf = new Map(kept.map((e) => [e.item, e]));
  return {
    items: byKind.map((i, k) => {
      const e = textOf.get(i.item)!;
      return { ...e, item: k + 1 };
    }),
  };
}

function defaultCompare(a: CutItem, b: CutItem): number {
  if (a.kind === "member") return a.designation.localeCompare(b.designation, undefined, { numeric: true }) || b.length - a.length || (b.cuts?.ends[0].angle ?? 0) - (a.cuts?.ends[0].angle ?? 0);
  if (a.kind === "plate") return (b.thickness ?? 0) - (a.thickness ?? 0) || (b.plateArea ?? 0) - (a.plateArea ?? 0);
  return 0;
}
