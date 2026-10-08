// The packet for a right-click on the sheet (Phase L): a view, one
// annotation, or the drawing. It holds what the agent needs to annotate and
// nothing more: the view's direction and scale, where the nodes, members and
// holes it shows are on the sheet, the annotations already there with what
// they read, and the drawing checks.

import type { RawDocument } from "../doc/commands";
import type { Annotation, Drawing, Vec2 } from "../doc/types";
import { validateDocument } from "../doc/validate";
import { drawingChecks } from "../drafting/checks";
import { composeSheet, type ComposedSheet, type ComposedView } from "../drafting/compose";
import { visibleLength } from "../drafting/plan";
import { inView, isOrthographic, viewFrame } from "../drafting/views";
import { round6 } from "../kernel/inspect";
import type { CheckResult, DrawingGeometry, KernelPort } from "./kernel";
import type { AskTarget, Packet } from "./packet";

type DrawingTarget = Extract<AskTarget, { kind: "view" | "annotation" | "drawing" }>;

const r1 = (x: number) => Math.round(x * 10) / 10 + 0;
const at = (p: Vec2): Vec2 => [r1(p[0]), r1(p[1])];

export interface DrawingState {
  drawing: Drawing;
  sheet: ComposedSheet;
  geometry: DrawingGeometry | null;
}

/** The drawing composed as the app shows it, for a packet or a check. */
export async function composeFor(doc: RawDocument, kernel: KernelPort, check: CheckResult): Promise<DrawingState | null> {
  const drawing = validateDocument(doc).drawing;
  if (!drawing) return null;
  const geometry = await kernel.project(
    doc,
    drawing.views.map((v) => ({ id: v.id, look: v.look })),
  );
  const sheet = composeSheet(doc, { measurements: check.measurements, geometry });
  return sheet ? { drawing, sheet, geometry } : null;
}

export async function drawingPacket(doc: RawDocument, target: DrawingTarget, kernel: KernelPort, check: CheckResult, label: string, writeScope: string[]): Promise<Packet> {
  const state = await composeFor(doc, kernel, check);
  if (!state) throw new Error("the part has no drawing: make one first (New drawing)");
  const { drawing, sheet, geometry } = state;
  const checks = drawingChecks(sheet, doc, check.measurements, geometry);
  const reads = (a: Annotation) => {
    const c = sheet.annotations.find((x) => x.id === a.id);
    return { ...a, ...(c?.problem ? { problem: c.problem } : { reads: c?.text ?? "" }) };
  };
  const m = check.measurements;
  const measurements = {
    overallSize: m?.boundingBox?.size.map(round6) ?? null,
    ...(sheet.cutList.length ? { cutList: sheet.cutList.map((i) => ({ item: i.item, size: i.designation, length: i.length, quantity: i.quantity, members: i.members })) } : {}),
  };
  const sheetBrief = { size: sheet.size, scale: sheet.scaleText, projection: sheet.projection, views: sheet.views.map((v) => ({ id: v.id, look: v.look, scale: v.scaleText })) };
  const base = { units: "mm" as const, writeScope, checks, error: sheet.problems.length ? sheet.problems.join("; ") : null };

  if (target.kind === "drawing") {
    return {
      target: { kind: "drawing", label },
      ...base,
      drawing: { ...sheetBrief, annotations: drawing.annotations.map(reads) },
      parent: null,
      children: [],
      measurements,
    };
  }
  if (target.kind === "view") {
    const view = drawing.views.find((v) => v.id === target.id);
    if (!view) throw new Error(`no view "${target.id}" in the drawing`);
    return {
      target: { kind: "view", id: view.id, label },
      ...base,
      view: viewSummary(doc, view.id, sheet, geometry, check),
      parent: { sheet: sheetBrief },
      children: drawing.annotations.filter((a) => "view" in a && a.view === view.id).map(reads),
      measurements,
    };
  }
  const a = drawing.annotations.find((x) => x.id === target.id);
  if (!a) throw new Error(`no annotation "${target.id}" in the drawing`);
  return {
    target: { kind: "annotation", id: a.id, type: a.type, label },
    ...base,
    annotation: reads(a),
    parent: "view" in a ? { view: viewSummary(doc, a.view, sheet, geometry, check) } : { sheet: sheetBrief },
    children: [],
    measurements,
  };
}

/** A view as the agent needs it: how it looks and where things are in it on the sheet. */
function viewSummary(doc: RawDocument, id: string, sheet: ComposedSheet, geometry: DrawingGeometry | null, check: CheckResult) {
  const cv = sheet.views.find((v) => v.id === id);
  if (!cv) return { id, missing: "not on the sheet" };
  const f = viewFrame(cv.look);
  const ortho = isOrthographic(cv.look);
  const place = (p: [number, number, number]) => at(toSheet(cv, inView(p, f)));
  const v = validateDocument(doc);
  const members = (check.measurements?.members ?? []).map((m) => {
    const a = inView(m.ends[0], f);
    const b = inView(m.ends[1], f);
    const flat = Math.hypot(b[0] - a[0], b[1] - a[1]) >= m.length * 0.999;
    const item = sheet.cutList.find((i) => i.members.includes(m.id))?.item;
    return {
      id: m.id,
      size: m.designation,
      length: m.length,
      ...(item ? { cutListItem: item } : {}),
      start: place(m.ends[0]),
      end: place(m.ends[1]),
      seen: visibleLength(geometry, id, m.body) > 1e-6,
      // A member's length can be dimensioned only where it lies flat in the view.
      liesFlat: ortho && flat,
    };
  });
  return {
    id,
    look: cv.look,
    scale: cv.scaleText,
    orthographic: ortho,
    ...(ortho ? {} : { note: "an iso view shortens lengths: no dimensions here" }),
    onSheet: cv.box ? { min: at(cv.box.min), max: at(cv.box.max) } : null,
    shows: {
      nodes: Object.fromEntries(Object.entries(v.nodes).map(([n, p]) => [n, place(p)])),
      ...(members.length ? { members } : {}),
      ...(geometry?.holes.length
        ? {
            holes: geometry.holes.map((h) => ({
              id: h.feature,
              at: place(h.entry),
              diameter: h.diameter,
              seenAsCircle: Math.abs(h.axis[0] * f.eye[0] + h.axis[1] * f.eye[1] + h.axis[2] * f.eye[2]) > 0.999,
            })),
          }
        : {}),
    },
  };
}

function toSheet(cv: ComposedView, p: Vec2): Vec2 {
  return [cv.centre[0] + (p[0] - cv.origin[0]) * cv.scale, cv.centre[1] + (p[1] - cv.origin[1]) * cv.scale];
}
