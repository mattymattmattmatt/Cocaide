// The extrude and cut editors, declared for FeatureForm, laid out the way
// SOLIDWORKS's Boss-Extrude and Cut-Extrude panels are: From (sketch plane,
// an offset, a surface), Direction 1 (end condition, depth or what it goes up
// to, offset, reverse, draft), Direction 2 (a tick box and its own block),
// Thin feature, Selected contours, and intersect (extrude) or flip side to cut
// (cut). The rules live in ./extrude.ts.

import type { Vec3 } from "../../doc/types";
import { sketchNormal } from "../model/sketchPlane";
import { Field } from "../fields";
import {
  contourLabel,
  contoursPatch,
  direction2Patch,
  endOptions,
  endPatch,
  isReversed,
  needsDepth,
  needsUpTo,
  pickedContours,
  sketchContours,
  startKind,
  startPatch,
  thinPatch,
  upToFromSelection,
  type StartKind,
} from "./extrude";
import type { FieldProps, FieldSpec, FormContext, Raw } from "./spec";

/** The sketch's normal where the rebuild placed it (+Z when it has not). */
function normalOf(f: Raw, c: FormContext): Vec3 {
  const sketch = c.before.find((g) => g.id === f.sketch);
  return sketchNormal(sketch, c.view) ?? [0, 0, 1];
}

/** The sketch's entities as the rebuild solved them (else as the document holds them). */
function entitiesOf(f: Raw, c: FormContext): unknown {
  const solved = c.view?.sketches?.find((s) => s.id === f.sketch)?.entities;
  return solved ?? c.before.find((g) => g.id === f.sketch)?.entities;
}

const heading = (key: string, text: string, when?: FieldSpec["when"]): FieldSpec => ({
  kind: "custom",
  key,
  label: text,
  when,
  render: () => (
    <div className="prop-section" data-testid={`prop-section-${key.replace(/^_/, "")}`}>
      {text}
    </div>
  ),
});

const d2 = (f: Raw) => f.direction2 as Raw | undefined;
const twoWay = (f: Raw) => f.extent === "midplane" || f.extent === "throughAllBoth";

/** "Selected contours": the sketch's regions, ticked (none ticked or all: every region). */
function Contours(p: FieldProps) {
  const list = sketchContours(entitiesOf(p.f, p));
  const picked = pickedContours(entitiesOf(p.f, p), p.f.regions);
  if (list.length < 2 && !p.f.regions) return null;
  return (
    <Field label="Selected contours" block hint={picked ? "only the regions ticked" : "the sketch's regions: untick one to leave it out, or tick a hole's area to fill it"}>
      <span className="body-checks" data-testid="prop-regions">
        {list.map((c, i) => (
          <label key={i} className="check" title={`A point inside it: ${c.seed.join(", ")}`}>
            <input
              type="checkbox"
              checked={picked ? picked.includes(i) : c.inDefault}
              onChange={(e) => {
                const patch = contoursPatch(list, picked, i, e.target.checked);
                if (patch) p.update(patch);
                else p.setError("At least one region must stay ticked: tick another first.");
              }}
              data-testid={`prop-regions-${i}`}
            />
            {contourLabel(c)}
          </label>
        ))}
        {!list.length && <span className="muted small">the sketch has no closed regions</span>}
        {picked && (
          <button type="button" onClick={() => p.update({ regions: null })} data-testid="prop-regions-all">
            Use every region
          </button>
        )}
      </span>
    </Field>
  );
}

/** The fields of an extrude ("extrude") or a cut ("cut"). The body fields stay in PropertyPanel. */
export function extrudeFields(op: "extrude" | "cut"): FieldSpec[] {
  return [
    { kind: "sketch", key: "sketch", label: "Sketch", testId: "prop-sketch" },

    heading("_from", "From"),
    {
      kind: "select",
      key: "from",
      label: "Start",
      testId: "prop-from",
      options: [
        ["sketch", "Sketch plane"],
        ["offset", "Offset"],
        ["surface", "Surface, face, plane or vertex"],
      ],
      get: (f) => startKind(f),
      set: (v, f, c) => startPatch(f, v as StartKind, c),
      hint: "Where the extrude begins",
    },
    { kind: "number", key: "startOffset", label: "Offset", unit: "mm", testId: "prop-start-offset", when: (f) => startKind(f) === "offset", hint: "Along the sketch normal; negative: behind it" },
    { kind: "datumRef", key: "from", label: "Start at", accepts: ["plane", "point"], testId: "prop-from-ref", when: (f) => startKind(f) === "surface" },

    heading("_dir1", "Direction 1"),
    {
      kind: "select",
      key: "extent",
      label: "End condition",
      testId: "prop-extent",
      options: endOptions(1),
      get: (f) => f.extent ?? "blind",
      set: (v, f, c) => endPatch(f, 1, String(v), c),
    },
    { kind: "number", key: "distance", label: "Depth", unit: "mm", min: 0, testId: "prop-distance", when: (f) => needsDepth(f.extent) && f.extent !== "midplane" },
    { kind: "number", key: "distance", label: "Total depth", unit: "mm", min: 0, testId: "prop-distance", when: (f) => f.extent === "midplane" },
    {
      kind: "datumRef",
      key: "upTo",
      label: "Up to",
      testId: "prop-up-to",
      accepts: (f) => (f.extent === "upToVertex" ? ["point"] : ["plane"]),
      when: (f) => needsUpTo(f.extent),
      // A curved face will do for up to surface, so not the plain plane-or-point rule.
      pick: (f, c) => upToFromSelection(String(f.extent), c, "Use selected"),
      hint: "Click the face, plane or vertex in the view, then Use selected",
    },
    { kind: "number", key: "offset", label: "Offset", unit: "mm", testId: "prop-offset", when: (f) => f.extent === "offsetFromFace", hint: "Short of the surface, toward the sketch; negative: past it" },
    {
      kind: "select",
      key: "direction",
      label: "Direction",
      testId: "prop-direction-mode",
      options: [
        ["normal", "Sketch normal"],
        ["reversed", "Reversed"],
        ["custom", "Custom"],
      ],
      get: (f, c) => (!f.direction ? "normal" : isReversed(f.direction, normalOf(f, c)) ? "reversed" : "custom"),
      set: (v, f, c) => {
        const n = normalOf(f, c);
        return { direction: v === "normal" ? null : v === "reversed" ? n.map((x) => -x + 0) : n };
      },
    },
    { kind: "direction", key: "direction", label: "Vector", testId: "prop-direction", when: (f, c) => !!f.direction && !isReversed(f.direction, normalOf(f, c)) },
    {
      kind: "bool",
      key: "draft",
      label: "Draft",
      testId: "prop-draft",
      when: (f) => !f.thin,
      get: (f) => !!f.draft,
      set: (v) => ({ draft: v ? { angle: 5 } : null }),
      hint: "Tapered sides",
    },
    { kind: "number", key: "draft.angle", label: "Draft angle", unit: "°", min: 0, testId: "prop-draft-angle", when: (f) => !!f.draft },
    { kind: "bool", key: "draft.outward", label: "Draft outward", testId: "prop-draft-outward", when: (f) => !!f.draft },

    {
      kind: "bool",
      key: "direction2",
      label: "Direction 2",
      testId: "prop-direction2",
      when: (f) => !twoWay(f),
      get: (f) => !!f.direction2,
      set: (v, f) => direction2Patch(f, v === true),
      hint: "The other way too, with its own end",
    },
    {
      kind: "select",
      key: "direction2.extent",
      label: "End condition",
      testId: "prop-direction2-extent",
      options: endOptions(2),
      when: (f) => !!d2(f) && !twoWay(f),
      set: (v, f, c) => endPatch(f, 2, String(v), c),
    },
    { kind: "number", key: "direction2.distance", label: "Depth", unit: "mm", min: 0, testId: "prop-direction2-distance", when: (f) => !!d2(f) && d2(f)!.extent === "blind" },
    {
      kind: "datumRef",
      key: "direction2.upTo",
      label: "Up to",
      testId: "prop-direction2-up-to",
      accepts: (f) => (d2(f)?.extent === "upToVertex" ? ["point"] : ["plane"]),
      when: (f) => !!d2(f) && needsUpTo(d2(f)!.extent),
      pick: (f, c) => upToFromSelection(String(d2(f)!.extent), c, "Use selected"),
    },
    { kind: "number", key: "direction2.offset", label: "Offset", unit: "mm", testId: "prop-direction2-offset", when: (f) => d2(f)?.extent === "offsetFromFace" },
    {
      kind: "bool",
      key: "direction2.draft",
      label: "Draft",
      testId: "prop-direction2-draft",
      when: (f) => !!d2(f) && !f.thin,
      get: (f) => !!d2(f)?.draft,
      set: (v, f) => {
        const { draft: _old, ...rest } = d2(f) ?? {};
        void _old;
        return { direction2: v ? { ...rest, draft: { angle: 5 } } : rest };
      },
    },
    { kind: "number", key: "direction2.draft.angle", label: "Draft angle", unit: "°", min: 0, testId: "prop-direction2-draft-angle", when: (f) => !!d2(f)?.draft },
    { kind: "bool", key: "direction2.draft.outward", label: "Draft outward", testId: "prop-direction2-draft-outward", when: (f) => !!d2(f)?.draft },

    {
      kind: "bool",
      key: "thin",
      label: "Thin feature",
      testId: "prop-thin",
      get: (f) => !!f.thin,
      set: (v, f) => thinPatch(f, v === true),
      hint: "A wall from the sketch's lines: an open sketch may be used",
    },
    { kind: "number", key: "thin.thickness", label: "Thickness", unit: "mm", min: 0, testId: "prop-thin-thickness", when: (f) => !!f.thin },
    {
      kind: "select",
      key: "thin.side",
      label: "Wall side",
      testId: "prop-thin-side",
      options: [
        ["outside", "Outside"],
        ["inside", "Inside"],
        ["mid", "Both sides (mid)"],
      ],
      default: "outside",
      omitDefault: true,
      when: (f) => !!f.thin,
    },

    { kind: "custom", key: "regions", label: "Selected contours", render: (p) => <Contours {...p} /> },

    op === "extrude"
      ? { kind: "bool", key: "intersect", label: "Intersect with the body", testId: "prop-intersect", hint: "Keep only where the extrusion and the body overlap" }
      : { kind: "bool", key: "flipSide", label: "Flip side to cut", testId: "prop-flip-side", hint: "Remove what lies outside the profile instead" },
  ];
}

export const EXTRUDE_FIELDS = extrudeFields("extrude");
export const CUT_FIELDS = extrudeFields("cut");
