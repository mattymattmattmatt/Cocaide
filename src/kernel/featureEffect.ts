// What one feature does to the part, as material: the solid it adds (the part
// after it, less the part before it) and the solid it removes (before, less
// after). A feature session draws these over the part as it stands before the
// feature: what it adds tinted, what it removes as a red ghost. The same two
// booleans work for every feature (an extrude, a cut, a fillet that rounds a
// convex edge and fills a concave one, a shell, a pattern), so nothing here
// knows how a feature makes its shape.

import type { TopoDS_Shape } from "replicad-opencascadejs";
import { volumeOf } from "./measure";
import type { OC, Scope } from "./oc";

export interface FeatureEffect {
  /** The material it adds (in scope `s`), or null for none. */
  added: TopoDS_Shape | null;
  /** The material it removes, or null for none. */
  removed: TopoDS_Shape | null;
  /** Their volumes, mm³ (0 for none). */
  addedVolume: number;
  removedVolume: number;
}

/** Less than this share of the part's volume is no material (the slivers a boolean leaves on shared faces). */
const SLIVER = 1e-7;

/** a − b, or null when the kernel can't (a preview only: no error stops the session for it). */
function cut(oc: OC, s: Scope, a: TopoDS_Shape, b: TopoDS_Shape): TopoDS_Shape | null {
  try {
    const op = s.track(new oc.BRepAlgoAPI_Cut(a, b, s.track(new oc.Message_ProgressRange())));
    if (!op.IsDone()) return null;
    return s.track(op.Shape());
  } catch {
    return null;
  }
}

/**
 * The material a feature adds and removes, from the part before it and after
 * it (either may be null: no solid yet, or none left). Shapes are in `s`.
 */
export function featureEffect(oc: OC, s: Scope, before: TopoDS_Shape | null, after: TopoDS_Shape | null): FeatureEffect {
  const none: FeatureEffect = { added: null, removed: null, addedVolume: 0, removedVolume: 0 };
  if (!before && !after) return none;
  if (!before) return { ...none, added: after, addedVolume: volumeOf(oc, s, after!) };
  if (!after) return { ...none, removed: before, removedVolume: volumeOf(oc, s, before) };
  const scale = Math.max(volumeOf(oc, s, before), volumeOf(oc, s, after), 1);
  const keep = (shape: TopoDS_Shape | null): [TopoDS_Shape | null, number] => {
    if (!shape) return [null, 0];
    const v = volumeOf(oc, s, shape);
    return v > SLIVER * scale ? [shape, v] : [null, 0];
  };
  const [added, addedVolume] = keep(cut(oc, s, after, before));
  const [removed, removedVolume] = keep(cut(oc, s, before, after));
  return { added, removed, addedVolume, removedVolume };
}
