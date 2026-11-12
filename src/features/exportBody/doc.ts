// exportBody: a STEP export of some bodies, kept in the tree so it can be run
// again after the part changes. It makes no geometry. It holds which bodies,
// and where the file's axes go: the origin (the model's, the bodies' box
// centre, the middle of their bottom, or a point that follows the model) and
// orientation (what is up and which way the front faces, each a reference:
// an axis or edge's direction, a plane or flat face's normal), for a Z-up or
// a Y-up program. The rebuild works that frame out (shown in the view as a
// coordinate system); Export STEP in its properties writes the file.

import type { DatumRef, FeatureBase } from "../../doc/types";
import { datumRefsAt } from "../datum";
import type { FeatureDef } from "../defs";

export const EXPORT_ORIGINS = ["model", "centre", "bottom", "point"] as const;
export type ExportOrigin = (typeof EXPORT_ORIGINS)[number];
export const UP_CONVENTIONS = ["zUp", "yUp"] as const;

export interface ExportBodyFeature extends FeatureBase {
  op: "exportBody";
  /** The bodies to write (default every body). */
  bodies?: string[];
  /** Where the file's origin is (default "model": as modelled). */
  origin?: ExportOrigin;
  /** origin "point": the point (a vertex, an edge's midpoint, a circle's centre, a point feature). */
  point?: DatumRef;
  /** Up: an axis or straight edge (along it) or a plane or flat face (its normal). Default Z. */
  up?: DatumRef;
  reverseUp?: boolean;
  /** The way the front faces, the same way (made square to up). Default the Front plane's normal (−Y). */
  front?: DatumRef;
  reverseFront?: boolean;
  /** The program it is for: Z up (up becomes +Z, the front faces −Y; the default) or Y up (up +Y, front +Z). */
  convention?: (typeof UP_CONVENTIONS)[number];
  /** The file's name, without .step (default the part's, and the body's when one). */
  fileName?: string;
}

export const def: FeatureDef<ExportBodyFeature> = {
  op: "exportBody",
  validate(raw, c, x) {
    c.keys(raw, "", ["id", "op", "bodies", "origin", "point", "up", "reverseUp", "front", "reverseFront", "convention", "fileName"]);
    const bodies = raw.bodies === undefined ? undefined : x.bodyList(raw.bodies, "bodies");
    const origin = raw.origin === undefined ? undefined : x.oneOf(raw, "origin", "", EXPORT_ORIGINS);
    const point = raw.point === undefined ? undefined : x.datumRef(raw.point, "point", "point");
    if (origin === "point" && raw.point === undefined) c.fail("point", 'needed with origin "point": a vertex, an edge\'s midpoint, a circle\'s centre or a point');
    if (raw.point !== undefined && origin !== "point") c.fail("point", 'only origin "point" uses it');
    const up = raw.up === undefined ? undefined : x.datumRef(raw.up, "up", ["axis", "plane"]);
    const front = raw.front === undefined ? undefined : x.datumRef(raw.front, "front", ["axis", "plane"]);
    const convention = raw.convention === undefined ? undefined : x.oneOf(raw, "convention", "", UP_CONVENTIONS);
    let fileName: string | undefined;
    if (raw.fileName !== undefined) {
      if (typeof raw.fileName !== "string" || !raw.fileName.trim() || /[\\/:*?"<>|]/.test(raw.fileName)) c.fail("fileName", `must be a file name without / \\ : * ? " < > | (got ${x.describe(raw.fileName)})`);
      else fileName = raw.fileName.trim().replace(/\.ste?p$/i, "");
    }
    const reverseUp = x.bool(raw, "reverseUp", "");
    const reverseFront = x.bool(raw, "reverseFront", "");
    if (c.errors.length || bodies === null || point === null || up === null || front === null || origin === null || convention === null) return null;
    return {
      id: raw.id as string,
      op: "exportBody",
      ...(bodies ? { bodies } : {}),
      ...(origin ? { origin } : {}),
      ...(point ? { point } : {}),
      ...(up ? { up } : {}),
      ...(reverseUp ? { reverseUp } : {}),
      ...(front ? { front } : {}),
      ...(reverseFront ? { reverseFront } : {}),
      ...(convention ? { convention } : {}),
      ...(fileName ? { fileName } : {}),
    };
  },
  datumRefs: (raw) => datumRefsAt(raw, "point", "up", "front"),
  reference: `## exportBody
{ "id": "export_1", "op": "exportBody", "bodies": ["upright"], "origin": "bottom", "up": { "datum": "X" }, "convention": "zUp" }
A STEP export kept in the tree (it makes no geometry; put it last): which bodies (default all) and where the file's axes go.
"origin": "model" (as modelled, the default), "centre" (the bodies' box centre), "bottom" (the middle of their bottom,
lowest along up) or "point" with "point": a point reference (a vertex { "edge", "at" }, an edge's "mid", a circle's "center").
"up": an axis or straight edge (its direction) or a plane or flat face (its normal), default { "datum": "Z" };
"front": the way the front faces, the same way (default { "datum": "Front" }: its normal, -Y); "reverseUp" / "reverseFront".
"convention": "zUp" (up becomes +Z, the front faces -Y; most CAD and CAM) or "yUp" (up +Y, front +Z). "fileName" (no .step).
The rebuild works the frame out (a coordinate system in the view); the user exports the file from its properties.
`,
};
