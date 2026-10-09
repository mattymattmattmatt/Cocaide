// The faces a list of face selectors picks on the part as it stands, for ops
// that work on several faces at once (shell's removed faces, draft's faces).
// Each selector must pick at least one face, and no tie: a "largest" that two
// faces share is an error that says so. Faces picked twice count once.

import type { TopoDS_Face } from "replicad-opencascadejs";
import type { FaceSelector } from "../doc/types";
import type { DescribedPart } from "./bodies";
import { OpError } from "./ops";
import { describeWanted, selectFaces } from "./selectors";

export interface PickedFace {
  /** Its index in the part's face order (this rebuild only). */
  index: number;
  face: TopoDS_Face;
  /** The body it is on. */
  body: string | undefined;
  /** The selector that picked it first, as a field path ("faces[1]"). */
  path: string;
}

/** The faces the selectors pick, in selector order; OpError naming the selector that picks none, or ties. */
export function pickFaces(part: DescribedPart, selectors: readonly FaceSelector[], path = "faces"): PickedFace[] {
  const out: PickedFace[] = [];
  const seen = new Set<number>();
  selectors.forEach((sel, i) => {
    const where = `${path}[${i}]`;
    const found = selectFaces(part.faceInfos, sel);
    if (found.matches.length === 0) throw new OpError(`${where}: selector matched no face (wanted ${describeWanted(sel, 1)})`);
    if (found.tie) throw new OpError(`${where}: selector matched ${found.matches.length} faces tied for ${found.tie}${found.tie === "nearest" ? "" : " area"}; add "near" to pick one, or "pick": "all" for all of them`);
    for (const info of found.matches) {
      if (seen.has(info.index)) continue;
      seen.add(info.index);
      out.push({ index: info.index, face: part.faces[info.index], body: info.body, path: where });
    }
  });
  return out;
}

/**
 * The one body these faces are on, checked against the body the feature
 * names; with no faces, the named body, else the part's only body. `verb`
 * names the op in messages ("hollow", "draft").
 */
export function bodyOfFaces(picked: readonly PickedFace[], named: string | undefined, bodies: readonly string[], verb: string): string {
  const on = [...new Set(picked.map((p) => p.body).filter((b): b is string => b !== undefined))];
  if (on.length > 1) throw new OpError(`faces: the faces are on ${on.length} bodies (${on.join(", ")}); a ${verb} works on one body: make one feature per body`);
  if (named !== undefined) {
    if (on.length === 1 && on[0] !== named) throw new OpError(`faces: the faces are on body "${on[0]}", not on "${named}" (the body this feature names)`);
    return named;
  }
  if (on.length === 1) return on[0];
  if (bodies.length === 1) return bodies[0];
  if (bodies.length === 0) throw new OpError("there is no solid before this feature");
  throw new OpError(`the part has ${bodies.length} bodies (${bodies.join(", ")}); name the one to ${verb} with "body"`);
}
