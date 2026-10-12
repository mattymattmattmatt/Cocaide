// The loft's list of sections, as its editor changes it (pure): move a
// sketch up or down the order, take one out, add one; and which sketches
// before the loft could be sections.

import { entitiesOf, sketchUse } from "../sweep/fields";

type Raw = Record<string, unknown>;

/** The list with item i moved one place up (-1) or down (+1); null when it cannot move. */
export function moved(list: string[], i: number, by: -1 | 1): string[] | null {
  const j = i + by;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return null;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** The list without item i; null when that would leave fewer than two. */
export function without(list: string[], i: number): string[] | null {
  if (list.length <= 2) return null;
  return list.filter((_, k) => k !== i);
}

/** Sketches before the loft that could be sections (a closed profile, or a lone point), not yet in the list: [id, label]. */
export function sectionChoices(before: Raw[], list: string[]): [string, string][] {
  return before
    .filter((g) => g.op === "sketch" && !list.includes(String(g.id)))
    .flatMap((g): [string, string][] => {
      const use = sketchUse(entitiesOf(g));
      if (use === "profile") return [[String(g.id), String(g.id)]];
      if (use === "point") return [[String(g.id), `${String(g.id)} (a point)`]];
      return [];
    });
}
