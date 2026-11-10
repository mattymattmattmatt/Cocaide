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
import { allViews, parseGeoRef, parseScale, STANDARD_SCALES, viewKind } from "../doc/drawing";
import {
  type AnnotationType,
  type DimensionAnnotation,
  type Drawing,
  type DrawingSheet,
  type DrawingView,
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
import { holesInView, holeTable, holeTagPrims, outlineOrigin, renderSheetTables, type DrawingTable, type HoleTableRow, type RenderedTable, type RevisionRow, type TableContext, type TableCorner } from "./tables";
import { cutListOf, itemNumberFor } from "../weldment/items";
import { draftStyle, layoutSheetAnnotations, measureDimension, Occupancy, planDimensionRows, rowDistance, type AnnotationContext, type AnnotationData, type DraftStyle, type Grip, type Measure, type ViewInfo } from "./annotate";
import { nestCutList } from "../weldment/nesting";
import type { PropContext } from "./props";
import { boxOf, centre, grow, inside, overlaps, primBox, type Box, type Prim } from "./sheet";
import { projectionOf } from "./specs";
import { CAP, CENTER_DASH, HIDDEN_DASH, LINE, PHANTOM_DASH, TEXT, textWidth } from "./text";
import { DIRECTION_VECTORS, inView, isSquareFrame, leftOf, placeFromFront, sameFrame, sectionSide, viewFrame, type ViewFrame } from "./views";

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
  /** Why it isn't on the sheet (a dangling one is drawn at its last place, in the warning colour). */
  problem?: string;
  dangling?: boolean;
  /** Where its text is, on the sheet. */
  textBox?: Box;
  /** The handles a drag moves (src/drafting/annotate/picks dragGrip). */
  grips?: Grip[];
  /** Where it is now, from its view's centre: what rememberPlaces keeps as its `last`. */
  place?: { pts: Vec2[]; text: string };
  /** Hidden: kept, not drawn. */
  hidden?: boolean;
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
  /**
   * Tables with no anchor of their own that the layout moved from their usual
   * corner so the views fit at a larger scale (Phase Q Q4 polish): Fit views
   * and New drawing store these as the tables' anchors.
   */
  tableCorners?: Record<string, TableCorner>;
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
const ARROW = { length: 3, half: 0.6 };
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

/**
 * The annotation context each composed sheet was laid out in (its views, its
 * data, what is already where): the sheet editor lays a tool's annotation out
 * in it for a live preview that is exactly what will be drawn.
 */
export const LAYOUT_CONTEXT = new WeakMap<ComposedSheet, AnnotationContext>();

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
  /** Every view of the drawing by id (a section's parent may be on another sheet). */
  private readonly allViews: Map<string, DrawingView>;
  /** This sheet's views, by id. */
  private readonly here: Map<string, DrawingView>;
  private readonly props: PropContext;
  private readonly points: PointContext;
  /** How annotations are drawn: the standard's, or Phase L's for the classic template. */
  private readonly style: DraftStyle;
  /** The scale dimensions are planned at before the sheet's is known. */
  private readonly provisional = 1;

  constructor(
    private readonly v: ValidationResult,
    private readonly d: Drawing,
    private readonly s: DrawingSheet,
    private readonly index: number,
    private readonly ctx: ComposeContext,
    private readonly doc: unknown = null,
  ) {
    this.template = s.format.template ?? (d.standard === "ASME" ? "ansi" : "iso");
    this.style = draftStyle(d.standard ?? "ISO", this.template);
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
    this.planDimensions();
    // The sheet's tables (src/drafting/tables): placed by their anchors before the views, which keep clear of them.
    // Tables with no anchor of their own may go to the top right instead when the views then fit at a larger scale
    // (or, with the sheet's scale stored, fit at all).
    let best: { tables: ReturnType<Composer["placeTables"]>; sheetTables: ReturnType<Composer["renderTables"]>; blocked: Box[]; scale: number; views: ComposedView[]; fitted: boolean; corners: Record<string, TableCorner> } | null = null;
    for (const corners of this.tableVariants()) {
      const tables = this.placeTables(corners);
      const sheetTables = this.renderTables(corners);
      const tableBoxes = sheetTables.flatMap((t) => t.rendered.boxes);
      const blocked = [this.titleBlock, ...(this.format?.revisionBlock ? [this.format.revisionBlock] : []), ...tables.map((t) => t.box), ...this.notes().map((n) => n.box), ...tableBoxes];
      const laid = this.layout(blocked);
      const better = !best || (laid.fitted && (!best.fitted || laid.scale > best.scale + 1e-12));
      if (better) best = { tables, sheetTables, blocked, ...laid, corners };
      if (best!.fitted && parseScale(this.s.scale)) break;
    }
    const { tables, sheetTables, scale, views, corners } = best!;
    this.views = views;
    this.tableBoxes = [...tables.map((t) => t.box), ...this.notes().map((n) => n.box), ...sheetTables.flatMap((t) => t.rendered.boxes)];

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
    this.drawAnnotations(tables);
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
    const sheet: ComposedSheet = {
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
      ...(Object.keys(corners).length ? { tableCorners: corners } : {}),
    };
    if (this.annotationCtx) LAYOUT_CONTEXT.set(sheet, this.annotationCtx);
    return sheet;
  }

  // ------------------------------------------------------------- tables (Phase Q)

  /** The sheet's tables, rendered: what each says (the cut list v2, welds, revisions, a view's holes) where its anchor puts it. */
  /**
   * The table arrangements the layout may try, as corners for tables with no
   * anchor of their own: none moved first, then the cut list, BOM and weld
   * tables (which sit by the title block) at the top right.
   */
  private tableVariants(): Record<string, TableCorner>[] {
    const movable = (this.s.tables ?? []).filter((t) => !t.anchor && (t.kind === "cutList" || t.kind === "bom" || t.kind === "welds")).map((t) => t.id);
    // A Phase L table annotation (the cut list or weld table New drawing puts above the title block) likewise.
    const legacy = this.s.annotations.find((a) => a.type === "table" && !a.at);
    if (legacy) movable.push(legacy.id);
    const out: Record<string, TableCorner>[] = [{}];
    if (movable.length) out.push(Object.fromEntries(movable.map((id) => [id, "topRight" as TableCorner])));
    return out;
  }

  private renderTables(corners: Record<string, TableCorner> = {}): { table: DrawingTable; rendered: RenderedTable; holes?: { view: string; rows: HoleTableRow[]; origin: Vec2 } }[] {
    const tables = (this.s.tables ?? []).map((t) => (corners[t.id] ? { ...t, anchor: { corner: corners[t.id] } } : t));
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
      // A view the user placed keeps its cell (Phase Q wave Q4): the others don't close up round where it was.
      const g = placeFromFront(view.look ?? "front", this.s.projection);
      if (!g) continue;
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
        if (out.has(view.id)) continue;
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

  /** Each dimension measured in its view (view mm), before the views are placed. */
  private readonly measures = new Map<string, Measure | { problem: string }>();
  /** Each view's linear dimensions with the side they go on. */
  private readonly dimItems = new Map<string, { id: string; m: Measure; side: -1 | 1; fixed: boolean }[]>();
  private readonly rowCache = new Map<string, Map<string, { side: -1 | 1; row: number; dir: "h" | "v" | "a" }>>();

  /** A view as far as measuring in it goes. */
  private viewInfo(view: DrawingView): ViewInfo {
    const pv = this.pv(view);
    return { id: view.id, edges: pv?.edges ?? [], frame: this.frameOf(view), outline: this.outline(view), square: this.squareById(view.id) };
  }

  /** Measures each dimension and decides its side: away from the views beside it, else the side its points are nearer. */
  private planDimensions(): void {
    const grid = this.grid();
    const occupied = new Set([...grid.values()].map(String));
    const neighbour = (id: string, dx: number, dy: number) => {
      const g = grid.get(id);
      return !!g && occupied.has(String([g[0] + dx, g[1] + dy]));
    };
    const members = this.points.members;
    for (const a of this.s.annotations) {
      if (a.type !== "dimension") continue;
      const view = this.here.get(a.view);
      if (!view) continue;
      const info = this.viewInfo(view);
      const m = measureDimension(a, info, this.points, members);
      this.measures.set(a.id, m);
      if ("problem" in m || (m.kind !== "linear" && m.kind !== "set")) continue;
      const dir = m.kind === "linear" ? m.dir : m.dir;
      let side: -1 | 1;
      if (a.offset !== undefined && a.offset !== 0) side = a.offset > 0 ? 1 : -1;
      else if (dir === "a") side = 1;
      else {
        const toward = (sd: -1 | 1) => (dir === "h" ? neighbour(a.view, 0, sd) : neighbour(a.view, sd, 0));
        const o = info.outline!;
        const axis = dir === "h" ? 1 : 0;
        const mid = (o.min[axis] + o.max[axis]) / 2;
        const half = (o.max[axis] - o.min[axis]) / 2 || 1;
        let near: -1 | 1 | undefined;
        if (m.kind === "linear") {
          if (m.near !== undefined) near = m.near;
          else if (!m.sides[0] || !m.sides[1]) {
            const pts = [m.p1, m.p2].filter((_, i) => !m.sides[i]);
            const c = pts.reduce((t, p) => t + p[axis], 0) / pts.length;
            // Only a clear lean counts: a point near the middle goes on the usual side.
            if (Math.abs(c - mid) > 0.25 * half) near = c > mid ? 1 : -1;
          }
        }
        side = near ?? (toward(-1) && !toward(1) ? 1 : -1);
        if (toward(side) && !toward(-side as -1 | 1)) side = -side as -1 | 1;
      }
      this.dimItems.set(a.view, [...(this.dimItems.get(a.view) ?? []), { id: a.id, m, side, fixed: a.offset !== undefined || a.at !== undefined }]);
    }
  }

  /** The rows of a view's dimensions at scale k. */
  private rows(viewId: string, k: number): Map<string, { side: -1 | 1; row: number; dir: "h" | "v" | "a" }> {
    const key = `${viewId}@${k}`;
    let r = this.rowCache.get(key);
    if (!r) {
      r = planDimensionRows(this.dimItems.get(viewId) ?? [], k, this.style);
      this.rowCache.set(key, r);
    }
    return r;
  }

  /** Room each view's annotations need around it, sheet mm: [left, bottom, right, top]. */
  private padding(view: DrawingView, k?: number, sheetScale?: number): [number, number, number, number] {
    return this.paddings(view, k, sheetScale).all;
  }

  /**
   * The room a view's annotations need ([left, bottom, right, top]): all of
   * it, and the part that is its dimension stacks and label alone (what two
   * views side by side can't share; the room kept for callouts and symbols,
   * which find their own places, they can).
   */
  private paddings(view: DrawingView, k?: number, sheetScale?: number): { all: [number, number, number, number]; dims: [number, number, number, number] } {
    const pad: [number, number, number, number] = [INSET, INSET, INSET, INSET];
    const need = (i: number, mm: number) => (pad[i] = Math.max(pad[i], mm));
    const text = this.style.h + this.style.lift + 2.5;
    const rows = this.rows(view.id, k ?? this.provisional);
    for (const item of this.dimItems.get(view.id) ?? []) {
      const a = this.s.annotations.find((x) => x.id === item.id) as DimensionAnnotation;
      const r = rows.get(item.id);
      const deepest = item.m.kind === "set" && item.m.mode === "baseline" ? Math.max(0, ...item.m.pts.map((_, i) => rows.get(`${item.id}#${i}`)?.row ?? 0)) : (r?.row ?? 0);
      const dist = a.offset !== undefined ? Math.abs(a.offset) : rowDistance(deepest, this.style);
      const extra = item.m.kind === "set" && item.m.mode === "ordinate" ? 3 * this.style.font : 0;
      if (r?.dir === "h" || (item.m.kind === "set" && item.m.dir === "h")) need(item.side < 0 ? 1 : 3, dist + text + extra);
      else if (r?.dir === "v" || (item.m.kind === "set" && item.m.dir === "v")) need(item.side < 0 ? 0 : 2, dist + text + extra);
      else for (let i = 0; i < 4; i++) need(i, this.style.first + text);
    }
    const dims: [number, number, number, number] = [...pad];
    // Radial and angular dimensions, callouts, symbols and balloons stand out of the view where there is room.
    let room0 = 0;
    for (const a of this.s.annotations) {
      if (!("view" in a) || a.view !== view.id || ("at" in a && a.at)) continue;
      const room = a.type === "balloon" ? 17 : a.type === "weld" ? 18 : a.type === "hole" ? 16 : a.type === "gdt" ? 14 : a.type === "datum" ? 12 : a.type === "surface" ? 14 : a.type === "dimension" && a.kind && ["radius", "diameter", "chamfer", "angular", "arcLength", "pathLength"].includes(a.kind) && a.refs?.length === 1 ? 12 : 0;
      room0 = Math.max(room0, room);
    }
    if (room0) for (let i = 0; i < 4; i++) need(i, room0);
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
    if (label) {
      pad[1] += 5 + label * TEXT.title * 0.95;
      dims[1] += 5 + label * TEXT.title * 0.95;
    }
    return { all: pad, dims };
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

  /**
   * The sheet's scale and its views' places (Phase Q wave Q4). The layout is
   * worked out as if no view had been moved — the projection's grid, the
   * loose column, the scale (the sheet's, else the largest standard one at
   * which that layout fits) — and only then does each view the user placed go
   * where they put it, the views lined up with it following. So moving a view
   * never changes a scale, nor where the other views are, nor any view's size.
   */
  private layout(blocked: Box[]): { scale: number; views: ComposedView[]; fitted: boolean } {
    const natural = this.naturalLayout(blocked);
    return { scale: natural.scale, views: this.settle(natural.views), fitted: natural.fitted };
  }

  private naturalLayout(blocked: Box[]): { scale: number; views: ComposedView[]; fitted: boolean } {
    const fixed = parseScale(this.s.scale);
    const grid = this.grid();
    this.gridCache = grid;
    const loose = this.s.views.filter((view) => !grid.has(view.id));
    const candidates = fixed ? [fixed] : STANDARD_SCALES.map((s) => parseScale(s)!);
    // Iso views placed on their own may go a step or two smaller to fit (never below a scale the sheet was given); a detail is never smaller than its parent.
    const shrinkable = !fixed && loose.some((v) => viewKind(v) === "model" || viewKind(v) === "projected");
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
          if (this.fits(views, blocked, candidates[i])) return { scale: candidates[i], views, fitted: true };
        }
      }
      // The usual arrangement doesn't fit at this scale: the projection's group in another corner (or beside a
      // table, above the title block), the views on their own packed into whatever room is left (Phase Q Q4 polish).
      for (const step of shrinkable ? [0, 1, 2] : [0]) {
        const looseScale = candidates[Math.min(i + step, candidates.length - 1)];
        const views = this.packed(candidates[i], looseScale, grid, loose, blocked);
        if (views) return { scale: candidates[i], views, fitted: true };
      }
    }
    this.start = [left, top];
    // Nothing fits: the sheet's scale, else the smallest; the checks say what overlaps.
    const smallest = candidates[candidates.length - 1];
    return { scale: smallest, views: this.place(smallest, smallest, grid, loose), fitted: false };
  }

  /**
   * The views where the user put them: a view with a place of its own is
   * there (at its natural scale and size); a view lined up with its parent is
   * kept on the parent's line, and one with no place of its own goes with its
   * parent by as much as the parent moved. Every other view stays put.
   */
  private settle(natural: ComposedView[]): ComposedView[] {
    const byId = new Map(natural.map((cv) => [cv.id, cv]));
    const out = new Map<string, ComposedView>();
    const moved = (cv: ComposedView, d: Vec2): ComposedView => ({
      ...cv,
      centre: [cv.centre[0] + d[0], cv.centre[1] + d[1]],
      box: cv.box ? { min: [cv.box.min[0] + d[0], cv.box.min[1] + d[1]], max: [cv.box.max[0] + d[0], cv.box.max[1] + d[1]] } : null,
    });
    const visit = (id: string, trail: Set<string>): ComposedView | undefined => {
      const done = out.get(id);
      if (done) return done;
      const cv = byId.get(id);
      const view = this.here.get(id);
      if (!cv || !view) return undefined;
      const parent = this.attachDir(view) && view.parent && byId.has(view.parent) && !trail.has(view.parent) ? view.parent : null;
      const pNatural = parent ? byId.get(parent) : undefined;
      const pNow = parent ? visit(parent, new Set([...trail, id])) : undefined;
      let now: ComposedView;
      if (view.at) now = { ...moved(cv, [view.at[0] - cv.centre[0], view.at[1] - cv.centre[1]]), auto: false };
      else if (pNatural && pNow) now = moved(cv, [pNow.centre[0] - pNatural.centre[0], pNow.centre[1] - pNatural.centre[1]]);
      else now = cv;
      out.set(id, now);
      if (pNow) this.lineUp(view, out);
      return out.get(id);
    };
    for (const cv of natural) visit(cv.id, new Set());
    return natural.map((cv) => out.get(cv.id)!);
  }

  /**
   * True when every view placed automatically, with the room its annotations
   * need, is on the sheet and clear of the title block, the tables, the notes
   * and every other view. A view the user placed is an obstacle, not judged:
   * where it is is theirs (the checks say if it overlaps).
   */
  private fits(views: ComposedView[], blocked: Box[], scale: number, tight = false): boolean {
    const padded = views.filter((cv) => cv.box).map((cv) => {
      const p = this.paddings(this.here.get(cv.id)!, cv.scale, scale);
      return { cv, box: grow(cv.box!, p.all), dims: grow(cv.box!, p.dims) };
    });
    const auto = padded.filter((p) => p.cv.auto);
    const held = padded.filter((p) => !p.cv.auto).map((p) => p.cv.box!);
    for (const { box, dims } of auto) {
      if (tight ? !roomFor(box, dims, this.frame) : !inside(box, this.frame)) return false;
      if ([...blocked, ...held].some((b) => overlaps(box, b))) return false;
    }
    for (let i = 0; i < auto.length; i++)
      for (let j = i + 1; j < auto.length; j++) {
        const [a, b] = [auto[i], auto[j]];
        // Packed close (tight), views may share the room kept for callouts, not a view nor a dimension stack.
        if (tight ? overlaps(a.box, b.cv.box!) || overlaps(a.cv.box!, b.box) || overlaps(a.dims, b.dims) : overlaps(a.box, b.box)) return false;
      }
    return true;
  }

  /**
   * Another arrangement at a scale the usual one doesn't fit (Phase Q Q4
   * polish): the projection's group of views tried against each corner of the
   * frame and beside each table, title block and revision block (highest and
   * leftmost first), then each view on its own put in the highest, rightmost
   * room left that holds it with the room its annotations need. Null when no
   * arrangement fits.
   */
  private packed(scale: number, looseScale: number, grid: Map<string, Vec2>, loose: DrawingView[], blocked: Box[]): ComposedView[] | null {
    const left = this.frame.min[0] + INSET;
    const right = this.frame.max[0] - INSET;
    const top = this.frame.max[1] - INSET;
    const bottom = this.frame.min[1] + INSET;
    this.start = [left, top];
    const all = this.place(scale, looseScale, grid, loose, true);
    const padded = (cv: ComposedView): Box => grow(cv.box!, this.padding(this.here.get(cv.id)!, cv.scale, scale));
    const group = all.filter((cv) => grid.has(cv.id) && cv.box);
    const rest = all.filter((cv) => !grid.has(cv.id) && cv.box);
    const room: Box = { min: [left, bottom], max: [right, top] };
    const free = (b: Box, others: Box[]) => inside(b, room) && !others.some((o) => overlaps(b, o));
    for (const cv of rest) {
      const p = padded(cv);
      if (p.max[0] - p.min[0] > right - left || p.max[1] - p.min[1] > top - bottom) return null;
    }
    // Where the group may go: each pairing of an x and a y its box (or its dimensions' box) may line up with.
    const shifts: Vec2[] = [[0, 0]];
    if (group.length) {
      const boxes = group.map((cv) => {
        const p = this.paddings(this.here.get(cv.id)!, cv.scale, scale);
        return { full: grow(cv.box!, p.all), dims: grow(cv.box!, p.dims) };
      });
      const span = (bs: Box[]): Box => ({ min: [Math.min(...bs.map((x) => x.min[0])), Math.min(...bs.map((x) => x.min[1]))], max: [Math.max(...bs.map((x) => x.max[0])), Math.max(...bs.map((x) => x.max[1]))] });
      const g = span(boxes.map((x) => x.full));
      const gd = span(boxes.map((x) => x.dims));
      if (gd.max[0] - gd.min[0] > right - left || gd.max[1] - gd.min[1] > top - bottom) return null;
      const dxs = [g, gd].flatMap((x) => [left - x.min[0], right - x.max[0], ...blocked.flatMap((o) => [o.max[0] + GAP - x.min[0], o.min[0] - GAP - x.max[0]])]);
      const dys = [g, gd].flatMap((x) => [top - x.max[1], bottom - x.min[1], ...blocked.flatMap((o) => [o.min[1] - GAP - x.max[1], o.max[1] + GAP - x.min[1]])]);
      const tries: Vec2[] = [];
      for (const dx of dxs) for (const dy of dys) tries.push([dx, dy]);
      tries.sort((p, q) => q[1] - p[1] || p[0] - q[0]);
      shifts.length = 0;
      for (const t of tries) {
        if (shifts.some((x) => Math.abs(x[0] - t[0]) < 1e-6 && Math.abs(x[1] - t[1]) < 1e-6)) continue;
        if (boxes.every((x) => roomFor(shiftBox(x.full, t), shiftBox(x.dims, t), room) && !blocked.some((o) => overlaps(shiftBox(x.full, t), o)))) shifts.push(t);
      }
    }
    for (const d of shifts) {
      const placed = new Map<string, ComposedView>();
      for (const cv of group) placed.set(cv.id, shiftView(cv, d));
      const obstacles = [...blocked, ...[...placed.values()].map(padded)];
      let ok = true;
      for (const cv of rest) {
        const p = padded(cv);
        const w = p.max[0] - p.min[0];
        const h = p.max[1] - p.min[1];
        const xs = [right - w, left, ...obstacles.flatMap((o) => [o.min[0] - GAP - w, o.max[0] + GAP])];
        const ys = [top - h, bottom, ...obstacles.flatMap((o) => [o.min[1] - GAP - h, o.max[1] + GAP])];
        let best: Vec2 | null = null;
        for (const y of ys)
          for (const x of xs) {
            if (best && (y < best[1] - 1e-6 || (Math.abs(y - best[1]) < 1e-6 && x <= best[0]))) continue;
            if (free({ min: [x, y], max: [x + w, y + h] }, obstacles)) best = [x, y];
          }
        if (!best) {
          ok = false;
          break;
        }
        const moved = shiftView(cv, [best[0] - p.min[0], best[1] - p.min[1]]);
        placed.set(cv.id, moved);
        obstacles.push(padded(moved));
      }
      if (!ok) continue;
      const views = all.map((cv) => placed.get(cv.id) ?? cv);
      if (this.fits(views, blocked, scale, true)) return views;
    }
    return null;
  }

  /** Where the projection's group of views starts (its top left), and the loose column's top. */
  private start: Vec2 | null = null;
  private looseTop: number | null = null;

  private place(scale: number, looseScale: number, grid: Map<string, Vec2>, loose: DrawingView[], tight = false): ComposedView[] {
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
    // Every view where it goes when nobody has moved it (settle() then puts the ones the user placed where they are).
    // The projection: columns and rows around the front, each view's lines aligned with its neighbours'.
    const inGrid = this.s.views.filter((view) => grid.has(view.id));
    if (inGrid.length) {
      const ext = new Map<string, { half: Vec2; pad: [number, number, number, number]; dims: [number, number, number, number]; k: number }>();
      for (const view of inGrid) {
        const k = own(view, scale);
        const p = this.paddings(view, k, scale);
        ext.set(view.id, { half: this.extent(view, k).half, pad: p.all, dims: p.dims, k });
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
      if (tight) {
        // Packed closer: a column keeps clear only of the views in the same rows as its own (and a row of those in
        // its columns), and two views side by side share the room kept for callouts (not their dimension stacks).
        const at = (c: number, r: number) => inGrid.find((view) => grid.get(view.id)![0] === c && grid.get(view.id)![1] === r);
        const sep = (a: DrawingView, b: DrawingView, i: number, j: number) => {
          const ea = ext.get(a.id)!;
          const eb = ext.get(b.id)!;
          return Math.max(ea.pad[i], eb.pad[j], ea.dims[i] + eb.dims[j] + GAP);
        };
        cols.forEach((c, j) => {
          if (j === 0) return;
          let want = -Infinity;
          for (let i = 0; i < j; i++)
            for (const r of rows) {
              const a = at(cols[i], r);
              const b = at(c, r);
              if (a && b) want = Math.max(want, colX[i] + ext.get(a.id)!.half[0] + sep(a, b, 2, 0) + ext.get(b.id)!.half[0]);
            }
          if (want > -Infinity) colX[j] = Math.max(colX[j - 1], want);
        });
        rows.forEach((r, j) => {
          if (j === 0) return;
          let want = Infinity;
          for (let i = 0; i < j; i++)
            for (const c of cols) {
              const a = at(c, rows[i]);
              const b = at(c, r);
              if (a && b) want = Math.min(want, rowY[i] - ext.get(a.id)!.half[1] - sep(a, b, 1, 3) - ext.get(b.id)!.half[1]);
            }
          if (want < Infinity) rowY[j] = Math.min(rowY[j - 1], want);
        });
      }
      for (const view of inGrid) {
        const g = grid.get(view.id)!;
        out.set(view.id, make(view, ext.get(view.id)!.k, [colX[cols.indexOf(g[0])], rowY[rows.indexOf(g[1])]], true));
      }
      // A view made from its neighbour lines up with it exactly: the same model point at the same place across.
      for (const view of inGrid) this.lineUp(view, out);
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
    const cv = this.cv(id);
    const rows = this.rows(id, cv?.scale ?? this.provisional);
    for (const item of this.dimItems.get(id) ?? []) {
      const r = rows.get(item.id);
      const dir = item.m.kind === "set" ? item.m.dir : r?.dir;
      if (dir !== "h" || item.side > 0) continue;
      const a = this.s.annotations.find((x) => x.id === item.id) as DimensionAnnotation;
      const deepest = item.m.kind === "set" && item.m.mode === "baseline" ? Math.max(0, ...item.m.pts.map((_, i) => rows.get(`${item.id}#${i}`)?.row ?? 0)) : (r?.row ?? 0);
      const extra = item.m.kind === "set" && item.m.mode === "ordinate" ? 3 * this.style.font : 0;
      below = Math.max(below, (a.offset !== undefined ? Math.abs(a.offset) : rowDistance(deepest, this.style)) + this.style.h + this.style.lift + extra);
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

  /** The sheet's annotations laid out (src/drafting/annotate), each keeping clear of what is already there. */
  private drawAnnotations(tables: { a: TableAnnotation; box: Box; rows: string[][]; widths: number[] }[]): void {
    const occ = new Occupancy(this.frame);
    for (const cv of this.views) occ.addBox(cv.box ? grow(cv.box, 1) : null, "view", cv.id);
    occ.addBox(this.titleBlock, "title", "titleBlock");
    if (this.format?.revisionBlock) occ.addBox(this.format.revisionBlock, "title", "revisionBlock");
    for (const b of this.tableBoxes) occ.addBox(b, "table", "table");
    for (const b of this.labels) occ.addBox(b, "label", "label");
    // The views' marks: cutting lines' letters and arrows, detail letters (a callout keeps clear of them).
    for (const p of this.prims) {
      if (p.owner === "sheet" || p.owner === "titleBlock" || p.layer === "TEXT") continue;
      if (p.k === "text") occ.addPrims([p], p.owner ?? "mark");
      else if (p.layer === "SECTION" && p.k === "line") {
        const b = boxOf(p.pts);
        if (b && Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) < 16) occ.addBox(grow(b, 0.5), "label", p.owner ?? "mark");
      }
    }
    const ctx: AnnotationContext = {
      sheet: { id: this.s.id, views: this.views, points: this.points, frame: this.frame, titleBlock: this.titleBlock },
      style: this.style,
      drawing: this.d,
      data: this.annotationData(),
      occ,
      layouts: new Map(),
      all: new Map(this.s.annotations.map((a) => [a.id, a])),
      resolve: (ref) => resolveGeoRef(this.views.length ? [this.partial()] : [], ref),
      view: (id) => this.cv(id),
      row: (id) => {
        const base = id.split("#")[0];
        const a = this.s.annotations.find((x) => x.id === base);
        if (!a || !("view" in a) || !a.view) return undefined;
        const cv = this.cv(a.view);
        const r = this.rows(a.view, cv?.scale ?? this.provisional).get(id);
        const item = this.dimItems.get(a.view)?.find((x) => x.id === base);
        return r ? { ...r, side: item?.side ?? r.side } : undefined;
      },
    };
    this.annotationCtx = ctx;
    const layouts = layoutSheetAnnotations(this.s.annotations, ctx, this.measures);
    for (const a of this.s.annotations) {
      if (a.type === "table") {
        const start = this.prims.length;
        const t = tables.find((x) => x.a.id === a.id)!;
        this.drawTable(t);
        for (const p of this.prims.slice(start)) {
          p.owner = a.id;
          p.layer ??= "TABLE";
        }
        const text = a.table === "cutList" ? `cut list, ${t.rows.length - 2} item${t.rows.length - 2 === 1 ? "" : "s"}` : `weld table, ${t.rows.length - 2} weld${t.rows.length - 2 === 1 ? "" : "s"}`;
        this.annotations.set(a.id, { id: a.id, type: a.type, text, at: [t.box.min[0], t.box.max[1]], box: t.box });
        continue;
      }
      const l = layouts.get(a.id)!;
      const layer = a.type === "dimension" ? "DIMENSION" : a.type === "centerMark" || a.type === "centerline" ? "CENTER" : a.type === "note" || a.type === "text" ? "TEXT" : "ANNOTATION";
      // A hidden annotation is laid out (what hangs on it still finds it) but not drawn.
      if (a.hidden) {
        this.annotations.set(a.id, { id: a.id, type: a.type, ...("view" in a && a.view ? { view: a.view } : {}), text: l.text, ...(l.value !== undefined ? { value: l.value } : {}), box: null, hidden: true });
        continue;
      }
      for (const p of l.prims) this.prims.push({ ...p, owner: a.id, layer: p.layer ?? layer });
      if (l.problem) this.problems.push(`${a.id}: ${l.problem}`);
      this.annotations.set(a.id, {
        id: a.id,
        type: a.type,
        ...("view" in a && a.view ? { view: a.view } : {}),
        text: l.problem && !l.dangling ? "" : l.text,
        ...(l.value !== undefined ? { value: l.value } : {}),
        ...(l.along ? { along: l.along } : {}),
        ...(l.item !== undefined ? { item: l.item } : {}),
        ...(l.at ? { at: l.at } : {}),
        box: l.problem && !l.dangling ? null : l.box,
        ...(l.problem ? { problem: l.problem } : {}),
        ...(l.dangling ? { dangling: true } : {}),
        ...(l.textBox ? { textBox: l.textBox } : {}),
        grips: l.grips,
        ...(l.place ? { place: l.place } : {}),
      });
    }
  }

  /** What the annotations read from the model: holes, patterns, welds, members, items, properties. */
  private annotationData(): AnnotationData {
    const m = this.ctx.measurements;
    const patterns = new Map<string, { op: string; id: string; count: number }>();
    for (const vf of this.v.features) {
      if (!vf.feature) continue;
      const x = vf.feature as unknown as { op?: string; id: string; features?: unknown; feature?: unknown; count?: unknown; suppressed?: boolean };
      const of = Array.isArray(x.features) ? (x.features as string[]) : typeof x.feature === "string" ? [x.feature] : [];
      if ((x.op === "circularPattern" || x.op === "linearPattern" || x.op === "mirror") && !x.suppressed) for (const id of of) if (!patterns.has(id)) patterns.set(id, { op: x.op, id: x.id, count: typeof x.count === "number" ? x.count : 0 });
    }
    let v2: ReturnType<typeof cutListOf> | null = null;
    const list = () => (v2 ??= m && this.doc ? cutListOf(this.doc, m) : null);
    return {
      holes: this.holes,
      holeCounts: this.holeCounts,
      patterns,
      welds: this.v.welds,
      members: m?.members ?? [],
      bodies: m?.bodies ?? [],
      cutList: this.cut,
      itemOf: (id) => {
        const l = list();
        return l ? itemNumberFor(l, id) : null;
      },
      quantityOf: (item) => list()?.items.find((i) => i.item === item)?.quantity ?? this.cut.find((i) => i.item === item)?.quantity ?? 1,
      props: this.props,
    };
  }

  /** The annotation context the sheet was laid out in (for previews and picks). */
  annotationCtx: AnnotationContext | null = null;

  /** This sheet as composed so far: enough to resolve GeoRefs against its views. */
  private partial(): ComposedSheet {
    return { id: this.s.id, views: this.views, points: this.points } as ComposedSheet;
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
  private placeTables(corners: Record<string, TableCorner> = {}): { a: TableAnnotation; box: Box; rows: string[][]; widths: number[] }[] {
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
      else if (corners[a.id] === "topRight") {
        // Moved to the top right so the views fit larger (below a revision block there).
        const rev = this.format?.revisionBlock;
        const topY = rev && rev.max[1] >= this.frame.max[1] - 1 && rev.max[0] >= this.frame.max[0] - w ? rev.min[1] : this.frame.max[1];
        box = { min: [this.frame.max[0] - w, topY - h], max: [this.frame.max[0], topY] };
        first = false;
      } else if (first) {
        // Above the title block, and above the revision block that grows on it.
        const base = Math.max(this.titleBlock.max[1], this.format?.revisionBlock && this.format.revisionBlock.max[0] > this.frame.max[0] - w ? this.format.revisionBlock.max[1] : -Infinity);
        box = { min: [this.frame.max[0] - w, base], max: [this.frame.max[0], base + h] };
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
    if (!h.through) lines.push(`Ø${fmt(h.diameter)} ⌴${fmt(h.depth)}`);
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

function shiftBox(b: Box, d: Vec2): Box {
  return { min: [b.min[0] + d[0], b.min[1] + d[1]], max: [b.max[0] + d[0], b.max[1] + d[1]] };
}

function shiftView(cv: ComposedView, d: Vec2): ComposedView {
  return { ...cv, centre: [cv.centre[0] + d[0], cv.centre[1] + d[1]], box: cv.box ? shiftBox(cv.box, d) : null };
}

/**
 * True when a view packed close keeps on the sheet (room) with its dimension
 * stacks, and the room kept round it for callouts and symbols is there on at
 * least one side across and one side up and down (they go where there is room).
 */
function roomFor(full: Box, dims: Box, room: Box): boolean {
  if (!inside(dims, room)) return false;
  const out = (i: 0 | 1) => full.min[i] < room.min[i] - 0.01 && full.max[i] > room.max[i] + 0.01;
  return !out(0) && !out(1);
}
