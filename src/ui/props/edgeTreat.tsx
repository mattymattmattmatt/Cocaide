// Fillet and chamfer editors, the parts they share: which edges (picked edges,
// every edge of picked faces, the edges earlier features made), and the
// fillet's other radius sets. Pure rules first (Vitest checks them), then the
// fields.

import { edgesSelectorFor } from "../../kernel/synthesize";
import { describeEdgeSelector, describeWanted } from "../../kernel/selectors";
import type { EdgeSelector, FaceSelector } from "../../doc/types";
import { Field, NumberInput, type NumberValue } from "../fields";
import { asList, type FieldProps, type FieldSpec, type FormContext, type Raw } from "./spec";

/** The ops whose faces a fillet or chamfer may take "the edges it made" from. */
export const SHAPE_OPS = ["extrude", "cut", "hole", "revolve", "sweep", "loft", "rib", "shell", "draft", "fillet", "chamfer", "linearPattern", "circularPattern", "mirror", "member", "endCap", "gusset"];

/** The chamfer's kind, by its fields: equal distances, two distances, or a distance and an angle. */
export type ChamferType = "equal" | "distances" | "angle";

export function chamferType(f: Raw): ChamferType {
  return f.distance2 !== undefined && f.distance2 !== null ? "distances" : f.angle !== undefined && f.angle !== null ? "angle" : "equal";
}

/** The patch that makes the chamfer of this kind: the second distance starts equal to the first, the angle at 45°. */
export function chamferTypePatch(f: Raw, type: ChamferType): Raw {
  if (type === "equal") return { distance2: null, angle: null, flip: null };
  if (type === "distances") return { angle: null, distance2: f.distance2 ?? f.distance ?? 1 };
  return { distance2: null, angle: f.angle ?? 45 };
}

/** Variable radius on (the end radius twice the start) or off. */
export function variablePatch(resolved: Raw, on: boolean): Raw {
  if (!on) return { radius2: null };
  const r = typeof resolved.radius === "number" ? resolved.radius : 1;
  return { radius2: Math.round(r * 2 * 1e6) / 1e6 };
}

/**
 * The fillet with the edges selected in the view added as a radius set of
 * their own (the radius it has now), or what to do first.
 */
export function addSetPatch(f: Raw, resolved: Raw, c: Pick<FormContext, "selection" | "view">): Raw | string {
  if (!c.view || c.selection.edges.length === 0) return "Click the edges for the new radius in the view (Ctrl-click for more), then Add a radius set.";
  const s = edgesSelectorFor(c.view.edges, c.view.faces, c.selection.edges);
  if (!s.ok) return s.error;
  const r = typeof resolved.radius === "number" ? resolved.radius : 1;
  const sets = Array.isArray(f.sets) ? (f.sets as Raw[]) : [];
  return { sets: [...sets, { edges: s.selector, radius: r }] };
}

/** The fillet without radius set `i` (the last one gone: no sets). */
export function removeSetPatch(f: Raw, i: number): Raw {
  const sets = Array.isArray(f.sets) ? (f.sets as Raw[]).filter((_, k) => k !== i) : [];
  return { sets: sets.length ? sets : null };
}

/** The fillet with radius set `i`'s radius (or end radius) changed. */
export function setRadiusPatch(f: Raw, i: number, key: "radius" | "radius2", value: unknown): Raw {
  const sets = Array.isArray(f.sets) ? (f.sets as Raw[]) : [];
  return {
    sets: sets.map((set, k) => {
      if (k !== i) return set;
      const out: Raw = { ...set };
      if (value === null || value === undefined || value === "") delete out[key];
      else out[key] = value;
      return out;
    }),
  };
}

/** A radius set in words: "R 2 → 4 on line edges parallel to +Y …". */
export function describeSet(set: Raw): string {
  const r = set.radius2 !== undefined ? `R ${set.radius} → ${set.radius2}` : `R ${set.radius}`;
  const parts: string[] = [];
  for (const e of asList<EdgeSelector>(set.edges)) parts.push(describeEdgeSelector(e));
  for (const s of asList<FaceSelector>(set.faces)) parts.push(`the edges of ${describeWanted(s, 1).replace(/^1 /, "the ")}`);
  for (const id of Array.isArray(set.features) ? (set.features as string[]) : []) parts.push(`the edges ${id} made`);
  return `${r} on ${parts.join("; ") || "no edges"}`;
}

/** Edges, faces and features: which edges the feature treats (`prefix` "prop-fillet" or "prop-chamfer" for the new ones' test ids). */
export function edgeChoiceFields(prefix: string): FieldSpec[] {
  return [
    { kind: "edges", key: "edges", label: "Edges", optional: true },
    { kind: "faces", key: "faces", label: "Faces", optional: true, testId: `${prefix}-faces`, hint: "Every edge of these faces" },
    { kind: "features", key: "features", label: "Edges made by", ops: SHAPE_OPS, testId: `${prefix}-features`, hint: "Every edge of the faces these features made" },
  ];
}

/** The fillet's other radius sets: listed, removable, and "Add a radius set" from the edges selected. */
export function RadiusSets(p: FieldProps) {
  const sets = Array.isArray(p.f.sets) ? (p.f.sets as Raw[]) : [];
  return (
    <>
      <Field label="Radius sets" block hint="Other edges with radii of their own, in this one fillet">
        <span className="readout" data-testid="prop-fillet-sets">
          {sets.map((s, i) => (
            <span key={i} className="selector-line">
              <span className="set-text">{describeSet(s)}</span>
              <span className="set-radius">
                <NumberInput value={(s.radius ?? "") as NumberValue} min={0} onCommit={(v) => p.update(setRadiusPatch(p.f, i, "radius", v))} ariaLabel={`Radius of set ${i + 1}`} testId={`prop-fillet-sets-radius-${i}`} />
              </span>
              <button type="button" className="selector-remove" aria-label={`Remove radius set ${i + 1}`} title="Remove this set" onClick={() => p.update(removeSetPatch(p.f, i))} data-testid={`prop-fillet-sets-remove-${i}`}>
                ×
              </button>
            </span>
          ))}
          {!sets.length && <span className="muted">none: every edge takes the radius above</span>}
        </span>
      </Field>
      <button
        type="button"
        onClick={() => {
          const patch = addSetPatch(p.f, p.resolved, p);
          if (typeof patch === "string") return p.setError(patch);
          p.setError(null);
          p.update(patch);
        }}
        data-testid="prop-fillet-sets-add"
      >
        Add the selected edges as a radius set
      </button>
    </>
  );
}
