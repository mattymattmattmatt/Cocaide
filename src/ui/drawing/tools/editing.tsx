// Editing annotations on the sheet (Phase Q wave Q3A): every edit a tool
// keeps also remembers where the sheet's dimensions are drawn (so one whose
// geometry goes in a rebuild is drawn there, in the warning colour); the
// arrow keys nudge what is selected; the right-click menu's quick edits
// (tolerance picks, Ø ↔ R, linear ↔ baseline/ordinate, hide/show, copy the
// format); Align and Arrange Dimensions; the Format Painter.

import type { Command } from "../../../doc/commands";
import type { Annotation, DimensionAnnotation, Drawing, Vec2 } from "../../../doc/types";
import { rememberPlaces } from "../../../drafting/annotate";
import type { ComposedAnnotation, ComposedSheet } from "../../../drafting/compose";
import type { MenuEntry } from "../../ContextMenu";
import { convertDimension, radialSwap } from "./inference";
import { annotationKind, dimensionLine, offsetFor } from "./kinds";
import { registerDrawingTool } from "./registry";
import { BaseSession } from "./session";
import { BUILT_IN_FAVOURITES, applyFavourite, paintPatch, styleOf } from "./styles";
import type { DrawingToolCtx, OverlayShape, SheetPointer } from "./types";

// ------------------------------------------------------------ remembering places

/**
 * The editAnnotation commands that keep each of the sheet's dimensions'
 * place as drawn now (its `last`), leaving out what `cmds` touch (an
 * annotation they change or delete, a view they change). Empty when nothing
 * moved since the last time.
 */
export function rememberCommands(drawing: Drawing, sheet: ComposedSheet | null, cmds: Command[]): Command[] {
  if (!sheet || cmds.some((c) => c.type === "deleteSheet" || c.type === "setDrawing")) return [];
  const next = rememberPlaces(drawing, [sheet]);
  if (!next) return [];
  const ids = new Set(cmds.flatMap((c) => ("id" in c && typeof c.id === "string" ? [c.id] : [])));
  const out: Command[] = [];
  const before = new Map(drawing.sheets.flatMap((s) => s.annotations.map((a) => [a.id, a] as const)));
  for (const s of next.sheets) {
    if (s.id !== sheet.id) continue;
    for (const a of s.annotations) {
      if (a.type !== "dimension" || !a.last || ids.has(a.id) || ids.has(a.view)) continue;
      const old = before.get(a.id) as DimensionAnnotation | undefined;
      if (old && JSON.stringify(old.last) === JSON.stringify(a.last)) continue;
      out.push({ type: "editAnnotation", id: a.id, patch: { last: a.last } });
    }
  }
  return out;
}

/** Commands as one undo step, the sheet's dimensions' places remembered with them. The error when refused. */
export function keep(c: DrawingToolCtx, cmds: Command[]): string | null {
  if (!cmds.length) return null;
  return c.batch([...cmds, ...rememberCommands(c.drawing, c.sheet, cmds)]);
}

/** An annotation's patch (null removes a key), as one undo step. */
export function patchAnnotation(c: DrawingToolCtx, id: string, patch: Record<string, unknown>): string | null {
  return keep(c, [{ type: "editAnnotation", id, patch }]);
}

// ------------------------------------------------------------ the keyboard

/** The arrow keys nudge the selected annotations: 0.5 mm, Shift 5 mm. True when it took the key. */
export function annotationKey(e: KeyboardEvent, c: DrawingToolCtx): boolean {
  const dirs: Record<string, Vec2> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
  const d = dirs[e.key];
  if (!d || !c.sheet || e.ctrlKey || e.metaKey || e.altKey) return false;
  const step = e.shiftKey ? 5 : 0.5;
  const delta: Vec2 = [d[0] * step, d[1] * step];
  const cmds: Command[] = [];
  for (const id of c.selection) {
    const a = c.sheetDoc.annotations.find((x) => x.id === id) as Record<string, unknown> | undefined;
    const k = a && annotationKind(String(a.type));
    if (!a || !k?.move) continue;
    const patch = k.move(a, delta, { sheet: c.sheet, said: c.sheet.annotations.find((x) => x.id === id) });
    if (patch) cmds.push({ type: "editAnnotation", id, patch });
  }
  if (!cmds.length) return false;
  c.batch(cmds);
  return true;
}

// ------------------------------------------------------------ the right-click menu

const TOLERANCE_PICKS = BUILT_IN_FAVOURITES.filter((f) => f.style.tolerance);

/** The quick edits on an annotation's right-click menu. */
export function annotationMenu(a: Annotation, get: () => DrawingToolCtx, said?: ComposedAnnotation): MenuEntry[] {
  const c = get();
  const out: MenuEntry[] = [];
  const set = (patch: Record<string, unknown>) => () => {
    patchAnnotation(c, a.id, patch);
  };
  out.push({ label: "Edit properties", icon: "properties", onClick: () => c.select([a.id]), testId: "ctx-edit-annotation" });
  if (a.type === "dimension" || a.type === "hole") {
    out.push({ heading: "Tolerance" });
    out.push({ label: "None", onClick: set({ tolerance: null }), testId: "ctx-tol-none", disabled: !a.tolerance });
    for (const f of TOLERANCE_PICKS) {
      const ok = a.type === "hole" ? f.style.tolerance! : applyFavourite(a, f);
      out.push({ label: f.name, onClick: set({ tolerance: f.style.tolerance }), disabled: typeof ok === "string", testId: `ctx-tol-${f.name.replace(/[^A-Za-z0-9]+/g, "")}` });
    }
  }
  if (a.type === "dimension") {
    const kind = a.kind ?? "linear";
    const radial = (["diameter", "radius"] as const).flatMap((to) => (radialSwap(a, to) && kind !== to ? [to] : []));
    const convert = (["baseline", "ordinate", "chain", "linear"] as const).filter((to) => to !== kind && typeof convertDimension(a, to) !== "string");
    if (radial.length || convert.length) out.push("sep");
    for (const to of radial) out.push({ label: to === "diameter" ? "Display as diameter (Ø)" : "Display as radius (R)", icon: to === "diameter" ? "diameter" : "radius", onClick: set({ kind: to }), testId: `ctx-dim-${to}` });
    for (const to of convert) {
      out.push({
        label: to === "linear" ? "Convert to a linear dimension" : `Convert to ${to}`,
        icon: "dimension",
        onClick: () => {
          const next = convertDimension(a, to);
          if (typeof next === "string") return c.notice(next, "error");
          keep(c, [{ type: "setAnnotation", id: a.id, annotation: next }]);
        },
        testId: `ctx-dim-to-${to}`,
      });
    }
  }
  out.push("sep");
  const style = styleOf(a);
  if (style) out.push({ label: "Format painter: copy this format", icon: "palette", onClick: () => startPainter(get, a), testId: "ctx-format-painter" });
  out.push({ label: a.hidden ? "Show" : "Hide", icon: a.hidden ? "eye" : "eyeOff", onClick: set({ hidden: a.hidden ? null : true }), testId: a.hidden ? "ctx-show" : "ctx-hide" });
  void said;
  return out;
}

// ------------------------------------------------------------ align and arrange

/** The selected dimensions that are linear and drawn, with their lines. */
function linearDims(c: DrawingToolCtx): { a: DimensionAnnotation; line: NonNullable<ReturnType<typeof dimensionLine>> }[] {
  if (!c.sheet) return [];
  const out: { a: DimensionAnnotation; line: NonNullable<ReturnType<typeof dimensionLine>> }[] = [];
  for (const id of c.selection) {
    const a = c.sheetDoc.annotations.find((x) => x.id === id);
    if (a?.type !== "dimension" || !["linear", "diameter", undefined].includes(a.kind) || (a.kind === "diameter" && a.refs?.length !== 2)) continue;
    const line = dimensionLine(c.sheet, id);
    if (line && line.dir !== "a") out.push({ a, line });
  }
  return out;
}

/**
 * Align: the selected dimensions that run the same way in one view are put on
 * one line, the furthest out (their texts back in the middle of their lines).
 */
export function alignCommands(c: DrawingToolCtx): Command[] | string {
  const dims = linearDims(c);
  if (dims.length < 2) return "Select two or more linear dimensions that run the same way in one view";
  const groups = new Map<string, typeof dims>();
  for (const d of dims) {
    const cv = c.sheet!.views.find((v) => v.id === d.a.view)!;
    const side = d.line.level > (d.line.dir === "h" ? cv.centre[1] : cv.centre[0]) ? 1 : -1;
    const key = `${d.a.view}|${d.line.dir}|${side}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  const cmds: Command[] = [];
  for (const [key, g] of groups) {
    if (g.length < 2) continue;
    const [view, dir, side] = key.split("|");
    const cv = c.sheet!.views.find((v) => v.id === view)!;
    const level = Number(side) > 0 ? Math.max(...g.map((d) => d.line.level)) : Math.min(...g.map((d) => d.line.level));
    const offset = offsetFor(dir as "h" | "v", level, cv.box!);
    for (const d of g) cmds.push({ type: "editAnnotation", id: d.a.id, patch: { offset, at: null } });
  }
  return cmds.length ? cmds : "The selected dimensions don't share a direction and side of a view: nothing to line up";
}

/** Arrange: the selected dimensions given back to the layout, which stacks them in rows (shortest nearest, 10 then 7 mm apart). */
export function arrangeCommands(c: DrawingToolCtx): Command[] | string {
  const ids = c.selection.filter((id) => c.sheetDoc.annotations.some((a) => a.id === id && a.type === "dimension"));
  const all = ids.length ? ids : c.sheetDoc.annotations.filter((a) => a.type === "dimension" && (a.at || a.offset !== undefined)).map((a) => a.id);
  if (!all.length) return "Nothing to arrange: select dimensions you placed by hand (or none, for all of them)";
  return all.map((id) => ({ type: "editAnnotation", id, patch: { at: null, offset: null } }) as Command);
}

registerDrawingTool({
  id: "annotation.alignDimensions",
  tab: "annotation",
  group: "arrange",
  label: "Align",
  icon: "horizontal",
  title: "Line up the selected dimensions that run the same way: on one line, the furthest out",
  testId: "tool-annotation-align",
  disabled: (c) => (linearDims(c).length >= 2 ? undefined : "Select two or more linear dimensions"),
  run: (get) => {
    const c = get();
    const r = alignCommands(c);
    if (typeof r === "string") return c.notice(r, "error");
    if (!keep(c, r)) c.notice(`Aligned ${r.length} dimensions.`);
  },
});

registerDrawingTool({
  id: "annotation.arrangeDimensions",
  tab: "annotation",
  group: "arrange",
  label: "Arrange",
  icon: "examples",
  title: "Space the selected dimensions (or every one placed by hand) evenly: rows outward from the view, shortest nearest",
  testId: "tool-annotation-arrange",
  disabled: (c) => (c.sheetDoc.annotations.some((a) => a.type === "dimension") ? undefined : "No dimensions on this sheet"),
  run: (get) => {
    const c = get();
    const r = arrangeCommands(c);
    if (typeof r === "string") return c.notice(r);
    if (!keep(c, r)) c.notice(`Arranged ${r.length} dimension${r.length === 1 ? "" : "s"}.`);
  },
});

// ------------------------------------------------------------ the format painter

class PainterSession extends BaseSession {
  source: { id: string; style: NonNullable<ReturnType<typeof styleOf>> } | null = null;
  painted = 0;
  constructor(ctx: () => DrawingToolCtx, from?: Annotation) {
    super("annotation.formatPainter", ctx);
    const s = from && styleOf(from);
    if (from && s) this.source = { id: from.id, style: s };
  }
  title() {
    return this.painted ? `Format painter (${this.painted} painted)` : "Format painter";
  }
  prompt() {
    return this.source ? `Click annotations to give them ${this.source.id}'s format (Esc: done)` : "Click the annotation whose format to copy";
  }
  blocked() {
    return null;
  }
  ok() {
    this.ctx().end();
    return null;
  }
  cancel() {
    this.ctx().end();
  }
  click(p: SheetPointer) {
    const c = this.ctx();
    if (p.hit?.kind !== "annotation") return c.notice(this.prompt(), "error");
    const a = c.sheetDoc.annotations.find((x) => x.id === p.hit!.id);
    if (!a) return;
    if (!this.source) {
      const s = styleOf(a);
      if (!s) return c.notice(`A ${a.type} has no format to copy: pick a dimension, a note, a balloon, a centre mark`, "error");
      this.source = { id: a.id, style: s };
      return c.refresh();
    }
    if (a.id === this.source.id) return;
    const patch = paintPatch(a, this.source.style);
    if (typeof patch === "string") return c.notice(patch, "error");
    if (!patchAnnotation(c, a.id, patch)) this.painted++;
    c.refresh();
  }
  overlay(): OverlayShape[] {
    const h = this.hover?.hit;
    const b = h?.kind === "annotation" ? this.ctx().sheet?.annotations.find((x) => x.id === h.id)?.box : null;
    const src = this.source ? this.ctx().sheet?.annotations.find((x) => x.id === this.source!.id)?.box : null;
    return [...(src ? [{ k: "rect", box: src, tone: "accent", dash: true } as OverlayShape] : []), ...(b ? [{ k: "rect", box: b, tone: "preview" } as OverlayShape] : [])];
  }
}

/** Starts the format painter with this annotation's format. */
export function startPainter(get: () => DrawingToolCtx, from: Annotation): void {
  get().select([from.id]);
  get().startSession?.(new PainterSession(get, from));
}

registerDrawingTool({
  id: "annotation.formatPainter",
  tab: "annotation",
  group: "arrange",
  label: "Format Painter",
  icon: "palette",
  title: "Copy one annotation's format (tolerance, decimals, arrows; a note's height) onto others: click it, then them",
  testId: "tool-annotation-format-painter",
  disabled: (c) => (c.sheetDoc.annotations.length ? undefined : "No annotations on this sheet"),
  run: (get) => {
    const c = get();
    const sel = c.selection.map((id) => c.sheetDoc.annotations.find((a) => a.id === id)).find((a) => a && styleOf(a));
    return new PainterSession(get, sel);
  },
});
