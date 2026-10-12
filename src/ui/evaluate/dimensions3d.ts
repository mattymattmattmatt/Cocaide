// A feature's dimensions shown on the model (double-click a feature): its
// sketch's dimensions, drawn in the sketch's plane where the sketcher draws
// them, and the feature's own numbers (an extrude's depth along its arrow, an
// offset plane's distance). Each one says what editing it changes: a sketch
// dimension (setDimension) or a feature field (updateFeature). Pure.

import type { Constraint, SketchEntity, Vec3 } from "../../doc/types";
import { isExpression } from "../../doc/parameters";
import { dimensionNames } from "../../doc/dimensions";
import { to3D } from "../../geom/frame";
import { add3, scale3 } from "../../geom/vec";
import type { RebuildView } from "../../worker/protocol";
import { dimensionShapes, dimensionText } from "../sketcher/annotate";
import { fmt } from "../model/selection";
import type { Raw } from "../model/ToolContext";
import { featureHandles, handleTip } from "./handles";

export type DimensionEdit =
  | { kind: "sketch"; sketch: string; index: number; name: string; value: number | string; driven: boolean }
  | { kind: "feature"; feature: string; key: "distance" | "direction2.distance" | "angle"; value: number | string };

export interface Dimension3D {
  /** "<feature or sketch>:<index or key>": its test id is dim3d-<id>. */
  id: string;
  at: Vec3;
  text: string;
  /** Extension and dimension lines. */
  lines: [Vec3, Vec3][];
  edit: DimensionEdit;
  /** What it is, as a tooltip: "sketch_1.width", "extrude_1 depth". */
  title: string;
}

/** The sketch a feature is made from, if any: a sketch is its own. */
export function sketchOfFeature(f: Raw | undefined, sketchOf?: (f: Raw) => string | null | undefined): string | null {
  if (!f) return null;
  if (f.op === "sketch") return String(f.id);
  if ((f.op === "extrude" || f.op === "cut") && typeof f.sketch === "string") return f.sketch;
  return sketchOf?.(f) ?? null;
}

/**
 * The dimensions of feature `id` in the view. `resolved` and `features` are
 * the document's features with expressions evaluated and as written;
 * `mmPerPx` sets how far dimensions stand off their geometry.
 */
export function featureDimensions(id: string, resolved: Raw[], features: Raw[], view: RebuildView | null, mmPerPx: number, sketchOf?: (f: Raw) => string | null | undefined): Dimension3D[] {
  const f = resolved.find((g) => g.id === id);
  if (!f || !view) return [];
  const rawF = features.find((g) => g.id === id) ?? f;
  const out: Dimension3D[] = [];

  // The sketch's dimensions, where the rebuild put the sketch (solved).
  const sketchId = sketchOfFeature(f, sketchOf);
  const sk = sketchId ? view.sketches.find((s) => s.id === sketchId) : undefined;
  const sketchRaw = sketchId ? features.find((g) => g.id === sketchId) : undefined;
  const sketchResolved = sketchId ? resolved.find((g) => g.id === sketchId) : undefined;
  if (sk?.ok && sketchResolved && sketchRaw) {
    const constraints = (sketchResolved.constraints ?? []) as Constraint[];
    const rawConstraints = (sketchRaw.constraints ?? []) as Raw[];
    const names = dimensionNames(rawConstraints);
    const entities = (sk.entities?.length ? sk.entities : (sketchResolved.entities ?? [])) as SketchEntity[];
    let shapes: ReturnType<typeof dimensionShapes> = [];
    try {
      shapes = dimensionShapes(entities, constraints, mmPerPx);
    } catch {
      shapes = [];
    }
    for (const s of shapes) {
      const k = constraints[s.index];
      const rawValue = rawConstraints[s.index]?.value;
      const name = names[s.index] ?? `d${s.index + 1}`;
      out.push({
        id: `${sketchId}:${s.index}`,
        at: to3D(sk.frame, s.at),
        text: isExpression(rawValue) ? `${dimensionText(k)} (${rawValue})` : dimensionText(k),
        lines: s.lines.map(([p, q]) => [to3D(sk.frame, p), to3D(sk.frame, q)] as [Vec3, Vec3]),
        edit: { kind: "sketch", sketch: sketchId!, index: s.index, name, value: (rawValue as number | string) ?? ("value" in k ? k.value : 0), driven: (k as { driven?: boolean }).driven === true },
        title: `${sketchId}.${name}`,
      });
    }
  }

  // The feature's own numbers: along its arrows.
  for (const h of featureHandles(f, rawF, view)) {
    const tip = handleTip(h);
    const base = h.key === "distance" && h.scale === 2 ? add3(h.origin, scale3(h.dir, -h.value / 2)) : h.origin;
    const rawValue = h.key === "distance" ? rawF.distance : (rawF.direction2 as Raw | undefined)?.distance;
    out.push({
      id: `${id}:${h.key}`,
      at: scale3(add3(base, tip), 0.5),
      text: isExpression(rawValue) ? `${fmt(h.value)} (${rawValue})` : fmt(h.value),
      lines: [[base, tip]],
      edit: { kind: "feature", feature: id, key: h.key, value: (rawValue as number | string) ?? h.value },
      title: `${id} ${h.label.toLowerCase()}`,
    });
  }
  if (f.op === "plane" && f.mode === "angle" && typeof f.angle === "number") {
    const d = view.datums?.[id];
    if (d?.kind === "plane") out.push({ id: `${id}:angle`, at: d.origin, text: `${fmt(f.angle)}°`, lines: [], edit: { kind: "feature", feature: id, key: "angle", value: (rawF.angle as number | string) ?? f.angle }, title: `${id} angle` });
  }
  return out;
}

/** The patch for a feature dimension's new value (nested fields whole: patches are shallow). */
export function dimensionPatch(edit: Extract<DimensionEdit, { kind: "feature" }>, f: Raw, value: number | string): Raw {
  if (edit.key === "direction2.distance") return { direction2: { ...((f.direction2 as Raw | undefined) ?? {}), distance: value } };
  return { [edit.key]: value };
}
