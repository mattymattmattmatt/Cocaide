// Files in and out, on the Bodies tab (Phase P): Import STEP (a file's solids
// as bodies of this part), Export plates (every flat plate as a DXF for
// cutting, with an overview and a cutting list, in a ZIP), and Face to DXF
// (a flat face's outline in its own plane; also on a flat face's right-click).

import { validateDocument } from "../../../doc/validate";
import { writeDxf } from "../../../io/dxf";
import { plateFiles, platesSummary } from "../../../io/plates";
import { zipFiles } from "../../../io/zip";
import { importFeature } from "../../files/plan";
import type { ToolCtx, ToolDef } from "../ToolContext";

export const STEP_ACCEPT = ".step,.stp,.STEP,.STP";

const noFiles = (ctx: ToolCtx) => ctx.notice("Files can't be read or saved here.");

/** Asks for a STEP file and adds it to the part as an import (its bodies named after the file). */
export async function importStep(ctx: ToolCtx): Promise<void> {
  if (!ctx.files) return noFiles(ctx);
  const file = await ctx.files.pick(STEP_ACCEPT);
  if (!file) return;
  const made = importFeature(ctx.doc, file.name, await file.text());
  if (typeof made === "string") return ctx.notice(made);
  ctx.files.fit?.();
  ctx.create(made.feature);
  // As a drop says it: what came in, and where to place it.
  ctx.notice(`Imported ${file.name}${made.warning ? `. ${made.warning}` : ": move or turn it in Properties"}`, "info");
}

/** Every flat plate as a DXF for cutting: one plate alone as its DXF; several as a ZIP with an overview and a cutting list. */
export async function exportPlates(ctx: ToolCtx): Promise<void> {
  if (!ctx.files) return noFiles(ctx);
  if (!ctx.view?.bodies.length) return ctx.notice("There is no solid yet: make or import a plate first.");
  // Named and weighed as the part is now, not as it may be when the kernel answers.
  const base = ctx.files.base();
  const density = (ctx.doc ? validateDocument(ctx.doc).material?.densityKgPerM3 : undefined) ?? 7850;
  const r = await ctx.files.flat({ kind: "plates" });
  if (r.kind === "error") return ctx.notice(`Plates not exported: ${r.error}.`);
  if (r.kind !== "plates") return;
  const others = r.others.length ? ` Not flat plates (left out): ${r.others.map((o) => o.body).join(", ")}.` : "";
  if (r.plates.length === 0) {
    const why = r.others.length === 1 ? ` ${r.others[0].body} is ${r.others[0].why.replace(/^not a flat plate: /, "not one: ")}.` : others;
    return ctx.notice(`No flat plates to export: a plate is a flat body of one thickness with square edges (an end cap, gusset, base plate or flat bar).${why}`);
  }
  const files = plateFiles(r.plates, base, { density });
  if (r.plates.length === 1 && r.plates[0].bodies.length === 1) {
    ctx.files.save(files[0].name, files[0].data, "image/vnd.dxf");
    return ctx.notice(`Exported ${files[0].name}: ${platesSummary(r.plates)}, laid flat at the origin, mm, layer CUT.${others}`, "info");
  }
  const name = `${base}-plates.zip`;
  ctx.files.save(name, zipFiles(files), "application/zip");
  ctx.notice(`Exported ${name}: ${platesSummary(r.plates)}, a DXF per plate (thickness and quantity in its name), an overview and a cutting list.${others}`, "info");
}

/** A flat face's outline as a DXF, in the face's own plane (as a sketch on that face sees it). */
export async function exportFaceDxf(ctx: ToolCtx, index = ctx.selection.faces[0]): Promise<void> {
  if (!ctx.files) return noFiles(ctx);
  const face = index === undefined ? undefined : ctx.view?.faces[index];
  if (!face || face.type !== "plane") return ctx.notice("Click a flat face first, then Face to DXF (or right-click the face).");
  const base = ctx.files.base();
  const r = await ctx.files.flat({ kind: "face", face: index! });
  if (r.kind === "error") return ctx.notice(`Face not exported: ${r.error}.`);
  if (r.kind !== "face") return;
  const name = `${base}-face${r.body ? `-${r.body}` : ""}.dxf`;
  ctx.files.save(name, writeDxf({ entities: r.entities, layers: [{ name: "CUT", color: 7 }] }), "image/vnd.dxf");
  const loops = r.entities.filter((e) => e.type === "circle" || (e.type === "polyline" && e.closed) || e.type === "ellipse" || e.type === "spline").length;
  ctx.notice(`Exported ${name}: the face's outline${loops > 1 ? ` and ${loops - 1} inner loop${loops > 2 ? "s" : ""}` : ""} in its own plane, mm (the sketch frame of that face).`, "info");
}

const flatFace = (ctx: ToolCtx, index: number) => ctx.view?.faces[index]?.type === "plane";

export const tools: ToolDef[] = [
  {
    id: "tool.importStep",
    label: "Import STEP…",
    icon: "import",
    tab: "bodies",
    group: "files",
    title: "Import a STEP file (.step, .stp): each solid in it becomes a body of this part, placed at the origin (move or turn it in Properties)",
    hint: "A STEP file's solids as bodies",
    testId: "tool-import-step",
    run: (ctx) => void importStep(ctx),
  },
  {
    id: "tool.exportPlates",
    label: "Export plates (DXF)…",
    icon: "plates",
    tab: "bodies",
    group: "files",
    title: "Every flat plate (end caps, gussets, base plates, flat bars) laid flat as a DXF for laser, plasma or waterjet: a ZIP of one DXF per plate, an overview and a cutting list",
    hint: "Flat plates as DXF for cutting",
    testId: "tool-export-plates",
    disabled: (ctx) => (ctx.view && ctx.view.bodies.length === 0 ? "There is no solid yet" : undefined),
    run: (ctx) => void exportPlates(ctx),
  },
  {
    id: "tool.exportFaceDxf",
    label: "Face to DXF",
    icon: "dxfExport",
    tab: "bodies",
    group: "files",
    title: "Export the clicked flat face's outline as a DXF, in its own plane (holes and cut-outs included)",
    hint: "A flat face's outline as DXF",
    testId: "tool-export-face-dxf",
    run: (ctx) => void exportFaceDxf(ctx),
    contextItems: (ctx, t) =>
      t.kind === "face" && flatFace(ctx, t.index)
        ? [{ label: "Export face as DXF", icon: "dxfExport", hint: "The face's outline in its own plane, for cutting or a sketch elsewhere", testId: "ctx-export-face-dxf", run: (c) => void exportFaceDxf(c, t.index) }]
        : [],
  },
];
