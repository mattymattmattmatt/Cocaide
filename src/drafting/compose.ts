// Composes a drawing's sheet (Phase L) from the document, the rebuild's
// measurements and the projected views: where each view goes and at what
// scale, and what every dimension, balloon, callout and weld symbol says.
// Every number is read from the rebuild here; nothing on the sheet is typed
// but notes and the title block. An annotation that points at something the
// part no longer has, or that its view can't show, is not drawn: it is listed
// in `problems`.

import type { DrawingGeometry } from "../ask/kernel";
import { parseScale, pointRef, STANDARD_SCALES } from "../doc/drawing";
import {
  SHEET_SIZES,
  type Annotation,
  type AnnotationType,
  type BalloonAnnotation,
  type DimensionAnnotation,
  type Drawing,
  type DrawingView,
  type HoleAnnotation,
  type NoteAnnotation,
  type Projection,
  type SheetSize,
  type TableAnnotation,
  type Vec2,
  type Vec3,
  type ViewLook,
  type WeldAnnotation,
} from "../doc/types";
import { validateDocument, type ValidationResult } from "../doc/validate";
import type { Measurements } from "../kernel/measure";
import type { ProjectedView } from "../kernel/project";
import type { HoleRecord } from "../kernel/rebuild";
import { anglesText, cutList, type CutListItem } from "../weldment/cutlist";
import { boxOf, centre, grow, inside, overlaps, primBox, size, union, type Box, type Prim } from "./sheet";
import { CAP, LINE, TEXT, textWidth } from "./text";
import { inView, isOrthographic, placeFromFront, toModel, viewFrame, type ViewFrame } from "./views";

export interface ComposeContext {
  measurements: Measurements | null;
  geometry: DrawingGeometry | null;
}

export interface ComposedView {
  id: string;
  look: ViewLook;
  /** Sheet mm per model mm. */
  scale: number;
  scaleText: string;
  /** Placed with the others (it has no `at`). */
  auto: boolean;
  /** The view's centre on the sheet, and the point of the view (model mm, in its frame) drawn there. */
  centre: Vec2;
  origin: Vec2;
  /** What the projection covers in the view, model mm. Null when the view shows nothing. */
  outline: Box | null;
  /** Where its lines are on the sheet. */
  box: Box | null;
}

export interface ComposedAnnotation {
  id: string;
  type: AnnotationType;
  view?: string;
  /** What it says on the sheet. */
  text: string;
  /** A dimension's value, mm, and the model direction it measures along. */
  value?: number;
  along?: Vec3;
  /** A balloon's cut list item. */
  item?: number;
  /** Where it is held on the sheet (a balloon's centre, a callout's text, a weld's knee, a table's top left): what a drag moves. */
  at?: Vec2;
  box: Box | null;
  /** Why it isn't on the sheet. */
  problem?: string;
}

export interface ComposedSheet {
  size: SheetSize;
  width: number;
  height: number;
  projection: Projection;
  scale: number;
  scaleText: string;
  /** Inside the border. */
  frame: Box;
  titleBlock: Box;
  views: ComposedView[];
  annotations: ComposedAnnotation[];
  /** The tables and notes: placed things that aren't views. */
  blocks: { id: string; box: Box }[];
  prims: Prim[];
  /** "b3: no member rail_x": every annotation that isn't drawn, and why. */
  problems: string[];
  /** The cut list the balloons and the table number by. */
  cutList: CutListItem[];
}

const BORDER = { left: 20, right: 10, bottom: 10, top: 10 };
export const TITLE_BLOCK: Vec2 = [180, 30];
/** Between views (their annotations' room included), and from the border. */
const GAP = 6;
const INSET = 4;
/** The first dimension line's distance from the view, and each next one's. */
const DIM_FIRST = 10;
const DIM_STEP = 8;
const ARROW = { length: 3, half: 0.6 };
const BALLOON_R = 4.5;
/** A weld symbol's reference line, mm. */
const WELD_LINE = 26;
const ROW = 7;

/** "1200", "12.5", "6.6". */
export function fmt(x: number): string {
  const r = Math.round(x * 10) / 10 + 0;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** The scale a number is, as written: 0.1 → "1:10". */
export function scaleText(k: number): string {
  if (k >= 1) return `${fmt(k)}:1`;
  return `1:${fmt(1 / k)}`;
}

export function composeSheet(doc: unknown, ctx: ComposeContext): ComposedSheet | null {
  const v = validateDocument(doc);
  if (!v.drawing) return null;
  return new Composer(v, v.drawing, ctx).compose();
}

type Side = -1 | 1;

interface DimPlan {
  a: DimensionAnnotation;
  /** "h" and "v" stack outside the view; "a" sits beside its points. */
  dir: "h" | "v" | "a";
  side: Side;
  span: number;
  /** Its place in the stack on its side, nearest first. */
  stack: number;
}

class Composer {
  private readonly width: number;
  private readonly height: number;
  private readonly frame: Box;
  private readonly titleBlock: Box;
  private readonly prims: Prim[] = [];
  private readonly problems: string[] = [];
  private readonly annotations = new Map<string, ComposedAnnotation>();
  private readonly cut: CutListItem[];
  private readonly projected = new Map<string, ProjectedView>();
  private readonly holes = new Map<string, HoleRecord>();
  private views: ComposedView[] = [];
  private readonly dims = new Map<string, DimPlan>();

  constructor(
    private readonly v: ValidationResult,
    private readonly d: Drawing,
    private readonly ctx: ComposeContext,
  ) {
    [this.width, this.height] = SHEET_SIZES[d.sheet.size];
    this.frame = { min: [BORDER.left, BORDER.bottom], max: [this.width - BORDER.right, this.height - BORDER.top] };
    this.titleBlock = { min: [this.frame.max[0] - TITLE_BLOCK[0], this.frame.min[1]], max: [this.frame.max[0], this.frame.min[1] + TITLE_BLOCK[1]] };
    this.cut = ctx.measurements ? cutList(ctx.measurements.members) : [];
    for (const pv of ctx.geometry?.views ?? []) this.projected.set(pv.id, pv);
    for (const h of ctx.geometry?.holes ?? []) this.holes.set(h.feature, h);
  }

  private tableBoxes: Box[] = [];
  /** View labels ("ISO  SCALE 1:20"): balloons and symbols keep clear of them. */
  private labels: Box[] = [];

  compose(): ComposedSheet {
    const tables = this.placeTables();
    this.tableBoxes = [...tables.map((t) => t.box), ...this.notes().map((n) => n.box)];
    const blocked = [this.titleBlock, ...tables.map((t) => t.box), ...this.notes().map((n) => n.box)];
    this.planDimensions();
    const { scale, views } = this.layout(blocked);
    this.views = views;

    this.border();
    for (const cv of views) this.drawView(cv);
    for (const a of this.d.annotations) this.drawAnnotation(a, tables);
    this.drawTitleBlock(scale);

    const blocks = [...tables.map((t) => ({ id: t.a.id, box: t.box })), ...this.notes().map((n) => ({ id: n.a.id, box: n.box }))];
    return {
      size: this.d.sheet.size,
      width: this.width,
      height: this.height,
      projection: this.d.sheet.projection,
      scale,
      scaleText: scaleText(scale),
      frame: this.frame,
      titleBlock: this.titleBlock,
      views,
      annotations: this.d.annotations.map((a) => this.annotations.get(a.id) ?? { id: a.id, type: a.type, text: "", box: null }),
      blocks,
      prims: this.prims,
      problems: this.problems,
      cutList: this.cut,
    };
  }

  // ------------------------------------------------------------- layout

  private outline(view: DrawingView): Box | null {
    const pv = this.projected.get(view.id);
    if (!pv || pv.look !== view.look) return null;
    const pts: Vec2[] = [];
    for (const b of pv.bodies) for (const line of [...b.visible, ...(view.hidden ? b.hidden : [])]) pts.push(...line);
    return boxOf(pts);
  }

  /** Where each view sits in the projection, from the front: [dx, dy], or null when it is placed on its own. */
  private grid(): Map<string, Vec2> {
    const out = new Map<string, Vec2>();
    const taken = new Set<string>();
    for (const view of this.d.views) {
      const g = placeFromFront(view.look, this.d.sheet.projection);
      if (!g || view.at) continue;
      const key = String(g);
      if (taken.has(key)) continue;
      taken.add(key);
      out.set(view.id, g);
    }
    return out;
  }

  /** Decides each dimension's side and its place in the stack. */
  private planDimensions(): void {
    const grid = this.grid();
    const occupied = new Set([...grid.values()].map(String));
    const neighbour = (id: string, dx: number, dy: number) => {
      const g = grid.get(id);
      return !!g && occupied.has(String([g[0] + dx, g[1] + dy]));
    };
    const byView = new Map<string, DimPlan[]>();
    for (const a of this.d.annotations) {
      if (a.type !== "dimension") continue;
      const view = this.d.views.find((x) => x.id === a.view);
      if (!view) continue;
      const pts = this.dimPoints(a, view);
      if ("problem" in pts) continue;
      const { dir, span, near } = pts;
      let side: Side;
      if (a.offset !== undefined && a.offset !== 0) side = a.offset > 0 ? 1 : -1;
      else if (dir === "a") side = 1;
      else {
        // Away from the views beside it; a member's dimension goes on the side it is nearer.
        const toward = (sd: Side) => (dir === "h" ? neighbour(a.view, 0, sd) : neighbour(a.view, sd, 0));
        side = near ?? (toward(-1) && !toward(1) ? 1 : -1);
        if (near !== undefined && toward(side) && !toward(-side as Side)) side = -side as Side;
      }
      const plan: DimPlan = { a, dir, side, span, stack: 0 };
      this.dims.set(a.id, plan);
      byView.set(a.view, [...(byView.get(a.view) ?? []), plan]);
    }
    for (const plans of byView.values()) {
      for (const dir of ["h", "v"] as const) {
        for (const side of [-1, 1] as const) {
          const stack = plans.filter((p) => p.dir === dir && p.side === side && p.a.offset === undefined).sort((x, y) => x.span - y.span);
          stack.forEach((p, i) => (p.stack = i));
        }
      }
    }
  }

  /** Room each view's annotations need around it, sheet mm: [left, bottom, right, top]. */
  private padding(view: DrawingView): [number, number, number, number] {
    const pad: [number, number, number, number] = [INSET, INSET, INSET, INSET];
    const need = (i: number, mm: number) => (pad[i] = Math.max(pad[i], mm));
    const text = TEXT.dimension * CAP + 3;
    for (const p of this.dims.values()) {
      if (p.a.view !== view.id) continue;
      const dist = p.a.offset !== undefined ? Math.abs(p.a.offset) : DIM_FIRST + DIM_STEP * p.stack;
      if (p.dir === "h") need(p.side < 0 ? 1 : 3, dist + text);
      else if (p.dir === "v") need(p.side < 0 ? 0 : 2, dist + text);
      else for (let i = 0; i < 4; i++) need(i, DIM_FIRST + text);
    }
    for (const a of this.d.annotations) {
      if (!("view" in a) || a.view !== view.id || ("at" in a && a.at)) continue;
      const room = a.type === "balloon" ? 2 * BALLOON_R + 7 : a.type === "weld" ? 16 : a.type === "hole" ? 18 : 0;
      for (let i = 0; i < 4; i++) need(i, room);
    }
    return pad;
  }

  private layout(blocked: Box[]): { scale: number; views: ComposedView[] } {
    const fixed = parseScale(this.d.sheet.scale);
    const grid = this.grid();
    const loose = this.d.views.filter((view) => !view.at && !grid.has(view.id));
    const candidates = fixed ? [fixed] : STANDARD_SCALES.map((s) => parseScale(s)!);
    if (fixed) return { scale: fixed, views: this.place(fixed, fixed, grid, loose) };
    for (let i = 0; i < candidates.length; i++) {
      // A view placed on its own (the iso) may go a step or two smaller to fit.
      for (const step of loose.length ? [0, 1, 2] : [0]) {
        const looseScale = candidates[Math.min(i + step, candidates.length - 1)];
        const views = this.place(candidates[i], looseScale, grid, loose);
        if (this.fits(views, blocked)) return { scale: candidates[i], views };
      }
    }
    // Nothing fits: the smallest scale, and the checks say what overlaps.
    const smallest = candidates[candidates.length - 1];
    return { scale: smallest, views: this.place(smallest, smallest, grid, loose) };
  }

  /**
   * True when every view placed automatically, with the room its annotations
   * need, is on the sheet and clear of the title block, the tables, the notes
   * and every other view. A view the user placed is an obstacle, not judged:
   * where it is is theirs (the checks say if it overlaps).
   */
  private fits(views: ComposedView[], blocked: Box[]): boolean {
    const padded = views.filter((cv) => cv.box).map((cv) => ({ cv, box: grow(cv.box!, this.padding(this.d.views.find((x) => x.id === cv.id)!)) }));
    const auto = padded.filter((p) => p.cv.auto);
    const held = padded.filter((p) => !p.cv.auto).map((p) => p.cv.box!);
    for (const { box } of auto) {
      if (!inside(box, this.frame)) return false;
      if ([...blocked, ...held].some((b) => overlaps(box, b))) return false;
    }
    for (let i = 0; i < auto.length; i++) for (let j = i + 1; j < auto.length; j++) if (overlaps(auto[i].box, auto[j].box)) return false;
    return true;
  }

  private place(scale: number, looseScale: number, grid: Map<string, Vec2>, loose: DrawingView[]): ComposedView[] {
    const out = new Map<string, ComposedView>();
    const make = (view: DrawingView, k: number, at: Vec2): ComposedView => {
      const outline = this.outline(view);
      const origin = outline ? centre(outline) : ([0, 0] as Vec2);
      const half = outline ? ([(size(outline)[0] * k) / 2, (size(outline)[1] * k) / 2] as Vec2) : ([0, 0] as Vec2);
      return {
        id: view.id,
        look: view.look,
        scale: k,
        scaleText: scaleText(k),
        auto: !view.at,
        centre: at,
        origin,
        outline,
        box: outline ? { min: [at[0] - half[0], at[1] - half[1]], max: [at[0] + half[0], at[1] + half[1]] } : null,
      };
    };
    const own = (view: DrawingView, fallback: number) => parseScale(view.scale) ?? fallback;
    // Views with a place of their own.
    for (const view of this.d.views) if (view.at) out.set(view.id, make(view, own(view, scale), view.at));
    // The projection: columns and rows around the front, each view's lines aligned with its neighbours'.
    const inGrid = this.d.views.filter((view) => grid.has(view.id));
    if (inGrid.length) {
      const ext = new Map<string, { half: Vec2; pad: [number, number, number, number]; k: number }>();
      for (const view of inGrid) {
        const k = own(view, scale);
        const o = this.outline(view);
        ext.set(view.id, { half: o ? [(size(o)[0] * k) / 2, (size(o)[1] * k) / 2] : [0, 0], pad: this.padding(view), k });
      }
      const cols = [...new Set(inGrid.map((view) => grid.get(view.id)![0]))].sort((a, b) => a - b);
      const rows = [...new Set(inGrid.map((view) => grid.get(view.id)![1]))].sort((a, b) => b - a); // top row first
      const colExt = cols.map((c) => {
        const in_ = inGrid.filter((view) => grid.get(view.id)![0] === c).map((view) => ext.get(view.id)!);
        return { left: Math.max(...in_.map((e) => e.half[0] + e.pad[0])), right: Math.max(...in_.map((e) => e.half[0] + e.pad[2])) };
      });
      const rowExt = rows.map((r) => {
        const in_ = inGrid.filter((view) => grid.get(view.id)![1] === r).map((view) => ext.get(view.id)!);
        return { bottom: Math.max(...in_.map((e) => e.half[1] + e.pad[1])), top: Math.max(...in_.map((e) => e.half[1] + e.pad[3])) };
      });
      // The group's top left corner sits at the frame's top left.
      const colX: number[] = [];
      let x = this.frame.min[0] + INSET;
      colExt.forEach((e, i) => {
        colX[i] = x + e.left;
        x += e.left + e.right + GAP;
      });
      const rowY: number[] = [];
      let y = this.frame.max[1] - INSET;
      rowExt.forEach((e, i) => {
        rowY[i] = y - e.top;
        y -= e.top + e.bottom + GAP;
      });
      for (const view of inGrid) {
        const g = grid.get(view.id)!;
        out.set(view.id, make(view, ext.get(view.id)!.k, [colX[cols.indexOf(g[0])], rowY[rows.indexOf(g[1])]]));
      }
    }
    // The rest down the right, from the top.
    let top = this.frame.max[1] - INSET;
    for (const view of loose) {
      const k = own(view, looseScale);
      const o = this.outline(view);
      const half: Vec2 = o ? [(size(o)[0] * k) / 2, (size(o)[1] * k) / 2] : [0, 0];
      const pad = this.padding(view);
      const at: Vec2 = [this.frame.max[0] - INSET - pad[2] - half[0], top - pad[3] - half[1]];
      out.set(view.id, make(view, k, at));
      top = at[1] - half[1] - pad[1] - GAP;
    }
    return this.d.views.map((view) => out.get(view.id)!).filter(Boolean);
  }

  // ------------------------------------------------------------- views

  private cv(id: string): ComposedView | undefined {
    return this.views.find((x) => x.id === id);
  }

  private toSheet(cv: ComposedView, p: Vec2): Vec2 {
    return [cv.centre[0] + (p[0] - cv.origin[0]) * cv.scale, cv.centre[1] + (p[1] - cv.origin[1]) * cv.scale];
  }

  private border(): void {
    const f = this.frame;
    this.prims.push({ k: "line", pts: [f.min, [f.max[0], f.min[1]], f.max, [f.min[0], f.max[1]]], closed: true, w: LINE.border, owner: "sheet" });
  }

  private drawView(cv: ComposedView): void {
    const view = this.d.views.find((x) => x.id === cv.id)!;
    const pv = this.projected.get(cv.id);
    if (!cv.outline || !pv) {
      this.problems.push(`${cv.id}: shows nothing${this.ctx.geometry ? "" : " yet (the part hasn't been projected)"}`);
      return;
    }
    for (const b of pv.bodies) {
      if (view.hidden) for (const line of b.hidden) this.prims.push({ k: "line", pts: line.map((p) => this.toSheet(cv, p)), w: LINE.thin, dash: [3, 1.5], owner: cv.id });
      for (const line of b.visible) this.prims.push({ k: "line", pts: line.map((p) => this.toSheet(cv, p)), w: LINE.visible, owner: cv.id });
    }
    const sheetScale = parseScale(this.d.sheet.scale);
    const label = cv.look === "iso" ? "ISO" : cv.look.toUpperCase();
    if (cv.box && Math.abs(cv.scale - (sheetScale ?? this.mainScale())) > 1e-9) {
      const p: Prim = { k: "text", at: [cv.centre[0], cv.box.min[1] - 7], text: `${label}  SCALE ${cv.scaleText}`, size: TEXT.label * 1.4, anchor: "middle", owner: cv.id };
      this.prims.push(p);
      this.labels.push(grow(primBox(p, textWidth)!, 1));
    }
  }

  /** The scale most views are drawn at. */
  private mainScale(): number {
    const counts = new Map<number, number>();
    for (const cv of this.views) counts.set(cv.scale, (counts.get(cv.scale) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 1;
  }

  // ---------------------------------------------------------- annotations

  private fail(a: Annotation, problem: string): void {
    this.problems.push(`${a.id}: ${problem}`);
    this.annotations.set(a.id, { id: a.id, type: a.type, ...("view" in a ? { view: a.view } : {}), text: "", box: null, problem });
  }

  private drawAnnotation(a: Annotation, tables: { a: TableAnnotation; box: Box; rows: string[][]; widths: number[] }[]): void {
    const start = this.prims.length;
    let text = "";
    let extra: Partial<ComposedAnnotation> = {};
    if (a.type === "table") {
      const t = tables.find((x) => x.a.id === a.id)!;
      this.drawTable(t);
      text = a.table === "cutList" ? `cut list, ${t.rows.length - 2} item${t.rows.length - 2 === 1 ? "" : "s"}` : `weld table, ${t.rows.length - 2} weld${t.rows.length - 2 === 1 ? "" : "s"}`;
      extra = { at: [t.box.min[0], t.box.max[1]] };
    } else if (a.type === "note") {
      this.drawNote(a);
      text = a.text;
      extra = { at: a.at };
    } else {
      const cv = this.cv(a.view);
      if (!cv || !cv.outline) return this.fail(a, `its view ${a.view} shows nothing`);
      const r =
        a.type === "dimension" ? this.drawDimension(a, cv) : a.type === "balloon" ? this.drawBalloon(a, cv) : a.type === "hole" ? this.drawHole(a, cv) : this.drawWeld(a, cv);
      if ("problem" in r) return this.fail(a, r.problem);
      ({ text, ...extra } = r);
    }
    const mine = this.prims.slice(start);
    for (const p of mine) p.owner = a.id;
    const box = mine.reduce<Box | null>((acc, p) => union(acc, primBox(p, textWidth)), null);
    this.annotations.set(a.id, { id: a.id, type: a.type, ...("view" in a ? { view: a.view } : {}), text, ...extra, box });
  }

  private nodes(): Record<string, Vec3> {
    return this.v.nodes;
  }

  private member(id: string) {
    return this.ctx.measurements?.members.find((m) => m.id === id);
  }

  /** A dimension point in the view, model mm. A side of the view's outline has only the coordinate it names. */
  private point(ref: string, f: ViewFrame, outline: Box): { p: Vec2; side?: "x" | "y" } | { problem: string } {
    const r = pointRef(ref);
    if (!r) return { problem: `"${ref}" is not a point` };
    if (r.kind === "side") {
      const s = r.side;
      return s === "@left" ? { p: [outline.min[0], NaN], side: "x" } : s === "@right" ? { p: [outline.max[0], NaN], side: "x" } : s === "@bottom" ? { p: [NaN, outline.min[1]], side: "y" } : { p: [NaN, outline.max[1]], side: "y" };
    }
    if (r.kind === "end") {
      const m = this.member(r.member);
      if (!m) return { problem: `no member "${r.member}" built` };
      return { p: inView(m.ends[r.end === "start" ? 0 : 1], f) };
    }
    const node = this.nodes()[r.name];
    if (node) return { p: inView(node, f) };
    const hole = this.holes.get(r.name);
    if (hole) return { p: inView(hole.entry, f) };
    return { problem: `no node or hole "${r.name}" in the part` };
  }

  /** A dimension's points in its view, how it runs, and how long it is. */
  private dimPoints(a: DimensionAnnotation, view: DrawingView): { p1: Vec2; p2: Vec2; dir: "h" | "v" | "a"; span: number; near?: Side; value: number } | { problem: string } {
    const f = viewFrame(view.look);
    const outline = this.outline(view);
    if (!outline) return { problem: `its view ${view.id} shows nothing` };
    if (!isOrthographic(view.look)) return { problem: `${view.id} is an iso view, which shortens every length` };
    if (a.member !== undefined) {
      const m = this.member(a.member);
      if (!m) return { problem: `no member "${a.member}" built` };
      const p1 = inView(m.ends[0], f);
      const p2 = inView(m.ends[1], f);
      const along = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      if (along < m.length * 0.999) return { problem: `${a.member} doesn't lie flat in ${view.id} (it runs ${along < 1e-6 ? "straight at the viewer" : "at an angle to it"}): dimension it in a view it lies flat in` };
      const dir = Math.abs(p2[1] - p1[1]) < 1e-6 ? "h" : Math.abs(p2[0] - p1[0]) < 1e-6 ? "v" : "a";
      const c = centre(outline);
      const mid: Vec2 = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
      const near: Side = dir === "h" ? (mid[1] >= c[1] ? 1 : -1) : mid[0] >= c[0] ? 1 : -1;
      return { p1, p2, dir, span: m.length, near: dir === "a" ? undefined : near, value: m.length };
    }
    const q1 = this.point(a.from!, f, outline);
    const q2 = this.point(a.to!, f, outline);
    if ("problem" in q1) return q1;
    if ("problem" in q2) return q2;
    const sides = [q1.side, q2.side].filter(Boolean);
    let dir: "h" | "v" | "a";
    if (a.direction) dir = a.direction === "horizontal" ? "h" : a.direction === "vertical" ? "v" : "a";
    else if (sides.length) dir = sides[0] === "x" ? "h" : "v";
    else dir = Math.abs(q2.p[0] - q1.p[0]) >= Math.abs(q2.p[1] - q1.p[1]) ? "h" : "v";
    for (const [q, ref] of [[q1, a.from], [q2, a.to]] as const) {
      if (q.side === "x" && dir !== "h") return { problem: `${ref} is a side of the view: use it in a horizontal dimension` };
      if (q.side === "y" && dir !== "v") return { problem: `${ref} is the top or bottom of the view: use it in a vertical dimension` };
    }
    // A side has only its own coordinate: the other comes from the view's edge nearest the dimension.
    const fill = (p: Vec2): Vec2 => [Number.isNaN(p[0]) ? outline.min[0] : p[0], Number.isNaN(p[1]) ? outline.min[1] : p[1]];
    const p1 = fill(q1.p);
    const p2 = fill(q2.p);
    const value = dir === "h" ? Math.abs(p2[0] - p1[0]) : dir === "v" ? Math.abs(p2[1] - p1[1]) : Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    if (value < 1e-6) return { problem: `${a.from} and ${a.to} are at the same place ${dir === "h" ? "across" : dir === "v" ? "up" : "in"} ${view.id}` };
    return { p1, p2, dir, span: value, value };
  }

  private drawDimension(a: DimensionAnnotation, cv: ComposedView): { text: string; value: number; along: Vec3 } | { problem: string } {
    const view = this.d.views.find((x) => x.id === cv.id)!;
    const r = this.dimPoints(a, view);
    if ("problem" in r) return r;
    const plan = this.dims.get(a.id);
    const f = viewFrame(view.look);
    const s1 = this.toSheet(cv, r.p1);
    const s2 = this.toSheet(cv, r.p2);
    // Sides: put the extension line's foot on the view's edge nearest the dimension.
    const box = cv.box!;
    const side = plan?.side ?? -1;
    const dist = a.offset !== undefined ? Math.abs(a.offset) : DIM_FIRST + DIM_STEP * (plan?.stack ?? 0);
    const fromSide = (s: Vec2, ref?: string) => {
      const pr = ref ? pointRef(ref) : null;
      if (pr?.kind !== "side") return s;
      if (r.dir === "h") return [s[0], side > 0 ? box.max[1] : box.min[1]] as Vec2;
      return [side > 0 ? box.max[0] : box.min[0], s[1]] as Vec2;
    };
    const a1 = fromSide(s1, a.from);
    const a2 = fromSide(s2, a.to);
    const text = fmt(r.value);
    let u: Vec2;
    let n: Vec2;
    let level: number;
    if (r.dir === "h") {
      u = [1, 0];
      n = [0, side];
      level = side > 0 ? box.max[1] + dist : box.min[1] - dist;
    } else if (r.dir === "v") {
      u = [0, 1];
      n = [side, 0];
      level = side > 0 ? box.max[0] + dist : box.min[0] - dist;
    } else {
      const d: Vec2 = [a2[0] - a1[0], a2[1] - a1[1]];
      const len = Math.hypot(d[0], d[1]);
      u = [d[0] / len, d[1] / len];
      n = [-u[1], u[0]];
      // Away from the view's centre.
      const mid: Vec2 = [(a1[0] + a2[0]) / 2, (a1[1] + a2[1]) / 2];
      if ((mid[0] - cv.centre[0]) * n[0] + (mid[1] - cv.centre[1]) * n[1] < 0) n = [-n[0], -n[1]];
      level = Math.max(a1[0] * n[0] + a1[1] * n[1], a2[0] * n[0] + a2[1] * n[1]) + (a.offset !== undefined ? Math.abs(a.offset) : DIM_FIRST);
    }
    if (r.dir !== "a") level *= r.dir === "h" ? n[1] : n[0];
    this.linear(a1, a2, u, n, level, text);
    const along = r.dir === "h" ? f.right : r.dir === "v" ? f.up : normalize3(toModel([r.p2[0] - r.p1[0], r.p2[1] - r.p1[1]], f));
    return { text, value: r.value, along };
  }

  /**
   * A linear dimension: extension lines from a and b to the dimension line
   * {x : x·n = level}, the line with arrows, and the text above it.
   */
  private linear(a: Vec2, b: Vec2, u: Vec2, n: Vec2, level: number, text: string): void {
    const foot = (p: Vec2): Vec2 => {
      const t = level - (p[0] * n[0] + p[1] * n[1]);
      return [p[0] + n[0] * t, p[1] + n[1] * t];
    };
    const fa = foot(a);
    const fb = foot(b);
    for (const [p, q] of [
      [a, fa],
      [b, fb],
    ] as const) {
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 2) continue;
      const dir: Vec2 = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
      this.prims.push({ k: "line", pts: [[p[0] + dir[0] * 1.5, p[1] + dir[1] * 1.5], [q[0] + dir[0] * 2, q[1] + dir[1] * 2]], w: LINE.thin });
    }
    const span = (fb[0] - fa[0]) * u[0] + (fb[1] - fa[1]) * u[1];
    const along: Vec2 = span >= 0 ? u : [-u[0], -u[1]];
    const inside = Math.abs(span) >= 2 * ARROW.length + 4;
    if (inside) {
      this.prims.push({ k: "line", pts: [fa, fb], w: LINE.thin });
      this.arrow(fa, [-along[0], -along[1]]);
      this.arrow(fb, along);
    } else {
      // Too short for arrows inside: they point in from outside.
      this.prims.push({ k: "line", pts: [[fa[0] - along[0] * 6, fa[1] - along[1] * 6], [fb[0] + along[0] * 6, fb[1] + along[1] * 6]], w: LINE.thin });
      this.arrow(fa, along);
      this.arrow(fb, [-along[0], -along[1]]);
    }
    // Text reads from the bottom or the right of the sheet, above the line.
    let t = along;
    let angle = (Math.atan2(t[1], t[0]) * 180) / Math.PI;
    if (angle <= -90 + 1e-6 || angle > 90 + 1e-6) {
      t = [-t[0], -t[1]];
      angle = (Math.atan2(t[1], t[0]) * 180) / Math.PI;
    }
    const up: Vec2 = [-t[1], t[0]];
    const mid: Vec2 = [(fa[0] + fb[0]) / 2 + up[0] * 1.2, (fa[1] + fb[1]) / 2 + up[1] * 1.2];
    this.prims.push({ k: "text", at: mid, text, size: TEXT.dimension, anchor: "middle", ...(Math.abs(angle) > 1e-6 ? { angle: round3(angle) } : {}) });
  }

  /** A filled arrowhead with its tip at `tip`, pointing along `dir`. */
  private arrow(tip: Vec2, dir: Vec2): void {
    const back: Vec2 = [tip[0] - dir[0] * ARROW.length, tip[1] - dir[1] * ARROW.length];
    const side: Vec2 = [-dir[1] * ARROW.half, dir[0] * ARROW.half];
    this.prims.push({ k: "line", pts: [tip, [back[0] + side[0], back[1] + side[1]], [back[0] - side[0], back[1] - side[1]]], closed: true, fill: true, w: LINE.thin });
  }

  /** A point outside the view's box, along the direction from its centre through `from`. */
  private outside(cv: ComposedView, from: Vec2, clear: number, dir?: Vec2): Vec2 {
    let d = dir ?? ([from[0] - cv.centre[0], from[1] - cv.centre[1]] as Vec2);
    const len = Math.hypot(d[0], d[1]);
    d = len < 1e-9 ? [Math.SQRT1_2, Math.SQRT1_2] : [d[0] / len, d[1] / len];
    const box = grow(cv.box!, clear);
    let t = 0;
    for (const i of [0, 1]) {
      if (d[i] > 1e-9) t = Math.max(t, (box.max[i] - from[i]) / d[i]);
      if (d[i] < -1e-9) t = Math.max(t, (box.min[i] - from[i]) / d[i]);
    }
    return [from[0] + d[0] * t, from[1] + d[1] * t];
  }

  private bodyOf(memberId: string): string | undefined {
    return this.member(memberId)?.body;
  }

  /** The middle of the longest visible line of a body in a view, view mm, and how much of it shows. */
  visibleAnchor(viewId: string, body: string): { at: Vec2; length: number } | null {
    const pv = this.projected.get(viewId);
    const b = pv?.bodies.find((x) => x.name === body);
    if (!b) return null;
    let best: { at: Vec2; length: number; seg: number } | null = null;
    let total = 0;
    for (const line of b.visible) {
      for (let i = 1; i < line.length; i++) {
        const len = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
        total += len;
        if (!best || len > best.seg) best = { at: [(line[i][0] + line[i - 1][0]) / 2, (line[i][1] + line[i - 1][1]) / 2], length: 0, seg: len };
      }
    }
    return best && best.seg > 1e-6 ? { at: best.at, length: total } : null;
  }

  private placedBalloons: { view: string; c: Vec2; r: number }[] = [];

  /**
   * Where a balloon goes: on a ring just outside its view, as near its member
   * as it can be while on the sheet, clear of the other balloons, views,
   * tables and the title block.
   */
  private balloonSpot(cv: ComposedView, tip: Vec2, r: number): Vec2 {
    const blocked = [this.titleBlock, ...this.views.filter((x) => x.id !== cv.id && x.box).map((x) => grow(x.box!, 2)), ...this.tableBoxes, ...this.labels];
    const frame = grow(this.frame, -(r + 1));
    let best: { c: Vec2; cost: number } | null = null;
    for (let k = 0; k < 72; k++) {
      const t = (k / 72) * 2 * Math.PI;
      const c = this.outside(cv, cv.centre, 6 + r, [Math.cos(t), Math.sin(t)]);
      if (!inside({ min: c, max: c }, frame)) continue;
      const box: Box = { min: [c[0] - r, c[1] - r], max: [c[0] + r, c[1] + r] };
      if (blocked.some((b) => overlaps(box, b))) continue;
      if (this.placedBalloons.some((b) => Math.hypot(b.c[0] - c[0], b.c[1] - c[1]) < b.r + r + 3)) continue;
      const cost = Math.hypot(c[0] - tip[0], c[1] - tip[1]);
      if (!best || cost < best.cost) best = { c, cost };
    }
    return best?.c ?? this.outside(cv, tip, 6 + r);
  }

  /**
   * Where a weld symbol's reference line starts: just outside its view, above
   * it if there is room, as near the weld as it can be, with the whole line
   * and its text on the sheet and clear of everything else.
   */
  private weldSpot(cv: ComposedView, tip: Vec2): { knee: Vec2; dir: 1 | -1 } {
    const blocked = [this.titleBlock, ...this.views.filter((x) => x.id !== cv.id && x.box).map((x) => grow(x.box!, 2)), ...this.tableBoxes, ...this.labels];
    let best: { knee: Vec2; dir: 1 | -1; cost: number } | null = null;
    for (let k = 0; k < 72; k++) {
      const t = (k / 72) * 2 * Math.PI;
      const knee = this.outside(cv, cv.centre, 8, [Math.cos(t), Math.sin(t)]);
      const away: 1 | -1 = knee[0] >= cv.centre[0] ? 1 : -1;
      // The reference line runs away from the view if it can, else back over it.
      for (const dir of [away, -away as 1 | -1]) {
        const box: Box = { min: [Math.min(knee[0], knee[0] + dir * WELD_LINE) - 2, knee[1] - 6], max: [Math.max(knee[0], knee[0] + dir * WELD_LINE) + 2, knee[1] + 2] };
        if (!inside(box, this.frame) || blocked.some((b) => overlaps(box, b))) continue;
        if (this.placedBalloons.some((b) => b.view === cv.id && overlaps(box, { min: [b.c[0] - b.r, b.c[1] - b.r], max: [b.c[0] + b.r, b.c[1] + b.r] }))) continue;
        // Above or beside the view reads best; below it, under the dimensions, does not.
        const cost = Math.hypot(knee[0] - tip[0], knee[1] - tip[1]) + (knee[1] < cv.box!.min[1] ? 40 : 0) + (dir === away ? 0 : 6);
        if (!best || cost < best.cost) best = { knee, dir, cost };
      }
    }
    return best ?? { knee: this.outside(cv, tip, 8, [tip[0] >= cv.centre[0] ? 1 : -1, 1]), dir: tip[0] >= cv.centre[0] ? 1 : -1 };
  }

  private drawBalloon(a: BalloonAnnotation, cv: ComposedView): { text: string; item: number; at: Vec2 } | { problem: string } {
    const body = this.bodyOf(a.member);
    if (!body) return { problem: `no member "${a.member}" built` };
    const item = this.cut.find((i) => i.members.includes(a.member));
    if (!item) return { problem: `${a.member} is not in the cut list` };
    const anchor = this.visibleAnchor(cv.id, body);
    if (!anchor) return { problem: `${a.member} can't be seen in ${cv.id}: balloon it in a view that shows it` };
    const tip = this.toSheet(cv, anchor.at);
    const text = String(item.item);
    const r = text.length > 1 ? BALLOON_R + 0.7 : BALLOON_R;
    const c: Vec2 = a.at ? [cv.centre[0] + a.at[0], cv.centre[1] + a.at[1]] : this.balloonSpot(cv, tip, r);
    this.placedBalloons.push({ view: cv.id, c, r });
    const d: Vec2 = [tip[0] - c[0], tip[1] - c[1]];
    const len = Math.hypot(d[0], d[1]);
    if (len > r + 0.5) {
      this.prims.push({ k: "line", pts: [[c[0] + (d[0] / len) * r, c[1] + (d[1] / len) * r], tip], w: LINE.thin });
      this.prims.push({ k: "circle", c: tip, r: 0.7, w: LINE.thin, fill: true });
    }
    this.prims.push({ k: "circle", c, r, w: LINE.thin });
    this.prims.push({ k: "text", at: [c[0], c[1] - (TEXT.balloon * CAP) / 2], text, size: TEXT.balloon, anchor: "middle" });
    return { text, item: item.item, at: c };
  }

  private drawHole(a: HoleAnnotation, cv: ComposedView): { text: string; at: Vec2 } | { problem: string } {
    const h = this.holes.get(a.hole);
    if (!h) return { problem: `no hole "${a.hole}" built` };
    const f = viewFrame(cv.look);
    const facing = Math.abs(h.axis[0] * f.eye[0] + h.axis[1] * f.eye[1] + h.axis[2] * f.eye[2]);
    if (facing < 0.999) return { problem: `${a.hole} isn't seen as a circle in ${cv.id}: call it out in a view that looks along it` };
    const lines = holeText(h);
    const c = this.toSheet(cv, inView(h.entry, f));
    const r = ((h.counterbore?.diameter ?? h.countersink?.diameter ?? h.diameter) / 2) * cv.scale;
    // Its centre mark.
    const m = r + 2;
    this.prims.push({ k: "line", pts: [[c[0] - m, c[1]], [c[0] + m, c[1]]], w: LINE.thin, dash: [6, 1.5, 1, 1.5] });
    this.prims.push({ k: "line", pts: [[c[0], c[1] - m], [c[0], c[1] + m]], w: LINE.thin, dash: [6, 1.5, 1, 1.5] });
    const at: Vec2 = a.at ? [cv.centre[0] + a.at[0], cv.centre[1] + a.at[1]] : this.outside(cv, [c[0] + 1, c[1] + 1], 8, [1, 1]);
    const right = at[0] >= c[0];
    const w = Math.max(...lines.map((l) => textWidth(l, TEXT.dimension)));
    // Leader from the hole's edge to a landing under the text.
    const d: Vec2 = [at[0] - c[0], at[1] - c[1]];
    const len = Math.hypot(d[0], d[1]) || 1;
    const edge: Vec2 = [c[0] + (d[0] / len) * r, c[1] + (d[1] / len) * r];
    const landing: Vec2 = [at[0] + (right ? w + 1 : -w - 1), at[1]];
    this.prims.push({ k: "line", pts: [landing, at, edge], w: LINE.thin });
    this.arrow(edge, [-d[0] / len, -d[1] / len]);
    lines.forEach((l, i) =>
      this.prims.push({ k: "text", at: [at[0] + (right ? 0.5 : -0.5), at[1] + 1.2 - i * TEXT.dimension * 1.25], text: l, size: TEXT.dimension, anchor: right ? "start" : "end" }),
    );
    return { text: lines.join(" "), at };
  }

  /** Where two bodies meet: the middle of where their boxes overlap (or come closest). */
  private weldPoint(between: string[]): Vec3 | null {
    const boxes = between.slice(0, 2).map((n) => this.ctx.measurements?.bodies.find((b) => b.name === n)?.boundingBox);
    if (boxes.length < 2 || !boxes[0] || !boxes[1]) return null;
    const [p, q] = boxes as NonNullable<(typeof boxes)[0]>[];
    return [0, 1, 2].map((i) => {
      const lo = Math.max(p.min[i], q.min[i]);
      const hi = Math.min(p.max[i], q.max[i]);
      return (lo + hi) / 2;
    }) as Vec3;
  }

  private drawWeld(a: WeldAnnotation, cv: ComposedView): { text: string; at: Vec2 } | { problem: string } {
    const w = this.v.welds.find((x) => x.id === a.weld);
    if (!w) return { problem: `no weld "${a.weld}" in the weld table` };
    const at3 = this.weldPoint(w.between);
    if (!at3) return { problem: `the bodies of ${w.id} (${w.between.join(", ")}) aren't built` };
    const f = viewFrame(cv.look);
    const tip = this.toSheet(cv, inView(at3, f));
    const spot = a.at ? { knee: [cv.centre[0] + a.at[0], cv.centre[1] + a.at[1]] as Vec2, dir: (a.at[0] >= 0 ? 1 : -1) as 1 | -1 } : this.weldSpot(cv, tip);
    const { knee, dir } = spot;
    const end: Vec2 = [knee[0] + dir * WELD_LINE, knee[1]];
    this.placedBalloons.push({ view: cv.id, c: [knee[0] + (dir * WELD_LINE) / 2, knee[1] - 2], r: WELD_LINE / 2 });
    const d: Vec2 = [tip[0] - knee[0], tip[1] - knee[1]];
    const len = Math.hypot(d[0], d[1]) || 1;
    this.prims.push({ k: "line", pts: [tip, knee, end], w: LINE.thin });
    this.arrow(tip, [d[0] / len, d[1] / len]);
    if (w.allRound) this.prims.push({ k: "circle", c: knee, r: 1.6, w: LINE.thin });
    // The symbol on the arrow side: under the reference line (ISO 2553).
    const sx = knee[0] + dir * 8 - (dir < 0 ? 4 : 0);
    const y = knee[1];
    if (w.type === "fillet") this.prims.push({ k: "line", pts: [[sx, y], [sx, y - 4], [sx + 4, y]], closed: true, w: LINE.thin });
    else if (w.type === "butt") {
      this.prims.push({ k: "line", pts: [[sx + 0.8, y], [sx + 0.8, y - 4]], w: LINE.thin });
      this.prims.push({ k: "line", pts: [[sx + 3.2, y], [sx + 3.2, y - 4]], w: LINE.thin });
    } else this.prims.push({ k: "line", pts: [[sx, y], [sx, y - 3], [sx + 4, y - 3], [sx + 4, y]], w: LINE.thin });
    const textY = y - 3.6;
    this.prims.push({ k: "text", at: [sx - 1, textY], text: fmt(w.size), size: TEXT.dimension, anchor: "end" });
    this.prims.push({ k: "text", at: [sx + 5, textY], text: fmt(w.length), size: TEXT.dimension, anchor: "start" });
    return { text: `${w.id}: ${w.type} ${fmt(w.size)}, ${fmt(w.length)} long${w.allRound ? ", all round" : ""}`, at: knee };
  }

  // --------------------------------------------------------------- tables

  private tableRows(a: TableAnnotation): { rows: string[][]; widths: number[] } {
    if (a.table === "cutList") {
      return {
        widths: [14, 52, 24, 40, 16, 34],
        rows: [
          ["CUT LIST"],
          ["ITEM", "SIZE", "LENGTH", "ENDS", "QTY", "KG"],
          ...this.cut.map((i) => [String(i.item), i.designation, fmt(i.length), anglesText(i.angles), String(i.quantity), i.kgTotal.toFixed(2)]),
        ],
      };
    }
    return {
      widths: [16, 70, 22, 16, 22, 34],
      rows: [["WELDS"], ["WELD", "BETWEEN", "TYPE", "SIZE", "LENGTH", "NOTE"], ...this.v.welds.map((w) => [w.id, w.between.join(" + "), w.type, fmt(w.size), fmt(w.length), w.allRound ? "all round" : (w.note ?? "")])],
    };
  }

  /**
   * Tables placed automatically: the first above the title block, the rest
   * along the bottom border to its left, so the column above the title block
   * stays short and the views keep their room.
   */
  private placeTables(): { a: TableAnnotation; box: Box; rows: string[][]; widths: number[] }[] {
    let left = this.titleBlock.min[0];
    let first = true;
    const out: { a: TableAnnotation; box: Box; rows: string[][]; widths: number[] }[] = [];
    for (const a of this.d.annotations) {
      if (a.type !== "table") continue;
      const { rows, widths } = this.tableRows(a);
      const w = widths.reduce((x, y) => x + y, 0);
      const h = rows.length * ROW;
      let box: Box;
      if (a.at) box = { min: [a.at[0], a.at[1] - h], max: [a.at[0] + w, a.at[1]] };
      else if (first) {
        box = { min: [this.frame.max[0] - w, this.titleBlock.max[1]], max: [this.frame.max[0], this.titleBlock.max[1] + h] };
        first = false;
      } else {
        box = { min: [left - w, this.frame.min[1]], max: [left, this.frame.min[1] + h] };
        left -= w;
      }
      out.push({ a, box, rows, widths });
    }
    return out;
  }

  private drawTable(t: { a: TableAnnotation; box: Box; rows: string[][]; widths: number[] }): void {
    const { box, rows, widths } = t;
    const x0 = box.min[0];
    const x1 = box.max[0];
    const line = (pts: Vec2[], w: number = LINE.thin) => this.prims.push({ k: "line", pts, w });
    line([box.min, [x1, box.min[1]], box.max, [x0, box.max[1]], box.min], LINE.visible);
    rows.forEach((row, r) => {
      const top = box.max[1] - r * ROW;
      if (r > 0) line([[x0, top], [x1, top]], r === 1 || r === 2 ? LINE.visible : LINE.thin);
      const base = top - ROW + 2.2;
      if (row.length === 1) {
        this.prims.push({ k: "text", at: [x0 + 1.5, base], text: row[0], size: TEXT.cell, anchor: "start", bold: true });
        return;
      }
      let x = x0;
      row.forEach((cell, c) => {
        if (c > 0) line([[x, top], [x, top - ROW]]);
        this.prims.push({ k: "text", at: [x + 1.5, base], text: clip(cell, widths[c] - 3, TEXT.cell, r === 1), size: TEXT.cell, anchor: "start", ...(r === 1 ? { bold: true } : {}) });
        x += widths[c];
      });
    });
  }

  private notes(): { a: NoteAnnotation; box: Box; lines: string[] }[] {
    return this.d.annotations
      .filter((a): a is NoteAnnotation => a.type === "note")
      .map((a) => {
        const lines = a.text.split("\n");
        const w = Math.max(...lines.map((l) => textWidth(l, TEXT.note)));
        const h = (lines.length - 1) * TEXT.note * 1.4;
        return { a, lines, box: { min: [a.at[0], a.at[1] - h - 0.25 * TEXT.note], max: [a.at[0] + w, a.at[1] + TEXT.note * CAP] } };
      });
  }

  private drawNote(a: NoteAnnotation): void {
    a.text.split("\n").forEach((l, i) => this.prims.push({ k: "text", at: [a.at[0], a.at[1] - i * TEXT.note * 1.4], text: l, size: TEXT.note, anchor: "start" }));
  }

  // ----------------------------------------------------------- title block

  private drawTitleBlock(scale: number): void {
    const b = this.titleBlock;
    const s = this.d.sheet;
    const m = this.ctx.measurements;
    const material = m?.mass.material ?? this.v.material?.name ?? "steel";
    const cells: { x: number; y: number; w: number; h: number; label: string; value: string; big?: boolean }[] = [];
    const [x0, y0] = b.min;
    const row1 = 12;
    const row = 9;
    // Top row: the title and the drawing number.
    cells.push({ x: x0, y: y0 + 2 * row, w: 120, h: row1, label: "TITLE", value: s.title ?? this.v.name, big: true });
    cells.push({ x: x0 + 120, y: y0 + 2 * row, w: 60, h: row1, label: "DRAWING NO.", value: s.number ?? "" });
    // Middle: what it is made of and how it is drawn.
    let x = x0;
    for (const [w, label, value] of [
      [62, "MATERIAL", material],
      [30, "MASS", m ? `${m.mass.kg.toFixed(2)} kg` : ""],
      [28, "SCALE", scaleText(scale)],
      [20, "SIZE", s.size],
      [20, "REV", s.revision ?? ""],
      [20, "SHEET", "1 of 1"],
    ] as const) {
      cells.push({ x, y: y0 + row, w, h: row, label, value });
      x += w;
    }
    // Bottom: who and when, and the projection.
    x = x0;
    for (const [w, label, value] of [
      [40, "DRAWN", s.drawnBy ?? ""],
      [36, "DATE", s.date ?? ""],
      [44, `${s.projection.toUpperCase()} ANGLE`, ""],
      [60, "UNITS", "mm. Do not scale."],
    ] as const) {
      cells.push({ x, y: y0, w, h: row, label, value });
      x += w;
    }
    const line = (pts: Vec2[], w: number = LINE.thin) => this.prims.push({ k: "line", pts, w, owner: "titleBlock" });
    line([b.min, [b.max[0], b.min[1]], b.max, [b.min[0], b.max[1]], b.min], LINE.visible);
    for (const c of cells) {
      line([[c.x, c.y], [c.x + c.w, c.y], [c.x + c.w, c.y + c.h], [c.x, c.y + c.h]]);
      this.prims.push({ k: "text", at: [c.x + 1.2, c.y + c.h - TEXT.label * CAP - 1], text: c.label, size: TEXT.label, anchor: "start", owner: "titleBlock" });
      if (c.value) {
        const size = c.big ? TEXT.title : TEXT.cell;
        this.prims.push({ k: "text", at: [c.x + 1.5, c.y + 1.8], text: clip(c.value, c.w - 3, size, !!c.big), size, anchor: "start", ...(c.big ? { bold: true } : {}), owner: "titleBlock" });
      }
    }
    // The projection symbol: a truncated cone and its end view.
    const sym = cells.find((c) => c.label.endsWith("ANGLE"))!;
    this.projectionSymbol([sym.x + 22, sym.y + 3.6], s.projection);
  }

  /**
   * ISO 128's symbol, a truncated cone seen from the side and from its small
   * end. Third-angle puts the end view on the side it is seen from, so the
   * cone narrows toward it; first-angle on the opposite side, so it widens.
   */
  private projectionSymbol(at: Vec2, projection: Projection): void {
    const [x, y] = at;
    const big = 2.6;
    const small = 1.3;
    const long = 5.2;
    const [l, r] = projection === "third" ? [big, small] : [small, big];
    const owner = "titleBlock";
    this.prims.push({ k: "line", pts: [[x, y - l], [x + long, y - r], [x + long, y + r], [x, y + l]], closed: true, w: LINE.thin, owner });
    this.prims.push({ k: "circle", c: [x + long + 6 + big, y], r: big, w: LINE.thin, owner });
    this.prims.push({ k: "circle", c: [x + long + 6 + big, y], r: small, w: LINE.thin, owner });
  }
}

/** "4× Ø6.6 THRU", then a counterbore or countersink line. */
export function holeText(h: HoleRecord): string[] {
  const n = h.copies + 1;
  const lines = [`${n > 1 ? `${n}× ` : ""}Ø${fmt(h.diameter)} ${h.through ? "THRU" : `× ${fmt(h.depth)} DEEP`}`];
  if (h.counterbore) lines.push(`CBORE Ø${fmt(h.counterbore.diameter)} × ${fmt(h.counterbore.depth)} DEEP`);
  if (h.countersink) lines.push(`CSK Ø${fmt(h.countersink.diameter)} × ${fmt(h.countersink.angle)}°`);
  return lines;
}

function clip(text: string, width: number, size: number, bold = false): string {
  if (textWidth(text, size, bold) <= width) return text;
  let t = text;
  while (t.length > 1 && textWidth(`${t}...`, size, bold) > width) t = t.slice(0, -1);
  return `${t}...`;
}

function normalize3(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000 + 0;
}
