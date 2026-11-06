// What the right-click agent is told, and which tools it gets. The packet is
// the prompt; this file is the fixed part around it.

import { ADD_LIBRARY_PROFILE_HELP, LIBRARY_SIZE_RULE } from "../weldment/libraryTool";
import type Anthropic from "@anthropic-ai/sdk";
import { coreReference, opIndex, referenceSection, sectionIndex } from "../mcp/sections";
import { anthropicTool } from "./tools/specs";
import type { AskTarget, Packet, PacketKind } from "./packet";

export type AskMode = "explain" | "edit";

/**
 * Explain-only prompts must not write (spec 6.2), so they get no write tools
 * at all. A question is explain-only; "can you ..." and "please ..." are
 * requests, and anything else is an instruction.
 */
export function classify(text: string): AskMode {
  const t = text.trim().toLowerCase();
  if (/^(can|could|would|will) you\b|^please\b/.test(t)) return "edit";
  if (/^(what|what's|whats|why|how|which|where|who|when|is|are|does|do|did|explain|describe|tell me|show me|measure|name)\b/.test(t)) return "explain";
  return "edit";
}

/** A prompt that needs to see the part (spec 6.1): "make it look like this", "what is this face". */
export function isVisual(text: string, target: AskTarget): boolean {
  const t = text.toLowerCase();
  if (/\b(look|looks|looking|see|shape|appear|appearance|picture|image|visual|like this)\b/.test(t)) return true;
  return (target.kind === "face" || target.kind === "edge") && /\bwhat\b.*\bthis\b|\bwhich\b/.test(t);
}

export interface ScopedAction {
  label: string;
  /** The prompt. When `submit` is false it is put in the box for the user to finish (a size, a value). */
  prompt: string;
  submit: boolean;
}

/** The scoped actions under the prompt box (spec 6): prompts with the intent filled in. */
export function scopedActions(kind: PacketKind | AskTarget["kind"]): ScopedAction[] {
  switch (kind) {
    case "sketch":
      return [
        { label: "Fully define this sketch", prompt: "Fully define this sketch: add the dimensions and constraints it is missing, keeping the geometry where it is.", submit: true },
        { label: "Close the profile", prompt: "Close the profile so it can be extruded.", submit: true },
        { label: "Make it symmetric about the origin", prompt: "Make this sketch symmetric about the sketch origin.", submit: true },
        { label: "Revolve this profile", prompt: "Revolve this sketch's profile into a solid, about ", submit: false },
        { label: "Make this a spring", prompt: "Make a spring along a helix from this sketch: wire diameter ", submit: false },
        { label: "Change its shape", prompt: "Change this sketch so that ", submit: false },
        { label: "Explain it", prompt: "What does this sketch draw, and what holds it?", submit: true },
      ];
    case "entity":
      return [
        { label: "Make it construction geometry", prompt: "Turn this into construction geometry.", submit: true },
        { label: "Constrain this distance", prompt: "Constrain this distance to ", submit: false },
        { label: "Fully define it", prompt: "Add the relations and dimensions this needs to be fully defined, keeping it where it is.", submit: true },
        { label: "Change it", prompt: "Change this so that ", submit: false },
      ];
    case "constraint":
      return [
        { label: "Explain this constraint", prompt: "What does this constraint hold?", submit: true },
        { label: "Change its value", prompt: "Change this value to ", submit: false },
      ];
    case "failed":
      return [
        { label: "Fix this error", prompt: "Fix this error. Do not touch anything else.", submit: true },
        { label: "Why did this fail?", prompt: "Why did this fail?", submit: true },
      ];
    case "face":
      return [
        { label: "Hole here", prompt: "Put a through hole here, diameter ", submit: false },
        { label: "Fillet the boundary", prompt: "Fillet the edges around this face, radius ", submit: false },
        { label: "Boss on it", prompt: "Extrude a boss out of this face: ", submit: false },
        { label: "Pocket in it", prompt: "Cut a pocket into this face: ", submit: false },
        { label: "Shell this body 2 mm", prompt: "Shell this body with 2 mm walls, leaving this face open.", submit: true },
        { label: "Add a rib here", prompt: "Add a stiffening rib on this face, 3 mm thick, ", submit: false },
        { label: "Draft this face", prompt: "Draft this face 3° so the part releases from a mould, neutral plane ", submit: false },
        { label: "Make this a spring", prompt: "Wind a spring around this round face: a round wire swept along a helix, wire diameter ", submit: false },
        { label: "What is this face?", prompt: "What is this face?", submit: true },
      ];
    case "edge":
      return [
        { label: "Fillet this edge", prompt: "Fillet this edge, radius ", submit: false },
        { label: "Chamfer this edge", prompt: "Chamfer this edge, distance ", submit: false },
        { label: "Fillet every edge like it", prompt: "Fillet this edge and every edge like it, radius ", submit: false },
        { label: "What is this edge?", prompt: "What is this edge, and which feature made it?", submit: true },
      ];
    case "parameter":
      return [
        { label: "Where is this used?", prompt: "Where is this parameter used?", submit: true },
        { label: "Change it", prompt: "Change this parameter to ", submit: false },
      ];
    case "body":
      return [
        { label: "What is this body?", prompt: "What is this body, and which features make it?", submit: true },
        { label: "Does it clash?", prompt: "Does this body overlap any other body? Do not change anything.", submit: true },
        { label: "Shell this body 2 mm", prompt: "Shell this body with 2 mm walls, open at its top face.", submit: true },
        { label: "Rename it", prompt: "Rename this body to ", submit: false },
      ];
    case "member":
      return [
        { label: "Swap its size", prompt: "Change this member to ", submit: false },
        { label: "Turn it 90°", prompt: "Turn this member 90° about its line.", submit: true },
        { label: "What is its cut?", prompt: "What is this member's cut length and end angles?", submit: true },
      ];
    case "joint":
      return [
        { label: "Mitre it", prompt: "Make this joint a mitre.", submit: true },
        { label: "Butt it", prompt: "Make this a butt joint, with this member running through: ", submit: false },
        { label: "Leave a gap", prompt: "Leave a gap of ", submit: false },
        { label: "Explain it", prompt: "What does this joint do to each member?", submit: true },
      ];
    case "view":
      return [
        { label: "Dimension the overall size", prompt: "Dimension the overall size of the part in this view.", submit: true },
        { label: "Dimension a member's length", prompt: "Dimension the length of ", submit: false },
        { label: "Balloon what it shows", prompt: "Balloon the cut list items this view shows that have no balloon yet.", submit: true },
        { label: "Show hidden edges", prompt: "Show the hidden edges in this view.", submit: true },
      ];
    case "annotation":
      return [
        { label: "What does it say?", prompt: "What does this annotation show, and where is it measured from?", submit: true },
        { label: "Move it to the other side", prompt: "Move this to the other side of the view.", submit: true },
        { label: "Delete it", prompt: "Delete this annotation.", submit: true },
      ];
    case "table":
      return [
        { label: "What does it list?", prompt: "What does this table list, and where does each column come from?", submit: true },
        { label: "Add a column", prompt: "Add a column to this table for ", submit: false },
        { label: "Sort it", prompt: "Sort this table by ", submit: false },
      ];
    case "sheet":
      return [
        { label: "Fill in the title block", prompt: "Fill in this sheet's title block from the part's properties.", submit: true },
        { label: "Check this sheet", prompt: "Does this sheet pass its checks? Do not change anything.", submit: true },
        { label: "Change the sheet size", prompt: "Change this sheet to ", submit: false },
      ];
    case "drawing":
      return [
        { label: "Check the drawing", prompt: "Does this drawing pass its checks? Do not change anything.", submit: true },
        { label: "Balloon every item", prompt: "Add a balloon for every cut list item that has none.", submit: true },
        { label: "Change the scale", prompt: "Change the sheet's scale to ", submit: false },
      ];
    case "part":
      return [
        { label: "New part from a description", prompt: "", submit: false },
        { label: "Revolve a turned part", prompt: "Build a turned part by revolving its half section: ", submit: false },
        { label: "Make a spring", prompt: "Make a compression spring: wire diameter 2 mm, coil diameter 20 mm, pitch 6 mm, 8 turns.", submit: false },
        { label: "Explain this part", prompt: "What is this part, and how is it built?", submit: true },
        { label: "Check it", prompt: "Does this part rebuild cleanly, and is anything fragile?", submit: true },
        { label: "Change it", prompt: "Change this part: ", submit: false },
      ];
    default:
      return [
        { label: "Explain this", prompt: "Explain what this feature does.", submit: true },
        { label: "Change a dimension", prompt: "Make it ", submit: false },
        { label: "Pattern it", prompt: "Pattern this ", submit: false },
        { label: "Mirror it", prompt: "Mirror this about ", submit: false },
        { label: "Suppress it: what breaks?", prompt: "If this were suppressed, what would break? Do not change anything.", submit: true },
      ];
  }
}

export const SYSTEM = `You are the agent inside Cocaide, a parametric CAD program. The user right-clicked one thing in their part and typed a request about it. You get a context packet that describes that thing: the target, its parent, its direct children, its measurements, the selector for a picked face or edge, and the error if it failed. When the user lets the ask change the whole part (writeScope ["*"]), the packet also carries "part": every feature in brief, and getFeature reads any of them. Otherwise the packet is all the context there is; do not ask for the rest of the part.

Pick the smallest response that does what was asked:
1. Answer: explain, name or measure. No edit. If the packet already answers the question, just answer.
2. Parameter: change one field on the target ("make this hole M6" sets "size": "M6" and nothing else; the table gives its diameter).
3. Edit: add or change features inside writeScope, as many as the request needs.
4. Escalate: if the request cannot be done inside writeScope, call escalate with the reason. Never try to widen the scope.

Rules:
- writeScope is enforced by the program: an edit outside it is rejected and changes nothing. Its tokens: "*" (anything in the part: the target is only where the user pointed), a feature id (change that feature, or add a feature that uses it), "<sketch>/*" (that sketch's entities and constraints only), "<sketch>/<entity>" (that entity and the constraints on it), "param:<name>", "body:<name>" (add features that touch only that body: an extrude with "body": name, a cut or hole with "bodies": [name], selectors naming it; and rename it), and "+" (add one new feature; from a face or edge it must use that face or edge, normally through the packet's selection).
- Sketches: dimension and relate them with standard CAD sketch relations and dimensions (see the reference: horizontal, vertical, parallel, perpendicular, tangent, coincident, midpoint, equal, symmetric, fix, and distance, radius, diameter and angle dimensions). A sketch that is fully defined (packet measurements dof 0) won't move unexpectedly.
- Every edit is checked: the part is rebuilt and the edit is kept only if nothing newly fails. A failed edit returns the error; read it and fix the call, or stop and say why.
- After your edits, check the measurement the user asked about in the tool result. If it does not match, you get one correction pass. Then stop.
- Your edits are a proposal: the user sees them and accepts or discards them. Do not ask for confirmation in text; make the proposal.
- Weldments: a member's size must be one of the sizes in the part's profiles; never invent one. If the part has no profile for a member, add one with addLibraryProfile. If the size the user asked for is not in the catalogue, do NOT substitute or create one on your own: change nothing, and ask the user whether to create that exact size as a non-catalogue size or use one of the nearest catalogue sizes (name them; the tool error lists them). Only after they answer, add it (extraSizes) or use their choice. A joint is changed through its own fields (type, members, through, gap): a mitre names the two members it cuts, a butt names the member that runs through. The rebuild trims the members; read the measured cut to check.
- Drawings: a right-click on the sheet scopes the ask to a view and its annotations ("view:<id>"), one annotation ("annotation:<id>"), one table ("table:<id>", setTable on it alone) or the drawing ("drawing", also from a sheet's tab or title block: the packet's sheet is that one); the packet's "selection" lists what else the user had selected on the sheet, which "this" and "these" may mean; the part's features are never in scope from there. Every number on a sheet is measured on the rebuild: you choose what to dimension, never the value. A dimension runs between two points (a node "A", a member end "leg_a.start", a hole "hole_1", a side of the view "@left", "@right", "@top", "@bottom", or a GeoRef from the packet's view.geoRefs such as "front:vextrude_1/l3.0"), or along a member ({ "member": "leg_a" }: its cut length, only where the packet says liesFlat). Use the packet's view.shows to find the points, and its checks to see what is missing. Dimensions go in front, top, side views, never iso. Give a new annotation a short new id (d4, b4).
- Units are millimetres. If the user gives inches, convert once and say so (1 in = 25.4 mm). Metric screw clearance holes: M3 3.4, M4 4.5, M5 5.5, M6 6.6, M8 9, M10 11 (normal fit).
- Selectors choose faces and edges by query. Use the packet's selection for the picked face or edge rather than writing your own.
- Look before you write: listFaces and listEdges give a selector for every face and edge (never guess one), facePlane a face's frame, getSketch what holds a sketch, measureBetween any distance or angle, screenshot a picture. reference("<op>") gives an op's full section before you first use it.
- Several related edits go in one batch call (a sketch, its extrude, its holes): all are kept or none, and the result tells you what each step made. sketchProfile draws a fully defined sketch; holes lays out a bolt circle or grid.
- Building or reworking a whole part (the ask says so, or the part is empty): call plan first (the feature tree and the checks), build in batches, then verify with partSummary, measureBetween and a screenshot, and fix what disagrees (see strategy below).
- Finish with one or two plain sentences for the user: what you changed and the result, or the answer, or why you stopped. No markdown headings.

Document reference (the core; the reference tool gives the rest):
${coreReference()}`;

/**
 * The same agent for a model with a small context (a local model at 8-32k tokens): the same rules, tools and
 * semantics, in fewer words, with less of the reference inline (the document and sketch basics, selectors,
 * strategy and each op's first example; the rest is a reference call away). About half the size of SYSTEM.
 */
export const SYSTEM_COMPACT = `You are the agent inside Cocaide, a parametric CAD program (units: mm, degrees). The user right-clicked one thing in their part and typed a request. The context packet describes it: target, parent, children, measurements, the selector of a picked face or edge, the error if it failed, and writeScope. With writeScope ["*"] the packet's "part" lists every feature and you may change anything; otherwise only the packet is in context.

Do the smallest thing that does what was asked: answer (no edit), change one field, add or change features inside writeScope, or call escalate with the reason when it cannot be done inside writeScope.

Rules:
- Work only through the tools. Every edit is rebuilt and kept only if nothing newly fails; a failed edit returns the error: read it, fix the call, or stop and say why. Never repeat a call that failed without changing it.
- writeScope is enforced: "*" anything; a feature id: that feature, or a new feature using it; "<sketch>/*" that sketch's entities and constraints; "param:<name>"; "body:<name>"; "+" one new feature (from a face or edge it must use that face or edge, through the packet's selection).
- Your edits are a proposal the user accepts or discards. Do not ask for confirmation; make the proposal.
- Look before you write: listFaces / listEdges give a ready selector for every face and edge (never guess one), facePlane a face's frame, getSketch a sketch, measureBetween distances, partSummary the whole part. reference("<op>") gives an op's full section: read it before you first use an op.
- Related edits go in one batch call (a sketch, its extrude, its holes): all are kept or none. sketchProfile draws a fully defined sketch; holes lays out bolt circles and grids. Any edit tool not offered directly runs as a batch step: { "tool": "<name>", ...its arguments }.
- A whole new part: call plan first, build in batches, then check with partSummary and measureBetween, and fix what disagrees.
- Tool arguments are JSON objects that follow each tool's schema exactly.
- Metric clearance holes: M3 3.4, M4 4.5, M5 5.5, M6 6.6, M8 9, M10 11. Inches: convert once (25.4 mm) and say so.
- Weldment member sizes come from the packet's member.sizes only. Drawing numbers are measured, never given.
- Finish with one or two plain sentences: what you changed and the result, or the answer, or why you stopped.

Document reference (short; the reference tool gives the rest):
${compactReference()}`;

function compactReference(): string {
  const get = (k: string) => referenceSection(k) ?? "";
  const sketch = get("sketch");
  // The sketch section up to its constraints, and the first part of the constraint list.
  const cut = sketch.indexOf("Constraints are");
  const end = cut > 0 ? sketch.indexOf("\n", cut + 1500) : -1;
  const doc = get("document");
  const docCut = doc.indexOf("### Dimension names");
  return [
    docCut > 0 ? doc.slice(0, docCut).trim() : doc,
    cut > 0 ? sketch.slice(0, end > 0 ? end : undefined).trim() : sketch,
    get("selectors"),
    get("strategy"),
    `## Ops (first example each; reference("<op>") gives every field)\n${opIndex()}`,
    `## More, with the reference tool\n${sectionIndex()}`,
  ].join("\n\n");
}

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object" as const, properties, required, additionalProperties: false });
const any = { type: "object", description: "JSON object" };

const READ_TOOLS: Anthropic.Tool[] = [
  {
    name: "measure",
    description: "Measure the part as it is now (your edits included). Without a selector: volume, bounding box, holes. With a face or edge selector: what it picks.",
    input_schema: obj({ selector: { ...any, description: "Optional face or edge selector" } }, []),
  },
  {
    name: "getFeature",
    description: "The current JSON of a feature named in the packet (target, parent or a child).",
    input_schema: obj({ id: { type: "string" } }, ["id"]),
  },
  {
    name: "escalate",
    description: "Stop without changing anything: the request cannot be done inside writeScope, or needs information you do not have. Give the reason in one sentence.",
    input_schema: obj({ reason: { type: "string" } }, ["reason"]),
  },
];

/** Looking at the part closely: every face and edge with its selector, distances, sketches, frames, pictures, the reference. */
const INSPECT_TOOLS: Anthropic.Tool[] = [
  ...["partSummary", "listFaces", "listEdges", "measureBetween", "getSketch", "facePlane", "listDatums"].map(anthropicTool),
  {
    name: "screenshot",
    description:
      "A picture of the part as it is now (your edits included): a named view (iso, front, back, right, left, top, bottom, isoBack) or a direction from the part toward the eye; highlight paints what a selector picks (zoom: true frames it). Use it to check a build looks right.",
    input_schema: obj(
      {
        view: { type: "string" },
        direction: { type: "array", items: { type: "number" } },
        up: { type: "array", items: { type: "number" } },
        highlight: { ...any, description: "Optional face or edge selector" },
        zoom: { type: "boolean" },
        hiddenEdges: { type: "boolean" },
      },
      [],
    ),
  },
  anthropicTool("reference"),
];

/** Building: several edits as one transaction, and the helpers that write sketches and holes. */
const BUILD_TOOLS: Anthropic.Tool[] = ["batch", "sketchProfile", "fullyDefine", "holes"].map(anthropicTool);

/** The part's properties: a feature ask and a sheet ask (the title block shows them) may both set them. */
const SET_PROPERTIES: Anthropic.Tool = {
  name: "setProperties",
  description:
    'Change the part\'s properties: { "partNumber", "description", "revision", "author", "finish", "custom": { name: text } }. Merged in; null removes a field; "custom" replaces the custom ones whole. The drawing\'s title block (PART NO., DESCRIPTION, REV, DRAWN, FINISH where the sheet does not set its own), the cut list CSV and STEP export read them.',
  input_schema: obj({ patch: any }, ["patch"]),
};

/** The cut list's text and nesting settings (Phase Q): a feature ask and a sheet ask (its cut list table shows them) may both set them. */
const SET_CUT_LIST: Anthropic.Tool = {
  name: "setCutList",
  description: "Change the cut list's text and nesting settings (merged): { \"itemText\": [{ \"item\": 1, \"members\": [\"rail_front\", \"rail_back\"], \"description\"?, \"finish\"?, \"notes\"?, \"weldPrep\"?, \"group\"?, \"properties\"?: { \"Supplier\": \"Steel & Co\" } }] } sets text on cut list items (members from the cut list; the kept item sharing them keeps its number; \"\" or null removes a field); \"members\": { \"<member id or body>\": { ...text } } sets one member's own text (alike members with different text become separate items); \"stock\": { \"lengths\": [6000, 6100], \"kerf\": 3, \"trim\": 0, \"minOffcut\": 300, \"profiles\": { \"SHS 40x40x3\": { \"lengths\": [8000] } } } for nesting; \"tolerance\": mm within which lengths are one item (0.5). null removes a field.",
  input_schema: obj({ patch: any }, ["patch"]),
};

/** A catalogue section into the part (Phase Q): what a weldment in a part with no profiles starts with. */
const ADD_LIBRARY_PROFILE: Anthropic.Tool = {
  name: "addLibraryProfile",
  description: `${ADD_LIBRARY_PROFILE_HELP} ${LIBRARY_SIZE_RULE}`,
  input_schema: obj({ query: { type: "string" }, sizes: { type: "array", items: { type: "string" } }, extraSizes: { type: "array", items: any }, name: { type: "string" } }, ["query"]),
};

const FEATURE_TOOLS: Anthropic.Tool[] = [
  {
    name: "updateFeature",
    description: "Change fields of a feature: patch is merged in (null removes a field).",
    input_schema: obj({ id: { type: "string" }, patch: any }, ["id", "patch"]),
  },
  {
    name: "addFeature",
    description: "Add a feature (see the reference for ops and fields). id is optional.",
    input_schema: obj({ feature: any, index: { type: "integer" } }, ["feature"]),
  },
  {
    name: "suppressFeature",
    description: "Suppress or unsuppress a feature.",
    input_schema: obj({ id: { type: "string" }, suppressed: { type: "boolean" } }, ["id", "suppressed"]),
  },
  {
    name: "deleteFeature",
    description: "Delete a feature nothing else uses.",
    input_schema: obj({ id: { type: "string" } }, ["id"]),
  },
  {
    name: "reorderFeature",
    description:
      "Move a feature to index in the history. Refused (saying why) when it would come before what it uses: its sketch, a feature whose faces or edges its selectors name by createdBy, a sketch whose dimensions it reads. folder: the tree folder it goes in (null: none); left out, it joins a folder it lands inside.",
    input_schema: obj({ id: { type: "string" }, index: { type: "integer" }, folder: { type: ["string", "null"] } }, ["id", "index"]),
  },
  {
    name: "setFolder",
    description: 'Add, rename or regroup a folder of the feature tree ({ "name", "features": [ids next to each other in the history] }), or remove it (folder: null; its features stay). Folders change nothing that is built.',
    input_schema: obj({ id: { type: "string" }, folder: { ...any, description: '{ "name"?: text, "features"?: [feature ids] } or null' } }, ["id", "folder"]),
  },
  {
    name: "suppressFolder",
    description: "Suppress (or unsuppress) every feature of a tree folder, as one step.",
    input_schema: obj({ id: { type: "string" }, suppressed: { type: "boolean" } }, ["id", "suppressed"]),
  },
  {
    name: "setParameter",
    description: 'Set a document parameter: a number, or an "=expression" over other parameters and sketch dimensions ("=sketch_1.width / 2"). A cycle is refused.',
    input_schema: obj({ name: { type: "string" }, value: { type: ["number", "string"] } }, ["name", "value"]),
  },
  {
    name: "renameParameter",
    description: "Rename a parameter; every expression that reads it follows.",
    input_schema: obj({ from: { type: "string" }, to: { type: "string" } }, ["from", "to"]),
  },
  {
    name: "renameBody",
    description: "Rename a body; every feature and selector that names it follows.",
    input_schema: obj({ from: { type: "string" }, to: { type: "string" } }, ["from", "to"]),
  },
  {
    name: "setNode",
    description: 'Add or move a frame node ([x, y, z], numbers or "=expressions"), or remove one nothing names (at: null). Members on it move with it.',
    input_schema: obj({ name: { type: "string" }, at: { type: ["array", "null"], items: { type: ["number", "string"] } } }, ["name", "at"]),
  },
  {
    name: "setBodyMaterial",
    description: 'Give a body its own material ({ "name": "aluminium 6061", "densityKgPerM3": 2700 }), or put it back on the part\'s (material: null).',
    input_schema: obj({ body: { type: "string" }, material: { type: ["object", "null"] } }, ["body", "material"]),
  },
  {
    name: "setWeld",
    description: "Add or replace a weld note in the weld table by id, or remove it (weld: null). Welds are notes, never modelled.",
    input_schema: obj({ id: { type: "string" }, weld: { type: ["object", "null"] } }, ["id", "weld"]),
  },
  SET_PROPERTIES,
  SET_CUT_LIST,
  ADD_LIBRARY_PROFILE,
];

const SKETCH_TOOLS: Anthropic.Tool[] = [
  {
    name: "setDimension",
    description:
      'Set a sketch dimension, by `index` (its constraint\'s place) or `name` ("d2", "width"), to a number or "=expression" (functions, units, other dimensions as <sketch>.<name>); the sketch re-solves. A driven dimension is refused: make it driving first.',
    input_schema: obj({ sketch: { type: "string" }, index: { type: "integer" }, name: { type: "string" }, value: { type: ["number", "string"] } }, ["sketch", "value"]),
  },
  {
    name: "renameDimension",
    description: "Name a sketch dimension (by `index` or its current `name`); expressions anywhere read it as <sketch>.<to>, and those that read the old name follow.",
    input_schema: obj({ sketch: { type: "string" }, index: { type: "integer" }, name: { type: "string" }, to: { type: "string" } }, ["sketch", "to"]),
  },
  {
    name: "setDriven",
    description: "Make a sketch dimension driven (a reference: measured, never solved) or driving again (refused if that over-defines the sketch).",
    input_schema: obj({ sketch: { type: "string" }, index: { type: "integer" }, name: { type: "string" }, driven: { type: "boolean" } }, ["sketch", "driven"]),
  },
  {
    name: "addEntity",
    description: "Add an entity to a sketch (id optional).",
    input_schema: obj({ sketch: { type: "string" }, entity: any }, ["sketch", "entity"]),
  },
  {
    name: "updateEntity",
    description: "Change fields of a sketch entity (null removes a field, e.g. construction). The fields you set are held while the sketch re-solves.",
    input_schema: obj({ sketch: { type: "string" }, id: { type: "string" }, patch: any }, ["sketch", "id", "patch"]),
  },
  {
    name: "deleteEntity",
    description: "Delete a sketch entity and the constraints on it.",
    input_schema: obj({ sketch: { type: "string" }, id: { type: "string" } }, ["sketch", "id"]),
  },
  {
    name: "addConstraint",
    description: "Add a constraint to a sketch; the geometry moves to meet it.",
    input_schema: obj({ sketch: { type: "string" }, constraint: any }, ["sketch", "constraint"]),
  },
  {
    name: "deleteConstraint",
    description: "Delete constraint `index` of a sketch.",
    input_schema: obj({ sketch: { type: "string" }, index: { type: "integer" } }, ["sketch", "index"]),
  },
];

const DRAWING_TOOLS: Anthropic.Tool[] = [
  {
    name: "setAnnotation",
    description:
      'Add or replace an annotation on the drawing by id, or remove it (annotation: null). Types: dimension {view, from, to} or {view, member} or {view, kind: "linear" | "angular" | "radius" | "diameter" | "ordinate" | "baseline" | "chain" | "arcLength" | "chamfer" | "pathLength", refs: [GeoRef...]} with tolerance? {kind: "symmetric" | "bilateral" | "limit" | "fit" | "fitWithTol" | "basic" | "reference" | "min" | "max", plus?, minus?, fit?: "H7" | "g6" | "H7/g6"}, typ?, count?, prefix?, suffix?, precision?; hole {view, hole, count?}; gdt {view, rows: [{characteristic, tolerance, diameter?, material?, datums?: [{label}]}], dimension? | on?}; datum {view, label, on | dimension}; surface {view, on, symbol, values: ["Ra 1.6"]} or {general: true, ...}; weld {view, weld} or {view, on, arrowSide: {symbol, size, length}}; balloon {view, member | body | item}; note {text, at, numbered?, title?, leaders?}; leader, text, line, sketch, revisionCloud, cosmeticThread, datumTarget; centerMark; centerline; table. Read reference("annotations") for every field. Points may be GeoRefs from the packet (view.geoRefs). It goes on its view\'s sheet. What it reads is measured, never given.',
    input_schema: obj({ id: { type: "string" }, annotation: { type: ["object", "null"] }, sheet: { type: "string" } }, ["id", "annotation"]),
  },
  {
    name: "editAnnotation",
    description: 'Change some fields of an annotation, keeping the rest (null removes a field): {tolerance: {kind: "fit", fit: "H7"}}, {typ: true}, {at: [x, y]}, a frame\'s rows.',
    input_schema: obj({ id: { type: "string" }, patch: { type: "object" } }, ["id", "patch"]),
  },
  {
    name: "setView",
    description:
      'Add or replace a view by id, or remove it with its annotations and the views made from it (view: null). Kinds: model {look: "front" | "back" | "top" | "bottom" | "left" | "right" | "iso" | "dimetric" | "trimetric"}; projected {kind: "projected", parent, direction: "left" | "right" | "up" | "down" | "upLeft" | "upRight" | "downLeft" | "downRight"}; section {kind: "section", parent, line: [[x, y], [x, y], ...] on the parent (view mm), half?, aligned?, flip?, depth?}; detail {kind: "detail", parent, circle: {at: [x, y], r}, scale?}; auxiliary {kind: "auxiliary", parent, edge: "<parent>:e<edge>"}. Any view: at, scale, display ("visible" | "hidden" | "removed" | "shaded" | "shadedEdges"), tangent ("visible" | "phantom" | "removed"), breaks [{axis, from, to}], crop, bodies.',
    input_schema: obj({ id: { type: "string" }, view: { type: ["object", "null"] }, sheet: { type: "string" } }, ["id", "view"]),
  },
  {
    name: "moveView",
    description: "Move a view to at [x, y] on its sheet (null: back to its automatic place), and/or to another sheet (sheet) with its annotations.",
    input_schema: obj({ id: { type: "string" }, at: { type: ["array", "null"], items: { type: "number" } }, sheet: { type: "string" } }, ["id"]),
  },
  {
    name: "setSheet",
    description:
      'Change a sheet (sheet: its id; default the first): size ("A4".."A0", "ANSI A".."ANSI E"), orientation ("landscape" | "portrait"), template ("iso" | "ansi" | "minimal" | "classic"), scale ("1:10"; null for what fits), projection ("third" | "first"), name, and the title block: title, subtitle, number, revision, drawnBy, date, checkedBy, checkedDate, approvedBy, approvedDate, company, material, finish, mass (text, may link $PRP:"name"). Merged in; null removes a field.',
    input_schema: obj({ patch: any, sheet: { type: "string" } }, ["patch"]),
  },
  {
    name: "setTable",
    description:
      'Add or replace a table on a sheet by id, or remove it (table: null): {kind: "cutList" | "bom" | "holes" | "welds" | "revisions" | "general" | "stock", title?, columns?, sort?, group?, anchor? ({corner: "aboveTitleBlock" | "topRight" | ...} or {at: [x, y]}), view and origin (holes), header and rows (general)}. Views and annotations keep clear of it.',
    input_schema: obj({ id: { type: "string" }, table: { type: ["object", "null"] }, sheet: { type: "string" } }, ["id", "table"]),
  },
  {
    name: "addSheet",
    description: "Add a sheet to the drawing (after the others, or at index), its format from the sheet before it unless given in sheet.",
    input_schema: obj({ id: { type: "string" }, sheet: { type: "object" }, index: { type: "integer" } }, []),
  },
  {
    name: "deleteSheet",
    description: "Delete a sheet with its views and annotations (never the last one).",
    input_schema: obj({ id: { type: "string" } }, ["id"]),
  },
  {
    name: "setDrawingOptions",
    description: 'The drawing\'s settings: standard ("ISO" | "ASME"), units ("mm" | "in"), generalTolerance ("ISO 2768-mK"), properties {name: text}, revisions [{rev, description, date, by, approved, zone}]. Merged in; null removes one.',
    input_schema: obj({ patch: any }, ["patch"]),
  },
];

export const WRITE_TOOL_NAMES = new Set([...FEATURE_TOOLS, ...SKETCH_TOOLS, ...DRAWING_TOOLS, ...BUILD_TOOLS].map((t) => t.name));

/** The write tools a batch step may name in the right-click agent. */
export const BATCH_STEP_TOOLS: readonly string[] = [...FEATURE_TOOLS, ...SKETCH_TOOLS, ...DRAWING_TOOLS].map((t) => t.name).concat(["sketchProfile", "fullyDefine", "holes"]);

const PLAN_TOOL = anthropicTool("plan");

const DRAWING_KINDS = new Set<string>(["view", "annotation", "table", "sheet", "drawing"]);

/**
 * Explain-only asks get no write tools. An ask from the sheet gets the
 * drawing's, and only those. An ask that may change the whole part gets every
 * tool: the part's, the sketches', and the drawing's when there is one. Every
 * ask about the part can look at it closely (the inspection tools); a whole-part
 * build also gets plan.
 */
export function toolsFor(mode: AskMode, kind?: string, wide?: { part: boolean; drawing: boolean; build?: boolean }): Anthropic.Tool[] {
  const drawingTarget = !!kind && DRAWING_KINDS.has(kind);
  const read = [...READ_TOOLS, ...INSPECT_TOOLS];
  if (mode === "explain") return wide?.part || !drawingTarget ? read : READ_TOOLS.filter((t) => t.name === "escalate");
  if (wide?.part) return [...read, ...(wide.build ? [PLAN_TOOL] : []), ...FEATURE_TOOLS, ...SKETCH_TOOLS, ...BUILD_TOOLS, ...(wide.drawing ? DRAWING_TOOLS : [])];
  // The whole sheet (its title block among it) may change the part's properties; a view or an annotation may not.
  if (drawingTarget) return [...READ_TOOLS.filter((t) => t.name === "escalate"), ...DRAWING_TOOLS, ...(kind === "drawing" || kind === "sheet" ? [SET_PROPERTIES, SET_CUT_LIST] : [])];
  return [...read, ...FEATURE_TOOLS, ...SKETCH_TOOLS, ...BUILD_TOOLS];
}

/** The user turn: the packet, the screenshot when the prompt is visual, then the user's text, unchanged and last. */
/**
 * The tools a small-context model is offered directly: everything but the rarely used edits, which stay available
 * as batch steps (BATCH_STEP_TOOLS) with the same commands and checks. A weldment target keeps its node and weld tools.
 */
const RARE_TOOLS = new Set(["reorderFeature", "setFolder", "suppressFolder", "renameParameter", "setNode", "setBodyMaterial", "setWeld", "setProperties", "setCutList", "renameDimension", "setDriven", "fullyDefine"]);

export function leanTools(tools: Anthropic.Tool[], packet?: unknown): Anthropic.Tool[] {
  const welding = /"(member|node|joint)"/.test(JSON.stringify((packet as { target?: unknown } | undefined)?.target ?? ""));
  const keep = tools.filter((t) => !RARE_TOOLS.has(t.name) || (welding && (t.name === "setNode" || t.name === "setWeld")));
  // Without batch there is no other way to reach the rest: keep the list whole.
  return keep.some((t) => t.name === "batch") ? keep : tools;
}

export function userTurn(packet: Packet, text: string, mode: AskMode, image?: Uint8Array, wide = false, build = false): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  if (image) blocks.push({ type: "image", source: { type: "base64", media_type: "image/png", data: base64(image) } });
  const reach = wide
    ? " The user pointed at the target to show you where; you may change anything in the part to do what they ask (the packet's part has the rest of it)."
    : "";
  const note =
    mode === "explain"
      ? `This is a question: answer it. You have no tools that change the part.${wide ? " The packet's part has the rest of it." : ""}`
      : `Edits you make are a proposal the user accepts or discards.${reach}${build ? " This is a whole-part build: call plan first (the feature tree and the checks the request gives), build it in batch calls, then verify with partSummary, measureBetween and a screenshot before you finish." : ""}`;
  blocks.push({
    type: "text",
    text: `Context packet:\n${JSON.stringify(packet, null, 1)}\n\n${image ? "The image shows the part framed on the target, which is outlined in orange.\n" : ""}${note}\n\nThe user's request:\n${text}`,
  });
  return blocks;
}

export function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
