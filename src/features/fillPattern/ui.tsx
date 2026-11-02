// Fill pattern's properties: the features it copies, the region (a flat face
// picked in the view, or a sketch's closed profile), the layout, its spacings,
// angle and margin, and its instances: how many fit, ticked to make or
// unticked to skip, and in a session a click on the region skips (or brings
// back) the copy nearest the click.

import { Field } from "../../ui/fields";
import type { PickField } from "../../ui/props/picking";
import { PickWrap } from "../../ui/props/FeatureForm";
import { usePickHost } from "../../ui/props/pickHost";
import type { FieldProps, FieldSpec } from "../../ui/props/spec";
import { InstanceChecks, seedsField } from "../linearPattern/fields";
import { placeRows, seedsOf, skipPatch } from "../linearPattern/instances";
import type { UiOp } from "../uiDefs";
import { FILL_LAYOUTS } from "./layout";
import { fillPreview, instanceNear } from "./preview";

type Raw = Record<string, unknown>;

const regionKind = (f: Raw): "face" | "sketch" => (f.sketch !== undefined ? "sketch" : "face");

const LAYOUT_LABEL: Record<(typeof FILL_LAYOUTS)[number], string> = { square: "Square grid", staggered: "Staggered rows", circular: "Rings about the seed" };

/** The instances: the count that fits, tick boxes, and (in a session) clicks on the region to skip. */
function Instances(p: FieldProps) {
  const host = usePickHost();
  const view = host?.view ?? p.view;
  const preview = fillPreview(p.resolved, p.before, view);
  const rows = typeof preview === "string" ? [] : placeRows(preview.places, p.f.skip);
  const field: PickField | null =
    host && typeof preview !== "string"
      ? {
          key: "skipPick",
          label: "Skip",
          order: 90,
          kind: "point",
          takes: ["faces"],
          count: Array.isArray(p.f.skip) ? p.f.skip.length : 0,
          required: false,
          items: [],
          onRequest: true,
          prompt: "Click a copy's place on the region to skip it (again to bring it back)",
          toggle(t) {
            if (t.kind !== "face" || !t.point) return "Click on the region where a copy is";
            const n = instanceNear(preview, t.point, Math.max(Number(p.resolved.spacing) || 0, 1) / 2);
            if (n === null) return "No copy there: click nearer one of the copies";
            const skipped = Array.isArray(p.f.skip) && (p.f.skip as unknown[]).includes(n);
            const patch = skipPatch(p.f, rows, n, skipped);
            if (typeof patch === "string") return patch;
            const r = p.update(patch);
            return typeof r === "string" ? r : null;
          },
        }
      : null;
  const skipped = Array.isArray(p.f.skip) ? p.f.skip.length : 0;
  return (
    <PickWrap field={field} tid="prop-fill-skip-pick">
      <Field label="Fits" hint={typeof preview === "string" ? "Worked out when the part rebuilds" : host ? "Click Skip, then a copy's place in the view, to leave it out" : undefined}>
        <span className="readout" data-testid="prop-fill-count">
          {typeof preview === "string" ? preview : `${preview.places.length + 1} instances (the seed and ${preview.places.length} copies)${skipped ? `, ${skipped} skipped` : ""}`}
        </span>
      </Field>
      {rows.length > 1 && rows.length <= 200 && <InstanceChecks p={p} rows={rows} testId="prop-pattern-skip" />}
    </PickWrap>
  );
}

export const FILL_PATTERN_FIELDS: FieldSpec[] = [
  seedsField("prop-pattern-features"),
  {
    kind: "select",
    key: "regionKind",
    label: "Fill",
    options: [
      ["face", "A flat face"],
      ["sketch", "A sketch's closed profile"],
    ],
    testId: "prop-fill-region",
    get: regionKind,
    set: (v, f) => (v === "sketch" ? { face: null, sketch: typeof f.sketch === "string" ? f.sketch : "" } : { sketch: null }),
  },
  { kind: "face", key: "face", label: "Face", testId: "prop-fill-face", hint: "The flat face the copies fill, its holes left clear", prompt: "Pick the flat face to fill", when: (f) => regionKind(f) === "face" },
  { kind: "sketch", key: "sketch", label: "Region sketch", testId: "prop-fill-sketch", hint: "Its closed profile is the region, in its plane", when: (f) => regionKind(f) === "sketch" },
  {
    kind: "select",
    key: "layout",
    label: "Layout",
    options: FILL_LAYOUTS.map((l): [string, string] => [l, LAYOUT_LABEL[l]]),
    default: "square",
    omitDefault: true,
    testId: "prop-fill-layout",
  },
  { kind: "number", key: "spacing", label: "Spacing", unit: "mm", min: 0, testId: "prop-spacing", hint: "Between neighbours along a row (a ring)" },
  { kind: "number", key: "spacing2", label: "Row spacing", unit: "mm", min: 0, testId: "prop-fill-spacing2", hint: "Between rows (rings); empty: the spacing (staggered: × 0.866)" },
  { kind: "number", key: "angle", label: "Angle", unit: "°", testId: "prop-fill-angle", default: 0, omitDefault: true },
  { kind: "number", key: "margin", label: "Margin", unit: "mm", min: 0, testId: "prop-fill-margin", default: 0, omitDefault: true, hint: "How far every copy keeps from the region's edges and holes" },
  { kind: "custom", key: "skip", label: "Instances", render: (p) => <Instances {...p} /> },
];

export const ui: UiOp = {
  op: "fillPattern",
  label: "Fill pattern",
  icon: "fillPattern",
  fields: FILL_PATTERN_FIELDS,
  summary: (f) => {
    const seeds = seedsOf(f).length;
    return [typeof f.layout === "string" ? f.layout : "square", typeof f.spacing === "number" ? `${f.spacing} mm` : "", ...(seeds > 1 ? [`${seeds} features`] : [])].filter(Boolean).join(" ");
  },
  sketchOf: (f) => (typeof f.sketch === "string" ? f.sketch : null),
};
