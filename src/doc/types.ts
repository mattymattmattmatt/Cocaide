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
  /** Used for the mass measurement. Defaults to steel (7850 kg/m³) when absent. */
  material?: Material;
  features: Feature[];
}

export interface Material {
  name?: string;
  densityKgPerM3: number;
}

export type Feature = SketchFeature | ExtrudeFeature | HoleFeature;
export type FeatureOp = Feature["op"];
export const FEATURE_OPS: readonly FeatureOp[] = ["sketch", "extrude", "cut", "hole"];

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

export interface SketchFeature {
  id: string;
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

/** "entityId.point", e.g. "l1.end", "a2.center", "s1.center2". */
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

export interface ExtrudeFeature {
  id: string;
  /** extrude adds material, cut removes it. Same parameters. */
  op: "extrude" | "cut";
  sketch: string;
  /** Default "blind". */
  extent?: ExtrudeExtent;
  /** Required for blind and midplane (midplane: total length, split evenly). */
  distance?: number;
  /** Default: the sketch plane normal. Must not lie in the sketch plane. */
  direction?: Vec3;
}

// ------------------------------------------------------------------ hole

/**
 * A hole drilled into a planar face, against the face's outward normal.
 * `center` is in the face's plane frame: origin = the global origin projected
 * onto the face plane, axes from the same rule as a datum plane.
 */
export interface HoleFeature {
  id: string;
  op: "hole";
  face: FaceSelector;
  center: Vec2;
  diameter: number;
  depth: number | "through";
  counterbore?: { diameter: number; depth: number };
  countersink?: { diameter: number; angle: number };
}

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
}

export interface CylindricalFaceSelector {
  type: "cylindrical";
  radius?: number;
  /** Optional axis direction; matched in either sense. */
  axis?: Vec3;
  pick: Pick;
}

export type FaceSelector = PlanarFaceSelector | CylindricalFaceSelector;
