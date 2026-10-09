// The Cocaide feature document (.cocaide.json). This is the single source of
// truth: the B-rep, the mesh and every measurement are derived from it.

import { PLUGIN_OPS, type PluginFeature } from "../features/types";

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

export type SketchEntity = LineEntity | CircleEntity | ArcEntity | RectEntity | SlotEntity | PointEntity;
export type SketchEntityType = SketchEntity["type"];

/** "entityId.point", e.g. "l1.end", "a2.center", "s1.center2", "p1.at", or "origin" for the sketch origin. */
export type PointRef = string;

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
export interface DistanceConstraint {
  type: "distance" | "distanceX" | "distanceY";
  entity?: string;
  points?: [PointRef, PointRef];
  point?: PointRef;
  line?: string;
  value: number;
}

export interface RadiusConstraint {
  type: "radius" | "diameter";
  entity: string;
  value: number;
}

export interface EqualConstraint {
  type: "equal";
  entities: [string, string];
}

/**
 * Relations between two entities, as SOLIDWORKS has them: parallel,
 * perpendicular and collinear lines; tangent (a line and a circle or arc, or
 * two circles or arcs, on whichever side they are); concentric circles or arcs.
 */
export interface PairConstraint {
  type: "parallel" | "perpendicular" | "collinear" | "tangent" | "concentric";
  entities: [string, string];
}

/** The angle between two lines' directions (start to end), in degrees, over 0 and under 180. */
export interface AngleConstraint {
  type: "angle";
  entities: [string, string];
  value: number;
}

/** A point at the middle of a line, or on a line (extended), circle or arc. */
export interface PointOnConstraint {
  type: "midpoint" | "pointOn";
  point: PointRef;
  entity: string;
}

/** Two points mirrored about a line. */
export interface SymmetricConstraint {
  type: "symmetric";
  points: [PointRef, PointRef];
  line: string;
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
  | FixConstraint;
export type ConstraintType = Constraint["type"];

// ------------------------------------------------------- extrude and cut

export type ExtrudeExtent = "blind" | "midplane" | "throughAll";

export interface ExtrudeFeature extends FeatureBase {
  /** extrude adds material, cut removes it. Same parameters. */
  op: "extrude" | "cut";
  sketch: string;
  /** Default "blind". */
  extent?: ExtrudeExtent;
  /** Required for blind and midplane (midplane: total length, split evenly). */
  distance?: number;
  /** Default: the sketch plane normal. Must not lie in the sketch plane. */
  direction?: Vec3;
  /** extrude: the body to add to (default "main"). */
  body?: string;
  /** extrude: start a new body with this name instead. */
  newBody?: string;
  /** cut: the bodies to cut. Default: every body it reaches. Each listed one must lose material. */
  bodies?: string[];
}

// ------------------------------------------------------------------ hole

/**
 * A hole drilled into a planar face, against the face's outward normal.
 * `center` is in the face's plane frame: origin = the global origin projected
 * onto the face plane, axes from the same rule as a datum plane.
 */
export interface HoleFeature extends FeatureBase {
  op: "hole";
  face: FaceSelector;
  center: Vec2;
  diameter: number;
  depth: number | "through";
  counterbore?: { diameter: number; depth: number };
  countersink?: { diameter: number; angle: number };
  /** The bodies to drill. Default: every body it reaches. Each listed one must lose material. */
  bodies?: string[];
}

// ---------------------------------------------------- fillet and chamfer

/** Rounds the selected edges. `edges` is one selector or a list whose matches are combined. */
export interface FilletFeature extends FeatureBase {
  op: "fillet";
  edges: EdgeSelector | EdgeSelector[];
  radius: number;
}

/** Bevels the selected edges by `distance` on both adjacent faces. */
export interface ChamferFeature extends FeatureBase {
  op: "chamfer";
  edges: EdgeSelector | EdgeSelector[];
  distance: number;
}

// -------------------------------------------------------------- patterns

/** Ops a pattern can repeat: the ones that add or remove one tool body. */
export const PATTERNABLE_OPS = ["extrude", "cut", "hole", "member"] as const;

/**
 * Repeats one earlier extrude, cut or hole. `count` includes the original;
 * the optional second direction makes a grid of count x count2.
 */
export interface LinearPatternFeature extends FeatureBase {
  op: "linearPattern";
  feature: string;
  direction: Vec3;
  spacing: number;
  count: number;
  direction2?: Vec3;
  spacing2?: number;
  count2?: number;
}

/**
 * Repeats one earlier extrude, cut or hole about an axis. `count` includes
 * the original. `angle` is the total sweep in degrees (default 360): a full
 * turn spaces instances angle/count apart, a partial one angle/(count - 1).
 */
export interface CircularPatternFeature extends FeatureBase {
  op: "circularPattern";
  feature: string;
  axis: { origin: Vec3; direction: Vec3 };
  count: number;
  angle?: number;
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
 * Mirrors about a plane (Phase M). Either one earlier feature, the way a
 * pattern repeats it (a cut cuts the same bodies; an extrude adds to the same
 * body; one that starts a body, or a member, makes a new body `<body>_mirror`),
 * or whole bodies as they are here, each into a new body `<name>_mirror`, or
 * fused into itself with `merge`.
 */
export interface MirrorFeature extends FeatureBase {
  op: "mirror";
  plane: PlaneSpec;
  feature?: string;
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
