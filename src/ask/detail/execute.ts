// Carrying out a detailing plan (Phase Q wave Q3B): each ticked item turned
// into the document's own drawing commands (setDrawing, setView,
// setAnnotation, editAnnotation, setTable, setSheet, setDrawingOptions),
// applied in batches under the ask's write scope, each item kept only when
// its commands apply. The drawing is composed again between the batches
// (the views first, then sizes, datums and symbols, then the frames that
// hang under callouts), and last a readability pass moves what was added
// off whatever it lands on. Nothing here writes the user's document: the
// result is a list of commands the proposal (or the session) replays.

import { apply, type Command, type RawDocument } from "../../doc/commands";
import type { Annotation, Drawing, Vec2 } from "../../doc/types";
import { allAnnotations } from "../../doc/drawing";
import { validateDocument } from "../../doc/validate";
import { dragGrip } from "../../drafting/annotate";
import { composeDrawing, type ComposedDrawing, type ComposedSheet } from "../../drafting/compose";
import { overlaps, type Box } from "../../drafting/sheet";
import { viewSpecs } from "../../drafting/specs";
import type { CheckResult, DrawingGeometry, KernelPort, PartTopology } from "../kernel";
import { activeItems, type DetailPlan, type PlanItem } from "./plan";
import { notesFor } from "./notes";

/** The part and its drawing as the detailer sees them. */
export interface DetailState {
  doc: RawDocument;
  check: CheckResult;
  drawing: Drawing | null;
  geometry: DrawingGeometry | null;
  composed: ComposedDrawing | null;
  /** The sheet being detailed (the first, or the one asked for). */
  sheet: ComposedSheet | null;
  topology: PartTopology | null;
  /** The view specs the geometry was projected for (composing again reuses it while they hold). */
  specKey: string;
}

/** Composes the document's drawing (projecting its views). `sheetId`: the sheet to detail. */
export async function detailState(doc: RawDocument, kernel: KernelPort, opts: { check?: CheckResult; topology?: PartTopology | null; sheet?: string; geometry?: { key: string; geometry: DrawingGeometry | null } } = {}): Promise<DetailState> {
  const check = opts.check ?? (await kernel.check(doc));
  const topology = opts.topology !== undefined ? opts.topology : await kernel.topology(doc);
  const drawing = validateDocument(doc).drawing;
  if (!drawing) return { doc, check, drawing: null, geometry: null, composed: null, sheet: null, topology, specKey: "" };
  const specs = viewSpecs(drawing);
  const specKey = JSON.stringify(specs);
  const geometry = opts.geometry && opts.geometry.key === specKey ? opts.geometry.geometry : await kernel.project(doc, specs);
  const composed = composeDrawing(doc, { measurements: check.measurements, geometry });
  const sheet = composed?.sheets.find((s) => s.id === opts.sheet) ?? composed?.sheets[0] ?? null;
  return { doc, check, drawing, geometry, composed, sheet, topology, specKey };
}

/** The same part with another document's drawing: composed again, projecting only when the views changed. */
export function restate(state: DetailState, doc: RawDocument, kernel: KernelPort): Promise<DetailState> {
  return detailState(doc, kernel, { check: state.check, topology: state.topology, sheet: state.sheet?.id, geometry: { key: state.specKey, geometry: state.geometry } });
}

export interface ItemResult {
  item: string;
  ok: boolean;
  error?: string;
  /** What it added or changed: annotation, view or table ids. */
  made: string[];
}

export interface ExecuteResult {
  doc: RawDocument;
  commands: Command[];
  results: ItemResult[];
  state: DetailState;
}

/** The plan carried out on the document: its ticked items, in batches; the result to propose. */
export async function executePlan(plan: DetailPlan, base: DetailState, kernel: KernelPort, opts: { scope?: string[]; date?: string; fix?: boolean } = {}): Promise<ExecuteResult> {
  const scope = opts.scope ?? ["drawing"];
  const items = activeItems(plan);
  let doc = base.doc;
  const commands: Command[] = [];
  const results: ItemResult[] = [];
  /** Runs an item's commands: all applied, or none. */
  const run = (item: PlanItem, cmds: Command[], made: string[]) => {
    let next = doc;
    for (const cmd of cmds) {
      const r = apply(next, cmd, { writeScope: scope });
      if (!r.ok) {
        results.push({ item: item.id, ok: false, error: r.error, made: [] });
        return false;
      }
      next = r.doc;
    }
    doc = next;
    commands.push(...cmds);
    results.push({ item: item.id, ok: true, made });
    return true;
  };
  const phase = (p: PlanItem) => (["drawing", "view", "fill"].includes(p.action.do) ? 0 : p.action.do === "gdt" || p.action.do === "basic" ? 2 : 1);
  let state = base;
  for (const stage of [0, 1, 2]) {
    const list = items.filter((i) => phase(i) === stage);
    if (!list.length) continue;
    if (stage > 0) state = await restate(state, doc, kernel);
    for (const item of list) run(item, commandsFor(item, plan, state, doc, opts.date), madeBy(item));
  }
  state = await restate(state, doc, kernel);
  // Frames under callouts: placed once their size is known.
  const under = items.filter((i) => i.action.do === "gdt" && i.action.under && results.some((r) => r.item === i.id && r.ok));
  const moves: Command[] = [];
  for (const item of under) {
    if (item.action.do !== "gdt" || !item.action.under || !state.sheet) continue;
    const callout = state.sheet.annotations.find((a) => a.id === (item.action as { under: string }).under);
    const frame = state.sheet.annotations.find((a) => a.id === (item.action as { id: string }).id);
    const cv = state.sheet.views.find((v) => v.id === (item.action as { view: string }).view);
    if (!callout?.textBox || !frame?.textBox || !cv) continue;
    const h = frame.textBox.max[1] - frame.textBox.min[1];
    const at: Vec2 = [r1(callout.textBox.min[0] - cv.centre[0]), r1(callout.textBox.min[1] - 1 - h - cv.centre[1])];
    moves.push({ type: "editAnnotation", id: item.action.id, patch: { at } });
  }
  for (const cmd of moves) {
    const r = apply(doc, cmd, { writeScope: scope });
    if (r.ok) {
      doc = r.doc;
      commands.push(cmd);
    }
  }
  if (moves.length) state = await restate(state, doc, kernel);
  if (opts.fix !== false) {
    const added = new Set(results.flatMap((r) => r.made));
    for (let pass = 0; pass < 2; pass++) {
      const fixed = await clearOverlaps(state, kernel, scope, (id) => added.has(id));
      commands.push(...fixed.commands);
      state = fixed.state;
      const onSheet = await keepOnSheet(state, kernel, scope);
      commands.push(...onSheet.commands);
      state = onSheet.state;
      if (!onSheet.commands.length) break;
    }
    const kept = await keepWithHosts(state, kernel, scope);
    commands.push(...kept.commands);
    state = kept.state;
    doc = state.doc;
  }
  return { doc, commands, results, state };
}

/** The gap between two boxes, mm (0 when they touch or overlap). */
export function boxGap(a: Box, b: Box): number {
  const dx = Math.max(0, a.min[0] - b.max[0], b.min[0] - a.max[0]);
  const dy = Math.max(0, a.min[1] - b.max[1], b.min[1] - a.max[1]);
  return Math.hypot(dx, dy);
}

/**
 * A frame or datum hung on a callout or dimension and placed by hand that has come away from its host (the
 * host moved after it was placed): back to where the engine hangs it, under its host.
 */
export async function keepWithHosts(state: DetailState, kernel: KernelPort, scope: string[]): Promise<{ state: DetailState; commands: Command[] }> {
  const sheet = state.sheet;
  const drawing = validateDocument(state.doc).drawing;
  if (!sheet || !drawing) return { state, commands: [] };
  const commands: Command[] = [];
  let doc = state.doc;
  for (const a of allAnnotations(drawing)) {
    const host = a.type === "gdt" && typeof a.dimension === "string" ? a.dimension : null;
    if (!host || !(a as { at?: Vec2 }).at) continue;
    const mine = sheet.annotations.find((x) => x.id === a.id)?.textBox;
    const theirs = sheet.annotations.find((x) => x.id === host)?.textBox;
    if (!mine || !theirs || boxGap(mine, theirs) <= 4) continue;
    const cmd: Command = { type: "editAnnotation", id: a.id, patch: { at: null } };
    const r = apply(doc, cmd, { writeScope: scope });
    if (!r.ok) continue;
    doc = r.doc;
    commands.push(cmd);
  }
  return commands.length ? { state: await restate(state, doc, kernel), commands } : { state, commands };
}

/** What runs off the sheet (weighs 3; 1 when it can be moved by its place) or into a table, the notes or the title block (1), as "id: why". */
export function sheetProblemList(sheet: ComposedSheet): { what: string; weight: number }[] {
  const out: { what: string; weight: number }[] = [];
  const f = sheet.frame;
  const fixed = [{ id: "title block", box: sheet.titleBlock }, ...(sheet.revisionBlock ? [{ id: "revision block", box: sheet.revisionBlock }] : []), ...sheet.blocks];
  for (const a of sheet.annotations) {
    const b = a.box;
    if (!b || a.type === "table" || (a.type === "note" && !a.view) || (a.type === "surface" && !a.view)) continue;
    if (b.min[0] < f.min[0] || b.min[1] < f.min[1] || b.max[0] > f.max[0] || b.max[1] > f.max[1]) out.push({ what: `${a.id}: off the sheet`, weight: a.type !== "dimension" && a.grips?.some((g) => g.field === "at") ? 1 : 3 });
    for (const x of fixed) if (x.id !== a.id && overlaps(b, x.box)) out.push({ what: `${a.id}: into ${x.id}`, weight: 1 });
  }
  for (const v of sheet.views) for (const x of fixed) if (v.box && overlaps(v.box, x.box)) out.push({ what: `view ${v.id}: into ${x.id}`, weight: 1 });
  return out;
}

function sheetProblems(sheet: ComposedSheet): number {
  return sheetProblemList(sheet).reduce((t, p) => t + p.weight, 0);
}

/**
 * Annotations that run off the sheet (a view placed for fewer annotations
 * than it now has): its family of views (a parent with the views lined up on
 * it) is moved, all by one step, toward the room on the other side, while
 * that makes fewer problems.
 */
export async function keepOnSheet(state: DetailState, kernel: KernelPort, scope: string[]): Promise<{ state: DetailState; commands: Command[] }> {
  const commands: Command[] = [];
  const sheet = state.sheet;
  if (!sheet) return { state, commands };
  const f = sheet.frame;
  const off = sheet.annotations.filter((a) => a.box && "view" in a && a.view && (a.box.min[1] < f.min[1] || a.box.max[1] > f.max[1] || a.box.min[0] < f.min[0] || a.box.max[0] > f.max[0]));
  if (!off.length) return { state, commands };
  const rootOf = (id: string): string => {
    const v = sheet.views.find((x) => x.id === id);
    return v?.parent && sheet.views.some((x) => x.id === v.parent) && (v.kind === "projected" || v.kind === "section") ? rootOf(v.parent) : id;
  };
  let doc = state.doc;
  for (const root of new Set(off.map((a) => rootOf(String(a.view))))) {
    const family = sheet.views.filter((v) => rootOf(v.id) === root);
    const mine = off.filter((a) => rootOf(String(a.view)) === root);
    const dy = Math.max(0, ...mine.map((a) => a.box!.max[1] - f.max[1])) - Math.max(0, ...mine.map((a) => f.min[1] - a.box!.min[1]));
    const dx = Math.max(0, ...mine.map((a) => f.min[0] - a.box!.min[0])) - Math.max(0, ...mine.map((a) => a.box!.max[0] - f.max[0]));
    // The sheet keeps the scale it has (placed views no longer decide what fits).
    const pin: Command[] = validateDocument(doc).drawing?.sheets.find((x) => x.id === sheet.id)?.scale ? [] : [{ type: "setSheet", patch: { scale: sheet.scaleText }, sheet: sheet.id }];
    let best: { doc: RawDocument; cmds: Command[]; n: number } | null = null;
    const now = sheetProblems(sheet);
    // Further each try: what moves with the view (its dimension rows) can take more room once it moves.
    for (const k of [1, 2, 3, 4]) {
      const shift: Vec2 = [dx === 0 ? 0 : k * (dx + Math.sign(dx) * 3), dy === 0 ? 0 : -k * (dy + Math.sign(dy) * 3)];
      const cmds: Command[] = [...pin, ...family.map((v) => ({ type: "moveView", id: v.id, at: [r1(v.centre[0] + shift[0]), r1(v.centre[1] + shift[1])] }) as Command)];
      let next: RawDocument | null = doc;
      for (const cmd of cmds) {
        const r = apply(next!, cmd, { writeScope: scope });
        next = r.ok ? r.doc : null;
        if (!next) break;
      }
      if (!next) break;
      const c = composeDrawing(next, { measurements: state.check.measurements, geometry: state.geometry });
      const s = c?.sheets.find((x) => x.id === sheet.id);
      const n = s ? sheetProblems(s) : Infinity;
      if (n < now && (!best || n < best.n)) best = { doc: next, cmds, n };
      if (n === 0) break;
    }
    if (best) {
      doc = best.doc;
      commands.push(...best.cmds);
    }
  }
  return commands.length ? { state: await restate(state, doc, kernel), commands } : { state, commands };
}

const r1 = (x: number) => Math.round(x * 10) / 10 + 0;

function madeBy(item: PlanItem): string[] {
  const a = item.action;
  switch (a.do) {
    case "drawing":
      return allAnnotations(a.drawing).map((x) => x.id);
    case "view":
      return [a.id];
    case "fill":
      return a.annotations.map((x) => x.id);
    case "datum":
    case "gdt":
    case "surface":
    case "weld":
    case "table":
      return [a.id];
    case "fit":
      return a.make ? [a.make.id] : [];
    case "notes":
      return [a.id];
    case "balloons":
      return a.annotations.map((x) => x.id);
    default:
      return [];
  }
}

/** An item's commands on the drawing as it is now. */
export function commandsFor(item: PlanItem, plan: DetailPlan, state: DetailState, doc: RawDocument, date?: string): Command[] {
  const a = item.action;
  const o = plan.options;
  const drawing = validateDocument(doc).drawing;
  const has = (id: string) => !!drawing && allAnnotations(drawing).some((x) => x.id === id);
  switch (a.do) {
    case "drawing":
      return [{ type: "setDrawing", drawing: { ...a.drawing, standard: o.standard, generalTolerance: o.generalTolerance } }];
    case "view":
      return [{ type: "setView", id: a.id, view: a.view }];
    case "fill":
      return a.annotations.filter((x) => !has(x.id)).map((x) => ({ type: "setAnnotation", id: x.id, annotation: strip(x) }));
    case "datum":
      return [{ type: "setAnnotation", id: a.id, annotation: { type: "datum", view: a.view, label: a.label, ...(a.on ? { on: a.on } : {}), ...(a.dimension ? { dimension: a.dimension } : {}) } }];
    case "fit": {
      const tol = { kind: "fit", fit: a.fit };
      if (a.make) return [...(a.replaces && has(a.replaces) ? [{ type: "setAnnotation", id: a.replaces, annotation: null } as Command] : []), { type: "setAnnotation", id: a.make.id, annotation: { ...strip(a.make), tolerance: tol } }];
      return [{ type: "editAnnotation", id: a.target, patch: { tolerance: tol } }];
    }
    case "basic":
      return a.ids.filter(has).map((id) => ({ type: "editAnnotation", id, patch: { tolerance: { kind: "basic" } } }));
    case "gdt":
      return [{ type: "setAnnotation", id: a.id, annotation: { type: "gdt", view: a.view, rows: a.rows.map((r) => (r.characteristic === "position" ? { ...r, tolerance: r.tolerance === 0.05 ? r.tolerance : o.position } : r)), ...(a.on ? { on: a.on } : {}), ...(a.dimension ? { dimension: a.dimension } : {}), ...(a.under ? { at: underGuess(state, a.under, a.view) } : {}) } }];
    case "surface":
      return [{ type: "setAnnotation", id: a.id, annotation: { type: "surface", ...a.surface, ...(a.surface.general && o.roughness ? { values: [o.roughness] } : {}) } }];
    case "weld":
      return [{ type: "setAnnotation", id: a.id, annotation: { type: "weld", ...a.weld } }];
    case "tolerance":
      return [{ type: "setDrawingOptions", patch: { generalTolerance: o.generalTolerance, standard: o.standard } }];
    case "notes": {
      const text = notesFor(plan, doc, state.check.measurements).join("\n");
      return [{ type: "setAnnotation", id: a.id, annotation: { type: "note", text, at: notesAt(state, text, a.id), numbered: true, title: "NOTES:" } }];
    }
    case "table":
      return [{ type: "setAnnotation", id: a.id, annotation: strip(a.annotation) }];
    case "balloons":
      return a.annotations.filter((x) => !has(x.id)).map((x) => ({ type: "setAnnotation", id: x.id, annotation: strip(x) }));
    case "title":
      return [{ type: "setSheet", patch: a.patch, ...(state.sheet ? { sheet: state.sheet.id } : {}) }];
    case "revision":
      return [{ type: "setDrawingOptions", patch: { revisions: [{ rev: "A", description: "FIRST ISSUE", ...(date ? { date } : {}) }] } }];
  }
}

function strip(a: Annotation): Record<string, unknown> {
  const { id: _id, ...rest } = a as unknown as Record<string, unknown>;
  return rest;
}

/** A frame's first place under a callout (refined once its size is known). */
function underGuess(state: DetailState, callout: string, view: string): Vec2 {
  const c = state.sheet?.annotations.find((x) => x.id === callout);
  const cv = state.sheet?.views.find((v) => v.id === view);
  if (!c?.textBox || !cv) return [0, 0];
  return [r1(c.textBox.min[0] - cv.centre[0]), r1(c.textBox.min[1] - 8 - cv.centre[1])];
}

/** The notes block in the sheet's lower left corner, inside the border, above anything along the bottom there (as New drawing places it). */
function notesAt(state: DetailState, text: string, id: string): Vec2 {
  const sheet = state.sheet;
  if (!sheet) return [26, 60];
  const lines = text.split("\n").length;
  const h = lines * 4.9 + 7;
  const x0 = sheet.frame.min[0] + 6;
  let y0 = sheet.frame.min[1] + 4;
  for (const b of [...sheet.blocks.filter((x) => x.id !== id).map((x) => x.box), sheet.titleBlock]) if (b.min[0] < x0 + 120 && b.max[0] > x0 && b.min[1] < y0 + h) y0 = Math.max(y0, b.max[1] + 4);
  return [Math.round(x0), Math.round(y0 + 3 + lines * 4.9)];
}

// ------------------------------------------------------------ readability: nothing over anything

/** Where an annotation's text sits now, and every other thing it must keep off. */
export function overlapsOf(sheet: ComposedSheet, id: string): { with: string; area: number }[] {
  const a = sheet.annotations.find((x) => x.id === id);
  if (!a?.textBox) return [];
  const out: { with: string; area: number }[] = [];
  const area = (p: Box, q: Box) => Math.max(0, Math.min(p.max[0], q.max[0]) - Math.max(p.min[0], q.min[0])) * Math.max(0, Math.min(p.max[1], q.max[1]) - Math.max(p.min[1], q.min[1]));
  for (const b of sheet.annotations) {
    if (b.id === id || !b.textBox || b.type === "centerMark" || b.type === "centerline") continue;
    if (attached(sheet, a.id, b.id)) continue;
    if (overlaps(a.textBox, b.textBox, -0.8)) out.push({ with: b.id, area: area(a.textBox, b.textBox) });
  }
  for (const blk of [...sheet.blocks, { id: "title block", box: sheet.titleBlock }, ...(sheet.revisionBlock ? [{ id: "revision block", box: sheet.revisionBlock }] : [])]) {
    if (blk.id === id) continue;
    if (overlaps(a.textBox, blk.box, 0.3)) out.push({ with: blk.id, area: area(a.textBox, blk.box) });
  }
  return out;
}

/** Whether segment p–q crosses (or runs inside) box b. */
export function segmentInBox(p: Vec2, q: Vec2, b: Box): boolean {
  // Liang–Barsky clip of the segment against the box.
  let t0 = 0;
  let t1 = 1;
  const d = [q[0] - p[0], q[1] - p[1]];
  for (const [pk, qk] of [
    [-d[0], p[0] - b.min[0]],
    [d[0], b.max[0] - p[0]],
    [-d[1], p[1] - b.min[1]],
    [d[1], b.max[1] - p[1]],
  ]) {
    if (Math.abs(pk) < 1e-12) {
      if (qk < 0) return false;
      continue;
    }
    const t = qk / pk;
    if (pk < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return t1 - t0 > 1e-9;
}

/**
 * The other annotations whose lines (a leader, an extension or dimension line) run through this
 * annotation's text: a callout's leader through the frame hung under it, a dimension line through a
 * symbol. Its own lines and centre lines are not counted; the text box is shrunk by `inset` mm.
 */
export function crossingsOf(sheet: ComposedSheet, id: string, inset = 1.2): string[] {
  const a = sheet.annotations.find((x) => x.id === id);
  if (!a?.textBox) return [];
  const b: Box = { min: [a.textBox.min[0] + inset, a.textBox.min[1] + inset], max: [a.textBox.max[0] - inset, a.textBox.max[1] - inset] };
  if (b.min[0] >= b.max[0] || b.min[1] >= b.max[1]) return [];
  const skip = new Set(sheet.annotations.filter((x) => x.type === "centerMark" || x.type === "centerline" || x.type === "table" || x.type === "note").map((x) => x.id));
  const out = new Set<string>();
  for (const pr of sheet.prims) {
    if (pr.k !== "line" || pr.fill || !pr.owner || pr.owner === id || skip.has(pr.owner) || out.has(pr.owner)) continue;
    if (!sheet.annotations.some((x) => x.id === pr.owner)) continue;
    const n = pr.pts.length;
    for (let i = 0; i + 1 < n + (pr.closed ? 1 : 0); i++) {
      if (segmentInBox(pr.pts[i], pr.pts[(i + 1) % n], b)) {
        out.add(pr.owner);
        break;
      }
    }
  }
  return [...out];
}

/**
 * What this annotation's own lines run into: other annotations' text they cross (a leader through a
 * callout), and other annotations' lines they lie along (one dimension line drawn over another).
 */
export function lineConflictsOf(sheet: ComposedSheet, id: string): { through: string[]; along: string[] } {
  const skip = new Set(sheet.annotations.filter((x) => x.type === "centerMark" || x.type === "centerline" || x.type === "table" || x.type === "note").map((x) => x.id));
  if (skip.has(id)) return { through: [], along: [] };
  const all = (owner: string) => sheet.prims.flatMap((pr) => (pr.k === "line" && !pr.fill && pr.owner === owner ? pr.pts.slice(1).map((q, i) => [pr.pts[i], q] as [Vec2, Vec2]) : []));
  // A dimension's own line runs along its text (its extension lines across it, and those may be shared on purpose).
  const segs = (owner: string) => {
    const a = sheet.annotations.find((x) => x.id === owner);
    const list = all(owner);
    if (a?.type !== "dimension" || !a.textBox) return list;
    const wide = a.textBox.max[0] - a.textBox.min[0] >= a.textBox.max[1] - a.textBox.min[1];
    return list.filter(([p, q]) => (wide ? Math.abs(q[0] - p[0]) > 3 * Math.abs(q[1] - p[1]) : Math.abs(q[1] - p[1]) > 3 * Math.abs(q[0] - p[0])));
  };
  const mine = all(id);
  const mineAlong = segs(id);
  if (!mine.length) return { through: [], along: [] };
  const through = new Set<string>();
  const along = new Set<string>();
  const links = attachedIds.get(id);
  for (const b of sheet.annotations) {
    if (b.id === id || skip.has(b.id) || links?.has(b.id) || attachedIds.get(b.id)?.has(id)) continue;
    if (b.textBox) {
      const t: Box = { min: [b.textBox.min[0] + 1.2, b.textBox.min[1] + 1.2], max: [b.textBox.max[0] - 1.2, b.textBox.max[1] - 1.2] };
      if (t.min[0] < t.max[0] && t.min[1] < t.max[1] && mine.some(([p, q]) => segmentInBox(p, q, t))) through.add(b.id);
    }
    for (const [p, q] of segs(b.id)) {
      if (mineAlong.some(([u, v]) => collinearOverlap(u, v, p, q) > 1)) {
        along.add(b.id);
        break;
      }
    }
  }
  return { through: [...through], along: [...along] };
}

/** How far two segments lie on one another (parallel, within 0.4 mm), mm along them; 0 when they don't. */
export function collinearOverlap(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const L = Math.hypot(ux, uy);
  if (L < 1e-9) return 0;
  const n: Vec2 = [ux / L, uy / L];
  const off = (p: Vec2) => Math.abs((p[0] - a[0]) * n[1] - (p[1] - a[1]) * n[0]);
  if (off(c) > 0.4 || off(d) > 0.4) return 0;
  const t = (p: Vec2) => (p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1];
  const lo = Math.max(0, Math.min(t(c), t(d)));
  const hi = Math.min(L, Math.max(t(c), t(d)));
  return Math.max(0, hi - lo);
}

/** How many of the views' own lines (the part's edges, hatching, cutting-plane lines and labels) run through a box. */
export function viewLinesThrough(sheet: ComposedSheet, box: Box, inset = 0.8): number {
  const views = new Set(sheet.views.map((v) => v.id));
  const b: Box = { min: [box.min[0] + inset, box.min[1] + inset], max: [box.max[0] - inset, box.max[1] - inset] };
  if (b.min[0] >= b.max[0] || b.min[1] >= b.max[1]) return 0;
  let n = 0;
  for (const pr of sheet.prims) {
    if (!pr.owner || !views.has(pr.owner)) continue;
    if (pr.k === "line") {
      for (let i = 1; i < pr.pts.length; i++) if (segmentInBox(pr.pts[i - 1], pr.pts[i], b)) n++;
    } else if (pr.k === "text") {
      const p = pr.at;
      if (p[0] > b.min[0] - 3 && p[0] < b.max[0] + 3 && p[1] > b.min[1] - 3 && p[1] < b.max[1] + 3) n += 2;
    }
  }
  return n;
}

/** Whether an annotation runs into anything: text over text, a line through its text, its lines over another's. */
function troubled(sheet: ComposedSheet, id: string): boolean {
  // Its own lines running through or along others' weigh in its badness (where it may go) but do not set it moving:
  // chasing them moves whole dimension rows about.
  return overlapsOf(sheet, id).length > 0 || crossingsOf(sheet, id).length > 0;
}

/** A frame and its dimension, a datum and its frame or dimension: drawn together on purpose. */
function attached(sheet: ComposedSheet, a: string, b: string): boolean {
  void sheet;
  return attachedIds.get(a)?.has(b) || attachedIds.get(b)?.has(a) || false;
}
let attachedIds = new Map<string, Set<string>>();

function noteAttachments(doc: RawDocument): void {
  attachedIds = new Map();
  const d = validateDocument(doc).drawing;
  if (!d) return;
  for (const a of allAnnotations(d)) {
    const links = [("dimension" in a && typeof a.dimension === "string" ? a.dimension : null), (a.type === "datum" && a.gdt ? a.gdt : null)].filter((x): x is string => !!x);
    if (links.length) attachedIds.set(a.id, new Set(links));
  }
}

/** How badly an annotation sits: what it overlaps (by area), over the part's lines, off the sheet. */
function badness(sheet: ComposedSheet, id: string): number {
  const a = sheet.annotations.find((x) => x.id === id);
  if (!a?.textBox) return 0;
  let s = overlapsOf(sheet, id).reduce((t, o) => t + 10 + o.area, 0) + 15 * crossingsOf(sheet, id).length;
  const lines = lineConflictsOf(sheet, id);
  s += 15 * lines.through.length + 25 * lines.along.length;
  for (const v of sheet.views) {
    if (!v.box) continue;
    const b = v.box;
    const ov = Math.max(0, Math.min(a.textBox.max[0], b.max[0]) - Math.max(a.textBox.min[0], b.min[0])) * Math.max(0, Math.min(a.textBox.max[1], b.max[1]) - Math.max(a.textBox.min[1], b.min[1]));
    // Over a view's empty room costs little; over the part's own lines (and the cutting-plane lines and labels) much more.
    s += ov * 0.08;
  }
  s += 12 * viewLinesThrough(sheet, a.textBox);
  const f = sheet.frame;
  if (a.textBox.min[0] < f.min[0] || a.textBox.min[1] < f.min[1] || a.textBox.max[0] > f.max[0] || a.textBox.max[1] > f.max[1]) s += 1000;
  return s;
}

/**
 * Moves annotations the detailing added off whatever their text lands on
 * (other text, tables, the title block), trying places around where they
 * are, nearest first; at most `rounds` passes. Returns the moves made.
 */
export async function clearOverlaps(state: DetailState, kernel: KernelPort, scope: string[], mine: (id: string) => boolean, rounds = 2): Promise<{ state: DetailState; commands: Command[] }> {
  const commands: Command[] = [];
  let doc = state.doc;
  noteAttachments(doc);
  const rings: Vec2[] = [];
  for (const r of [5, 10, 16, 24]) for (let k = 0; k < 8; k++) rings.push([r * Math.cos((k * Math.PI) / 4), r * Math.sin((k * Math.PI) / 4)]);
  // Each try composes the sheet again (tens of ms): a budget keeps a crowded sheet from taking long.
  let budget = 80;
  let hungBudget = 30;
  // Callouts, dimensions and symbols first, in rounds; the frames and datums hung on a callout or dimension last, in one
  // pass once their hosts have stopped moving (a host the engine places moves when what is round it moves).
  const hung = (id: string) => attachedIds.has(id);
  for (let round = 0; round <= rounds; round++) {
    const last = round === rounds;
    const sheet = state.sheet;
    if (!sheet) break;
    const bad = sheet.annotations.filter((a) => mine(a.id) && hung(a.id) === last && a.textBox && a.grips?.some((g) => g.field === "at") && troubled(sheet, a.id));
    if (!bad.length) {
      if (last) break;
      round = rounds - 1;
      continue;
    }
    let moved = false;
    for (const stale of bad) {
      // Where it is now (an earlier move this round may have moved its host, or it).
      const ca = state.sheet?.annotations.find((x) => x.id === stale.id);
      if (!ca?.textBox || !ca.grips?.some((g) => g.field === "at")) continue;
      if (!troubled(state.sheet!, ca.id)) continue;
      const drawing = validateDocument(doc).drawing;
      const ann = drawing ? allAnnotations(drawing).find((x) => x.id === ca.id) : undefined;
      const grip = ca.grips!.find((g) => g.field === "at")!;
      if (!ann || !state.composed) continue;
      const now = badness(state.sheet!, ca.id);
      let best: { cmd: Command; doc: RawDocument; score: number; cmds?: Command[] } | null = null;
      // Besides the rings: a whole size of the text over (a frame from under its callout to above it or beside it), nearest first.
      const w = ca.textBox!.max[0] - ca.textBox!.min[0];
      const h = ca.textBox!.max[1] - ca.textBox!.min[1];
      const jumps: Vec2[] = [[0, h + 9], [0, -(h + 2)], [-(w + 2), 0], [w + 2, 0], [0, 2 * h + 9], [-(w + 2), -(h + 2)], [w + 2, -(h + 2)]];
      // A frame hung on a callout or dimension stays with it: only under it (where it is) or just above its text.
      const host = "dimension" in ann && typeof ann.dimension === "string" ? state.sheet!.annotations.find((x) => x.id === (ann as { dimension: string }).dimension) : undefined;
      const tries = host?.textBox
        ? ([
            // Under its text (centred, then flush left or right), above it, beside it.
            [(host.textBox.min[0] + host.textBox.max[0]) / 2 - w / 2 - ca.textBox!.min[0], host.textBox.min[1] - 0.8 - h - ca.textBox!.min[1]],
            [host.textBox.min[0] - ca.textBox!.min[0], host.textBox.min[1] - 0.8 - h - ca.textBox!.min[1]],
            [host.textBox.max[0] - w - ca.textBox!.min[0], host.textBox.min[1] - 0.8 - h - ca.textBox!.min[1]],
            [0, host.textBox.max[1] + 1 - ca.textBox!.min[1]],
            // Beside its text, on its line (right, then left).
            [host.textBox.max[0] + 1.5 - ca.textBox!.min[0], host.textBox.min[1] - ca.textBox!.min[1]],
            [host.textBox.min[0] - 1.5 - ca.textBox!.max[0], host.textBox.min[1] - ca.textBox!.min[1]],
          ] as Vec2[])
        : [...rings, ...jumps].sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1]));
      // A frame placed by hand beside a host the engine places would be left behind when the host moves: pin the host where it is.
      let base = doc;
      let pin: Command | null = null;
      const hostDoc = host && drawing ? (allAnnotations(drawing).find((x) => x.id === host.id) as (Annotation & { at?: Vec2 }) | undefined) : undefined;
      const hostGrip = host?.grips?.find((g) => g.field === "at");
      if (host && hostDoc && !hostDoc.at && hostGrip) {
        const held = dragGrip(hostDoc, hostGrip, hostGrip.at, state.composed) as Annotation & { at?: Vec2 };
        if (held.at) {
          pin = { type: "editAnnotation", id: host.id, patch: { at: [r1(held.at[0]), r1(held.at[1])] } };
          const r = apply(doc, pin, { writeScope: scope });
          if (r.ok) base = r.doc;
          else pin = null;
        }
      }
      for (const d of tries) {
        if (last ? hungBudget-- <= 0 : budget-- <= 0) break;
        const next = dragGrip(ann, grip, [grip.at[0] + d[0], grip.at[1] + d[1]], state.composed) as Annotation & { at?: Vec2 };
        if (!next.at) continue;
        const cmd: Command = { type: "editAnnotation", id: ca.id, patch: { at: [r1(next.at[0]), r1(next.at[1])] } };
        const r = apply(base, cmd, { writeScope: scope });
        if (!r.ok) continue;
        const c = composeDrawing(r.doc, { measurements: state.check.measurements, geometry: state.geometry });
        const s = c?.sheets.find((x) => x.id === state.sheet!.id);
        if (!s || s.annotations.find((x) => x.id === ca.id)?.problem) continue;
        // Nearer is better, but a hung frame's places are all beside its host.
        const score = badness(s, ca.id) + (host ? 0 : Math.hypot(d[0], d[1]) * 0.3);
        if (!best || score < best.score) best = { cmd, doc: r.doc, score, ...(pin ? { cmds: [pin, cmd] } : {}) };
        // The nearest place clear of everything will do.
        if (!troubled(s, ca.id) && badness(s, ca.id) < now) break;
      }
      if (best && best.score < now - 1e-6) {
        doc = best.doc;
        commands.push(...(best.cmds ?? [best.cmd]));
        state = await restate(state, doc, kernel);
        moved = true;
      }
    }
    if (!moved && !last) round = rounds - 1;
  }
  return { state, commands };
}
