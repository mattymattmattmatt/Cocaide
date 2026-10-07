// The Cocaide feature document (.cocaide.json). This is the single source of
// truth: the B-rep, the mesh and every measurement are derived from it.

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
  /** Where the part came from, kept as notes (a drawing's title block). Stored, never simulated. */
  source?: DocumentSource;
  /** A photo pinned under the part as a reference. Never geometry. */
  photo?: PhotoUnderlay;
  features: Feature[];
}

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
  | CombineFeature;
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

export interface SketchFeature extends FeatureBase {
  op: "sketch";
  plane: DatumPlane;
  entities: SketchEntity[];
  constraints?: Constraint[];
}

interface EntityBase {
  id: string;
  /** Construction geometry is kept for constraints but never becomes a profile. */
  construction?: boolean;
}

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

export type SketchEntity = LineEntity | CircleEntity | ArcEntity | RectEntity | SlotEntity;
export type SketchEntityType = SketchEntity["type"];

/** "entityId.point", e.g. "l1.end", "a2.center", "s1.center2", or "origin" for the sketch origin. */
export type PointRef = string;

export interface CoincidentConstraint {
  type: "coincident";
  points: [PointRef, PointRef];
}

export interface OrientationConstraint {
  type: "horizontal" | "vertical";
  entity: string;
}

/** Either `entity` (a line, rect or slot) or `points` (two point refs). */
export interface DistanceConstraint {
  type: "distance" | "distanceX" | "distanceY";
  entity?: string;
  points?: [PointRef, PointRef];
  value: number;
}

export interface RadiusConstraint {
  type: "radius";
  entity: string;
  value: number;
}

export interface EqualConstraint {
  type: "equal";
  entities: [string, string];
}

export type Constraint =
  | CoincidentConstraint
  | OrientationConstraint
  | DistanceConstraint
  | RadiusConstraint
  | EqualConstraint;
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
export const PATTERNABLE_OPS = ["extrude", "cut", "hole"] as const;

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
