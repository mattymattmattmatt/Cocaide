// The rollback bar: a place in the feature list the part is shown up to.
//
// It is stored in the part, as CAD users expect (save a part rolled back and
// it opens rolled back; undo puts the bar back where it was; an agent sees
// it): a top-level "rollback": "<feature id>" names the first feature BELOW
// the bar. That feature and every one after it are not built in the view;
// new features go in at the bar (just above that feature), so the name stays
// right while you add. Deleting that feature moves the bar to the next one
// (or to the end); renaming it renames the bar's reference.
//
// The kernel's rebuild ignores the field: the whole part is the part (STEP
// export, drawings and the assistant's checks see every feature). The app's
// view rebuilds `rolledBack(doc)`, the features above the bar.
//
// Pure: Vitest covers it in node.

import { isObject } from "./validate";

type Doc = Record<string, unknown> & { features?: unknown };

const features = (doc: unknown): unknown[] => (isObject(doc) && Array.isArray(doc.features) ? doc.features : []);
const idOf = (f: unknown): string | undefined => (isObject(f) && typeof f.id === "string" ? f.id : undefined);

/** The feature the bar sits above, or null when the part is rolled to the end. */
export function rollbackId(doc: unknown): string | null {
  if (!isObject(doc) || typeof doc.rollback !== "string") return null;
  return features(doc).some((f) => idOf(f) === doc.rollback) ? doc.rollback : null;
}

/** Where the bar is: the index of the first feature below it; the feature count when at the end. */
export function rollbackIndex(doc: unknown): number {
  const list = features(doc);
  const id = rollbackId(doc);
  const i = id === null ? -1 : list.findIndex((f) => idOf(f) === id);
  return i < 0 ? list.length : i;
}

/** Is the part rolled back (some features below the bar)? */
export function isRolledBack(doc: unknown): boolean {
  return rollbackIndex(doc) < features(doc).length;
}

/**
 * The document as far as the bar: the features above it, without the
 * "rollback" field. The same object when the part is at the end and has no
 * field to drop, so a rebuild cache keyed by the document still hits.
 */
export function rolledBack<T>(doc: T): T {
  if (!isObject(doc) || !("rollback" in doc)) return doc;
  const { rollback: _rollback, ...rest } = doc as Doc;
  return { ...rest, features: features(doc).slice(0, rollbackIndex(doc)) } as T;
}

/** The ids below the bar: not built while rolled back. */
export function rolledBackIds(doc: unknown): string[] {
  return features(doc)
    .slice(rollbackIndex(doc))
    .map(idOf)
    .filter((id): id is string => !!id);
}

/** The "rollback" field for a bar placed above the feature at `index` (null: at the end). */
export function rollbackAt(doc: unknown, index: number): string | null {
  const list = features(doc);
  return index >= 0 && index < list.length ? (idOf(list[index]) ?? null) : null;
}

/** The bar one feature up (Roll to previous): the field for it, or undefined when it is already at the top. */
export function rollbackPrevious(doc: unknown): string | null | undefined {
  const i = rollbackIndex(doc);
  return i === 0 ? undefined : rollbackAt(doc, i - 1);
}

/** The bar one feature down (Roll forward): the field for it, or undefined when it is at the end. */
export function rollbackNext(doc: unknown): string | null | undefined {
  const i = rollbackIndex(doc);
  return i >= features(doc).length ? undefined : rollbackAt(doc, i + 1);
}
