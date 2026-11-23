// The assembly in the document (src/doc/types.ts Assembly): validated
// strictly, as the drawing is, and never in the way of the part: what is
// wrong with it is listed as the assembly's errors. Pure.

import { MATE_TYPES, type Assembly, type AssemblyComponent, type ExplodeStep, type Mate, type MateRef, type Vec3 } from "./types";
import { Checker, checkAppearance, validateEdgeSelector, validateFaceSelector } from "./validate";

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
  c.keys(raw, "assembly", ["parts", "components", "mates", "explode"]);
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
      c.keys(x, at, ["id", "part", "at", "rotation", "fixed", "hidden", "transparent", "appearance"]);
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
      if (x.appearance !== undefined) {
        const look = checkAppearance(x.appearance, `${at}.appearance`, c);
        if (look) comp.appearance = look;
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
        c.keys(x, at, ["id", "type", "a", "b", "value", "aligned", "opposed", "flip", "suppressed", "min", "max", "lockRotation", "relative"]);
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
        if (x.aligned === true && x.opposed === true) return c.fail(at, "can't be both aligned and opposed: one way round or the other");
        // A limit: a range for a distance or an angle.
        if (x.min !== undefined || x.max !== undefined) {
          if (!needs) return c.fail(at, `a ${x.type} mate takes no limits (min and max are for distance and angle mates)`);
          if (typeof x.min !== "number" || typeof x.max !== "number" || !Number.isFinite(x.min) || !Number.isFinite(x.max)) return c.fail(at, `a limit needs both min and max as numbers (got ${describe(x.min)}, ${describe(x.max)})`);
          if (x.min > x.max) return c.fail(at, `min (${x.min}) is more than max (${x.max})`);
          if (x.type === "angle" && (x.min < 0 || x.max > 180)) return c.fail(at, `an angle's limits are 0 to 180 degrees (got ${x.min} to ${x.max})`);
          mate.min = x.min;
          mate.max = x.max;
        }
        // Where b was locked to a (lock; concentric with its rotation locked).
        const vec = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
        if (x.relative !== undefined) {
          if (!isObject(x.relative) || !vec(x.relative.at) || !vec(x.relative.rotation)) return c.fail(`${at}.relative`, `must be { "at": [x, y, z], "rotation": [x, y, z] }: b's place from a (got ${describe(x.relative)})`);
          mate.relative = { at: x.relative.at as Vec3, rotation: x.relative.rotation as Vec3 };
        }
        if (x.lockRotation !== undefined) {
          if (x.type !== "concentric") return c.fail(`${at}.lockRotation`, "only a concentric mate locks its rotation");
          if (x.lockRotation === true) {
            if (!mate.relative) return c.fail(`${at}.relative`, "a concentric mate with its rotation locked needs the turn it keeps (relative)");
            mate.lockRotation = true;
          }
        }
        if (x.type === "lock" && !mate.relative) return c.fail(`${at}.relative`, "a lock mate needs where b is from a (relative: { at, rotation })");
        for (const k of ["aligned", "opposed", "flip", "suppressed"] as const) {
          if (x[k] === undefined) continue;
          if (typeof x[k] !== "boolean") c.fail(`${at}.${k}`, `must be true or false (got ${describe(x[k])})`);
          else if (x[k]) mate[k] = true;
        }
        mates.push(mate);
      });
  }
  const explode: ExplodeStep[] = [];
  if (raw.explode !== undefined) {
    if (!Array.isArray(raw.explode)) c.fail("assembly.explode", `must be a list of steps { "components": [...], "move": [x, y, z] } (got ${describe(raw.explode)})`);
    else
      raw.explode.forEach((x, i) => {
        const at = `assembly.explode[${i}]`;
        if (!isObject(x)) return c.fail(at, `must be a step { "components": [...], "move": [x, y, z] } (got ${describe(x)})`);
        c.keys(x, at, ["components", "move"]);
        if (!Array.isArray(x.components) || !x.components.length || !x.components.every((id) => typeof id === "string" && components.some((k) => k.id === id))) {
          return c.fail(`${at}.components`, `must list components of the assembly (${components.map((k) => k.id).join(", ") || "none"}; got ${describe(x.components)})`);
        }
        const move = c.vec3(x, "move", at);
        if (move) explode.push({ components: x.components as string[], move });
      });
  }
  return { ...(Object.keys(parts).length ? { parts } : {}), components, ...(mates.length ? { mates } : {}), ...(explode.length ? { explode } : {}) };
}

/** Each component's exploded offset: the sum of the explode steps it is in (none: not moved). */
export function explodeOffsets(asm: Assembly | undefined): Map<string, Vec3> {
  const out = new Map<string, Vec3>();
  for (const step of asm?.explode ?? [])
    for (const id of step.components) {
      const o = out.get(id) ?? [0, 0, 0];
      out.set(id, [o[0] + step.move[0], o[1] + step.move[1], o[2] + step.move[2]]);
    }
  return out;
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
