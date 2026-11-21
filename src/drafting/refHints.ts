// Annotations that keep hold of their geometry. A GeoRef names an edge by its
// key ("post_b0/l23": the 23rd line post_b0 made, by position), and a key can
// change when the model's faces split differently though the shape is the
// same (joints rearranged, a feature reordered). So the drawing remembers
// where each GeoRef its annotations use was in its view (`refHints`, view mm,
// with the body), and a GeoRef whose key is gone is found again there: the
// same kind of thing (an end, a centre, a line) on the same body at the same
// place. `withRefHints` records the places and writes re-found refs back.

import { parseGeoRef, type GeoRefParts } from "../doc/drawing";
import type { Drawing, Vec2 } from "../doc/types";
import type { ComposedSheet, ComposedView } from "./compose";
import { geoInView } from "./georef";

/** Where a GeoRef was: its body, and its point ([x, y]), line ([ax, ay, bx, by]) or circle ([cx, cy, r]), view mm. */
export interface RefHint {
  body?: string;
  p: number[];
  /** It was a hidden line's (absent: a seen one's). */
  hidden?: true;
}

/** How near (view mm) a thing must be to where the GeoRef was to be taken for it. */
const NEAR = 0.05;

type Resolved = NonNullable<ReturnType<typeof geoInView>>;

/** The GeoRef written out again, its key replaced. */
export function geoRefText(parts: Exclude<GeoRefParts, { form: "point" }>): string {
  const tail = parts.form === "v" ? `.${parts.end}` : parts.form === "q" ? `.${parts.quadrant}` : "";
  return `${parts.view}:${parts.form}${parts.key}${tail}`;
}

/** What to remember of a resolved GeoRef. */
export function hintOf(r: Resolved): RefHint | null {
  const round = (xs: number[]) => xs.map((x) => Math.round(x * 1e4) / 1e4 + 0);
  const base = { ...(r.meta.body ? { body: r.meta.body } : {}), ...(r.visible ? {} : { hidden: true as const }) };
  if (r.kind === "point") return { ...base, p: round(r.p) };
  if (r.kind === "circle") return { ...base, p: round([...r.c, r.r]) };
  if (r.a && r.b) return { ...base, p: round([...r.a, ...r.b]) };
  return null;
}

const d2 = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** How far a resolved GeoRef is from a hint (Infinity: not the same kind of thing). */
function distance(r: Resolved, h: RefHint): number {
  const p = h.p;
  if (r.kind === "point" && p.length === 2) return d2(r.p, [p[0], p[1]]);
  if (r.kind === "circle" && p.length === 3) return d2(r.c, [p[0], p[1]]) + Math.abs(r.r - p[2]);
  if (r.kind === "edge" && r.a && r.b && p.length === 4) {
    const a: Vec2 = [p[0], p[1]];
    const b: Vec2 = [p[2], p[3]];
    return Math.min(d2(r.a, a) + d2(r.b, b), d2(r.a, b) + d2(r.b, a));
  }
  return Infinity;
}

/** Whether a resolved GeoRef is somewhere else than its hint says it was. */
export function movedFrom(r: Resolved, h: RefHint): boolean {
  return distance(r, h) > NEAR || r.visible === !!h.hidden;
}

/**
 * A GeoRef whose key is gone, found again where its hint says it was: the
 * key in the view that resolves (in the same form) nearest the hint, on the
 * same body when the hint names one. Null when nothing is there.
 */
export function healRef(cv: Pick<ComposedView, "edges" | "frame" | "outline">, parts: Exclude<GeoRefParts, { form: "point" }>, hint: RefHint): { key: string; found: Resolved } | null {
  let best: { key: string; found: Resolved; d: number } | null = null;
  for (const key of new Set(cv.edges.map((e) => e.key))) {
    if (!key || key === parts.key) continue;
    const found = geoInView(cv, { ...parts, key } as GeoRefParts);
    if (!found || (hint.body && found.meta.body && found.meta.body !== hint.body)) continue;
    // As near, and seen (or hidden) as it was: a seen edge's end over a hidden one's at the same place.
    const d = distance(found, hint) + (found.visible === !hint.hidden ? 0 : NEAR / 2);
    if (d <= NEAR && (!best || d < best.d)) best = { key, found, d };
  }
  return best && { key: best.key, found: best.found };
}

/** Every GeoRef (of a view's edges, not a node or a side) the annotations name, anywhere in them. */
export function refsIn(drawing: Drawing): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      const p = parseGeoRef(v);
      if (p && p.form !== "point") out.add(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  for (const s of drawing.sheets) walk(s.annotations ?? []);
  return [...out];
}

/** Replaces strings everywhere in a value (refs in annotations). */
function replaceRefs<T>(v: T, map: Map<string, string>): T {
  if (typeof v === "string") return (map.get(v) ?? v) as T;
  if (Array.isArray(v)) return v.map((x) => replaceRefs(x, map)) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replaceRefs(x, map)])) as T;
  return v;
}

/**
 * Where the annotations' GeoRefs are now (those no annotation names any
 * more dropped), and the GeoRefs whose keys are gone but were found again
 * where they were, with their new text. Null when nothing changes. Views
 * that aren't composed yet (or show nothing) keep what they had.
 */
export function refHintsFor(drawing: Drawing, sheets: readonly Pick<ComposedSheet, "views">[]): { hints: Record<string, RefHint>; renamed: Map<string, string> } | null {
  const views = new Map<string, ComposedView>();
  for (const s of sheets) for (const v of s.views) views.set(v.id, v);
  const old = drawing.refHints ?? {};
  const hints: Record<string, RefHint> = {};
  const renamed = new Map<string, string>();
  for (const ref of refsIn(drawing)) {
    const parts = parseGeoRef(ref);
    if (!parts || parts.form === "point") continue;
    const cv = views.get(parts.view);
    if (!cv || !cv.outline) {
      if (old[ref]) hints[ref] = old[ref];
      continue;
    }
    const found = geoInView(cv, parts);
    const was = old[ref];
    if (found && (!was || !movedFrom(found, was) || !healRef(cv, parts, was))) {
      // Where it is now (it may have moved with the model).
      const h = hintOf(found);
      if (h) hints[ref] = h;
      continue;
    }
    const healed = was ? healRef(cv, parts, was) : null;
    if (healed) {
      const next = geoRefText({ ...parts, key: healed.key } as Exclude<GeoRefParts, { form: "point" }>);
      renamed.set(ref, next);
      const h = hintOf(healed.found);
      if (h) hints[next] = h;
    } else if (was) hints[ref] = was; // still lost: keep where it was, for when it comes back
  }
  if (!renamed.size && JSON.stringify(hints) === JSON.stringify(old)) return null;
  return { hints, renamed };
}

/**
 * The drawing as the document holds it (expressions and all) with those
 * places recorded and the found GeoRefs written back. Null when nothing changes.
 */
export function withRefHints<D extends Record<string, unknown>>(raw: D, drawing: Drawing, sheets: readonly Pick<ComposedSheet, "views">[]): D | null {
  const r = refHintsFor(drawing, sheets);
  if (!r) return null;
  const { refHints: _drop, ...rest } = raw;
  const rawSheets = Array.isArray(rest.sheets) ? rest.sheets : [];
  return {
    ...rest,
    sheets: r.renamed.size ? replaceRefs(rawSheets, r.renamed) : rawSheets,
    ...(Object.keys(r.hints).length ? { refHints: r.hints } : {}),
  } as unknown as D;
}
