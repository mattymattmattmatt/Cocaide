// import: a STEP file's solids as bodies of the part (DESIGN §2.9). The
// document holds the file's text, so the part opens anywhere and rebuilds the
// same; the file is read, repaired where it needs it, placed (turned about
// X, then Y, then Z, then moved by `at`) and each solid becomes a body:
// newBody (default: the feature's id), then newBody_2, newBody_3 ... or the
// names in `names`. Later features work on them like on any body: their faces
// and edges are picked and selected the same way.

import type { FeatureBase, Vec3 } from "../../doc/types";
import type { FeatureDef } from "../defs";
import { MAX_STEP_CHARS, stepProblem, stepSolidCount } from "./stepText";

export const IMPORT_FORMATS = ["step"] as const;

export interface ImportFeature extends FeatureBase {
  op: "import";
  format: (typeof IMPORT_FORMATS)[number];
  /** The file it came from ("bracket.step"): a label; the data is what builds. */
  fileName: string;
  /** The file's text (ISO 10303-21). */
  data: string;
  /** The first body's name; the others add _2, _3 ... Default: the feature's id. */
  newBody?: string;
  /** Names for the bodies, in the order of the file's solids (a solid past the end of the list is named from newBody). */
  names?: string[];
  /** Where the file's origin goes, mm (after turning). */
  at?: Vec3;
  /** Degrees about X, then Y, then Z, about the file's origin. */
  rotate?: Vec3;
}

/** "bracket", "bracket_2", ...: the k-th body (0-based) of an import. */
export function importBodyName(base: string, k: number): string {
  return k === 0 ? base : `${base}_${k + 1}`;
}

/** The bodies an import makes for `count` solids. */
export function importBodies(f: { id?: unknown; newBody?: unknown; names?: unknown }, count: number): string[] {
  const base = typeof f.newBody === "string" ? f.newBody : String(f.id);
  const names = Array.isArray(f.names) ? f.names : [];
  return Array.from({ length: count }, (_, k) => (typeof names[k] === "string" ? (names[k] as string) : importBodyName(base, k)));
}

/** How many solids a raw import's file makes, as the document reads it (1 when it can't tell). */
export function importSolidCount(raw: Record<string, unknown>): number {
  return typeof raw.data === "string" && !stepProblem(raw.data) ? stepSolidCount(raw.data) : 1;
}

/** A size for messages: "12.4 MB", "820 kB". */
export function sizeText(chars: number): string {
  return chars >= 1024 * 1024 ? `${(chars / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(chars / 1024))} kB`;
}

export const def: FeatureDef<ImportFeature> = {
  op: "import",
  validate(raw, c, x) {
    c.keys(raw, "", ["id", "op", "format", "fileName", "data", "newBody", "names", "at", "rotate"]);
    let format: ImportFeature["format"] | undefined;
    if (raw.format === undefined) c.fail("format", 'needed: "step" (a STEP file\'s solids become bodies)');
    else if (raw.format !== "step") c.fail("format", `must be "step" (got ${x.describe(raw.format)}); a DXF drawing goes into a sketch instead: Insert DXF in the sketcher`);
    else format = "step";
    if (typeof raw.fileName !== "string" || raw.fileName.trim() === "") c.fail("fileName", `must be the name of the file it came from, like "bracket.step" (got ${x.describe(raw.fileName)})`);
    let data: string | undefined;
    if (typeof raw.data !== "string" || raw.data === "") c.fail("data", `must be the STEP file's text (got ${x.describe(typeof raw.data === "string" ? "" : raw.data)})`);
    else if (raw.data.length > MAX_STEP_CHARS) c.fail("data", `is ${sizeText(raw.data.length)} of STEP text; a part holds at most ${sizeText(MAX_STEP_CHARS)}: simplify the model (fewer, simpler faces) or import it in parts`);
    else {
      const problem = stepProblem(raw.data);
      if (problem) c.fail("data", problem);
      else data = raw.data;
    }
    const newBody = x.newBody(raw);
    let names: string[] | undefined;
    if (raw.names !== undefined) {
      if (!Array.isArray(raw.names) || raw.names.length === 0) c.fail("names", `must be a list of body names, one per solid of the file in order (got ${x.describe(raw.names)})`);
      else {
        const list = raw.names.map((n, i) => x.bodyName(n, `names[${i}]`));
        if (list.every((n): n is string => n !== undefined)) names = list;
      }
    }
    const at = raw.at === undefined ? undefined : c.vec3(raw, "at", "");
    const rotate = raw.rotate === undefined ? undefined : c.vec3(raw, "rotate", "");
    if (c.errors.length || !format || !data) return null;
    return {
      id: raw.id as string,
      op: "import",
      format,
      fileName: String(raw.fileName),
      data,
      ...(newBody !== undefined ? { newBody } : {}),
      ...(names ? { names } : {}),
      ...(at ? { at } : {}),
      ...(rotate ? { rotate } : {}),
    };
  },
  bodies: {
    makes: (f) => ({ names: importBodies(f, importSolidCount(f as unknown as Record<string, unknown>)), path: f.names ? "names" : f.newBody !== undefined ? "newBody" : "id" }),
  },
  onlyBodies: (raw, inScope) => importBodies(raw, importSolidCount(raw)).every(inScope),
  bodyFromId: (raw) => raw.newBody === undefined && raw.names === undefined,
  renameBodies(raw, rename, before) {
    // A body renamed (the Bodies panel): every body the import makes is named in `names` from then on, so
    // the others keep their names whatever the first is now called.
    const was = importBodies(before ?? raw, importSolidCount(before ?? raw));
    const now = was.map((n) => String(rename(n)));
    if (now.every((n, i) => n === was[i])) return {};
    const base = typeof raw.newBody === "string" ? raw.newBody : String(raw.id);
    return now.every((n, i) => n === importBodyName(base, i)) ? { names: undefined } : { names: now };
  },
  reference: `## import
{ "id": "import_1", "op": "import", "format": "step", "fileName": "bracket.step", "data": "<the STEP file's text>",
  "newBody": "bracket" (optional: the first body's name, default the feature's id), "names": ["base", "lug"] (optional: a name per solid),
  "at": [0, 0, 50] (optional, mm), "rotate": [90, 0, 0] (optional, degrees about X, then Y, then Z) }
A STEP file (AP203, AP214 or AP242, any units: they are converted to mm) read into the part: each solid in it becomes a body,
named newBody, newBody_2, newBody_3 ... in the file's order (or by "names"). The file is repaired where it needs it (gaps
closed, faces sewn); a file of surfaces that close is sewn into a solid, one that does not close is refused. The solids are
turned by "rotate" about the file's origin (X first, then Y, then Z), then moved by "at". Later features use the bodies like
any others: holes, fillets, cuts, members, patterns, mirrors; their faces and edges are selected the usual way (listFaces,
listEdges on the part). The document holds the whole file: keep imports to a few MB (over 10 MB the app warns; 50 MB is
the most a part holds). In the app: Open a .step file (a new part), drop one on the view, or Bodies > Import STEP.
`,
};
