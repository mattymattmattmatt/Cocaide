// Loft's properties: the sections in order (each moved up or down, taken
// out, or another sketch added), ruled or smooth, closed into a ring, and what
// it does to the part.

import { Field, Select } from "../../ui/fields";
import type { FieldProps, FieldSpec } from "../../ui/props/spec";
import { operationFields } from "../sweep/fields";
import type { UiOp } from "../uiDefs";
import { moved, sectionChoices, without } from "./profiles";

type Raw = Record<string, unknown>;

const listOf = (f: Raw): string[] => (Array.isArray(f.profiles) ? f.profiles.map(String) : []);

/** The sections, in order, each with up, down and remove; and a choice to add one. */
function Sections(p: FieldProps) {
  const list = listOf(p.f);
  const choices = sectionChoices(p.before, list);
  const set = (next: string[] | null) => next && p.update({ profiles: next });
  return (
    <>
      <Field label="Sections" block hint="In the order the loft passes through them">
        <span className="readout" data-testid="prop-loft-profiles">
          {list.map((id, i) => (
            <span key={`${id}-${i}`} className="selector-line" data-testid={`prop-loft-profile-${i}`}>
              <span className="set-text">
                {i + 1}. {id}
              </span>
              <button type="button" className="selector-remove" aria-label={`Move ${id} earlier`} title="Earlier in the loft" disabled={i === 0} onClick={() => set(moved(list, i, -1))} data-testid={`prop-loft-up-${i}`}>
                ↑
              </button>
              <button type="button" className="selector-remove" aria-label={`Move ${id} later`} title="Later in the loft" disabled={i === list.length - 1} onClick={() => set(moved(list, i, 1))} data-testid={`prop-loft-down-${i}`}>
                ↓
              </button>
              <button type="button" className="selector-remove" aria-label={`Take ${id} out of the loft`} title={list.length <= 2 ? "A loft needs two sections" : "Take this section out"} disabled={list.length <= 2} onClick={() => set(without(list, i))} data-testid={`prop-loft-remove-${i}`}>
                ×
              </button>
            </span>
          ))}
        </span>
      </Field>
      {choices.length > 0 && (
        <Field label="Add a section">
          <Select value="" options={[["", "Choose a sketch…"], ...choices]} onChange={(id) => id && p.update({ profiles: [...list, id] })} testId="prop-loft-add" />
        </Field>
      )}
    </>
  );
}

export const LOFT_FIELDS: FieldSpec[] = [
  { kind: "custom", key: "profiles", label: "Sections", render: (p) => <Sections {...p} /> },
  { kind: "bool", key: "ruled", label: "Ruled (straight between sections)", testId: "prop-ruled" },
  { kind: "bool", key: "closed", label: "Closed (back to the first section)", testId: "prop-closed", when: (f) => listOf(f).length >= 3 },
  ...operationFields("Cut (lofted cut)"),
];

export const ui: UiOp = {
  op: "loft",
  label: "Loft",
  icon: "loft",
  fields: LOFT_FIELDS,
  summary: (f) => [`${listOf(f).length} sections`, ...(f.ruled ? ["ruled"] : []), ...(f.closed ? ["closed"] : []), ...(f.operation === "remove" ? ["cut"] : [])].join(" "),
  sketchOf: (f) => listOf(f)[0] ?? null,
};
