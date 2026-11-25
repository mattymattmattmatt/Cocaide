// A mesh part's view, built in the page (no kernel needed): its .glb decoded (or fetched) and read once, kept by
// where it came from, then drawn at the part's scale. Browser.

import type { RebuildView } from "../worker/protocol";
import { parseGlb, type GlbMesh } from "./glb";
import { meshBytes, meshPartView, meshSpecOf, type MeshSpec } from "./meshPart";

const parsed = new Map<string, Promise<GlbMesh>>();

/** Where a mesh comes from, cheaply: its address, or its base64's length and ends (hashing the whole of a large one each time would be slow). */
export function meshSource(spec: MeshSpec): string {
  if (spec.url) return `url:${spec.url}`;
  const g = spec.glb ?? "";
  return `glb:${g.length}:${g.slice(0, 96)}:${g.slice(-96)}`;
}

/** What a mesh part's view depends on: its source, scale and name. */
export function meshKey(part: unknown): string {
  const spec = meshSpecOf(part);
  if (!spec) return "";
  const name = (part as { name?: unknown }).name;
  return `${meshSource(spec)}|${spec.scale ?? 1}|${typeof name === "string" ? name : ""}`;
}

export async function loadMeshView(part: unknown, key: string): Promise<RebuildView> {
  const spec = meshSpecOf(part);
  if (!spec) throw new Error("not a mesh part");
  const src = meshSource(spec);
  let p = parsed.get(src);
  if (!p) {
    p = meshBytes(spec).then(parseGlb);
    parsed.set(src, p);
    p.catch(() => parsed.delete(src));
  }
  const g = await p;
  const name = (part as { name?: unknown }).name;
  return meshPartView(g, typeof name === "string" ? name : key, spec.scale ?? 1, key);
}
