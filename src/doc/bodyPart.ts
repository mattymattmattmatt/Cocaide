// Save a body as a part (Phase M): one body of a part becomes a document of
// its own. It is a copy of the whole part, ending in a deleteBody that keeps
// that body, so it stays fully parametric and rebuilds exactly that body. It
// is never a link: linking files would need a shared store, which v1 avoids.

import { nextId, type RawDocument } from "./commands";
import { isObject, validateDocument, allErrors } from "./validate";

export type BodyPartResult = { ok: true; doc: RawDocument; name: string } | { ok: false; error: string };

export function bodyPart(input: RawDocument, body: string): BodyPartResult {
  const v = validateDocument(input);
  if (!v.bodies.includes(body)) return { ok: false, error: `no body "${body}" (bodies: ${v.bodies.join(", ") || "none"})` };
  const errors = allErrors(v).filter((e) => !e.startsWith("document: drawing"));
  if (errors.length) return { ok: false, error: `the part has errors to fix first: ${errors[0]}` };
  const doc = structuredClone(input) as RawDocument;
  doc.name = body;
  // The other bodies go at the end; a part of one body needs nothing.
  if (v.bodies.length > 1) doc.features.push({ id: nextId(doc, "keep"), op: "deleteBody", keep: [body] });
  // The body's material becomes the part's.
  const own = v.bodyMaterials[body];
  if (own) doc.material = own;
  delete doc.bodyMaterials;
  // The drawing and the weld table were the whole part's.
  delete doc.drawing;
  delete doc.welds;
  const after = allErrors(validateDocument(doc));
  if (after.length) return { ok: false, error: `the saved part would not validate: ${after[0]}` };
  return { ok: true, doc, name: body };
}

/** The file name a saved body goes by: "stand-upright.cocaide.json". */
export function bodyPartFile(part: unknown, body: string): string {
  const base = (isObject(part) && typeof part.name === "string" ? part.name : "part").replace(/[^\w.-]+/g, "_") || "part";
  return `${base}-${body.replace(/[^\w.-]+/g, "_")}.cocaide.json`;
}
