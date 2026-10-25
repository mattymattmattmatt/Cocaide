// A whole part as STEP, the way the app and the MCP server export it: the
// product named by the part number (else the part's name), its description
// and author from the part's properties, and the photo note when the part was
// estimated from a photo (that note wins the file description: it matters more).

import { photoNote } from "../doc/photo";
import { partProperties, stepProduct } from "../doc/properties";
import type { OC } from "./oc";
import type { RebuildResult } from "./rebuild";
import { exportSTEP } from "./step";

export function exportPartSTEP(oc: OC, built: RebuildResult, doc: unknown): string {
  if (!built.solid) throw new Error("there is no solid to export");
  const product = stepProduct(doc, built.name);
  const p = partProperties(doc);
  return exportSTEP(oc, built.solid, product.name, photoNote(doc) ?? product.description, built.bodies, { author: p.author, productDescription: product.description });
}
