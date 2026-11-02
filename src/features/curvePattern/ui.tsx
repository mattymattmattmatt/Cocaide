// Curve-driven pattern's properties: the features it copies, the curve (a
// sketch's chain, or model edges picked in the view), how many and how far
// apart (evenly over the whole curve, or a spacing), whether copies turn with
// the curve, which end it starts from, and which instances it makes.

import { Field, NumberInput, Select } from "../../ui/fields";
import type { FieldProps, FieldSpec } from "../../ui/props/spec";
import { seedsField, skipField } from "../linearPattern/fields";
import { countPatch, seedsOf, type InstanceRow } from "../linearPattern/instances";
import type { UiOp } from "../uiDefs";

type Raw = Record<string, unknown>;

const pathKind = (f: Raw): "sketch" | "edges" => (typeof f.path === "object" && f.path !== null && "edges" in (f.path as Raw) ? "edges" : "sketch");

/** The instances along the curve: 1 the seed, 2 ... count. */
export function curveRows(f: Raw): InstanceRow[] {
  const count = typeof f.count === "number" && Number.isInteger(f.count) && f.count > 0 ? Math.min(f.count, 1000) : 1;
  const skip = Array.isArray(f.skip) ? (f.skip as unknown[]) : [];
  return Array.from({ length: count }, (_, k) => ({ n: k + 1, label: k === 0 ? "1 (the seed)" : String(k + 1), skipped: skip.includes(k + 1) }));
}

/** Spread evenly over the curve, or a set spacing along it. */
function Spacing(p: FieldProps) {
  const even = p.f.spacing === undefined;
  return (
    <>
      <Field label="Spacing" hint={even ? "Shared out evenly over the whole curve (round a closed one)" : "Along the curve, between neighbours"}>
        <Select
          value={even ? "even" : "set"}
          options={[
            ["even", "Even over the whole curve"],
            ["set", "A set spacing"],
          ]}
          onChange={(v) => p.update({ spacing: v === "even" ? null : 10 })}
          testId="prop-curve-spacing-mode"
        />
      </Field>
      {!even && (
        <Field label="Spacing" unit="mm">
          <NumberInput value={p.f.spacing as number} min={0} onCommit={(v) => p.update({ spacing: v })} testId="prop-spacing" />
        </Field>
      )}
    </>
  );
}

export const CURVE_PATTERN_FIELDS: FieldSpec[] = [
  seedsField("prop-pattern-features"),
  {
    kind: "select",
    key: "pathKind",
    label: "Along",
    options: [
      ["sketch", "A sketch's curve"],
      ["edges", "Model edges"],
    ],
    testId: "prop-curve-path-kind",
    get: pathKind,
    set: (v) => ({ path: v === "edges" ? { edges: [] } : { sketch: "" } }),
  },
  {
    kind: "sketch",
    key: "path.sketch",
    label: "Curve sketch",
    testId: "prop-curve-sketch",
    hint: "Its chain of lines, arcs and splines: the seed sits at its start",
    when: (f) => pathKind(f) === "sketch",
    set: (id) => ({ path: { sketch: id } }),
  },
  {
    kind: "edges",
    key: "path.edges",
    label: "Edges",
    testId: "prop-curve-edges",
    hint: "Edges end to end: the seed sits where the chain starts",
    prompt: "Pick the edges the copies follow",
    when: (f) => pathKind(f) === "edges",
    set: (v) => ({ path: { edges: Array.isArray(v) ? v : v ? [v] : [] } }),
  },
  { kind: "number", key: "count", label: "Count", min: 2, testId: "prop-count", hint: "Instances in all, the original one of them", set: (v, f) => countPatch(f, "count", v) },
  { kind: "custom", key: "spacing", label: "Spacing", render: (p) => <Spacing {...p} /> },
  {
    kind: "select",
    key: "orientation",
    label: "Copies",
    options: [
      ["curve", "Turn with the curve"],
      ["fixed", "Keep the seed's orientation"],
    ],
    default: "curve",
    omitDefault: true,
    testId: "prop-curve-orientation",
  },
  { kind: "bool", key: "reverse", label: "Start from the other end", testId: "prop-pattern-reverse" },
  skipField((f) => curveRows(f)),
];

export const ui: UiOp = {
  op: "curvePattern",
  label: "Curve-driven pattern",
  icon: "curvePattern",
  fields: CURVE_PATTERN_FIELDS,
  summary: (f) => {
    const seeds = seedsOf(f).length;
    return typeof f.count === "number" ? [`${f.count}×`, f.spacing === undefined ? "even" : `${String(f.spacing)} mm`, ...(seeds > 1 ? [`${seeds} features`] : [])].join(" ") : null;
  },
  sketchOf: (f) => (typeof f.path === "object" && f.path !== null && typeof (f.path as Raw).sketch === "string" ? ((f.path as Raw).sketch as string) : null),
};
