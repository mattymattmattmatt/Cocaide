// The Cocaide feature document (.cocaide.json). This is the single source of
// truth: the B-rep, the mesh and every measurement are derived from it.

import { PLUGIN_OPS, type PluginFeature } from "../features/types";
import type { HoleFit, HoleKind, ThreadSpec } from "../features/hole/standards";

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
  /** A photo pinned under the part as a reference. Never geometry. */
  photo?: PhotoUnderlay;
  /** Weldment profiles the part uses, by name: its own copies, so it opens anywhere. */
  profiles?: Record<string, ProfileDef>;
  /** Named points a frame is built on (Phase J). In the file, coordinates may be expressions. */
  nodes?: Record<string, Vec3>;
  /** The weld table: notes, stored and listed, never modelled. */
  welds?: Weld[];
  features: Feature[];
  /** The part's fabrication drawing (Phase L): views of the rebuilt part, annotated. */
  drawing?: Drawing;
}

// ---------------------------------------------------------------- drawing

/**
 * A drawing of the part (Phase L): one sheet of views projected from the
 * rebuilt solid. Every number on it is measured on the rebuild; only notes and
 * the title block are typed. Coordinates on the sheet are mm from its lower
 * left corner, y up.
 */
export interface Drawing {
  sheet: Sheet;
  views: DrawingView[];
  annotations: Annotation[];
}

/** Landscape sheet sizes, mm (ISO 216). */
export const SHEET_SIZES = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841] } as const;
export type SheetSize = keyof typeof SHEET_SIZES;
export const PROJECTIONS = ["third", "first"] as const;
export type Projection = (typeof PROJECTIONS)[number];

export interface Sheet {
  size: SheetSize;
  /** "1:10", "2:1". Without it, the largest standard scale that fits. */
  scale?: string;
  /** Third-angle (the top view above the front) or first-angle (below). */
  projection: Projection;
  /** The title block. The part's name, material, mass and the scale fill the rest. */
  title?: string;
  number?: string;
  revision?: string;
  drawnBy?: string;
  date?: string;
}
export const SHEET_KEYS = ["size", "scale", "projection", "title", "number", "revision", "drawnBy", "date"] as const;

/** Where a view looks from. "iso" is from the front, right and above. */
export const VIEW_LOOKS = ["front", "back", "top", "bottom", "left", "right", "iso"] as const;
export type ViewLook = (typeof VIEW_LOOKS)[number];

export interface DrawingView {
  id: string;
  look: ViewLook;
  /** The view's centre on the sheet. Without it, the view is placed with the others. */
  at?: Vec2;
  /** Its own scale; else the sheet's. */
  scale?: string;
  /** Hidden edges, dashed. */
  hidden?: boolean;
}
export const VIEW_KEYS = ["id", "look", "at", "scale", "hidden"] as const;

/**
 * A point a dimension runs from or to: a node ("A"), a member's end
 * ("leg_a.start", "leg_a.end"), a hole's centre ("hole_1"), or a side of the
 * view's outline ("@left", "@right", "@top", "@bottom").
 */
export type DrawingPoint = string;
export const OUTLINE_SIDES = ["@left", "@right", "@top", "@bottom"] as const;
export const DIMENSION_DIRECTIONS = ["horizontal", "vertical", "aligned"] as const;
export type DimensionDirection = (typeof DIMENSION_DIRECTIONS)[number];

/**
 * A dimension, measured on the rebuild: between two points, or a member's cut
 * length along it (`member`), long point to long point.
 */
export interface DimensionAnnotation {
  id: string;
  type: "dimension";
  view: string;
  from?: DrawingPoint;
  to?: DrawingPoint;
  member?: string;
  /** Default: horizontal when the points are further apart across the view than up it, else vertical. A member's is along it. */
  direction?: DimensionDirection;
  /** Sheet mm from the part to the dimension line; the sign picks the side (+ above or right). Default: stacked outside the view. */
  offset?: number;
}

/** "Ø8 THRU" on a hole the view sees as a circle; "4× Ø8 THRU" when it is patterned. */
export interface HoleAnnotation {
  id: string;
  type: "hole";
  view: string;
  hole: string;
  /** The text, from the view's centre, sheet mm. Default: beside the hole. */
  at?: Vec2;
}

/** A member's cut list item number in a circle, with a leader to the member. */
export interface BalloonAnnotation {
  id: string;
  type: "balloon";
  view: string;
  member: string;
  /** The balloon, from the view's centre, sheet mm. Default: outside the view, near the member. */
  at?: Vec2;
}

/** A weld from the weld table, as a symbol with an arrow to where its bodies meet. */
export interface WeldAnnotation {
  id: string;
  type: "weld";
  view: string;
  weld: string;
  /** The symbol's reference line, from the view's centre, sheet mm. */
  at?: Vec2;
}

export const DRAWING_TABLES = ["cutList", "welds"] as const;
export type DrawingTable = (typeof DRAWING_TABLES)[number];

/** The cut list or the weld table. */
export interface TableAnnotation {
  id: string;
  type: "table";
  table: DrawingTable;
  /** The table's top left corner on the sheet. Default: stacked above the title block. */
  at?: Vec2;
}

/** Free text on the sheet. */
export interface NoteAnnotation {
  id: string;
  type: "note";
  text: string;
  /** Where the text starts on the sheet (its first line's baseline). */
  at: Vec2;
}

export type Annotation = DimensionAnnotation | HoleAnnotation | BalloonAnnotation | WeldAnnotation | TableAnnotation | NoteAnnotation;
export type AnnotationType = Annotation["type"];
export const ANNOTATION_TYPES = ["dimension", "hole", "balloon", "weld", "table", "note"] as const;
export const ANNOTATION_KEYS: Record<AnnotationType, readonly string[]> = {
  dimension: ["id", "type", "view", "from", "to", "member", "direction", "offset"],
  hole: ["id", "type", "view", "hole", "at"],
  balloon: ["id", "type", "view", "member", "at"],
  weld: ["id", "type", "view", "weld", "at"],
  table: ["id", "type", "table", "at"],
  note: ["id", "type", "text", "at"],
};

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
}
export const WELD_TYPES = ["fillet", "butt", "plug"] as const;
export type WeldType = (typeof WELD_TYPES)[number];
export const WELD_KEYS = ["id", "between", "type", "size", "length", "allRound", "note"] as const;

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
  /** A note, like a drawing's material note. It does not set the density. */
  material?: string;
  /** The library entry this copy came from. */
  library?: { id: string; version: number };
}

export interface ProfileSize {
  designation: string;
  values: Record<string, number>;
}

export const PROFILE_KEYS = ["name", "entities", "constraints", "parameters", "sizes", "anchor", "tags", "material", "library"] as const;

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
 * - { datum: "<id>" }: an earlier plane, axis or point feature.
 * - { face }: a planar face is a plane (its outward normal); a cylindrical or
 *   conical face is its axis.
 * - { edge }: a straight edge is an axis (start to end); a circular edge is its
 *   axis, or its centre where a point is needed. With `at`, that point of it.
 * - { point }: a fixed point.
 */
export type DatumRef =
  | { datum: string }
  | { face: FaceSelector }
  | { edge: EdgeSelector; at?: EdgePoint }
  | { point: Vec3 };
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

export type SketchEntity = LineEntity | CircleEntity | ArcEntity | RectEntity | SlotEntity | PointEntity | EllipseEntity | SplineEntity;
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
 * Two points mirrored about a line (`points`); or two lines, two arcs or two
 * circles that are each other's mirror images about it (`entities`: their
 * ends pair up as they lie, the arcs' centres and radii too). Exactly one of
 * the two. Mirror Entities relates each copy to its original this way.
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

export interface PlanarFaceSelector {
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

export interface CylindricalFaceSelector {
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
export interface EdgeSelector {
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
