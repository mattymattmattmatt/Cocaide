// A .glb file as a mesh part document (src/mesh/meshPart.ts): read once to check it is a model this can draw (and
// to say how big it is as modelled), then carried whole, base64, in the part. Browser.

import { bytesToBase64, isGlb, parseGlb } from "./glb";
import { meshPartView } from "./meshPart";

export async function glbPart(file: File): Promise<{ part: Record<string, unknown>; size: [number, number, number] }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isGlb(bytes)) throw new Error("it isn't a .glb (binary glTF) file");
  const view = meshPartView(parseGlb(bytes), "model");
  // Its name from the file's: underscores as spaces, a trailing date and code (as generators stamp exports) dropped.
  const name =
    file.name
      .replace(/\.glb$/i, "")
      .replace(/[ _-]+\d{4}-\d{2}-\d{2}(?:[ _-]+[0-9a-z]{4,10})?$/i, "")
      .replace(/_+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "model";
  return { part: { version: 1, units: "mm", name, features: [], mesh: { glb: bytesToBase64(bytes) } }, size: view.meshSize ?? [0, 0, 0] };
}
