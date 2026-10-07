// Intent: what the user asked for, before it is a feature document (spec
// 5.1). The model reads a prompt or a drawing into this; every number
// carries where it came from and how sure the reading is. The planner turns
// a confirmed intent into features. Intent is not the document.

import { z } from "zod";
import { CORNERS, FRAME_TYPES, KINDS, PLACEMENTS, SOURCES } from "./constants";

export { CORNERS, FRAME_TYPES, KINDS, PLACEMENTS, SOURCES };

/**
 * Where a value came from:
 * - stated: the user typed it, or it is printed on the drawing
 * - standard: derived from a named standard the user typed (M6 clearance = 6.6)
 * - inferred: the model's guess
 * - missing: nobody said
 */
export type Source = (typeof SOURCES)[number];

const field = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    value: value.nullable(),
    /** The exact words (or drawing text) the value comes from; "" when none. */
    evidence: z.string(),
    source: z.enum(SOURCES),
    /** 0 to 1. */
    confidence: z.number(),
  });

export const NumberField = field(z.number());
export type NumberField = z.infer<typeof NumberField>;

export const TextField = field(z.string());
export type TextField = z.infer<typeof TextField>;

const Point = z.object({ x: z.number(), y: z.number() });
export const PointsField = field(z.array(Point));
export type PointsField = z.infer<typeof PointsField>;

export type Placement = (typeof PLACEMENTS)[number];

export const HoleGroup = z.object({
  diameter: NumberField,
  count: NumberField,
  placement: z.enum(PLACEMENTS),
  /** corners: distance from each of the two nearest edges to the hole centre. */
  inset: NumberField,
  /** points: hole centres, measured from the plate's lower-left corner (x right, y up); for a disc, from its centre. */
  points: PointsField,
  /** grid: rows (along Y) and columns (along X), and the centre-to-centre pitch; the grid is centred on the part. */
  rows: NumberField,
  columns: NumberField,
  pitchX: NumberField,
  pitchY: NumberField,
  /** circle: diameter of the circle the hole centres lie on, centred on the part. */
  circleDiameter: NumberField,
  /** null value: through. */
  depth: NumberField,
});
export type HoleGroup = z.infer<typeof HoleGroup>;

/**
 * A frame of structural members (Phase K). Sizes are outside sizes. The
 * section is the user's words; code matches them against the section library.
 */
export const FrameIntent = z.object({
  type: z.enum(FRAME_TYPES),
  /** Outside size along X. */
  length: NumberField,
  /** Outside size along Y. */
  width: NumberField,
  /** table: floor to top, along Z. */
  height: NumberField,
  /** The section exactly as written in the request ("SHS 40×40×3", "40x40x3 box section"); value null when not given. */
  section: TextField,
  /** How the corners are joined; "unspecified" when the request does not say. */
  corners: z.enum(CORNERS),
});
export type FrameIntent = z.infer<typeof FrameIntent>;

export const Intent = z.object({
  /** create: a new part. edit: change the current part. answer: a question about it. */
  action: z.enum(["create", "edit", "answer"]),
  kind: z.enum(KINDS),
  /** A short name for the part, e.g. "mounting plate". */
  name: z.string(),
  /** The units the numbers below are in, as the user gave them. They are converted to mm once, by the planner. */
  units: z.enum(["mm", "in"]),
  /** plate: size along X. */
  width: NumberField,
  /** plate: size along Y. */
  height: NumberField,
  thickness: NumberField,
  /** disc: outside diameter. */
  diameter: NumberField,
  /** plate: radius of the four vertical corners; null value: sharp. */
  cornerRadius: NumberField,
  holes: z.array(HoleGroup),
  /** frame: the frame; null for any other kind. */
  frame: FrameIntent.nullable(),
  /** other: what the part is, in a sentence. */
  description: z.string(),
  /** What the model would need to know that the request does not say. */
  questions: z.array(z.string()),
});
export type Intent = z.infer<typeof Intent>;

export const blank = (): NumberField => ({ value: null, evidence: "", source: "missing", confidence: 0 });
export const blankText = (): TextField => ({ value: null, evidence: "", source: "missing", confidence: 0 });

export const emptyFrame = (type: FrameIntent["type"] = "table"): FrameIntent => ({
  type,
  length: blank(),
  width: blank(),
  height: blank(),
  section: blankText(),
  corners: "unspecified",
});
export const stated = (value: number, evidence: string): NumberField => ({ value, evidence, source: "stated", confidence: 1 });

export const emptyHoleGroup = (): HoleGroup => ({
  diameter: blank(),
  count: blank(),
  placement: "unspecified",
  inset: blank(),
  points: { value: null, evidence: "", source: "missing", confidence: 0 },
  rows: blank(),
  columns: blank(),
  pitchX: blank(),
  pitchY: blank(),
  circleDiameter: blank(),
  depth: blank(),
});

export const emptyIntent = (action: Intent["action"] = "create"): Intent => ({
  action,
  kind: "plate",
  name: "part",
  units: "mm",
  width: blank(),
  height: blank(),
  thickness: blank(),
  diameter: blank(),
  cornerRadius: blank(),
  holes: [],
  frame: null,
  description: "",
  questions: [],
});
