// The Cocaide feature document (.cocaide.json). This is the single source of
// truth: the B-rep, the mesh and every measurement are derived from it.

import { PLUGIN_OPS, type PluginFeature } from "../features/types";
import type { HoleFit, HoleKind, ThreadSpec } from "../features/hole/standards";
import type { DrawingTable } from "../drafting/tables/types";
import type { CutListSettings } from "./cutListSettings";
import type { Tolerance } from "../drafting/tolerance";
import type { GdtCharacteristic } from "../drafting/symbols/glyphs";
export type { Tolerance } from "../drafting/tolerance";
export type { GdtCharacteristic } from "../drafting/symbols/glyphs";

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export const DOCUMENT_VERSION = 1;

export interface CocaideDocument {
  version: 1;
  /** Document units. v1 stores millimetres only; conversions happen before a value enters the document. */
  units: "mm";
  name: string;
  /** Named numbers. Any numeric field of a feature may be an expression over them: "=plate_t * 2". */
  parameters?: Record<string, number>;
  /** Used for the mass measurement. Defaults to steel (7850 kg/m³) when absent. */
  material?: Material;
  /** A body's own material, by body name, instead of the part's (Phase M). */
  bodyMaterials?: Record<string, Material>;
  /** Where the part came from, kept as notes (a drawing's title block). Stored, never simulated. */
  source?: DocumentSource;
  /** The part's properties (Phase P): its number, description, revision ... The drawing's title block, the cut list and STEP export read them. */
  properties?: PartProperties;
  /** A photo pinned under the part as a reference. Never geometry. */
  photo?: PhotoUnderlay;
  /** Weldment profiles the part uses, by name: its own copies, so it opens anywhere. */
  profiles?: Record<string, ProfileDef>;
  /** Named points a frame is built on (Phase J). In the file, coordinates may be expressions. */
  nodes?: Record<string, Vec3>;
  /** The weld table: notes, stored and listed, never modelled. */
  welds?: Weld[];
  /** The cut list's text and settings (Phase Q): descriptions, finishes, custom properties, stock bars and kerf, kept item numbers (src/doc/cutListSettings.ts). */
  cutList?: CutListSettings;
  features: Feature[];
  /** The part's fabrication drawing (Phase L): views of the rebuilt part, annotated. */
  drawing?: Drawing;
}

// ---------------------------------------------------------------- drawing

/**
 * The part's drawing (Phase Q; Phase L had one sheet): sheets of views
 * projected from the rebuilt solid, annotated. Every number on it is measured
 * on the rebuild; only notes and the title block are typed. Coordinates on a
 * sheet are mm from its lower left corner, y up.
 *
 * A Phase L drawing ({ sheet, views, annotations }) is read as one sheet
 * (src/doc/drawing.ts migrateDrawing); it is written back in this shape the
 * first time the drawing is edited.
 */
export interface Drawing {
  /** One or more; views and annotations have ids unique across all of them. */
  sheets: DrawingSheet[];
  /** The drafting standard: arrowheads, lettering, symbols and the default projection. Default ISO. */
  standard?: DraftingStandard;
  /** The units the drawing shows (the model is mm). Default mm. */
  units?: "mm" | "in";
  /** "ISO 2768-mK", or a title-block tolerance block "X.X ±0.5, X.XX ±0.1, ANG ±0.5°". */
  generalTolerance?: string;
  /** The drawing's own properties, for title-block fields and notes that link them ($PRP:"name"). */
  properties?: Record<string, string>;
  /** The revision history, newest last: the revision block lists it. */
  revisions?: Revision[];
  /** Decimal places dimensions are written to unless they say (default: as few as they need, up to one). */
  precision?: number;
  /** Dimensions in the other unit too, in brackets ("25 [0.984]"). */
  dualUnits?: boolean;
}
export const DRAWING_KEYS = ["sheets", "standard", "units", "generalTolerance", "properties", "revisions", "precision", "dualUnits"] as const;
export const DRAFTING_STANDARDS = ["ISO", "ASME"] as const;
export type DraftingStandard = (typeof DRAFTING_STANDARDS)[number];

export interface Revision {
  /** "A", "B", "02". */
  rev: string;
  description?: string;
  /** "2026-11-04". */
  date?: string;
  by?: string;
  approved?: string;
  /** Where on the sheet it changed: a zone of the border grid, "C4". */
  zone?: string;
}
export const REVISION_KEYS = ["rev", "description", "date", "by", "approved", "zone"] as const;

/**
 * Paper sizes, landscape, mm: ISO 216 A0–A4 and ANSI/ASME Y14.1 A–E. A
 * portrait sheet swaps them.
 */
export const SHEET_SIZES = {
  A4: [297, 210],
  A3: [420, 297],
  A2: [594, 420],
  A1: [841, 594],
  A0: [1189, 841],
  "ANSI A": [279.4, 215.9],
  "ANSI B": [431.8, 279.4],
  "ANSI C": [558.8, 431.8],
  "ANSI D": [863.6, 558.8],
  "ANSI E": [1117.6, 863.6],
} as const;
export type SheetSize = keyof typeof SHEET_SIZES;
export const PROJECTIONS = ["third", "first"] as const;
export type Projection = (typeof PROJECTIONS)[number];
export const SHEET_ORIENTATIONS = ["landscape", "portrait"] as const;
/**
 * The sheet's border and title block: "iso" (ISO 5457 border with zones, an
 * ISO 7200 title block), "ansi" (ASME Y14.1 border and title block with the
 * tolerance block), "minimal" (a border and one strip), "classic" (Phase L's
 * block, which old drawings keep).
 */
export const SHEET_TEMPLATES = ["iso", "ansi", "minimal", "classic"] as const;
export type SheetTemplate = (typeof SHEET_TEMPLATES)[number];

/**
 * The title block's fields. Each is text and may link a property:
 * `$PRP:"partNumber"` (the drawing's properties, then the part's),
 * `$PRPMODEL:"mass"` (measured). An unset field shows its default link.
 */
export const TITLE_FIELDS = [
  "title",
  "subtitle",
  "number",
  "revision",
  "drawnBy",
  "date",
  "checkedBy",
  "checkedDate",
  "approvedBy",
  "approvedDate",
  "company",
  "material",
  "finish",
  "mass",
] as const;
export type TitleField = (typeof TITLE_FIELDS)[number];

/** The paper: size, orientation, template and what its title block says. */
export type SheetFormat = {
  size: SheetSize;
  /** Default landscape. */
  orientation?: (typeof SHEET_ORIENTATIONS)[number];
  /** Default "iso" (ASME drawings: "ansi"). */
  template?: SheetTemplate;
} & Partial<Record<TitleField, string>>;
export const FORMAT_KEYS = ["size", "orientation", "template", ...TITLE_FIELDS] as const;

export interface DrawingSheet {
  /** "sheet1". */
  id: string;
  /** Its tab's name. Default "Sheet <n>". */
  name?: string;
  format: SheetFormat;
  /** "1:10", "2:1". Without it, the largest standard scale that fits. */
  scale?: string;
  /** Third-angle (the top view above the front) or first-angle (below). */
  projection: Projection;
  views: DrawingView[];
  annotations: Annotation[];
  /** Tables placed on the sheet (src/drafting/tables). */
  tables?: DrawingTable[];
}
export const SHEET_KEYS = ["id", "name", "format", "scale", "projection", "views", "annotations", "tables"] as const;

/** Phase L's sheet: what migrateDrawing reads. */
export interface LegacySheet {
  size: "A4" | "A3" | "A2" | "A1" | "A0";
  scale?: string;
  projection: Projection;
  title?: string;
  number?: string;
  revision?: string;
  drawnBy?: string;
  date?: string;
}

/** Named orientations of a model view. "iso" is from the front, right and above. */
export const VIEW_LOOKS = ["front", "back", "top", "bottom", "left", "right", "iso", "dimetric", "trimetric"] as const;
export type ViewLook = (typeof VIEW_LOOKS)[number];

/**
 * What a view is: "model" (a named or custom orientation of the part),
 * "projected" (from a parent view, kept aligned with it), "section" (the
 * parent cut along a line drawn on it), "detail" (a part of the parent,
 * enlarged), "auxiliary" (looking square at an edge seen in the parent).
 */
export const VIEW_KINDS = ["model", "projected", "section", "detail", "auxiliary"] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];
/** Where a projected view is from its parent: the four sides (orthographic), or a corner (an iso from that corner). */
export const PROJECT_DIRECTIONS = ["left", "right", "up", "down", "upLeft", "upRight", "downLeft", "downRight"] as const;
export type ProjectDirection = (typeof PROJECT_DIRECTIONS)[number];
/**
 * How a view draws the part: every edge solid ("visible"), hidden edges dashed
 * ("hidden"), hidden edges left out ("removed", the default), faces shaded
 * ("shaded"), or shaded with the visible edges over them ("shadedEdges").
 */
export const DISPLAY_MODES = ["visible", "hidden", "removed", "shaded", "shadedEdges"] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];
/** Edges between faces that meet smoothly (a fillet's): drawn ("visible"), thin long-dash ("phantom"), or left out ("removed", the default). */
export const TANGENT_MODES = ["visible", "phantom", "removed"] as const;
export type TangentMode = (typeof TANGENT_MODES)[number];
/** A detail view's look: its circle and label ("circle"), with a leader from the parent's circle ("connected"), or with no boundary drawn round the detail ("noBoundary"). */
export const DETAIL_STYLES = ["circle", "connected", "noBoundary"] as const;
export type DetailStyle = (typeof DETAIL_STYLES)[number];
/**
 * Section hatching (ISO 128-50 / ANSI patterns): "general" (45° lines),
 * "steel" (pairs of lines), "aluminium" (lines and dashes), "copper" (brass,
 * bronze: alternate lines dashed), "plastic" (cross-hatch), "rubber" (dense
 * cross-hatch), "wood" (grain), "concrete" (dots and lines), "solid" (filled,
 * for thin sections), "none". Default: from the body's material.
 */
export const HATCH_PATTERNS = ["general", "steel", "aluminium", "copper", "plastic", "rubber", "wood", "concrete", "solid", "none"] as const;
export type HatchPattern = (typeof HATCH_PATTERNS)[number];
export interface HatchStyle {
  pattern?: HatchPattern;
  /** Degrees from the sheet's x axis. Default 45° (each body of a weldment its own). */
  angle?: number;
  /** Between lines, sheet mm. Default by the view's size (2–4 mm). */
  spacing?: number;
}
export const HATCH_KEYS = ["pattern", "angle", "spacing"] as const;

/** A break: the view shortened by leaving out the part between `from` and `to` (view mm along x or y). Dimensions still read true lengths. */
export interface ViewBreak {
  axis: "x" | "y";
  from: number;
  to: number;
  /** Paper left between the break lines, sheet mm. Default 6. */
  gap?: number;
  /** Break lines: "zigzag" (default), "straight" or "curved" (for round bars and tubes). */
  style?: "zigzag" | "straight" | "curved";
}
export const BREAK_KEYS = ["axis", "from", "to", "gap", "style"] as const;

/** A broken-out section: the material inside `profile` (view mm, closed) removed `depth` mm into the part from its nearest face. */
export interface BrokenOut {
  profile: Vec2[];
  depth: number;
}

/**
 * A geometry reference: a point, edge or circle of a view, kept as text so it
 * survives a rebuild where the model's provenance allows (src/drafting/georef.ts):
 * "<view>:e<edgeKey>" an edge, "<view>:v<edgeKey>.<0|1>" an end of one,
 * "<view>:c<edgeKey>" a circle's or arc's centre, "<view>:m<edgeKey>" an
 * edge's midpoint, "<view>:q<edgeKey>.<0-3>" a circle's quadrant point, and
 * the Phase L points "<view>:A" (a node), "<view>:leg_a.start", "<view>:hole_1",
 * "<view>:@left".
 */
export type GeoRef = string;

export interface DrawingView {
  id: string;
  /** Default "model". */
  kind?: ViewKind;
  /** model: a named orientation (default "front"). */
  look?: ViewLook;
  /** model: a custom orientation instead: from the part toward the viewer, and which way is up on the sheet. */
  orientation?: { eye: Vec3; up?: Vec3 };
  /** projected, section, detail, auxiliary: the view it is made from. */
  parent?: string;
  /** projected: which side of the parent it is drawn. */
  direction?: ProjectDirection;
  /** section: the cutting line, two or more points on the parent (view mm, the parent's frame). */
  line?: Vec2[];
  /** section, detail, auxiliary: its letter ("A"). Default the next free one. */
  label?: string;
  /** section: cut only from the line's first point to its last, not beyond (a half section: draw the line from outside the part to its centre). */
  half?: boolean;
  /** section: an aligned section, the line's second segment turned into the plane of its first about the middle point (three points). */
  aligned?: boolean;
  /** section: look the other way along the line. */
  flip?: boolean;
  /** section: how far behind the cut to show, mm. Default all of it. */
  depth?: number;
  /** section: draw the part behind the cut (default true); false shows the cut faces alone. */
  showBehind?: boolean;
  /** section, brokenOut: the hatch, instead of the material's. */
  hatch?: HatchStyle;
  /** detail: the circle on the parent (view mm). */
  circle?: { at: Vec2; r: number };
  /** detail: a closed outline on the parent instead of a circle (view mm). */
  profile?: Vec2[];
  /** detail: how it is drawn (default "circle"). */
  style?: DetailStyle;
  /** auxiliary: the straight edge on the parent to look square at. */
  edge?: GeoRef;
  /** The view's centre on the sheet. Without it, the view is placed with the others (a projected view stays lined up with its parent). */
  at?: Vec2;
  /** Its own scale; else the sheet's (a detail: twice its parent's). */
  scale?: string;
  /** Default "removed". */
  display?: DisplayMode;
  /** Default "removed". */
  tangent?: TangentMode;
  /** Cosmetic threads of tapped holes and thread features (default true). */
  threads?: boolean;
  /** Shortened view. */
  breaks?: ViewBreak[];
  /** Only what is inside this closed outline (view mm) is shown. */
  crop?: Vec2[];
  brokenOut?: BrokenOut[];
  /** Only these bodies (a weldment's members, a multibody part's bodies). Default all. */
  bodies?: string[];
  /** Its label under it ("SECTION A-A", "DETAIL B (2:1)"). Default: shown for sections, details, auxiliaries and views at their own scale. */
  showLabel?: boolean;
  /** The scale in its label. Default when the view's scale is not the sheet's. */
  showScale?: boolean;
}
export const VIEW_KEYS = [
  "id",
  "kind",
  "look",
  "orientation",
  "parent",
  "direction",
  "line",
  "label",
  "half",
  "aligned",
  "flip",
  "depth",
  "showBehind",
  "hatch",
  "circle",
  "profile",
  "style",
  "edge",
  "at",
  "scale",
  "display",
  "tangent",
  "threads",
  "breaks",
  "crop",
  "brokenOut",
  "bodies",
  "showLabel",
  "showScale",
] as const;

/**
 * A point a dimension runs from or to: a node ("A"), a member's end
 * ("leg_a.start", "leg_a.end"), a hole's centre ("hole_1"), a side of the
 * view's outline ("@left", "@right", "@top", "@bottom"), or a GeoRef
 * ("front:vextrude_1/l3.0", "front:chole_1/c0").
 */
export type DrawingPoint = string;
export const OUTLINE_SIDES = ["@left", "@right", "@top", "@bottom"] as const;
export const DIMENSION_DIRECTIONS = ["horizontal", "vertical", "aligned"] as const;
export type DimensionDirection = (typeof DIMENSION_DIRECTIONS)[number];

// ------------------------------------------------------------ annotations (Phase Q wave Q2A)
//
// Every annotation is measured on the rebuild: none takes a value. Places
// (`at`) of annotations in a view are sheet mm from the view's centre, so
// they move with it; a sheet's own (a note, a table, free sketching) are
// sheet mm from its lower left corner. Where an annotation is attached is a
// GeoRef ("front:ehole_1/c0"), a dimension's id, or both.

/**
 * What a dimension measures (default "linear"):
 *  linear     two points (from, to), an edge's length (refs [edge]), two parallel edges' distance, a point's from an edge;
 *  angular    two edges (refs [edge, edge]) or three points (refs [end, vertex, end]); `major` for the reflex side;
 *  radius     an arc or circle (refs [edge]): "R5";
 *  diameter   a circle (refs [edge]): "Ø10"; or a cylinder's two sides seen from the side (refs [edge, edge]): a linear "Ø";
 *  ordinate   an origin and points, each its distance from the origin along one direction;
 *  baseline   an origin and points, each its own dimension from the origin, stacked;
 *  chain      points in a row, each dimension from the one before;
 *  arcLength  an arc's length along it (refs [edge]): "⌒25.1";
 *  chamfer    a chamfer's edge (refs [edge]): "C2" or "2 × 45°";
 *  pathLength edges end to end (refs [edge, ...]): their length together.
 */
export const DIMENSION_KINDS = ["linear", "angular", "radius", "diameter", "ordinate", "baseline", "chain", "arcLength", "chamfer", "pathLength"] as const;
export type DimensionKind = (typeof DIMENSION_KINDS)[number];
/** Where a dimension's arrows go: inside its extension lines (or the circle), outside them, or wherever they fit (default). */
export const ARROW_PLACES = ["auto", "inside", "outside"] as const;
export type ArrowPlace = (typeof ARROW_PLACES)[number];

/**
 * A dimension, measured on the rebuild: between two points, a member's cut
 * length along it (`member`), or what its GeoRefs are (`refs`, by `kind`).
 */
export interface DimensionAnnotation {
  id: string;
  type: "dimension";
  view: string;
  kind?: DimensionKind;
  from?: DrawingPoint;
  to?: DrawingPoint;
  member?: string;
  /** The edges, points or circles it measures (see DIMENSION_KINDS). */
  refs?: GeoRef[];
  /** ordinate, baseline: the zero; chain: the first point. */
  origin?: DrawingPoint;
  /** ordinate, baseline, chain: the points measured. */
  points?: DrawingPoint[];
  /** Default: horizontal when the points are further apart across the view than up it, else vertical. A member's is along it. */
  direction?: DimensionDirection;
  /** Sheet mm from the part to the dimension line; the sign picks the side (+ above or right). Default: stacked outside the view. */
  offset?: number;
  /** The text's place, sheet mm from the view's centre (dragged there). A linear dimension's line goes through it. */
  at?: Vec2;
  /** angular: the reflex angle (over 180°) instead of the one under. */
  major?: boolean;
  /** radius: a jogged leader to a centre off the view (a large, foreshortened radius). */
  jog?: boolean;
  arrows?: ArrowPlace;
  /** The text and leader on the other side. */
  flip?: boolean;
  /** Before the value ("2×", "SR", "<MOD-DIAM>"): tokens and drafting characters allowed. */
  prefix?: string;
  /** After it ("THRU", "TYP"). */
  suffix?: string;
  /** How many alike features it stands for: "4×" before it. */
  count?: number;
  /** "TYP" after it: the same size wherever it recurs. */
  typ?: boolean;
  /** In an inspection oval: checked at inspection (ASME). */
  inspection?: boolean;
  tolerance?: Tolerance;
  /** Decimal places (default the drawing's). */
  precision?: number;
  /** The other unit too, in brackets (default the drawing's `dualUnits`). */
  dual?: boolean;
  /** Where it was last drawn, sheet mm from the view's centre (its two feet and its text): a dangling dimension is drawn there, in the warning colour. */
  last?: AnnotationPlace;
}

/** Where an annotation was last drawn: points (sheet mm from its view's centre) and what it said. */
export interface AnnotationPlace {
  pts: Vec2[];
  text: string;
}

/** The leader ends (arrowheads) a leader may have (ISO 128-22): filled closed, open, an integral dot (on a surface), none. */
export const ARROW_STYLES = ["closed", "open", "dot", "none", "slash"] as const;
export type ArrowStyle = (typeof ARROW_STYLES)[number];

/** A leader from an annotation's text to what it points at, through bends; `spline` draws it smooth. */
export interface Leader {
  /** What it points at: a GeoRef, or a point (sheet mm: from the view's centre for a view's annotation, else from the sheet's corner). */
  to: GeoRef | Vec2;
  /** Bends between the text and `to`, the same mm as `to`. */
  via?: Vec2[];
  arrow?: ArrowStyle;
  spline?: boolean;
}

/** "4× Ø8 THRU" on a hole the view sees as a circle: from the hole feature (Hole Wizard), its counterbore ⌴, countersink ⌵, depth ↧ and thread. */
export interface HoleAnnotation {
  id: string;
  type: "hole";
  view: string;
  hole: string;
  /** Which of its holes the leader points at (a circle GeoRef). Default: the one nearest the corner it is called out from. */
  on?: GeoRef;
  /** The text, from the view's centre, sheet mm. Default: beside the hole. */
  at?: Vec2;
  /** How many it stands for (default: the feature's holes and their pattern copies). */
  count?: number;
  /** "EQ SP" and the pitch circle (a circular pattern): default on for a circular pattern. */
  pattern?: boolean;
  prefix?: string;
  suffix?: string;
  /** On the bore's diameter: "Ø8 H7". */
  tolerance?: Tolerance;
}

/** The balloon shapes (ISO 6433 circle, and the shapes BOMs use): circle, hexagon, triangle, square box, a circle split across (item over quantity), flag. */
export const BALLOON_SHAPES = ["circle", "hexagon", "triangle", "box", "split", "flag"] as const;
export type BalloonShape = (typeof BALLOON_SHAPES)[number];

/** A cut list (or BOM) item number in a balloon, with a leader to its member or body. */
export interface BalloonAnnotation {
  id: string;
  type: "balloon";
  view: string;
  /** The member it numbers (or its body's name). */
  member?: string;
  /** A body (a plate, a part of a multibody part) by name. */
  body?: string;
  /** Or the item number itself. */
  item?: number;
  /** What the leader points at instead of the member's longest visible line. */
  on?: GeoRef;
  /** The balloon, from the view's centre, sheet mm. Default: outside the view, near the member. */
  at?: Vec2;
  shape?: BalloonShape;
  /** Its diameter, mm (default 10; 12 with three digits). */
  size?: number;
  /** "2×" beside it (true: the item's quantity). A split balloon writes it in its lower half. */
  quantity?: number | boolean;
  /** More items stacked under it, sharing its leader (members, bodies or item numbers). */
  stack?: (string | number)[];
  arrow?: ArrowStyle;
}

/**
 * The weld symbol's elementary symbols (ISO 2553 / AWS A2.4): fillet, butt
 * welds (square, V, bevel, U, J, flare-V, flare-bevel), plug or slot, spot,
 * seam, edge, back or backing weld, surfacing, stud.
 */
export const WELD_SYMBOLS = ["fillet", "square", "v", "bevel", "u", "j", "flareV", "flareBevel", "plug", "slot", "spot", "seam", "edge", "backWeld", "backing", "surfacing", "stud"] as const;
export type WeldSymbolType = (typeof WELD_SYMBOLS)[number];
export const WELD_CONTOURS = ["flush", "convex", "concave"] as const;
/** One side's weld: its symbol and what it says. Sizes are mm. */
export interface WeldSymbolSide {
  symbol: WeldSymbolType;
  /** Fillet leg (z) or throat (a): "a5" or "z7"; a butt weld's depth of penetration (s). A number is the throat a (ISO) or leg (AWS). */
  size?: number | string;
  /** Length of each weld (an intermittent weld's), mm. */
  length?: number;
  /** Intermittent: how many welds, and their pitch (centre to centre; ISO writes the gap (e) between). */
  count?: number;
  pitch?: number;
  /** A groove's angle, degrees, and root opening, mm. */
  angle?: number;
  root?: number;
  contour?: (typeof WELD_CONTOURS)[number];
  /** How it is finished (ISO 1302's letters, AWS: C chip, G grind, M machine, R roll, H hammer, P peen). */
  finish?: string;
}
export const WELD_SIDE_KEYS = ["symbol", "size", "length", "count", "pitch", "angle", "root", "contour", "finish"] as const;

/**
 * A weld symbol (ISO 2553 / AWS A2.4): a reference line (ISO adds a dashed
 * identification line for the other side), an arrow to the joint, a symbol
 * on the arrow side, the other side or both, all-around, field weld, a tail
 * with the process and a reference, and more reference lines for welds made
 * in order. `weld` takes it from the weld table (and keeps up with it).
 */
export interface WeldAnnotation {
  id: string;
  type: "weld";
  view: string;
  /** The weld table's weld: its type, size, length, sides, process. */
  weld?: string;
  /** What the arrow points at (an edge or point GeoRef). Default: where the weld's bodies meet. */
  on?: GeoRef;
  /** The symbol's reference line, from the view's centre, sheet mm. */
  at?: Vec2;
  arrowSide?: WeldSymbolSide;
  otherSide?: WeldSymbolSide;
  /** Intermittent welds on both sides, staggered. */
  staggered?: boolean;
  allAround?: boolean;
  /** Welded on site (a flag at the knee). */
  field?: boolean;
  /** The process (ISO 4063 number "135", or AWS "GMAW") and a reference (a WPS), in the tail. */
  process?: string;
  reference?: string;
  /** More reference lines, the next welds in order, above the first. */
  more?: { arrowSide?: WeldSymbolSide; otherSide?: WeldSide }[];
}

/**
 * Text on the sheet: rich (**bold**, *italic*, __underlined__, the symbols
 * palette's tokens <MOD-DIAM>), linked properties ($PRP:"partNumber",
 * $PRPMODEL:"mass", $PRPSHEET:"scale") read live, with leaders to what it is
 * about, or a numbered block of general notes ("NOTES: 1. ...").
 */
export interface NoteAnnotation {
  id: string;
  type: "note";
  text: string;
  /** Where the text starts on the sheet (its first line's baseline), sheet mm from the corner; in a view, from its centre. */
  at: Vec2;
  /** A view it sits in (it moves with it, and its leaders' GeoRefs are in it). */
  view?: string;
  leaders?: Leader[];
  /** Capital height, mm (default 3.5; 5 and 7 for titles). */
  height?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** A numbered list: each line its number ("1. "), under `title` ("NOTES:"). */
  numbered?: boolean;
  title?: string;
  /** A box round it. */
  frame?: boolean;
  /** Degrees, counter-clockwise. */
  angle?: number;
}

/** A centre mark: a cross on a circle's centre, its arms a little past the circle (thin chain lines). A new view gets one for every circle it sees end on; delete the ones not wanted. */
export interface CenterMarkAnnotation {
  id: string;
  type: "centerMark";
  view: string;
  /** The circle or arc: "<view>:e<edgeKey>", or its centre "<view>:c<edgeKey>". */
  at: GeoRef;
  /** How far the arms run past the circle, sheet mm (default 2.5). */
  extend?: number;
  /** "lines" (centre lines across the circle, the default), "cross" (the small cross only), "pitch" (a pattern's: the arc of its pitch circle through it, and a radial line). */
  style?: "lines" | "cross" | "pitch";
}

/** A centre line: midway between two edges (a cylinder's sides, seen from the side), or through two points (circle centres). */
export interface CenterlineAnnotation {
  id: string;
  type: "centerline";
  view: string;
  between: [GeoRef, GeoRef];
  /** How far it runs past the ends, sheet mm (default 2.5). */
  extend?: number;
}

/** The ISO 1101 / ASME Y14.5 material and zone modifiers a tolerance may carry (after its value). */
export const GDT_MODIFIERS = ["P", "F", "T", "S", "U", "CZ", "ST", "E", "I", "LE", "ACS"] as const;
export type GdtModifier = (typeof GDT_MODIFIERS)[number];
/** A datum in a frame: its letter (or "A-B" for a common datum), and a material modifier. */
export interface GdtDatumRef {
  label: string;
  modifier?: "M" | "L" | "S";
}
/**
 * One row of a feature control frame: the characteristic, its tolerance
 * zone (Ø for a cylindrical zone, SØ spherical, the value in mm, a material
 * modifier, other modifiers), and up to three datums.
 */
export interface GdtRow {
  characteristic: GdtCharacteristic;
  /** Ø: a cylindrical zone (position of a hole). */
  diameter?: boolean;
  /** SØ: a spherical zone. */
  spherical?: boolean;
  tolerance: number;
  /** Ⓜ maximum or Ⓛ least material condition. */
  material?: "M" | "L";
  modifiers?: GdtModifier[];
  /** Ⓟ's projected height, mm (written after it). */
  projected?: number;
  /** Ⓤ's unequal disposition, mm. */
  unequal?: number;
  /** A per-unit refinement ("0.05/100": tolerance per this length). */
  per?: number;
  datums?: GdtDatumRef[];
}
export const GDT_ROW_KEYS = ["characteristic", "diameter", "spherical", "tolerance", "material", "modifiers", "projected", "unequal", "per", "datums"] as const;

/**
 * A feature control frame (GD&T), attached to a feature (a leader to an edge,
 * a surface, a circle), under a dimension's text (its size's feature), or to
 * a dimension's extension line.
 */
export interface GdtAnnotation {
  id: string;
  type: "gdt";
  view: string;
  rows: GdtRow[];
  /** Two or more rows of one characteristic sharing its symbol (a composite frame); else each row its own (stacked). */
  composite?: boolean;
  /** The feature: a leader to it. */
  on?: GeoRef;
  /** Under this dimension's text (it tolerances the size's feature). */
  dimension?: string;
  /** With `dimension`: on its extension line 0 or 1 instead (the surface the line stands on). */
  extension?: 0 | 1;
  /** The frame's lower left corner, sheet mm from the view's centre. */
  at?: Vec2;
  /** "6×" above it, and notes above and below ("ALL AROUND", "EACH ELEMENT"). */
  count?: number;
  above?: string;
  below?: string;
  arrow?: ArrowStyle;
}

/** A datum feature symbol: its letter in a frame, a triangle on the feature (or on its dimension, its extension line, a frame). */
export interface DatumAnnotation {
  id: string;
  type: "datum";
  view: string;
  /** "A", "B", ... (I, O and Q are not used). */
  label: string;
  /** The feature: an edge (the surface seen edge on) or a point on it. */
  on?: GeoRef;
  /** A dimension: the datum is its feature of size (the triangle on its dimension line). */
  dimension?: string;
  /** A feature control frame it hangs from. */
  gdt?: string;
  /** The letter's frame, sheet mm from the view's centre. Default: straight out from the surface. */
  at?: Vec2;
  /** An open triangle instead of the filled one. */
  open?: boolean;
}

/** A datum target (ISO 5459 / ASME Y14.5): a point, a line or an area of a datum feature, with its symbol (size over label). */
export interface DatumTargetAnnotation {
  id: string;
  type: "datumTarget";
  view: string;
  /** "A1". */
  label: string;
  target: "point" | "line" | "area";
  /** Where it is on the part: a point GeoRef (the target point, the line's middle, the area's centre). */
  on: GeoRef;
  /** An area's size: its diameter (round) or width and height (rectangular), mm. */
  size?: number | [number, number];
  /** A line target's length and angle on the sheet, mm and degrees (default: along the edge it is on). */
  length?: number;
  /** The symbol, sheet mm from the view's centre. */
  at?: Vec2;
}

/** The surface texture symbol (ISO 1302 / ISO 21920-1, ASME Y14.36): basic, material removal required, or not allowed. */
export const SURFACE_SYMBOLS = ["basic", "removal", "noRemoval"] as const;
/** The direction of lay: parallel, perpendicular, crossed, multi-directional, circular, radial, particulate. */
export const LAY_SYMBOLS = ["=", "⊥", "X", "M", "C", "R", "P"] as const;
/** A surface texture symbol on a surface (an edge seen edge on, on it or by a leader), on an extension line, or a general one in the title area. */
export interface SurfaceAnnotation {
  id: string;
  type: "surface";
  /** The view it is in; a general requirement (`general`) has none. */
  view?: string;
  symbol?: (typeof SURFACE_SYMBOLS)[number];
  /** The requirements, one per line: "Ra 1.6", "Rz 6.3", "Ra 3.2 max". */
  values?: string[];
  /** The manufacturing method: "ground", "milled". */
  process?: string;
  lay?: (typeof LAY_SYMBOLS)[number];
  /** Machining allowance, mm (on a casting or forging). */
  allowance?: number;
  /** All round the outline seen in the view: a circle at the symbol's knee. */
  allAround?: boolean;
  on?: GeoRef;
  /** On this dimension's extension line (0 or 1). */
  dimension?: string;
  extension?: 0 | 1;
  /** Sheet mm from the view's centre (a general one: from the sheet's corner). */
  at?: Vec2;
  /** The drawing's general requirement: "√Ra 3.2 (√)" near the title block, for every surface not marked otherwise. */
  general?: boolean;
}

/** A cosmetic thread's callout: "M8×1.25 - 6H ↧16" with a leader, from a tapped hole or thread feature. */
export interface CosmeticThreadAnnotation {
  id: string;
  type: "cosmeticThread";
  view: string;
  /** The tapped hole or the thread feature. */
  hole: string;
  on?: GeoRef;
  at?: Vec2;
}

/** A revision cloud round what changed, and its revision's triangle. */
export interface RevisionCloudAnnotation {
  id: string;
  type: "revisionCloud";
  /** The outline, closed, sheet mm (from the view's centre when it is in one). */
  pts: Vec2[];
  view?: string;
  /** The revision ("B"): its letter in a triangle by the cloud. */
  rev?: string;
  /** The triangle, the same mm as `pts`. Default: at the cloud's top right. */
  at?: Vec2;
  /** The arcs' size, mm (default 6). */
  arc?: number;
}

/** A leader with text (or none): an arrow to a GeoRef or a point, the text at its other end. */
export interface LeaderAnnotation {
  id: string;
  type: "leader";
  view?: string;
  to: GeoRef | Vec2;
  /** The text's place (the same mm as `to`). */
  at: Vec2;
  text?: string;
  via?: Vec2[];
  arrow?: ArrowStyle;
  spline?: boolean;
}

/** One line of rich text placed on the sheet. */
export interface TextAnnotation {
  id: string;
  type: "text";
  text: string;
  at: Vec2;
  view?: string;
  height?: number;
  angle?: number;
  anchor?: "start" | "middle" | "end";
  bold?: boolean;
}

/** The kinds of line free sketching draws (ISO 128): thick, thin, centre (chain), hidden (dashed), phantom. */
export const SKETCH_LINES = ["thick", "thin", "center", "hidden", "phantom"] as const;
export type SketchLine = (typeof SKETCH_LINES)[number];
/** A straight line drawn on the sheet. */
export interface LineAnnotation {
  id: string;
  type: "line";
  view?: string;
  pts: [Vec2, Vec2];
  line?: SketchLine;
}

/** Free sketching on the sheet: lines, arcs, circles, rectangles, polylines and text. */
export type SketchItem =
  | { kind: "line"; a: Vec2; b: Vec2; line?: SketchLine }
  | { kind: "arc"; c: Vec2; r: number; start: number; end: number; line?: SketchLine }
  | { kind: "circle"; c: Vec2; r: number; line?: SketchLine }
  | { kind: "rect"; a: Vec2; b: Vec2; line?: SketchLine }
  | { kind: "polyline"; pts: Vec2[]; closed?: boolean; line?: SketchLine }
  | { kind: "text"; at: Vec2; text: string; height?: number; angle?: number };
export interface SketchAnnotation {
  id: string;
  type: "sketch";
  /** In a view: its points from the view's centre, moving with it. */
  view?: string;
  items: SketchItem[];
}

export const DRAWING_TABLES = ["cutList", "welds"] as const;
/** The Phase L tables an annotation can place (DrawingSheet.tables holds the Phase Q ones). */
export type TableName = (typeof DRAWING_TABLES)[number];

/** The cut list or the weld table. */
export interface TableAnnotation {
  id: string;
  type: "table";
  table: TableName;
  /** The table's top left corner on the sheet. Default: stacked above the title block. */
  at?: Vec2;
}

export type Annotation =
  | DimensionAnnotation
  | HoleAnnotation
  | BalloonAnnotation
  | WeldAnnotation
  | TableAnnotation
  | NoteAnnotation
  | CenterMarkAnnotation
  | CenterlineAnnotation
  | GdtAnnotation
  | DatumAnnotation
  | DatumTargetAnnotation
  | SurfaceAnnotation
  | CosmeticThreadAnnotation
  | RevisionCloudAnnotation
  | LeaderAnnotation
  | TextAnnotation
  | LineAnnotation
  | SketchAnnotation;
export type AnnotationType = Annotation["type"];
export const ANNOTATION_TYPES = [
  "dimension",
  "hole",
  "balloon",
  "weld",
  "table",
  "note",
  "centerMark",
  "centerline",
  "gdt",
  "datum",
  "datumTarget",
  "surface",
  "cosmeticThread",
  "revisionCloud",
  "leader",
  "text",
  "line",
  "sketch",
] as const;
export const ANNOTATION_KEYS: Record<AnnotationType, readonly string[]> = {
  dimension: ["id", "type", "view", "kind", "from", "to", "member", "refs", "origin", "points", "direction", "offset", "at", "major", "jog", "arrows", "flip", "prefix", "suffix", "count", "typ", "inspection", "tolerance", "precision", "dual", "last"],
  hole: ["id", "type", "view", "hole", "on", "at", "count", "pattern", "prefix", "suffix", "tolerance"],
  balloon: ["id", "type", "view", "member", "body", "item", "on", "at", "shape", "size", "quantity", "stack", "arrow"],
  weld: ["id", "type", "view", "weld", "on", "at", "arrowSide", "otherSide", "staggered", "allAround", "field", "process", "reference", "more"],
  table: ["id", "type", "table", "at"],
  note: ["id", "type", "text", "at", "view", "leaders", "height", "bold", "italic", "underline", "numbered", "title", "frame", "angle"],
  centerMark: ["id", "type", "view", "at", "extend", "style"],
  centerline: ["id", "type", "view", "between", "extend"],
  gdt: ["id", "type", "view", "rows", "composite", "on", "dimension", "extension", "at", "count", "above", "below", "arrow"],
  datum: ["id", "type", "view", "label", "on", "dimension", "gdt", "at", "open"],
  datumTarget: ["id", "type", "view", "label", "target", "on", "size", "length", "at"],
  surface: ["id", "type", "view", "symbol", "values", "process", "lay", "allowance", "allAround", "on", "dimension", "extension", "at", "general"],
  cosmeticThread: ["id", "type", "view", "hole", "on", "at"],
  revisionCloud: ["id", "type", "pts", "view", "rev", "at", "arc"],
  leader: ["id", "type", "view", "to", "at", "text", "via", "arrow", "spline"],
  text: ["id", "type", "text", "at", "view", "height", "angle", "anchor", "bold"],
  line: ["id", "type", "view", "pts", "line"],
  sketch: ["id", "type", "view", "items"],
};
/** The annotations that must sit in a view (the others may, or are the sheet's). */
export const VIEW_ANNOTATIONS: readonly AnnotationType[] = ["dimension", "hole", "balloon", "weld", "centerMark", "centerline", "gdt", "datum", "datumTarget", "cosmeticThread"];

// ------------------------------------------------------------ frames

/** A node's name: letters, digits and _, starting with a letter ("A", "top_1"). */
export const NODE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A weld, as a note: where it is, what it is. Never modelled. */
export interface Weld {
  id: string;
  /** The bodies it joins. */
  between: string[];
  type: WeldType;
  /** Fillet leg or butt throat, mm. */
  size: number;
  /** Total length, mm. */
  length: number;
  /** Welded all round the joint. */
  allRound?: boolean;
  note?: string;
  /** Phase Q: the welding process, as written in the tail ("135 MAG", "GMAW", "141 TIG"). */
  process?: string;
  /** Phase Q: which side of the joint: the arrow side, the other side, or both. */
  side?: WeldSide;
  /** Phase Q: how many alike welds this line stands for (default 1). */
  count?: number;
}
export const WELD_SIDES = ["arrow", "other", "both"] as const;
export type WeldSide = (typeof WELD_SIDES)[number];
export const WELD_TYPES = ["fillet", "butt", "plug"] as const;
export type WeldType = (typeof WELD_TYPES)[number];
export const WELD_KEYS = ["id", "between", "type", "size", "length", "allRound", "note", "process", "side", "count"] as const;

// ------------------------------------------------------- weldment profiles

/**
 * A weldment profile (Phase I): a section drawn as a sketch, in its own plane
 * (x right, y up, the origin at the sketch origin). Its dimensions may be
 * expressions over its size parameters ("=b", "=b - 2 * t"), so one profile
 * is a family of sizes.
 */
export interface ProfileDef {
  /** The family: "SHS". */
  name: string;
  entities: SketchEntity[];
  constraints?: Constraint[];
  /** The size parameters, at the first size. */
  parameters: Record<string, number>;
  /** Every size, with its designation ("SHS 40x40x3") and parameter values. At least one. */
  sizes: ProfileSize[];
  /** What sits on a member's line: the section's centroid, or the sketch origin. */
  anchor: "centroid" | "origin";
  tags: string[];
  /** A note, like a drawing's material note. It does not set the density: `density` does. */
  material?: string;
  /** kg/m³: when set, members of this profile weigh this, whatever the part's material (catalogue steel, timber). */
  density?: number;
  /** The library entry this copy came from. */
  library?: { id: string; version: number };
}

export interface ProfileSize {
  designation: string;
  values: Record<string, number>;
}

export const PROFILE_KEYS = ["name", "entities", "constraints", "parameters", "sizes", "anchor", "tags", "material", "density", "library"] as const;

/**
 * A photo the part was estimated from (spec 5.3). The document keeps what the
 * photo says about the part; the pixels stay in the browser that opened it,
 * found by their SHA-256.
 *
 * A photo has no scale until the user gives one: two points on the photo and
 * the real length between them. Every size measured on the photo is an
 * estimate, scaled from that one dimension. Until the user confirms the scale,
 * and sets every size the photo doesn't show, the part is not exported.
 */
export interface PhotoUnderlay {
  /** The photo's file name. */
  image: string;
  sha256: string;
  /** Pixel size of the photo as read: every pixel position below is in this image. */
  width: number;
  height: number;
  /** The photo pixel at the model origin. The photo lies on XY: pixel x along +X, pixel y along -Y. */
  origin: Vec2;
  scale: PhotoScale;
  /**
   * Parameters that came from the photo. A number is the size (or offset) in
   * photo pixels: an estimate, rescaled with the scale. null is a guess the
   * photo doesn't show. A parameter the user sets is no longer listed.
   */
  estimated: Record<string, number | null>;
}

export interface PhotoScale {
  /** Two points on the photo, in pixels. */
  from: Vec2;
  to: Vec2;
  /** The real distance between them, mm. */
  length: number;
  /** What the points are on: "the plate's long edge", "the 0 and 100 marks on the rule". */
  what: string;
  /** Where the length came from: typed by the user, read off a reference in the photo, or a guess. */
  source: PhotoScaleSource;
  /** The parameter this length is, when it measures the part ("plate_w"). */
  parameter?: string;
  /** Set only by the user, in the app. A change to the points or the length clears it. */
  confirmed: boolean;
}

export const PHOTO_SCALE_SOURCES = ["typed", "reference", "guess"] as const;
export type PhotoScaleSource = (typeof PHOTO_SCALE_SOURCES)[number];
export const PHOTO_KEYS = ["image", "sha256", "width", "height", "origin", "scale", "estimated"] as const;
export const PHOTO_SCALE_KEYS = ["from", "to", "length", "what", "source", "parameter", "confirmed"] as const;

export interface DocumentSource {
  /** The drawing file the part was built from. */
  drawing?: string;
  drawingNumber?: string;
  /** "first-angle" or "third-angle", as the user declared it. */
  projection?: string;
  /** The title block's material note, as written. It does not set the density. */
  material?: string;
  /** The title block's units, as written. The document itself is always mm. */
  units?: string;
}

export const SOURCE_KEYS = ["drawing", "drawingNumber", "projection", "material", "units"] as const;

/**
 * The part's properties, as a fabricator keeps them: every one optional text.
 * A drawing's title block shows them where its own sheet fields are not set
 * (the sheet's number, revision and "drawn by" win over the part's), the cut
 * list CSV starts with the part number and description, and STEP export names
 * the product by the part number.
 */
export interface PartProperties {
  partNumber?: string;
  description?: string;
  revision?: string;
  /** Who drew it: the title block's "drawn by". */
  author?: string;
  /** Surface finish or coating: "Hot-dip galvanised", "Powder coat black". */
  finish?: string;
  /** Anything else, by name: "Customer": "Acme", "Job": "2417". */
  custom?: Record<string, string>;
}

export const PROPERTY_KEYS = ["partNumber", "description", "revision", "author", "finish", "custom"] as const;

export interface Material {
  name?: string;
  densityKgPerM3: number;
}

export type Feature =
  | SketchFeature
  | ExtrudeFeature
  | HoleFeature
  | FilletFeature
  | ChamferFeature
  | LinearPatternFeature
  | CircularPatternFeature
  | CombineFeature
  | MemberFeature
  | JointFeature
  | EndCapFeature
  | GussetFeature
  | MirrorFeature
  | SplitFeature
  | MoveFeature
  | DeleteBodyFeature
  /** The ops in the registry (src/features/<op>/doc.ts, listed in src/features/docIndex.ts). */
  | PluginFeature;
export type FeatureOp = Feature["op"];
export const FEATURE_OPS: readonly FeatureOp[] = [
  "sketch",
  "extrude",
  "cut",
  "hole",
  "fillet",
  "chamfer",
  "linearPattern",
  "circularPattern",
  "combine",
  "member",
  "joint",
  "endCap",
  "gusset",
  "mirror",
  "split",
  "move",
  "deleteBody",
  ...PLUGIN_OPS,
];

// ----------------------------------------------------------------- bodies

/**
 * A part is one or more named solids (bodies). A feature that adds material
 * names the body it adds to; one that names none adds to the default body.
 * A name that doesn't exist is an error, never a new body.
 */
export const DEFAULT_BODY = "main";
export const BODY_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Fields every feature may carry. */
export interface FeatureBase {
  id: string;
  /** A suppressed feature is kept in the document but skipped by the rebuild. */
  suppressed?: boolean;
  /** A short comment about the feature (shown in the tree's tooltip); never read by the rebuild. */
  note?: string;
}

// ---------------------------------------------------------------- sketch

/**
 * A datum plane. The sketch's 2D axes are derived from the normal:
 * x = xDir if given, else global X projected onto the plane (global Y when the
 * normal is parallel to X); y = normal × x.
 */
export interface DatumPlane {
  type: "datum";
  normal: Vec3;
  origin: Vec3;
  xDir?: Vec3;
}

/**
 * Anything that can serve as a plane, an axis or a point (reference
 * geometry). Resolved by the kernel at rebuild time, so a reference to a face
 * or an edge follows the model when earlier features change.
 * - { datum: "Front" | "Top" | "Right" }: a default plane (Z up: Top = XY,
 *   normal +Z; Front = XZ, normal -Y; Right = YZ, normal +X), through the origin.
 * - { datum: "Origin" }: the origin, a point. { datum: "X" | "Y" | "Z" }: an axis through it.
 * - { datum: "<id>" }: an earlier plane, axis or point feature, or a coordinate
 *   system (with `part`, one of its planes, axes or its origin: CsysPart).
 * - { face }: a planar face is a plane (its outward normal); a cylindrical or
 *   conical face is its axis.
 * - { edge }: a straight edge is an axis (start to end); a circular edge is its
 *   axis, or its centre where a point is needed. With `at`, that point of it.
 * - { point }: a fixed point.
 * - { sketch, entity }: an entity of an earlier sketch, as the rebuild solved
 *   it: a line is an axis (start to end); a circle or arc is the axis through
 *   its centre square to its sketch, or its centre where a point is needed; a
 *   point is a point. With `at`, that point of it ("center" of a circle or arc,
 *   "start", "end" or "mid" of a line or arc). It follows that sketch.
 */
export type DatumRef =
  | { datum: string; part?: CsysPart }
  /** As a sketch entity's ref, with `section`: the piece of the curve where the face cuts the sketch plane nearest that point (an intersection curve). */
  | { face: FaceSelector; section?: Vec2 }
  | { edge: EdgeSelector; at?: EdgePoint }
  | { point: Vec3 }
  | SketchEntityRef;
/**
 * A part of a coordinate system feature (op "coordinateSystem") used as a
 * reference: { "datum": "cs1", "part": "XY" } is its XY plane (normal Z, x
 * along X), "YZ" (normal X, x along Y), "ZX" (normal Y, x along Z), "X" / "Y"
 * / "Z" its axes through its origin, "origin" its origin. Without a part, a
 * coordinate system is its XY plane where a plane is needed, its Z axis where
 * an axis is, its origin where a point is.
 */
export type CsysPart = "XY" | "YZ" | "ZX" | "X" | "Y" | "Z" | "origin";
/** A reference to an entity of an earlier sketch (DESIGN §2.9): see DatumRef. */
export interface SketchEntityRef {
  sketch: string;
  entity: string;
  at?: EdgePoint;
}
/** A point of an edge: its ends, the middle of its length, or a circle's centre. */
export type EdgePoint = "start" | "end" | "mid" | "center";

/**
 * A plane given by reference: a face, a default plane or a plane feature,
 * moved `offset` mm along its normal (before any flip). `flip` turns the plane
 * over (its normal reversed, its x kept). `xDir` sets the plane's x axis
 * (projected onto it); without it, a default or plane feature keeps its own x,
 * and a face uses the datum-plane rule.
 */
export interface RefPlane {
  type: "ref";
  ref: DatumRef;
  offset?: number;
  flip?: boolean;
  xDir?: Vec3;
}

/** Where a sketch, a mirror or a split plane is: written out, or by reference. */
export type PlaneSpec = DatumPlane | RefPlane;

export interface SketchFeature extends FeatureBase {
  op: "sketch";
  /** A sketch on a face is { "type": "ref", "ref": { "face": <selector> } }: it follows the face. */
  plane: PlaneSpec;
  entities: SketchEntity[];
  constraints?: Constraint[];
  /** Drawn as a weldment profile: saved to the section library under this name. */
  profile?: { name: string; library?: { id: string; version: number } };
  /**
   * Shown in the view (true) or hidden (false). Absent: a sketch a later
   * feature uses (extrudes, cuts, revolves, sweeps…) is hidden, any other
   * shown. View only: never read by the rebuild.
   */
  shown?: boolean;
}

interface EntityBase {
  id: string;
  /**
   * Construction geometry is kept for constraints but never becomes a profile.
   * A reference entity (with `ref`) is construction unless this is false.
   */
  construction?: boolean;
  /**
   * Reference geometry (DESIGN §2.4): the entity is the model's edge, axis or
   * point projected into the sketch plane, again on every rebuild, at the
   * sketch's place in history. Its numbers are the projection's; the solver
   * holds them as constants, and relations and dimensions to it follow the
   * model. Lines, circles, arcs and points only: a line takes a straight edge
   * (or a circular one seen edge-on) or an axis; a circle a whole circular
   * edge; an arc part of one; a point an edge's point (`at`), a circle's
   * centre, a point feature or the Origin.
   */
  ref?: DatumRef;
}

/** The sketch's own axes: lines through its origin along its x and y, usable wherever a line id is (as "origin" is a point). */
export const SKETCH_AXES = ["X", "Y"] as const;
export type SketchAxis = (typeof SKETCH_AXES)[number];

export interface LineEntity extends EntityBase {
  type: "line";
  start: Vec2;
  end: Vec2;
}

export interface CircleEntity extends EntityBase {
  type: "circle";
  center: Vec2;
  radius: number;
}

/** Arc from start to end around center, counter-clockwise unless `clockwise` is set. */
export interface ArcEntity extends EntityBase {
  type: "arc";
  center: Vec2;
  start: Vec2;
  end: Vec2;
  clockwise?: boolean;
}

export interface RectEntity extends EntityBase {
  type: "rect";
  center: Vec2;
  w: number;
  h: number;
}

/** Straight slot: two end-arc centres and the slot width. */
export interface SlotEntity extends EntityBase {
  type: "slot";
  center1: Vec2;
  center2: Vec2;
  width: number;
}

/**
 * A sketch point on its own: a hole centre, a pattern instance, a dimension's
 * anchor, the middle of a centre rectangle. Its point ref is "<id>.at". Never
 * part of a profile.
 */
export interface PointEntity extends EntityBase {
  type: "point";
  at: Vec2;
}

/**
 * An ellipse, or an elliptical arc. `major` is the end of the major semi-axis:
 * its direction from `center` is the ellipse's tilt and its distance the
 * major radius; `minor` is the minor radius, square to it (on its left).
 * With `startAngle` and `endAngle` (both or neither) it is an elliptical arc
 * running counter-clockwise from start to end. They are parameter angles in
 * degrees: the point at angle t is center + major radius · cos t along the
 * major axis + minor · sin t along the minor axis (0 is the major end, 90 the
 * minor end). Point refs: "<id>.center", "<id>.major", "<id>.minorEnd"
 * (center + minor along the minor axis), and an arc's "<id>.start", "<id>.end".
 */
export interface EllipseEntity extends EntityBase {
  type: "ellipse";
  center: Vec2;
  major: Vec2;
  minor: number;
  startAngle?: number;
  endAngle?: number;
}

/**
 * A smooth curve through `points` in order (a cubic spline, curvature
 * continuous, parameterised by chord length). Open by default, with natural
 * ends (no bending there) unless `startTangent` / `endTangent` give the
 * direction it leaves its first point / arrives at its last, in degrees from
 * the sketch's x axis the way it runs (a tangent relation to a line at an end
 * sets these). `closed`: it runs on from the last point back to the first,
 * smoothly (at least three points; no end tangents). Point refs: "<id>.p0",
 * "<id>.p1", … for points[0], points[1], ….
 */
export interface SplineEntity extends EntityBase {
  type: "spline";
  points: Vec2[];
  closed?: boolean;
  startTangent?: number;
  endTangent?: number;
}

/**
 * Text (Phase P): its letters' outlines are profile loops (an extrude
 * embosses it, a cut engraves it; a letter's holes, O, A, B, are holes).
 * `at` is where its first line's baseline starts (`align` "left", the
 * default), or the baseline's middle ("center") or end ("right"); `height`
 * is its capital letters' height, mm; `angle` turns it about `at`, degrees
 * counter-clockwise from the sketch's x axis. Lines are split by "\n". The
 * font is the bundled sans serif ("sans", OFL); `bold` and `italic` as named.
 * Its point ref is `<id>.at`; a distance dimension on the entity is its height.
 */
export interface TextEntity extends EntityBase {
  type: "text";
  at: Vec2;
  text: string;
  height: number;
  font?: "sans";
  angle?: number;
  align?: "left" | "center" | "right";
  bold?: boolean;
  italic?: boolean;
}

export type SketchEntity = LineEntity | CircleEntity | ArcEntity | RectEntity | SlotEntity | PointEntity | EllipseEntity | SplineEntity | TextEntity;
export type SketchEntityType = SketchEntity["type"];

/** "entityId.point", e.g. "l1.end", "a2.center", "s1.center2", "p1.at", or "origin" for the sketch origin. */
export type PointRef = string;

/**
 * What every dimension (a constraint with a value) may carry:
 * - `name`: what expressions call it, as <sketch id>.<name> ("=sketch_1.width * 2"). Without one it is d<n>,
 *   n its place among the sketch's dimensions; a name given is kept whatever is deleted around it.
 * - `driven`: a reference (driven) dimension: measured from the geometry, never solved,
 *   shown in parentheses; its value is what it measures, kept up to date by every solve.
 */
export interface DimensionFields {
  name?: string;
  driven?: boolean;
}

/** Where a distance meets a circle or arc picked by its centre: the centre, or its nearest (min) or farthest (max) point. */
export const ARC_CONDITIONS = ["center", "min", "max"] as const;
export type ArcCondition = (typeof ARC_CONDITIONS)[number];

export interface CoincidentConstraint {
  type: "coincident";
  points: [PointRef, PointRef];
}

/** A line along the sketch's X or Y; or two points level with each other (horizontal) or above each other (vertical). */
export interface OrientationConstraint {
  type: "horizontal" | "vertical";
  entity?: string;
  points?: [PointRef, PointRef];
}

/**
 * Exactly one of `entity` (a line, rect or slot), `points` (two point refs),
 * or `point` with `line` (a distance only: the point's perpendicular distance from
 * the line, extended; `line` may be the sketch axis "X" or "Y").
 */
export interface DistanceConstraint extends DimensionFields {
  type: "distance" | "distanceX" | "distanceY";
  entity?: string;
  points?: [PointRef, PointRef];
  point?: PointRef;
  line?: string;
  /**
   * Two lines (`distance` only): the parallel distance between them, from the
   * second's middle to the first, extended. A sketch axis may be the first.
   */
  lines?: [string, string];
  /**
   * Measured to a circle's or arc's nearest (min) or farthest (max) point
   * rather than its centre, wherever a point of the dimension is the centre
   * of a circle or arc ("c1.center"). In the sketcher: Shift-click the circle.
   */
  condition?: ArcCondition;
  /**
   * A linear diameter (`point` with `line` only): twice the point's distance
   * from the line, shown with Ø: a revolve profile's diameter across its centreline.
   */
  doubled?: boolean;
  value: number;
}

export interface RadiusConstraint extends DimensionFields {
  type: "radius" | "diameter";
  entity: string;
  value: number;
}

/** An arc's length along it, mm. */
export interface ArcLengthConstraint extends DimensionFields {
  type: "arcLength";
  entity: string;
  value: number;
}

/** A point where two lines (extended) cross: on both. A sketch axis may be one of them. */
export interface IntersectionConstraint {
  type: "intersection";
  point: PointRef;
  entities: [string, string];
}

export interface EqualConstraint {
  type: "equal";
  entities: [string, string];
}

/**
 * Relations between two entities, the standard CAD set: parallel,
 * perpendicular and collinear lines; tangent (a line and a circle or arc, or
 * two circles or arcs, on whichever side they are); concentric circles or arcs;
 * coradial circles or arcs (concentric and the same radius, as one relation).
 */
export interface PairConstraint {
  type: "parallel" | "perpendicular" | "collinear" | "tangent" | "concentric" | "coradial";
  entities: [string, string];
}

/** The angle between two lines' directions (start to end), in degrees, over 0 and under 180. */
export interface AngleConstraint extends DimensionFields {
  type: "angle";
  entities: [string, string];
  value: number;
  /** The other quadrant: the value is 180° minus the angle between the directions (where the dimension was dropped). */
  supplement?: boolean;
}

/** A point at the middle of a line, or on a line (extended), circle or arc. */
export interface PointOnConstraint {
  type: "midpoint" | "pointOn";
  point: PointRef;
  entity: string;
}

/**
 * Two points mirrored about a line (`points`); or two lines, two arcs, two
 * circles or two splines that are each other's mirror images about it
 * (`entities`: their ends pair up as they lie, the arcs' centres and radii
 * too; a spline's points pair up in order, and an end tangent the second one
 * holds is the first's mirrored). Exactly one of the two. Mirror Entities
 * relates each copy to its original this way.
 */
export interface SymmetricConstraint {
  type: "symmetric";
  points?: [PointRef, PointRef];
  entities?: [string, string];
  line: string;
}

/**
 * Offset entities held by one driving distance (Offset Entities makes it):
 * each `offsets[i]` lies `value` mm from `entities[i]`, on the side it is on
 * now. A line's offset is a line parallel to it at that distance; an arc's or
 * a circle's is concentric with it, its radius that much larger or smaller.
 * A base may also be a point ref ("l1.end"): its offset is an arc or circle
 * centred there with the value for radius (a rounded corner, an arc cap).
 * Editing the value moves every offset at once.
 */
export interface OffsetConstraint extends DimensionFields {
  type: "offset";
  /** The bases: lines, arcs and circles of the sketch, or point refs. */
  entities: string[];
  /** One offset per base, in the same order. */
  offsets: string[];
  value: number;
}

/** An entity (a point entity too), or one point, held where it is: only the document's numbers move it. */
export interface FixConstraint {
  type: "fix";
  entity?: string;
  point?: PointRef;
}

export type Constraint =
  | CoincidentConstraint
  | OrientationConstraint
  | DistanceConstraint
  | RadiusConstraint
  | EqualConstraint
  | PairConstraint
  | AngleConstraint
  | PointOnConstraint
  | SymmetricConstraint
  | FixConstraint
  | OffsetConstraint
  | ArcLengthConstraint
  | IntersectionConstraint;
export type ConstraintType = Constraint["type"];

// ------------------------------------------------------- extrude and cut

/**
 * Where an extrude or cut ends (its "end condition"):
 * - blind: `distance` along the direction; midplane: `distance` in all, half each way;
 * - throughAll: through every body it works on; throughAllBoth: that, both ways;
 * - upToNext: to the next face of the part it meets (a boss stops where it
 *   meets material, a cut where the material ends);
 * - upToFace: to `upTo`, a face (a flat face is taken as its whole plane), a
 *   plane feature or a default plane;
 * - upToVertex: to the plane through `upTo` (a point) parallel to the sketch;
 * - offsetFromFace: to `upTo` (flat) moved `offset` mm back toward the sketch
 *   (negative: past it).
 */
export type ExtrudeExtent = "blind" | "midplane" | "throughAll" | "throughAllBoth" | "upToNext" | "upToFace" | "upToVertex" | "offsetFromFace";
export const EXTRUDE_EXTENTS: readonly ExtrudeExtent[] = ["blind", "midplane", "throughAll", "throughAllBoth", "upToNext", "upToFace", "upToVertex", "offsetFromFace"];
/** The end conditions a second direction can have (midplane and throughAllBoth are both directions already). */
export type Direction2Extent = Exclude<ExtrudeExtent, "midplane" | "throughAllBoth">;
export const DIRECTION2_EXTENTS: readonly Direction2Extent[] = ["blind", "throughAll", "upToNext", "upToFace", "upToVertex", "offsetFromFace"];

/** Tapered sides: `angle` degrees (over 0, under 90) inward as the extrude goes out, or outward. */
export interface ExtrudeDraft {
  angle: number;
  outward?: boolean;
}

/** The second direction: the other way from the start, with its own end condition. */
export interface ExtrudeDirection2 {
  extent: Direction2Extent;
  distance?: number;
  upTo?: DatumRef;
  offset?: number;
  draft?: ExtrudeDraft;
}

/** A thin feature: the profile (an open chain, or closed loops) thickened into a wall first. */
export interface ExtrudeThin {
  thickness: number;
  /** Default "outside": away from what a loop encloses (an open chain: its outer, convex side). */
  side?: "outside" | "inside" | "mid";
}

export interface ExtrudeFeature extends FeatureBase {
  /** extrude adds material, cut removes it. Same parameters. */
  op: "extrude" | "cut";
  sketch: string;
  /** Default "blind". */
  extent?: ExtrudeExtent;
  /** Required for blind and midplane (midplane: total length, split evenly). */
  distance?: number;
  /** upToFace, offsetFromFace: the face or plane it ends at; upToVertex: the point. */
  upTo?: DatumRef;
  /** offsetFromFace: mm short of `upTo`, back toward the start (negative: past it). */
  offset?: number;
  /** Default: the sketch plane normal. Must not lie in the sketch plane. */
  direction?: Vec3;
  /** The other way too, with its own end condition. */
  direction2?: ExtrudeDirection2;
  /** Start this many mm from the sketch plane (along its normal; negative: behind it). */
  startOffset?: number;
  /** Start at this plane, flat face or point (a point: the plane through it parallel to the sketch). */
  from?: DatumRef;
  /** Tapered sides (direction 1; midplane: both halves). */
  draft?: ExtrudeDraft;
  /** A thin wall from the profile (an open sketch may be used). */
  thin?: ExtrudeThin;
  /** Only the closed regions of the sketch these points (sketch coordinates) lie in. Default: every region. */
  regions?: Vec2[];
  /** extrude: keep only where the extrusion and the body overlap (an intersect). */
  intersect?: boolean;
  /** cut: remove what lies outside the profile instead ("flip side to cut"). */
  flipSide?: boolean;
  /** extrude: the body to add to (default "main"). */
  body?: string;
  /** extrude: start a new body with this name instead. */
  newBody?: string;
  /** cut: the bodies to cut. Default: every body it reaches. Each listed one must lose material. */
  bodies?: string[];
}

// ------------------------------------------------------------------ hole

/**
 * Holes drilled into a planar face, against the face's outward normal (the
 * Hole Wizard). Where: `center` (one hole) or `centers` (several), in the
 * face's plane frame (origin = the global origin projected onto the face
 * plane, axes from the same rule as a datum plane); or `points`, every point
 * entity of a sketch: on the face when `face` is given (the sketch parallel
 * to it), else on the sketch's own plane, drilled against its normal.
 *
 * What: `size` ("M6", ISO metric) with `kind` and `fit` takes the numbers
 * from the table in src/features/hole/standards.ts: a clearance bore
 * (ISO 273) for simple, counterbored (ISO 4762 heads) and countersunk
 * (ISO 10642 heads) holes; a tap drill and a thread for tapped ones. A
 * number the hole gives itself wins over the table. Without a size, the hole
 * gives its diameter (and counterbore or countersink) in full.
 *
 * In the document `diameter` may be left out when a size gives it; once
 * validated it is always the bore's diameter, and `counterbore`,
 * `countersink` and `thread` hold the numbers used.
 */
export interface HoleFeature extends FeatureBase {
  op: "hole";
  /** The flat face it is drilled into. Optional with `points`: the holes then start on that sketch's plane. */
  face?: FaceSelector;
  center?: Vec2;
  centers?: Vec2[];
  /** A sketch: a hole at each of its point entities. */
  points?: string;
  /** "M3" ... "M24". */
  size?: string;
  /** Default: what its fields say (a counterbore makes it "counterbore"), else "simple". */
  kind?: HoleKind;
  /** The clearance for simple, counterbored and countersunk holes. Default "normal". */
  fit?: HoleFit;
  diameter: number;
  /** Blind (mm), through all, or up to next: through the first wall it meets. */
  depth: number | "through" | "upToNext";
  counterbore?: { diameter: number; depth: number };
  countersink?: { diameter: number; angle: number };
  /** A tapped hole's thread. In the document { pitch?, depth? } (the size gives the rest); validated, the whole spec. */
  thread?: ThreadSpec;
  /** The bodies to drill. Default: every body it reaches. Each listed one must lose material. */
  bodies?: string[];
}
export const HOLE_DEPTHS = ["through", "upToNext"] as const;

// ---------------------------------------------------- fillet and chamfer

/**
 * Which edges a fillet or chamfer (or one of a fillet's sets) treats: the
 * edges its selectors match, every edge of the faces it names, and every edge
 * of the faces the features it names made. At least one is given.
 */
export interface EdgeChoice {
  /** One selector or a list whose matches are combined. */
  edges?: EdgeSelector | EdgeSelector[];
  /** Every edge bounding these faces. */
  faces?: FaceSelector[];
  /** Every edge of the faces these earlier features made (an extrude's sides and top, where it meets the part). */
  features?: string[];
}

/** One radius over some edges of a fillet. */
export interface FilletSet extends EdgeChoice {
  radius: number;
  radius2?: number;
}

/**
 * Rounds the selected edges. `radius2` makes the radius vary linearly from
 * `radius` at each edge's start to `radius2` at its end. `sets` gives other
 * edges radii of their own in the same feature.
 */
export interface FilletFeature extends FeatureBase, EdgeChoice {
  op: "fillet";
  /** Needed unless `sets` gives every radius. */
  radius?: number;
  radius2?: number;
  sets?: FilletSet[];
}

/**
 * Bevels the selected edges: `distance` on both faces (equal), or `distance`
 * on one face and `distance2` on the other, or `distance` on one face at
 * `angle` degrees from it. Which face takes `distance`: the one facing most
 * up (+Z, then +Y, then +X); `flip` swaps the faces.
 */
export interface ChamferFeature extends FeatureBase, EdgeChoice {
  op: "chamfer";
  distance: number;
  distance2?: number;
  angle?: number;
  flip?: boolean;
}

// -------------------------------------------------------------- patterns

/** Ops a pattern can repeat: the ones that add or remove one tool body. */
export const PATTERNABLE_OPS = ["extrude", "cut", "hole", "member"] as const;

/** The features a pattern or a mirror repeats: its `features`, or its one `feature` (raw or validated). */
export function seedIds(f: { feature?: unknown; features?: unknown }): string[] {
  if (Array.isArray(f.features)) return f.features.filter((x): x is string => typeof x === "string");
  return typeof f.feature === "string" ? [f.feature] : [];
}

/** The instance numbers a pattern of `total` makes copies at: 2 ... total (1 is the original), less those it skips. */
export function instanceNumbers(total: number, skip: readonly number[] = []): number[] {
  const out: number[] = [];
  for (let k = 2; k <= total; k++) if (!skip.includes(k)) out.push(k);
  return out;
}

/**
 * Repeats earlier features (an extrude, cut, hole, member, or a registry op
 * that patterns, such as revolve) in a row, or a grid with the second
 * direction. `count` (and `count2`) include the original.
 *
 * The direction is `direction`, written out, or `along`, taken from the model
 * (a straight edge or an axis: its direction; a flat face or a plane: its
 * normal), so it follows the model; `reverse` turns it round.
 *
 * Instances are numbered from 1, the original: along the first direction
 * 1 ... count, then the next row 1 + count ... 2 count, and so on (instance
 * i along direction 1 and j along direction 2, counting from 0, is number
 * 1 + i + j * count). `skip` leaves those instances out. A copy of a feature
 * that starts a body is a new body named <body>_<instance number>.
 */
export interface LinearPatternFeature extends FeatureBase {
  op: "linearPattern";
  /** One feature to repeat; or `features`, several, each repeated the same way. */
  feature?: string;
  features?: string[];
  direction?: Vec3;
  along?: DatumRef;
  reverse?: boolean;
  spacing: number;
  count: number;
  direction2?: Vec3;
  along2?: DatumRef;
  reverse2?: boolean;
  spacing2?: number;
  count2?: number;
  skip?: number[];
}

/**
 * Repeats earlier features about an axis: `{ origin, direction }` written out,
 * or `{ ref }`, a straight or round edge, an axis, a cylindrical face. `count`
 * includes the original (instance 1, then 2, 3 ... turning the right-handed
 * way about the axis, or the other way with `reverse`). `angle` is the angle
 * the pattern spans in degrees (default 360), with the instances spaced
 * equally: a full turn spaces them angle/count apart, a partial one
 * angle/(count - 1), so the last lands on the end. `skip` leaves instances out.
 */
export interface CircularPatternFeature extends FeatureBase {
  op: "circularPattern";
  feature?: string;
  features?: string[];
  axis: { origin: Vec3; direction: Vec3 } | { ref: DatumRef };
  count: number;
  angle?: number;
  reverse?: boolean;
  skip?: number[];
}

// ----------------------------------------------------------------- member

/**
 * A straight structural member: a profile from the part's `profiles`, at one
 * of its sizes, swept from `from` to `to`. It is a body of its own, named by
 * `newBody` or else its id. The profile is upright: its y axis is as close to
 * world +Z as the line allows (+Y for a vertical member), then turned by
 * `rotation` degrees about the line.
 */
export interface MemberFeature extends FeatureBase {
  op: "member";
  profile: string;
  size: string;
  /** In the file, a point or a node's name; validated, the point. */
  from: Vec3;
  to: Vec3;
  /** The nodes it joins, when `from` or `to` named one. */
  fromNode?: string;
  toNode?: string;
  rotation?: number;
  /**
   * Where the line runs through the section, on its envelope: [0, 0] the
   * middle, [-1, 1] the top left as seen from the `to` end (x across, y up).
   * Without it, the profile's anchor is on the line.
   */
  align?: Vec2;
  newBody?: string;
}

// ------------------------------------------------------------------ joints

/**
 * What happens where members meet at a node. Every member that ends at the
 * node and is not one of the joint's own butts against them.
 * - mitre: `members` (two that end at the node) are cut on the plane that
 *   halves the angle between them.
 * - butt: `through` runs through, extended to cover the others if it ends
 *   at the node; the others stop at its face.
 * `gap` (mm) is left between the cut faces.
 */
export interface JointFeature extends FeatureBase {
  op: "joint";
  node: string;
  type: JointType;
  members?: [string, string];
  through?: string;
  gap?: number;
}
export const JOINT_TYPES = ["mitre", "butt"] as const;
export type JointType = (typeof JOINT_TYPES)[number];

/** A plate of the section's outline closing a member's square end; a body of its own. */
export interface EndCapFeature extends FeatureBase {
  op: "endCap";
  member: string;
  end: "start" | "end";
  thickness: number;
  newBody?: string;
}

/**
 * A triangular plate in the inside corner between two members at a node, in
 * the plane of their lines and centred on their sections. Its legs run `size`
 * mm along each member from where their inner faces meet; `chamfer` clips the
 * corner for the weld. A body of its own.
 */
export interface GussetFeature extends FeatureBase {
  op: "gusset";
  node: string;
  members: [string, string];
  size: number;
  thickness: number;
  chamfer?: number;
  newBody?: string;
}

// ------------------------------------------------------- multibody tools

/**
 * Mirrors about a plane (Phase M). Either earlier features, the way a
 * pattern repeats it (a cut cuts the same bodies; an extrude adds to the same
 * body; one that starts a body, or a member, makes a new body `<body>_mirror`),
 * or whole bodies as they are here, each into a new body `<name>_mirror`, or
 * fused into itself with `merge`.
 */
export interface MirrorFeature extends FeatureBase {
  op: "mirror";
  /** Written out, or by reference: a flat face of the part, a default plane or a plane feature ({ "type": "ref", "ref": ... }). */
  plane: PlaneSpec;
  feature?: string;
  /** Several features, each mirrored as `feature` is. */
  features?: string[];
  bodies?: string[];
  merge?: boolean;
  /** The new body's name, when the mirror makes exactly one. */
  newBody?: string;
}

/** Cuts a body in two with a plane: the piece the normal points to becomes `newBody` (default `<body>_split`). */
export interface SplitFeature extends FeatureBase {
  op: "split";
  body: string;
  plane: PlaneSpec;
  newBody?: string;
}

/** Turns (first) and moves bodies; with `copy`, the originals stay and the copies are new bodies `<name>_copy`. */
export interface MoveFeature extends FeatureBase {
  op: "move";
  bodies: string[];
  translate?: Vec3;
  rotate?: { axis: { origin: Vec3; direction: Vec3 }; angle: number };
  /**
   * Moves the bodies from one coordinate system (or plane: its origin and
   * axes) to another, before any rotate and translate: what sits at
   * `fromSystem`'s origin, along its axes, goes to `toSystem`'s. Both or neither.
   */
  fromSystem?: DatumRef;
  toSystem?: DatumRef;
  copy?: boolean;
  /** The copy's name, when one body is copied. */
  newBody?: string;
}

/** Deletes bodies, or keeps only these. */
export interface DeleteBodyFeature extends FeatureBase {
  op: "deleteBody";
  bodies?: string[];
  keep?: string[];
}

/** The suffix a tool gives the new body it derives from another when it isn't named: upright → upright_mirror. */
export const DERIVED_SUFFIX = { mirror: "_mirror", split: "_split", move: "_copy" } as const;

// ---------------------------------------------------------------- combine

/** Adds, subtracts or intersects bodies into `target`. The tool bodies are consumed. */
export interface CombineFeature extends FeatureBase {
  op: "combine";
  operation: "add" | "subtract" | "common";
  target: string;
  tools: string[];
}
export const COMBINE_OPERATIONS = ["add", "subtract", "common"] as const;

// ------------------------------------------------------------- selectors

/** Which of the matching faces to keep. "all" keeps every match. */
export type Pick = "largest" | "smallest" | "all";
export const PICKS: readonly Pick[] = ["largest", "smallest", "all"];

/**
 * Where a selector's face or edge was when the selector was made (picked in
 * the view): what the rebuild uses to find it again when the selector stops
 * matching after an upstream edit ("an edge moved - re-found it"). Optional:
 * selectors without it simply fail as before.
 */
export interface SelectorHint {
  /** The face's area centroid, or the edge's centre. */
  centroid: Vec3;
  /** A planar face's outward normal, or a straight edge's direction. */
  normal?: Vec3;
  /** Area of the face, or length of the edge. */
  size?: number;
}

/** Fields every face and edge selector may carry (Phase P provenance). */
export interface SelectorProvenance {
  /** Optional: only faces (edges) the feature with this id made (the rebuild records who made each). */
  createdBy?: string;
  /** Optional: where it was when picked, to find it again when it moves (see SelectorHint). */
  hint?: SelectorHint;
}

export interface PlanarFaceSelector extends SelectorProvenance {
  type: "planar";
  /** Outward face normal. */
  normal: Vec3;
  pick: Pick;
  /** Optional: signed distance of the face plane from the origin along `normal`. */
  offset?: number;
  /**
   * Optional: which level along the normal, counting the different planes the
   * matching faces lie in: 1 = the furthest out along the normal (the top face
   * for +Z), 2 the next one in, ...; -1 = the furthest in, -2 the next one out.
   * Unlike `offset` it keeps meaning the same face when the face moves (a
   * taller block), as long as the levels keep their order. Not with `offset`.
   */
  rank?: number;
  /** Optional: of the matches, the one whose centre is nearest this point (for otherwise identical faces). */
  near?: Vec3;
  /** Optional: only faces of this body. */
  body?: string;
}

export interface CylindricalFaceSelector extends SelectorProvenance {
  type: "cylindrical";
  radius?: number;
  /** Optional axis direction; matched in either sense. */
  axis?: Vec3;
  /** Optional: of the matches, the one whose centre is nearest this point. */
  near?: Vec3;
  pick: Pick;
  /** Optional: only faces of this body. */
  body?: string;
}

export type FaceSelector = PlanarFaceSelector | CylindricalFaceSelector;

/** Which of the matching edges to keep. */
export type EdgePick = "all" | "longest" | "shortest";
export const EDGE_PICKS: readonly EdgePick[] = ["all", "longest", "shortest"];

/**
 * Edges are found by query too. Every filter given must hold:
 * `onFace` - the edge bounds a face the face selector matches;
 * `between` - the edge is shared by a face matching each selector;
 * `direction` - a straight edge parallel to this (either sense);
 * `radius` - a circular edge of this radius; `length` - this length;
 * `near` - of the matches, the one whose centre is nearest this point.
 */
export interface EdgeSelector extends SelectorProvenance {
  type: "edge";
  kind?: "line" | "circle" | "other";
  onFace?: FaceSelector;
  between?: [FaceSelector, FaceSelector];
  direction?: Vec3;
  radius?: number;
  length?: number;
  near?: Vec3;
  pick: EdgePick;
  /** Optional: only edges of this body. */
  body?: string;
}
