// Fillet and chamfer editors, the parts they share: which edges (picked edges,
// every edge of picked faces, the edges earlier features made), and the
// fillet's other radius sets. Pure rules first (Vitest checks them), then the
// fields.

import { edgesSelectorFor } from "../../kernel/synthesize";
import { describeEdgeSelector, describeWanted } from "../../kernel/selectors";
import type { EdgeSelector, FaceSelector } from "../../doc/types";
import { Field, NumberInput, type NumberValue } from "../fields";
import { PickWrap } from "./FeatureForm";
import type { PickField } from "./picking";
import { pickFieldFor, type PickEnv } from "./pickFields";
import { usePickHost, type PickHost } from "./pickHost";
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

/**
 * The fillet with radius set `i`'s edges changed; with none left (null), the
 * set keeps its faces and features, or goes when it has none.
 */
export function setEdgesPatch(f: Raw, i: number, edges: unknown): Raw {
  const sets = Array.isArray(f.sets) ? (f.sets as Raw[]) : [];
  const set = sets[i];
  if (!set) return {};
  if (edges !== null && edges !== undefined) return { sets: sets.map((s, k) => (k === i ? { ...s, edges } : s)) };
  const { edges: _gone, ...rest } = set;
  void _gone;
  if (!asList(rest.faces).length && !(Array.isArray(rest.features) && rest.features.length)) return removeSetPatch(f, i);
  return { sets: sets.map((s, k) => (k === i ? rest : s)) };
}

/** The fillet with a new radius set on these edges, at its radius now. */
export function newSetPatch(f: Raw, resolved: Raw, edges: unknown): Raw {
  const r = typeof resolved.radius === "number" ? resolved.radius : 1;
  const sets = Array.isArray(f.sets) ? (f.sets as Raw[]) : [];
  return { sets: [...sets, { edges, radius: r }] };
}

/** The key of the session field the first click of a new radius set goes into. */
export const NEW_SET_FIELD = "sets.new";
/** Where the radius sets' fields sit among the fillet's selection fields (after edges, faces and features). */
const SETS_ORDER = 100;

/** A radius set's edges as a field: what pickFieldFor reads them as. */
const setEdgesSpec = (i: number): FieldSpec => ({
  kind: "edges",
  key: `sets.${i}.edges`,
  label: `Radius set ${i + 1}`,
  optional: true,
  propagation: true,
  prompt: `Pick edges for radius set ${i + 1}`,
  get: (f) => (Array.isArray(f.sets) ? (f.sets as Raw[])[i]?.edges : undefined),
});
const NEW_SET_SPEC: FieldSpec = { kind: "edges", key: NEW_SET_FIELD, label: "New radius set", optional: true, propagation: true, prompt: "Pick the edges for a new radius", get: () => undefined };

const envOf = (host: PickHost, p: FieldProps): PickEnv => ({ view: host.view, before: p.before, bodies: p.bodies, edge: host.edge, chainOf: host.chainOf, passes: host.passes });
const refusal = (r: unknown) => (typeof r === "string" ? r : null);

/** One radius set's row; in a session its edges are a live field (clicks put edges in and take them out). */
function SetRow({ p, i, set }: { p: FieldProps; i: number; set: Raw }) {
  const host = usePickHost();
  const field = host ? pickFieldFor(setEdgesSpec(i), p.f, p, SETS_ORDER + i, envOf(host, p), (value) => refusal(p.update(setEdgesPatch(p.f, i, value)))) : null;
  return (
    <PickWrap field={field} tid={`prop-fillet-sets-${i}`}>
      <span className="selector-line">
        <span className="set-text">{describeSet(set)}</span>
        <span className="set-radius">
          <NumberInput value={(set.radius ?? "") as NumberValue} min={0} onCommit={(v) => p.update(setRadiusPatch(p.f, i, "radius", v))} ariaLabel={`Radius of set ${i + 1}`} testId={`prop-fillet-sets-radius-${i}`} />
        </span>
        <button type="button" className="selector-remove" aria-label={`Remove radius set ${i + 1}`} title="Remove this set" onClick={() => p.update(removeSetPatch(p.f, i))} data-testid={`prop-fillet-sets-remove-${i}`}>
          ×
        </button>
      </span>
    </PickWrap>
  );
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
  const verb = prefix === "prop-chamfer" ? "chamfer" : "fillet";
  return [
    { kind: "edges", key: "edges", label: "Edges", optional: true, propagation: true, prompt: `Pick edges to ${verb}` },
    { kind: "faces", key: "faces", label: "Faces", optional: true, testId: `${prefix}-faces`, hint: "Every edge of these faces", prompt: `Pick faces: every edge of each is ${verb === "fillet" ? "filleted" : "chamfered"}` },
    { kind: "features", key: "features", label: "Edges made by", ops: SHAPE_OPS, testId: `${prefix}-features`, hint: "Every edge of the faces these features made" },
  ];
}

/**
 * The fillet's other radius sets: listed, removable, and "Add a radius set"
 * of the edges selected. In a session each set's edges are a live field,
 * and Add makes the next click in the view start a new set (it is then that
 * set's field, for more of its edges).
 */
export function RadiusSets(p: FieldProps) {
  const sets = Array.isArray(p.f.sets) ? (p.f.sets as Raw[]) : [];
  const host = usePickHost();
  const newSet: PickField | null = host
    ? {
        ...pickFieldFor(NEW_SET_SPEC, p.f, p, SETS_ORDER + sets.length, envOf(host, p), (value) => {
          if (value === null || value === undefined) return null;
          const r = refusal(p.update(newSetPatch(p.f, p.resolved, value)));
          if (!r) host.setActive(`sets.${sets.length}.edges`);
          return r;
        })!,
        onRequest: true,
      }
    : null;
  const add = () => {
    // In a session the next click in the view starts the set; outside one, the edges selected are the set.
    if (host) {
      p.setError(null);
      return host.setActive(NEW_SET_FIELD);
    }
    const patch = addSetPatch(p.f, p.resolved, p);
    if (typeof patch === "string") return p.setError(patch);
    p.setError(null);
    p.update(patch);
  };
  return (
    <>
      <Field label="Radius sets" block hint="Other edges with radii of their own, in this one fillet">
        <span className="readout" data-testid="prop-fillet-sets">
          {sets.map((s, i) => (
            <SetRow key={i} p={p} i={i} set={s} />
          ))}
          {!sets.length && <span className="muted">none: every edge takes the radius above</span>}
        </span>
      </Field>
      <PickWrap field={newSet} tid="prop-fillet-sets-new">
        <button type="button" onClick={add} data-testid="prop-fillet-sets-add">
          {host ? "Add a radius set" : "Add the selected edges as a radius set"}
        </button>
      </PickWrap>
    </>
  );
}
