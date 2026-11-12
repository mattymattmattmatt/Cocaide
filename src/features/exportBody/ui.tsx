// Export body's properties: the bodies (clicked in the view, or ticked), the
// file's origin (a point picked in the view when "a point"), up and front
// (a face or edge picked in the view, or a default plane or axis), Z up or
// Y up, the file name, where the bodies will sit in the file, and Export STEP.

import type { Vec3 } from "../../doc/types";
import { toFile, type ExportFrame } from "../../geom/exportFrame";
import { Field, TextInput } from "../../ui/fields";
import { runExportBody } from "../../ui/exportBodyAction";
import type { UiOp } from "../uiDefs";
import type { FieldProps } from "../../ui/props/spec";

type Raw = Record<string, unknown>;
const fmt = (x: number) => (Math.round(x * 1000) / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 });

/** Where the chosen bodies will sit in the file, from the rebuilt frame and their boxes. */
function fileExtent(p: FieldProps): string | null {
  const d = p.view?.datums?.[String(p.f.id)];
  if (!d || d.kind !== "frame") return null;
  const frame: ExportFrame = { origin: d.origin, x: d.x, y: d.y, z: d.z };
  const names = Array.isArray(p.f.bodies) ? (p.f.bodies as string[]) : (p.view?.bodies ?? []).map((b) => b.name);
  const boxes = (p.view?.measurements?.bodies ?? []).filter((b) => names.includes(b.name) && b.boundingBox).map((b) => b.boundingBox!);
  if (!boxes.length) return null;
  const pts: Vec3[] = [];
  for (const b of boxes) for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) pts.push(toFile(frame, [x, y, z]));
  const r = [0, 1, 2].map((i) => `${"XYZ"[i]} ${fmt(Math.min(...pts.map((q) => q[i])))} to ${fmt(Math.max(...pts.map((q) => q[i])))}`);
  return r.join(", ");
}

export const ui: UiOp = {
  op: "exportBody",
  label: "Export body",
  icon: "export",
  fields: [
    { kind: "bodies", key: "bodies", label: "Bodies", allowEmpty: true, emptyHint: "none ticked: every body", testId: "prop-export-bodies", prompt: "Click the bodies to export in the view" },
    {
      kind: "select",
      key: "origin",
      label: "Origin",
      testId: "prop-export-origin",
      options: [
        ["model", "the model's origin (as modelled)"],
        ["centre", "the centre of the bodies' box"],
        ["bottom", "the middle of their bottom (lowest along Up)"],
        ["point", "a point (pick it in the view)"],
      ],
      default: "model",
      omitDefault: true,
      set: (v: unknown, f: Raw) => (v === "point" ? { origin: "point", ...(f.point ? {} : { point: { datum: "Origin" } }) } : { origin: v === "model" ? null : v, point: null }),
    },
    {
      kind: "datumRef",
      key: "point",
      label: "Point",
      accepts: ["point"],
      testId: "prop-export-point",
      hint: "A vertex, an edge's midpoint, a circle's centre (the Vertices filter snaps to midpoints and centres)",
      prompt: "Pick the file's origin: a vertex, an edge's midpoint or a circle (its centre)",
      when: (f: Raw) => f.origin === "point",
    },
    {
      kind: "datumRef",
      key: "up",
      label: "Up",
      accepts: ["axis", "plane"],
      optional: true,
      testId: "prop-export-up",
      hint: "An edge or axis (along it), or a flat face or plane (its normal); none: +Z",
      prompt: "Pick what is up: a flat face (its normal) or an edge",
    },
    { kind: "bool", key: "reverseUp", label: "Reverse up", testId: "prop-export-reverse-up" },
    {
      kind: "datumRef",
      key: "front",
      label: "Front faces",
      accepts: ["axis", "plane"],
      optional: true,
      testId: "prop-export-front",
      hint: "The way the front faces: a flat face (its normal) or an edge; none: the Front plane's normal (−Y)",
      prompt: "Pick the way the front faces: a flat face (its normal) or an edge",
    },
    { kind: "bool", key: "reverseFront", label: "Reverse front", testId: "prop-export-reverse-front" },
    {
      kind: "select",
      key: "convention",
      label: "For",
      testId: "prop-export-convention",
      options: [
        ["zUp", "Z up (most CAD and CAM): up is +Z, the front faces −Y"],
        ["yUp", "Y up (many mesh tools): up is +Y, the front faces +Z"],
      ],
      default: "zUp",
      omitDefault: true,
    },
    {
      kind: "custom",
      key: "fileName",
      label: "File name",
      render: (p) => {
        const names = Array.isArray(p.f.bodies) ? (p.f.bodies as string[]) : [];
        const base = typeof p.doc.name === "string" && p.doc.name.trim() ? p.doc.name.trim() : "part";
        const placeholder = names.length === 1 ? `${base}-${names[0]}` : base;
        return (
          <Field label="File name" hint={`.step is added; empty: ${placeholder}`}>
            <TextInput value={typeof p.f.fileName === "string" ? p.f.fileName : ""} onCommit={(v) => void p.update({ fileName: v.trim() ? v.trim() : null })} testId="prop-export-name" />
          </Field>
        );
      },
    },
    {
      kind: "custom",
      key: "export",
      label: "Export",
      render: (p) => {
        const extent = fileExtent(p);
        return (
          <>
            <Field label="In the file">
              <span className="readout" data-testid="prop-export-where">
                {extent ?? "not worked out: see the error above"}
              </span>
            </Field>
            <div className="field">
              <span className="field-label" />
              <button type="button" className="primary" disabled={!extent} onClick={() => runExportBody(String(p.f.id))} data-testid="prop-export-go" title="Write the bodies to a STEP file, placed as set here">
                Export STEP
              </button>
            </div>
          </>
        );
      },
    },
  ],
  summary: (f) => {
    const n = Array.isArray(f.bodies) ? (f.bodies as string[]) : null;
    return `${n ? (n.length === 1 ? n[0] : `${n.length} bodies`) : "all bodies"}${f.origin || f.up || f.front || f.convention ? ", re-placed" : ""}`;
  },
};
