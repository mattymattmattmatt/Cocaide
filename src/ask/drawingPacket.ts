// The packet for a right-click on the sheet (Phase L): a view, one
// annotation, or the drawing. It holds what the agent needs to annotate and
// nothing more: the view's direction and scale, where the nodes, members and
// holes it shows are on the sheet, the annotations already there with what
// they read, and the drawing checks.

import { threadCallout } from "../features/hole/standards";
import type { RawDocument } from "../doc/commands";
import type { Annotation, Drawing, Vec2 } from "../doc/types";
import { validateDocument } from "../doc/validate";
import { partProperties } from "../doc/properties";
import { drawingChecks } from "../drafting/checks";
import { allAnnotations, findAnnotation, findView, sheetHolding } from "../doc/drawing";
import { composeDrawing, viewToSheet, type ComposedSheet } from "../drafting/compose";
import { listGeoRefs } from "../drafting/georef";
import { visibleLength } from "../drafting/plan";
import { viewSpecs } from "../drafting/specs";
import { inView } from "../drafting/views";
import { round6 } from "../kernel/inspect";
import type { CheckResult, DrawingGeometry, KernelPort } from "./kernel";
import type { AskTarget, Packet } from "./packet";
import { detailState } from "./detail/execute";
import { inferIntent } from "./detail/intent";
import { drawingContext } from "./detail/packet";

type DrawingTarget = Extract<AskTarget, { kind: "view" | "annotation" | "table" | "sheet" | "drawing" }>;

const r1 = (x: number) => Math.round(x * 10) / 10 + 0;
const at = (p: Vec2): Vec2 => [r1(p[0]), r1(p[1])];

export interface DrawingState {
  drawing: Drawing;
  /** The first sheet (or the one asked for). */
  sheet: ComposedSheet;
  sheets: ComposedSheet[];
  geometry: DrawingGeometry | null;
}

/** The drawing composed as the app shows it, for a packet or a check. `holding`: the sheet with this view or annotation. */
export async function composeFor(doc: RawDocument, kernel: KernelPort, check: CheckResult, holding?: string, sheetId?: string): Promise<DrawingState | null> {
  const drawing = validateDocument(doc).drawing;
  if (!drawing) return null;
  const geometry = await kernel.project(doc, viewSpecs(drawing));
  const composed = composeDrawing(doc, { measurements: check.measurements, geometry });
  if (!composed || !composed.sheets.length) return null;
  const id = sheetId ?? (holding ? sheetHolding(drawing, holding)?.id : undefined);
  const sheet = composed.sheets.find((x) => x.id === id) ?? composed.sheets[0];
  return { drawing, sheet, sheets: composed.sheets, geometry };
}

export async function drawingPacket(doc: RawDocument, target: DrawingTarget, kernel: KernelPort, check: CheckResult, label: string, writeScope: string[], opts: { compact?: boolean } = {}): Promise<Packet> {
  const state = await composeFor(doc, kernel, check, target.kind === "drawing" ? undefined : target.kind === "sheet" ? undefined : target.id, target.kind === "sheet" ? target.id : undefined);
  if (!state) throw new Error("the part has no drawing: make one first (New drawing)");
  const { drawing, sheet, sheets, geometry } = state;
  const checks = drawingChecks(sheets, doc, check.measurements, geometry);
  const reads = (a: Annotation) => {
    const c = sheets.flatMap((x) => x.annotations).find((x) => x.id === a.id);
    return { ...a, ...(c?.problem ? { problem: c.problem } : { reads: c?.text ?? "" }) };
  };
  const m = check.measurements;
  const measurements = {
    overallSize: m?.boundingBox?.size.map(round6) ?? null,
    ...(sheet.cutList.length ? { cutList: sheet.cutList.map((i) => ({ item: i.item, size: i.designation, length: i.length, quantity: i.quantity, members: i.members })) } : {}),
  };
  const brief = (sh: ComposedSheet) => ({
    id: sh.id,
    name: sh.name,
    size: sh.size,
    template: sh.template,
    scale: sh.scaleText,
    projection: sh.projection,
    views: sh.views.map((v) => ({ id: v.id, kind: v.kind, look: v.look, ...(v.parent ? { parent: v.parent } : {}), ...(v.label ? { label: v.label } : {}), scale: v.scaleText })),
  });
  const sheetBrief = { ...brief(sheet), ...(sheets.length > 1 ? { otherSheets: sheets.filter((x) => x !== sheet).map(brief) } : {}), ...(drawing.standard ? { standard: drawing.standard } : {}), ...(drawing.generalTolerance ? { generalTolerance: drawing.generalTolerance } : {}) };
  // The part's properties: the title block shows them where the sheet sets nothing of its own (setProperties changes them).
  const properties = partProperties(doc);
  // What else the user had selected on the sheet: each with what it is (wave Q2B).
  const selected = (target.selection ?? []).flatMap((sid): Record<string, unknown>[] => {
    const v = findView(drawing, sid);
    if (v) return [{ id: sid, is: "view", kind: v.kind ?? "model" }];
    const a = findAnnotation(drawing, sid);
    if (a) return [{ ...reads(a), is: "annotation" }];
    const t = drawing.sheets.flatMap((x) => x.tables ?? []).find((x) => x.id === sid);
    return t ? [{ id: sid, is: "table", kind: t.kind }] : [];
  });
  // Packet v2 (wave Q3B): the part's design intent and features, each view's GeoRefs in a line, annotations with their effective tolerances, the critic.
  const detailing = target.kind === "drawing" || target.kind === "sheet" || target.kind === "view" ? await detailingOf(doc, kernel, check, sheet.id, target.kind === "view" ? target.id : undefined, !!opts.compact) : null;
  const base = { units: "mm" as const, writeScope, checks, ...(detailing ? { detailing } : {}), error: sheet.problems.length ? sheet.problems.join("; ") : null, ...(Object.keys(properties).length ? { properties } : {}), ...(selected.length ? { selection: selected } : {}) };

  if (target.kind === "table") {
    const t = drawing.sheets.flatMap((x) => x.tables ?? []).find((x) => x.id === target.id);
    if (!t) throw new Error(`no table "${target.id}" in the drawing`);
    const box = sheets.flatMap((x) => x.blocks).find((b) => b.id === t.id)?.box;
    return {
      target: { kind: "table", id: t.id, label },
      ...base,
      table: { ...t, ...(box ? { onSheet: { min: at(box.min), max: at(box.max) } } : {}), problems: sheet.problems.filter((p) => p.startsWith(`${t.id}:`)) },
      parent: { sheet: sheetBrief },
      children: [],
      measurements,
    };
  }
  if (target.kind === "drawing" || target.kind === "sheet") {
    return {
      target: { kind: target.kind, ...(target.kind === "sheet" ? { id: target.id } : {}), label },
      ...base,
      drawing: { ...sheetBrief, annotations: allAnnotations(drawing).map(reads) },
      parent: null,
      children: [],
      measurements,
    };
  }
  if (target.kind === "view") {
    const view = findView(drawing, target.id);
    if (!view) throw new Error(`no view "${target.id}" in the drawing`);
    return {
      target: { kind: "view", id: view.id, label },
      ...base,
      view: viewSummary(doc, view.id, sheet, geometry, check),
      parent: { sheet: sheetBrief },
      children: allAnnotations(drawing).filter((a) => "view" in a && a.view === view.id).map(reads),
      measurements,
    };
  }
  const a = findAnnotation(drawing, target.id);
  if (!a) throw new Error(`no annotation "${target.id}" in the drawing`);
  return {
    target: { kind: "annotation", id: a.id, type: a.type, label },
    ...base,
    annotation: reads(a),
    parent: "view" in a && a.view ? { view: viewSummary(doc, a.view, sheet, geometry, check) } : { sheet: sheetBrief },
    children: [],
    measurements,
  };
}

/** The v2 context (src/ask/detail/packet.ts), or nothing when the part cannot be read for it. */
async function detailingOf(doc: RawDocument, kernel: KernelPort, check: CheckResult, sheet: string, view: string | undefined, compact: boolean) {
  try {
    const state = await detailState(doc, kernel, { check, sheet });
    const intent = inferIntent(doc, check.measurements, state.geometry?.holes ?? [], state.topology);
    return drawingContext(state, intent, { compact, ...(view ? { view } : {}) });
  } catch {
    return null;
  }
}

/** A view as the agent needs it: how it looks and where things are in it on the sheet. */
function viewSummary(doc: RawDocument, id: string, sheet: ComposedSheet, geometry: DrawingGeometry | null, check: CheckResult) {
  const cv = sheet.views.find((v) => v.id === id);
  if (!cv) return { id, missing: "not on the sheet" };
  const f = cv.frame;
  const ortho = cv.square;
  const place = (p: [number, number, number]) => at(viewToSheet(cv, inView(p, f)));
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
  // What the view offers to attach to (edges, their ends, circle centres), by GeoRef: the first 80.
  const refs = listGeoRefs(sheet, id).filter((r) => r.visible);
  return {
    id,
    kind: cv.kind,
    look: cv.look,
    scale: cv.scaleText,
    orthographic: ortho,
    geoRefs: refs.slice(0, 80).map((r) => ({ ref: r.ref, what: r.what, at: at(r.at), ...(r.feature ? { feature: r.feature } : {}), ...(r.length !== undefined ? { length: round6(r.length) } : {}), ...(r.radius !== undefined ? { radius: round6(r.radius) } : {}) })),
    ...(refs.length > 80 ? { moreGeoRefs: refs.length - 80 } : {}),
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
              ...(h.size ? { size: h.size } : {}),
              ...(h.thread ? { thread: threadCallout(h.thread) } : {}),
              seenAsCircle: Math.abs(h.axis[0] * f.eye[0] + h.axis[1] * f.eye[1] + h.axis[2] * f.eye[2]) > 0.999,
            })),
          }
        : {}),
    },
  };
}
