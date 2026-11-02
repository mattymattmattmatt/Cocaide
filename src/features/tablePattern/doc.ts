// tablePattern: copies of earlier features at a table of [x, y] positions in
// a plane or a coordinate system (its XY plane by default). The seed sits at
// `from` (default: the first position); each other position gets a copy,
// moved in that plane by the difference. A table pasted as CSV (one "x, y"
// per line) becomes `positions`.

import type { DatumRef, FeatureBase, Vec2 } from "../../doc/types";
import type { BodyHooks, FeatureDef } from "../defs";
import { datumRefsAt } from "../datum";
import { copyIndices } from "../sketchPattern/doc";

export interface TablePatternFeature extends FeatureBase {
  op: "tablePattern";
  feature?: string;
  features?: string[];
  /** The plane or coordinate system the positions are in (x, y along its axes). Default Top. */
  system?: DatumRef;
  /** The places, [x, y] in that plane. */
  positions: Vec2[];
  /** Where the seed is, [x, y] in that plane. Default the first position (which then gets no copy). */
  from?: Vec2;
  /** Instances left out: 1 is the seed, 2, 3 ... the other positions in order. */
  skip?: number[];
}

/** The most rows a table may have. */
export const MAX_TABLE_ROWS = 1000;

/**
 * Body hooks for a pattern-like op whose copy count the document knows:
 * a copy of a seed that starts a body is a body <body>_<instance number>.
 */
export function copyBodies<F extends { feature?: string; features?: string[]; skip?: number[] }>(copiesOf: (f: F) => number): BodyHooks<F> {
  return {
    makes(f, state) {
      const copies = copiesOf(f);
      const ids = f.features ?? (f.feature ? [f.feature] : []);
      const names: string[] = [];
      for (const id of ids) {
        const seed = state.made.get(id);
        if (!seed) continue;
        for (let n = 2; n <= copies + 1; n++) if (!f.skip?.includes(n)) names.push(`${seed}_${n}`);
      }
      return names.length ? { names, path: f.features ? "features" : "feature" } : null;
    },
  };
}

/**
 * Rows of [x, y] read from pasted text: one position per line, the two
 * numbers split by a comma, semicolon, tab or spaces; a header line (no
 * numbers) or a blank one is skipped, a third column (a label, a z) ignored.
 * The error says which line could not be read.
 */
export function parseTable(text: string): Vec2[] | string {
  const out: Vec2[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = line.split(/[,;\t]|\s+/).map((c) => c.trim()).filter((c) => c !== "");
    const nums = cells.map((c) => Number(c));
    if (nums.every((n) => Number.isNaN(n)) && out.length === 0) continue; // a header
    if (cells.length < 2 || !Number.isFinite(nums[0]) || !Number.isFinite(nums[1])) return `line ${i + 1} ("${line}") is not "x, y": two numbers, split by a comma, a tab or spaces`;
    out.push([nums[0], nums[1]]);
  }
  if (out.length === 0) return 'no positions: paste one "x, y" per line';
  if (out.length > MAX_TABLE_ROWS) return `${out.length} positions is more than ${MAX_TABLE_ROWS}: split the table`;
  return out;
}

/** The table as CSV text, one "x, y" per line. */
export function tableText(positions: readonly (readonly unknown[])[]): string {
  return positions.map((p) => `${String(p[0])}, ${String(p[1])}`).join("\n");
}

const copiesOf = new WeakMap<TablePatternFeature, number>();

export const def: FeatureDef<TablePatternFeature> = {
  op: "tablePattern",
  validate(raw, c, x) {
    c.keys(raw, "", ["id", "op", "feature", "features", "system", "positions", "from", "skip"]);
    const seeds = x.seeds(raw);
    const system = raw.system === undefined ? undefined : x.datumRef(raw.system, "system", "plane");
    let positions: Vec2[] | undefined;
    if (!Array.isArray(raw.positions) || raw.positions.length === 0) c.fail("positions", `must be a list of [x, y] places in the plane, at least one (got ${x.describe(raw.positions)})`);
    else if (raw.positions.length > MAX_TABLE_ROWS) c.fail("positions", `has ${raw.positions.length} rows; at most ${MAX_TABLE_ROWS}`);
    else {
      const list = raw.positions.map((p, i) => c.vec2({ [`positions[${i}]`]: p }, `positions[${i}]`, ""));
      if (list.every((p) => p)) positions = list as Vec2[];
    }
    const from = raw.from === undefined ? undefined : c.vec2(raw, "from", "");
    let copies: number | undefined;
    if (positions) {
      copies = copyIndices(positions, from).length;
      if (copies === 0) c.fail("positions", "every position is where the seed is: there is nowhere to copy it to");
    }
    const skip = copies ? x.skip(raw, copies + 1) : undefined;
    if (c.errors.length || !seeds || !positions || system === null) return null;
    const f: TablePatternFeature = { id: raw.id as string, op: "tablePattern", ...seeds, ...(system ? { system } : {}), positions };
    if (from) f.from = from;
    if (skip) f.skip = skip;
    copiesOf.set(f, copies ?? 0);
    return f;
  },
  references: (raw) => (Array.isArray(raw.features) ? raw.features.filter((v): v is string => typeof v === "string") : typeof raw.feature === "string" ? [raw.feature] : []),
  datumRefs: (raw) => datumRefsAt(raw, "system"),
  bodies: copyBodies<TablePatternFeature>((f) => copiesOf.get(f) ?? 0),
  reference: `## tablePattern
{ "id": "tp_1", "op": "tablePattern", "feature": "hole_1", "system": { "datum": "cs1" }, "positions": [[0, 0], [25, 0], [25, 40], [-10, 15]] }
Copies of earlier features at a table of positions: "feature" (one) or "features": [...] (extrudes, cuts, holes,
members and the ops that pattern). "positions": [[x, y], ...] in the plane "system" (a plane or coordinate system
reference; default { "datum": "Top" }): x and y run along its axes from its origin (a coordinate system's XY plane:
its X and Y). "from": [x, y], where the seed sits in that plane (default the first position, which then gets no
copy). Instances: 1 the seed, then 2, 3 ... the other positions in order; "skip": [3] leaves some out. A copy of a
feature that starts a body is a new body <body>_<instance number>. The editor takes a table pasted as CSV.
`,
};
