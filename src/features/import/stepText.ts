// STEP text, read without the kernel: is it a STEP file at all, and how many
// solids will it make. The document layer needs the count before any rebuild,
// to know the bodies an import makes (newBody, newBody_2, ...) when later
// features name them. Pure; no imports.
//
// The count follows the file's product structure the way the kernel's reader
// does: each top-level product, its own solids (through its shape
// representations, the relationships that link them and mapped items), and
// every occurrence of each sub-assembly and part under it, so a bolt used
// four times counts four times. A file with no products counts its solids.

export const STEP_MAGIC = "ISO-10303-21";

/** Above this a document warns that it is getting heavy; at MAX_STEP_CHARS it refuses. */
export const WARN_STEP_CHARS = 10 * 1024 * 1024;
export const MAX_STEP_CHARS = 50 * 1024 * 1024;

/** Why the text is not a STEP file, or null when it looks like one. */
export function stepProblem(text: string): string | null {
  const head = text.slice(0, 2048).replace(/^﻿/, "").trimStart();
  if (!head.startsWith(`${STEP_MAGIC};`)) {
    if (/^\s*\{/.test(head)) return "is JSON, not STEP text: open a .cocaide.json part with Open";
    if (/^[\s\d]*\r?\n\s*SECTION/.test(head) || /^\s*0\s*\r?\n\s*SECTION/.test(head)) return "is a DXF drawing, not STEP: insert a DXF into a sketch (Insert DXF in the sketcher)";
    return `does not start with "${STEP_MAGIC};": it is not a STEP file (save it from the program it came from as STEP AP203, AP214 or AP242)`;
  }
  if (!/\bDATA\s*;/.test(text.slice(0, 1 << 20))) return 'has no DATA section: the STEP file is cut short or damaged; export it again';
  if (!text.slice(-4096).includes(`END-${STEP_MAGIC}`)) return `does not end with "END-${STEP_MAGIC};": the file is cut short; export or copy it again`;
  return null;
}

interface Entity {
  /** Entity type names: one for a simple entity, several for a complex one "(A(...) B(...))". */
  types: string[];
  /** The text inside the outer parentheses. */
  body: string;
}

const SOLID_TYPES = new Set(["MANIFOLD_SOLID_BREP", "BREP_WITH_VOIDS", "FACETED_BREP"]);
const REPRESENTATION_TYPES = new Set([
  "SHAPE_REPRESENTATION",
  "ADVANCED_BREP_SHAPE_REPRESENTATION",
  "MANIFOLD_SURFACE_SHAPE_REPRESENTATION",
  "FACETED_BREP_SHAPE_REPRESENTATION",
  "GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION",
]);

/** Splits the DATA section into entities by id. Strings ('...', '' for a quote) and comments are skipped over. */
function entities(text: string): Map<number, Entity> {
  const out = new Map<number, Entity>();
  const data = text.search(/\bDATA\s*;/);
  if (data < 0) return out;
  let i = text.indexOf(";", data) + 1;
  const n = text.length;
  while (i < n) {
    // One statement, to its ';' outside strings and comments.
    let j = i;
    let inString = false;
    for (; j < n; j++) {
      const ch = text.charCodeAt(j);
      if (inString) {
        if (ch === 39 /* ' */) {
          if (text.charCodeAt(j + 1) === 39) j++;
          else inString = false;
        }
      } else if (ch === 39) inString = true;
      else if (ch === 47 /* / */ && text.charCodeAt(j + 1) === 42 /* * */) {
        const end = text.indexOf("*/", j + 2);
        j = end < 0 ? n : end + 1;
      } else if (ch === 59 /* ; */) break;
    }
    const stmt = text.slice(i, j).trim();
    i = j + 1;
    if (stmt === "ENDSEC") break;
    const m = /^#(\d+)\s*=\s*/.exec(stmt);
    if (!m) continue;
    const rest = stmt.slice(m[0].length);
    if (rest.startsWith("(")) {
      // A complex entity: (A(...)B(...)...): its type names at depth one.
      const types: string[] = [];
      let depth = 0;
      let word = "";
      for (let k = 0; k < rest.length; k++) {
        const c = rest[k];
        if (c === "'") {
          k = skipString(rest, k);
          continue;
        }
        if (c === "(") {
          if (depth === 1 && word) types.push(word);
          word = "";
          depth++;
        } else if (c === ")") {
          depth--;
          word = "";
        } else if (depth === 1 && /[A-Z0-9_]/.test(c)) word += c;
        else if (depth === 1) word = "";
      }
      out.set(Number(m[1]), { types, body: rest });
    } else {
      const t = /^([A-Z0-9_]+)\s*\(/.exec(rest);
      if (t) out.set(Number(m[1]), { types: [t[1]], body: rest.slice(t[0].length, rest.lastIndexOf(")")) });
    }
  }
  return out;
}

function skipString(s: string, k: number): number {
  for (let j = k + 1; j < s.length; j++) {
    if (s[j] === "'") {
      if (s[j + 1] === "'") j++;
      else return j;
    }
  }
  return s.length;
}

/** The top-level arguments of an entity body ("'a',#1,(#2,#3),$" → ["'a'", "#1", "(#2,#3)", "$"]). */
function args(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < body.length; k++) {
    const c = body[k];
    if (c === "'") k = skipString(body, k);
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(body.slice(start, k).trim());
      start = k + 1;
    }
  }
  out.push(body.slice(start).trim());
  return out;
}

const refs = (s: string | undefined): number[] => (s ? [...s.matchAll(/#(\d+)/g)].map((m) => Number(m[1])) : []);

/** How many solids the file makes (see the header comment); at least 1 for a file that holds only shells (they may sew into one). */
export function stepSolidCount(text: string): number {
  const cached = counts.get(text);
  if (cached !== undefined) return cached;
  const n = countSolids(text);
  counts.set(text, n);
  // Keep the last few files: the document holds one or two STEP texts, validated over and over.
  if (counts.size > 4) counts.delete(counts.keys().next().value!);
  return n;
}

const counts = new Map<string, number>();

function countSolids(text: string): number {
  const all = entities(text);
  const ofType = (t: string) => [...all].filter(([, e]) => e.types.length === 1 && e.types[0] === t);
  const isSolid = (id: number) => {
    const e = all.get(id);
    return !!e && e.types.length === 1 && SOLID_TYPES.has(e.types[0]);
  };
  const everySolid = [...all.values()].filter((e) => e.types.length === 1 && SOLID_TYPES.has(e.types[0])).length;

  // Representation links without a placement (a part's SHAPE_REPRESENTATION to its ADVANCED_BREP...), both ways.
  const linked = new Map<number, number[]>();
  for (const [, e] of ofType("SHAPE_REPRESENTATION_RELATIONSHIP")) {
    const [, , a, b] = args(e.body);
    const ra = refs(a)[0];
    const rb = refs(b)[0];
    if (ra === undefined || rb === undefined) continue;
    linked.set(ra, [...(linked.get(ra) ?? []), rb]);
    linked.set(rb, [...(linked.get(rb) ?? []), ra]);
  }
  /** Solids a representation holds: its own items, mapped items' representations, and what it is linked to. */
  const repSolids = (rep: number, seen: Set<number>): number => {
    if (seen.has(rep)) return 0;
    seen.add(rep);
    const e = all.get(rep);
    let count = 0;
    if (e && e.types.length === 1 && REPRESENTATION_TYPES.has(e.types[0])) {
      for (const item of refs(args(e.body)[1])) {
        if (isSolid(item)) count++;
        else {
          const it = all.get(item);
          if (it?.types[0] === "MAPPED_ITEM") {
            // MAPPED_ITEM('', #map, #target): the map's representation is placed here.
            const map = all.get(refs(args(it.body)[1])[0]);
            if (map?.types[0] === "REPRESENTATION_MAP") count += repSolids(refs(args(map.body)[1])[0], seen);
          }
        }
      }
    }
    for (const other of linked.get(rep) ?? []) count += repSolids(other, seen);
    return count;
  };

  // Products: each definition's shape representations, and the occurrences of other definitions under it.
  const pdShape = new Map<number, number>(); // PRODUCT_DEFINITION_SHAPE -> PRODUCT_DEFINITION
  for (const [id, e] of ofType("PRODUCT_DEFINITION_SHAPE")) {
    const pd = refs(args(e.body)[2])[0];
    if (pd !== undefined) pdShape.set(id, pd);
  }
  const reps = new Map<number, number[]>(); // PRODUCT_DEFINITION -> representations
  for (const [, e] of ofType("SHAPE_DEFINITION_REPRESENTATION")) {
    const [def, rep] = args(e.body).map((a) => refs(a)[0]);
    const pd = def !== undefined ? pdShape.get(def) : undefined;
    if (pd === undefined || rep === undefined) continue;
    reps.set(pd, [...(reps.get(pd) ?? []), rep]);
  }
  const children = new Map<number, number[]>();
  const isChild = new Set<number>();
  for (const [, e] of ofType("NEXT_ASSEMBLY_USAGE_OCCURRENCE")) {
    const a = args(e.body);
    const parent = refs(a[3])[0];
    const child = refs(a[4])[0];
    if (parent === undefined || child === undefined) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
    isChild.add(child);
  }
  const definitions = new Set([...ofType("PRODUCT_DEFINITION")].map(([id]) => id));
  if (definitions.size === 0) return Math.max(1, everySolid);
  const pdSolids = (pd: number, path: Set<number>): number => {
    if (path.has(pd)) return 0; // a product that contains itself: ignore the loop
    const next = new Set(path).add(pd);
    let count = 0;
    // An assembly's own representation links to its components' only through placements: count its own solids.
    for (const rep of reps.get(pd) ?? []) count += repSolids(rep, new Set());
    for (const child of children.get(pd) ?? []) count += pdSolids(child, next);
    return count;
  };
  let total = 0;
  for (const pd of definitions) if (!isChild.has(pd)) total += pdSolids(pd, new Set());
  return Math.max(1, total || everySolid);
}
