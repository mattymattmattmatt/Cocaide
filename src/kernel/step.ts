// STEP export and import through OCCT's own translator (AP214, the OCCT default).
// A part of several bodies goes out as an assembly of named solids (XCAF), so
// the next tool shows "base" and "upright", not "Solid1" and "Solid2".
// Import (readStepSolids) reads any STEP into its solids, in mm whatever units
// the file used, repaired where it needs it; a file of surfaces is sewn and
// kept if it closes into solids.

import type { STEPControl_Reader, TopoDS_Shape } from "replicad-opencascadejs";
import { type OC, type Scope, scoped } from "./oc";
import { isValidShape, volumeOf } from "./measure";
import { copyOut } from "./ops";

let counter = 0;

/** What else a STEP file can say about the part: who drew it, and the product's own description. */
export interface StepExtra {
  author?: string | null;
  productDescription?: string | null;
}

/**
 * Returns the STEP file text. Lengths are written in millimetres. `description`
 * goes in the header. With more than one body, each is its own named solid.
 * `extra`: the author (FILE_NAME) and the product's description (PRODUCT).
 */
export function exportSTEP(
  oc: OC,
  shape: TopoDS_Shape,
  name: string,
  description?: string | null,
  bodies?: { name: string; shape: TopoDS_Shape }[],
  extra: StepExtra = {},
): string {
  if (bodies && bodies.length > 1) return finish(exportNamed(oc, name, bodies, description), name, extra);
  const path = `/cocaide-export-${++counter}.step`;
  const productName = stepSafe(name);
  return finish(
    scoped((s) => {
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
    }),
    name,
    extra,
  );
}

/** The author into FILE_NAME and the description into the part's (or assembly's) PRODUCT. */
function finish(text: string, name: string, extra: StepExtra): string {
  let out = text;
  if (extra.author) out = out.replace(/(FILE_NAME\('[^']*','[^']*',\()'[^']*'\)/, (_m, head: string) => `${head}'${stepString(extra.author!)}')`);
  if (extra.productDescription) {
    const product = stepSafe(name);
    out = out.replace(`PRODUCT('${product}','${product}',''`, () => `PRODUCT('${product}','${product}','${stepString(extra.productDescription!)}'`);
  }
  return out;
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
  return withStepFile(oc, data, (s, reader) => {
    const progress = s.track(new oc.Message_ProgressRange());
    const roots = reader.TransferRoots(progress);
    if (roots < 1) throw new Error("STEP file contained no transferable shape");
    return reader.OneShape();
  });
}

/** Why a STEP file can't be imported: the message says what to do. */
export class StepImportError extends Error {}

/** A STEP file read into solids (see readStepSolids). */
export interface StepSolids {
  /** The solids, in the file's order, in mm. Owned by the caller: delete() each when done. */
  solids: TopoDS_Shape[];
  /** Solids the repair changed (orientation, small gaps). */
  repaired: number;
  /** The file held surfaces only, sewn into these solids. */
  sewn: boolean;
}

/**
 * Reads a STEP file into its solids, each repaired where it needs it (shell
 * orientation, small gaps) and checked to hold volume. A file with no solids
 * but surfaces that close is sewn into solids; one that does not close is
 * refused with how many open edges it has. Throws StepImportError with a
 * message that says what to do.
 */
export function readStepSolids(oc: OC, data: string | Uint8Array): StepSolids {
  return withStepFile(oc, data, (s, reader) => {
    const roots = reader.TransferRoots(s.track(new oc.Message_ProgressRange()));
    if (roots < 1 || reader.NbShapes() < 1) throw new StepImportError("the STEP file has nothing the reader can turn into a shape (no solids or surfaces in it)");
    const shape = s.track(reader.OneShape());
    let sewn = false;
    let found = subShapes(oc, s, shape, "TopAbs_SOLID");
    if (found.length === 0) {
      const faces = subShapes(oc, s, shape, "TopAbs_FACE");
      if (faces.length === 0) throw new StepImportError("the STEP file holds no solids and no surfaces (only curves or points?): export the part as a solid");
      found = sewIntoSolids(oc, s, shape, faces.length);
      sewn = true;
    }
    let repaired = 0;
    const solids: TopoDS_Shape[] = [];
    found.forEach((solid, i) => {
      const where = found.length > 1 ? `solid ${i + 1} of ${found.length}` : "the solid";
      let fixed = solid;
      if (!isValidShape(oc, s, solid) || volumeOf(oc, s, solid) <= 0) {
        const fix = s.track(new oc.ShapeFix_Solid(s.track(oc.TopoDS.Solid(solid))));
        fix.Perform(s.track(new oc.Message_ProgressRange()));
        const out = s.track(fix.Solid());
        // The fix may split a solid in two (multiconnexity): keep each piece.
        const pieces = subShapes(oc, s, out, "TopAbs_SOLID");
        if (pieces.length) {
          fixed = pieces.length === 1 ? pieces[0] : out;
          repaired++;
        }
      }
      for (const piece of fixed === solid ? [solid] : subShapes(oc, s, fixed, "TopAbs_SOLID")) {
        const v = volumeOf(oc, s, piece);
        if (!(v > 1e-9)) throw new StepImportError(`${where} in the STEP file holds no volume (${v.toPrecision(3)} mm³) even after repair: export it again as a closed solid`);
        solids.push(copyOut(piece));
      }
    });
    return { solids, repaired, sewn };
  });
}

/** Sews the file's faces and keeps the closed shells as solids; refuses when none closes. */
function sewIntoSolids(oc: OC, s: Scope, shape: TopoDS_Shape, faceCount: number): TopoDS_Shape[] {
  const sewing = s.track(new oc.BRepBuilderAPI_Sewing(1e-3, true, true, true, false));
  sewing.Add(shape);
  sewing.Perform(s.track(new oc.Message_ProgressRange()));
  const sewnShape = s.track(sewing.SewedShape());
  const open = sewing.NbFreeEdges();
  const out: TopoDS_Shape[] = [];
  for (const shell of subShapes(oc, s, sewnShape, "TopAbs_SHELL")) {
    if (!oc.BRep_Tool.IsClosed(shell)) continue;
    const fix = s.track(new oc.ShapeFix_Solid());
    out.push(s.track(fix.SolidFromShell(s.track(oc.TopoDS.Shell(shell)))));
  }
  if (out.length === 0) {
    throw new StepImportError(
      `the STEP file holds surfaces only (${faceCount} face${faceCount === 1 ? "" : "s"}) and they do not close into a solid (${open} open edge${open === 1 ? "" : "s"} after sewing): export the part as a solid, or close the gaps in the program it came from`,
    );
  }
  return out;
}

/** Every sub-shape of a kind, tracked in s. */
function subShapes(oc: OC, s: Scope, shape: TopoDS_Shape, kind: "TopAbs_SOLID" | "TopAbs_SHELL" | "TopAbs_FACE"): TopoDS_Shape[] {
  const out: TopoDS_Shape[] = [];
  const ex = s.track(new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum[kind], oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
  for (; ex.More(); ex.Next()) out.push(s.track(ex.Current()));
  return out;
}

/** Writes the data to the in-memory file system, reads it with a STEP reader, and cleans up. */
function withStepFile<T>(oc: OC, data: string | Uint8Array, use: (s: Scope, reader: STEPControl_Reader) => T): T {
  const path = `/cocaide-import-${++counter}.step`;
  oc.FS.writeFile(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
  try {
    return scoped((s) => {
      const reader = s.track(new oc.STEPControl_Reader());
      const status = reader.ReadFile(path);
      if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
        throw new StepImportError(
          status === oc.IFSelect_ReturnStatus.IFSelect_RetVoid
            ? "the STEP file is empty: it has no entities to read"
            : `the STEP file could not be read (${String(status).replace("IFSelect_Ret", "").toLowerCase()}): it is damaged or not ISO 10303-21; export it again as STEP AP203, AP214 or AP242`,
        );
      }
      return use(s, reader);
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
