// The assembly in the document (src/doc/types.ts Assembly): validated
// strictly, as the drawing is, and never in the way of the part: what is
// wrong with it is listed as the assembly's errors. Pure.

import { MATE_TYPES, type Assembly, type AssemblyComponent, type Mate, type MateRef, type Vec3 } from "./types";
import { Checker, validateEdgeSelector, validateFaceSelector } from "./validate";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const describe = (v: unknown) => (v === undefined ? "nothing" : JSON.stringify(v));

/** The part key a component made from this document's own part uses. */
export const SELF = "self";
export const MATE_DATUMS = ["Top", "Front", "Right", "X", "Y", "Z", "Origin"] as const;

/** The assembly as written, checked; null with the errors when it can't be read at all. */
export function validateAssembly(raw: unknown, c: Checker): Assembly | null {
  if (!isObject(raw)) {
    c.fail("assembly", `must be { "components": [...], "mates"?: [...], "parts"?: {...} } (got ${describe(raw)})`);
    return null;
  }
  c.keys(raw, "assembly", ["parts", "components", "mates"]);
  const parts: Record<string, unknown> = {};
  if (raw.parts !== undefined) {
    if (!isObject(raw.parts)) c.fail("assembly.parts", `must map part keys to part documents (got ${describe(raw.parts)})`);
    else
      for (const [key, doc] of Object.entries(raw.parts)) {
        if (key === SELF) c.fail(`assembly.parts.${key}`, `"${SELF}" is this document's own part: give the part another key`);
        else if (!isObject(doc) || !Array.isArray(doc.features)) c.fail(`assembly.parts.${key}`, "must be a part document (with its features)");
        else parts[key] = doc;
      }
  }
  const components: AssemblyComponent[] = [];
  if (!Array.isArray(raw.components)) c.fail("assembly.components", `must be a list of components (got ${describe(raw.components)})`);
  else
    raw.components.forEach((x, i) => {
      const at = `assembly.components[${i}]`;
      if (!isObject(x)) return c.fail(at, `must be a component { "id", "part", "at"?, "rotation"? } (got ${describe(x)})`);
      c.keys(x, at, ["id", "part", "at", "rotation", "fixed", "hidden", "transparent"]);
      if (typeof x.id !== "string" || !/^[A-Za-z_][\w-]*$/.test(x.id)) return c.fail(`${at}.id`, `must be a name (letters, digits, _ and -; got ${describe(x.id)})`);
      if (components.some((k) => k.id === x.id)) return c.fail(`${at}.id`, `"${x.id}" is another component's id`);
      if (typeof x.part !== "string" || (x.part !== SELF && !(x.part in parts))) {
        return c.fail(`${at}.part`, `must be "${SELF}" (this part) or a key of assembly.parts (${Object.keys(parts).join(", ") || "none"}; got ${describe(x.part)})`);
      }
      const vec = (key: "at" | "rotation"): Vec3 | undefined => (x[key] === undefined ? undefined : c.vec3(x, key, at));
      const comp: AssemblyComponent = { id: x.id, part: x.part };
      const place = vec("at");
      const turn = vec("rotation");
      if (place) comp.at = place;
      if (turn) comp.rotation = turn;
      for (const k of ["fixed", "hidden", "transparent"] as const) {
        if (x[k] === undefined) continue;
        if (typeof x[k] !== "boolean") c.fail(`${at}.${k}`, `must be true or false (got ${describe(x[k])})`);
        else if (x[k]) comp[k] = true;
      }
      components.push(comp);
    });
  const mates: Mate[] = [];
  if (raw.mates !== undefined) {
    if (!Array.isArray(raw.mates)) c.fail("assembly.mates", `must be a list of mates (got ${describe(raw.mates)})`);
    else
      raw.mates.forEach((x, i) => {
        const at = `assembly.mates[${i}]`;
        if (!isObject(x)) return c.fail(at, `must be a mate { "id", "type", "a", "b" } (got ${describe(x)})`);
        c.keys(x, at, ["id", "type", "a", "b", "value", "aligned", "suppressed"]);
        if (typeof x.id !== "string" || !x.id) return c.fail(`${at}.id`, `must be a name (got ${describe(x.id)})`);
        if (mates.some((m) => m.id === x.id)) return c.fail(`${at}.id`, `"${x.id}" is another mate's id`);
        if (!MATE_TYPES.includes(x.type as never)) return c.fail(`${at}.type`, `must be ${MATE_TYPES.map((t) => `"${t}"`).join(", ")} (got ${describe(x.type)})`);
        const a = mateRef(x.a, `${at}.a`, c, components);
        const b = mateRef(x.b, `${at}.b`, c, components);
        if (!a || !b) return;
        if (a.component === b.component) return c.fail(at, `mates two things of one component ("${a.component}"): a mate holds two components together`);
        const needs = x.type === "distance" || x.type === "angle";
        if (needs && typeof x.value !== "number") return c.fail(`${at}.value`, `${x.type === "distance" ? "a distance mate needs the distance (mm)" : "an angle mate needs the angle (degrees)"} (got ${describe(x.value)})`);
        if (!needs && x.value !== undefined) return c.fail(`${at}.value`, `a ${x.type} mate takes no value`);
        if (x.type === "angle" && ((x.value as number) < 0 || (x.value as number) > 180)) return c.fail(`${at}.value`, `must be 0 to 180 degrees (got ${x.value})`);
        const mate: Mate = { id: x.id, type: x.type as Mate["type"], a, b };
        if (needs) mate.value = x.value as number;
        for (const k of ["aligned", "suppressed"] as const) {
          if (x[k] === undefined) continue;
          if (typeof x[k] !== "boolean") c.fail(`${at}.${k}`, `must be true or false (got ${describe(x[k])})`);
          else if (x[k]) mate[k] = true;
        }
        mates.push(mate);
      });
  }
  return { ...(Object.keys(parts).length ? { parts } : {}), components, ...(mates.length ? { mates } : {}) };
}

function mateRef(raw: unknown, at: string, c: Checker, components: AssemblyComponent[]): MateRef | null {
  if (!isObject(raw)) {
    c.fail(at, `must be { "component", "face" | "edge" | "datum" } (got ${describe(raw)})`);
    return null;
  }
  c.keys(raw, at, ["component", "face", "edge", "datum"]);
  if (typeof raw.component !== "string" || !components.some((k) => k.id === raw.component)) {
    c.fail(`${at}.component`, `must be a component of the assembly (${components.map((k) => k.id).join(", ") || "none"}; got ${describe(raw.component)})`);
    return null;
  }
  const given = (["face", "edge", "datum"] as const).filter((k) => raw[k] !== undefined);
  if (given.length !== 1) {
    c.fail(at, 'names one thing of the component: a "face" or "edge" selector, or a "datum" ("Top", "Front", "Right", "X", "Y", "Z", "Origin")');
    return null;
  }
  const ref: MateRef = { component: raw.component };
  if (raw.face !== undefined) {
    const f = validateFaceSelector(raw.face, `${at}.face`, c);
    if (!f) return null;
    ref.face = f;
  } else if (raw.edge !== undefined) {
    const e = validateEdgeSelector(raw.edge, `${at}.edge`, c);
    if (!e) return null;
    ref.edge = e;
  } else {
    if (!MATE_DATUMS.includes(raw.datum as never)) {
      c.fail(`${at}.datum`, `must be ${MATE_DATUMS.map((d) => `"${d}"`).join(", ")} (got ${describe(raw.datum)})`);
      return null;
    }
    ref.datum = raw.datum as string;
  }
  return ref;
}

/** A new component's id: the part's name and the next free number ("bracket-1"). */
export function nextComponentId(assembly: Assembly | undefined, base: string): string {
  const stem = base.replace(/[^\w-]+/g, "_").replace(/^[^A-Za-z_]+/, "") || "part";
  const taken = new Set((assembly?.components ?? []).map((k) => k.id));
  for (let i = 1; ; i++) if (!taken.has(`${stem}-${i}`)) return `${stem}-${i}`;
}

/** A new mate's id. */
export function nextMateId(assembly: Assembly | undefined, type: string): string {
  const taken = new Set((assembly?.mates ?? []).map((m) => m.id));
  for (let i = 1; ; i++) if (!taken.has(`${type}${i}`)) return `${type}${i}`;
}
