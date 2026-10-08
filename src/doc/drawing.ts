// The drawing in the document (Phase L): what a sheet, a view and an
// annotation may hold, the points a dimension can run between, and how the
// drawing follows the model when a node or feature is renamed.
//
// Validation here is about the drawing itself (fields, ids, the view an
// annotation sits in). What an annotation points at in the model (a member,
// a node, a hole, a weld) is not a validation error: the model can change
// under a drawing, and a dangling annotation is a drawing problem, listed by
// the drawing checks, never a reason to refuse an edit to the part.

import { describe, isObject, type Checker } from "./validate";
import {
  ANNOTATION_KEYS,
  ANNOTATION_TYPES,
  DIMENSION_DIRECTIONS,
  DRAWING_TABLES,
  OUTLINE_SIDES,
  PROJECTIONS,
  SHEET_KEYS,
  SHEET_SIZES,
  VIEW_KEYS,
  VIEW_LOOKS,
  type Annotation,
  type Drawing,
  type DrawingView,
  type Sheet,
} from "./types";

const ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const SCALE = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/;

/** Standard drawing scales, largest first. */
export const STANDARD_SCALES = ["10:1", "5:1", "2:1", "1:1", "1:2", "1:5", "1:10", "1:20", "1:25", "1:50", "1:100", "1:200", "1:500", "1:1000"];

/** "1:10" → 0.1; null when it isn't a scale. */
export function parseScale(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = SCALE.exec(s.trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a > 0 && b > 0 ? a / b : null;
}

export type PointRef =
  | { kind: "side"; side: (typeof OUTLINE_SIDES)[number] }
  | { kind: "end"; member: string; end: "start" | "end" }
  /** A node, or a hole feature: which one is up to the document. */
  | { kind: "name"; name: string };

/** Reads a dimension point; null when it can't be one. */
export function pointRef(p: unknown): PointRef | null {
  if (typeof p !== "string") return null;
  if ((OUTLINE_SIDES as readonly string[]).includes(p)) return { kind: "side", side: p as (typeof OUTLINE_SIDES)[number] };
  const end = /^(.+)\.(start|end)$/.exec(p);
  if (end && ID.test(end[1])) return { kind: "end", member: end[1], end: end[2] as "start" | "end" };
  return ID.test(p) ? { kind: "name", name: p } : null;
}

const POINT_HELP = 'a node ("A"), a member end ("leg_a.start"), a hole ("hole_1") or a side of the view ("@left", "@right", "@top", "@bottom")';

/** Validates the drawing's own structure. Null when anything in it is wrong. */
export function validateDrawing(input: unknown, c: Checker): Drawing | null {
  const before = c.errors.length;
  if (!isObject(input)) {
    c.fail("drawing", `must be a drawing object with sheet, views and annotations (got ${describe(input)})`);
    return null;
  }
  c.keys(input, "drawing", ["sheet", "views", "annotations"]);
  checkSheet(input.sheet, "drawing.sheet", c);
  const ids = new Set<string>();
  const id = (v: unknown, path: string) => {
    if (typeof v !== "string" || !ID.test(v)) c.fail(path, `must be an identifier like "front" or "d1" (got ${describe(v)})`);
    else if (ids.has(v)) c.fail(path, `duplicate id "${v}": views and annotations share their ids`);
    else ids.add(v);
  };
  const views = new Map<string, unknown>();
  if (!Array.isArray(input.views)) c.fail("drawing.views", `must be a list of views (got ${describe(input.views)})`);
  else
    input.views.forEach((v, i) => {
      const at = `drawing.views[${i}]`;
      if (!isObject(v)) return c.fail(at, `must be a view object (got ${describe(v)})`);
      c.keys(v, at, [...VIEW_KEYS]);
      id(v.id, `${at}.id`);
      if (typeof v.id === "string") views.set(v.id, v.look);
      if (!VIEW_LOOKS.includes(v.look as never)) c.fail(`${at}.look`, `must be ${VIEW_LOOKS.map((l) => `"${l}"`).join(", ")} (got ${describe(v.look)})`);
      if (v.at !== undefined) c.vec2(v, "at", at);
      if (v.scale !== undefined && parseScale(v.scale) === null) c.fail(`${at}.scale`, `must be a scale like "1:10" (got ${describe(v.scale)})`);
      if (v.hidden !== undefined && typeof v.hidden !== "boolean") c.fail(`${at}.hidden`, `must be true or false (got ${describe(v.hidden)})`);
    });
  if (!Array.isArray(input.annotations)) c.fail("drawing.annotations", `must be a list of annotations (got ${describe(input.annotations)})`);
  else
    input.annotations.forEach((a, i) => {
      const at = `drawing.annotations[${i}]`;
      if (!isObject(a)) return c.fail(at, `must be an annotation object (got ${describe(a)})`);
      id(a.id, `${at}.id`);
      if (!ANNOTATION_TYPES.includes(a.type as never)) {
        return c.fail(`${at}.type`, `must be ${ANNOTATION_TYPES.map((t) => `"${t}"`).join(", ")} (got ${describe(a.type)})`);
      }
      checkAnnotation(a, at, views, c);
    });
  return c.errors.length === before ? (input as unknown as Drawing) : null;
}

export function checkSheet(s: unknown, path: string, c: Checker): Sheet | null {
  const before = c.errors.length;
  if (!isObject(s)) {
    c.fail(path, `must be a sheet object (got ${describe(s)})`);
    return null;
  }
  c.keys(s, path, [...SHEET_KEYS]);
  if (!(typeof s.size === "string" && s.size in SHEET_SIZES)) c.fail(`${path}.size`, `must be ${Object.keys(SHEET_SIZES).map((k) => `"${k}"`).join(", ")} (got ${describe(s.size)})`);
  if (s.scale !== undefined && parseScale(s.scale) === null) c.fail(`${path}.scale`, `must be a scale like "1:10" (got ${describe(s.scale)})`);
  if (!PROJECTIONS.includes(s.projection as never)) c.fail(`${path}.projection`, `must be "third" or "first" (got ${describe(s.projection)})`);
  for (const k of ["title", "number", "revision", "drawnBy", "date"] as const) {
    if (s[k] !== undefined && typeof s[k] !== "string") c.fail(`${path}.${k}`, `must be text (got ${describe(s[k])})`);
  }
  return c.errors.length === before ? (s as unknown as Sheet) : null;
}

function checkAnnotation(a: Record<string, unknown>, at: string, views: Map<string, unknown>, c: Checker): void {
  const type = a.type as Annotation["type"];
  c.keys(a, at, [...ANNOTATION_KEYS[type]]);
  if (type !== "table" && type !== "note") {
    if (typeof a.view !== "string" || !views.has(a.view)) c.fail(`${at}.view`, `no view ${describe(a.view)} (views: ${[...views.keys()].join(", ") || "none"})`);
    else if (type === "dimension" && views.get(a.view) === "iso") {
      c.fail(`${at}.view`, `${a.view} is an iso view, which shortens every length: dimension in a view that looks square at the part`);
    }
  }
  const named = (key: string, what: string) => {
    if (typeof a[key] !== "string" || !ID.test(a[key] as string)) c.fail(`${at}.${key}`, `must name ${what} (got ${describe(a[key])})`);
  };
  switch (type) {
    case "dimension": {
      const between = a.from !== undefined || a.to !== undefined;
      if (a.member !== undefined) {
        named("member", "a member");
        if (between) c.fail(at, "a dimension is either between two points (from, to) or along a member, not both");
        if (a.direction !== undefined && a.direction !== "aligned") c.fail(`${at}.direction`, `a member's length is dimensioned along it (got ${describe(a.direction)})`);
      } else {
        for (const k of ["from", "to"] as const) if (!pointRef(a[k])) c.fail(`${at}.${k}`, `must be ${POINT_HELP} (got ${describe(a[k])})`);
        if (typeof a.from === "string" && a.from === a.to) c.fail(at, `runs from ${a.from} to itself`);
      }
      if (a.direction !== undefined && !DIMENSION_DIRECTIONS.includes(a.direction as never)) {
        c.fail(`${at}.direction`, `must be "horizontal", "vertical" or "aligned" (got ${describe(a.direction)})`);
      }
      if (a.offset !== undefined) c.num(a, "offset", at, {});
      break;
    }
    case "hole":
      named("hole", "a hole feature");
      if (a.at !== undefined) c.vec2(a, "at", at);
      break;
    case "balloon":
      named("member", "a member");
      if (a.at !== undefined) c.vec2(a, "at", at);
      break;
    case "weld":
      named("weld", "a weld in the weld table");
      if (a.at !== undefined) c.vec2(a, "at", at);
      break;
    case "table":
      if (!DRAWING_TABLES.includes(a.table as never)) c.fail(`${at}.table`, `must be "cutList" or "welds" (got ${describe(a.table)})`);
      if (a.at !== undefined) c.vec2(a, "at", at);
      break;
    case "note":
      if (typeof a.text !== "string" || !a.text.trim()) c.fail(`${at}.text`, `must be the note's text (got ${describe(a.text)})`);
      c.vec2(a, "at", at);
      break;
  }
}

/** What the model holds that a drawing can point at, from the raw document. */
export interface DrawingTargets {
  nodes: Set<string>;
  members: Set<string>;
  holes: Set<string>;
  welds: Set<string>;
}

export function drawingTargets(doc: Record<string, unknown>): DrawingTargets {
  const features = Array.isArray(doc.features) ? doc.features.filter(isObject) : [];
  const ids = (op: string) => new Set(features.filter((f) => f.op === op && !f.suppressed && typeof f.id === "string").map((f) => f.id as string));
  return {
    nodes: new Set(isObject(doc.nodes) ? Object.keys(doc.nodes) : []),
    members: ids("member"),
    holes: ids("hole"),
    welds: new Set(Array.isArray(doc.welds) ? doc.welds.filter(isObject).map((w) => String(w.id)) : []),
  };
}

/** Null when everything the annotation points at is in the model, else what is missing. */
export function annotationTargetProblem(a: Annotation, t: DrawingTargets): string | null {
  const member = (id: string) => (t.members.has(id) ? null : `no member "${id}"${list(t.members)}`);
  switch (a.type) {
    case "dimension": {
      if (a.member !== undefined) return member(a.member);
      for (const p of [a.from, a.to]) {
        const r = pointRef(p);
        if (!r || r.kind === "side") continue;
        if (r.kind === "end") {
          const problem = member(r.member);
          if (problem) return problem;
        } else if (!t.nodes.has(r.name) && !t.holes.has(r.name)) {
          return `no node or hole "${r.name}"${list(new Set([...t.nodes, ...t.holes]))}`;
        }
      }
      return null;
    }
    case "hole":
      return t.holes.has(a.hole) ? null : `no hole "${a.hole}"${list(t.holes)}`;
    case "balloon":
      return member(a.member);
    case "weld":
      return t.welds.has(a.weld) ? null : `no weld "${a.weld}" in the weld table${list(t.welds)}`;
    default:
      return null;
  }
}

function list(names: Set<string>): string {
  return names.size ? ` (there are ${[...names].slice(0, 12).join(", ")}${names.size > 12 ? ", ..." : ""})` : "";
}

/** The raw drawing, when the document has one that is an object. */
export function rawDrawing(doc: Record<string, unknown>): { sheet: unknown; views: Record<string, unknown>[]; annotations: Record<string, unknown>[] } | null {
  const d = doc.drawing;
  if (!isObject(d)) return null;
  return { sheet: d.sheet, views: Array.isArray(d.views) ? d.views.filter(isObject) : [], annotations: Array.isArray(d.annotations) ? d.annotations.filter(isObject) : [] };
}

/**
 * A renamed node or feature, on the sheet: the dimensions, callouts and
 * balloons that name it follow. Returns the new drawing, or the same one when
 * nothing named it.
 */
export function renameInDrawing(drawing: unknown, kind: "node" | "feature" | "weld", from: string, to: string): unknown {
  if (!isObject(drawing) || !Array.isArray(drawing.annotations)) return drawing;
  const point = (p: unknown): unknown => {
    const r = pointRef(p);
    if (!r) return p;
    if (r.kind === "name" && r.name === from && kind !== "weld") return to;
    if (r.kind === "end" && r.member === from && kind === "feature") return `${to}.${r.end}`;
    return p;
  };
  let changed = false;
  const annotations = drawing.annotations.map((a) => {
    if (!isObject(a)) return a;
    const next = { ...a };
    if (kind === "feature") {
      if (next.member === from) next.member = to;
      if (next.hole === from) next.hole = to;
    }
    if (kind === "weld" && next.weld === from) next.weld = to;
    if (next.from !== undefined) next.from = point(next.from);
    if (next.to !== undefined) next.to = point(next.to);
    if (JSON.stringify(next) !== JSON.stringify(a)) changed = true;
    return next;
  });
  return changed ? { ...drawing, annotations } : drawing;
}

/** The annotations that sit in a view. */
export function viewAnnotations(drawing: Drawing, view: string): Annotation[] {
  return drawing.annotations.filter((a) => "view" in a && a.view === view);
}

export type { Drawing, DrawingView };

/**
 * The document as the kernel sees it: everything but the drawing. Two
 * documents with the same key rebuild to the same part, so a change to the
 * sheet never rebuilds the model.
 */
export function geometryKey(doc: unknown): string {
  if (!isObject(doc) || doc.drawing === undefined) return JSON.stringify(doc);
  const { drawing: _drawing, ...rest } = doc;
  return JSON.stringify(rest);
}
