// The VR walkthrough's part of the document: where you start when you put the
// headset on, the pins dropped in VR (notes on the design: "too tight here"),
// and the furniture moved in VR, kept as proposals until someone at a desk
// accepts one (it becomes a Move feature of the part that holds the body) or
// rejects it. Points are model mm, Z up; headings and turns degrees
// counter-clockwise in plan. Pure.

import { placementOf, pointFrom, apply, transpose, fromEuler, mul, written } from "../assembly/transform";
import { isMeshPart } from "../mesh/meshPart";
import type { Vec3 } from "./types";

export interface VrStart {
  at: Vec3;
  /** The way you face, degrees counter-clockwise from +X. */
  heading: number;
}

export const PIN_TAGS = ["note", "tight", "move", "like", "check"] as const;
export type PinTag = (typeof PIN_TAGS)[number];
export const PIN_WORDS: Record<PinTag, string> = { note: "Note", tight: "Too tight", move: "Move this", like: "Love this", check: "Check this" };
export const PIN_COLORS: Record<PinTag, number> = { note: 0x1f6feb, tight: 0xe5484d, move: 0xf5a524, like: 0x30a46c, check: 0x8e4ec6 };

export interface VrPin {
  id: string;
  at: Vec3;
  tag: PinTag;
  text?: string;
  /** When it was dropped (ISO date). */
  made?: string;
}

/** A body moved in VR: which one (in an assembly, the component it is in and its own name on its part), how far, how much turned about its middle. */
export interface VrMove {
  id: string;
  body: string;
  component?: string;
  move: Vec3;
  turn?: number;
  /** Its middle before the move (model mm): what it turns about. */
  centre: Vec3;
  made?: string;
}

/** A body's name as people say it: "sofa_367" → "sofa", "table_dining_57" → "table dining". */
export function niceName(body: string): string {
  return body.replace(/_\d+$/, "").replace(/[_-]+/g, " ").trim() || body;
}

export interface VrSettings {
  start?: VrStart;
  pins?: VrPin[];
  moves?: VrMove[];
}

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const vec = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(num);
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** What is wrong with a document's `vr`, as [path, message] pairs (none when it is right). */
export function vrProblems(raw: unknown): [string, string][] {
  const out: [string, string][] = [];
  if (!obj(raw)) return [["vr", "must be an object: { start?, pins?, moves? }"]];
  for (const k of Object.keys(raw)) if (!["start", "pins", "moves"].includes(k)) out.push(["vr", `unknown field "${k}" (allowed: start, pins, moves)`]);
  const keys = (o: Record<string, unknown>, path: string, allowed: string[]) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) out.push([path, `unknown field "${k}" (allowed: ${allowed.join(", ")})`]);
  };
  if (raw.start !== undefined) {
    const s = raw.start;
    if (!obj(s)) out.push(["vr.start", "must be { at: [x, y, z], heading }"]);
    else {
      keys(s, "vr.start", ["at", "heading"]);
      if (!vec(s.at)) out.push(["vr.start.at", "must be a point [x, y, z] (mm): where you stand, on the floor"]);
      if (!num(s.heading)) out.push(["vr.start.heading", "must be degrees counter-clockwise from +X: the way you face"]);
    }
  }
  const ids = new Set<string>();
  const list = (key: "pins" | "moves", check: (o: Record<string, unknown>, path: string) => void) => {
    const v = raw[key];
    if (v === undefined) return;
    if (!Array.isArray(v)) return void out.push([`vr.${key}`, "must be a list"]);
    v.forEach((o, i) => {
      const path = `vr.${key}[${i}]`;
      if (!obj(o)) return void out.push([path, "must be an object"]);
      if (typeof o.id !== "string" || !o.id) out.push([`${path}.id`, "must be a name"]);
      else if (ids.has(o.id)) out.push([`${path}.id`, `"${o.id}" is used twice`]);
      else ids.add(o.id);
      if (o.made !== undefined && typeof o.made !== "string") out.push([`${path}.made`, "must be a date"]);
      check(o, path);
    });
  };
  list("pins", (o, path) => {
    keys(o, path, ["id", "at", "tag", "text", "made"]);
    if (!vec(o.at)) out.push([`${path}.at`, "must be a point [x, y, z] (mm)"]);
    if (!PIN_TAGS.includes(o.tag as PinTag)) out.push([`${path}.tag`, `must be ${PIN_TAGS.map((t) => `"${t}"`).join(", ")}`]);
    if (o.text !== undefined && (typeof o.text !== "string" || o.text.length > 500)) out.push([`${path}.text`, "must be text, at most 500 characters"]);
  });
  list("moves", (o, path) => {
    keys(o, path, ["id", "body", "component", "move", "turn", "centre", "made"]);
    if (typeof o.body !== "string" || !o.body) out.push([`${path}.body`, "must name the body moved"]);
    if (o.component !== undefined && typeof o.component !== "string") out.push([`${path}.component`, "must name the component it is in"]);
    if (!vec(o.move)) out.push([`${path}.move`, "must be how far it moved [x, y, z] (mm)"]);
    if (!vec(o.centre)) out.push([`${path}.centre`, "must be its middle before the move [x, y, z] (mm)"]);
    if (o.turn !== undefined && !num(o.turn)) out.push([`${path}.turn`, "must be degrees"]);
  });
  return out;
}

const vrOf = (doc: unknown): VrSettings | null => {
  const vr = obj(doc) ? doc.vr : undefined;
  return vr === undefined || vrProblems(vr).length ? null : (vr as VrSettings);
};

/** The document's VR start, when it has a valid one. */
export function vrStartOf(doc: unknown): VrStart | null {
  return vrOf(doc)?.start ?? null;
}
/** The document's VR pins and moves (none when it has none, or they are not valid). */
export function vrNotesOf(doc: unknown): { pins: VrPin[]; moves: VrMove[] } {
  const vr = vrOf(doc);
  return { pins: vr?.pins ?? [], moves: vr?.moves ?? [] };
}

/** The `vr` settings with pins and moves added (a move of a body already moved replaces that one, its moves summed). */
export function withNotes(vr: VrSettings | undefined, pins: VrPin[], moves: VrMove[]): VrSettings {
  const next: VrSettings = { ...(vr ?? {}) };
  if (pins.length) next.pins = [...(vr?.pins ?? []), ...pins];
  if (moves.length) {
    const all = [...(vr?.moves ?? [])];
    for (const m of moves) {
      const i = all.findIndex((x) => x.body === m.body && x.component === m.component);
      if (i >= 0) {
        const was = all[i];
        all[i] = { ...was, move: [was.move[0] + m.move[0], was.move[1] + m.move[1], was.move[2] + m.move[2]], turn: (was.turn ?? 0) + (m.turn ?? 0), made: m.made ?? was.made };
        if (!all[i].turn) delete all[i].turn;
      } else all.push(m);
    }
    next.moves = all;
  }
  return next;
}

type Doc = Record<string, unknown>;
const freeId = (features: unknown[], base: string) => {
  const used = new Set(features.map((f) => (obj(f) ? String(f.id) : "")));
  let n = 1;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
};
const round = (v: Vec3): Vec3 => v.map((x) => Math.round(x * 100) / 100 + 0) as Vec3;

/**
 * A move accepted: the document with a Move feature for it (on the part that holds the body: this one, or the
 * component's part, in the part's own coordinates) and the proposal gone; a note when the part is used more than
 * once (every copy moves); or what is wrong.
 */
export function acceptMove(doc: Doc, id: string): { doc: Doc; note?: string } | { error: string } {
  const vr = vrOf(doc);
  const m = vr?.moves?.find((x) => x.id === id);
  if (!vr || !m) return { error: `no VR move "${id}"` };
  let move = m.move;
  let centre = m.centre;
  let axis: Vec3 = [0, 0, 1];
  let note: string | undefined;
  let target: Doc = doc;
  let partKey: string | null = null;
  if (m.component) {
    const asm = obj(doc.assembly) ? doc.assembly : null;
    const comps = asm && Array.isArray(asm.components) ? (asm.components as Doc[]) : [];
    const k = comps.find((c) => c.id === m.component);
    if (!k) return { error: `the component ${m.component} is not in the assembly any more` };
    const P = placementOf(k as { at?: Vec3; rotation?: Vec3 });
    // A mesh part (a .glb model) has no features to move: the component itself goes where it was put, turned about
    // the vertical through its middle.
    const parts0 = obj(asm!.parts) ? (asm!.parts as Record<string, Doc>) : {};
    if (k.part !== "self" && isMeshPart(parts0[String(k.part)])) {
      const R = m.turn ? fromEuler([0, 0, m.turn]) : fromEuler([0, 0, 0]);
      const c = m.centre;
      const off = apply(R, [P.t[0] - c[0], P.t[1] - c[1], P.t[2] - c[2]]);
      const w = written({ R: mul(R, P.R), t: [c[0] + off[0] + m.move[0], c[1] + off[1] + m.move[1], c[2] + off[2] + m.move[2]] });
      const placed = { ...k, at: round(w.at), rotation: w.rotation.map((v) => Math.round(v * 100) / 100) as Vec3 };
      const rest = (vr.moves ?? []).filter((x) => x.id !== id);
      const nextVr: VrSettings = { ...vr, ...(rest.length ? { moves: rest } : {}) };
      if (!rest.length) delete nextVr.moves;
      const out: Doc = { ...doc, assembly: { ...asm!, components: comps.map((x) => (x.id === k.id ? placed : x)) } };
      return { doc: Object.keys(nextVr).length ? { ...out, vr: nextVr } : (({ vr: _drop, ...r }) => r)(out) };
    }
    const back = transpose(P.R);
    move = apply(back, m.move);
    axis = apply(back, [0, 0, 1]);
    centre = pointFrom(P, m.centre);
    partKey = String(k.part);
    if (partKey !== "self") {
      const parts = obj(asm!.parts) ? (asm!.parts as Record<string, Doc>) : {};
      if (!parts[partKey]) return { error: `the part ${partKey} is not in the file` };
      target = parts[partKey];
    }
    const uses = comps.filter((c) => c.part === k.part).length;
    if (uses > 1) note = `${partKey} is used ${uses} times: every copy of ${m.body} moves`;
  }
  const features = Array.isArray(target.features) ? (target.features as unknown[]) : [];
  const feature: Doc = {
    id: freeId(features, "vr_move"),
    op: "move",
    bodies: [m.body],
    translate: round(move),
    ...(m.turn ? { rotate: { axis: { origin: round(centre), direction: round(axis) }, angle: Math.round(m.turn * 100) / 100 } } : {}),
  };
  const moved = { ...target, features: [...features, feature] };
  const rest = (vr.moves ?? []).filter((x) => x.id !== id);
  const nextVr: VrSettings = { ...vr, ...(rest.length ? { moves: rest } : {}) };
  if (!rest.length) delete nextVr.moves;
  let out: Doc;
  if (partKey && partKey !== "self") {
    const asm = doc.assembly as Doc;
    out = { ...doc, assembly: { ...asm, parts: { ...(asm.parts as Doc), [partKey]: moved } } };
  } else out = moved;
  return { doc: Object.keys(nextVr).length ? { ...out, vr: nextVr } : (({ vr: _drop, ...r }) => r)(out), ...(note ? { note } : {}) };
}
