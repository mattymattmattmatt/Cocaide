// The face and edge selectors in a feature (Phase P): where each is, which
// ones are fragile (they name a face by where it is, so they break when it
// moves), and writing a re-found or re-picked selector in place of an old
// one. Pure, on raw JSON.

import { isObject } from "./validate";

/** A face or edge selector somewhere in a feature: its path ("edges[0]", "upTo.face") and what it is. */
export interface SelectorAt {
  path: string;
  /** The top-level field it is under: what a patch writes. */
  key: string;
  kind: "face" | "edge";
  selector: Record<string, unknown>;
}

const isSelector = (v: unknown): v is Record<string, unknown> => isObject(v) && (v.type === "planar" || v.type === "cylindrical" || v.type === "edge");

/** Every face and edge selector of a feature, outermost first (a face nested in an edge selector is part of it, not listed). */
export function selectorsIn(f: Record<string, unknown>): SelectorAt[] {
  const out: SelectorAt[] = [];
  const walk = (v: unknown, path: string, key: string) => {
    if (isSelector(v)) {
      out.push({ path, key, kind: v.type === "edge" ? "edge" : "face", selector: v });
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, key));
    else if (isObject(v)) for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, key || k);
  };
  for (const [k, v] of Object.entries(f)) if (k !== "entities" && k !== "constraints") walk(v, k, k);
  return out;
}

/** The same JSON, keys in order: two selectors that mean the same compare equal. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/**
 * The patch that writes `to` in place of the selector equal to `from`
 * (`from` as the rebuild read it); null when the feature has no such selector.
 */
export function replaceSelectorPatch(f: Record<string, unknown>, from: unknown, to: unknown): Record<string, unknown> | null {
  const want = canonical(from);
  const hit = selectorsIn(f).find((s) => canonical(s.selector) === want);
  return hit ? setAtPath(f, hit.path, to) : null;
}

/** The patch that writes `value` at `path` ("edges[0]", "upTo.face") of the feature: its top-level field, copied with the change. */
export function setAtPath(f: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const steps = path.match(/[^.[\]]+/g) ?? [];
  const key = steps[0] ?? path;
  const root = structuredClone(f[key]);
  if (steps.length === 1) return { [key]: structuredClone(value) };
  let at = root as Record<string, unknown> | unknown[];
  for (let i = 1; i < steps.length - 1; i++) at = (at as Record<string, unknown>)[steps[i]] as Record<string, unknown>;
  (at as Record<string, unknown>)[steps[steps.length - 1]] = structuredClone(value);
  return { [key]: root };
}

/** The selector at `path` of the feature, if there is one. */
export function selectorAt(f: Record<string, unknown>, path: string): Record<string, unknown> | null {
  return selectorsIn(f).find((s) => s.path === path)?.selector ?? null;
}

/**
 * Why a selector is fragile, or null: it names its face or edge by where it
 * is (an offset, a nearest point, a length) and has no hint to find it again
 * by, so an upstream edit that moves it breaks the feature. "Make robust"
 * writes it again from the face it means now, with its maker and a hint.
 */
export function fragility(sel: Record<string, unknown>): string | null {
  if (sel.hint !== undefined) return null;
  if (sel.type === "planar" && sel.offset !== undefined) return "names the face by its offset: it breaks when the face moves";
  if (sel.near !== undefined && sel.createdBy === undefined) return "tells it apart by position only: it can pick another one when things move";
  if (sel.type === "edge" && sel.length !== undefined) return "names the edge by its length: it breaks when the length changes";
  const nested = [sel.onFace, ...(Array.isArray(sel.between) ? sel.between : [])].filter(isSelector);
  for (const n of nested) if (fragility(n)) return `its face ${fragility(n)}`;
  return null;
}

/** The fragile selectors of a feature, with why. */
export function fragileSelectors(f: Record<string, unknown>): (SelectorAt & { reason: string })[] {
  return selectorsIn(f).flatMap((s) => {
    const reason = fragility(s.selector);
    return reason ? [{ ...s, reason }] : [];
  });
}
