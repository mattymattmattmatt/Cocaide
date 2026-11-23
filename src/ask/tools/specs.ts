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

/** When the AI should file a tool issue (the same words for every host). */
export const TOOL_ISSUE_RULE =
  "If a Cocaide tool fails in a way that looks like a bug, refuses something it should take, its description or the reference misled you, or no tool does what the user asked (so you had to work around it), call reportToolIssue once per problem: which tool, what you tried, what happened, and what would have helped. It goes into the user's tool-issue log for Cocaide's developers. Then carry on with the task; never report the user's own mistakes or a refusal that was right (a write scope, a size the user must confirm).";

const mateRefSpec = obj.describe('What a mate holds on a component: { "component": "<id>", "face": <face selector> } (a flat face: its plane; a round face: its axis), or "edge": <edge selector>, or "datum": "Top" | "Front" | "Right" | "X" | "Y" | "Z" | "Origin" of its part. mateFeatures gives a ready ref for every mateable face');

/** The assembly tools (src/assembly/tools.ts): put parts together and mate them, as the Assembly tab does. */
const ASSEMBLY_SPECS: ToolSpec[] = [
  {
    name: "assembly",
    description:
      "The assembly at a glance (the document's Assembly tab): each component (its part, where it is: at [x,y,z] mm and rotation [rx,ry,rz] degrees about X then Y then Z, fixed or not, and roughly where it sits), the parts it uses, each mate and whether it holds. Start here before changing an assembly.",
    input: {},
    readOnly: true,
  },
  {
    name: "insertComponent",
    description:
      'Put a part in the assembly as a component (the first one goes in fixed at the origin; mate the others to it). "part": "self" (this document\'s own part, the default), a part key the assembly carries already, { "example": "<example name>" }, or { "file": "<path to a .cocaide.json part or a .step/.stp file>" } (a STEP file comes in as an imported part; its holes and faces are mateable like any). "at" and "rotation" place it; else it goes at the origin.',
    input: {
      part: z.unknown().optional().describe('"self", a carried part key, { "example": "flange" } or { "file": "path" }'),
      id: z.string().optional().describe("Its id (default <part name>-<n>)"),
      at: vec3.optional(),
      rotation: vec3.optional().describe("Degrees about X, then Y, then Z"),
      fixed: z.boolean().optional(),
    },
    readOnly: false,
  },
  {
    name: "setComponent",
    description: 'Move, turn, fix or float, hide or show, make transparent or colour a component: { "id", "patch": { "at"?, "rotation"?, "fixed"?, "hidden"?, "transparent"?, "appearance"? } } (transparent: drawn see-through and clicked through, to reach what is inside or behind it; appearance: { "color": "#rrggbb", "opacity"?, "finish"? } or null for the colours of its part). The mates are solved after (a mated component goes where they hold it).',
    input: { id: z.string(), patch: obj },
    readOnly: false,
  },
  {
    name: "deleteComponent",
    description: "Take a component out of the assembly, with its mates (a part no other component uses goes from the file too).",
    input: { id: z.string() },
    readOnly: false,
  },
  {
    name: "addMate",
    description:
      'Mate two things of two components; the components that aren\'t fixed move until every mate holds. Refused (nothing changes) when the new mate can\'t hold, saying why. Types: "coincident" (flat faces against each other — facing unless "aligned": true; an edge or axis on a face; two axes in line), "distance" (value mm between faces), "concentric" (two round faces or edges on one axis: a pin in a hole), "parallel", "perpendicular", "angle" (value degrees), "tangent" (a round face on a flat one, or two round faces touching; "flip": true for the flat face\'s other side, or one round face inside the other), "lock" (two parts held together as they are now: a and b any face of each). A limit: "min" and "max" on a distance or angle (it holds anywhere in the range). "lockRotation": true on a concentric stops it spinning. Which way round: "aligned": true (the same direction) or "opposed": true (opposite) for parallel, concentric and axes in line; "flip": true puts a distance on the other side of the first face. Take a and b from mateFeatures or suggestMates.',
    input: {
      type: z.string(),
      a: mateRefSpec,
      b: mateRefSpec,
      value: z.number().optional().describe("distance: mm; angle: degrees"),
      aligned: z.boolean().optional().describe("coincident or distance between flat faces: the faces face the same way, not each other; parallel, concentric, axes in line: the same direction"),
      opposed: z.boolean().optional().describe("parallel, concentric, axes in line: opposite directions (neither aligned nor opposed: either way)"),
      flip: z.boolean().optional().describe("distance: the other side of the first face; tangent: the flat face's other side, or one round face inside the other"),
      min: z.number().optional().describe("distance or angle: a limit mate holds anywhere from min to max (give both; value is then where it starts)"),
      max: z.number().optional(),
      lockRotation: z.boolean().optional().describe("concentric: it can't spin about the axis either (kept as it is now)"),
      id: z.string().optional(),
    },
    readOnly: false,
  },
  {
    name: "editMate",
    description: 'Change a mate: { "id", "patch": { "type"?, "value"?, "aligned"?, "opposed"?, "flip"?, "suppressed"?, "a"?, "b"? } } (flip flat faces by toggling aligned; directions by swapping aligned and opposed; an angle by 180 − value; a distance\'s side or a tangent by flip). Refused when it then can\'t hold.',
    input: { id: z.string(), patch: obj },
    readOnly: false,
  },
  {
    name: "copyToHoles",
    description: 'Copy a component that sits in a hole (a bolt, a pin: concentric with the hole) into every other free hole of that size on the same part, each copy with the original\'s mates: { "id" }. Copies whose mates would not hold are left out.',
    input: { id: z.string() },
    readOnly: false,
  },
  {
    name: "explodeAssembly",
    description: 'The exploded view\'s steps: worked out from the mates ({} or { "scale": 1.5 } — each part off the one it is mated to, out of its hole along the axis, off its face along the normal), given ({ "steps": [{ "components": ["bolt-1"], "move": [0, 0, 60] }] }), or { "collapse": true }. A drawing view { "look": "iso", "source": "assembly", "exploded": true } draws it, with explode lines.',
    input: { scale: z.number().optional(), steps: z.array(obj).optional(), collapse: z.boolean().optional() },
    readOnly: false,
  },
  {
    name: "deleteMate",
    description: "Remove a mate.",
    input: { id: z.string() },
    readOnly: false,
  },
  {
    name: "mateFeatures",
    description:
      "What can be mated on a component, biggest first, in the assembly's coordinates as it sits now: its flat faces (normal, centre, area) and its holes and bosses (round faces: diameter, axis, a point on it, length), each with the ref a mate takes. Works on parts imported from STEP too.",
    input: { component: z.string(), kind: z.enum(["all", "planes", "round"]).optional(), limit: z.number().optional() },
    readOnly: true,
  },
  {
    name: "suggestMates",
    description:
      "The mates two components most likely want, best first, found from their features: a boss or pin into a hole of its size (concentric, and the faces that then meet), holes of one size in line (bolt holes), or their biggest facing faces flush. Each suggestion lists the addMate calls to make.",
    input: { a: z.string(), b: z.string() },
    readOnly: true,
  },
  {
    name: "checkAssembly",
    description:
      "Find what is wrong with the assembly: mates that don't hold (and why), components held by nothing, what each component can still do (slides and turns its mates don't stop — fine for a hinge or a slider, else a mate is missing), and components that overlap (interference) where the host can check. Run it after assembling, and fix what it lists.",
    input: {},
    readOnly: true,
  },
];

export const SPECS: ToolSpec[] = [
  ...ASSEMBLY_SPECS,
  {
    name: "reportToolIssue",
    description:
      "Note a problem with Cocaide's tools in the user's tool-issue log (for Cocaide's developers): a tool that failed in a way that looks like a bug, refused something it should take, was described wrongly, or a tool that is missing. Changes nothing in the part; carry on after it.",
    input: {
      tool: z.string().describe('The tool it is about ("addFeature"), or "missing" when no tool does it'),
      problem: z.string().describe("What you tried and what happened, in a sentence or two (the error text if there was one)"),
      suggestion: z.string().optional().describe("What would have helped: a fix, a field, a tool"),
      input: z.unknown().optional().describe("The arguments of the call that went wrong, if any"),
    },
    readOnly: true,
  },
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
      'A whole sketch from a compact description, with the relations a CAD user would add (coincident ends, horizontal/vertical lines, tangent arcs, equal fillets) and dimensions (any "=expression" you give is kept), then Fully Define for the rest, so it comes out fully defined. "sketch": a new id (with "plane", default Top) or an existing sketch to add to. "shapes": { "polyline": [[x,y], { "at": [x,y], "fillet": r }, { "arcTo": [x,y], "center" | "through": [x,y] | "tangent": true, "clockwise"? }], "closed"?: true } (a polyline is closed back to its first point unless "closed": false: give false for an open path, such as a sweep path) | { "rect": { "center" | "corner": [x,y], "width", "height", "fillet"? } } | { "circle": { "center", "diameter" | "radius" } } | { "slot": { "from", "to", "width" } } | { "polygon": { "center", "sides", "diameter" | "acrossFlats", "angle"? } } | { "line": { "from", "to" } } | { "point": [x,y] }; each may add "construction": true, "id" (the entity id, or a prefix for several: <id>_1, <id>_2 ...) and "name" (its dimension names). "dimensions": "none" skips Fully Define; "datum": the point positions are measured from (default "origin").',
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
