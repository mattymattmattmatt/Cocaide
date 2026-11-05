// Annotation kinds in the sheet editor (Phase Q wave Q2B): for each kind,
// its name and icon in the tree, its property schema (the panel is drawn
// from it), and how it moves when dragged on the sheet — what a drag of the
// whole thing, or of one of its grips, writes into it. The kinds the drawing
// has today are registered here; a later wave registers its new kinds (and
// may replace these) with registerAnnotationKind, and the tree, the panel,
// drag, copy and paste pick them up.

import { STANDARD_SCALES } from "../../../doc/drawing";
import { DIMENSION_DIRECTIONS, OUTLINE_SIDES, type Vec2 } from "../../../doc/types";
import { validateDocument } from "../../../doc/validate";
import type { ComposedAnnotation, ComposedSheet } from "../../../drafting/compose";
import type { ReactNode } from "react";
import type { MenuEntry } from "../../ContextMenu";
import type { IconName } from "../../icons";
import { tenth } from "../align";
import type { DrawingToolCtx } from "./types";
import type { Choice, PropSchema, SchemaEnv } from "./schema";

/** A handle on a selected annotation: dragging it changes one thing (a dimension line's distance). */
export interface Grip {
  id: string;
  /** Where it is drawn, sheet mm. */
  at: Vec2;
  /** It moves along this sheet direction only (unit), or anywhere. */
  along?: Vec2;
  label: string;
  /** A click on it (no drag) acts: dragGrip is called with no movement (an arrowhead flips the arrows). */
  click?: boolean;
}

/** What a kind's drag and grips may read: the sheet as composed, and the annotation as composed. */
export interface KindCtx {
  sheet: ComposedSheet;
  said?: ComposedAnnotation;
}

export interface AnnotationKindDef {
  type: string;
  label: string;
  icon: IconName;
  schema: PropSchema;
  /** Its words in the tree, after its id ("dimension 860"). */
  describe?(a: Record<string, unknown>, said?: ComposedAnnotation): string;
  /** The patch a drag of the whole annotation by `delta` (sheet mm) writes, or null when it stays put (it follows its geometry). */
  move?(a: Record<string, unknown>, delta: Vec2, ctx: KindCtx): Record<string, unknown> | null;
  grips?(a: Record<string, unknown>, ctx: KindCtx): Grip[];
  dragGrip?(a: Record<string, unknown>, grip: Grip, delta: Vec2, ctx: KindCtx): Record<string, unknown> | null;
  /** A copy, pasted `offset` away (the caller gives it a new id); default: the same, moved where it can be. */
  paste?(a: Record<string, unknown>, offset: Vec2, ctx: KindCtx): Record<string, unknown>;
  /** The prefix of a new one's id ("d" → d4). */
  prefix: string;
  /** Its own property panel, drawn above the schema's fields (which then fold under "All properties"). */
  panel?(p: KindPanelProps): ReactNode;
  /** Its entries in the right-click menu, before Copy. */
  menu?(a: Record<string, unknown>, ctx: DrawingToolCtx, said?: ComposedAnnotation): MenuEntry[];
}

/** What a kind's own panel is given: the annotation as stored and as composed, and how to change it. */
export interface KindPanelProps {
  a: Record<string, unknown>;
  said?: ComposedAnnotation;
  env: SchemaEnv;
  /** A patch (null removes a key), one undo step; the error when refused. */
  write(patch: Record<string, unknown>): string | null;
  ctx: () => DrawingToolCtx;
}

const kinds = new Map<string, AnnotationKindDef>();

export function registerAnnotationKind(def: AnnotationKindDef): void {
  kinds.set(def.type, def);
}

export function annotationKind(type: string): AnnotationKindDef | undefined {
  return kinds.get(type);
}

export function annotationKinds(): AnnotationKindDef[] {
  return [...kinds.values()];
}

// ------------------------------------------------------------- choices

const viewChoices = (env: SchemaEnv): Choice[] => env.sheetDoc.views.map((v) => ({ value: v.id, label: v.id }));

/** Points a dimension can run from or to: the view's sides, nodes, member ends, holes; a GeoRef is typed or picked. */
function pointChoices(env: SchemaEnv, a: Record<string, unknown>): Choice[] {
  const v = validateDocument(env.doc);
  const feats = (op: string) => v.features.flatMap((f) => (f.feature?.op === op && !f.feature.suppressed ? [f.feature.id] : []));
  const out: Choice[] = [
    ...OUTLINE_SIDES.map((s) => ({ value: s, label: `${s.slice(1)} of the view` })),
    ...Object.keys(v.nodes).map((n) => ({ value: n, label: `node ${n}` })),
    ...feats("member").flatMap((m) => [
      { value: `${m}.start`, label: `${m} start` },
      { value: `${m}.end`, label: `${m} end` },
    ]),
    ...feats("hole").map((h) => ({ value: h, label: `hole ${h}` })),
  ];
  for (const k of ["from", "to"]) {
    const cur = a[k];
    if (typeof cur === "string" && !out.some((c) => c.value === cur)) out.unshift({ value: cur, label: cur });
  }
  return out;
}

const memberChoices = (env: SchemaEnv, a: Record<string, unknown>): Choice[] => {
  const ids = validateDocument(env.doc).features.flatMap((f) => (f.feature?.op === "member" && !f.feature.suppressed ? [f.feature.id] : []));
  const cur = typeof a.member === "string" && !ids.includes(a.member) ? [a.member] : [];
  return [...ids, ...cur].map((m) => ({ value: m, label: m }));
};
const holeChoices = (env: SchemaEnv): Choice[] => validateDocument(env.doc).features.flatMap((f) => (f.feature?.op === "hole" && !f.feature.suppressed ? [{ value: f.feature.id, label: f.feature.id }] : []));
const weldChoices = (env: SchemaEnv): Choice[] => validateDocument(env.doc).welds.map((w) => ({ value: w.id, label: `${w.id}: ${w.type} ${w.size} mm` }));

/** The scale list a view's scale picks from. */
export const SCALE_CHOICES: Choice[] = STANDARD_SCALES.map((s) => ({ value: s, label: s }));

// ------------------------------------------------------------- moves

/** Annotations held from their view's centre (balloons, callouts, weld symbols): a drag moves `at`, made from where it is drawn now. */
function moveFromView(a: Record<string, unknown>, delta: Vec2, ctx: KindCtx): Record<string, unknown> | null {
  const placed = ctx.said?.at;
  const cv = ctx.sheet.views.find((v) => v.id === a.view);
  if (!placed || !cv) return null;
  return { at: [tenth(placed[0] + delta[0] - cv.centre[0]), tenth(placed[1] + delta[1] - cv.centre[1])] };
}

/** Annotations held on the sheet (notes, the Phase L tables): `at` moves by the drag. */
function moveOnSheet(a: Record<string, unknown>, delta: Vec2, ctx: KindCtx): Record<string, unknown> | null {
  const placed = (ctx.said?.at ?? a.at) as Vec2 | undefined;
  if (!placed) return null;
  return { at: [tenth(placed[0] + delta[0]), tenth(placed[1] + delta[1])] };
}

/**
 * A dimension's line as drawn: horizontal ("h"), vertical ("v") or aligned,
 * and where it is. The extension lines are the pair of parallel lines; the
 * dimension line is the one across them (alone, when they were too short to draw).
 */
export function dimensionLine(sheet: ComposedSheet, id: string): { dir: "h" | "v" | "a"; level: number; a: Vec2; b: Vec2 } | null {
  const lines = sheet.prims.filter((p): p is Extract<typeof p, { k: "line" }> => p.k === "line" && p.owner === id && !p.fill && p.pts.length === 2);
  if (!lines.length) return null;
  const orient = (l: (typeof lines)[number]) => {
    const [p, q] = l.pts;
    if (Math.abs(p[1] - q[1]) < 1e-6) return "h";
    if (Math.abs(p[0] - q[0]) < 1e-6) return "v";
    return "a";
  };
  const by = { h: lines.filter((l) => orient(l) === "h"), v: lines.filter((l) => orient(l) === "v"), a: lines.filter((l) => orient(l) === "a") };
  let dir: "h" | "v";
  if (by.h.length === 1 && by.v.length !== 1) dir = "h";
  else if (by.v.length === 1 && by.h.length !== 1) dir = "v";
  else if (by.h.length && !by.v.length) dir = "h";
  else if (by.v.length && !by.h.length) dir = "v";
  else dir = by.h.length <= by.v.length ? "h" : "v";
  const pick = by[dir].length ? by[dir][0] : [...lines].sort((x, y) => len(y) - len(x))[0];
  const [a, b] = pick.pts;
  return { dir: by[dir].length ? dir : "a", level: dir === "h" ? a[1] : a[0], a, b };
}

function len(l: { pts: Vec2[] }): number {
  return Math.hypot(l.pts[1][0] - l.pts[0][0], l.pts[1][1] - l.pts[0][1]);
}

/** A dimension's offset for its line at `level` (sheet mm across the view): + above or right of the view, − below or left; at least 4 mm off it. */
export function offsetFor(dir: "h" | "v", level: number, view: { min: Vec2; max: Vec2 }): number {
  const ax = dir === "h" ? 1 : 0;
  const lo = view.min[ax];
  const hi = view.max[ax];
  if (level >= hi) return tenth(Math.max(4, level - hi));
  if (level <= lo) return tenth(-Math.max(4, lo - level));
  // Inside the view: to the nearer side.
  return level - lo < hi - level ? -4 : 4;
}

function moveDimension(a: Record<string, unknown>, delta: Vec2, ctx: KindCtx): Record<string, unknown> | null {
  const line = dimensionLine(ctx.sheet, String(a.id));
  const cv = ctx.sheet.views.find((v) => v.id === a.view);
  if (!line || !cv?.box) return null;
  if (line.dir === "a") {
    // Along the normal away from the view: the distance grows by the drag across the line.
    const u: Vec2 = [line.b[0] - line.a[0], line.b[1] - line.a[1]];
    const l = Math.hypot(u[0], u[1]) || 1;
    let n: Vec2 = [-u[1] / l, u[0] / l];
    const mid: Vec2 = [(line.a[0] + line.b[0]) / 2, (line.a[1] + line.b[1]) / 2];
    if ((mid[0] - cv.centre[0]) * n[0] + (mid[1] - cv.centre[1]) * n[1] < 0) n = [-n[0], -n[1]];
    const now = typeof a.offset === "number" ? Math.abs(a.offset) : 10;
    return { offset: tenth(Math.max(4, now + delta[0] * n[0] + delta[1] * n[1])) };
  }
  return { offset: offsetFor(line.dir, line.level + (line.dir === "h" ? delta[1] : delta[0]), cv.box) };
}

function dimensionGrips(a: Record<string, unknown>, ctx: KindCtx): Grip[] {
  const line = dimensionLine(ctx.sheet, String(a.id));
  if (!line) return [];
  const mid: Vec2 = [(line.a[0] + line.b[0]) / 2, (line.a[1] + line.b[1]) / 2];
  const along: Vec2 | undefined = line.dir === "h" ? [0, 1] : line.dir === "v" ? [1, 0] : undefined;
  return [{ id: "offset", at: mid, ...(along ? { along } : {}), label: "Drag the dimension line nearer or further" }];
}

const atGrip = (_a: Record<string, unknown>, ctx: KindCtx): Grip[] => (ctx.said?.at ? [{ id: "at", at: ctx.said.at, label: "Drag to move it" }] : []);

// ------------------------------------------------------------- the kinds of today

const view = { key: "view", label: "View", kind: "select", options: viewChoices } as const;

registerAnnotationKind({
  type: "dimension",
  label: "Dimension",
  icon: "dimension",
  prefix: "d",
  schema: {
    fields: [
      view,
      { key: "member", label: "Member", kind: "select", options: memberChoices, when: (a) => a.member !== undefined },
      { key: "from", label: "From", kind: "ref", options: pointChoices, picks: ["vertex", "centre", "midpoint", "quadrant"], when: (a) => a.member === undefined },
      { key: "to", label: "To", kind: "ref", options: pointChoices, picks: ["vertex", "centre", "midpoint", "quadrant"], when: (a) => a.member === undefined },
      { key: "direction", label: "Direction", kind: "select", options: DIMENSION_DIRECTIONS, optional: true, placeholder: "automatic", when: (a) => a.member === undefined },
      { key: "offset", label: "Offset", kind: "number", optional: true, placeholder: "automatic", help: "Sheet mm from the part to the dimension line; + above or right, − below or left" },
    ],
  },
  describe: (_a, said) => `dimension ${said?.text ?? ""}`.trim(),
  move: moveDimension,
  grips: dimensionGrips,
  dragGrip: (a, _g, delta, ctx) => moveDimension(a, delta, ctx),
});

registerAnnotationKind({
  type: "hole",
  label: "Hole callout",
  icon: "hole",
  prefix: "h",
  schema: { fields: [view, { key: "hole", label: "Hole", kind: "select", options: holeChoices }, { key: "at", label: "Text at", kind: "vec2", optional: true, placeholder: "beside the hole", help: "From the view's centre, sheet mm" }] },
  describe: (_a, said) => `hole ${said?.text ?? ""}`.trim(),
  move: moveFromView,
  grips: atGrip,
  dragGrip: (a, _g, d, ctx) => moveFromView(a, d, ctx),
});

registerAnnotationKind({
  type: "balloon",
  label: "Balloon",
  icon: "balloon",
  prefix: "b",
  schema: { fields: [view, { key: "member", label: "Member", kind: "select", options: memberChoices }, { key: "at", label: "Balloon at", kind: "vec2", optional: true, placeholder: "outside the view", help: "From the view's centre, sheet mm" }] },
  describe: (_a, said) => `balloon ${said?.text ?? ""}`.trim(),
  move: moveFromView,
  grips: atGrip,
  dragGrip: (a, _g, d, ctx) => moveFromView(a, d, ctx),
});

registerAnnotationKind({
  type: "weld",
  label: "Weld symbol",
  icon: "joint",
  prefix: "w",
  schema: { fields: [view, { key: "weld", label: "Weld", kind: "select", options: weldChoices }, { key: "at", label: "Symbol at", kind: "vec2", optional: true, placeholder: "beside the joint" }] },
  describe: (_a, said) => `weld ${said?.text ?? ""}`.trim(),
  move: moveFromView,
  grips: atGrip,
  dragGrip: (a, _g, d, ctx) => moveFromView(a, d, ctx),
});

registerAnnotationKind({
  type: "note",
  label: "Note",
  icon: "note",
  prefix: "n",
  schema: { fields: [{ key: "text", label: "Text", kind: "textarea", help: 'Links: $PRP:"name" a drawing or part property, $PRPMODEL:"mass", $PRPSHEET:"scale"' }, { key: "at", label: "At", kind: "vec2", help: "Its first line's start on the sheet, mm from the lower left" }] },
  describe: (a, said) => `note ${said?.text ?? String(a.text ?? "")}`.trim().slice(0, 60),
  move: moveOnSheet,
  grips: (a) => (Array.isArray(a.at) ? [{ id: "at", at: a.at as Vec2, label: "Drag to move it" }] : []),
  dragGrip: (a, _g, d, ctx) => moveOnSheet(a, d, ctx),
  paste: (a, offset) => ({ ...a, at: Array.isArray(a.at) ? [tenth((a.at as Vec2)[0] + offset[0]), tenth((a.at as Vec2)[1] + offset[1])] : a.at }),
});

registerAnnotationKind({
  type: "table",
  label: "Table (classic)",
  icon: "grid",
  prefix: "t",
  schema: { fields: [{ key: "table", label: "Table", kind: "select", options: ["cutList", "welds"] }, { key: "at", label: "At", kind: "vec2", optional: true, placeholder: "above the title block" }] },
  describe: (a) => `table ${String(a.table ?? "")}`,
  move: moveOnSheet,
});

registerAnnotationKind({
  type: "centerMark",
  label: "Centre mark",
  icon: "plus",
  prefix: "c",
  schema: { fields: [view, { key: "at", label: "Circle", kind: "ref", picks: ["circle", "arc", "centre"] }, { key: "extend", label: "Past the circle", kind: "number", optional: true, positive: true, placeholder: "2.5" }] },
  describe: (a) => `centre mark ${String(a.at ?? "").split(":")[1]?.slice(1) ?? ""}`.trim(),
});

registerAnnotationKind({
  type: "centerline",
  label: "Centreline",
  icon: "centerline",
  prefix: "c",
  schema: {
    fields: [
      view,
      { key: "between.0", label: "From", kind: "ref", picks: ["edge", "centre"] },
      { key: "between.1", label: "To", kind: "ref", picks: ["edge", "centre"] },
      { key: "extend", label: "Past the ends", kind: "number", optional: true, positive: true, placeholder: "2.5" },
    ],
  },
  describe: () => "centreline",
});
