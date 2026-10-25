// Files in and out of the app (Phase P), in one place: what Open and a drop
// do with a STEP or DXF file (asking where it goes), the DXF exports of a
// sketch, and the file actions the model tools get (ToolFiles). App renders
// `dialogs` and wires the rest; the decisions are pure, in plan.ts.

import { useRef, useState, type ReactNode } from "react";
import type { KernelPort } from "../../ask/kernel";
import { formatDocument } from "../../doc/format";
import type { RawDocument } from "../../doc/commands";
import { exportBase } from "../../doc/properties";
import { resolvedDocument } from "../../doc/parameters";
import type { SketchEntity } from "../../doc/types";
import { writeDxf, type DxfRead } from "../../io/dxf";
import { sketchToDxf, type InsertOptions } from "../../io/dxfSketch";
import type { RebuildView } from "../../worker/protocol";
import type { ToolFiles } from "../model/ToolContext";
import { DxfInsertDialog, StepDropDialog, type DxfTarget } from "./FileDialogs";
import { pickFile, saveFile } from "./pick";
import { dxfPart, dxfSketch, fileKind, importFeature, readDxfFile, stepPart, stepSizeProblem } from "./plan";

/** What the sketcher does with a DXF read and the options chosen: puts it in its draft, and says what came in. */
export type SketchInsert = (read: DxfRead, opts: InsertOptions) => string;

interface Options {
  doc: RawDocument | null;
  /** The document the view on screen was built from (its face indices are the view's). */
  viewDoc(): unknown;
  view: RebuildView | null;
  kernel: KernelPort;
  notice(text: string, kind?: "info" | "error"): void;
  /** Loads a whole new document (Open): a fresh undo history. */
  openDocument(text: string, origin: string): void;
  /** Adds a feature to the part, selects it and opens its properties. */
  create(feature: Record<string, unknown>): void;
  /** The sketch being edited, if any. */
  sketching: boolean;
  /** Fits the view to the part once the next rebuild comes in (a STEP's bodies can be far bigger than the part). */
  fit?(): void;
}

type Dialog =
  | { kind: "step"; fileName: string; text: string }
  | { kind: "dxf"; fileName: string; read: DxfRead; targets: DxfTarget[] };

export const OPEN_ACCEPT = ".json,.cocaide.json,application/json,.step,.stp,.STEP,.STP,.dxf,.DXF";

export function useFiles(o: Options) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  /** Set by the sketcher while one is open. */
  const sketchInsert = useRef<SketchInsert | null>(null);
  const latest = useRef(o);
  latest.current = o;

  const base = () => exportBase(latest.current.doc);

  const openStepAsPart = (fileName: string, text: string) => {
    const made = stepPart(fileName, text);
    if (typeof made === "string") return o.notice(made);
    latest.current.openDocument(formatDocument(made.doc), `Opened ${fileName} as a new part${made.warning ? `. ${made.warning}` : ""}`);
  };
  const insertStep = (fileName: string, text: string) => {
    const made = importFeature(latest.current.doc, fileName, text);
    if (typeof made === "string") return o.notice(made);
    latest.current.fit?.();
    latest.current.create(made.feature);
    latest.current.notice(`Imported ${fileName}${made.warning ? `. ${made.warning}` : ": move or turn it in Properties"}`, "info");
  };

  /** A STEP, DXF or part file from Open: a STEP or DXF opens as a new part (a DXF after its questions). True when it was one of these. */
  const open = async (file: File): Promise<boolean> => {
    const text = await file.text();
    const kind = fileKind(file.name, text.slice(0, 256));
    if (kind === "step") {
      const size = stepSizeProblem(text.length);
      if (size.refuse) o.notice(size.refuse);
      else openStepAsPart(file.name, text);
      return true;
    }
    if (kind === "dxf") {
      const read = readDxfFile(file.name, text);
      if (typeof read === "string") o.notice(read);
      else setDialog({ kind: "dxf", fileName: file.name, read, targets: ["newPart"] });
      return true;
    }
    return false;
  };

  /** A file dropped on the app: a STEP asks new part or body, a DXF where it goes. False when it is neither (the caller handles it). */
  const drop = async (file: File): Promise<boolean> => {
    const kind = fileKind(file.name);
    if (kind !== "step" && kind !== "dxf") return false;
    const text = await file.text();
    if (kind === "step") {
      if (latest.current.sketching) {
        o.notice("Finish or cancel the sketch first, then drop the STEP file.");
        return true;
      }
      const size = stepSizeProblem(text.length);
      if (size.refuse) o.notice(size.refuse);
      else setDialog({ kind: "step", fileName: file.name, text });
      return true;
    }
    const read = readDxfFile(file.name, text);
    if (typeof read === "string") o.notice(read);
    else setDialog({ kind: "dxf", fileName: file.name, read, targets: latest.current.sketching ? ["sketch"] : ["newSketch", "newPart"] });
    return true;
  };

  /** The sketcher's Insert DXF…: a file, then its questions, then into the draft. */
  const insertIntoSketch = async () => {
    const file = await pickFile(".dxf,.DXF");
    if (!file) return;
    const read = readDxfFile(file.name, await file.text());
    if (typeof read === "string") return o.notice(read);
    setDialog({ kind: "dxf", fileName: file.name, read, targets: ["sketch"] });
  };

  const placeDxf = (d: Extract<Dialog, { kind: "dxf" }>, target: DxfTarget, opts: InsertOptions) => {
    setDialog(null);
    if (target === "sketch") {
      const put = sketchInsert.current;
      if (!put) return o.notice("Open a sketch first: the drawing goes into the sketch being edited.");
      o.notice(`${put(d.read, opts)} from ${d.fileName}.`, "info");
      return;
    }
    if (target === "newPart") {
      const made = dxfPart(d.fileName, d.read, opts);
      latest.current.openDocument(formatDocument(made.doc), `${made.report} into a sketch on Top of a new part, from ${d.fileName}`);
      return;
    }
    const made = dxfSketch(latest.current.doc, d.read, opts);
    latest.current.create(made.feature);
    latest.current.notice(`${made.report} into ${String(made.feature.id)} on Top, from ${d.fileName}.`, "info");
  };

  /** A sketch's entities as a DXF download: profile, construction and points on their layers. */
  const exportSketch = (entities: SketchEntity[], id: string) => {
    if (!entities.length) return o.notice(`${id} is empty: draw something first.`);
    const name = `${base()}-${id}.dxf`;
    saveFile(name, writeDxf(sketchToDxf(entities)), "image/vnd.dxf");
    o.notice(`Exported ${name}: the sketch in its own plane, mm (profile on PROFILE, construction on CONSTRUCTION).`, "info");
  };

  /** A sketch of the part as DXF, by id: as the rebuild solved it (references where the model is), else as the document has it. */
  const exportSketchById = (id: string) => {
    const shown = latest.current.view?.sketches.find((k) => k.id === id);
    if (shown?.entities.length) return exportSketch(shown.entities, id);
    const doc = latest.current.doc;
    const f = doc ? (resolvedDocument(doc).features as Record<string, unknown>[]).find((x) => x.id === id) : undefined;
    exportSketch(Array.isArray(f?.entities) ? (f.entities as SketchEntity[]) : [], id);
  };

  const tool: ToolFiles = {
    pick: pickFile,
    save: saveFile,
    // A face by index belongs to the view's solid; plates are of the whole part, as STEP export is.
    flat: (query) => latest.current.kernel.flat(query.kind === "face" ? latest.current.viewDoc() : latest.current.doc, query),
    base,
    fit: () => latest.current.fit?.(),
  };

  let dialogs: ReactNode = null;
  if (dialog?.kind === "step") {
    const d = dialog;
    dialogs = (
      <StepDropDialog
        fileName={d.fileName}
        size={d.text.length}
        canInsert={!!o.doc}
        onOpen={() => {
          setDialog(null);
          openStepAsPart(d.fileName, d.text);
        }}
        onInsert={() => {
          setDialog(null);
          insertStep(d.fileName, d.text);
        }}
        onCancel={() => setDialog(null)}
      />
    );
  } else if (dialog?.kind === "dxf") {
    const d = dialog;
    dialogs = <DxfInsertDialog fileName={d.fileName} read={d.read} targets={d.targets} onInsert={(t, opts) => placeDxf(d, t, opts)} onCancel={() => setDialog(null)} />;
  }

  return { open, drop, insertIntoSketch, exportSketch, exportSketchById, sketchInsert, tool, dialogs, base };
}
