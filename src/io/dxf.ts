// DXF in and out, in millimetres. Pure: text in, text out, no DOM, no kernel.
//
// The writer makes ASCII DXF R2000 (AC1015) by default: what current laser,
// plasma and waterjet CAM (and every CAD program) reads, with what a cutting
// file needs: LWPOLYLINE with bulges, so a closed outline of lines and arcs
// is one contour (one pierce, one lead-in, kerf on the right side); true
// CIRCLE, ARC, ELLIPSE and SPLINE; layers; TEXT; $INSUNITS = 4 (mm). It is
// written whole (handles, tables, block records, the objects dictionary), so
// strict readers accept it as well as forgiving ones. R12 (AC1009) is there
// for old controllers that read nothing newer: polylines become POLYLINE and
// VERTEX (bulges kept), and ellipses and splines, which R12 does not have,
// become fine polylines.
//
// The reader takes R12 to current ASCII DXF: LINE, ARC, CIRCLE, LWPOLYLINE,
// POLYLINE (bulges kept), ELLIPSE, SPLINE, POINT and INSERT (block
// references, exploded with their scale, rotation, mirror and arrays);
// $INSUNITS converts to mm; layers are kept for a filter; text, dimensions,
// hatches and the like are counted and skipped.

import {
  boundsOf,
  compose,
  entityPoints,
  IDENTITY,
  placement,
  sampleEllipse,
  sampleSpline,
  TAU,
  transformEntity,
  translation,
  wrap,
  type Affine,
} from "./dxfGeom";

export type Vec2 = [number, number];

interface Layered {
  /** Its layer; "0" when absent. */
  layer?: string;
}

/** A 2D DXF entity, mm. Angles: arcs in degrees, ellipse parameters in radians, both counter-clockwise as DXF has them. */
export type DxfEntity =
  | ({ type: "line"; a: Vec2; b: Vec2 } & Layered)
  | ({ type: "circle"; c: Vec2; r: number } & Layered)
  /** Counter-clockwise from `start` to `end` (degrees). */
  | ({ type: "arc"; c: Vec2; r: number; start: number; end: number } & Layered)
  /** `bulges[i]` bends the piece from point i to the next: tan(included angle / 4), positive counter-clockwise. */
  | ({ type: "polyline"; points: Vec2[]; bulges?: number[]; closed?: boolean } & Layered)
  /**
   * `major` is the vector from the centre to the end of the major axis; the
   * minor axis is that turned a quarter left, times `ratio`. Counter-clockwise
   * from parameter `start` to `end` (radians); the whole ellipse when they are
   * a whole turn apart (0 and 2π).
   */
  | ({ type: "ellipse"; c: Vec2; major: Vec2; ratio: number; start: number; end: number } & Layered)
  /** A B-spline (NURBS when `weights` are given) by its control points and knots; `fit` points when the file has them. */
  | ({ type: "spline"; degree: number; control: Vec2[]; knots: number[]; weights?: number[]; fit?: Vec2[]; closed?: boolean } & Layered)
  | ({ type: "point"; at: Vec2 } & Layered)
  /** Single-line text from `at` (its left end, on the baseline; centred when `align` says so). */
  | ({ type: "text"; at: Vec2; height: number; text: string; rotation?: number; align?: "left" | "center" } & Layered);

export type DxfEntityType = DxfEntity["type"];

export interface DxfLayer {
  name: string;
  /** AutoCAD colour index (1 red, 2 yellow, 3 green, 4 cyan, 5 blue, 6 magenta, 7 white/black, 8 grey). */
  color?: number;
  lineType?: "CONTINUOUS" | "DASHED";
}

export interface DxfDrawing {
  entities: DxfEntity[];
  /** Layers with their colour and line type; layers the entities name but this does not list are white and continuous. */
  layers?: DxfLayer[];
}

export interface WriteOptions {
  /** "R2000" (default): AC1015 with LWPOLYLINE, ELLIPSE and SPLINE. "R12": AC1009, for old CAM and controllers. */
  version?: "R2000" | "R12";
  /** Splines as SPLINE entities (default in R2000) or as polylines within `tolerance`. */
  splines?: "spline" | "polyline";
  /** Chord tolerance for curves drawn as polylines, mm (default 0.01). */
  tolerance?: number;
}

export class DxfError extends Error {}

// ================================================================= writer

/** Numbers as DXF writes them: plain decimals (no exponent), to 1e-10, always with a point. */
export function dxfNumber(x: number): string {
  if (!Number.isFinite(x)) return "0.0";
  // Ten decimals, but no more than the 15 significant digits a double holds.
  const digits = Math.abs(x) >= 1 ? Math.floor(Math.log10(Math.abs(x))) + 1 : 0;
  let s = x.toFixed(Math.max(0, Math.min(10, 15 - digits))).replace(/0+$/, "");
  if (s.endsWith(".")) s += "0";
  return s === "-0.0" ? "0.0" : s;
}

/** DXF text: ASCII as is; anything else as \U+XXXX, as AutoCAD writes it. */
function dxfText(s: string): string {
  let out = "";
  for (const ch of s.replace(/[\r\n]+/g, " ")) {
    const c = ch.codePointAt(0)!;
    out += c >= 32 && c < 127 ? ch : `\\U+${c.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

/** Layer names DXF accepts: no <>/\":;?*|=` and not empty. */
export function layerName(name: string): string {
  const clean = name.replace(/[<>/\\":;?*|=`]/g, "_").trim();
  return clean || "0";
}

class Out {
  readonly lines: string[] = [];
  /** A group: its code, then its value. */
  g(code: number, value: string | number, int = false) {
    this.lines.push(String(code).padStart(3, " "), typeof value === "number" ? (int ? String(Math.round(value)) : dxfNumber(value)) : value);
  }
  i(code: number, value: number) {
    this.g(code, value, true);
  }
  xy(code: number, p: Vec2, z = true) {
    this.g(code, p[0]);
    this.g(code + 10, p[1]);
    if (z) this.g(code + 20, 0);
  }
  text(): string {
    return `${this.lines.join("\r\n")}\r\n`;
  }
}

/**
 * The entities the version can write: R12 has no LWPOLYLINE (POLYLINE does
 * the same job), no ELLIPSE and no SPLINE (polylines within tolerance).
 */
function forVersion(entities: DxfEntity[], opts: WriteOptions): DxfEntity[] {
  const tol = opts.tolerance ?? 0.01;
  const r12 = opts.version === "R12";
  const splinesAsPolylines = r12 || opts.splines === "polyline";
  return entities.flatMap((e): DxfEntity[] => {
    if (e.type === "ellipse" && r12) {
      const whole = wrap(e.end - e.start) < 1e-12;
      const pts = sampleEllipse(e, tol);
      if (whole) pts.pop();
      return [{ type: "polyline", points: pts, ...(whole ? { closed: true } : {}), ...(e.layer !== undefined ? { layer: e.layer } : {}) }];
    }
    if (e.type === "spline" && splinesAsPolylines) {
      const pts = sampleSpline(e, tol);
      if (e.closed && pts.length > 2) pts.pop();
      return [{ type: "polyline", points: pts, ...(e.closed ? { closed: true } : {}), ...(e.layer !== undefined ? { layer: e.layer } : {}) }];
    }
    if (e.type === "polyline" && e.points.length < 2) return [];
    return [e];
  });
}

/** The DXF text of a drawing (see the header comment for the versions). */
export function writeDxf(drawing: DxfDrawing, opts: WriteOptions = {}): string {
  const entities = forVersion(drawing.entities, opts);
  // Every layer used or declared, "0" first.
  const declared = new Map((drawing.layers ?? []).map((l) => [layerName(l.name), { ...l, name: layerName(l.name) }]));
  const layers: DxfLayer[] = [declared.get("0") ?? { name: "0", color: 7 }];
  const seen = new Set(["0"]);
  for (const l of [...declared.values(), ...entities.map((e) => ({ name: layerName(e.layer ?? "0") }) as DxfLayer)]) {
    if (seen.has(l.name)) continue;
    seen.add(l.name);
    layers.push(declared.get(l.name) ?? l);
  }
  const box = boundsOf(entities) ?? { min: [0, 0] as Vec2, max: [0, 0] as Vec2 };
  return opts.version === "R12" ? writeR12(entities, layers, box) : writeR2000(entities, layers, box);
}

const DASHED = { name: "DASHED", description: "Dashed __ __ __", pattern: [9.525, -3.175] };

function writeR2000(entities: DxfEntity[], layers: DxfLayer[], box: { min: Vec2; max: Vec2 }): string {
  // Handles: every object gets one, and every owner is known before its children are written.
  let next = 1;
  const h = () => (next++).toString(16).toUpperCase();
  const root = h();
  const groups = h();
  const T = { vport: h(), ltype: h(), layer: h(), style: h(), view: h(), ucs: h(), appid: h(), dimstyle: h(), block: h() };
  const vport = h();
  const ltypes = ["ByBlock", "ByLayer", "Continuous", DASHED.name].map((name) => ({ name, handle: h() }));
  const layerHandles = layers.map(() => h());
  const style = h();
  const appid = h();
  const dimstyle = h();
  const model = { record: h(), begin: h(), end: h() };
  const paper = { record: h(), begin: h(), end: h() };
  const handles = entities.map(() => h());
  const seed = h();

  const o = new Out();
  // ---- header
  o.g(0, "SECTION");
  o.g(2, "HEADER");
  const variable = (name: string, write: () => void) => {
    o.g(9, name);
    write();
  };
  variable("$ACADVER", () => o.g(1, "AC1015"));
  variable("$DWGCODEPAGE", () => o.g(3, "ANSI_1252"));
  variable("$INSBASE", () => o.xy(10, [0, 0]));
  variable("$EXTMIN", () => o.xy(10, box.min));
  variable("$EXTMAX", () => o.xy(10, box.max));
  variable("$LIMMIN", () => o.xy(10, box.min, false));
  variable("$LIMMAX", () => o.xy(10, box.max, false));
  variable("$LUNITS", () => o.i(70, 2));
  variable("$LUPREC", () => o.i(70, 4));
  variable("$INSUNITS", () => o.i(70, 4));
  variable("$MEASUREMENT", () => o.i(70, 1));
  variable("$HANDSEED", () => o.g(5, seed));
  o.g(0, "ENDSEC");
  o.g(0, "SECTION");
  o.g(2, "CLASSES");
  o.g(0, "ENDSEC");

  // ---- tables
  o.g(0, "SECTION");
  o.g(2, "TABLES");
  const table = (name: string, handle: string, count: number, body: () => void, dim = false) => {
    o.g(0, "TABLE");
    o.g(2, name);
    o.g(5, handle);
    o.g(330, "0");
    o.g(100, "AcDbSymbolTable");
    o.i(70, count);
    if (dim) o.g(100, "AcDbDimStyleTable");
    body();
    o.g(0, "ENDTAB");
  };
  const record = (type: string, handle: string, owner: string, subclass: string, name: string, dim = false) => {
    o.g(0, type);
    o.g(dim ? 105 : 5, handle);
    o.g(330, owner);
    o.g(100, "AcDbSymbolTableRecord");
    o.g(100, subclass);
    o.g(2, name);
    o.i(70, 0);
  };
  const w = Math.max(box.max[0] - box.min[0], 1);
  const ht = Math.max(box.max[1] - box.min[1], 1);
  table("VPORT", T.vport, 1, () => {
    record("VPORT", vport, T.vport, "AcDbViewportTableRecord", "*Active");
    o.xy(10, [0, 0], false);
    o.xy(11, [1, 1], false);
    o.xy(12, [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2], false);
    o.xy(13, [0, 0], false);
    o.xy(14, [10, 10], false);
    o.xy(15, [10, 10], false);
    o.g(16, 0);
    o.g(26, 0);
    o.g(36, 1);
    o.g(17, 0);
    o.g(27, 0);
    o.g(37, 0);
    o.g(40, Math.max(ht, w / 1.5) * 1.1);
    o.g(41, 1.5);
    o.g(42, 50);
    o.g(43, 0);
    o.g(44, 0);
    o.g(50, 0);
    o.g(51, 0);
    o.i(71, 0);
    o.i(72, 100);
    o.i(73, 1);
    o.i(74, 3);
    o.i(75, 0);
    o.i(76, 0);
    o.i(77, 0);
    o.i(78, 0);
  });
  table("LTYPE", T.ltype, ltypes.length, () => {
    for (const l of ltypes) {
      record("LTYPE", l.handle, T.ltype, "AcDbLinetypeTableRecord", l.name);
      if (l.name === DASHED.name) {
        o.g(3, DASHED.description);
        o.i(72, 65);
        o.i(73, DASHED.pattern.length);
        o.g(40, DASHED.pattern.reduce((s, x) => s + Math.abs(x), 0));
        for (const x of DASHED.pattern) {
          o.g(49, x);
          o.i(74, 0);
        }
      } else {
        o.g(3, l.name === "Continuous" ? "Solid line" : "");
        o.i(72, 65);
        o.i(73, 0);
        o.g(40, 0);
      }
    }
  });
  table("LAYER", T.layer, layers.length, () => {
    layers.forEach((l, i) => {
      record("LAYER", layerHandles[i], T.layer, "AcDbLayerTableRecord", l.name);
      o.i(62, l.color ?? 7);
      o.g(6, l.lineType === "DASHED" ? DASHED.name : "Continuous");
      o.i(370, -3);
      o.g(390, "0");
    });
  });
  table("STYLE", T.style, 1, () => {
    record("STYLE", style, T.style, "AcDbTextStyleTableRecord", "Standard");
    o.g(40, 0);
    o.g(41, 1);
    o.g(50, 0);
    o.i(71, 0);
    o.g(42, 2.5);
    o.g(3, "txt");
    o.g(4, "");
  });
  table("VIEW", T.view, 0, () => {});
  table("UCS", T.ucs, 0, () => {});
  table("APPID", T.appid, 1, () => record("APPID", appid, T.appid, "AcDbRegAppTableRecord", "ACAD"));
  table(
    "DIMSTYLE",
    T.dimstyle,
    1,
    () => {
      record("DIMSTYLE", dimstyle, T.dimstyle, "AcDbDimStyleTableRecord", "Standard", true);
      o.g(40, 1);
      o.g(41, 2.5);
      o.g(42, 0.625);
      o.g(43, 3.75);
      o.g(44, 1.25);
      o.g(140, 2.5);
      o.g(141, 2.5);
      o.g(147, 0.625);
      o.i(77, 1);
      o.i(271, 2);
      o.i(272, 2);
    },
    true,
  );
  table("BLOCK_RECORD", T.block, 2, () => {
    record("BLOCK_RECORD", model.record, T.block, "AcDbBlockTableRecord", "*Model_Space");
    record("BLOCK_RECORD", paper.record, T.block, "AcDbBlockTableRecord", "*Paper_Space");
  });
  o.g(0, "ENDSEC");

  // ---- blocks: model space and paper space, empty (the entities are in ENTITIES)
  o.g(0, "SECTION");
  o.g(2, "BLOCKS");
  for (const [b, name, paperSpace] of [
    [model, "*Model_Space", false],
    [paper, "*Paper_Space", true],
  ] as const) {
    o.g(0, "BLOCK");
    o.g(5, b.begin);
    o.g(330, b.record);
    o.g(100, "AcDbEntity");
    if (paperSpace) o.i(67, 1);
    o.g(8, "0");
    o.g(100, "AcDbBlockBegin");
    o.g(2, name);
    o.i(70, 0);
    o.xy(10, [0, 0]);
    o.g(3, name);
    o.g(1, "");
    o.g(0, "ENDBLK");
    o.g(5, b.end);
    o.g(330, b.record);
    o.g(100, "AcDbEntity");
    if (paperSpace) o.i(67, 1);
    o.g(8, "0");
    o.g(100, "AcDbBlockEnd");
  }
  o.g(0, "ENDSEC");

  // ---- entities
  o.g(0, "SECTION");
  o.g(2, "ENTITIES");
  entities.forEach((e, i) => {
    const head = (type: string, subclass: string) => {
      o.g(0, type);
      o.g(5, handles[i]);
      o.g(330, model.record);
      o.g(100, "AcDbEntity");
      o.g(8, layerName(e.layer ?? "0"));
      o.g(100, subclass);
    };
    switch (e.type) {
      case "line":
        head("LINE", "AcDbLine");
        o.xy(10, e.a);
        o.xy(11, e.b);
        break;
      case "circle":
        head("CIRCLE", "AcDbCircle");
        o.xy(10, e.c);
        o.g(40, e.r);
        break;
      case "arc":
        head("ARC", "AcDbCircle");
        o.xy(10, e.c);
        o.g(40, e.r);
        o.g(100, "AcDbArc");
        o.g(50, wrapDegrees(e.start));
        o.g(51, wrapDegrees(e.end));
        break;
      case "polyline":
        head("LWPOLYLINE", "AcDbPolyline");
        o.i(90, e.points.length);
        o.i(70, e.closed ? 1 : 0);
        o.g(43, 0);
        e.points.forEach((p, k) => {
          o.xy(10, p, false);
          const b = e.bulges?.[k] ?? 0;
          if (Math.abs(b) > 1e-12) o.g(42, b);
        });
        break;
      case "ellipse": {
        head("ELLIPSE", "AcDbEllipse");
        o.xy(10, e.c);
        o.xy(11, e.major);
        o.g(210, 0);
        o.g(220, 0);
        o.g(230, 1);
        o.g(40, e.ratio);
        const whole = wrap(e.end - e.start) < 1e-12;
        const start = whole ? 0 : wrap(e.start);
        o.g(41, start);
        o.g(42, whole ? TAU : start + wrap(e.end - e.start));
        break;
      }
      case "spline": {
        head("SPLINE", "AcDbSpline");
        o.g(210, 0);
        o.g(220, 0);
        o.g(230, 1);
        const rational = !!e.weights && e.weights.some((x) => Math.abs(x - 1) > 1e-12);
        o.i(70, 8 | (e.closed ? 1 : 0) | (rational ? 4 : 0));
        o.i(71, e.degree);
        o.i(72, e.knots.length);
        o.i(73, e.control.length);
        o.i(74, 0);
        o.g(42, 1e-10);
        o.g(43, 1e-10);
        for (const k of e.knots) o.g(40, k);
        if (rational) for (const x of e.weights!) o.g(41, x);
        for (const p of e.control) o.xy(10, p);
        break;
      }
      case "point":
        head("POINT", "AcDbPoint");
        o.xy(10, e.at);
        break;
      case "text":
        head("TEXT", "AcDbText");
        o.xy(10, e.at);
        o.g(40, e.height);
        o.g(1, dxfText(e.text));
        if (e.rotation) o.g(50, e.rotation);
        if (e.align === "center") {
          o.i(72, 1);
          o.xy(11, e.at);
        }
        o.g(100, "AcDbText");
        break;
    }
  });
  o.g(0, "ENDSEC");

  // ---- objects: the root dictionary, with the (empty) group dictionary AutoCAD expects
  o.g(0, "SECTION");
  o.g(2, "OBJECTS");
  o.g(0, "DICTIONARY");
  o.g(5, root);
  o.g(330, "0");
  o.g(100, "AcDbDictionary");
  o.i(281, 1);
  o.g(3, "ACAD_GROUP");
  o.g(350, groups);
  o.g(0, "DICTIONARY");
  o.g(5, groups);
  o.g(330, root);
  o.g(100, "AcDbDictionary");
  o.i(281, 1);
  o.g(0, "ENDSEC");
  o.g(0, "EOF");
  return o.text();
}

function writeR12(entities: DxfEntity[], layers: DxfLayer[], box: { min: Vec2; max: Vec2 }): string {
  const o = new Out();
  o.g(0, "SECTION");
  o.g(2, "HEADER");
  o.g(9, "$ACADVER");
  o.g(1, "AC1009");
  o.g(9, "$INSBASE");
  o.xy(10, [0, 0]);
  o.g(9, "$EXTMIN");
  o.xy(10, box.min);
  o.g(9, "$EXTMAX");
  o.xy(10, box.max);
  // Not R12 variables, but readers that know them (most) take the units from them; R12 readers skip them.
  o.g(9, "$INSUNITS");
  o.i(70, 4);
  o.g(9, "$MEASUREMENT");
  o.i(70, 1);
  o.g(0, "ENDSEC");
  o.g(0, "SECTION");
  o.g(2, "TABLES");
  o.g(0, "TABLE");
  o.g(2, "LTYPE");
  o.i(70, 2);
  for (const [name, description, pattern] of [
    ["CONTINUOUS", "Solid line", [] as number[]],
    [DASHED.name, DASHED.description, DASHED.pattern],
  ] as const) {
    o.g(0, "LTYPE");
    o.g(2, name);
    o.i(70, 0);
    o.g(3, description);
    o.i(72, 65);
    o.i(73, pattern.length);
    o.g(40, pattern.reduce((s, x) => s + Math.abs(x), 0));
    for (const x of pattern) o.g(49, x);
  }
  o.g(0, "ENDTAB");
  o.g(0, "TABLE");
  o.g(2, "LAYER");
  o.i(70, layers.length);
  for (const l of layers) {
    o.g(0, "LAYER");
    o.g(2, l.name);
    o.i(70, 0);
    o.i(62, l.color ?? 7);
    o.g(6, l.lineType === "DASHED" ? DASHED.name : "CONTINUOUS");
  }
  o.g(0, "ENDTAB");
  o.g(0, "TABLE");
  o.g(2, "STYLE");
  o.i(70, 1);
  o.g(0, "STYLE");
  o.g(2, "STANDARD");
  o.i(70, 0);
  o.g(40, 0);
  o.g(41, 1);
  o.g(50, 0);
  o.i(71, 0);
  o.g(42, 2.5);
  o.g(3, "txt");
  o.g(4, "");
  o.g(0, "ENDTAB");
  o.g(0, "ENDSEC");
  o.g(0, "SECTION");
  o.g(2, "BLOCKS");
  o.g(0, "ENDSEC");
  o.g(0, "SECTION");
  o.g(2, "ENTITIES");
  for (const e of entities) {
    const layer = layerName(e.layer ?? "0");
    const head = (type: string) => {
      o.g(0, type);
      o.g(8, layer);
    };
    switch (e.type) {
      case "line":
        head("LINE");
        o.xy(10, e.a);
        o.xy(11, e.b);
        break;
      case "circle":
        head("CIRCLE");
        o.xy(10, e.c);
        o.g(40, e.r);
        break;
      case "arc":
        head("ARC");
        o.xy(10, e.c);
        o.g(40, e.r);
        o.g(50, wrapDegrees(e.start));
        o.g(51, wrapDegrees(e.end));
        break;
      case "polyline":
        head("POLYLINE");
        o.i(66, 1);
        o.xy(10, [0, 0]);
        o.i(70, e.closed ? 1 : 0);
        e.points.forEach((p, k) => {
          head("VERTEX");
          o.xy(10, p);
          const b = e.bulges?.[k] ?? 0;
          if (Math.abs(b) > 1e-12) o.g(42, b);
        });
        head("SEQEND");
        break;
      case "point":
        head("POINT");
        o.xy(10, e.at);
        break;
      case "text":
        head("TEXT");
        o.xy(10, e.at);
        o.g(40, e.height);
        o.g(1, dxfText(e.text));
        if (e.rotation) o.g(50, e.rotation);
        if (e.align === "center") {
          o.i(72, 1);
          o.xy(11, e.at);
        }
        break;
      default:
        // Ellipses and splines became polylines in forVersion.
        break;
    }
  }
  o.g(0, "ENDSEC");
  o.g(0, "EOF");
  return o.text();
}

function wrapDegrees(a: number): number {
  const w = a % 360;
  const v = w < 0 ? w + 360 : w;
  return Math.abs(v - 360) < 1e-10 ? 0 : v;
}

// ================================================================= reader

/** The units a DXF says its numbers are in ($INSUNITS), and what one of them is in mm. */
export interface DxfUnits {
  /** The $INSUNITS code; null when the file does not say. */
  code: number | null;
  /** "millimetres", "inches", ... */
  name: string;
  /** mm per drawing unit. */
  scale: number;
  /** The file does not say (or says "unitless"): read as millimetres. */
  assumed: boolean;
}

/** What a DXF file holds, read into mm. */
export interface DxfRead {
  /** The geometry, every entity with its layer, blocks exploded, in mm. */
  entities: DxfEntity[];
  /** The layers: each with how many entities it holds here, and whether the file had it off or frozen. */
  layers: { name: string; count: number; off?: boolean }[];
  units: DxfUnits;
  /** What was left out, by kind ("text": 3, "dimension": 2). */
  skipped: Record<string, number>;
  /** Anything else worth knowing (a block that is not there, a curve not in the XY plane). */
  warnings: string[];
  /** $ACADVER, when the file has one ("AC1015"). */
  version?: string;
}

/** $INSUNITS codes: [name, mm per unit]. */
const UNITS: Record<number, [string, number]> = {
  1: ["inches", 25.4],
  2: ["feet", 304.8],
  4: ["millimetres", 1],
  5: ["centimetres", 10],
  6: ["metres", 1000],
  8: ["microinches", 25.4e-6],
  9: ["thousandths of an inch", 0.0254],
  10: ["yards", 914.4],
  13: ["micrometres", 1e-3],
  14: ["decimetres", 100],
};

/** The mm per unit for an $INSUNITS code (inches 25.4), or null when it is not a length this reader takes. */
export function unitScale(code: number): number | null {
  return UNITS[code]?.[1] ?? null;
}

type Group = [number, string];
interface Rec {
  type: string;
  groups: Group[];
}

/** Kinds that hold no geometry for a sketch: counted under these names when skipped. */
const SKIP_NAMES: Record<string, string> = {
  TEXT: "text",
  MTEXT: "text",
  ATTRIB: "text",
  ATTDEF: "text",
  DIMENSION: "dimension",
  ARC_DIMENSION: "dimension",
  LARGE_RADIAL_DIMENSION: "dimension",
  HATCH: "hatch",
  LEADER: "leader",
  MULTILEADER: "leader",
  MLEADER: "leader",
  TOLERANCE: "tolerance",
  SOLID: "solid fill",
  TRACE: "solid fill",
  "3DFACE": "3D face",
  "3DSOLID": "3D solid",
  REGION: "region",
  BODY: "3D solid",
  MESH: "mesh",
  IMAGE: "image",
  WIPEOUT: "wipeout",
  VIEWPORT: "viewport",
  OLE2FRAME: "OLE object",
  XLINE: "construction line",
  RAY: "construction line",
  MLINE: "multiline",
};

/** Reads a DXF file's text. Throws DxfError when it is not an ASCII DXF. */
export function readDxf(text: string): DxfRead {
  if (text.startsWith("AutoCAD Binary DXF")) throw new DxfError("this is a binary DXF; save it as ASCII DXF (any version) and try again");
  const raw = text.replace(/^﻿/, "").split(/\r\n|\r|\n/);
  const groups: Group[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const code = Number.parseInt(raw[i].trim(), 10);
    if (!Number.isFinite(code)) {
      if (raw[i].trim() === "" && i + 1 >= raw.length - 1) break;
      throw new DxfError(`not a DXF file: line ${i + 1} should be a group code, but reads "${raw[i].trim().slice(0, 40)}"`);
    }
    groups.push([code, raw[i + 1]]);
  }
  if (!groups.some(([c, v]) => c === 0 && v.trim() === "SECTION")) throw new DxfError("not a DXF file: it has no SECTION");

  // Split into sections, each a list of records (a record starts at a 0 group).
  const sections = new Map<string, Rec[]>();
  const header = new Map<string, Group[]>();
  for (let i = 0; i < groups.length; i++) {
    if (groups[i][0] !== 0 || groups[i][1].trim() !== "SECTION") continue;
    const name = groups[i + 1]?.[0] === 2 ? groups[i + 1][1].trim() : "";
    i += 2;
    if (name === "HEADER") {
      let variable = "";
      for (; i < groups.length && !(groups[i][0] === 0 && groups[i][1].trim() === "ENDSEC"); i++) {
        const [c, v] = groups[i];
        if (c === 9) {
          variable = v.trim();
          header.set(variable, []);
        } else if (variable) header.get(variable)!.push([c, v]);
      }
      continue;
    }
    const recs: Rec[] = [];
    for (; i < groups.length && !(groups[i][0] === 0 && groups[i][1].trim() === "ENDSEC"); i++) {
      const [c, v] = groups[i];
      if (c === 0) recs.push({ type: v.trim(), groups: [] });
      else recs[recs.length - 1]?.groups.push([c, v]);
    }
    sections.set(name, [...(sections.get(name) ?? []), ...recs]);
  }

  const headerValue = (name: string, code: number): string | undefined => header.get(name)?.find(([c]) => c === code)?.[1].trim();
  const version = headerValue("$ACADVER", 1);
  const insunits = headerValue("$INSUNITS", 70);
  const code = insunits !== undefined ? Number.parseInt(insunits, 10) : null;
  const known = code !== null && Object.hasOwn(UNITS, code) ? UNITS[code] : null;
  const units: DxfUnits = known
    ? { code, name: known[0], scale: known[1], assumed: false }
    : { code, name: "millimetres", scale: 1, assumed: true };
  const warnings: string[] = [];
  if (code !== null && code !== 0 && !known) warnings.push(`the file's units ($INSUNITS ${code}) are not a length this reads: read as millimetres`);

  // Layers from the table: their names and whether they are off (negative colour) or frozen (flag 1).
  const layerInfo = new Map<string, { off: boolean }>();
  for (const r of sections.get("TABLES") ?? []) {
    if (r.type !== "LAYER") continue;
    const name = str(r, 2);
    if (!name) continue;
    layerInfo.set(name, { off: num(r, 62, 7) < 0 || (int(r, 70, 0) & 1) === 1 });
  }

  const skipped: Record<string, number> = {};
  const skip = (what: string, n = 1) => (skipped[what] = (skipped[what] ?? 0) + n);

  // Blocks: name -> base point and records.
  const blocks = new Map<string, { base: Vec2; recs: Rec[] }>();
  {
    let current: { name: string; base: Vec2; recs: Rec[] } | null = null;
    for (const r of sections.get("BLOCKS") ?? []) {
      if (r.type === "BLOCK") {
        current = { name: str(r, 2) ?? "", base: [num(r, 10, 0), num(r, 20, 0)], recs: [] };
        // An external reference has no geometry in this file.
        if ((int(r, 70, 0) & 4) === 4) current.name = "";
      } else if (r.type === "ENDBLK") {
        if (current?.name) blocks.set(current.name, { base: current.base, recs: current.recs });
        current = null;
      } else current?.recs.push(r);
    }
  }

  const out: DxfEntity[] = [];
  const insertsMissing = new Set<string>();
  /** Turns a list of records into entities, through the map `m`; layer "0" inside a block takes the insert's layer. */
  const walk = (recs: Rec[], m: Affine, outerLayer: string | null, depth: number) => {
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (int(r, 67, 0) === 1) {
        skip("paper space");
        continue;
      }
      if (int(r, 60, 0) === 1) {
        skip("invisible");
        continue;
      }
      const own = str(r, 8) ?? "0";
      const layer = outerLayer !== null && own === "0" ? outerLayer : own;
      if (r.type === "POLYLINE") {
        // R12 polylines: the vertices follow as records of their own, up to SEQEND.
        const vertices: Rec[] = [];
        while (i + 1 < recs.length && recs[i + 1].type === "VERTEX") vertices.push(recs[++i]);
        if (recs[i + 1]?.type === "SEQEND") i++;
        const e = polylineOf(r, vertices, layer, skip);
        if (e) emit(e, r, m);
        continue;
      }
      if (r.type === "INSERT") {
        const name = str(r, 2) ?? "";
        // Attributes after an insert are text: skip them with it.
        if (int(r, 66, 0) === 1) {
          while (i + 1 < recs.length && recs[i + 1].type === "ATTRIB") {
            i++;
            skip("text");
          }
          if (recs[i + 1]?.type === "SEQEND") i++;
        }
        const block = blocks.get(name);
        if (!block) {
          if (!name.startsWith("*")) insertsMissing.add(name);
          continue;
        }
        if (depth > 16) {
          warnings.push(`block "${name}" nests deeper than 16 levels: left out`);
          continue;
        }
        const at: Vec2 = [num(r, 10, 0), num(r, 20, 0)];
        const sx = num(r, 41, 1);
        const sy = num(r, 42, 1);
        const rotation = num(r, 50, 0);
        const cols = Math.max(1, int(r, 70, 1));
        const rows = Math.max(1, int(r, 71, 1));
        const dx = num(r, 44, 0);
        const dy = num(r, 45, 0);
        const ocs = extrusionMap(r);
        if (!ocs) {
          warnings.push(`block "${name}" is inserted out of the XY plane: left out`);
          continue;
        }
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            // Array copies step along the insert's own rotated axes.
            const rot = (rotation * Math.PI) / 180;
            const off: Vec2 = [col * dx * Math.cos(rot) - row * dy * Math.sin(rot), col * dx * Math.sin(rot) + row * dy * Math.cos(rot)];
            const place = compose(placement([at[0] + off[0], at[1] + off[1]], sx, sy, rotation), translation([-block.base[0], -block.base[1]]));
            walk(block.recs, compose(m, compose(ocs, place)), layer, depth + 1);
          }
        }
        continue;
      }
      if (r.type === "VERTEX" || r.type === "SEQEND" || r.type === "ATTRIB") continue;
      const e = entityOf(r, layer, skip, warnings);
      if (e) emit(e, r, m);
    }
  };
  const emit = (e: DxfEntity, r: Rec, m: Affine) => {
    // Lines, points, ellipses and splines are in world coordinates; arcs, circles, polylines and text in the
    // entity's own (OCS), which for a mirrored ("extrusion 0,0,-1") entity is x turned round.
    const ocsTypes = e.type === "arc" || e.type === "circle" || e.type === "polyline" || e.type === "text";
    const ocs = extrusionMap(r);
    if (ocs === null && !(e.type === "line" || e.type === "point")) {
      skip("not in the XY plane");
      return;
    }
    let local: DxfEntity[] = [e];
    if (ocs && ocsTypes) local = transformEntity(e, ocs);
    else if (ocs && ocs.a < 0 && e.type === "ellipse") local = [{ ...e, start: -e.end, end: -e.start }];
    for (const x of local) out.push(...transformEntity(x, m));
  };
  walk(sections.get("ENTITIES") ?? [], IDENTITY, null, 0);
  if (insertsMissing.size) warnings.push(`the file inserts block${insertsMissing.size === 1 ? "" : "s"} ${[...insertsMissing].map((n) => `"${n}"`).join(", ")} it does not define: left out`);

  // Into millimetres.
  const entities = units.scale === 1 ? out : out.flatMap((e) => transformEntity(e, { a: units.scale, b: 0, c: 0, d: units.scale, e: 0, f: 0 }));
  const counts = new Map<string, number>();
  for (const e of entities) counts.set(e.layer ?? "0", (counts.get(e.layer ?? "0") ?? 0) + 1);
  const layers = [...new Set([...layerInfo.keys(), ...counts.keys()])]
    .filter((n) => counts.has(n))
    .map((name) => ({ name, count: counts.get(name)!, ...(layerInfo.get(name)?.off ? { off: true } : {}) }));
  return { entities, layers, units, skipped, warnings, ...(version ? { version } : {}) };
}

function str(r: Rec, code: number): string | undefined {
  const g = r.groups.find(([c]) => c === code);
  return g ? g[1].trim() : undefined;
}

function num(r: Rec, code: number, fallback: number): number {
  const s = str(r, code);
  const v = s === undefined ? NaN : Number.parseFloat(s);
  return Number.isFinite(v) ? v : fallback;
}

function int(r: Rec, code: number, fallback: number): number {
  return Math.round(num(r, code, fallback));
}

/** Every value of a group code, in order, as numbers. */
function nums(r: Rec, code: number): number[] {
  return r.groups.filter(([c]) => c === code).map(([, v]) => Number.parseFloat(v.trim()));
}

/** Points written as repeated x (code) and y (code + 10) groups. */
function pointsOf(r: Rec, code: number): Vec2[] {
  const xs = nums(r, code);
  const ys = nums(r, code + 10);
  return xs.slice(0, ys.length).map((x, i) => [x, ys[i]] as Vec2);
}

/**
 * The map from an entity's own coordinates to the XY plane: identity for the
 * usual extrusion (0, 0, 1), x turned round for (0, 0, -1) (a mirrored arc or
 * circle), null when the entity is not in the XY plane at all.
 */
function extrusionMap(r: Rec): Affine | null {
  const nx = num(r, 210, 0);
  const ny = num(r, 220, 0);
  const nz = num(r, 230, 1);
  const l = Math.hypot(nx, ny, nz) || 1;
  if (Math.abs(nx / l) > 1e-9 || Math.abs(ny / l) > 1e-9) return null;
  return nz < 0 ? { a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 } : IDENTITY;
}

function entityOf(r: Rec, layer: string, skip: (what: string) => void, warnings: string[]): DxfEntity | null {
  const base = { layer };
  switch (r.type) {
    case "LINE": {
      const a: Vec2 = [num(r, 10, 0), num(r, 20, 0)];
      const b: Vec2 = [num(r, 11, 0), num(r, 21, 0)];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-12) {
        skip("zero-length line");
        return null;
      }
      return { type: "line", a, b, ...base };
    }
    case "CIRCLE": {
      const r0 = num(r, 40, 0);
      if (!(r0 > 0)) return (skip("zero circle"), null);
      return { type: "circle", c: [num(r, 10, 0), num(r, 20, 0)], r: r0, ...base };
    }
    case "ARC": {
      const r0 = num(r, 40, 0);
      if (!(r0 > 0)) return (skip("zero arc"), null);
      return { type: "arc", c: [num(r, 10, 0), num(r, 20, 0)], r: r0, start: num(r, 50, 0), end: num(r, 51, 360), ...base };
    }
    case "LWPOLYLINE": {
      // Vertices are 10/20 pairs; a 42 (bulge) after a vertex bends the piece leaving it.
      const points: Vec2[] = [];
      const bulges: number[] = [];
      for (const [c, v] of r.groups) {
        if (c === 10) {
          points.push([Number.parseFloat(v), 0]);
          bulges.push(0);
        } else if (c === 20 && points.length) points[points.length - 1][1] = Number.parseFloat(v);
        else if (c === 42 && points.length) bulges[bulges.length - 1] = Number.parseFloat(v);
      }
      if (points.length < 2) return (skip("empty polyline"), null);
      const closed = (int(r, 70, 0) & 1) === 1;
      return { type: "polyline", points, ...(bulges.some((b) => b !== 0) ? { bulges } : {}), ...(closed ? { closed: true } : {}), ...base };
    }
    case "ELLIPSE": {
      const ratio = num(r, 40, 1);
      const major: Vec2 = [num(r, 11, 1), num(r, 21, 0)];
      if (!(ratio > 0) || Math.hypot(...major) < 1e-12) return (skip("zero ellipse"), null);
      return { type: "ellipse", c: [num(r, 10, 0), num(r, 20, 0)], major, ratio: Math.min(ratio, 1), start: num(r, 41, 0), end: num(r, 42, TAU), ...base };
    }
    case "SPLINE": {
      const flags = int(r, 70, 0);
      const degree = int(r, 71, 3);
      const knots = nums(r, 40);
      const weights = nums(r, 41);
      const control = pointsOf(r, 10);
      const fit = pointsOf(r, 11);
      const closed = (flags & 1) === 1;
      if (control.length >= 2 && knots.length !== control.length + degree + 1) {
        if (fit.length >= 2) return { type: "spline", degree, control: [], knots: [], fit, ...(closed ? { closed: true } : {}), ...base };
        warnings.push(`a spline on layer "${layer}" has ${knots.length} knots for ${control.length} control points of degree ${degree}: left out`);
        return null;
      }
      if (control.length < 2 && fit.length < 2) return (skip("empty spline"), null);
      return {
        type: "spline",
        degree,
        control,
        knots: control.length >= 2 ? knots : [],
        ...(weights.length === control.length && weights.some((x) => x !== 1) ? { weights } : {}),
        ...(fit.length >= 2 ? { fit } : {}),
        ...(closed ? { closed: true } : {}),
        ...base,
      };
    }
    case "POINT":
      return { type: "point", at: [num(r, 10, 0), num(r, 20, 0)], ...base };
    default: {
      skip(SKIP_NAMES[r.type] ?? r.type.toLowerCase());
      return null;
    }
  }
}

/** An R12 POLYLINE and its VERTEX records as one polyline; meshes and polyface meshes are skipped. */
function polylineOf(r: Rec, vertices: Rec[], layer: string, skip: (what: string) => void): DxfEntity | null {
  const flags = int(r, 70, 0);
  if (flags & 16 || flags & 64) {
    skip("mesh");
    return null;
  }
  // A spline-fit polyline's frame (control) vertices are not on the curve: keep the fitted ones.
  const kept = vertices.filter((v) => (int(v, 70, 0) & 16) === 0);
  const points = kept.map((v) => [num(v, 10, 0), num(v, 20, 0)] as Vec2);
  const bulges = flags & 8 ? [] : kept.map((v) => num(v, 42, 0));
  if (points.length < 2) {
    skip("empty polyline");
    return null;
  }
  const closed = (flags & 1) === 1;
  return { type: "polyline", points, ...(bulges.some((b) => b !== 0) ? { bulges } : {}), ...(closed ? { closed: true } : {}), layer };
}

/** "3 texts", "1 dimension": what was skipped, for a report. */
export function skippedText(skipped: Record<string, number>): string {
  const plural = (what: string, n: number) =>
    n === 1 || what.endsWith("space") ? what : /(s|x|ch|sh)$/.test(what) ? `${what}es` : what.endsWith("y") ? `${what.slice(0, -1)}ies` : `${what}s`;
  return Object.entries(skipped)
    .map(([what, n]) => `${n} ${plural(what, n)}`)
    .join(", ");
}

/** The points of every curve, for checks and previews. */
export { entityPoints };
