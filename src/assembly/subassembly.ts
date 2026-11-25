// Sub-assemblies: an assembly put into another as one component. A part
// document in `assembly.parts` that has an assembly of its own (a shed, its
// walls, roof and door) is a sub-assembly: its components, placed where it
// keeps them, move together as one rigid piece. It is mated, moved, hidden
// and listed as one; its view is its own components joined (each a body
// named by its component), so its faces are picked and mated like a part's.
// In the kernel it is one compound of its components' solids, so STEP export,
// interference and drawings take it as one component. Sub-assemblies nest (a
// limit keeps a document that holds itself from going round for ever). Pure,
// but for the views it is handed a way to build.

import { Checker } from "../doc/validate";
import { validateAssembly } from "../doc/assembly";
import type { Assembly } from "../doc/types";
import type { RebuildView } from "../worker/protocol";
import { partDocuments } from "./model";
import { composeScene } from "./scene";
import { placementOf } from "./transform";

/** How deep sub-assemblies may nest. */
export const MAX_DEPTH = 8;

/** Its assembly, when the document is a sub-assembly (an assembly with components, valid), else null. */
export function subAssemblyOf(doc: unknown): Assembly | null {
  if (!doc || typeof doc !== "object") return null;
  const raw = (doc as { assembly?: unknown }).assembly;
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { components?: unknown }).components) || !(raw as { components: unknown[] }).components.length) return null;
  try {
    return validateAssembly(raw, new Checker("document"));
  } catch {
    return null;
  }
}

export function isSubAssembly(doc: unknown): boolean {
  return subAssemblyOf(doc) !== null;
}

/** How many components it holds, counting those of the sub-assemblies in it. */
export function componentCount(doc: unknown, depth = 0): number {
  const asm = subAssemblyOf(doc);
  if (!asm || depth > MAX_DEPTH) return 1;
  const docs = partDocuments(doc as Record<string, unknown>, asm);
  return asm.components.reduce((n, k) => n + componentCount(docs[k.part], depth + 1), 0);
}

/**
 * What its view depends on, to know when to build it again: its own part's
 * geometry, where its components are and whether they are shown, and each of
 * its parts by `leafKey` (a sub-assembly in it, by this again).
 */
export function subAssemblyKey(doc: Record<string, unknown>, leafKey: (part: Record<string, unknown>) => string, depth = 0): string {
  const asm = subAssemblyOf(doc);
  if (!asm || depth > MAX_DEPTH) return leafKey(doc);
  const docs = partDocuments(doc, asm);
  const parts = Object.fromEntries(Object.entries(docs).map(([k, d]) => [k, isSubAssembly(d) ? subAssemblyKey(d, leafKey, depth + 1) : leafKey(d)]));
  const comps = asm.components.map((k) => [k.id, k.part, k.at ?? null, k.rotation ?? null, !!k.hidden]);
  return JSON.stringify({ comps, parts });
}

/**
 * Its view: each of its shown components' parts built (by `build`; a
 * sub-assembly in it, by this again), placed where it keeps them and joined.
 * A part that doesn't build is left out (its view is the rest).
 */
export async function subAssemblyView(doc: Record<string, unknown>, build: (part: Record<string, unknown>) => Promise<RebuildView>, depth = 0): Promise<RebuildView> {
  const asm = subAssemblyOf(doc);
  if (!asm) return build(doc);
  if (depth > MAX_DEPTH) throw new Error(`sub-assemblies nest more than ${MAX_DEPTH} deep (does it hold itself?)`);
  const docs = partDocuments(doc, asm);
  const views = new Map<string, RebuildView>();
  const failed: string[] = [];
  await Promise.all(
    Object.entries(docs).map(async ([key, d]) => {
      try {
        views.set(key, isSubAssembly(d) ? await subAssemblyView(d, build, depth + 1) : await build(d));
      } catch (e) {
        failed.push(`${key}: ${(e as Error).message}`);
      }
    }),
  );
  if (!views.size && failed.length) throw new Error(failed.join("; "));
  const name = typeof doc.name === "string" ? doc.name : "sub-assembly";
  const view = composeScene(asm.components.map((k) => ({ id: k.id, placement: placementOf(k), view: views.get(k.part), hidden: k.hidden })), name).view;
  return failed.length ? { ...view, errors: failed } : view;
}

/** Its components placed in its own frame, each with its part's document (for the kernel), shown ones only. */
export function subAssemblyParts(doc: Record<string, unknown>): { id: string; part: Record<string, unknown> | undefined; key: string; R: number[][]; t: number[] }[] {
  const asm = subAssemblyOf(doc);
  if (!asm) return [];
  const docs = partDocuments(doc, asm);
  return asm.components.filter((k) => !k.hidden).map((k) => {
    const P = placementOf(k);
    return { id: k.id, key: k.part, part: docs[k.part], R: P.R, t: P.t };
  });
}
