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
      ];
    case "entity":
      return [
        { label: "Make it construction geometry", prompt: "Turn this into construction geometry.", submit: true },
        { label: "Constrain this distance", prompt: "Constrain this distance to ", submit: false },
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
        { label: "What is this face?", prompt: "What is this face?", submit: true },
      ];
    case "edge":
      return [
        { label: "Fillet this edge", prompt: "Fillet this edge, radius ", submit: false },
        { label: "Chamfer this edge", prompt: "Chamfer this edge, distance ", submit: false },
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
    case "part":
      return [
        { label: "New part from a description", prompt: "", submit: false },
        { label: "Explain this part", prompt: "What is this part, and how is it built?", submit: true },
        { label: "Check it", prompt: "Does this part rebuild cleanly, and is anything fragile?", submit: true },
      ];
    default:
      return [
        { label: "Explain this", prompt: "Explain what this feature does.", submit: true },
        { label: "Change a dimension", prompt: "Make it ", submit: false },
        { label: "Pattern it", prompt: "Pattern this ", submit: false },
        { label: "Suppress it: what breaks?", prompt: "If this were suppressed, what would break? Do not change anything.", submit: true },
      ];
  }
}

export const SYSTEM = `You are the agent inside Cocaide, a parametric CAD program. The user right-clicked one thing in their part and typed a request about it. You get a context packet that describes that thing: the target, its parent, its direct children, its measurements, the selector for a picked face or edge, and the error if it failed. The packet is all the context there is; do not ask for the rest of the part.

Pick the smallest response that does what was asked:
1. Answer: explain, name or measure. No edit. If the packet already answers the question, just answer.
2. Parameter: change one field on the target ("make this hole M6" sets diameter 6.6 and nothing else).
3. Scoped edit: add or change features inside writeScope.
4. Escalate: if the request cannot be done inside writeScope, call escalate with the reason. Never try to widen the scope.

Rules:
- writeScope is enforced by the program: an edit outside it is rejected and changes nothing. Its tokens: a feature id (change that feature, or add a feature that uses it), "<sketch>/*" (that sketch's entities and constraints only), "<sketch>/<entity>" (that entity and the constraints on it), "param:<name>", "body:<name>" (add features that touch only that body: an extrude with "body": name, a cut or hole with "bodies": [name], selectors naming it; and rename it), and "+" (add one new feature; from a face or edge it must use that face or edge, normally through the packet's selection).
- Every edit is checked: the part is rebuilt and the edit is kept only if nothing newly fails. A failed edit returns the error; read it and fix the call, or stop and say why.
- After your edits, check the measurement the user asked about in the tool result. If it does not match, you get one correction pass. Then stop.
- Your edits are a proposal: the user sees them and accepts or discards them. Do not ask for confirmation in text; make the proposal.
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

export const WRITE_TOOL_NAMES = new Set([...FEATURE_TOOLS, ...SKETCH_TOOLS].map((t) => t.name));

/** Explain-only asks get no write tools. */
export function toolsFor(mode: AskMode): Anthropic.Tool[] {
  return mode === "explain" ? READ_TOOLS : [...READ_TOOLS, ...FEATURE_TOOLS, ...SKETCH_TOOLS];
}

/** The user turn: the packet, the screenshot when the prompt is visual, then the user's text, unchanged and last. */
export function userTurn(packet: Packet, text: string, mode: AskMode, image?: Uint8Array): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  if (image) blocks.push({ type: "image", source: { type: "base64", media_type: "image/png", data: base64(image) } });
  const note =
    mode === "explain"
      ? "This is a question: answer it. You have no tools that change the part."
      : "Edits you make are a proposal the user accepts or discards.";
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
