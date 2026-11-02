// The feature tree's document side (Phase P): folders, the references a
// feature has through the faces and edges it picks (selectors' createdBy),
// and the checks a move in the history must pass. Pure, on raw JSON.
//
// A folder groups features that are next to each other in the history
// (`folders: [{ id, name, features }]` in the document). It changes nothing
// the rebuild does: suppressing a folder suppresses its features. A move
// keeps folders whole: a feature dropped between two of a folder's features
// joins it, one moved away from its folder leaves it, and a folder that loses
// its last feature goes.

import { isObject } from "./validate";
import { parameterRefs } from "./parameters";

export interface Folder {
  id: string;
  name: string;
  /** Its features, in history order: next to each other in the feature list. */
  features: string[];
}

/** The document's folders (well-formed ones; validation reports the rest). */
export function foldersOf(doc: unknown): Folder[] {
  if (!isObject(doc) || !Array.isArray(doc.folders)) return [];
  return doc.folders.filter((f): f is Folder => isObject(f) && typeof f.id === "string" && typeof f.name === "string" && Array.isArray(f.features));
}

/** The folder a feature is in, if any. */
export function folderOf(folders: readonly Folder[], id: string): Folder | undefined {
  return folders.find((f) => f.features.includes(id));
}

/** The first free folder id, folder_1, folder_2, ... (not a feature's id either). */
export function nextFolderId(doc: unknown): string {
  const used = new Set([...foldersOf(doc).map((f) => f.id), ...(isObject(doc) && Array.isArray(doc.features) ? doc.features.map((f) => (isObject(f) ? f.id : undefined)) : [])]);
  for (let n = 1; ; n++) if (!used.has(`folder_${n}`)) return `folder_${n}`;
}

/**
 * The ids of the features whose faces or edges this feature picks by who made
 * them (a selector's createdBy), anywhere in it: it needs them to come before it.
 */
export function provenanceRefs(f: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isObject(v)) {
      if ((v.type === "planar" || v.type === "cylindrical" || v.type === "edge") && typeof v.createdBy === "string") out.add(v.createdBy);
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(f);
  return [...out];
}

/** The sketches whose dimensions a feature's expressions read ("=sketch_1.width" reads sketch_1). */
export function dimensionOwners(f: unknown): string[] {
  return [...new Set([...parameterRefs(f)].filter((n) => n.includes(".")).map((n) => n.slice(0, n.indexOf("."))))];
}

/** Renames a feature id in every selector's createdBy, in place. */
export function renameCreatedBy(features: unknown[], from: string, to: string): void {
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isObject(v)) {
      if ((v.type === "planar" || v.type === "cylindrical" || v.type === "edge") && v.createdBy === from) v.createdBy = to;
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(features);
}

/**
 * What would be wrong in this order that is not wrong now: a feature before
 * a feature it uses (`hard`: the references the document layer knows), before
 * the feature that made the faces or edges it picks, or before a sketch whose
 * dimensions it reads. Null when nothing new is wrong.
 */
export function orderProblems(features: Record<string, unknown>[], hard: (f: Record<string, unknown>) => string[]): string[] {
  const seen = new Set<string>();
  const ids = new Set(features.map((f) => String(f.id)));
  const out: string[] = [];
  for (const f of features) {
    const id = String(f.id);
    for (const ref of hard(f)) if (ids.has(ref) && !seen.has(ref)) out.push(`${id} uses ${ref}, which would come after it`);
    for (const ref of provenanceRefs(f)) if (ids.has(ref) && ref !== id && !seen.has(ref)) out.push(`${id} picks faces or edges ${ref} made, so ${ref} must come before it`);
    for (const ref of dimensionOwners(f)) if (ids.has(ref) && ref !== id && !seen.has(ref)) out.push(`${id} reads ${ref}'s dimensions, so ${ref} must come before it`);
    seen.add(id);
  }
  return out;
}

/** The features with `id` moved to `index` (as reorderFeature moves it). */
export function moved<T extends Record<string, unknown>>(features: T[], id: string, index: number): T[] {
  const list = [...features];
  const i = list.findIndex((f) => f.id === id);
  if (i < 0) return list;
  const [f] = list.splice(i, 1);
  list.splice(index, 0, f);
  return list;
}

/**
 * Why `id` cannot go to `index` (what the move would put before what it
 * needs, or after what needs it), or null when it can: the tree's live check
 * while a feature is dragged.
 */
export function moveProblem(features: Record<string, unknown>[], id: string, index: number, hard: (f: Record<string, unknown>) => string[]): string | null {
  if (index < 0 || index >= features.length) return `there is no place ${index} in the history`;
  const before = new Set(orderProblems(features, hard));
  const after = orderProblems(moved(features, id, index), hard).filter((p) => !before.has(p));
  return after[0] ?? null;
}

/**
 * The folders after `id` moved within `features` (already in their new
 * order). `want`: the folder it should be in (null: none; undefined: decide
 * from where it landed: between two features of a folder it joins it; next to
 * its own folder it stays in it; else it leaves). Returns the folders, or why
 * that cannot be.
 */
export function foldersAfterMove(folders: readonly Folder[], features: Record<string, unknown>[], id: string, want?: string | null): Folder[] | string {
  const order = features.map((f) => String(f.id));
  const at = order.indexOf(id);
  const prev = order[at - 1];
  const next = order[at + 1];
  const own = folderOf(folders, id);
  const holder = (x: string | undefined) => (x === undefined ? undefined : folderOf(folders, x)?.id);
  // Between two features of a folder: in it, whatever was asked.
  const inside = prev !== undefined && next !== undefined && holder(prev) !== undefined && holder(prev) === holder(next) && holder(prev) !== own?.id ? holder(prev) : undefined;
  const ownStill = own && own.features.some((x) => x !== id && (x === prev || x === next));
  let target: string | null;
  if (inside) target = inside;
  else if (want !== undefined) {
    if (want !== null && holder(prev) !== want && holder(next) !== want && !(own?.id === want && ownStill)) {
      const f = folders.find((x) => x.id === want);
      if (!f) return `there is no folder "${want}"`;
      return `${id} is not next to folder "${f.name}" there: drop it beside one of its features`;
    }
    target = want;
  } else target = own && (ownStill || (own.features.length === 1)) ? own.id : null;
  const out: Folder[] = [];
  for (const f of folders) {
    let list = f.features.filter((x) => x !== id);
    if (f.id === target) list = [...list, id];
    list.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    if (list.length) out.push({ ...f, features: list });
  }
  return out;
}

/** Why a folder's features are not a run next to each other in the history (null: they are). */
export function folderGap(f: Folder, order: string[]): string | null {
  const at = f.features.map((x) => order.indexOf(x));
  if (at.some((i) => i < 0)) return `folder "${f.name}": no feature "${f.features[at.findIndex((i) => i < 0)]}"`;
  const sorted = [...at].sort((a, b) => a - b);
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k] !== sorted[k - 1] + 1) return `folder "${f.name}": its features must be next to each other in the history (${order[sorted[k - 1] + 1]} is between them)`;
  }
  return null;
}
