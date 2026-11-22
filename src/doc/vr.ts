// The VR walkthrough's settings carried in the document: where you start when
// you put the headset on (a point on the floor, model mm, and the way you face,
// degrees counter-clockwise from +X in plan). Pure.

import type { Vec3 } from "./types";

export interface VrStart {
  at: Vec3;
  heading: number;
}
export interface VrSettings {
  start?: VrStart;
}

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);

/** What is wrong with a document's `vr`, as [path, message] pairs (none when it is right). */
export function vrProblems(raw: unknown): [string, string][] {
  const out: [string, string][] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [["vr", "must be an object: { start?: { at: [x, y, z], heading } }"]];
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (k !== "start") out.push(["vr", `unknown field "${k}" (allowed: start)`]);
  if (r.start !== undefined) {
    const s = r.start as Record<string, unknown>;
    if (!s || typeof s !== "object" || Array.isArray(s)) out.push(["vr.start", "must be { at: [x, y, z], heading }"]);
    else {
      for (const k of Object.keys(s)) if (k !== "at" && k !== "heading") out.push(["vr.start", `unknown field "${k}" (allowed: at, heading)`]);
      if (!Array.isArray(s.at) || s.at.length !== 3 || !s.at.every(num)) out.push(["vr.start.at", "must be a point [x, y, z] (mm): where you stand, on the floor"]);
      if (!num(s.heading)) out.push(["vr.start.heading", "must be degrees counter-clockwise from +X: the way you face"]);
    }
  }
  return out;
}

/** The document's VR start, when it has a valid one. */
export function vrStartOf(doc: unknown): VrStart | null {
  const vr = doc && typeof doc === "object" ? (doc as Record<string, unknown>).vr : undefined;
  if (vr === undefined || vrProblems(vr).length) return null;
  return (vr as VrSettings).start ?? null;
}
