// Composes a drawing's sheets (Phase L; Phase Q: sheets, view kinds,
// templates) from the document, the rebuild's measurements and the projected
// views: where each view goes and at what scale, how it is drawn (visible,
// hidden, smooth and cut edges, hatching, cosmetic threads, breaks, crops,
// the cutting lines and detail circles on its parent, its label), and what
// every dimension, balloon, callout and weld symbol says. Every number is
// read from the rebuild here; nothing on the sheet is typed but notes and the
// title block. An annotation that points at something the part no longer
// has, or that its view can't show, is not drawn: it is listed in `problems`.

import type { DrawingGeometry } from "../ask/kernel";
import { allViews, parseGeoRef, parseScale, pointRef, STANDARD_SCALES, viewKind } from "../doc/drawing";
import {
  type Annotation,
  type AnnotationType,
  type BalloonAnnotation,
  type CenterlineAnnotation,
  type CenterMarkAnnotation,
  type DimensionAnnotation,
  type Drawing,
  type DrawingSheet,
  type DrawingView,
  type HoleAnnotation,
  type NoteAnnotation,
  type Projection,
  type SheetFormat,
  type SheetSize,
  type SheetTemplate,
  type TableAnnotation,
  type Vec2,
  type Vec3,
  type ViewKind,
  type ViewLook,
  VIEW_LOOKS,
  type WeldAnnotation,
} from "../doc/types";
import { validateDocument, type ValidationResult } from "../doc/validate";
import type { Measurements } from "../kernel/measure";
import type { ProjectedEdge, ProjectedView } from "../kernel/drawingViews";
import type { HoleRecord } from "../kernel/rebuild";
import { threadCallout } from "../features/hole/standards";
import { anglesText, cutList, type CutListItem } from "../weldment/cutlist";
import { clipOutside, clipToCircle, clipToPolygon, insidePolygon } from "./clip";
import { drawFormat, paperSize, type FormatLayout } from "./formats";
import { BODY_ANGLES, hatchLines, materialPattern } from "./hatch";
import { geoInView, resolveGeoRef } from "./georef";
import { holesInView, holeTable, holeTagPrims, outlineOrigin, renderSheetTables, type DrawingTable, type HoleTableRow, type RenderedTable, type RevisionRow, type TableContext } from "./tables";
import { cutListOf } from "../weldment/items";
import { nestCutList } from "../weldment/nesting";
import type { PropContext } from "./props";
import { boxOf, centre, grow, inside, overlaps, primBox, union, type Box, type Prim } from "./sheet";
import { projectionOf } from "./specs";
import { CAP, CENTER_DASH, HIDDEN_DASH, LINE, PHANTOM_DASH, TEXT, textWidth } from "./text";
import { DIRECTION_VECTORS, inView, isSquareFrame, leftOf, placeFromFront, sameFrame, sectionSide, toModel, viewFrame, type ViewFrame } from "./views";

export interface ComposeContext {
  measurements: Measurements | null;
  geometry: DrawingGeometry | null;
}

/** A break as composed: along x (0) or y (1), view mm, with the paper it leaves as view mm. */
export interface ComposedBreak {
  axis: 0 | 1;
  from: number;
  to: number;
  /** The gap left between the break lines, view mm. */
  gap: number;
  style: "zigzag" | "straight" | "curved";
}

export interface ComposedView {
  id: string;
  kind: ViewKind;
  /** The named look its frame is (a projected top view's is "top"), else "custom". */
  look: ViewLook | "custom";
  frame: ViewFrame;
  parent?: string;
  /** "A" for section A-A. */
  label?: string;
  /** The view whose projection it draws (a detail: its parent's). */
  source: string;
  /** Sheet mm per model mm. */
  scale: number;
  scaleText: string;
  /** Placed with the others (it has no `at`). */
  auto: boolean;
  /** The view's centre on the sheet, and the point of the view (view mm, breaks taken out) drawn there. */
  centre: Vec2;
  origin: Vec2;
  /** What the projection covers in the view, view mm, before breaks. Null when the view shows nothing. */
  outline: Box | null;
  /** Where its lines are on the sheet. */
  box: Box | null;
  /** True when a length along the view is a true length. */
  square: boolean;
  breaks: ComposedBreak[];
  /** A detail's region of its parent, or a crop: only what is inside shows (view mm). */
  clip?: { circle?: { c: Vec2; r: number }; poly?: Vec2[] };
  /** Its projection's edges (view mm), each with its key: what GeoRefs resolve against. */
  edges: ProjectedEdge[];
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

/** What the Phase L points of a view are made from: nodes, members, holes. */
export interface PointContext {
  nodes: Record<string, Vec3>;
  members: { id: string; body: string; ends: [Vec3, Vec3]; length: number }[];
  /** Each hole feature's first hole. */
  holes: Map<string, HoleRecord>;
}

export interface ComposedSheet {
  /** The sheet's id, name, and where it is among the drawing's sheets (from 1). */
  id: string;
  name: string;
  number: number;
  count: number;
  size: SheetSize;
  template: SheetTemplate;
  format: SheetFormat;
  width: number;
  height: number;
  projection: Projection;
  scale: number;
  scaleText: string;
  /** Inside the border. */
  frame: Box;
  titleBlock: Box;
  revisionBlock?: Box;
  views: ComposedView[];
  annotations: ComposedAnnotation[];
  /** The tables and notes: placed things that aren't views. */
  blocks: { id: string; box: Box }[];
  prims: Prim[];
  /** "b3: no member rail_x": every annotation that isn't drawn, and why. */
  problems: string[];
  /** The cut list the balloons and the table number by. */
  cutList: CutListItem[];
  /** For resolving GeoRefs' Phase L points. */
  points: PointContext;
}

export interface ComposedDrawing {
  drawing: Drawing;
  sheets: ComposedSheet[];
}

const BORDER = { left: 20, right: 10, bottom: 10, top: 10 };
export const TITLE_BLOCK: Vec2 = [180, 39];
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
/** The colour of a dangling annotation (its target gone): drawn where it was, never deleted. */
export const WARNING = "#c0392b";

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

/** Every sheet of the document's drawing, composed. Null when it has no valid drawing. */
export function composeDrawing(doc: unknown, ctx: ComposeContext): ComposedDrawing | null {
  const v = validateDocument(doc);
  if (!v.drawing) return null;
  const drawing = v.drawing;
  const sheets = drawing.sheets.map((s, i) => new Composer(v, drawing, s, i, ctx, doc).compose());
  return { drawing, sheets };
}

/** One sheet of the document's drawing (by id or place; default the first), composed. Null when it has no valid drawing or no such sheet. */
export function composeSheet(doc: unknown, ctx: ComposeContext, sheet: string | number = 0): ComposedSheet | null {
  const v = validateDocument(doc);
  if (!v.drawing) return null;
  const i = typeof sheet === "number" ? sheet : v.drawing.sheets.findIndex((s) => s.id === sheet);
  const s = v.drawing.sheets[i];
  return s ? new Composer(v, v.drawing, s, i, ctx, doc).compose() : null;
}

/** A point of a view (view mm, before breaks) on the sheet. */
export function viewToSheet(cv: Pick<ComposedView, "centre" | "origin" | "scale" | "breaks">, p: Vec2): Vec2 {
  const q = unbreak(cv.breaks, p);
  return [cv.centre[0] + (q[0] - cv.origin[0]) * cv.scale, cv.centre[1] + (q[1] - cv.origin[1]) * cv.scale];
}

/** A point of a view with its breaks taken out: past a break, closer by what it leaves out; in one, squeezed into its gap. */
export function unbreak(breaks: ComposedBreak[], p: Vec2): Vec2 {
  const q: Vec2 = [p[0], p[1]];
  for (const axis of [0, 1] as const) {
    let shift = 0;
    for (const b of breaks) {
      if (b.axis !== axis) continue;
      if (p[axis] >= b.to) shift += b.to - b.from - b.gap;
      else if (p[axis] > b.from) shift += ((p[axis] - b.from) / (b.to - b.from)) * (b.to - b.from - b.gap);
    }
    q[axis] = p[axis] - shift;
  }
  return q;
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

/** The named look a frame is, else "custom". */
function lookOf(f: ViewFrame): ViewLook | "custom" {
  return VIEW_LOOKS.find((l) => sameFrame(viewFrame(l), f)) ?? "custom";
}

class Composer {
  private readonly width: number;
  private readonly height: number;
  private readonly frame: Box;
  private readonly titleBlock: Box;
  private readonly format: FormatLayout | null;
  private readonly template: SheetTemplate;
  private readonly prims: Prim[] = [];
  private readonly problems: string[] = [];
  private readonly annotations = new Map<string, ComposedAnnotation>();
  private readonly cut: CutListItem[];
  private readonly projected = new Map<string, ProjectedView>();
  /** Each hole feature's first hole (what its callout points at and a dimension measures to), and how many holes it made in all. */
  private readonly holes = new Map<string, HoleRecord>();
  private readonly holeCounts = new Map<string, number>();
  private views: ComposedView[] = [];
  private readonly dims = new Map<string, DimPlan>();
  /** Every view of the drawing by id (a section's parent may be on another sheet). */
  private readonly allViews: Map<string, DrawingView>;
  /** This sheet's views, by id. */
  private readonly here: Map<string, DrawingView>;
  private readonly props: PropContext;
  private readonly points: PointContext;

  constructor(
    private readonly v: ValidationResult,
    private readonly d: Drawing,
    private readonly s: DrawingSheet,
    private readonly index: number,
    private readonly ctx: ComposeContext,
    private readonly doc: unknown = null,
  ) {
    this.template = s.format.template ?? (d.standard === "ASME" ? "ansi" : "iso");
    this.allViews = new Map(allViews(d).map((x) => [x.id, x]));
    this.here = new Map(s.views.map((x) => [x.id, x]));
    this.cut = ctx.measurements ? cutList(ctx.measurements.members) : [];
    for (const pv of ctx.geometry?.views ?? []) this.projected.set(pv.id, pv);
    for (const h of ctx.geometry?.holes ?? []) {
      if (!this.holes.has(h.feature)) this.holes.set(h.feature, h);
      this.holeCounts.set(h.feature, (this.holeCounts.get(h.feature) ?? 0) + h.copies + 1);
    }
    const m = ctx.measurements;
    const part = v.properties as Record<string, unknown>;
    const partProps: Record<string, string> = {};
    for (const [k, val] of Object.entries(part)) {
      if (typeof val === "string") partProps[k] = val;
      else if (k === "custom" && val && typeof val === "object") for (const [ck, cv] of Object.entries(val as Record<string, unknown>)) if (typeof cv === "string") partProps[ck] = cv;
    }
    this.props = {
      drawing: d.properties ?? {},
      part: partProps,
      model: {
        name: v.name,
        material: m?.mass.material ?? v.material?.name ?? "steel",
        ...(m ? { mass: `${m.mass.kg.toFixed(2)} kg`, volume: `${fmt(m.volume / 1000)} cm³` } : {}),
      },
      sheet: { sheet: String(index + 1), sheets: String(d.sheets.length), size: s.format.size, name: s.name ?? `Sheet ${index + 1}` },
    };
    this.points = {
      nodes: v.nodes,
      members: (m?.members ?? []).map((x) => ({ id: x.id, body: x.body, ends: x.ends, length: x.length })),
      holes: this.holes,
    };
    if (this.template === "classic") {
      [this.width, this.height] = paperSize(s.format);
      this.frame = { min: [BORDER.left, BORDER.bottom], max: [this.width - BORDER.right, this.height - BORDER.top] };
      this.titleBlock = { min: [this.frame.max[0] - TITLE_BLOCK[0], this.frame.min[1]], max: [this.frame.max[0], this.frame.min[1] + TITLE_BLOCK[1]] };
      this.format = null;
    } else {
      // The format's size and blocks don't depend on the scale; the scale's text is filled in once it is known.
      const probe = drawFormat({ format: s.format, projection: s.projection, drawing: d, props: this.props, scaleText: "", sheetNumber: index + 1, sheetCount: d.sheets.length });
      this.width = probe.width;
      this.height = probe.height;
      this.frame = probe.frame;
      this.titleBlock = probe.titleBlock;
      this.format = probe;
    }
  }

  private tableBoxes: Box[] = [];
  /** View labels ("ISO  SCALE 1:20"): balloons and symbols keep clear of them. */
  private labels: Box[] = [];

  compose(): ComposedSheet {
    const tables = this.placeTables();
    // The sheet's tables (src/drafting/tables): placed by their anchors before the views, which keep clear of them.
    const sheetTables = this.renderTables();
    const tableBoxes = sheetTables.flatMap((t) => t.rendered.boxes);
    this.tableBoxes = [...tables.map((t) => t.box), ...this.notes().map((n) => n.box), ...tableBoxes];
    const blocked = [this.titleBlock, ...(this.format?.revisionBlock ? [this.format.revisionBlock] : []), ...tables.map((t) => t.box), ...this.notes().map((n) => n.box), ...tableBoxes];
    this.planDimensions();
    const { scale, views } = this.layout(blocked);
    this.views = views;

    if (this.template === "classic") this.border();
    else {
      this.props.sheet.scale = scaleText(scale);
      const f = drawFormat({ format: this.s.format, projection: this.s.projection, drawing: this.d, props: this.props, scaleText: scaleText(scale), sheetNumber: this.index + 1, sheetCount: this.d.sheets.length });
      this.prims.push(...f.prims);
    }
    for (const cv of views) this.drawView(cv);
    for (const cv of views) this.drawMarks(cv);
    // Labels come first (balloons and callouts keep clear of them), under the room the view's dimensions take.
    for (const cv of views) this.drawLabel(cv, scale);
    for (const a of this.s.annotations) this.drawAnnotation(a, tables);
    for (const t of sheetTables) {
      this.prims.push(...t.rendered.prims);
      for (const p of t.rendered.problems) this.problems.push(`${t.table.id}: ${p}`);
      // A hole table's tags beside its holes, and its origin's mark.
      const cv = t.holes ? this.cv(t.holes.view) : undefined;
      if (t.holes && cv) this.prims.push(...holeTagPrims(t.holes.rows, cv, t.holes.origin, t.table.id));
    }
    if (this.template === "classic") this.drawTitleBlock(scale);

    const blocks = [
      ...tables.map((t) => ({ id: t.a.id, box: t.box })),
      ...this.notes().map((n) => ({ id: n.a.id, box: n.box })),
      ...sheetTables.flatMap((t) => (t.rendered.box ? [{ id: t.table.id, box: t.rendered.box }] : [])),
    ];
    return {
      id: this.s.id,
      name: this.s.name ?? `Sheet ${this.index + 1}`,
      number: this.index + 1,
      count: this.d.sheets.length,
      size: this.s.format.size,
      template: this.template,
      format: this.s.format,
      width: this.width,
      height: this.height,
      projection: this.s.projection,
      scale,
      scaleText: scaleText(scale),
      frame: this.frame,
      titleBlock: this.titleBlock,
      ...(this.format?.revisionBlock ? { revisionBlock: this.format.revisionBlock } : {}),
      views,
      annotations: this.s.annotations.map((a) => this.annotations.get(a.id) ?? { id: a.id, type: a.type, text: "", box: null }),
      blocks,
      prims: this.prims,
      problems: this.problems,
      cutList: this.cut,
      points: this.points,
    };
  }

  // ------------------------------------------------------------- tables (Phase Q)

  /** The sheet's tables, rendered: what each says (the cut list v2, welds, revisions, a view's holes) where its anchor puts it. */
  private renderTables(): { table: DrawingTable; rendered: RenderedTable; holes?: { view: string; rows: HoleTableRow[]; origin: Vec2 } }[] {
    const tables = this.s.tables ?? [];
    if (!tables.length) return [];
    const m = this.ctx.measurements;
    const cutList = m && this.doc ? cutListOf(this.doc, m) : null;
    const base: TableContext = {
      cutList,
      welds: this.v.welds,
      revisions: (this.d.revisions ?? []).map((r): RevisionRow => ({ rev: r.rev, ...(r.description !== undefined ? { description: r.description } : {}), ...(r.date ? { date: r.date } : {}), ...(r.by ? { by: r.by } : {}), ...(r.approved ? { approved: r.approved } : {}), ...(r.zone ? { zone: r.zone } : {}) })),
      nesting: cutList && tables.some((t) => t.kind === "stock") ? nestCutList(cutList) : null,
    };
    const sf = { frame: this.frame, titleBlock: this.titleBlock };
    const out: { table: DrawingTable; rendered: RenderedTable; holes?: { view: string; rows: HoleTableRow[]; origin: Vec2 } }[] = [];
    const plain = tables.filter((t) => t.kind !== "holes");
    renderSheetTables(plain, base, sf).forEach((rendered, i) => out.push({ table: plain[i], rendered }));
    for (const t of tables.filter((x) => x.kind === "holes")) {
      const holes = this.holeRows(t);
      const rendered = renderSheetTables([t], { ...base, holes: holes?.rows ?? null }, sf)[0];
      out.push({ table: t, rendered, ...(holes ? { holes } : {}) });
    }
    // In the sheet's order.
    return tables.map((t) => out.find((o) => o.table === t)!);
  }

  /** A hole table's rows: the holes its view looks into, X and Y from its origin (a corner of the outline, or a GeoRef). */
  private holeRows(t: DrawingTable): { view: string; rows: HoleTableRow[]; origin: Vec2 } | null {
    const view = t.view ? this.here.get(t.view) : undefined;
    const m = this.ctx.measurements;
    if (!view || !m) return null;
    const pv = this.pv(view);
    const outline = this.outline(view);
    let origin = outlineOrigin(t.origin, outline);
    if (!origin && t.origin) {
      const g = parseGeoRef(t.origin);
      const r = g && pv ? geoInView({ edges: pv.edges, frame: pv.frame, outline }, g, this.points) : null;
      origin = r?.kind === "point" ? r.p : r?.kind === "circle" ? r.c : r?.kind === "edge" && r.a ? r.a : null;
      if (!origin) this.problems.push(`${t.id}: its origin ${t.origin} is not in ${view.id}`);
    }
    if (!origin) origin = outlineOrigin("@lowerLeft", outline);
    if (!origin) return null;
    return { view: view.id, rows: holeTable(holesInView(m.holes ?? [], this.ctx.geometry?.holes ?? [], this.frameOf(view)), origin), origin };
  }

  // ------------------------------------------------------------- layout

  /** The projection a view draws (a detail's is its parent's). */
  private pv(view: DrawingView): ProjectedView | undefined {
    return this.projected.get(projectionOf(this.allViews, view.id));
  }

  /** How a view draws hidden edges. */
  private display(view: DrawingView): NonNullable<DrawingView["display"]> {
    if (view.display) return view.display;
    const kind = viewKind(view);
    if (kind === "detail" && view.parent) {
      const p = this.allViews.get(view.parent);
      if (p) return this.display(p);
    }
    return "removed";
  }

  /** A detail's region of its parent, or a view's crop. */
  private clipOf(view: DrawingView): ComposedView["clip"] | undefined {
    if (viewKind(view) === "detail") {
      if (view.circle) return { circle: { c: view.circle.at, r: view.circle.r } };
      if (view.profile) return { poly: view.profile };
    }
    if (view.crop) return { poly: view.crop };
    return undefined;
  }

  /** What a view's lines cover, view mm, before breaks: its edges (hidden ones when drawn), cut to its region. */
  private outline(view: DrawingView): Box | null {
    const pv = this.pv(view);
    if (!pv) return null;
    const clip = this.clipOf(view);
    const hidden = this.display(view) === "hidden" || this.display(view) === "visible";
    const pts: Vec2[] = [];
    for (const e of pv.edges) {
      if (!e.visible && !hidden) continue;
      if (e.type === "smooth" && (view.tangent ?? "removed") === "removed") continue;
      for (const piece of this.clipped([e.pts], clip)) pts.push(...piece);
    }
    for (const r of pv.sections ?? []) for (const l of r.loops) for (const piece of this.clipped([l], clip)) pts.push(...piece);
    if (!pts.length && pv.bodies.length && !clip) for (const b of pv.bodies) for (const line of [...b.visible, ...(hidden ? b.hidden : [])]) pts.push(...line);
    const box = boxOf(pts);
    if (clip?.circle && (box || viewKind(view) === "detail")) {
      // A detail is as big as its circle, whatever is in it.
      const { c, r } = clip.circle;
      return { min: [c[0] - r, c[1] - r], max: [c[0] + r, c[1] + r] };
    }
    return box;
  }

  private clipped(lines: Vec2[][], clip: ComposedView["clip"] | undefined): Vec2[][] {
    if (!clip) return lines;
    if (clip.circle) return lines.flatMap((l) => clipToCircle(l, clip.circle!.c, clip.circle!.r));
    if (clip.poly) return lines.flatMap((l) => clipToPolygon(l, clip.poly!));
    return lines;
  }

  /** A view's breaks at scale k: the gap is paper, so it is fewer view mm at a larger scale. */
  private breaksOf(view: DrawingView, k: number): ComposedBreak[] {
    // A view lined up with a broken parent is broken the same way along the axis they share.
    let breaks = view.breaks ?? [];
    const d = breaks.length ? null : this.attachDir(view);
    const parent = view.parent ? this.here.get(view.parent) : undefined;
    if (d && parent) breaks = (this.breaksSpec(parent) ?? []).filter((b) => (d[0] !== 0 ? b.axis === "y" : b.axis === "x"));
    return breaks
      .map((b) => ({ axis: (b.axis === "x" ? 0 : 1) as 0 | 1, from: b.from, to: b.to, gap: Math.min(b.to - b.from, (b.gap ?? 6) / k), style: b.style ?? "zigzag" }))
      .sort((a, b) => a.from - b.from);
  }

  /** The breaks a view has, its own or its parent's. */
  private breaksSpec(view: DrawingView): DrawingView["breaks"] {
    if (view.breaks?.length) return view.breaks;
    const d = this.attachDir(view);
    const parent = view.parent ? this.here.get(view.parent) : undefined;
    return d && parent ? (this.breaksSpec(parent) ?? []).filter((b) => (d[0] !== 0 ? b.axis === "y" : b.axis === "x")) : undefined;
  }

  /** The view's frame, from its projection (a look's own frame before it is projected). */
  private frameOf(view: DrawingView): ViewFrame {
    const pv = this.pv(view);
    if (pv) return pv.frame;
    return viewFrame(view.look ?? "front");
  }

  /** The direction (on the sheet) a view sits from its parent when it is lined up with it, or null when it is placed on its own. */
  private attachDir(view: DrawingView): Vec2 | null {
    const kind = viewKind(view);
    if (!view.parent || !this.here.has(view.parent) || view.free) return null;
    if (kind === "projected") {
      const d = DIRECTION_VECTORS[view.direction ?? "right"];
      return d[0] !== 0 && d[1] !== 0 ? null : d;
    }
    if (kind === "section" && view.line && view.line.length >= 2 && !view.aligned) {
      const n = sectionSide(view.line, view.flip);
      const d: Vec2 = this.s.projection === "third" ? n : [-n[0], -n[1]];
      if (Math.abs(Math.abs(d[0]) - 1) < 1e-9 || Math.abs(Math.abs(d[1]) - 1) < 1e-9) return [Math.round(d[0]), Math.round(d[1])];
    }
    return null;
  }

  /** Where each view sits in the projection, from the front: [dx, dy], or null when it is placed on its own. */
  private grid(): Map<string, Vec2> {
    const out = new Map<string, Vec2>();
    const taken = new Set<string>();
    for (const view of this.s.views) {
      if (viewKind(view) !== "model" || view.orientation) continue;
      const g = placeFromFront(view.look ?? "front", this.s.projection);
      if (!g || view.at) continue;
      const key = String(g);
      if (taken.has(key)) continue;
      taken.add(key);
      out.set(view.id, g);
    }
    // Views made from a view in the grid, on a side of it: the next cell that way, when free.
    let grew = true;
    while (grew) {
      grew = false;
      for (const view of this.s.views) {
        if (out.has(view.id) || view.at) continue;
        const d = this.attachDir(view);
        const pg = view.parent ? out.get(view.parent) : undefined;
        if (!d || !pg) continue;
        const g: Vec2 = [pg[0] + d[0], pg[1] + d[1]];
        if (taken.has(String(g))) continue;
        taken.add(String(g));
        out.set(view.id, g);
        grew = true;
      }
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
    for (const a of this.s.annotations) {
      if (a.type !== "dimension") continue;
      const view = this.here.get(a.view);
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
  private padding(view: DrawingView, k?: number, sheetScale?: number): [number, number, number, number] {
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
    for (const a of this.s.annotations) {
      if (!("view" in a) || a.view !== view.id || ("at" in a && a.at)) continue;
      const room = a.type === "balloon" ? 2 * BALLOON_R + 7 : a.type === "weld" ? 16 : a.type === "hole" ? 18 : 0;
      for (let i = 0; i < 4; i++) need(i, room);
    }
    // A section's cutting line, a detail's circle: their letters and arrows stand out of the parent.
    for (const child of this.allViews.values()) {
      if (child.parent !== view.id) continue;
      const kind = viewKind(child);
      if (kind === "section" || kind === "auxiliary") for (let i = 0; i < 4; i++) need(i, 14);
    }
    // The label under it, below its dimensions.
    // At the scales known (while placing), the label it will have; else a loose view may be at a scale of its own.
    const loose = (viewKind(view) === "model" || viewKind(view) === "projected") && !this.gridCache?.has(view.id);
    const label = this.template === "classic" ? 0 : k !== undefined && sheetScale !== undefined ? this.labelLines(view, k, sheetScale).length : this.labelLines(view, 1, loose ? 2 : 1).length;
    if (label) pad[1] += 5 + label * TEXT.title * 0.95;
    return pad;
  }

  /** A view's size on the sheet at scale k (breaks taken out), and what it covers before them. */
  private extent(view: DrawingView, k: number): { half: Vec2; outline: Box | null; originB: Vec2; breaks: ComposedBreak[] } {
    const outline = this.outline(view);
    const breaks = this.breaksOf(view, k);
    if (!outline) return { half: [0, 0], outline, originB: [0, 0], breaks };
    const lo = unbreak(breaks, outline.min);
    const hi = unbreak(breaks, outline.max);
    return { half: [((hi[0] - lo[0]) * k) / 2, ((hi[1] - lo[1]) * k) / 2], outline, originB: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2], breaks };
  }

  /** A view's own scale: its own, else a detail's twice its parent's, else the sheet's. */
  private scaleFor(view: DrawingView, sheetScale: number, looseScale: number, loose: boolean): number {
    const own = parseScale(view.scale);
    if (own) return own;
    if (viewKind(view) === "detail" && view.parent) {
      const p = this.allViews.get(view.parent);
      const base = p ? this.scaleFor(p, sheetScale, looseScale, false) : sheetScale;
      return nextScaleUp(base * 2);
    }
    if (view.parent && viewKind(view) !== "model") {
      const p = this.allViews.get(view.parent);
      if (p && this.here.has(p.id)) return this.scaleFor(p, sheetScale, looseScale, false);
    }
    return loose ? looseScale : sheetScale;
  }

  private gridCache: Map<string, Vec2> | null = null;

  private layout(blocked: Box[]): { scale: number; views: ComposedView[] } {
    const fixed = parseScale(this.s.scale);
    const grid = this.grid();
    this.gridCache = grid;
    const loose = this.s.views.filter((view) => !view.at && !grid.has(view.id));
    const candidates = fixed ? [fixed] : STANDARD_SCALES.map((s) => parseScale(s)!);
    if (fixed) return { scale: fixed, views: this.place(fixed, fixed, grid, loose) };
    // Iso views placed on their own may go a step or two smaller to fit; a detail is never smaller than its parent.
    const shrinkable = loose.some((v) => viewKind(v) === "model" || viewKind(v) === "projected");
    // The views' group starts at the frame's top left, or beside or below a table that holds that corner.
    const top = this.frame.max[1] - INSET;
    const left = this.frame.min[0] + INSET;
    const corner = blocked.filter((b) => b.max[1] >= this.frame.max[1] - 1 && b.min[0] <= this.frame.min[0] + 1);
    const starts: Vec2[] = [[left, top], ...corner.flatMap((b): Vec2[] => [[b.max[0] + GAP, top], [left, b.min[1] - GAP]])];
    // The loose column starts under whatever holds the top right corner (a revision block, a table).
    const right = blocked.filter((b) => b.max[1] >= this.frame.max[1] - 1 && b.max[0] >= this.frame.max[0] - 1);
    this.looseTop = Math.min(top, ...right.map((b) => b.min[1] - GAP));
    for (let i = 0; i < candidates.length; i++) {
      for (const step of shrinkable ? [0, 1, 2] : [0]) {
        const looseScale = candidates[Math.min(i + step, candidates.length - 1)];
        for (const start of starts) {
          this.start = start;
          const views = this.place(candidates[i], looseScale, grid, loose);
          if (this.fits(views, blocked, candidates[i])) return { scale: candidates[i], views };
        }
      }
    }
    this.start = [left, top];
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
  private fits(views: ComposedView[], blocked: Box[], scale: number): boolean {
    const padded = views.filter((cv) => cv.box).map((cv) => ({ cv, box: grow(cv.box!, this.padding(this.here.get(cv.id)!, cv.scale, scale)) }));
    const auto = padded.filter((p) => p.cv.auto);
    const held = padded.filter((p) => !p.cv.auto).map((p) => p.cv.box!);
    for (const { box } of auto) {
      if (!inside(box, this.frame)) return false;
      if ([...blocked, ...held].some((b) => overlaps(box, b))) return false;
    }
    for (let i = 0; i < auto.length; i++) for (let j = i + 1; j < auto.length; j++) if (overlaps(auto[i].box, auto[j].box)) return false;
    return true;
  }

  /** Where the projection's group of views starts (its top left), and the loose column's top. */
  private start: Vec2 | null = null;
  private looseTop: number | null = null;

  private place(scale: number, looseScale: number, grid: Map<string, Vec2>, loose: DrawingView[]): ComposedView[] {
    const out = new Map<string, ComposedView>();
    const make = (view: DrawingView, k: number, at: Vec2, auto: boolean): ComposedView => {
      const e = this.extent(view, k);
      const frame = this.frameOf(view);
      const kind = viewKind(view);
      const clip = this.clipOf(view);
      const parentCv = view.parent ? out.get(view.parent) : undefined;
      return {
        id: view.id,
        kind,
        look: lookOf(frame),
        frame,
        ...(view.parent ? { parent: view.parent } : {}),
        ...(view.label ? { label: view.label } : {}),
        source: projectionOf(this.allViews, view.id),
        scale: k,
        scaleText: scaleText(k),
        auto,
        centre: at,
        origin: e.originB,
        outline: e.outline,
        box: e.outline ? { min: [at[0] - e.half[0], at[1] - e.half[1]], max: [at[0] + e.half[0], at[1] + e.half[1]] } : null,
        square: kind === "detail" && parentCv ? parentCv.square : isSquareFrame(frame),
        breaks: e.breaks,
        ...(clip ? { clip } : {}),
        edges: this.pv(view)?.edges ?? [],
      };
    };
    const own = (view: DrawingView, fallback: number) => this.scaleFor(view, scale, fallback, false);
    // Views with a place of their own: a view lined up with its parent keeps its line (it moves along it only).
    const placedLater: DrawingView[] = [];
    for (const view of this.s.views) {
      if (!view.at) continue;
      if (this.attachDir(view) && view.parent && !this.here.get(view.parent)?.at && grid.has(view.parent)) placedLater.push(view);
      else out.set(view.id, make(view, own(view, scale), view.at, false));
    }
    // The projection: columns and rows around the front, each view's lines aligned with its neighbours'.
    const inGrid = this.s.views.filter((view) => grid.has(view.id));
    if (inGrid.length) {
      const ext = new Map<string, { half: Vec2; pad: [number, number, number, number]; k: number }>();
      for (const view of inGrid) {
        const k = own(view, scale);
        ext.set(view.id, { half: this.extent(view, k).half, pad: this.padding(view, k, scale), k });
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
      // The group's top left corner sits at the frame's top left (below an ASME revision block on the right is fine).
      const colX: number[] = [];
      let x = this.start?.[0] ?? this.frame.min[0] + INSET;
      colExt.forEach((e, i) => {
        colX[i] = x + e.left;
        x += e.left + e.right + GAP;
      });
      const rowY: number[] = [];
      let y = this.start?.[1] ?? this.frame.max[1] - INSET;
      rowExt.forEach((e, i) => {
        rowY[i] = y - e.top;
        y -= e.top + e.bottom + GAP;
      });
      for (const view of inGrid) {
        const g = grid.get(view.id)!;
        out.set(view.id, make(view, ext.get(view.id)!.k, [colX[cols.indexOf(g[0])], rowY[rows.indexOf(g[1])]], true));
      }
      // A view made from its neighbour lines up with it exactly: the same model point at the same place across.
      for (const view of inGrid) this.lineUp(view, out);
    }
    for (const view of placedLater) {
      const cv = make(view, own(view, scale), view.at!, false);
      out.set(view.id, cv);
      this.lineUp(view, out);
    }
    // The rest down the right, from the top.
    let top = this.looseTop ?? this.frame.max[1] - INSET;
    for (const view of loose) {
      const k = this.scaleFor(view, scale, looseScale, true);
      const { half } = this.extent(view, k);
      const pad = this.padding(view, k, scale);
      const at: Vec2 = [this.frame.max[0] - INSET - pad[2] - half[0], top - pad[3] - half[1]];
      out.set(view.id, make(view, k, at, true));
      top = at[1] - half[1] - pad[1] - GAP;
    }
    return this.s.views.map((view) => out.get(view.id)!).filter(Boolean);
  }

  /** Moves a view made from its parent across, so that a model point is at the same place across both. */
  private lineUp(view: DrawingView, out: Map<string, ComposedView>): void {
    const d = this.attachDir(view);
    const cv = out.get(view.id);
    const pcv = view.parent ? out.get(view.parent) : undefined;
    if (!d || !cv || !pcv || Math.abs(cv.scale - pcv.scale) > 1e-12) return;
    const axis = d[0] !== 0 ? 1 : 0;
    // Along the shared axis both views' coordinates are the same model quantity.
    const want = pcv.centre[axis] + (cv.origin[axis] - pcv.origin[axis]) * cv.scale;
    const shift = want - cv.centre[axis];
    if (Math.abs(shift) < 1e-12) return;
    cv.centre = axis === 0 ? [want, cv.centre[1]] : [cv.centre[0], want];
    if (cv.box) cv.box = axis === 0 ? { min: [cv.box.min[0] + shift, cv.box.min[1]], max: [cv.box.max[0] + shift, cv.box.max[1]] } : { min: [cv.box.min[0], cv.box.min[1] + shift], max: [cv.box.max[0], cv.box.max[1] + shift] };
  }

  // ------------------------------------------------------------- views

  private cv(id: string): ComposedView | undefined {
    return this.views.find((x) => x.id === id);
  }

  private toSheet(cv: ComposedView, p: Vec2): Vec2 {
    return viewToSheet(cv, p);
  }

  private border(): void {
    const f = this.frame;
    this.prims.push({ k: "line", pts: [f.min, [f.max[0], f.min[1]], f.max, [f.min[0], f.max[1]]], closed: true, w: LINE.border, owner: "sheet" });
  }

  /** Lines of a view, view mm: cut to its region, its breaks left out, then on the sheet. */
  private emit(cv: ComposedView, lines: Vec2[][], style: { w: number; dash?: number[]; layer?: string }): void {
    for (const piece of this.clipped(lines, cv.clip)) {
      let parts = [piece];
      for (const axis of [0, 1] as const) {
        const gaps = cv.breaks.filter((b) => b.axis === axis).map((b) => [b.from, b.to] as [number, number]);
        if (gaps.length) parts = parts.flatMap((p) => clipOutside(p, axis, gaps));
      }
      for (const p of parts) if (p.length >= 2) this.prims.push({ k: "line", pts: p.map((q) => this.toSheet(cv, q)), w: style.w, ...(style.dash ? { dash: style.dash } : {}), ...(style.layer ? { layer: style.layer } : {}), owner: cv.id });
    }
  }

  private drawView(cv: ComposedView): void {
    const view = this.here.get(cv.id)!;
    const pv = this.pv(view);
    if (!cv.outline || !pv) {
      const why = pv?.problems?.length ? `: ${pv.problems.join("; ")}` : this.ctx.geometry ? "" : " yet (the part hasn't been projected)";
      this.problems.push(`${cv.id}: shows nothing${why}`);
      return;
    }
    for (const p of pv.problems ?? []) this.problems.push(`${cv.id}: ${p}`);
    const display = this.display(view);
    const tangent = view.tangent ?? "removed";
    const shaded = display === "shaded" || display === "shadedEdges";
    // Shading first, painted far to near; a crop or a detail keeps the triangles whose middle is inside.
    if (shaded && pv.shaded) {
      for (const t of pv.shaded) {
        const mid: Vec2 = [(t.pts[0][0] + t.pts[1][0] + t.pts[2][0]) / 3, (t.pts[0][1] + t.pts[1][1] + t.pts[2][1]) / 3];
        if (cv.clip?.circle && Math.hypot(mid[0] - cv.clip.circle.c[0], mid[1] - cv.clip.circle.c[1]) > cv.clip.circle.r) continue;
        if (cv.clip?.poly && !insidePolygon(mid, cv.clip.poly)) continue;
        if (cv.breaks.some((b) => mid[b.axis] > b.from && mid[b.axis] < b.to)) continue;
        const g = Math.round(105 + 130 * t.shade);
        const hex = `#${[g, g, Math.min(255, g + 8)].map((x) => Math.min(255, x).toString(16).padStart(2, "0")).join("")}`;
        this.prims.push({ k: "area", loops: [t.pts.map((q) => this.toSheet(cv, q))], fill: hex, owner: cv.id });
      }
    }
    // Hatching, under the edges.
    this.hatch(cv, view, pv);
    const edgeW = display === "shaded" ? 0 : display === "shadedEdges" ? LINE.thin * 1.2 : LINE.visible;
    const hiddenOn = display === "hidden";
    const wire = display === "visible";
    const visible: Vec2[][] = [];
    const hidden: Vec2[][] = [];
    const smooth: Vec2[][] = [];
    const smoothHidden: Vec2[][] = [];
    for (const e of pv.edges) {
      if (e.type === "smooth") {
        if (tangent === "removed") continue;
        (e.visible ? smooth : smoothHidden).push(e.pts);
      } else (e.visible ? visible : hidden).push(e.pts);
    }
    if (hiddenOn) this.emit(cv, [...hidden, ...(tangent !== "removed" ? smoothHidden : [])], { w: LINE.thin, dash: HIDDEN_DASH, layer: "HIDDEN" });
    if (edgeW > 0) {
      if (tangent === "visible") this.emit(cv, smooth, { w: edgeW, layer: "TANGENT" });
      if (tangent === "phantom") this.emit(cv, smooth, { w: LINE.thin, dash: PHANTOM_DASH, layer: "TANGENT" });
      this.emit(cv, wire ? [...visible, ...hidden] : visible, { w: edgeW, layer: "VISIBLE" });
    }
    if (view.threads !== false) this.threads(cv, view, pv);
    // A broken-out section's boundary: a thin line where the material was broken away.
    for (const b of view.brokenOut ?? []) this.emit(cv, [[...b.profile, b.profile[0]]], { w: LINE.thin, layer: "BREAK" });
    this.breakLines(cv);
    // A detail's boundary.
    if (cv.kind === "detail" && view.style !== "noBoundary") {
      if (cv.clip?.circle) this.prims.push({ k: "circle", c: this.toSheet(cv, cv.clip.circle.c), r: cv.clip.circle.r * cv.scale, w: LINE.thin, owner: cv.id });
      else if (cv.clip?.poly) this.prims.push({ k: "line", pts: cv.clip.poly.map((q) => this.toSheet(cv, q)), closed: true, w: LINE.thin, owner: cv.id });
    }
  }

  /** The cut faces' hatching: by each body's material, each body of a weldment its own way. */
  private hatch(cv: ComposedView, view: DrawingView, pv: ProjectedView): void {
    const regions = pv.sections ?? [];
    if (!regions.length) return;
    const owner = viewKind(view) === "detail" && view.parent ? this.allViews.get(projectionOf(this.allViews, view.id)) : view;
    const style = owner?.hatch ?? {};
    const bodies = [...new Set(regions.map((r) => r.body))];
    // A body keeps its angle in every view: by its place in the part.
    const order = (this.ctx.measurements?.bodies ?? []).map((b) => b.name);
    for (const r of regions) {
      const material = this.v.bodyMaterials[r.body] ?? this.v.material;
      const pattern = style.pattern ?? materialPattern(material);
      if (pattern === "none") continue;
      const i = Math.max(0, order.indexOf(r.body));
      const angle = style.angle ?? (bodies.length > 1 || order.length > 1 ? BODY_ANGLES[i % BODY_ANGLES.length] : 45);
      // ISO 128-50: wider for a big face, never finer than 1.5 mm on paper.
      // One spacing for all of a body's cut faces: by the size of them together.
      const box = boxOf(regions.filter((x) => x.body === r.body).flatMap((x) => x.loops.flat()))!;
      const big = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1]) * cv.scale;
      const spacing = style.spacing ?? Math.min(4, Math.max(1.5, big / 22));
      // A thin section (a tube's wall at a small scale, under about 1 mm on paper) is filled black, as ISO 128-50 allows.
      const perimeter = r.loops.reduce((t, l) => t + l.reduce((u, q, i) => u + Math.hypot(q[0] - l[(i + 1) % l.length][0], q[1] - l[(i + 1) % l.length][1]), 0), 0);
      const thickness = perimeter > 0 ? (2 * r.area) / perimeter : 0;
      if (pattern === "solid" || (!style.pattern && thickness * cv.scale < 1)) {
        this.prims.push({ k: "area", loops: r.loops.map((l) => l.map((q) => this.toSheet(cv, q))), fill: "#000000", owner: cv.id });
        continue;
      }
      for (const h of hatchLines(r.loops, pattern, angle, spacing / cv.scale)) this.emit(cv, [h.pts], { w: LINE.thin * 0.9, layer: "HATCH", ...(h.dash ? { dash: h.dash } : {}) });
    }
  }

  /**
   * Cosmetic threads (ISO 6410): a tapped hole seen end on has its tap drill
   * thick and a thin three-quarter circle at the thread's major diameter; a
   * thread on a shaft, its major thick and the minor thin. From the side:
   * thin lines at the major (a hole, dashed unless cut) or minor (a shaft)
   * diameter, as long as the thread.
   */
  private threads(cv: ComposedView, view: DrawingView, pv: ProjectedView): void {
    const holes = this.ctx.geometry?.holes ?? [];
    const f = cv.frame;
    const features = this.v.features;
    const cutView = viewKind(view) === "section" || (pv.sections?.length ?? 0) > 0;
    for (const h of holes) {
      const t = h.thread;
      if (!t || t.modelled) continue;
      // Its copies: patterns and mirrors of it.
      const makers = new Set([h.feature, ...features.filter((x) => Array.isArray((x as { features?: unknown }).features) && ((x as unknown as { features: string[] }).features).includes(h.feature)).map((x) => x.id)]);
      const holeR = t.external ? t.major / 2 : h.diameter / 2;
      const minor = Math.max(0.1, t.major - 1.0825 * t.pitch) / 2;
      const thinR = t.external ? minor : t.major / 2;
      const axis = normalize3(h.axis);
      const facing = Math.abs(axis[0] * f.eye[0] + axis[1] * f.eye[1] + axis[2] * f.eye[2]);
      const centres: Vec3[] = [];
      for (const e of pv.edges) {
        const m = e.model;
        if (!m || m.kind !== "circle" || !m.center || !m.axis || m.radius === undefined) continue;
        if (Math.abs(m.radius - holeR) > 1e-3 || Math.abs(Math.abs(dot3(normalize3(m.axis), axis)) - 1) > 1e-6) continue;
        if (e.feature && !makers.has(e.feature) && !e.feature.startsWith("?")) continue;
        if (centres.some((c) => Math.hypot(c[0] - m.center![0], c[1] - m.center![1], c[2] - m.center![2]) < 1e-6)) continue;
        centres.push(m.center);
      }
      if (!centres.length) centres.push(h.entry);
      const len = t.depth === "through" ? h.depth : t.depth;
      if (facing > 0.999) {
        // End on: one per hole seen (holes behind one another draw once).
        const seen: Vec2[] = [];
        for (const c3 of centres) {
          const c = inView(c3, f);
          if (seen.some((s) => Math.hypot(s[0] - c[0], s[1] - c[1]) < 1e-6)) continue;
          seen.push(c);
          // Three quarters of a circle, open at the top right.
          const pts: Vec2[] = [];
          for (let k = 0; k <= 54; k++) {
            const a = (Math.PI / 180) * (100 + (k * 270) / 54);
            pts.push([c[0] + thinR * Math.cos(a), c[1] + thinR * Math.sin(a)]);
          }
          this.emit(cv, [pts], { w: LINE.thin, layer: "THREAD" });
        }
      } else if (facing < 0.001) {
        // From the side: the thread's two lines and its end.
        const seen = new Set<string>();
        for (const c3 of centres) {
          // A through hole's other end is a circle too: start from the one at the hole's entry side.
          const start = c3;
          const key = inView(start, f).map((x) => x.toFixed(4)).join(",");
          if (seen.has(key)) continue;
          seen.add(key);
          const along = (d: number): Vec3 => [start[0] + axis[0] * d, start[1] + axis[1] * d, start[2] + axis[2] * d];
          // Into the material: a hole along its axis from the entry; a copy found at the far end goes back.
          const dirSign = dot3([c3[0] - h.entry[0], c3[1] - h.entry[1], c3[2] - h.entry[2]], axis) > h.depth / 2 ? -1 : 1;
          const a2 = inView(along(0), f);
          const b2 = inView(along(dirSign * len), f);
          const ax2 = inView(axis, f);
          const al = Math.hypot(ax2[0], ax2[1]) || 1;
          const across: Vec2 = [ax2[0] / al, ax2[1] / al];
          const n: Vec2 = [-across[1], across[0]];
          const off = (p: Vec2, r: number): Vec2 => [p[0] + n[0] * r, p[1] + n[1] * r];
          const style = t.external || cutView ? { w: LINE.thin, layer: "THREAD" } : { w: LINE.thin, dash: HIDDEN_DASH, layer: "THREAD" };
          this.emit(cv, [[off(a2, thinR), off(b2, thinR)], [off(a2, -thinR), off(b2, -thinR)]], style);
          if (!t.external && !cutView) this.emit(cv, [[off(b2, thinR), off(b2, -thinR)]], { w: LINE.thin, dash: HIDDEN_DASH, layer: "THREAD" });
          if (t.external) this.emit(cv, [[off(b2, holeR), off(b2, -holeR)]], { w: LINE.visible, layer: "VISIBLE" });
        }
      }
    }
  }

  /** The lines where a view is broken: a pair across the part at each break. */
  private breakLines(cv: ComposedView): void {
    if (!cv.breaks.length || !cv.outline) return;
    const o = cv.outline;
    for (const b of cv.breaks) {
      const other = b.axis === 0 ? 1 : 0;
      const lo = o.min[other];
      const hi = o.max[other];
      const over = 3 / cv.scale;
      for (const at of [b.from, b.to]) {
        const pts: Vec2[] = [];
        const span = hi - lo + 2 * over;
        const steps = b.style === "straight" ? 1 : 24;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const y = lo - over + span * t;
          let x = at;
          if (b.style === "zigzag") {
            // One Z in the middle.
            const m = Math.abs(t - 0.5);
            x = at + (m < 0.06 ? ((0.5 - t) / 0.06) * (2.5 / cv.scale) : 0);
          } else if (b.style === "curved") x = at + Math.sin(t * Math.PI * 2) * (1.6 / cv.scale) * (at === b.from ? 1 : -1);
          // A point exactly on the break's edge stays on its side of the gap.
          const q: Vec2 = b.axis === 0 ? [x, y] : [y, x];
          pts.push(q);
        }
        const sheet = pts.map((q) => {
          const nudge: Vec2 = b.axis === 0 ? [at === b.from ? Math.min(q[0], b.from) : Math.max(q[0], b.to), q[1]] : [q[0], at === b.from ? Math.min(q[1], b.from) : Math.max(q[1], b.to)];
          return this.toSheet(cv, nudge);
        });
        // Zigzag and curves are drawn on the sheet from the straight line: offsets in paper mm.
        if (b.style !== "straight") {
          const base = pts.map((q) => this.toSheet(cv, b.axis === 0 ? [at, q[1]] : [q[0], at]));
          for (let i = 0; i < sheet.length; i++) {
            const dv = b.axis === 0 ? pts[i][0] - at : pts[i][1] - at;
            sheet[i] = b.axis === 0 ? [base[i][0] + dv * cv.scale, base[i][1]] : [base[i][0], base[i][1] + dv * cv.scale];
          }
        }
        this.prims.push({ k: "line", pts: sheet, w: LINE.thin, layer: "BREAK", owner: cv.id });
      }
    }
  }

  /** On this view: its children's cutting lines, detail circles and view arrows. */
  private drawMarks(cv: ComposedView): void {
    const start = this.prims.length;
    this.drawMarksOf(cv);
    for (const p of this.prims.slice(start)) p.layer ??= "SECTION";
  }

  private drawMarksOf(cv: ComposedView): void {
    const standard = this.d.standard ?? "ISO";
    for (const child of this.allViews.values()) {
      if (child.parent !== cv.id) continue;
      const kind = viewKind(child);
      const label = child.label ?? "";
      if (kind === "section" && child.line && child.line.length >= 2) this.cuttingLine(cv, child, label, standard);
      if (kind === "detail") this.detailCircle(cv, child, label);
      if (kind === "auxiliary") this.viewArrow(cv, child, label);
    }
  }

  /**
   * A section's cutting line on its parent (ISO 128-44: a thin chain line,
   * thick at its ends and where it turns; ASME Y14.2: a thick dashed line),
   * with arrows at its ends pointing the way the section looks and its letter.
   */
  private cuttingLine(cv: ComposedView, child: DrawingView, label: string, standard: "ISO" | "ASME"): void {
    const owner = child.id;
    const pts = child.line!.map((p) => this.toSheet(cv, p));
    const n = sectionSide(child.line!, child.flip);
    const look: Vec2 = [-n[0], -n[1]];
    const thick = LINE.visible * 1.4;
    if (standard === "ASME") this.prims.push({ k: "line", pts, w: thick, dash: [12, 2, 3, 2, 3, 2], owner });
    else {
      this.prims.push({ k: "line", pts, w: LINE.thin, dash: CENTER_DASH, owner });
      // Thick at the ends and the turns.
      const seg = 6;
      const along = (a: Vec2, b: Vec2, l: number): Vec2 => {
        const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        return [a[0] + ((b[0] - a[0]) / d) * Math.min(l, d / 2), a[1] + ((b[1] - a[1]) / d) * Math.min(l, d / 2)];
      };
      this.prims.push({ k: "line", pts: [pts[0], along(pts[0], pts[1], seg)], w: thick, owner });
      this.prims.push({ k: "line", pts: [pts[pts.length - 1], along(pts[pts.length - 1], pts[pts.length - 2], seg)], w: thick, owner });
      for (let i = 1; i + 1 < pts.length; i++) this.prims.push({ k: "line", pts: [along(pts[i], pts[i - 1], seg / 2), pts[i], along(pts[i], pts[i + 1], seg / 2)], w: thick, owner });
    }
    // Arrows: square to the line at each end, pointing the way of sight, the letter beyond.
    const ends: [Vec2, Vec2][] = [
      [pts[0], pts[1]],
      [pts[pts.length - 1], pts[pts.length - 2]],
    ];
    const half = child.half;
    ends.forEach(([end], i) => {
      if (half && i === 1) return;
      const nn = i === 1 && child.aligned ? sectionSide([child.line![1], child.line![2]], child.flip) : n;
      const lk: Vec2 = i === 1 && child.aligned ? [-nn[0], -nn[1]] : look;
      let tailEnd: Vec2;
      if (standard === "ASME") {
        // The line's end bends square the way of sight, the arrowhead at the bend's end.
        const tip: Vec2 = [end[0] + lk[0] * 9, end[1] + lk[1] * 9];
        this.prims.push({ k: "line", pts: [end, tip], w: thick, owner });
        this.arrowAt(tip, lk, owner, 4, 1.1);
        tailEnd = tip;
      } else {
        // ISO: the arrow comes in from the viewer's side, its tip on the thick end.
        tailEnd = [end[0] - lk[0] * 9, end[1] - lk[1] * 9];
        this.prims.push({ k: "line", pts: [tailEnd, end], w: LINE.thin, owner });
        this.arrowAt(end, lk, owner, 4, 1.1);
      }
      // The letter beyond the arrow's tail, a little out along the line.
      const outward = (() => {
        const other = i === 0 ? pts[1] : pts[pts.length - 2];
        const d: Vec2 = [end[0] - other[0], end[1] - other[1]];
        const l = Math.hypot(d[0], d[1]) || 1;
        return [d[0] / l, d[1] / l] as Vec2;
      })();
      const away = standard === "ASME" ? 3 : -2.5;
      const at: Vec2 = [tailEnd[0] + lk[0] * away + outward[0] * 3, tailEnd[1] + lk[1] * away + outward[1] * 3];
      const size = TEXT.title;
      this.prims.push({ k: "text", at: [at[0], at[1] - (size * CAP) / 2], text: label, size, anchor: "middle", bold: standard === "ASME", owner });
    });
  }

  /** A detail's circle on its parent (thin), its letter beside it, and a leader to the detail when connected. */
  private detailCircle(cv: ComposedView, child: DrawingView, label: string): void {
    const owner = child.id;
    if (child.circle) {
      const c = this.toSheet(cv, child.circle.at);
      const r = child.circle.r * cv.scale;
      this.prims.push({ k: "circle", c, r, w: LINE.thin * 1.4, owner });
      const a = Math.PI / 4;
      const at: Vec2 = [c[0] + Math.cos(a) * (r + 2.5), c[1] + Math.sin(a) * (r + 2.5)];
      this.prims.push({ k: "text", at, text: label, size: TEXT.title, anchor: "start", bold: (this.d.standard ?? "ISO") === "ASME", owner });
      if (child.style === "connected") {
        const target = this.cv(child.id);
        if (target?.box) {
          const tc = centre(target.box);
          const d: Vec2 = [tc[0] - c[0], tc[1] - c[1]];
          const l = Math.hypot(d[0], d[1]) || 1;
          const tr = (target.clip?.circle?.r ?? 0) * target.scale;
          if (l > r + tr + 2) this.prims.push({ k: "line", pts: [[c[0] + (d[0] / l) * r, c[1] + (d[1] / l) * r], [tc[0] - (d[0] / l) * tr, tc[1] - (d[1] / l) * tr]], w: LINE.thin, owner });
        }
      }
    } else if (child.profile) {
      const pts = child.profile.map((p) => this.toSheet(cv, p));
      this.prims.push({ k: "line", pts, closed: true, w: LINE.thin * 1.4, owner });
      const b = boxOf(pts)!;
      this.prims.push({ k: "text", at: [b.max[0] + 1.5, b.max[1] + 1], text: label, size: TEXT.title, anchor: "start", owner });
    }
  }

  /** An auxiliary view's arrow on its parent: square to the edge, pointing the way it looks, with its letter. */
  private viewArrow(cv: ComposedView, child: DrawingView, label: string): void {
    const pv = this.projected.get(child.id);
    if (!pv) return;
    // Its frame's eye, seen in the parent, is the way it looks from.
    const e = inView(pv.frame.eye, cv.frame);
    const l = Math.hypot(e[0], e[1]);
    if (l < 1e-9 || !cv.box) return;
    const lk: Vec2 = [-e[0] / l, -e[1] / l];
    const c = centre(cv.box);
    const half = Math.max(cv.box.max[0] - cv.box.min[0], cv.box.max[1] - cv.box.min[1]) / 2;
    const tip: Vec2 = [c[0] - lk[0] * (half + 3), c[1] - lk[1] * (half + 3)];
    const tail: Vec2 = [tip[0] - lk[0] * 10, tip[1] - lk[1] * 10];
    const owner = child.id;
    this.prims.push({ k: "line", pts: [tail, tip], w: LINE.thin, owner });
    this.arrowAt(tip, lk, owner, 4, 1.1);
    const side = leftOf(lk);
    this.prims.push({ k: "text", at: [tail[0] + side[0] * 3, tail[1] + side[1] * 3 - (TEXT.title * CAP) / 2], text: label, size: TEXT.title, anchor: "middle", owner });
  }

  /** A filled arrowhead (sheet mm), tip at `tip`, pointing along `dir`. */
  private arrowAt(tip: Vec2, dir: Vec2, owner: string, length = ARROW.length, halfW = ARROW.half): void {
    const back: Vec2 = [tip[0] - dir[0] * length, tip[1] - dir[1] * length];
    const side: Vec2 = [-dir[1] * halfW, dir[0] * halfW];
    this.prims.push({ k: "line", pts: [tip, [back[0] + side[0], back[1] + side[1]], [back[0] - side[0], back[1] - side[1]]], closed: true, fill: true, w: LINE.thin, owner });
  }

  /** A view's label lines: "SECTION A-A" / "A–A", "DETAIL B" / "B (2:1)", and the scale when it is the view's own. */
  private labelLines(view: DrawingView, scale: number, sheetScale: number): string[] {
    const kind = viewKind(view);
    const asme = (this.d.standard ?? "ISO") === "ASME";
    const own = Math.abs(scale - sheetScale) > 1e-9;
    const showScale = view.showScale ?? (own || kind === "detail");
    const scaleTxt = scaleText(scale).replace(":", " : ");
    const label = view.label ?? "";
    let lines: string[] = [];
    if (kind === "section") lines = asme ? [`SECTION ${label}-${label}`] : [`${label}–${label}`];
    else if (kind === "detail") lines = asme ? [`DETAIL ${label}`] : [showScale ? `${label} (${scaleTxt})` : label];
    else if (kind === "auxiliary") lines = asme ? [`VIEW ${label}`] : [label];
    else if (view.showLabel || own) lines = [view.id.toUpperCase()];
    if (view.showLabel === false) return [];
    if (showScale && (asme || kind !== "detail") && lines.length) lines.push(`SCALE ${scaleTxt}`);
    return lines;
  }

  private drawLabel(cv: ComposedView, sheetScale: number): void {
    const view = this.here.get(cv.id)!;
    if (!cv.box) return;
    if (this.template === "classic") {
      // Phase L: a view at its own scale says so under it.
      const sheetFixed = parseScale(this.s.scale);
      const label = cv.look === "iso" ? "ISO" : cv.look === "custom" ? cv.id.toUpperCase() : cv.look.toUpperCase();
      const kind = cv.kind;
      if (kind === "model" || kind === "projected") {
        if (Math.abs(cv.scale - (sheetFixed ?? this.mainScale())) > 1e-9) {
          const p: Prim = { k: "text", at: [cv.centre[0], cv.box.min[1] - 7], text: `${label}  SCALE ${cv.scaleText}`, size: TEXT.label * 1.4, anchor: "middle", owner: cv.id };
          this.prims.push(p);
          this.labels.push(grow(primBox(p, textWidth)!, 1));
        }
        return;
      }
    }
    const lines = this.labelLines(view, cv.scale, parseScale(this.s.scale) ?? sheetScale);
    // Under the view and whatever of its annotations hangs below it (its dimensions), across its width.
    const bottom = cv.box.min[1] - this.dimsBelow(cv.id);
    lines.forEach((t, i) => {
      const size = i === 0 ? TEXT.title : TEXT.cell;
      const y = bottom - 5 - i * (TEXT.title * 0.95) - size * CAP;
      const p: Prim = { k: "text", at: [cv.centre[0], y], text: t, size, anchor: "middle", layer: "TEXT", ...(i === 0 ? { bold: (this.d.standard ?? "ISO") === "ASME" } : {}), owner: cv.id };
      this.prims.push(p);
      this.labels.push(grow(primBox(p, textWidth)!, 1));
    });
  }

  /** How far under a view its dimensions reach, sheet mm. */
  private dimsBelow(id: string): number {
    let below = 0;
    for (const p of this.dims.values()) {
      if (p.a.view !== id || p.dir !== "h" || p.side > 0) continue;
      below = Math.max(below, (p.a.offset !== undefined ? Math.abs(p.a.offset) : DIM_FIRST + DIM_STEP * p.stack) + TEXT.dimension * CAP);
    }
    return below;
  }

  /** The scale most views are drawn at. */
  private mainScale(): number {
    const counts = new Map<number, number>();
    for (const cv of this.views) counts.set(cv.scale, (counts.get(cv.scale) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 1;
  }

  /** A view's frame, by id (its projection's). */
  private frameById(id: string): ViewFrame {
    const view = this.here.get(id);
    return view ? this.frameOf(view) : viewFrame("front");
  }

  /** True when a view looks square at the part. */
  private squareById(id: string): boolean {
    const view = this.here.get(id);
    if (!view) return false;
    if (viewKind(view) === "detail" && view.parent) return this.squareById(view.parent) || (this.allViews.has(view.parent) && isSquareFrame(this.frameById(view.parent)));
    if (viewKind(view) === "section" || viewKind(view) === "auxiliary") return true;
    return isSquareFrame(this.frameOf(view));
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
        a.type === "dimension"
          ? this.drawDimension(a, cv)
          : a.type === "balloon"
            ? this.drawBalloon(a, cv)
            : a.type === "hole"
              ? this.drawHole(a, cv)
              : a.type === "weld"
                ? this.drawWeld(a, cv)
                : a.type === "centerMark"
                  ? this.drawCenterMark(a, cv)
                  : this.drawCenterline(a, cv);
      if ("problem" in r) return this.fail(a, r.problem);
      ({ text, ...extra } = r);
    }
    const mine = this.prims.slice(start);
    const layer = a.type === "dimension" ? "DIMENSION" : a.type === "centerMark" || a.type === "centerline" ? "CENTER" : a.type === "table" ? "TABLE" : "ANNOTATION";
    for (const p of mine) {
      p.owner = a.id;
      p.layer ??= layer;
    }
    const box = mine.reduce<Box | null>((acc, p) => union(acc, primBox(p, textWidth)), null);
    this.annotations.set(a.id, { id: a.id, type: a.type, ...("view" in a ? { view: a.view } : {}), text, ...extra, box });
  }

  private nodes(): Record<string, Vec3> {
    return this.v.nodes;
  }

  /** A member by its feature's id, or by its body's name (a renamed body is named on the sheet by its new name). */
  private member(id: string) {
    const members = this.ctx.measurements?.members ?? [];
    return members.find((m) => m.id === id) ?? members.find((m) => m.body === id);
  }

  /** A dimension point in the view, model mm. A side of the view's outline has only the coordinate it names. */
  private point(ref: string, f: ViewFrame, outline: Box): { p: Vec2; side?: "x" | "y" } | { problem: string } {
    const r = pointRef(ref);
    if (!r) return { problem: `"${ref}" is not a point` };
    if (r.kind === "geo") {
      const g = this.geo(r.ref);
      if (!g || g.kind !== "point") return { problem: `${ref} is not in its view (the edge it names is gone)` };
      return { p: g.inView };
    }
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
    const f = this.frameById(view.id);
    const outline = this.outline(view);
    if (!outline) return { problem: `its view ${view.id} shows nothing` };
    if (!this.squareById(view.id)) return { problem: `${view.id} is ${view.look === "iso" ? "an iso view" : "a view at an angle to the part"}, which shortens every length` };
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
    const view = this.here.get(cv.id)!;
    const r = this.dimPoints(a, view);
    if ("problem" in r) return r;
    const plan = this.dims.get(a.id);
    const f = this.frameById(view.id);
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
  private outside(cv: ComposedView, from: Vec2, clear: number, dir?: Vec2, nearest = false): Vec2 {
    let d = dir ?? ([from[0] - cv.centre[0], from[1] - cv.centre[1]] as Vec2);
    const len = Math.hypot(d[0], d[1]);
    d = len < 1e-9 ? [Math.SQRT1_2, Math.SQRT1_2] : [d[0] / len, d[1] / len];
    const box = grow(cv.box!, clear);
    // Past both sides of the box the way it goes (clear of its corner), or, `nearest`, out through the first side it meets.
    const exits: number[] = [];
    for (const i of [0, 1]) {
      if (d[i] > 1e-9) exits.push((box.max[i] - from[i]) / d[i]);
      if (d[i] < -1e-9) exits.push((box.min[i] - from[i]) / d[i]);
    }
    const t = Math.max(0, nearest ? Math.min(...exits) : Math.max(...exits));
    return [from[0] + d[0] * t, from[1] + d[1] * t];
  }

  /** The middle of the longest visible line of a body in a view, view mm, and how much of it shows. */
  visibleAnchor(viewId: string, body: string): { at: Vec2; length: number } | null {
    const pv = this.projected.get(projectionOf(this.allViews, viewId));
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
    const m = this.member(a.member);
    if (!m) return { problem: `no member "${a.member}" built` };
    const body = m.body;
    const item = this.cut.find((i) => i.members.includes(m.id));
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
    const f = cv.frame;
    const facing = Math.abs(h.axis[0] * f.eye[0] + h.axis[1] * f.eye[1] + h.axis[2] * f.eye[2]);
    if (facing < 0.999) return { problem: `${a.hole} isn't seen as a circle in ${cv.id}: call it out in a view that looks along it` };
    const lines = holeText(h, this.holeCounts.get(a.hole));
    const c = this.toSheet(cv, inView(h.entry, f));
    const r = ((h.counterbore?.diameter ?? h.countersink?.diameter ?? h.diameter) / 2) * cv.scale;
    // Its centre mark.
    const m = r + 2;
    this.prims.push({ k: "line", pts: [[c[0] - m, c[1]], [c[0] + m, c[1]]], w: LINE.thin, dash: [6, 1.5, 1, 1.5] });
    this.prims.push({ k: "line", pts: [[c[0], c[1] - m], [c[0], c[1] + m]], w: LINE.thin, dash: [6, 1.5, 1, 1.5] });
    const w = Math.max(...lines.map((l) => calloutWidth(l, TEXT.dimension)));
    // Just out of the view, near the hole, on the sheet and clear of everything placed so far (other callouts too).
    const at: Vec2 = a.at ? [cv.centre[0] + a.at[0], cv.centre[1] + a.at[1]] : this.calloutSpot(cv, c, w, lines.length);
    const right = at[0] >= c[0];
    // Leader from the hole's edge to a landing under the text.
    const d: Vec2 = [at[0] - c[0], at[1] - c[1]];
    const len = Math.hypot(d[0], d[1]) || 1;
    const edge: Vec2 = [c[0] + (d[0] / len) * r, c[1] + (d[1] / len) * r];
    const landing: Vec2 = [at[0] + (right ? w + 1 : -w - 1), at[1]];
    this.prims.push({ k: "line", pts: [landing, at, edge], w: LINE.thin });
    this.arrow(edge, [-d[0] / len, -d[1] / len]);
    lines.forEach((l, i) => this.calloutLine([at[0] + (right ? 0.5 : -0.5), at[1] + 1.2 - i * TEXT.dimension * 1.25], l, TEXT.dimension, right ? "start" : "end"));
    return { text: lines.join(" "), at };
  }

  /** The box a hole callout's text (and its landing) takes with its leader's knee at `at`, the text running right or left. */
  private calloutBox(at: Vec2, right: boolean, w: number, lines: number): Box {
    const x0 = right ? at[0] : at[0] - w - 1;
    return { min: [x0, at[1] + 1.2 - (lines - 1) * TEXT.dimension * 1.25 - TEXT.dimension * 0.3], max: [x0 + w + 1, at[1] + 1.2 + TEXT.dimension * CAP] };
  }

  /**
   * Where a hole callout's leader turns: just outside its view, up and right
   * of the hole if there is room, else as near the hole as it can be, with
   * its text on the sheet and clear of the other views, tables, the title
   * block, the view labels and the annotations placed before it (another
   * hole's callout, a dimension).
   */
  private calloutSpot(cv: ComposedView, hole: Vec2, w: number, lines: number): Vec2 {
    const blocked = [
      this.titleBlock,
      ...this.views.filter((x) => x.box).map((x) => grow(x.box!, x.id === cv.id ? 1 : 2)),
      ...this.tableBoxes,
      ...this.labels,
      ...[...this.annotations.values()].filter((x) => x.box && (x.type === "hole" || x.type === "weld" || x.type === "balloon" || x.type === "dimension")).map((x) => x.box!),
      ...this.placedCallouts,
    ];
    const fits = (at: Vec2) => {
      const box = this.calloutBox(at, at[0] >= hole[0], w, lines);
      return inside(box, this.frame) && !blocked.some((b) => overlaps(box, b));
    };
    // Up and right of the hole, out through the view's nearer side: the usual place.
    const usual = this.outside(cv, [hole[0] + 1, hole[1] + 1], 8, [1, 1], true);
    let best: { at: Vec2; cost: number } | null = fits(usual) ? { at: usual, cost: 0 } : null;
    if (!best) {
      for (let k = 0; k < 72; k++) {
        const t = (k / 72) * 2 * Math.PI;
        for (const clear of [8, 16, 24]) {
          const at = this.outside(cv, hole, clear, [Math.cos(t), Math.sin(t)]);
          if (!fits(at)) continue;
          // Above the view reads best; below it, among the dimensions, least.
          // A leader square to the sheet runs along the hole's centre line and the dimensions' extension lines: slanted reads apart.
          const dx = Math.abs(at[0] - hole[0]);
          const dy = Math.abs(at[1] - hole[1]);
          const square = Math.min(dx, dy) < 0.15 * Math.max(dx, dy) ? 12 : 0;
          const cost = Math.hypot(at[0] - hole[0], at[1] - hole[1]) + (at[1] < cv.box!.min[1] ? 30 : 0) + square;
          if (!best || cost < best.cost) best = { at, cost };
        }
      }
    }
    const at = best?.at ?? usual;
    this.placedCallouts.push(this.calloutBox(at, at[0] >= hole[0], w, lines));
    return at;
  }

  /** The hole callouts' text boxes placed so far. */
  private placedCallouts: Box[] = [];

  /**
   * One line of a hole callout. The depth symbol ⌴ is drawn (a box open at
   * the top), not set as text: Helvetica, the PDF's font, has no such glyph.
   */
  private calloutLine(at: Vec2, text: string, size: number, anchor: "start" | "end"): void {
    if (!text.includes(DEPTH)) {
      this.prims.push({ k: "text", at, text, size, anchor });
      return;
    }
    let x = anchor === "start" ? at[0] : at[0] - calloutWidth(text, size);
    const pieces = text.split(DEPTH);
    pieces.forEach((piece, i) => {
      if (piece) this.prims.push({ k: "text", at: [x, at[1]], text: piece, size, anchor: "start" });
      x += textWidth(piece, size);
      if (i === pieces.length - 1) return;
      const h = size * CAP * 0.8;
      const w = size * DEPTH_WIDTH;
      const inset = size * 0.08;
      this.prims.push({ k: "line", pts: [[x + inset, at[1] + h], [x + inset, at[1]], [x + w - inset, at[1]], [x + w - inset, at[1] + h]], w: LINE.thin });
      x += w;
    });
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
    const f = cv.frame;
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

  /** A GeoRef of this sheet, resolved (view mm in `inView`). */
  private geo(ref: string) {
    return resolveGeoRef(this.views.length ? [this.partial()] : [], ref);
  }

  /** This sheet as composed so far: enough to resolve GeoRefs against its views. */
  private partial(): ComposedSheet {
    return { id: this.s.id, views: this.views, points: this.points } as ComposedSheet;
  }

  /** A centre mark: the circle's centre lines a little past it, and the short cross where they meet (thin chain lines). */
  private drawCenterMark(a: CenterMarkAnnotation, cv: ComposedView): { text: string; at: Vec2 } | { problem: string } {
    const g = this.geo(a.at);
    if (!g) return { problem: `${a.at} is not in ${cv.id} any more` };
    let c: Vec2;
    let r: number;
    if (g.kind === "circle") {
      c = g.inView.c;
      r = g.inView.r;
    } else if (g.kind === "point" && g.of === "centre") {
      c = g.inView;
      const e = cv.edges.find((x) => x.key === g.key && x.circle);
      r = e?.circle?.r ?? 0;
    } else return { problem: `${a.at} is not a circle or an arc's centre` };
    const s = this.toSheet(cv, c);
    const R = r * cv.scale + (a.extend ?? 2.5);
    const cross = Math.min(1.5, R / 3);
    this.prims.push({ k: "line", pts: [[s[0] - R, s[1]], [s[0] + R, s[1]]], w: LINE.thin, dash: R > 6 ? CENTER_DASH : undefined });
    this.prims.push({ k: "line", pts: [[s[0], s[1] - R], [s[0], s[1] + R]], w: LINE.thin, dash: R > 6 ? CENTER_DASH : undefined });
    if (R > 6) {
      // The dash pattern may leave the centre open: a short solid cross marks it.
      this.prims.push({ k: "line", pts: [[s[0] - cross, s[1]], [s[0] + cross, s[1]]], w: LINE.thin });
      this.prims.push({ k: "line", pts: [[s[0], s[1] - cross], [s[0], s[1] + cross]], w: LINE.thin });
    }
    return { text: `centre mark Ø${fmt(2 * (g.kind === "circle" ? g.radius : r))}`, at: s };
  }

  /** A centre line: midway between two edges (a cylinder's sides), or through two points, a little past both ends. */
  private drawCenterline(a: CenterlineAnnotation, cv: ComposedView): { text: string; at: Vec2 } | { problem: string } {
    const [g1, g2] = a.between.map((r) => this.geo(r));
    if (!g1 || !g2) return { problem: `${!g1 ? a.between[0] : a.between[1]} is not in ${cv.id} any more` };
    let p: Vec2;
    let q: Vec2;
    if (g1.kind === "edge" && g2.kind === "edge" && g1.inView.a && g1.inView.b && g2.inView.a && g2.inView.b) {
      const [a1, b1] = [g1.inView.a, g1.inView.b];
      let [a2, b2] = [g2.inView.a, g2.inView.b];
      // Pair the ends that are nearer each other.
      if (Math.hypot(a1[0] - a2[0], a1[1] - a2[1]) > Math.hypot(a1[0] - b2[0], a1[1] - b2[1])) [a2, b2] = [b2, a2];
      p = [(a1[0] + a2[0]) / 2, (a1[1] + a2[1]) / 2];
      q = [(b1[0] + b2[0]) / 2, (b1[1] + b2[1]) / 2];
    } else if (g1.kind !== "edge" && g2.kind !== "edge") {
      p = g1.kind === "circle" ? g1.inView.c : g1.inView;
      q = g2.kind === "circle" ? g2.inView.c : g2.inView;
    } else return { problem: "a centre line is between two edges or through two points" };
    const s = this.toSheet(cv, p);
    const t = this.toSheet(cv, q);
    const d: Vec2 = [t[0] - s[0], t[1] - s[1]];
    const l = Math.hypot(d[0], d[1]);
    if (l < 1e-6) return { problem: "its two ends are the same place" };
    const ext = a.extend ?? 2.5;
    const u: Vec2 = [d[0] / l, d[1] / l];
    this.prims.push({ k: "line", pts: [[s[0] - u[0] * ext, s[1] - u[1] * ext], [t[0] + u[0] * ext, t[1] + u[1] * ext]], w: LINE.thin, dash: CENTER_DASH });
    return { text: "centre line", at: [(s[0] + t[0]) / 2, (s[1] + t[1]) / 2] };
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
    for (const a of this.s.annotations) {
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
    return this.s.annotations
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
    const s = { ...this.s.format, projection: this.s.projection };
    const m = this.ctx.measurements;
    // The part's properties fill what the sheet does not say itself: its own number, revision and "drawn by" win.
    const p = this.v.properties;
    const material = m?.mass.material ?? this.v.material?.name ?? "steel";
    const cells: { x: number; y: number; w: number; h: number; label: string; value: string; big?: boolean }[] = [];
    const [x0, y0] = b.min;
    const row1 = 12;
    const row = 9;
    const rows = (y: number, list: readonly (readonly [number, string, string])[]) => {
      let x = x0;
      for (const [w, label, value] of list) {
        cells.push({ x, y, w, h: row, label, value });
        x += w;
      }
    };
    // Top row: the title and the part number.
    cells.push({ x: x0, y: y0 + 3 * row, w: 110, h: row1, label: "TITLE", value: s.title ?? this.v.name, big: true });
    cells.push({ x: x0 + 110, y: y0 + 3 * row, w: 70, h: row1, label: "PART NO.", value: p.partNumber ?? "" });
    // What it is, the drawing's number and revision.
    rows(y0 + 2 * row, [
      [110, "DESCRIPTION", p.description ?? ""],
      [45, "DRAWING NO.", s.number ?? p.partNumber ?? ""],
      [25, "REV", s.revision ?? p.revision ?? ""],
    ]);
    // What it is made of and how it is drawn.
    rows(y0 + row, [
      [56, "MATERIAL", material],
      [54, "FINISH", p.finish ?? ""],
      [30, "MASS", m ? `${m.mass.kg.toFixed(2)} kg` : ""],
      [20, "SCALE", scaleText(scale)],
      [20, "SIZE", s.size],
    ]);
    // Who and when, the projection, the sheet.
    rows(y0, [
      [36, "DRAWN", s.drawnBy ?? p.author ?? ""],
      [28, "DATE", s.date ?? ""],
      [44, `${s.projection.toUpperCase()} ANGLE`, ""],
      [20, "SHEET", `${this.index + 1} of ${this.d.sheets.length}`],
      [52, "UNITS", "mm. Do not scale."],
    ]);
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

/** The depth symbol of a hole callout (ISO 129): drawn on the sheet, written in the callout's text. */
const DEPTH = "⌴";
/** Its width, as a fraction of the font size. */
const DEPTH_WIDTH = 0.62;

/** A callout line's width on the sheet, the depth symbol as drawn. */
function calloutWidth(text: string, size: number): number {
  const pieces = text.split(DEPTH);
  return pieces.reduce((w, p) => w + textWidth(p, size), 0) + (pieces.length - 1) * size * DEPTH_WIDTH;
}

/**
 * "4× Ø6.6 THRU", then a counterbore or countersink line. A tapped hole: its
 * thread, "3× M6×1 - 6H ⌴12" (or THRU), then its tap drill when the drill
 * stops short, "Ø5 ⌴15". `count` is how many holes the callout stands for
 * (default: this one and its copies).
 */
export function holeText(h: HoleRecord, count = h.copies + 1): string[] {
  const n = count;
  if (h.thread) {
    const lines = [`${n > 1 ? `${n}× ` : ""}${threadCallout(h.thread)}`];
    if (!h.through) lines.push(`Ø${fmt(h.diameter)} ${DEPTH}${fmt(h.depth)}`);
    return lines;
  }
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

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** The smallest standard scale at or above k (a detail at twice its parent's scale). */
function nextScaleUp(k: number): number {
  const all = STANDARD_SCALES.map((s) => parseScale(s)!).sort((a, b) => a - b);
  return all.find((s) => s >= k - 1e-9) ?? all[all.length - 1];
}

function normalize3(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000 + 0;
}
