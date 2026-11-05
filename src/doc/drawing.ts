// The drawing in the document (Phase L, sheets and view kinds in Phase Q):
// what a drawing, a sheet, a view and an annotation may hold, the points a
// dimension can run between, the geometry references (GeoRefs) annotations
// attach to, how a Phase L drawing is read as one sheet, and how the drawing
// follows the model when a node or feature is renamed.
//
// Validation here is about the drawing itself (fields, ids, the view an
// annotation sits in, a view's parent). What an annotation points at in the
// model (a member, a node, a hole, a weld, an edge) is not a validation error:
// the model can change under a drawing, and a dangling annotation is a drawing
// problem, listed by the drawing checks, never a reason to refuse an edit to
// the part.

import { describe, isObject, validateDocument, type Checker } from "./validate";
import { checkDrawingTables } from "../drafting/tables/validate";
import { toleranceProblem } from "../drafting/tolerance";
import { GDT_CHARACTERISTICS } from "../drafting/symbols/glyphs";
import {
  ANNOTATION_KEYS,
  ANNOTATION_TYPES,
  ARROW_PLACES,
  ARROW_STYLES,
  BALLOON_SHAPES,
  DIMENSION_KINDS,
  GDT_MODIFIERS,
  GDT_ROW_KEYS,
  LAY_SYMBOLS,
  SKETCH_LINES,
  SURFACE_SYMBOLS,
  VIEW_ANNOTATIONS,
  WELD_CONTOURS,
  WELD_SIDE_KEYS,
  WELD_SYMBOLS,
  BREAK_KEYS,
  DETAIL_STYLES,
  DIMENSION_DIRECTIONS,
  DISPLAY_MODES,
  DRAFTING_STANDARDS,
  DRAWING_KEYS,
  DRAWING_TABLES,
  FORMAT_KEYS,
  HATCH_KEYS,
  HATCH_PATTERNS,
  OUTLINE_SIDES,
  PROJECT_DIRECTIONS,
  PROJECTIONS,
  REVISION_KEYS,
  SHEET_KEYS,
  SHEET_ORIENTATIONS,
  SHEET_SIZES,
  SHEET_TEMPLATES,
  TANGENT_MODES,
  TITLE_FIELDS,
  VIEW_KINDS,
  VIEW_KEYS,
  VIEW_LOOKS,
  type Annotation,
  type Drawing,
  type DrawingSheet,
  type DrawingView,
  type ViewKind,
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

// ------------------------------------------------------------ geometry references

/**
 * An edge's key in a view: the feature that made the model edge, then what it
 * is and its place among that feature's edges of the kind: "extrude_1/l3" (a
 * straight edge), "hole_1/c0" (a circle or arc), "sweep_1/o2" (another curve),
 * "revolve_1/s0a" (a side of a round face seen from the side, a or b), "?/l4"
 * (an edge no feature is recorded for). The kernel makes them
 * (src/kernel/drawingViews.ts).
 */
export const EDGE_KEY = /^[A-Za-z0-9_?-]+\/[a-z]\d+[ab]?$/;

export type GeoRefParts =
  | { view: string; form: "e" | "c" | "m"; key: string }
  | { view: string; form: "v"; key: string; end: 0 | 1 }
  | { view: string; form: "q"; key: string; quadrant: 0 | 1 | 2 | 3 }
  /** A Phase L point in the view: a node, a member end, a hole, a side of the outline. */
  | { view: string; form: "point"; point: PointRef };

/** Reads a GeoRef ("front:eextrude_1/l3", "front:vhole_1/c0.1", "front:A"); null when it isn't one. */
export function parseGeoRef(ref: unknown): GeoRefParts | null {
  if (typeof ref !== "string") return null;
  const colon = ref.indexOf(":");
  if (colon <= 0) return null;
  const view = ref.slice(0, colon);
  if (!ID.test(view)) return null;
  const rest = ref.slice(colon + 1);
  const form = rest[0];
  const body = rest.slice(1);
  if ((form === "e" || form === "c" || form === "m") && EDGE_KEY.test(body)) return { view, form, key: body };
  const dotted = /^(.+)\.(\d)$/.exec(body);
  if (dotted && EDGE_KEY.test(dotted[1])) {
    const n = Number(dotted[2]);
    if (form === "v" && n <= 1) return { view, form, key: dotted[1], end: n as 0 | 1 };
    if (form === "q" && n <= 3) return { view, form, key: dotted[1], quadrant: n as 0 | 1 | 2 | 3 };
  }
  const point = pointRef(rest, false);
  return point ? { view, form: "point", point } : null;
}

export const GEOREF_HELP =
  'a view\'s geometry: "<view>:e<edge>" an edge, "<view>:v<edge>.0" or ".1" an end of it, "<view>:c<edge>" a circle\'s centre, "<view>:m<edge>" a midpoint, "<view>:q<edge>.0"–".3" a quadrant (edges as the view lists them, like "extrude_1/l3"), or "<view>:A" a node, member end, hole or @side';

export type PointRef =
  | { kind: "side"; side: (typeof OUTLINE_SIDES)[number] }
  | { kind: "end"; member: string; end: "start" | "end" }
  /** A node, or a hole feature: which one is up to the document. */
  | { kind: "name"; name: string }
  /** A point of the view's own geometry (a GeoRef: an edge's end, a circle's centre ...). */
  | { kind: "geo"; ref: string };

/** Reads a dimension point; null when it can't be one. */
export function pointRef(p: unknown, geo = true): PointRef | null {
  if (typeof p !== "string") return null;
  if ((OUTLINE_SIDES as readonly string[]).includes(p)) return { kind: "side", side: p as (typeof OUTLINE_SIDES)[number] };
  if (geo && p.includes(":")) {
    const g = parseGeoRef(p);
    return g && g.form !== "point" && g.form !== "e" ? { kind: "geo", ref: p } : null;
  }
  const end = /^(.+)\.(start|end)$/.exec(p);
  if (end && ID.test(end[1])) return { kind: "end", member: end[1], end: end[2] as "start" | "end" };
  return ID.test(p) ? { kind: "name", name: p } : null;
}

const POINT_HELP =
  'a node ("A"), a member end ("leg_a.start"), a hole ("hole_1"), a side of the view ("@left", "@right", "@top", "@bottom") or a point of the view\'s geometry ("front:vextrude_1/l3.0", "front:chole_1/c0")';

// ------------------------------------------------------------ migration

/** True for a Phase L drawing: one sheet, as { sheet, views, annotations }. */
export function isLegacyDrawing(d: unknown): boolean {
  return isObject(d) && d.sheets === undefined && (d.sheet !== undefined || d.views !== undefined || d.annotations !== undefined);
}

/** The id the first sheet of a migrated Phase L drawing gets. */
export const FIRST_SHEET = "sheet1";

/**
 * A Phase L drawing read as a Phase Q one: its sheet becomes the first sheet
 * (its title block fields move into the format, with the "classic" template
 * so it looks as it did), its views and annotations go on it. A drawing that
 * is already Phase Q is returned as it is. Pure: whatever is wrong in it is
 * left for validation to say.
 */
export function migrateDrawing(d: unknown): unknown {
  if (!isLegacyDrawing(d)) return d;
  const old = d as Record<string, unknown>;
  const s = isObject(old.sheet) ? old.sheet : {};
  const format: Record<string, unknown> = { template: "classic" };
  for (const [k, v] of Object.entries(s)) if (k !== "scale" && k !== "projection") format[k] = v;
  if (format.size === undefined && s.size === undefined) format.size = "A3";
  const sheet: Record<string, unknown> = {
    id: FIRST_SHEET,
    format,
    ...(s.scale !== undefined ? { scale: s.scale } : {}),
    projection: s.projection ?? "third",
    views: Array.isArray(old.views) ? old.views.map(migrateView) : old.views,
    annotations: old.annotations ?? [],
  };
  if (!isObject(old.sheet) && old.sheet !== undefined) sheet.format = old.sheet;
  const { sheet: _s, views: _v, annotations: _a, ...rest } = old;
  return { ...rest, sheets: [sheet] };
}

/** A Phase L view read as a Phase Q one: `hidden: true` is display "hidden". */
export function migrateView(v: unknown): unknown {
  if (!isObject(v) || v.hidden === undefined) return v;
  const { hidden, ...rest } = v;
  if (hidden === true && rest.display === undefined) return { ...rest, display: "hidden" };
  if (hidden === false) return rest;
  return v;
}

// ------------------------------------------------------------ validation

/** Validates the drawing's own structure (a Phase L one as migrated). Null when anything in it is wrong. */
export function validateDrawing(raw: unknown, c: Checker): Drawing | null {
  const before = c.errors.length;
  const input = migrateDrawing(raw);
  if (!isObject(input)) {
    c.fail("drawing", `must be a drawing object with sheets (got ${describe(input)})`);
    return null;
  }
  c.keys(input, "drawing", [...DRAWING_KEYS]);
  if (input.standard !== undefined && !DRAFTING_STANDARDS.includes(input.standard as never)) c.fail("drawing.standard", `must be "ISO" or "ASME" (got ${describe(input.standard)})`);
  if (input.units !== undefined && input.units !== "mm" && input.units !== "in") c.fail("drawing.units", `must be "mm" or "in" (got ${describe(input.units)})`);
  if (input.generalTolerance !== undefined) text(input.generalTolerance, "drawing.generalTolerance", c, 200);
  if (input.precision !== undefined && (!Number.isInteger(input.precision) || (input.precision as number) < 0 || (input.precision as number) > 6)) c.fail("drawing.precision", `is the decimal places dimensions are written to, 0 to 6 (got ${describe(input.precision)})`);
  if (input.dualUnits !== undefined && typeof input.dualUnits !== "boolean") c.fail("drawing.dualUnits", `must be true or false (got ${describe(input.dualUnits)})`);
  if (input.properties !== undefined) {
    if (!isObject(input.properties)) c.fail("drawing.properties", `must be an object of names to text (got ${describe(input.properties)})`);
    else
      for (const [k, v] of Object.entries(input.properties)) {
        if (!/^[A-Za-z][A-Za-z0-9 _-]{0,59}$/.test(k)) c.fail(`drawing.properties`, `"${k}" is not a property name: letters, digits, spaces, _ and -, starting with a letter, up to 60`);
        text(v, `drawing.properties.${k}`, c, 500);
      }
  }
  if (input.revisions !== undefined) {
    if (!Array.isArray(input.revisions)) c.fail("drawing.revisions", `must be a list of revisions (got ${describe(input.revisions)})`);
    else
      input.revisions.forEach((r, i) => {
        const at = `drawing.revisions[${i}]`;
        if (!isObject(r)) return c.fail(at, `must be a revision { rev, description, date, by, approved, zone } (got ${describe(r)})`);
        c.keys(r, at, [...REVISION_KEYS]);
        if (typeof r.rev !== "string" || !r.rev.trim() || r.rev.length > 10) c.fail(`${at}.rev`, `must be the revision's letter or number, up to 10 characters (got ${describe(r.rev)})`);
        for (const k of ["description", "date", "by", "approved", "zone"] as const) if (r[k] !== undefined) text(r[k], `${at}.${k}`, c, 300);
      });
  }
  if (!Array.isArray(input.sheets) || input.sheets.length === 0) {
    c.fail("drawing.sheets", `must be a list of one or more sheets (got ${describe(input.sheets)})`);
    return null;
  }

  // Ids are unique across the whole drawing: a view or an annotation is found by its id alone.
  const ids = new Set<string>();
  const id = (v: unknown, path: string, what = "views and annotations share their ids") => {
    if (typeof v !== "string" || !ID.test(v)) c.fail(path, `must be an identifier like "front" or "d1" (got ${describe(v)})`);
    else if (ids.has(v)) c.fail(path, `duplicate id "${v}": ${what}`);
    else ids.add(v);
  };
  const sheetIds = new Set<string>();
  /** Every view, by id: its raw object and the sheet it is on. */
  const views = new Map<string, { v: Record<string, unknown>; sheet: number; path: string }>();
  /** Every view object, a duplicate id's too: each is checked. */
  const checked: { v: Record<string, unknown>; path: string }[] = [];
  input.sheets.forEach((s, si) => {
    const sp = `drawing.sheets[${si}]`;
    if (!isObject(s)) return c.fail(sp, `must be a sheet object (got ${describe(s)})`);
    c.keys(s, sp, [...SHEET_KEYS]);
    if (typeof s.id !== "string" || !ID.test(s.id)) c.fail(`${sp}.id`, `must be an identifier like "sheet1" (got ${describe(s.id)})`);
    else if (sheetIds.has(s.id)) c.fail(`${sp}.id`, `duplicate sheet id "${s.id}"`);
    else sheetIds.add(s.id);
    if (s.name !== undefined) text(s.name, `${sp}.name`, c, 60);
    checkFormat(s.format, `${sp}.format`, c);
    if (s.scale !== undefined && parseScale(s.scale) === null) c.fail(`${sp}.scale`, `must be a scale like "1:10" (got ${describe(s.scale)})`);
    if (!PROJECTIONS.includes(s.projection as never)) c.fail(`${sp}.projection`, `must be "third" or "first" (got ${describe(s.projection)})`);
    if (!Array.isArray(s.views)) c.fail(`${sp}.views`, `must be a list of views (got ${describe(s.views)})`);
    else
      s.views.forEach((v, i) => {
        const at = `${sp}.views[${i}]`;
        if (!isObject(v)) return c.fail(at, `must be a view object (got ${describe(v)})`);
        id(v.id, `${at}.id`);
        checked.push({ v, path: at });
        if (typeof v.id === "string" && !views.has(v.id)) views.set(v.id, { v, sheet: si, path: at });
      });
  });
  for (const { v, path } of checked) checkView(v, path, views, c);
  checkLabels(views, c);

  input.sheets.forEach((s, si) => {
    if (!isObject(s) || !Array.isArray(s.annotations)) {
      if (isObject(s)) c.fail(`drawing.sheets[${si}].annotations`, `must be a list of annotations (got ${describe(s.annotations)})`);
      return;
    }
    const here = new Map([...views].filter(([, x]) => x.sheet === si).map(([k, x]) => [k, x.v]));
    s.annotations.forEach((a, i) => {
      const at = `drawing.sheets[${si}].annotations[${i}]`;
      if (!isObject(a)) return c.fail(at, `must be an annotation object (got ${describe(a)})`);
      id(a.id, `${at}.id`);
      if (!ANNOTATION_TYPES.includes(a.type as never)) {
        return c.fail(`${at}.type`, `must be ${ANNOTATION_TYPES.map((t) => `"${t}"`).join(", ")} (got ${describe(a.type)})`);
      }
      checkAnnotation(a, at, here, views, c);
    });
    if (s.tables !== undefined) {
      // The table engine's own checks (src/drafting/tables), with the views on this sheet a hole table may name.
      const r = checkDrawingTables(s.tables, `drawing.sheets[${si}].tables`, { views: [...here.keys()] });
      for (const e of r.errors) c.fail("", e);
      if (Array.isArray(s.tables)) s.tables.forEach((t, i) => isObject(t) && id(t.id, `drawing.sheets[${si}].tables[${i}].id`, "views, annotations and tables share their ids"));
    }
  });
  return c.errors.length === before ? (input as unknown as Drawing) : null;
}

function text(v: unknown, path: string, c: Checker, max: number): void {
  if (typeof v !== "string") c.fail(path, `must be text (got ${describe(v)})`);
  else if (v.length > max) c.fail(path, `is ${v.length} characters; at most ${max}`);
}

export function checkFormat(f: unknown, path: string, c: Checker): void {
  if (!isObject(f)) return c.fail(path, `must be the sheet's format { size, orientation, template, title ... } (got ${describe(f)})`);
  c.keys(f, path, [...FORMAT_KEYS]);
  if (!(typeof f.size === "string" && f.size in SHEET_SIZES)) c.fail(`${path}.size`, `must be ${Object.keys(SHEET_SIZES).map((k) => `"${k}"`).join(", ")} (got ${describe(f.size)})`);
  if (f.orientation !== undefined && !SHEET_ORIENTATIONS.includes(f.orientation as never)) c.fail(`${path}.orientation`, `must be "landscape" or "portrait" (got ${describe(f.orientation)})`);
  if (f.template !== undefined && !SHEET_TEMPLATES.includes(f.template as never)) c.fail(`${path}.template`, `must be ${SHEET_TEMPLATES.map((t) => `"${t}"`).join(", ")} (got ${describe(f.template)})`);
  for (const k of TITLE_FIELDS) if (f[k] !== undefined) text(f[k], `${path}.${k}`, c, 200);
}

/** The fields each kind of view takes beyond the ones every view does. */
const KIND_KEYS: Record<ViewKind, readonly string[]> = {
  model: ["look", "orientation"],
  projected: ["parent", "direction", "free"],
  section: ["parent", "line", "label", "half", "aligned", "flip", "depth", "showBehind", "hatch", "free"],
  detail: ["parent", "circle", "profile", "style", "label"],
  auxiliary: ["parent", "edge", "label", "flip"],
};
const COMMON_KEYS = ["id", "kind", "hidden", "at", "locked", "scale", "display", "tangent", "threads", "breaks", "crop", "brokenOut", "bodies", "showLabel", "showScale"];
const KIND_HELP: Record<ViewKind, string> = {
  model: "a model view looks at the part from a named orientation (look) or a custom one (orientation)",
  projected: "a projected view is made from a parent view and a direction",
  section: "a section view is made from a parent view and a cutting line on it",
  detail: "a detail view is made from a parent view and a circle (or profile) on it",
  auxiliary: "an auxiliary view is made from a parent view and an edge on it",
};

/** The view's kind, as written (default model). */
export function viewKind(v: { kind?: unknown }): ViewKind {
  return (VIEW_KINDS as readonly string[]).includes(v.kind as string) ? (v.kind as ViewKind) : "model";
}

function checkView(v: Record<string, unknown>, at: string, views: Map<string, { v: Record<string, unknown> }>, c: Checker): void {
  if (v.kind !== undefined && !VIEW_KINDS.includes(v.kind as never)) {
    c.fail(`${at}.kind`, `must be ${VIEW_KINDS.map((k) => `"${k}"`).join(", ")} (got ${describe(v.kind)})`);
    return;
  }
  const kind = viewKind(v);
  const allowed = [...COMMON_KEYS, ...KIND_KEYS[kind]];
  for (const key of Object.keys(v)) {
    if (allowed.includes(key)) continue;
    if ((VIEW_KEYS as readonly string[]).includes(key)) c.fail(at, `"${key}" is not for a ${kind} view: ${KIND_HELP[kind]}`);
    else c.fail(at, `unknown field "${key}" (allowed for a ${kind} view: ${allowed.join(", ")})`);
  }
  const pts = (key: string, min: number, what: string) => {
    const p = v[key];
    if (!Array.isArray(p) || p.length < min || !p.every((q) => Array.isArray(q) && q.length === 2 && q.every((x) => typeof x === "number" && Number.isFinite(x)))) {
      c.fail(`${at}.${key}`, `must be ${what}: ${min} or more [x, y] points, view mm (got ${describe(p)})`);
      return null;
    }
    const list = p as [number, number][];
    for (let i = 1; i < list.length; i++) if (Math.hypot(list[i][0] - list[i - 1][0], list[i][1] - list[i - 1][1]) < 1e-6) c.fail(`${at}.${key}[${i}]`, "is the same point as the one before it");
    return list;
  };
  const bool = (key: string) => {
    if (v[key] !== undefined && typeof v[key] !== "boolean") c.fail(`${at}.${key}`, `must be true or false (got ${describe(v[key])})`);
  };
  if (kind === "model") {
    if (v.look !== undefined && v.orientation !== undefined) c.fail(at, "a model view has a look or an orientation, not both");
    if (v.look !== undefined && !VIEW_LOOKS.includes(v.look as never)) c.fail(`${at}.look`, `must be ${VIEW_LOOKS.map((l) => `"${l}"`).join(", ")} (got ${describe(v.look)})`);
    if (v.look === undefined && v.orientation === undefined && v.kind === undefined) c.fail(`${at}.look`, `must be ${VIEW_LOOKS.map((l) => `"${l}"`).join(", ")} (got nothing)`);
    if (v.orientation !== undefined) {
      const o = v.orientation;
      if (!isObject(o)) c.fail(`${at}.orientation`, `must be { eye: [x, y, z], up?: [x, y, z] } (got ${describe(o)})`);
      else {
        c.keys(o, `${at}.orientation`, ["eye", "up"]);
        const eye = c.unitVec(o, "eye", `${at}.orientation`);
        const up = o.up === undefined ? undefined : c.unitVec(o, "up", `${at}.orientation`);
        if (eye && up) {
          const cos = Math.abs(eye[0] * up[0] + eye[1] * up[1] + eye[2] * up[2]) / (Math.hypot(...eye) * Math.hypot(...up));
          if (cos > 0.999) c.fail(`${at}.orientation.up`, "must not point along the eye: up is a direction across the view");
        }
      }
    }
  } else {
    const parent = v.parent;
    if (typeof parent !== "string" || !views.has(parent)) c.fail(`${at}.parent`, `must be the view it is made from (views: ${[...views.keys()].join(", ") || "none"}; got ${describe(parent)})`);
    else if (parent === v.id) c.fail(`${at}.parent`, "is the view itself");
    else {
      // No view may be its own ancestor.
      const seen = new Set<string>([String(v.id)]);
      let p: unknown = parent;
      while (typeof p === "string" && views.has(p)) {
        if (seen.has(p)) {
          c.fail(`${at}.parent`, `makes a loop of parents (${[...seen, p].join(" → ")})`);
          break;
        }
        seen.add(p);
        p = views.get(p)!.v.parent;
      }
    }
  }
  if (kind === "projected" && !PROJECT_DIRECTIONS.includes(v.direction as never)) c.fail(`${at}.direction`, `must be ${PROJECT_DIRECTIONS.map((d) => `"${d}"`).join(", ")} (got ${describe(v.direction)})`);
  if (kind === "section") {
    const line = pts("line", 2, "the cutting line on the parent");
    if (line && v.aligned === true && line.length !== 3) c.fail(`${at}.line`, `an aligned section's line has three points: one end, the centre it turns about, the other end (got ${line.length})`);
    if (line && v.aligned !== true) {
      // An offset section's line steps at right angles: its long runs all cut in parallel planes.
      const dirs = line.slice(1).map((p, i) => Math.atan2(p[1] - line[i][1], p[0] - line[i][0]));
      for (let i = 1; i < dirs.length; i++) {
        const turn = Math.abs(Math.sin(dirs[i] - dirs[i - 1]));
        if (turn > 1e-6 && Math.abs(turn - 1) > 1e-6) {
          c.fail(`${at}.line[${i + 1}]`, "an offset section's line turns at right angles only; for a line through an angle, make it aligned (aligned: true, three points)");
          break;
        }
      }
    }
    for (const k of ["half", "aligned", "flip", "showBehind"]) bool(k);
    if (v.half === true && v.aligned === true) c.fail(at, "a section is half or aligned, not both");
    if (v.depth !== undefined) c.num(v, "depth", at, { positive: true });
    if (v.hatch !== undefined) checkHatch(v.hatch, `${at}.hatch`, c);
  }
  if (kind === "auxiliary") {
    const g = parseGeoRef(v.edge);
    if (!g || g.form !== "e") c.fail(`${at}.edge`, `must be a straight edge of the parent, "<parent>:e<edge>" (got ${describe(v.edge)})`);
    else if (g.view !== v.parent) c.fail(`${at}.edge`, `is in view ${g.view}; the edge must be one of the parent's (${String(v.parent)})`);
    bool("flip");
  }
  if (kind === "detail") {
    if ((v.circle === undefined) === (v.profile === undefined)) c.fail(at, "a detail view has a circle { at, r } or a closed profile on its parent, one of them");
    if (v.circle !== undefined) {
      if (!isObject(v.circle)) c.fail(`${at}.circle`, `must be { at: [x, y], r } on the parent, view mm (got ${describe(v.circle)})`);
      else {
        c.keys(v.circle, `${at}.circle`, ["at", "r"]);
        c.vec2(v.circle, "at", `${at}.circle`);
        c.num(v.circle, "r", `${at}.circle`, { positive: true });
      }
    }
    if (v.profile !== undefined) pts("profile", 3, "a closed outline on the parent");
    if (v.style !== undefined && !DETAIL_STYLES.includes(v.style as never)) c.fail(`${at}.style`, `must be ${DETAIL_STYLES.map((s) => `"${s}"`).join(", ")} (got ${describe(v.style)})`);
  }
  if (v.label !== undefined && (typeof v.label !== "string" || !/^[A-Z]{1,2}[0-9]?$/.test(v.label))) c.fail(`${at}.label`, `must be a capital letter or two ("A", "AA", "B1") (got ${describe(v.label)})`);
  if (v.at !== undefined) c.vec2(v, "at", at);
  if (v.scale !== undefined && parseScale(v.scale) === null) c.fail(`${at}.scale`, `must be a scale like "1:10" (got ${describe(v.scale)})`);
  if (v.display !== undefined && !DISPLAY_MODES.includes(v.display as never)) c.fail(`${at}.display`, `must be ${DISPLAY_MODES.map((d) => `"${d}"`).join(", ")} (got ${describe(v.display)})`);
  if (v.tangent !== undefined && !TANGENT_MODES.includes(v.tangent as never)) c.fail(`${at}.tangent`, `must be ${TANGENT_MODES.map((d) => `"${d}"`).join(", ")} (got ${describe(v.tangent)})`);
  for (const k of ["threads", "showLabel", "showScale", "free", "locked"]) bool(k);
  // Phase L's switch (true and false are read as display "hidden" and its default); anything else is a mistake.
  if (v.hidden !== undefined) c.fail(`${at}.hidden`, `must be true or false (got ${describe(v.hidden)}); a view's hidden edges are now display: "hidden"`);
  if (v.breaks !== undefined) {
    if (!Array.isArray(v.breaks)) c.fail(`${at}.breaks`, `must be a list of breaks { axis, from, to } (got ${describe(v.breaks)})`);
    else
      v.breaks.forEach((b, i) => {
        const bp = `${at}.breaks[${i}]`;
        if (!isObject(b)) return c.fail(bp, `must be a break { axis: "x" | "y", from, to, gap?, style? } (got ${describe(b)})`);
        c.keys(b, bp, [...BREAK_KEYS]);
        if (b.axis !== "x" && b.axis !== "y") c.fail(`${bp}.axis`, `must be "x" (a break across a long view) or "y" (got ${describe(b.axis)})`);
        const from = c.num(b, "from", bp, {});
        const to = c.num(b, "to", bp, {});
        if (from !== undefined && to !== undefined && to <= from) c.fail(bp, `runs from ${from} to ${to}: "to" must be beyond "from"`);
        if (b.gap !== undefined) c.num(b, "gap", bp, { positive: true });
        if (b.style !== undefined && !["zigzag", "straight", "curved"].includes(b.style as string)) c.fail(`${bp}.style`, `must be "zigzag", "straight" or "curved" (got ${describe(b.style)})`);
      });
  }
  if (v.crop !== undefined) pts("crop", 3, "a closed outline");
  if (v.brokenOut !== undefined) {
    if (!Array.isArray(v.brokenOut)) c.fail(`${at}.brokenOut`, `must be a list of broken-out sections { profile, depth } (got ${describe(v.brokenOut)})`);
    else
      v.brokenOut.forEach((b, i) => {
        const bp = `${at}.brokenOut[${i}]`;
        if (!isObject(b)) return c.fail(bp, `must be { profile: [[x, y], ...], depth } (got ${describe(b)})`);
        c.keys(b, bp, ["profile", "depth"]);
        const p = b.profile;
        if (!Array.isArray(p) || p.length < 3 || !p.every((q) => Array.isArray(q) && q.length === 2 && q.every((x) => typeof x === "number" && Number.isFinite(x)))) {
          c.fail(`${bp}.profile`, `must be a closed outline: 3 or more [x, y] points, view mm (got ${describe(p)})`);
        }
        c.num(b, "depth", bp, { positive: true });
      });
  }
  if (v.bodies !== undefined && (!Array.isArray(v.bodies) || v.bodies.length === 0 || !v.bodies.every((b) => typeof b === "string" && b.length > 0))) {
    c.fail(`${at}.bodies`, `must be a list of the bodies to show, by name (got ${describe(v.bodies)}); leave it out to show them all`);
  }
}

function checkHatch(h: unknown, at: string, c: Checker): void {
  if (!isObject(h)) return c.fail(at, `must be { pattern?, angle?, spacing? } (got ${describe(h)})`);
  c.keys(h, at, [...HATCH_KEYS]);
  if (h.pattern !== undefined && !HATCH_PATTERNS.includes(h.pattern as never)) c.fail(`${at}.pattern`, `must be ${HATCH_PATTERNS.map((p) => `"${p}"`).join(", ")} (got ${describe(h.pattern)})`);
  if (h.angle !== undefined) c.num(h, "angle", at, {});
  if (h.spacing !== undefined) {
    const s = c.num(h, "spacing", at, { positive: true });
    if (s !== undefined && s < 0.5) c.fail(`${at}.spacing`, `${s} mm is too fine to print; at least 0.5`);
  }
}

/** No two sections, details or auxiliary views share a label. */
function checkLabels(views: Map<string, { v: Record<string, unknown>; path: string }>, c: Checker): void {
  const used = new Map<string, string>();
  for (const [id, { v, path }] of views) {
    if (typeof v.label !== "string") continue;
    const other = used.get(v.label);
    if (other) c.fail(`${path}.label`, `"${v.label}" is ${other}'s label too: each section, detail and auxiliary view has its own`);
    else used.set(v.label, id);
  }
}

/** True when a view looks square at the part: a length in it is a true length. */
export function isSquareView(v: Record<string, unknown>, views: Map<string, { v: Record<string, unknown> }>): boolean {
  const kind = viewKind(v);
  if (kind === "model") {
    if (v.orientation !== undefined) {
      const eye = (isObject(v.orientation) ? v.orientation.eye : null) as number[] | null;
      if (!eye) return true;
      const l = Math.hypot(...eye);
      return eye.some((x) => Math.abs(Math.abs(x) / l - 1) < 1e-9);
    }
    return !["iso", "dimetric", "trimetric"].includes(String(v.look ?? "front"));
  }
  if (kind === "projected") {
    const diagonal = ["upLeft", "upRight", "downLeft", "downRight"].includes(String(v.direction));
    const parent = views.get(String(v.parent));
    return !diagonal && !!parent && isSquareView(parent.v, views);
  }
  if (kind === "detail") {
    const parent = views.get(String(v.parent));
    return !!parent && isSquareView(parent.v, views);
  }
  // A section or an auxiliary view looks square at its cut or its edge.
  return true;
}

function checkAnnotation(a: Record<string, unknown>, at: string, here: Map<string, Record<string, unknown>>, all: Map<string, { v: Record<string, unknown>; sheet: number }>, c: Checker): void {
  const type = a.type as Annotation["type"];
  c.keys(a, at, [...ANNOTATION_KEYS[type]]);
  const needsView = (VIEW_ANNOTATIONS as readonly string[]).includes(type) || (type === "surface" && a.general !== true && a.view !== undefined);
  if (needsView || (a.view !== undefined && type !== "table")) {
    if (typeof a.view !== "string" || !here.has(a.view)) {
      const elsewhere = typeof a.view === "string" && all.has(a.view);
      c.fail(`${at}.view`, elsewhere ? `${a.view} is on another sheet: an annotation goes on its view's sheet` : `no view ${describe(a.view)} (views: ${[...here.keys()].join(", ") || "none"})`);
    } else if (type === "dimension" && !isSquareView(here.get(a.view)!, all)) {
      const look = here.get(a.view)!.look;
      c.fail(`${at}.view`, `${a.view} is ${look === "iso" ? "an iso view" : "a view at an angle to the part"}, which shortens every length: dimension in a view that looks square at the part`);
    }
  }
  const named = (key: string, what: string) => {
    if (typeof a[key] !== "string" || !ID.test(a[key] as string)) c.fail(`${at}.${key}`, `must name ${what} (got ${describe(a[key])})`);
  };
  const geo = (v: unknown, path: string, forms: string[]) => {
    const g = parseGeoRef(v);
    if (!g || !forms.includes(g.form)) c.fail(path, `must be ${GEOREF_HELP} (got ${describe(v)})`);
    else if (g.view !== a.view) c.fail(path, `is in view ${g.view}; it must be in the annotation's view ${String(a.view)}`);
  };
  const bool = (key: string) => {
    if (a[key] !== undefined && typeof a[key] !== "boolean") c.fail(`${at}.${key}`, `must be true or false (got ${describe(a[key])})`);
  };
  bool("hidden");
  const str = (key: string, max = 200, required = false) => {
    if (a[key] === undefined) {
      if (required) c.fail(`${at}.${key}`, "is required");
      return;
    }
    text(a[key], `${at}.${key}`, c, max);
  };
  const oneOf = (key: string, values: readonly string[]) => {
    if (a[key] !== undefined && !values.includes(a[key] as string)) c.fail(`${at}.${key}`, `must be ${values.map((v) => `"${v}"`).join(", ")} (got ${describe(a[key])})`);
  };
  const count = (key: string) => {
    if (a[key] !== undefined && (!Number.isInteger(a[key]) || (a[key] as number) < 1 || (a[key] as number) > 999)) c.fail(`${at}.${key}`, `must be a whole number 1 to 999 (got ${describe(a[key])})`);
  };
  const point = (v: unknown, path: string) => {
    const r = pointRef(v);
    if (!r) c.fail(path, `must be ${POINT_HELP} (got ${describe(v)})`);
    else if (r.kind === "geo" && parseGeoRef(r.ref)!.view !== a.view) c.fail(path, `is in view ${parseGeoRef(r.ref)!.view}; a dimension's points are in its own view ${String(a.view)}`);
  };
  const vec = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && Number.isFinite(x));
  const pts = (key: string, min: number, max = 10000) => {
    const p = a[key];
    if (!Array.isArray(p) || p.length < min || p.length > max || !p.every(vec)) c.fail(`${at}.${key}`, `must be ${min}${max === min ? "" : " or more"} [x, y] points, sheet mm (got ${describe(p)})`);
  };
  const ownPlace = () => {
    if (a.at !== undefined) c.vec2(a, "at", at);
  };
  const arrow = (key = "arrow") => oneOf(key, ARROW_STYLES);
  const tolerance = () => {
    if (a.tolerance === undefined) return;
    const p = toleranceProblem(a.tolerance);
    if (p) c.fail(`${at}.tolerance`, p);
  };
  const leaderTo = (v: unknown, path: string) => {
    if (typeof v === "string") {
      const g = parseGeoRef(v);
      if (!g) c.fail(path, `must be a GeoRef (${GEOREF_HELP}) or a point [x, y] (got ${describe(v)})`);
      else if (a.view !== undefined && g.view !== a.view) c.fail(path, `is in view ${g.view}; this annotation is in ${String(a.view)}`);
    } else if (!vec(v)) c.fail(path, `must be a GeoRef or a point [x, y] (got ${describe(v)})`);
  };
  switch (type) {
    case "dimension": {
      const kind = (a.kind ?? "linear") as string;
      if (!DIMENSION_KINDS.includes(kind as never)) {
        c.fail(`${at}.kind`, `must be ${DIMENSION_KINDS.map((k) => `"${k}"`).join(", ")} (got ${describe(a.kind)})`);
        break;
      }
      const refs = a.refs;
      if (refs !== undefined) {
        if (!Array.isArray(refs) || !refs.length) c.fail(`${at}.refs`, `must be a list of GeoRefs (got ${describe(refs)})`);
        else refs.forEach((r, i) => geo(r, `${at}.refs[${i}]`, ["e", "v", "c", "m", "q", "point"]));
      }
      const between = a.from !== undefined || a.to !== undefined;
      const set = kind === "ordinate" || kind === "baseline" || kind === "chain";
      const n = Array.isArray(refs) ? refs.length : 0;
      if (set) {
        if (between || a.member !== undefined || refs !== undefined) c.fail(at, `a ${kind} set is an origin and points (origin, points), not from/to, member or refs`);
        if (a.origin !== undefined) point(a.origin, `${at}.origin`);
        else if (kind !== "chain") c.fail(`${at}.origin`, `a ${kind} set measures from an origin: a point or a side of the view`);
        if (!Array.isArray(a.points) || a.points.length < (kind === "chain" && a.origin === undefined ? 2 : 1)) c.fail(`${at}.points`, `must be the points it measures, a list (got ${describe(a.points)})`);
        else a.points.forEach((p, i) => point(p, `${at}.points[${i}]`));
      } else if (a.origin !== undefined || a.points !== undefined) c.fail(at, `origin and points are for ordinate, baseline and chain sets, not a ${kind} dimension`);
      if (kind === "linear") {
        if (a.member !== undefined) {
          named("member", "a member");
          if (between || refs !== undefined) c.fail(at, "a dimension is between two points (from, to), along a member, or on GeoRefs (refs): one of them");
          if (a.direction !== undefined && a.direction !== "aligned") c.fail(`${at}.direction`, `a member's length is dimensioned along it (got ${describe(a.direction)})`);
        } else if (refs !== undefined) {
          if (between) c.fail(at, "a dimension is between two points (from, to) or on GeoRefs (refs), not both");
          if (n > 2) c.fail(`${at}.refs`, "a linear dimension is on one edge or between two GeoRefs");
        } else {
          for (const k of ["from", "to"] as const) point(a[k], `${at}.${k}`);
          if (typeof a.from === "string" && a.from === a.to) c.fail(at, `runs from ${a.from} to itself`);
        }
      } else if (!set) {
        if (between || a.member !== undefined) c.fail(at, `a ${kind} dimension is on its GeoRefs (refs), not from/to or a member`);
        const want: Record<string, string> = {
          angular: "two edges or three points",
          radius: "one arc or circle",
          diameter: "one circle, or a cylinder's two sides",
          arcLength: "one arc",
          chamfer: "one chamfer edge",
          pathLength: "one or more edges",
        };
        const ok = kind === "angular" ? n === 2 || n === 3 : kind === "diameter" ? n === 1 || n === 2 : kind === "pathLength" ? n >= 1 : n === 1;
        if (!ok) c.fail(`${at}.refs`, `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind} dimension is on ${want[kind]} (got ${n} GeoRef${n === 1 ? "" : "s"})`);
      }
      if (a.direction !== undefined && !DIMENSION_DIRECTIONS.includes(a.direction as never)) c.fail(`${at}.direction`, `must be "horizontal", "vertical" or "aligned" (got ${describe(a.direction)})`);
      if (a.offset !== undefined) c.num(a, "offset", at, {});
      ownPlace();
      for (const k of ["major", "jog", "flip", "typ", "inspection", "dual"]) bool(k);
      if (a.major !== undefined && kind !== "angular") c.fail(`${at}.major`, "is for an angular dimension");
      if (a.jog !== undefined && kind !== "radius") c.fail(`${at}.jog`, "is for a radius dimension");
      oneOf("arrows", ARROW_PLACES);
      str("prefix", 40);
      str("suffix", 80);
      str("below", 80);
      str("override", 40);
      count("count");
      if (a.precision !== undefined && (!Number.isInteger(a.precision) || (a.precision as number) < 0 || (a.precision as number) > 6)) c.fail(`${at}.precision`, `is decimal places, 0 to 6 (got ${describe(a.precision)})`);
      tolerance();
      if (a.last !== undefined) {
        const l = a.last as Record<string, unknown>;
        if (!isObject(l) || !Array.isArray(l.pts) || !l.pts.every(vec) || typeof l.text !== "string") c.fail(`${at}.last`, `must be { pts: [[x, y], ...], text } (where it was last drawn; got ${describe(a.last)})`);
      }
      break;
    }
    case "hole":
      named("hole", "a hole feature");
      if (a.on !== undefined) geo(a.on, `${at}.on`, ["e", "c"]);
      ownPlace();
      count("count");
      bool("pattern");
      str("prefix", 40);
      str("suffix", 80);
      tolerance();
      break;
    case "balloon": {
      const by = ["member", "body", "item"].filter((k) => a[k] !== undefined);
      if (by.length !== 1) c.fail(at, `a balloon numbers a member, a body or an item: one of them (got ${by.length ? by.join(", ") : "none"})`);
      if (a.member !== undefined) named("member", "a member");
      if (a.body !== undefined) str("body", 80);
      if (a.item !== undefined) count("item");
      if (a.on !== undefined) geo(a.on, `${at}.on`, ["e", "v", "c", "m", "q", "point"]);
      ownPlace();
      oneOf("shape", BALLOON_SHAPES);
      if (a.size !== undefined) {
        const s = c.num(a, "size", at, { positive: true });
        if (s !== undefined && (s < 5 || s > 30)) c.fail(`${at}.size`, `a balloon is 5 to 30 mm across (got ${s})`);
      }
      if (a.quantity !== undefined && typeof a.quantity !== "boolean") count("quantity");
      if (a.stack !== undefined && (!Array.isArray(a.stack) || !a.stack.every((x) => (typeof x === "string" && ID.test(x)) || (Number.isInteger(x) && (x as number) > 0)))) c.fail(`${at}.stack`, `must be members, bodies or item numbers stacked under it (got ${describe(a.stack)})`);
      arrow();
      break;
    }
    case "weld": {
      if (a.weld !== undefined) named("weld", "a weld in the weld table");
      if (a.on !== undefined) geo(a.on, `${at}.on`, ["e", "v", "c", "m", "q", "point"]);
      if (a.weld === undefined && a.on === undefined) c.fail(at, "a weld symbol is a weld of the weld table (weld) or points at the joint (on)");
      if (a.weld === undefined && a.arrowSide === undefined && a.otherSide === undefined) c.fail(at, "a weld symbol has a weld on the arrow side, the other side or both (arrowSide, otherSide)");
      ownPlace();
      const side = (v: unknown, path: string) => {
        if (!isObject(v)) return c.fail(path, `must be { symbol, size?, length?, count?, pitch?, angle?, root?, contour?, finish? } (got ${describe(v)})`);
        c.keys(v, path, [...WELD_SIDE_KEYS]);
        if (!WELD_SYMBOLS.includes(v.symbol as never)) c.fail(`${path}.symbol`, `must be ${WELD_SYMBOLS.map((s) => `"${s}"`).join(", ")} (got ${describe(v.symbol)})`);
        if (v.size !== undefined && !(typeof v.size === "number" && v.size > 0) && !(typeof v.size === "string" && /^[asz]?\d+(\.\d+)?$/.test(v.size) || (typeof v.size === "string" && /^\(?\d+(\.\d+)?\)?$/.test(v.size)))) c.fail(`${path}.size`, `must be mm, or "a5" (throat), "z7" (leg), "s6" (penetration) (got ${describe(v.size)})`);
        for (const k of ["length", "pitch", "root"]) if (v[k] !== undefined) c.num(v, k, path, { positive: true });
        if (v.angle !== undefined) {
          const an = c.num(v, "angle", path, { positive: true });
          if (an !== undefined && an >= 180) c.fail(`${path}.angle`, "a groove's angle is under 180°");
        }
        if (v.count !== undefined && (!Number.isInteger(v.count) || (v.count as number) < 1)) c.fail(`${path}.count`, `must be a whole number of welds (got ${describe(v.count)})`);
        if (v.pitch !== undefined && typeof v.length === "number" && (v.pitch as number) <= v.length) c.fail(`${path}.pitch`, `is centre to centre: more than the length ${v.length}`);
        if (v.contour !== undefined && !WELD_CONTOURS.includes(v.contour as never)) c.fail(`${path}.contour`, `must be "flush", "convex" or "concave" (got ${describe(v.contour)})`);
        if (v.finish !== undefined && (typeof v.finish !== "string" || !/^[A-Z]$/.test(v.finish))) c.fail(`${path}.finish`, `must be a capital letter (C chip, G grind, M machine, R roll, H hammer, P peen; got ${describe(v.finish)})`);
      };
      if (a.arrowSide !== undefined) side(a.arrowSide, `${at}.arrowSide`);
      if (a.otherSide !== undefined) side(a.otherSide, `${at}.otherSide`);
      for (const k of ["staggered", "allAround", "field"]) bool(k);
      str("process", 40);
      str("reference", 60);
      if (a.more !== undefined) {
        if (!Array.isArray(a.more)) c.fail(`${at}.more`, `must be a list of reference lines { arrowSide?, otherSide? } (got ${describe(a.more)})`);
        else
          a.more.forEach((m, i) => {
            if (!isObject(m)) return c.fail(`${at}.more[${i}]`, "must be { arrowSide?, otherSide? }");
            c.keys(m, `${at}.more[${i}]`, ["arrowSide", "otherSide"]);
            if (m.arrowSide !== undefined) side(m.arrowSide, `${at}.more[${i}].arrowSide`);
            if (m.otherSide !== undefined) side(m.otherSide, `${at}.more[${i}].otherSide`);
          });
      }
      break;
    }
    case "table":
      if (!DRAWING_TABLES.includes(a.table as never)) c.fail(`${at}.table`, `must be "cutList" or "welds" (got ${describe(a.table)})`);
      ownPlace();
      break;
    case "note":
    case "text":
      if (typeof a.text !== "string" || !a.text.trim()) c.fail(`${at}.text`, `must be the ${type}'s text (got ${describe(a.text)})`);
      else if (a.text.length > 4000) c.fail(`${at}.text`, `is ${a.text.length} characters; at most 4000`);
      c.vec2(a, "at", at);
      if (a.height !== undefined) {
        const h = c.num(a, "height", at, { positive: true });
        if (h !== undefined && (h < 1.8 || h > 20)) c.fail(`${at}.height`, `lettering is 1.8 to 20 mm high (ISO 3098: 2.5, 3.5, 5, 7, 10; got ${h})`);
      }
      if (a.angle !== undefined) c.num(a, "angle", at, {});
      for (const k of ["bold", "italic", "underline", "numbered", "frame"]) bool(k);
      str("title", 80);
      oneOf("anchor", ["start", "middle", "end"]);
      if (a.leaders !== undefined) {
        if (!Array.isArray(a.leaders)) c.fail(`${at}.leaders`, `must be a list of leaders { to, via?, arrow?, spline? } (got ${describe(a.leaders)})`);
        else
          a.leaders.forEach((l, i) => {
            const lp = `${at}.leaders[${i}]`;
            if (!isObject(l)) return c.fail(lp, "must be a leader { to, via?, arrow?, spline? }");
            c.keys(l, lp, ["to", "via", "arrow", "spline"]);
            leaderTo(l.to, `${lp}.to`);
            if (l.via !== undefined && (!Array.isArray(l.via) || !l.via.every(vec))) c.fail(`${lp}.via`, "must be a list of [x, y] bends");
            if (l.arrow !== undefined && !ARROW_STYLES.includes(l.arrow as never)) c.fail(`${lp}.arrow`, `must be ${ARROW_STYLES.map((s) => `"${s}"`).join(", ")}`);
            if (l.spline !== undefined && typeof l.spline !== "boolean") c.fail(`${lp}.spline`, "must be true or false");
          });
      }
      break;
    case "centerMark":
      geo(a.at, `${at}.at`, ["e", "c"]);
      if (a.extend !== undefined) c.num(a, "extend", at, { nonNegative: true });
      oneOf("style", ["lines", "cross", "pitch"]);
      break;
    case "centerline":
      if (!Array.isArray(a.between) || a.between.length !== 2) c.fail(`${at}.between`, `must be two GeoRefs: two edges (a cylinder's sides) or two points (got ${describe(a.between)})`);
      else a.between.forEach((g, i) => geo(g, `${at}.between[${i}]`, ["e", "v", "c", "m", "q", "point"]));
      if (a.extend !== undefined) c.num(a, "extend", at, { nonNegative: true });
      break;
    case "gdt": {
      if (!Array.isArray(a.rows) || !a.rows.length || a.rows.length > 4) {
        c.fail(`${at}.rows`, `must be one to four rows { characteristic, tolerance, diameter?, material?, modifiers?, datums? } (got ${describe(a.rows)})`);
        break;
      }
      a.rows.forEach((r, i) => {
        const rp = `${at}.rows[${i}]`;
        if (!isObject(r)) return c.fail(rp, "must be a row { characteristic, tolerance, ... }");
        c.keys(r, rp, [...GDT_ROW_KEYS]);
        if (!GDT_CHARACTERISTICS.includes(r.characteristic as never)) c.fail(`${rp}.characteristic`, `must be ${GDT_CHARACTERISTICS.map((x) => `"${x}"`).join(", ")} (got ${describe(r.characteristic)})`);
        c.num(r, "tolerance", rp, { positive: true });
        for (const k of ["diameter", "spherical"]) if (r[k] !== undefined && typeof r[k] !== "boolean") c.fail(`${rp}.${k}`, "must be true or false");
        if (r.diameter === true && r.spherical === true) c.fail(rp, "a zone is Ø or SØ, not both");
        if (r.material !== undefined && r.material !== "M" && r.material !== "L") c.fail(`${rp}.material`, `must be "M" (maximum material) or "L" (least) (got ${describe(r.material)})`);
        if (r.modifiers !== undefined && (!Array.isArray(r.modifiers) || !r.modifiers.every((m) => GDT_MODIFIERS.includes(m as never)))) c.fail(`${rp}.modifiers`, `must be a list of ${GDT_MODIFIERS.map((m) => `"${m}"`).join(", ")} (got ${describe(r.modifiers)})`);
        for (const k of ["projected", "unequal", "per"]) if (r[k] !== undefined) c.num(r, k, rp, { positive: true });
        if (r.projected !== undefined && !(Array.isArray(r.modifiers) && r.modifiers.includes("P"))) c.fail(`${rp}.projected`, 'is Ⓟ\'s height: add "P" to modifiers');
        if (r.unequal !== undefined && !(Array.isArray(r.modifiers) && r.modifiers.includes("U"))) c.fail(`${rp}.unequal`, 'is Ⓤ\'s amount: add "U" to modifiers');
        if (r.datums !== undefined) {
          if (!Array.isArray(r.datums) || r.datums.length > 3) c.fail(`${rp}.datums`, `must be up to three datums { label, modifier? } (got ${describe(r.datums)})`);
          else
            r.datums.forEach((d, j) => {
              const dp = `${rp}.datums[${j}]`;
              if (!isObject(d)) return c.fail(dp, 'must be { label: "A", modifier?: "M" | "L" | "S" }');
              c.keys(d, dp, ["label", "modifier"]);
              if (typeof d.label !== "string" || !/^[A-HJ-NPR-Z]{1,2}\d*(-[A-HJ-NPR-Z]{1,2}\d*)?$/.test(d.label)) c.fail(`${dp}.label`, `must be a datum letter ("A", "B", or "A-B" for a common datum; I, O and Q are not used; got ${describe(d.label)})`);
              if (d.modifier !== undefined && !["M", "L", "S"].includes(d.modifier as string)) c.fail(`${dp}.modifier`, `must be "M", "L" or "S" (got ${describe(d.modifier)})`);
            });
        }
      });
      bool("composite");
      if (a.composite === true && Array.isArray(a.rows) && (a.rows as Record<string, unknown>[]).some((r) => isObject(r) && r.characteristic !== (a.rows as Record<string, unknown>[])[0].characteristic)) c.fail(`${at}.composite`, "a composite frame's rows share one characteristic (position or profile)");
      if (a.on !== undefined) geo(a.on, `${at}.on`, ["e", "v", "c", "m", "q", "point"]);
      if (a.dimension !== undefined) named("dimension", "a dimension on the sheet");
      if (a.extension !== undefined && a.extension !== 0 && a.extension !== 1) c.fail(`${at}.extension`, "must be 0 or 1: the dimension's first or second extension line");
      if (a.extension !== undefined && a.dimension === undefined) c.fail(`${at}.extension`, "is a dimension's extension line: give dimension too");
      if (a.on === undefined && a.dimension === undefined && a.at === undefined) c.fail(at, "a frame is on a feature (on), a dimension (dimension) or placed (at)");
      ownPlace();
      count("count");
      str("above", 80);
      str("below", 80);
      arrow();
      break;
    }
    case "datum":
      if (typeof a.label !== "string" || !/^[A-HJ-NPR-Z]{1,2}$/.test(a.label)) c.fail(`${at}.label`, `must be a datum letter "A", "B" ... (I, O and Q are not used; got ${describe(a.label)})`);
      if ([a.on, a.dimension, a.gdt].filter((x) => x !== undefined).length !== 1) c.fail(at, "a datum is on a surface (on), a dimension (dimension) or a frame (gdt): one of them");
      if (a.on !== undefined) geo(a.on, `${at}.on`, ["e", "v", "m", "point"]);
      if (a.dimension !== undefined) named("dimension", "a dimension on the sheet");
      if (a.gdt !== undefined) named("gdt", "a feature control frame on the sheet");
      ownPlace();
      bool("open");
      break;
    case "datumTarget":
      if (typeof a.label !== "string" || !/^[A-HJ-NPR-Z]{1,2}\d{1,2}$/.test(a.label)) c.fail(`${at}.label`, `must be a datum letter and a number, "A1" (got ${describe(a.label)})`);
      oneOf("target", ["point", "line", "area"]);
      if (a.target === undefined) c.fail(`${at}.target`, 'must be "point", "line" or "area"');
      geo(a.on, `${at}.on`, ["e", "v", "c", "m", "q", "point"]);
      if (a.size !== undefined && !(typeof a.size === "number" && a.size > 0) && !(Array.isArray(a.size) && a.size.length === 2 && a.size.every((x) => typeof x === "number" && x > 0))) c.fail(`${at}.size`, `must be a diameter or [width, height], mm (got ${describe(a.size)})`);
      if (a.size !== undefined && a.target !== "area") c.fail(`${at}.size`, "is an area target's size");
      if (a.length !== undefined) c.num(a, "length", at, { positive: true });
      ownPlace();
      break;
    case "surface":
      oneOf("symbol", SURFACE_SYMBOLS);
      if (a.values !== undefined && (!Array.isArray(a.values) || a.values.length > 3 || !a.values.every((x) => typeof x === "string" && x.length <= 40))) c.fail(`${at}.values`, `must be up to three requirements like "Ra 1.6" (got ${describe(a.values)})`);
      str("process", 60);
      oneOf("lay", LAY_SYMBOLS);
      if (a.allowance !== undefined) c.num(a, "allowance", at, { positive: true });
      for (const k of ["allAround", "general"]) bool(k);
      if (a.general === true) {
        if (a.on !== undefined || a.dimension !== undefined) c.fail(at, "a general surface requirement stands by the title block: no on or dimension");
      } else {
        if (a.view === undefined) c.fail(`${at}.view`, "a surface symbol is in a view (or general: true for the drawing's general requirement)");
        if (a.on !== undefined) geo(a.on, `${at}.on`, ["e", "v", "m", "point"]);
        if (a.dimension !== undefined) named("dimension", "a dimension on the sheet");
        if (a.on === undefined && a.dimension === undefined) c.fail(at, "a surface symbol is on a surface (on) or a dimension's extension line (dimension)");
      }
      if (a.extension !== undefined && a.extension !== 0 && a.extension !== 1) c.fail(`${at}.extension`, "must be 0 or 1");
      ownPlace();
      break;
    case "cosmeticThread":
      named("hole", "a tapped hole or thread feature");
      if (a.on !== undefined) geo(a.on, `${at}.on`, ["e", "v", "c", "m", "q", "point"]);
      ownPlace();
      break;
    case "revisionCloud":
      pts("pts", 3);
      str("rev", 10);
      ownPlace();
      if (a.arc !== undefined) {
        const r = c.num(a, "arc", at, { positive: true });
        if (r !== undefined && (r < 1 || r > 50)) c.fail(`${at}.arc`, `the cloud's arcs are 1 to 50 mm (got ${r})`);
      }
      break;
    case "leader":
      leaderTo(a.to, `${at}.to`);
      ownPlace();
      if (a.text !== undefined) str("text", 500);
      if (a.via !== undefined && (!Array.isArray(a.via) || !a.via.every(vec))) c.fail(`${at}.via`, "must be a list of [x, y] bends");
      arrow();
      bool("spline");
      break;
    case "line":
      pts("pts", 2, 2);
      oneOf("line", SKETCH_LINES);
      break;
    case "sketch":
      if (!Array.isArray(a.items) || !a.items.length) c.fail(`${at}.items`, `must be a list of sketch items (lines, arcs, circles, rects, polylines, texts; got ${describe(a.items)})`);
      else
        a.items.forEach((it, i) => {
          const ip = `${at}.items[${i}]`;
          if (!isObject(it)) return c.fail(ip, "must be a sketch item { kind, ... }");
          const keys: Record<string, string[]> = { line: ["a", "b"], arc: ["c", "r", "start", "end"], circle: ["c", "r"], rect: ["a", "b"], polyline: ["pts", "closed"], text: ["at", "text", "height", "angle"] };
          if (!(typeof it.kind === "string" && it.kind in keys)) return c.fail(`${ip}.kind`, `must be "line", "arc", "circle", "rect", "polyline" or "text" (got ${describe(it.kind)})`);
          c.keys(it, ip, ["kind", ...keys[it.kind as string], ...(it.kind !== "text" ? ["line"] : [])]);
          for (const k of ["a", "b", "c", "at"]) if (keys[it.kind as string].includes(k) && !vec(it[k])) c.fail(`${ip}.${k}`, "must be a point [x, y]");
          if (it.r !== undefined) c.num(it, "r", ip, { positive: true });
          for (const k of ["start", "end", "height", "angle"]) if (it[k] !== undefined) c.num(it, k, ip, {});
          if (it.kind === "polyline" && (!Array.isArray(it.pts) || it.pts.length < 2 || !it.pts.every(vec))) c.fail(`${ip}.pts`, "must be two or more [x, y] points");
          if (it.kind === "text" && (typeof it.text !== "string" || !it.text)) c.fail(`${ip}.text`, "must be text");
          if (it.line !== undefined && !SKETCH_LINES.includes(it.line as never)) c.fail(`${ip}.line`, `must be ${SKETCH_LINES.map((l) => `"${l}"`).join(", ")}`);
        });
      break;
  }
}

// ------------------------------------------------------------ reading a drawing

/** Every view of the drawing, sheet by sheet. */
export function allViews(d: Drawing): DrawingView[] {
  return d.sheets.flatMap((s) => s.views);
}

/** Every annotation of the drawing, sheet by sheet. */
export function allAnnotations(d: Drawing): Annotation[] {
  return d.sheets.flatMap((s) => s.annotations);
}

/** The sheet a view or an annotation (or a table) is on. */
export function sheetHolding(d: Drawing, id: string): DrawingSheet | undefined {
  return d.sheets.find((s) => s.views.some((v) => v.id === id) || s.annotations.some((a) => a.id === id) || (s.tables ?? []).some((t) => t.id === id));
}

export function findView(d: Drawing, id: string): DrawingView | undefined {
  for (const s of d.sheets) for (const v of s.views) if (v.id === id) return v;
  return undefined;
}

export function findAnnotation(d: Drawing, id: string): Annotation | undefined {
  for (const s of d.sheets) for (const a of s.annotations) if (a.id === id) return a;
  return undefined;
}

/** The annotations that sit in a view. */
export function viewAnnotations(drawing: Drawing, view: string): Annotation[] {
  return allAnnotations(drawing).filter((a) => "view" in a && a.view === view);
}

/** The views made from `id`, and theirs, all the way down. */
export function dependentViews(d: Drawing | { sheets: { views: { id: string; parent?: unknown }[] }[] }, id: string): string[] {
  const views = d.sheets.flatMap((s) => s.views);
  const out: string[] = [];
  const walk = (p: string) => {
    for (const v of views) if (v.parent === p && !out.includes(v.id)) {
      out.push(v.id);
      walk(v.id);
    }
  };
  walk(id);
  return out;
}

/** Letters a section, detail or auxiliary view may take: I, O and Q are left out, as the standards ask. */
export const VIEW_LABELS = "ABCDEFGHJKLMNPRSTUVWXYZ".split("");

/** The first label no view of the drawing has. */
export function nextViewLabel(d: { sheets: { views: { label?: unknown }[] }[] }): string {
  const used = new Set(d.sheets.flatMap((s) => s.views.map((v) => v.label)).filter((l): l is string => typeof l === "string"));
  for (const l of VIEW_LABELS) if (!used.has(l)) return l;
  for (const a of VIEW_LABELS) for (const b of VIEW_LABELS) if (!used.has(a + b)) return a + b;
  return "ZZ";
}

/** A new sheet's id: "sheet<n>", the first free. */
export function nextSheetId(d: { sheets: { id: unknown }[] }): string {
  const used = new Set(d.sheets.map((s) => s.id));
  for (let n = 1; ; n++) if (!used.has(`sheet${n}`)) return `sheet${n}`;
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
  // A member's mirror, pattern copy or split piece is a member by its body's name.
  const members = new Set([...ids("member"), ...validateDocument(doc).madeBodies]);
  return {
    nodes: new Set(isObject(doc.nodes) ? Object.keys(doc.nodes) : []),
    members,
    // A thread is called out as a tapped hole is (its record is a hole's).
    holes: new Set([...ids("hole"), ...ids("thread")]),
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
        if (!r || r.kind === "side" || r.kind === "geo") continue;
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
      return a.member ? member(a.member) : null;
    case "weld":
      return !a.weld || t.welds.has(a.weld) ? null : `no weld "${a.weld}" in the weld table${list(t.welds)}`;
    default:
      return null;
  }
}

function list(names: Set<string>): string {
  return names.size ? ` (there are ${[...names].slice(0, 12).join(", ")}${names.size > 12 ? ", ..." : ""})` : "";
}

/** A sheet of the raw drawing, for the commands: its lists always lists. */
export interface RawSheet {
  [k: string]: unknown;
  id: string;
  views: Record<string, unknown>[];
  annotations: Record<string, unknown>[];
}

/** The raw drawing, migrated, when the document has one that is an object: what the commands edit. */
export function rawDrawing(doc: Record<string, unknown>): { drawing: Record<string, unknown>; sheets: RawSheet[] } | null {
  const d = migrateDrawing(doc.drawing);
  if (!isObject(d)) return null;
  const sheets = (Array.isArray(d.sheets) ? d.sheets.filter(isObject) : []).map((s) => ({
    ...s,
    id: String(s.id),
    views: Array.isArray(s.views) ? s.views.filter(isObject) : [],
    annotations: Array.isArray(s.annotations) ? s.annotations.filter(isObject) : [],
  }));
  return { drawing: d, sheets };
}

/** Every raw annotation of the document's drawing (any shape it is in). */
export function rawAnnotations(doc: Record<string, unknown>): Record<string, unknown>[] {
  return rawDrawing(doc)?.sheets.flatMap((s) => s.annotations) ?? [];
}

/**
 * A renamed node or feature, on the sheet: the dimensions, callouts and
 * balloons that name it follow, and so do the edges it made in GeoRefs
 * ("front:eextrude_1/l3"). Returns the new drawing, or the same one when
 * nothing named it.
 */
export function renameInDrawing(drawing: unknown, kind: "node" | "feature" | "weld", from: string, to: string): unknown {
  const d = migrateDrawing(drawing);
  if (!isObject(d) || !Array.isArray(d.sheets)) return drawing;
  const geo = (g: unknown): unknown => {
    if (typeof g !== "string" || kind !== "feature") return g;
    const parts = parseGeoRef(g);
    if (!parts || parts.form === "point" || parts.key.slice(0, parts.key.indexOf("/")) !== from) return g;
    // "<view>:<form><maker>/<rest>": the maker follows the rename.
    const at = g.indexOf(":") + 2;
    return `${g.slice(0, at)}${to}${g.slice(at + from.length)}`;
  };
  const point = (p: unknown): unknown => {
    const r = pointRef(p);
    if (!r) return p;
    if (r.kind === "geo") return geo(p);
    if (r.kind === "name" && r.name === from && kind !== "weld") return to;
    if (r.kind === "end" && r.member === from && kind === "feature") return `${to}.${r.end}`;
    return p;
  };
  let changed = false;
  const sheets = d.sheets.map((s) => {
    if (!isObject(s) || !Array.isArray(s.annotations)) return s;
    const annotations = s.annotations.map((a) => {
      if (!isObject(a)) return a;
      const next = { ...a };
      if (kind === "feature") {
        if (next.member === from) next.member = to;
        if (next.hole === from) next.hole = to;
        if (next.type === "centerMark") next.at = geo(next.at);
        if (Array.isArray(next.between)) next.between = next.between.map(geo);
      }
      if (kind === "weld" && next.weld === from) next.weld = to;
      if (next.from !== undefined) next.from = point(next.from);
      if (next.to !== undefined) next.to = point(next.to);
      if (JSON.stringify(next) !== JSON.stringify(a)) changed = true;
      return next;
    });
    const views = Array.isArray(s.views)
      ? s.views.map((v) => {
          if (!isObject(v) || v.edge === undefined) return v;
          const edge = geo(v.edge);
          if (edge === v.edge) return v;
          changed = true;
          return { ...v, edge };
        })
      : s.views;
    return { ...s, annotations, views };
  });
  return changed ? { ...d, sheets } : drawing;
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
