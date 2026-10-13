// The AI tools added for building whole parts: one spec per tool (a zod
// shape and a description) feeding both hosts. The MCP server registers the
// zod shapes as they are; the right-click agent gets them as Anthropic tool
// schemas (anthropicTool). The tools themselves are in inspect.ts, batch.ts,
// sketchProfile.ts and helpers.ts.

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { BATCH_TOOLS } from "./batch";

const obj = z.record(z.string(), z.unknown());
const vec3 = z.array(z.number()).length(3);
const faceSel = obj.describe('A face selector, e.g. { "type": "planar", "normal": [0,0,1], "pick": "largest" } (listFaces gives one for every face)');
const operand = z
  .union([vec3, obj])
  .describe('A face or edge selector picking one thing, a point [x, y, z], { "datum": "Top" | "X" | "Origin" | "<plane/axis/point feature>" }, or { "sketch": "<id>", "point": "l1.end" }');

export interface ToolSpec {
  name: string;
  description: string;
  input: z.ZodRawShape;
  readOnly: boolean;
}

export const SPECS: ToolSpec[] = [
  {
    name: "partSummary",
    description:
      "The part at a glance: every feature with its rebuild status (and error), parameters, reference geometry, and the measured result: volume, surface area, bounding box, mass, holes, and each body (volume, box, centre of mass, which features make it). Start here, and use it to check a build.",
    input: {},
    readOnly: true,
  },
  {
    name: "listFaces",
    description:
      "The part's faces, each with a ready-to-use selector that picks it alone, its type, area, centroid, normal and offset (flat), radius and axis (round), body, the feature that made it, and for a flat face its sketch frame (origin, x, y: where a sketch on it or a hole's center puts 2D coordinates) with its centroid and box in that frame. Filters: type, normal (faces facing that way), madeBy (a feature id), body, near (closest first). Largest first.",
    input: {
      type: z.enum(["plane", "cylinder", "cone", "other"]).optional(),
      normal: vec3.optional().describe("Only flat faces whose outward normal is this direction"),
      madeBy: z.string().optional().describe("Only faces this feature made"),
      body: z.string().optional(),
      near: vec3.optional().describe("Sort by distance from this point"),
      limit: z.number().int().optional().describe("Default 40"),
    },
    readOnly: true,
  },
  {
    name: "listEdges",
    description:
      'The part\'s edges (seams left out), each with a ready-to-use selector that picks it alone, its kind, length, ends, direction or radius and centre, the faces it lies between (with the features that made them) and its corner: "convex" (outside: a fillet rounds it off), "concave" (inside: a fillet fills it) or "smooth". When several match, allSelector picks exactly all of them (for one fillet or chamfer). Filters: kind, direction, radius, onFace (a face selector), madeBy, corner, body, near. Longest first.',
    input: {
      kind: z.enum(["line", "circle", "other"]).optional(),
      direction: vec3.optional().describe("Straight edges parallel to this"),
      radius: z.number().optional().describe("Round edges of this radius"),
      onFace: faceSel.optional(),
      madeBy: z.string().optional().describe("Edges of the faces this feature made"),
      corner: z.enum(["convex", "concave", "smooth"]).optional(),
      body: z.string().optional(),
      near: vec3.optional(),
      limit: z.number().int().optional().describe("Default 40"),
    },
    readOnly: true,
  },
  {
    name: "measureBetween",
    description:
      "The shortest distance between two things on the part as it is now (faces, edges, points, default or feature planes, axes and points, sketch points), the closest points and the vector between them; with two directions (flat faces, straight edges, axes) the angle between them (and between two planes' normals); with two round things or axes the distance between their axes.",
    input: { a: operand, b: operand },
    readOnly: true,
  },
  {
    name: "getSketch",
    description:
      "One sketch in full: its plane and resolved frame (origin, x, y, normal in world coordinates), entities (as solved), every constraint with its index, dimension name, a readable label and what it measures now, its status (fully defined / under defined with the free points / over defined with the conflicting constraints, DOF) and its profile (closed regions and areas, or why it is open).",
    input: { id: z.string() },
    readOnly: true,
  },
  {
    name: "facePlane",
    description:
      'The frame of a flat face, to place a sketch or a hole on it: the plane spec to give a sketch ({ "type": "ref", "ref": { "face": <selector> } }, follows the face), the frame (origin = the world origin projected onto the face, x, y, normal), the same as a fixed datum plane, and the face\'s centroid and box in that frame. offset moves it along the normal; points converts world points to the frame\'s 2D coordinates.',
    input: { face: faceSel, offset: z.number().optional(), points: z.array(vec3).optional() },
    readOnly: true,
  },
  {
    name: "listDatums",
    description: "The reference geometry: the default planes (Top, Front, Right), axes (X, Y, Z) and Origin, and each plane, axis and point feature with where it is now (or why it failed). Use any as { \"datum\": <name or id> }.",
    input: {},
    readOnly: true,
  },
  {
    name: "reference",
    description:
      "One section of the document reference, fetched when you need it: an op by name (revolve, sweep, hole, extrude, linearPattern, ...) or a topic (document, expressions, sketch, sketch-edits, references, selectors, bodies, weldments, drawing, examples, strategy, tools). Without a section: the list of sections.",
    input: { section: z.string().optional() },
    readOnly: true,
  },
  {
    name: "plan",
    description:
      'Before building a whole part: write down the feature tree you will build (one line per feature, in order) and the checks the result must pass, from the request. Checks: { "label", "measure": "volume" | "sizeX" | "sizeY" | "sizeZ" | "holes" | "bodies" | "surfaceArea" | "massKg", "expected": number, "tolerance"?: fraction (default 0.01) }. When you stop, the checks are run on the result and any that fail are sent back to you.',
    input: {
      features: z.array(z.string()).describe('e.g. ["sk_profile: half section of the fitting on Front", "body: revolve sk_profile about Z", ...]'),
      checks: z.array(obj).optional(),
    },
    readOnly: true,
  },
  {
    name: "batch",
    description: `Several edits as ONE transaction: the steps are applied in order, the part is rebuilt once, and all of them are kept (one undo step) only if nothing newly fails; otherwise none is, and the error names the failing step. Build a whole chain in one call (a sketch, its extrude, the holes, a pattern, the fillets). Each step is { "tool": <one of ${BATCH_TOOLS.join(", ")}>, ...that tool's arguments }; give new features and entities your own ids so later steps can name them. dryRun: true rebuilds and reports the result without keeping anything. The result lists what each step made (feature ids, entity ids, constraint indices) and the part's volume.`,
    input: {
      commands: z.array(obj).describe('e.g. [{ "tool": "sketchProfile", "sketch": "sk1", "shapes": [...] }, { "tool": "addFeature", "feature": { "id": "body", "op": "revolve", "sketch": "sk1", "axis": { "datum": "Z" } } }]'),
      dryRun: z.boolean().optional(),
    },
    readOnly: false,
  },
  {
    name: "sketchProfile",
    description:
      'A whole sketch from a compact description, with the relations a CAD user would add (coincident ends, horizontal/vertical lines, tangent arcs, equal fillets) and dimensions (any "=expression" you give is kept), then Fully Define for the rest, so it comes out fully defined. "sketch": a new id (with "plane", default Top) or an existing sketch to add to. "shapes": { "polyline": [[x,y], { "at": [x,y], "fillet": r }, { "arcTo": [x,y], "center" | "through": [x,y] | "tangent": true, "clockwise"? }], "closed"?: true } | { "rect": { "center" | "corner": [x,y], "width", "height", "fillet"? } } | { "circle": { "center", "diameter" | "radius" } } | { "slot": { "from", "to", "width" } } | { "polygon": { "center", "sides", "diameter" | "acrossFlats", "angle"? } } | { "line": { "from", "to" } } | { "point": [x,y] }; each may add "construction": true, "id" (the entity id, or a prefix for several: <id>_1, <id>_2 ...) and "name" (its dimension names). "dimensions": "none" skips Fully Define; "datum": the point positions are measured from (default "origin").',
    input: {
      sketch: z.string(),
      plane: obj.optional().describe('A new sketch\'s plane: { "type": "ref", "ref": { "datum": "Front" } }, a face, a plane feature ...'),
      shapes: z.array(obj),
      dimensions: z.enum(["full", "none"]).optional(),
      datum: z.string().optional(),
    },
    readOnly: false,
  },
  {
    name: "fullyDefine",
    description: "Fully Define Sketch: adds the relations and dimensions a sketch is missing, measured from its geometry as it is (nothing moves): what is level, plumb or touching, then sizes, then each point's X and Y from the datum (the origin, or a point such as \"l1.start\").",
    input: { sketch: z.string(), datum: z.string().optional(), relations: z.boolean().optional(), dimensions: z.boolean().optional() },
    readOnly: false,
  },
  {
    name: "holes",
    description:
      'Hole Wizard holes on a flat face, laid out for you: "at": { "circle": { "center"?: [x,y], "diameter", "count", "startAngle"? } } (a bolt circle: one hole and a circular pattern of it) | { "grid": { "center" | "corner": [x,y], "columns", "rows", "pitchX", "pitchY" } } (one hole and a linear pattern) | { "corners": { "inset" } } (one hole at each corner of the face\'s box) | { "points": [[x,y], ...] } | { "center": [x,y] }, in the face\'s frame (facePlane). The hole takes size ("M6"), kind (simple, counterbore, countersink, tapped), fit, diameter, depth (default "through"), counterbore, countersink, thread, bodies. "pattern": false makes one hole with several centres instead of a pattern. "id" names the hole.',
    input: {
      face: faceSel,
      at: obj,
      id: z.string().optional(),
      size: z.string().optional(),
      kind: z.string().optional(),
      fit: z.string().optional(),
      diameter: z.union([z.number(), z.string()]).optional(),
      depth: z.union([z.number(), z.string()]).optional(),
      counterbore: obj.optional(),
      countersink: obj.optional(),
      thread: obj.optional(),
      bodies: z.array(z.string()).optional(),
      pattern: z.boolean().optional(),
    },
    readOnly: false,
  },
];

export const SPEC = new Map(SPECS.map((s) => [s.name, s]));

/** The new write tools (they edit through commands, like the old ones). */
export const NEW_WRITE_TOOLS = new Set(SPECS.filter((s) => !s.readOnly).map((s) => s.name));

/** A spec as the Messages API's tool: its JSON schema, without the keywords the API doesn't need. */
export function anthropicTool(name: string): Anthropic.Tool {
  const s = SPEC.get(name);
  if (!s) throw new Error(`no tool spec "${name}"`);
  const schema = tidy(z.toJSONSchema(z.object(s.input).strict())) as Anthropic.Tool["input_schema"];
  return { name: s.name, description: s.description, input_schema: schema };
}

function tidy(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(tidy);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "$schema" || k === "propertyNames") continue;
      out[k] = k === "additionalProperties" && x && typeof x === "object" && Object.keys(x).length === 0 ? true : tidy(x);
    }
    return out;
  }
  return v;
}
