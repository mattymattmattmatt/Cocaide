// STEP export and import through OCCT's own translator (AP214, the OCCT default).

import type { TopoDS_Shape } from "replicad-opencascadejs";
import { type OC, scoped } from "./oc";

let counter = 0;

/** Returns the STEP file text. Lengths are written in millimetres. `description` goes in the header. */
export function exportSTEP(oc: OC, shape: TopoDS_Shape, name: string, description?: string | null): string {
  const path = `/cocaide-export-${++counter}.step`;
  const productName = stepSafe(name);
  return scoped((s) => {
    // The writer's constructor registers the STEP statics, so set them afterwards.
    const writer = s.track(new oc.STEPControl_Writer());
    oc.Interface_Static.SetCVal("write.step.unit", "MM");
    oc.Interface_Static.SetCVal("write.step.product.name", productName);
    const progress = s.track(new oc.Message_ProgressRange());
    writer.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true, progress);
    const status = writer.Write(path);
    if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error(`STEP write failed (${String(status)})`);
    const bytes = oc.FS.readFile(path) as Uint8Array;
    oc.FS.unlink(path);
    let text = new TextDecoder().decode(bytes);
    // OCCT suffixes the product with a per-session counter (" 1", " 2", ...); keep the name exact.
    text = text.replace(new RegExp(`'${escapeRegExp(productName)} \\d+'`, "g"), `'${productName}'`);
    text = text.replace("FILE_NAME('Open CASCADE Shape Model'", `FILE_NAME('${productName}.step'`);
    if (description) text = text.replace(/FILE_DESCRIPTION\(\('[^']*'\)/, () => `FILE_DESCRIPTION(('${stepString(description)}')`);
    return text;
  });
}

/** Reads a STEP file back into one shape. */
export function importSTEP(oc: OC, data: string | Uint8Array): TopoDS_Shape {
  const path = `/cocaide-import-${++counter}.step`;
  oc.FS.writeFile(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
  try {
    return scoped((s) => {
      const reader = s.track(new oc.STEPControl_Reader());
      const status = reader.ReadFile(path);
      if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error(`STEP read failed (${String(status)})`);
      const progress = s.track(new oc.Message_ProgressRange());
      const roots = reader.TransferRoots(progress);
      if (roots < 1) throw new Error("STEP file contained no transferable shape");
      return reader.OneShape();
    });
  } finally {
    oc.FS.unlink(path);
  }
}

/** STEP strings are ISO 8859-1 with '' for a quote; keep to plain printable ASCII. */
function stepSafe(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/'/g, "_").trim();
  return ascii || "cocaide-part";
}

/** Text for a STEP string: plain ASCII, a quote doubled. */
function stepString(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, "_").replace(/'/g, "''");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
