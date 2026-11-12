// Fillet's properties: the edges it rounds (picked edges, every edge of picked
// faces, the edges earlier features made), its radius (or a radius varying
// from one end of each edge to the other), and other radius sets.

import { edgeChoiceFields, RadiusSets, variablePatch } from "../../ui/props/edgeTreat";
import type { UiOp } from "../uiDefs";

type Raw = Record<string, unknown>;
const variable = (f: Raw) => f.radius2 !== undefined && f.radius2 !== null;
/** Does the feature have edges of its own (not only radius sets)? Then it needs its own radius. */
const own = (f: Raw) => f.radius !== undefined || !f.sets || f.edges !== undefined || f.faces !== undefined || f.features !== undefined;

export const ui: UiOp = {
  op: "fillet",
  label: "Fillet",
  icon: "fillet",
  fields: [
    { kind: "number", key: "radius", label: "Radius", unit: "mm", min: 0, testId: "prop-radius", when: (f) => own(f) && !variable(f) },
    { kind: "number", key: "radius", label: "Start radius", unit: "mm", min: 0, testId: "prop-radius", when: (f) => own(f) && variable(f) },
    { kind: "number", key: "radius2", label: "End radius", unit: "mm", min: 0, testId: "prop-radius2", when: variable },
    {
      kind: "bool",
      key: "radius2",
      label: "Variable radius",
      testId: "prop-fillet-variable",
      when: own,
      get: (f) => variable(f),
      set: (v, _f, c) => variablePatch(c.resolved, v === true),
      hint: "From the start radius at each edge's start to the end radius at its end",
    },
    // The radius first (what is changed most), then the edges it rounds.
    ...edgeChoiceFields("prop-fillet"),
    { kind: "custom", key: "sets", label: "Radius sets", render: (p) => <RadiusSets {...p} /> },
  ],
  summary: (f) => (typeof f.radius === "number" ? (typeof f.radius2 === "number" ? `R${f.radius}→${f.radius2}` : `R${f.radius}`) : null),
};
