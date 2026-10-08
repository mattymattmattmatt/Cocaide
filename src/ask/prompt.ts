// What the right-click agent is told, and which tools it gets. The packet is
// the prompt; this file is the fixed part around it.

import type Anthropic from "@anthropic-ai/sdk";
import { REFERENCE } from "../mcp/reference";
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
    case "drawing":
      return [
        { label: "Check the drawing", prompt: "Does this drawing pass its checks? Do not change anything.", submit: true },
        { label: "Balloon every item", prompt: "Add a balloon for every cut list item that has none.", submit: true },
        { label: "Change the scale", prompt: "Change the sheet's scale to ", submit: false },
      ];
    case "part":
      return [
        { label: "New part from a description", prompt: "", submit: false },
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
2. Parameter: change one field on the target ("make this hole M6" sets diameter 6.6 and nothing else).
3. Edit: add or change features inside writeScope, as many as the request needs.
4. Escalate: if the request cannot be done inside writeScope, call escalate with the reason. Never try to widen the scope.

Rules:
- writeScope is enforced by the program: an edit outside it is rejected and changes nothing. Its tokens: "*" (anything in the part: the target is only where the user pointed), a feature id (change that feature, or add a feature that uses it), "<sketch>/*" (that sketch's entities and constraints only), "<sketch>/<entity>" (that entity and the constraints on it), "param:<name>", "body:<name>" (add features that touch only that body: an extrude with "body": name, a cut or hole with "bodies": [name], selectors naming it; and rename it), and "+" (add one new feature; from a face or edge it must use that face or edge, normally through the packet's selection).
- Sketches: dimension and relate them the way SOLIDWORKS does (see the reference: horizontal, vertical, parallel, perpendicular, tangent, coincident, midpoint, equal, symmetric, fix, and distance, radius, diameter and angle dimensions). A sketch that is fully defined (packet measurements dof 0) won't move unexpectedly.
- Every edit is checked: the part is rebuilt and the edit is kept only if nothing newly fails. A failed edit returns the error; read it and fix the call, or stop and say why.
- After your edits, check the measurement the user asked about in the tool result. If it does not match, you get one correction pass. Then stop.
- Your edits are a proposal: the user sees them and accepts or discards them. Do not ask for confirmation in text; make the proposal.
- Weldments: a member's size must be one of the sizes in the packet's member.sizes; never invent one. A joint is changed through its own fields (type, members, through, gap): a mitre names the two members it cuts, a butt names the member that runs through. The rebuild trims the members; read the measured cut to check.
- Drawings: a right-click on the sheet scopes the ask to a view and its annotations ("view:<id>"), one annotation ("annotation:<id>") or the drawing ("drawing"); the part's features are never in scope from there. Every number on a sheet is measured on the rebuild: you choose what to dimension, never the value. A dimension runs between two points (a node "A", a member end "leg_a.start", a hole "hole_1", or a side of the view "@left", "@right", "@top", "@bottom"), or along a member ({ "member": "leg_a" }: its cut length, only where the packet says liesFlat). Use the packet's view.shows to find the points, and its checks to see what is missing. Dimensions go in front, top, side views, never iso. Give a new annotation a short new id (d4, b4).
- Units are millimetres. If the user gives inches, convert once and say so (1 in = 25.4 mm). Metric screw clearance holes: M3 3.4, M4 4.5, M5 5.5, M6 6.6, M8 9, M10 11 (normal fit).
- Selectors choose faces and edges by query. Use the packet's selection for the picked face or edge rather than writing your own.
- Finish with one or two plain sentences for the user: what you changed and the result, or the answer, or why you stopped. No markdown headings.

Document reference:
${REFERENCE}`;

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
    name: "setParameter",
    description: "Set a document parameter.",
    input_schema: obj({ name: { type: "string" }, value: { type: "number" } }, ["name", "value"]),
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
];

const SKETCH_TOOLS: Anthropic.Tool[] = [
  {
    name: "setDimension",
    description: "Set the value of constraint `index` of a sketch (a number or \"=expression\"); the sketch re-solves.",
    input_schema: obj({ sketch: { type: "string" }, index: { type: "integer" }, value: { type: ["number", "string"] } }, ["sketch", "index", "value"]),
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
      'Add or replace an annotation on the drawing by id, or remove it (annotation: null). Types: dimension {view, from, to, direction?, offset?} or {view, member}; hole {view, hole}; balloon {view, member}; weld {view, weld}; table {table: "cutList" | "welds"}; note {text, at}. What it reads is measured, never given.',
    input_schema: obj({ id: { type: "string" }, annotation: { type: ["object", "null"] } }, ["id", "annotation"]),
  },
  {
    name: "setView",
    description: 'Add or replace a view by id ({look: "front" | "back" | "top" | "bottom" | "left" | "right" | "iso", at?, scale?, hidden?}), or remove it and its annotations (view: null).',
    input_schema: obj({ id: { type: "string" }, view: { type: ["object", "null"] } }, ["id", "view"]),
  },
  {
    name: "setSheet",
    description: 'Change the sheet: size ("A4".."A0"), scale ("1:10"; null for what fits), projection ("third" | "first"), title, number, revision, drawnBy, date. Merged in; null removes a field.',
    input_schema: obj({ patch: any }, ["patch"]),
  },
];

export const WRITE_TOOL_NAMES = new Set([...FEATURE_TOOLS, ...SKETCH_TOOLS, ...DRAWING_TOOLS].map((t) => t.name));

const DRAWING_KINDS = new Set<string>(["view", "annotation", "drawing"]);

/**
 * Explain-only asks get no write tools. An ask from the sheet gets the
 * drawing's, and only those. An ask that may change the whole part gets every
 * tool: the part's, the sketches', and the drawing's when there is one.
 */
export function toolsFor(mode: AskMode, kind?: string, wide?: { part: boolean; drawing: boolean }): Anthropic.Tool[] {
  if (mode === "explain") return wide?.part ? READ_TOOLS : READ_TOOLS.filter((t) => !kind || !DRAWING_KINDS.has(kind) || t.name === "escalate");
  if (wide?.part) return [...READ_TOOLS, ...FEATURE_TOOLS, ...SKETCH_TOOLS, ...(wide.drawing ? DRAWING_TOOLS : [])];
  if (kind && DRAWING_KINDS.has(kind)) return [...READ_TOOLS.filter((t) => t.name === "escalate"), ...DRAWING_TOOLS];
  return [...READ_TOOLS, ...FEATURE_TOOLS, ...SKETCH_TOOLS];
}

/** The user turn: the packet, the screenshot when the prompt is visual, then the user's text, unchanged and last. */
export function userTurn(packet: Packet, text: string, mode: AskMode, image?: Uint8Array, wide = false): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  if (image) blocks.push({ type: "image", source: { type: "base64", media_type: "image/png", data: base64(image) } });
  const reach = wide
    ? " The user pointed at the target to show you where; you may change anything in the part to do what they ask (the packet's part has the rest of it)."
    : "";
  const note =
    mode === "explain"
      ? `This is a question: answer it. You have no tools that change the part.${wide ? " The packet's part has the rest of it." : ""}`
      : `Edits you make are a proposal the user accepts or discards.${reach}`;
  blocks.push({
    type: "text",
    text: `Context packet:\n${JSON.stringify(packet, null, 1)}\n\n${image ? "The image shows the part framed on the target, which is outlined in orange.\n" : ""}${note}\n\nThe user's request:\n${text}`,
  });
  return blocks;
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
