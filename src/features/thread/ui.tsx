// A thread's properties: the round face it is on (picked in the view), its
// size (the one the face fits, or chosen) and pitch, its length and which end
// it starts from, cosmetic or modelled (with the run-out chamfer), left hand;
// and the callout a drawing will show, with a word when a modelled one will
// be slow to rebuild.

import { Field } from "../../ui/fields";
import type { FieldProps, FieldSpec } from "../../ui/props/spec";
import { selectFaces } from "../../kernel/selectors";
import type { FaceSelector } from "../../doc/types";
import { HOLE_SIZES, screwSize, threadCallout } from "../hole/standards";
import type { UiOp } from "../uiDefs";
import { EXTERNAL_CLASS, sizeFor, SLOW_TURNS } from "./profile";

type Raw = Record<string, unknown>;

/** The size the thread is: its own, else the one its face fits on the part shown; and whether it is inside a hole. */
export function threadSize(f: Raw, view: FieldProps["view"]): { size?: string; pitch?: number; internal?: boolean; length?: number } {
  const face = f.face && view ? selectFaces(view.faces, f.face as FaceSelector).matches[0] : undefined;
  const cyl = face?.cylinder;
  const fitted = cyl ? sizeFor(2 * cyl.radius, cyl.concave) : undefined;
  const size = typeof f.size === "string" ? f.size : fitted?.size;
  const std = size ? screwSize(size) : undefined;
  const pitch = typeof f.pitch === "number" ? f.pitch : std?.pitch;
  const length = typeof f.length === "number" ? f.length : cyl ? cyl.axial[1] - cyl.axial[0] : undefined;
  return { size, pitch, internal: cyl?.concave, length };
}

function Callout(p: FieldProps) {
  const t = threadSize(p.resolved, p.view);
  const std = t.size ? screwSize(t.size) : undefined;
  if (!std || t.pitch === undefined) {
    return (
      <Field label="Callout">
        <span className="readout" data-testid="prop-thread-callout">
          Pick a round face (a shaft, or a hole's wall) that fits a size, or choose the size
        </span>
      </Field>
    );
  }
  const text = threadCallout({ designation: `${std.size}×${t.pitch}${p.resolved.leftHanded ? " LH" : ""}`, major: std.d, pitch: t.pitch, class: t.internal ? "6H" : EXTERNAL_CLASS, depth: t.length ?? "through" });
  const turns = t.length !== undefined ? t.length / t.pitch : 0;
  return (
    <>
      <Field label="Callout" hint={t.internal ? "An internal thread, in the hole's wall" : "An external thread, on the shaft"}>
        <span className="readout" data-testid="prop-thread-callout">
          {text}
        </span>
      </Field>
      {p.resolved.modelled === true && turns > SLOW_TURNS && (
        <span className="field-hint warning" data-testid="prop-thread-slow">
          {Math.round(turns)} turns: a modelled thread this long rebuilds slowly. A cosmetic thread shows and calls out the same.
        </span>
      )}
    </>
  );
}

export const THREAD_FIELDS: FieldSpec[] = [
  { kind: "face", key: "face", label: "Face", testId: "prop-thread-face", hint: "A shaft (external thread) or a hole's wall (internal)", prompt: "Pick the round face to thread: a shaft or a hole" },
  {
    kind: "select",
    key: "size",
    label: "Size",
    options: [["", "The size the face fits"], ...HOLE_SIZES.map((s): [string, string] => [s, s])],
    testId: "prop-thread-size",
    get: (f) => (typeof f.size === "string" ? f.size : ""),
    set: (v) => ({ size: v ? v : null, pitch: null }),
  },
  { kind: "number", key: "pitch", label: "Pitch", unit: "mm", min: 0, testId: "prop-thread-pitch", hint: "Empty: the size's coarse pitch" },
  { kind: "number", key: "length", label: "Length", unit: "mm", min: 0, testId: "prop-thread-length", hint: "From its start; empty: the whole face" },
  { kind: "bool", key: "reverse", label: "Start from the other end", testId: "prop-thread-reverse" },
  { kind: "bool", key: "modelled", label: "Modelled (cut the thread)", testId: "prop-thread-modelled", hint: "Off: cosmetic, shown in the view and called out on drawings, nothing cut", set: (v) => (v ? { modelled: true } : { modelled: null, chamfer: null }) },
  { kind: "bool", key: "chamfer", label: "Run-out chamfer at the start", testId: "prop-thread-chamfer", when: (f) => f.modelled === true },
  { kind: "bool", key: "leftHanded", label: "Left hand", testId: "prop-thread-left" },
  { kind: "custom", key: "callout", label: "Callout", render: (p) => <Callout {...p} /> },
];

export const ui: UiOp = {
  op: "thread",
  label: "Thread",
  icon: "thread",
  fields: THREAD_FIELDS,
  summary: (f) => [typeof f.size === "string" ? f.size : null, f.modelled ? "modelled" : "cosmetic"].filter(Boolean).join(" "),
};
