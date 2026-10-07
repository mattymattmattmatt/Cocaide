// STEP export and import through OCCT's own translator (AP214, the OCCT default).
// A part of several bodies goes out as an assembly of named solids (XCAF), so
// the next tool shows "base" and "upright", not "Solid1" and "Solid2".

import type { TopoDS_Shape } from "replicad-opencascadejs";
import { type OC, scoped } from "./oc";

let counter = 0;

/**
 * Returns the STEP file text. Lengths are written in millimetres. `description`
 * goes in the header. With more than one body, each is its own named solid.
 */
export function exportSTEP(oc: OC, shape: TopoDS_Shape, name: string, description?: string | null, bodies?: { name: string; shape: TopoDS_Shape }[]): string {
  if (bodies && bodies.length > 1) return exportNamed(oc, name, bodies, description);
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

/** An assembly named after the part, with one named component per body. */
function exportNamed(oc: OC, name: string, bodies: { name: string; shape: TopoDS_Shape }[], description?: string | null): string {
  const path = `/cocaide-export-${++counter}.step`;
  return scoped((s) => {
    const text = (v: string) => s.track(new oc.TCollection_ExtendedString(stepSafe(v), false));
    // The document is not tracked: OCCT owns it through its handle, and deleting it here would crash.
    const doc = new oc.TDocStd_Document(text("XmlXCAF"));
    const shapes = oc.XCAFDoc_DocumentTool.ShapeTool(s.track(doc.Main()));
    const assembly = s.track(shapes.NewShape());
    oc.TDataStd_Name.Set(assembly, text(name));
    for (const b of bodies) {
      const label = s.track(shapes.AddShape(b.shape, false, false));
      oc.TDataStd_Name.Set(label, text(b.name));
      oc.TDataStd_Name.Set(s.track(shapes.AddComponent(assembly, label, s.track(new oc.TopLoc_Location()))), text(b.name));
    }
    shapes.UpdateAssemblies();
    oc.Interface_Static.SetCVal("write.step.unit", "MM");
    const writer = s.track(new oc.STEPCAFControl_Writer());
    writer.SetNameMode(true);
    if (!writer.Perform(doc, path, s.track(new oc.Message_ProgressRange()))) throw new Error("STEP write failed");
    const bytes = oc.FS.readFile(path) as Uint8Array;
    oc.FS.unlink(path);
    let out = new TextDecoder().decode(bytes);
    out = out.replace("FILE_NAME('Open CASCADE Shape Model'", `FILE_NAME('${stepSafe(name)}.step'`);
    if (description) out = out.replace(/FILE_DESCRIPTION\(\('[^']*'\)/, () => `FILE_DESCRIPTION(('${stepString(description)}')`);
    return out;
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
