// Copy and paste of features (Phase P): Ctrl+C on features in the tree,
// Ctrl+V puts copies in with fresh ids, as one insertFeatures command (one
// undo step). Pure, on raw JSON.
//
// What is copied: the features picked, each with the sketch it is made from
// when nothing else uses that sketch (a cut and its sketch go together). What
// a paste does with them:
// - onto a face picked in the view: a hole drills that face, a sketch copied
//   with its feature stands on that face (by reference, so it follows it), and
//   an extrude or cut goes along that face's normal (a written-out direction
//   is dropped). The numbers in the sketch are the same, now in the face's frame;
// - anywhere else: in the same place (Duplicate), to move afterwards.
// A copied feature that uses one not copied keeps using the original (a
// pattern pasted alone keeps its seeds); the paste says so.

import { isObject } from "./validate";
import { references } from "./commands";
import type { FaceSelector } from "./types";

type Raw = Record<string, unknown>;

export interface Clip {
  /** The copies' source features, in history order (with the sketches that go with them). */
  features: Raw[];
  /** What was picked to copy (the rest came along). */
  picked: string[];
}

/** The features to copy for these ids: in history order, each with its own sketch. */
export function copyFeatures(doc: { features: Raw[] }, ids: string[]): Clip | string {
  const all = doc.features;
  const want = new Set(ids);
  if (!ids.length) return "nothing to copy: select a feature in the tree";
  for (const id of ids) if (!all.some((f) => f.id === id)) return `no feature "${id}" to copy`;
  for (const f of all) {
    if (!want.has(String(f.id))) continue;
    // Its sketch comes along when only it uses that sketch.
    const own = typeof f.sketch === "string" ? f.sketch : typeof f.points === "string" ? f.points : null;
    if (own && all.filter((g) => references(g).includes(own)).length === 1) want.add(own);
  }
  return { features: structuredClone(all.filter((f) => want.has(String(f.id)))), picked: [...ids] };
}

/** A paste's features and what to tell about it. */
export interface Pasted {
  features: Raw[];
  /** Old id to new id. */
  ids: Map<string, string>;
  notes: string[];
}

/** "hole_3" -> "hole". */
function prefixOf(id: string): string {
  return id.replace(/_\d+$/, "") || "feature";
}

/** Fresh copies of the clip for `doc` (new ids, references among them following), placed on `onto` when given. */
export function pasteFeatures(doc: { features: Raw[] }, clip: Clip, onto?: { face: FaceSelector }): Pasted {
  const used = new Set(doc.features.map((f) => String(f.id)));
  const ids = new Map<string, string>();
  for (const f of clip.features) {
    const p = prefixOf(String(f.id));
    let n = 1;
    while (used.has(`${p}_${n}`)) n++;
    ids.set(String(f.id), `${p}_${n}`);
    used.add(`${p}_${n}`);
  }
  const notes: string[] = [];
  const rename = (v: unknown, inEntities = false): unknown => {
    if (typeof v === "string") {
      if (ids.has(v)) return ids.get(v);
      // An expression reading a copied sketch's dimension reads the copy's.
      if (v.startsWith("=")) return v.replace(/[A-Za-z_][A-Za-z0-9_-]*(?=\.)/g, (m) => ids.get(m) ?? m);
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => rename(x, inEntities));
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "id" && inEntities ? x : rename(x, inEntities || k === "entities" || k === "constraints")]));
    return v;
  };
  const out = clip.features.map((f) => {
    const copy = rename(f) as Raw;
    copy.id = ids.get(String(f.id));
    return copy;
  });
  for (const [i, f] of out.entries()) {
    const src = clip.features[i];
    const kept = references(src).filter((r) => !ids.has(r));
    if (kept.length && src.op !== "sketch") notes.push(`${String(f.id)} uses ${kept.join(", ")} as ${String(src.id)} did${/Pattern$|^mirror$/.test(String(src.op)) ? " (its seeds)" : ""}`);
    if (!onto) continue;
    if (f.op === "hole" && f.points === undefined) f.face = structuredClone(onto.face);
    else if (f.op === "sketch") f.plane = { type: "ref", ref: { face: structuredClone(onto.face) } };
    if ((f.op === "extrude" || f.op === "cut") && f.direction !== undefined) delete f.direction;
  }
  if (onto && !out.some((f) => f.op === "hole" || f.op === "sketch")) notes.push("nothing in it stands on a face, so it is pasted where it was");
  return { features: out, ids, notes };
}
