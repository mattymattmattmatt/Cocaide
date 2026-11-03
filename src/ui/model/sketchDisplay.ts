// Which sketches the view draws (pure, so tests read it). A sketch a later
// feature uses (the profile it extrudes, cuts or revolves, a sweep's path, a
// hole's points) is hidden once used, the usual CAD way; any other is shown.
// The tree's eye, its right-click Show/Hide and the view's right-click set a
// sketch's `shown` in the document (true, false; absent: the default), so it
// saves. A sketch selected in the tree, or used by the feature open in a
// session, is drawn whatever its eye says, so it can still be picked.

import { references } from "../../doc/commands";

type Raw = Record<string, unknown>;

/** The sketches a later feature uses (not another sketch referencing their entities, not a suppressed feature). */
export function usedSketches(features: readonly Raw[]): Set<string> {
  const sketches = new Set(features.filter((f) => f.op === "sketch").map((f) => String(f.id)));
  const out = new Set<string>();
  for (const f of features) {
    if (f.op === "sketch" || f.suppressed === true) continue;
    for (const id of references(f, { sketchRefs: false })) if (sketches.has(id)) out.add(id);
  }
  return out;
}

/** Is the sketch's eye open? Its own `shown` when set; else hidden when a feature uses it. */
export function sketchShown(f: Raw, used: ReadonlySet<string>): boolean {
  return typeof f.shown === "boolean" ? f.shown : !used.has(String(f.id));
}

/**
 * The sketches not drawn: those whose eye is closed, unless picked (selected
 * in the tree) or used by the feature in a session (`keep`); all of them when
 * the view's Sketches toggle is off is the view's own business.
 */
export function hiddenSketches(features: readonly Raw[], keep: readonly string[] = []): Set<string> {
  const used = usedSketches(features);
  return new Set(features.filter((f) => f.op === "sketch" && !keep.includes(String(f.id)) && !sketchShown(f, used)).map((f) => String(f.id)));
}

/** The patch that shows or hides a sketch: an override equal to the default is dropped (old documents stay as they were). */
export function showSketchPatch(features: readonly Raw[], id: string, show: boolean): Raw {
  return { shown: show === !usedSketches(features).has(id) ? null : show };
}

/** The sketches a feature uses (to keep drawn while it is open in a session). */
export function sketchesOf(f: Raw | undefined, features: readonly Raw[]): string[] {
  if (!f) return [];
  const sketches = new Set(features.filter((g) => g.op === "sketch").map((g) => String(g.id)));
  return references(f, { sketchRefs: false }).filter((id) => sketches.has(id));
}
