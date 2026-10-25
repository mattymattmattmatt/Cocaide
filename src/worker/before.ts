// The part as it stands before a feature: what a sketch being edited may see
// and reference (DESIGN §2.4: a sketch's references are to the model at its
// place in history, not to the features after it or the one made from it).
// Pure: the worker rebuilds what this returns and keeps a few such views.

import { geometryKey } from "../doc/drawing";

/** The document with only the features before `feature` (all of them when it isn't there). */
export function documentBefore(doc: unknown, feature: string): unknown {
  if (typeof doc !== "object" || doc === null || !Array.isArray((doc as { features?: unknown }).features)) return doc;
  const features = (doc as { features: unknown[] }).features;
  const at = features.findIndex((f) => typeof f === "object" && f !== null && (f as { id?: unknown }).id === feature);
  // The drawing describes the whole part; the part before a feature has none. Nor a rollback bar (it may name a feature cut off here).
  const { drawing: _drawing, rollback: _rollback, ...rest } = doc as Record<string, unknown>;
  return { ...rest, features: at < 0 ? features : features.slice(0, at) };
}

/**
 * The document with the features up to and including `feature` (all of them
 * when it isn't there): the part just after it, with nothing that comes later.
 * A feature session compares this with the part before it.
 */
export function documentThrough(doc: unknown, feature: string): unknown {
  if (typeof doc !== "object" || doc === null || !Array.isArray((doc as { features?: unknown }).features)) return doc;
  const features = (doc as { features: unknown[] }).features;
  const at = features.findIndex((f) => typeof f === "object" && f !== null && (f as { id?: unknown }).id === feature);
  if (at < 0 || at === features.length - 1) return doc;
  const { drawing: _drawing, rollback: _rollback, ...rest } = doc as Record<string, unknown>;
  return { ...rest, features: features.slice(0, at + 1) };
}

/** What two requests for the part before a feature share when they are the same: the geometry before it. */
export function beforeKey(doc: unknown, feature: string): string {
  return `${feature}\u0000${geometryKey(documentBefore(doc, feature))}`;
}

/** A small cache, newest last: editing a sketch asks for the same part again and again. */
export class Recent<T> {
  private readonly items = new Map<string, T>();
  /** `evicted` is told of each value dropped (to free what it holds: a rebuild's shapes). */
  constructor(
    private readonly size = 4,
    private readonly evicted?: (value: T) => void,
  ) {}
  get(key: string): T | undefined {
    const v = this.items.get(key);
    if (v !== undefined) {
      this.items.delete(key);
      this.items.set(key, v);
    }
    return v;
  }
  set(key: string, value: T): void {
    const old = this.items.get(key);
    this.items.delete(key);
    if (old !== undefined && old !== value) this.evicted?.(old);
    this.items.set(key, value);
    while (this.items.size > this.size) {
      const first = this.items.keys().next().value!;
      const dropped = this.items.get(first)!;
      this.items.delete(first);
      this.evicted?.(dropped);
    }
  }
  clear(): void {
    if (this.evicted) for (const v of this.items.values()) this.evicted(v);
    this.items.clear();
  }
}
