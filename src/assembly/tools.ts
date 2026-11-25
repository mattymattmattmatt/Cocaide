// The AI's assembly tools, one implementation for every host (the bridge's
// agent session, the in-app ask): each reads the document and the parts'
// topology (the host builds them) and answers, or gives the one command
// that makes the change (setAssembly: the assembly with the mates solved).
// What the user can do in the Assembly tab, the AI can do here, and check.

import { isMeshPart } from "../mesh/meshPart";
import { autoExplode, explodeWithout } from "./explode";
import { nextComponentId, nextMateId, SELF, validateAssembly } from "../doc/assembly";
import type { Command, RawDocument } from "../doc/commands";
import { geometryKey } from "../doc/drawing";
import type { Assembly, AssemblyComponent, ExplodeStep, Mate, MateRef, Vec3 } from "../doc/types";
import { MATE_TYPES } from "../doc/types";
import { Checker } from "../doc/validate";
import { copiesThatHold, linedHoles, mateFeatures, occupiedHoles, sortClashes, suggestMates, type Clash } from "./features";
import { componentStates, floatingGroups, motionWords, partBox, partDocument, partDocuments, partName, partSize, placed, solveAssembly, type AssemblySolve } from "./model";
import { mateGeometry, type PartTopology } from "./resolve";
import { apply, mul, placementOf, pointTo, transpose, written } from "./transform";

/** Where component b is now from a (b's place in a's frame): what a lock, or a concentric's locked rotation, keeps. */
function relativeOf(asm: Assembly, ida: string, idb: string): { at: Vec3; rotation: Vec3 } {
  const P = (id: string) => placementOf(asm.components.find((k) => k.id === id) ?? {});
  const pa = P(ida);
  const pb = P(idb);
  const Rt = transpose(pa.R);
  const w = written({ R: mul(Rt, pb.R), t: apply(Rt, [pb.t[0] - pa.t[0], pb.t[1] - pa.t[1], pb.t[2] - pa.t[2]]) });
  const r = (v: Vec3) => v.map((x) => Math.round(x * 1e6) / 1e6 + 0) as Vec3;
  return { at: r(w.at), rotation: r(w.rotation) };
}

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

export interface AssemblyEnv {
  doc: RawDocument;
  /** A part document's faces and edges, built (or why it can't be). */
  topology(part: Raw): Promise<PartTopology | string>;
  /** The example parts, by name. */
  examples: Record<string, string>;
  /** A part from a file the host can read (a .cocaide.json or a STEP file); the in-app ask can't. */
  readPart?(path: string): Promise<Raw | string>;
  /** Pairs of components that share volume; left out where the host can't check. */
  interference?(parts: Record<string, Raw>, components: { id: string; part: string; R: number[][]; t: number[] }[]): Promise<{ components: [string, string]; volume: number }[] | string>;
}

export type AssemblyOutcome = { ok: true; result: Raw; command?: Command } | { ok: false; error: string };

export const ASSEMBLY_READ_TOOLS = ["assembly", "mateFeatures", "suggestMates", "checkAssembly"] as const;
export const ASSEMBLY_WRITE_TOOLS = ["insertComponent", "setComponent", "deleteComponent", "addMate", "editMate", "deleteMate", "copyToHoles", "explodeAssembly"] as const;
export const ASSEMBLY_TOOLS = new Set<string>([...ASSEMBLY_READ_TOOLS, ...ASSEMBLY_WRITE_TOOLS]);

const r3 = (x: number) => Math.round(x * 1000) / 1000 + 0;
const fail = (error: string): AssemblyOutcome => ({ ok: false, error });

/** The assembly as written (null without one); its errors, if any. */
function current(doc: RawDocument): { asm: Assembly | null; errors: string[] } {
  if (doc.assembly === undefined) return { asm: null, errors: [] };
  const c = new Checker("document");
  return { asm: validateAssembly(doc.assembly, c), errors: c.errors };
}

/** Each part the assembly uses, built. */
async function topologies(env: AssemblyEnv, asm: Assembly, doc: RawDocument = env.doc): Promise<{ views: Map<string, PartTopology>; problems: string[] }> {
  const views = new Map<string, PartTopology>();
  const problems: string[] = [];
  for (const [key, part] of Object.entries(partDocuments(doc as Raw, asm))) {
    // A mesh part (a .glb model) has no faces to mate to: nothing to build.
    if (isMeshPart(part)) continue;
    const t = await env.topology(part);
    if (typeof t === "string") problems.push(`part "${key}" (${partName(doc as Raw, key)}) doesn't build: ${t}`);
    else views.set(key, t);
  }
  return { views, problems };
}

/** The mates' state in words, for a reply. */
function mateReport(s: AssemblySolve) {
  return s.mates.map((m) => ({ id: m.id, holds: m.ok, ...(m.ok ? {} : { off: Number.isFinite(m.error) ? r3(m.error) : null }), ...(m.problem ? { problem: m.problem } : {}) }));
}

/** The assembly at a glance: components (part, place, size where they sit), parts, mates and whether they hold. */
async function summary(env: AssemblyEnv, asm: Assembly): Promise<Raw> {
  const { views, problems } = await topologies(env, asm);
  const s = asm.mates?.length ? solveAssembly(asm, views) : null;
  const doc = env.doc as Raw;
  return {
    components: asm.components.map((k) => {
      const v = views.get(k.part);
      const P = placementOf(k);
      // Where it sits: its part's box (from its edges), turned and moved, in the assembly.
      let box: { min: Vec3; max: Vec3 } | null = null;
      const pb = v ? partBox(v) : null;
      if (pb) {
        const pts: Vec3[] = [];
        for (let i = 0; i < 8; i++) pts.push(pointTo(P, [i & 1 ? pb.max[0] : pb.min[0], i & 2 ? pb.max[1] : pb.min[1], i & 4 ? pb.max[2] : pb.min[2]]));
        box = { min: [0, 1, 2].map((i) => r3(Math.min(...pts.map((p) => p[i])))) as Vec3, max: [0, 1, 2].map((i) => r3(Math.max(...pts.map((p) => p[i])))) as Vec3 };
      }
      return { id: k.id, part: k.part, partName: partName(doc, k.part), at: k.at ?? [0, 0, 0], rotation: k.rotation ?? [0, 0, 0], ...(k.fixed ? { fixed: true } : {}), ...(k.hidden ? { hidden: true } : {}), ...(box ? { roughly: box } : {}) };
    }),
    parts: [{ key: SELF, name: partName(doc, SELF) }, ...Object.keys(asm.parts ?? {}).map((key) => ({ key, name: partName(doc, key) }))],
    mates: (asm.mates ?? []).map((m) => ({ ...m, ...(s ? { holds: s.mates.find((x) => x.id === m.id)?.ok ?? false } : {}) })),
    ...(s ? { solved: s.solved } : {}),
    ...(problems.length ? { problems } : {}),
  };
}

/** The assembly with an edit, solved, as the one command; refused when the mates then don't hold (`strict`). */
async function commit(env: AssemblyEnv, next: Assembly, label: string, opts: { strict?: string[]; extra?: Raw } = {}): Promise<AssemblyOutcome> {
  const doc = { ...env.doc, assembly: next } as RawDocument;
  const { views, problems } = await topologies(env, next, doc);
  let out = next;
  let report: Raw = {};
  if (next.mates?.length) {
    const s = solveAssembly(next, views);
    const failing = s.mates.filter((m) => !m.ok && (!opts.strict || opts.strict.includes(m.id)));
    if (opts.strict && failing.length) {
      // What it fights: the other mates on its components (they held before it came).
      const fights = (id: string) => {
        const m = next.mates?.find((x) => x.id === id);
        if (!m) return "";
        const others = (next.mates ?? []).filter((x) => x.id !== id && !x.suppressed && [x.a.component, x.b.component].some((c) => c === m.a.component || c === m.b.component));
        return others.length ? `; it fights ${others.map((x) => `${x.id} (${x.type} ${x.a.component} ↔ ${x.b.component})`).join(", ")}: change or suppress one of them` : "";
      };
      return fail(
        `${failing.map((m) => `${m.id} ${m.problem ?? `doesn't hold (${Number.isFinite(m.error) ? `${r3(m.error)} off` : "can't"})${fights(m.id)}`}`).join("; ")}: nothing changed. Check the faces or edges with mateFeatures (a mate's two things must suit its type).`,
      );
    }
    out = placed(next, new Map([...s.placements].filter(([id]) => !next.components.find((k) => k.id === id)?.fixed)));
    report = { mates: mateReport(s), solved: s.solved };
  }
  return {
    ok: true,
    command: { type: "setAssembly", assembly: out as unknown as Raw, label },
    result: { ...opts.extra, components: out.components.map((k) => ({ id: k.id, at: k.at ?? [0, 0, 0], rotation: k.rotation ?? [0, 0, 0], ...(k.fixed ? { fixed: true } : {}) })), ...report, ...(problems.length ? { problems } : {}) },
  };
}

/** A mate reference as the AI writes it: { component, face | edge | datum }. */
function mateRef(v: unknown, path: string): MateRef | string {
  if (!isObject(v) || typeof v.component !== "string") return `${path} must be { "component": "<id>", "face": <face selector> | "edge": <edge selector> | "datum": "Top" | "Front" | "Right" | "X" | "Y" | "Z" | "Origin" } (take faces from mateFeatures)`;
  return v as unknown as MateRef;
}

export async function runAssemblyTool(name: string, input: unknown, env: AssemblyEnv): Promise<AssemblyOutcome> {
  const a = isObject(input) ? input : {};
  const { asm, errors } = current(env.doc);
  if (errors.length && name !== "assembly") return fail(`the assembly has errors: ${errors.join("; ")}`);
  const base: Assembly = asm ?? { components: [] };
  // A component by its id, or by its name as the user says it ("cylinder head-1" for cylinder_head-1): spaces and
  // case don't matter when only one component matches that way.
  const squash = (id: string) => id.trim().replace(/\s+/g, "_").toLowerCase();
  const known = (id: unknown): string | undefined => {
    if (typeof id !== "string") return undefined;
    if (base.components.some((x) => x.id === id)) return id;
    const like = base.components.filter((x) => squash(x.id) === squash(id));
    return like.length === 1 ? like[0].id : undefined;
  };
  const need = (id: unknown): AssemblyComponent | string => {
    const k = base.components.find((x) => x.id === known(id));
    return k ?? `no component "${String(id)}" (components: ${base.components.map((x) => x.id).join(", ") || "none: insertComponent first"})`;
  };
  switch (name) {
    case "assembly":
      if (!asm) return { ok: true, result: { components: [], note: "no assembly yet: insertComponent puts parts in (the first is fixed at the origin)", ...(errors.length ? { errors } : {}) } };
      return { ok: true, result: { ...(await summary(env, asm)), ...(errors.length ? { errors } : {}) } };

    case "insertComponent": {
      // What part: this document's own, one the assembly carries already, an example, or a file (a part or a STEP file).
      let key: string | undefined;
      let carried: Raw | undefined;
      const part = a.part;
      if (part === undefined || part === SELF) key = SELF;
      else if (typeof part === "string" && base.parts && part in base.parts) key = part;
      else if (isObject(part) && typeof part.example === "string") {
        const text = env.examples[part.example];
        if (!text) return fail(`no example "${part.example}" (examples: ${Object.keys(env.examples).join(", ")})`);
        carried = JSON.parse(text) as Raw;
      } else if (isObject(part) && typeof part.file === "string") {
        if (!env.readPart) return fail("this host can't read files: insert this part (\"self\"), an example, or a part the assembly carries already");
        const read = await env.readPart(part.file);
        if (typeof read === "string") return fail(read);
        carried = read;
      } else return fail(`part must be "self" (this document's part), a part key the assembly carries (${Object.keys(base.parts ?? {}).join(", ") || "none"}), { "example": "<name>" } or { "file": "<path to a .cocaide.json or .step>" } (got ${JSON.stringify(part)})`);
      let parts = base.parts ?? {};
      if (carried) {
        const { assembly: _a, drawing: _d, ...clean } = carried;
        void _a;
        void _d;
        if (!Array.isArray(clean.features)) return fail("that isn't a part document: it has no features");
        // The same part again is the same key.
        key = Object.entries(parts).find(([, d]) => geometryKey(d) === geometryKey(clean))?.[0];
        if (!key) {
          const stem = (typeof clean.name === "string" ? clean.name : "part").replace(/[^\w-]+/g, "_") || "part";
          key = stem;
          for (let i = 2; key === SELF || key in parts; i++) key = `${stem}_${i}`;
          parts = { ...parts, [key]: clean };
        }
      }
      const name0 = typeof a.id === "string" && a.id ? a.id : nextComponentId(base, partName({ ...env.doc, assembly: { ...base, parts } } as Raw, key!));
      if (base.components.some((k) => k.id === name0)) return fail(`a component "${name0}" exists already`);
      const first = base.components.length === 0;
      const vec = (k: string): Vec3 | undefined => (Array.isArray(a[k]) && (a[k] as unknown[]).length === 3 && (a[k] as unknown[]).every((x) => typeof x === "number") ? (a[k] as Vec3) : undefined);
      const k: AssemblyComponent = { id: name0, part: key! };
      if (vec("at")) k.at = vec("at");
      if (vec("rotation")) k.rotation = vec("rotation");
      if (a.fixed === true || (first && a.fixed !== false)) k.fixed = true;
      const next: Assembly = { ...base, ...(Object.keys(parts).length ? { parts } : {}), components: [...base.components, k] };
      return commit(env, next, `Insert ${name0}`, { extra: { inserted: name0, part: key, ...(k.fixed ? { note: first ? "the first component is fixed at the origin: mate the others to it" : "fixed" } : {}) } });
    }

    case "setComponent": {
      const k = need(a.id);
      if (typeof k === "string") return fail(k);
      if (!isObject(a.patch)) return fail('patch must be an object: { "at"?: [x, y, z], "rotation"?: [rx, ry, rz] degrees, "fixed"?: true | false, "hidden"?: true | false, "transparent"?: true | false, "appearance"?: { "color": "#rrggbb", "opacity"?, "finish"? } | null }');
      const extra = Object.keys(a.patch).filter((x) => !["at", "rotation", "fixed", "hidden", "transparent", "appearance"].includes(x));
      if (extra.length) return fail(`patch takes at, rotation, fixed, hidden, transparent, appearance (got ${extra.join(", ")})`);
      const nk = { ...k, ...(a.patch as Partial<AssemblyComponent>) } as AssemblyComponent;
      for (const key of ["fixed", "hidden", "transparent"] as const) if (!nk[key]) delete nk[key];
      for (const key of ["at", "rotation", "appearance"] as const) if (nk[key] === null) delete nk[key];
      return commit(env, { ...base, components: base.components.map((x) => (x.id === k.id ? nk : x)) }, `Edit ${k.id}`);
    }

    case "deleteComponent": {
      const k = need(a.id);
      if (typeof k === "string") return fail(k);
      const left = base.components.filter((x) => x.id !== k.id);
      const mates = (base.mates ?? []).filter((m) => m.a.component !== k.id && m.b.component !== k.id);
      const used = new Set(left.map((x) => x.part));
      const parts = Object.fromEntries(Object.entries(base.parts ?? {}).filter(([key]) => used.has(key)));
      if (!left.length) return { ok: true, command: { type: "setAssembly", assembly: null, label: `Delete ${k.id}` }, result: { deleted: k.id, note: "the assembly is empty now, so it is gone" } };
      const explode = explodeWithout(base.explode, k.id);
      return commit(env, { components: left, ...(mates.length ? { mates } : {}), ...(Object.keys(parts).length ? { parts } : {}), ...(explode.length ? { explode } : {}) }, `Delete ${k.id}`, { extra: { deleted: k.id, matesRemoved: (base.mates ?? []).length - mates.length } });
    }

    case "addMate": {
      if (!MATE_TYPES.includes(a.type as never)) return fail(`type must be ${MATE_TYPES.map((t) => `"${t}"`).join(", ")} (got ${JSON.stringify(a.type)})`);
      const ra = mateRef(a.a, "a");
      const rb = mateRef(a.b, "b");
      if (typeof ra === "string") return fail(ra);
      if (typeof rb === "string") return fail(rb);
      for (const r of [ra, rb]) r.component = known(r.component) ?? r.component;
      const id = typeof a.id === "string" && a.id ? a.id : nextMateId(base, String(a.type));
      if ((base.mates ?? []).some((m) => m.id === id)) return fail(`a mate "${id}" exists already`);
      const m = { id, type: a.type, a: ra, b: rb, ...(Array.isArray(a.about) ? { about: a.about } : {}), ...(a.value !== undefined ? { value: a.value } : {}), ...(a.aligned === true ? { aligned: true } : {}), ...(a.opposed === true ? { opposed: true } : {}), ...(a.flip === true ? { flip: true } : {}), ...(typeof a.min === "number" ? { min: a.min } : {}), ...(typeof a.max === "number" ? { max: a.max } : {}), ...(a.lockRotation === true ? { lockRotation: true } : {}) } as Mate;
      // A lock, or a concentric mate's locked rotation: kept as the parts are now.
      if (m.type === "lock" || m.lockRotation) m.relative = relativeOf(base, ra.component, rb.component);
      // An angle is signed unless told not to ("signed": false): measured about the direction square to both as they
      // are now (in a's frame), from a's to b's.
      if (m.type === "angle" && !m.about && a.signed !== false) {
        const { views } = await topologies(env, base);
        const ka = base.components.find((k) => k.id === ra.component);
        const kb = base.components.find((k) => k.id === rb.component);
        const ga = ka ? mateGeometry(ra, views.get(ka.part)) : "";
        const gb = kb ? mateGeometry(rb, views.get(kb.part)) : "";
        const dirOf = (g: typeof ga) => (typeof g === "string" ? null : g.kind === "plane" ? g.n : g.kind === "axis" ? g.d : null);
        const da = dirOf(ga);
        const db = dirOf(gb);
        if (ka && kb && da && db) {
          const Ra = placementOf(ka).R;
          const u = apply(Ra, da);
          const v = apply(placementOf(kb).R, db);
          const w: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
          const lw = Math.hypot(...w);
          if (lw > 1e-6) m.about = apply(transpose(Ra), [w[0] / lw, w[1] / lw, w[2] / lw]).map((x) => Math.round(x * 1e6) / 1e6 + 0) as Vec3;
        }
      }
      const next = { ...base, mates: [...(base.mates ?? []), m] };
      const c = new Checker("document");
      validateAssembly(next, c);
      if (c.errors.length) return fail(c.errors.join("; "));
      // A lock keeps where the parts are now: say so (and that a part not mated into place yet is locked where it lies).
      const loose = m.type === "lock" || m.lockRotation ? [m.a.component, m.b.component].filter((c) => !base.components.find((k) => k.id === c)?.fixed && !(base.mates ?? []).some((x) => !x.suppressed && (x.a.component === c || x.b.component === c))) : [];
      const note = m.type === "lock" || m.lockRotation ? { note: `locked as they are now (${m.b.component} at ${JSON.stringify(m.relative?.at)}, turned ${JSON.stringify(m.relative?.rotation)} from ${m.a.component})${loose.length ? `; ${loose.join(" and ")} had no other mates, so ${loose.length === 1 ? "it was" : "they were"} locked wherever ${loose.length === 1 ? "it was" : "they were"}: place ${loose.length === 1 ? "it" : "them"} first and lock again if that is wrong` : ""}` } : {};
      return commit(env, next, `Mate ${id}`, { strict: [id], extra: { mate: id, ...note } });
    }

    case "editMate": {
      const m = (base.mates ?? []).find((x) => x.id === a.id);
      if (!m) return fail(`no mate "${String(a.id)}" (mates: ${(base.mates ?? []).map((x) => x.id).join(", ") || "none"})`);
      if (!isObject(a.patch)) return fail('patch must be an object: { "type"?, "value"?, "aligned"?, "opposed"?, "flip"?, "min"?, "max"?, "lockRotation"?, "suppressed"?, "a"?, "b"? }');
      const nm = { ...m, ...(a.patch as Partial<Mate>) } as Mate;
      for (const side of ["a", "b"] as const) if (isObject(nm[side]) && typeof nm[side].component === "string") nm[side] = { ...nm[side], component: known(nm[side].component) ?? nm[side].component };
      for (const key of ["aligned", "opposed", "flip", "suppressed", "lockRotation"] as const) if (!nm[key]) delete nm[key];
      for (const key of ["min", "max"] as const) if (nm[key] === null || nm[key] === undefined) delete nm[key];
      // Locking (or locking a concentric's rotation) keeps the parts as they are now; unlocking drops it.
      if ((nm.type === "lock" || nm.lockRotation) && (!nm.relative || (a.patch as Record<string, unknown>).lockRotation === true)) nm.relative = relativeOf(base, nm.a.component, nm.b.component);
      if (nm.type !== "lock" && !nm.lockRotation) delete nm.relative;
      if (nm.value === null) delete nm.value;
      const next = { ...base, mates: (base.mates ?? []).map((x) => (x.id === m.id ? nm : x)) };
      const c = new Checker("document");
      validateAssembly(next, c);
      if (c.errors.length) return fail(c.errors.join("; "));
      return commit(env, next, `Edit ${m.id}`, nm.suppressed ? {} : { strict: [m.id] });
    }

    case "deleteMate": {
      if (!(base.mates ?? []).some((x) => x.id === a.id)) return fail(`no mate "${String(a.id)}"`);
      const mates = (base.mates ?? []).filter((x) => x.id !== a.id);
      const next: Assembly = { ...base, mates };
      if (!mates.length) delete next.mates;
      return commit(env, next, `Delete ${String(a.id)}`, { extra: { deleted: a.id } });
    }

    case "copyToHoles": {
      const k = need(a.id);
      if (typeof k === "string") return fail(k);
      const { views } = await topologies(env, base);
      const partOf = (id: string) => {
        const c = base.components.find((x) => x.id === id);
        return c ? views.get(c.part) : undefined;
      };
      const plan = copiesThatHold(base, k.id, partOf, views);
      if (typeof plan === "string") return fail(plan);
      return commit(env, plan.next, `Copy ${k.id} to ${plan.copies.length} hole${plan.copies.length === 1 ? "" : "s"}`, { extra: { copies: plan.copies, ...(plan.skipped ? { skipped: `${plan.skipped} hole(s) where the copy's mates didn't hold` } : {}) } });
    }

    case "explodeAssembly": {
      // Steps given, or worked out from the mates (each part off the one it is mated to, `scale` times as far); none: collapsed.
      let steps: ExplodeStep[];
      if (Array.isArray(a.steps)) steps = a.steps as ExplodeStep[];
      else if (a.collapse === true) steps = [];
      else {
        const { views } = await topologies(env, base);
        steps = autoExplode(base, (id) => views.get(base.components.find((x) => x.id === id)?.part ?? ""), typeof a.scale === "number" ? a.scale : 1);
        if (!steps.length) return fail("nothing to explode: mate the components first (each moves off the part it is mated to)");
      }
      const next: Assembly = { ...base };
      if (steps.length) next.explode = steps;
      else delete next.explode;
      return commit(env, next, steps.length ? "Explode" : "Collapse", { extra: { explode: steps, note: steps.length ? 'a drawing view shows it with { "look": "iso", "source": "assembly", "exploded": true }' : "collapsed" } });
    }

    case "mateFeatures": {
      const k = need(a.component);
      if (typeof k === "string") return fail(k);
      const part = partDocument(env.doc as Raw, k.part);
      if (!part) return fail(`${k.id}'s part "${k.part}" isn't in the document`);
      const t = await env.topology(part);
      if (typeof t === "string") return fail(`${k.id}'s part doesn't build: ${t}`);
      const kinds = typeof a.kind === "string" ? a.kind : "all";
      const list = mateFeatures(k, t, typeof a.limit === "number" ? a.limit : 16).filter((f) => kinds === "all" || (kinds === "planes" ? f.kind === "plane" : f.kind !== "plane"));
      return { ok: true, result: { component: k.id, note: "in the assembly's coordinates, as the component sits now; pass a feature's ref as a mate's a or b", features: list } };
    }

    case "suggestMates": {
      const ka = need(a.a);
      const kb = need(a.b);
      if (typeof ka === "string") return fail(ka);
      if (typeof kb === "string") return fail(kb);
      const ta = await env.topology(partDocument(env.doc as Raw, ka.part) ?? {});
      const tb = await env.topology(partDocument(env.doc as Raw, kb.part) ?? {});
      if (typeof ta === "string" || typeof tb === "string") return fail(`a part doesn't build: ${typeof ta === "string" ? ta : tb}`);
      // A hole with a pin in it (a concentric mate holds a boss in it) isn't offered again.
      const tops = new Map<string, PartTopology>();
      for (const k of base.components) {
        if (tops.has(k.id)) continue;
        const t = await env.topology(partDocument(env.doc as Raw, k.part) ?? {});
        if (typeof t !== "string") tops.set(k.id, t);
      }
      const taken = occupiedHoles(base, (id) => tops.get(id));
      const lined = linedHoles(base, ka.id, kb.id);
      const s = suggestMates(ka, ta, kb, tb, { taken, lined });
      return { ok: true, result: { suggestions: s, note: s.length ? "best first; add each of a suggestion's mates with addMate (check the result: a coincident may want aligned)" : "nothing obvious: pick faces with mateFeatures" } };
    }

    case "checkAssembly": {
      if (!asm) return fail("there is no assembly to check");
      const { views, problems } = await topologies(env, asm);
      const s = solveAssembly(asm, views);
      const states = componentStates(asm, s, new Map([...views].map(([key, t]) => [key, partSize(t)])));
      const issues: string[] = [...problems];
      for (const g of floatingGroups(asm)) issues.push(`${g.join(", ")} are mated to each other but to nothing fixed: they float together (mate one of them to the rest, or fix one)`);
      for (const m of s.mates) if (!m.ok) issues.push(`mate ${m.id} ${m.problem ?? `doesn't hold (${Number.isFinite(m.error) ? `${r3(m.error)} off` : "can't"})`}`);
      for (const st of states) {
        if (st.fixed) continue;
        if (st.motions.length === 6) issues.push(`${st.id} is held by nothing: mate it, or fix it`);
      }
      let clashes: Clash[] | string | undefined;
      if (env.interference && asm.components.length > 1) {
        const docs = partDocuments(env.doc as Raw, asm);
        const raw = await env.interference(docs, asm.components.map((k) => ({ id: k.id, part: k.part, ...placementOf(k) })));
        clashes = Array.isArray(raw)
          ? sortClashes(asm, raw, (id) => {
              const c = asm.components.find((x) => x.id === id);
              return c ? views.get(c.part) : undefined;
            })
          : raw;
        if (Array.isArray(clashes)) for (const c of clashes) if (!c.expected) issues.push(`${c.components[0]} and ${c.components[1]} overlap by ${r3(c.volume)} mm³`);
      }
      return {
        ok: true,
        result: {
          ok: issues.length === 0,
          issues,
          mates: mateReport(s),
          freedom: states.map((st) => ({ id: st.id, ...(st.fixed ? { fixed: true } : {}), free: st.motions.length, ...(st.motions.length && st.motions.length < 6 ? { canStill: st.motions.map(motionWords) } : {}) })),
          ...(typeof clashes === "string" ? { interference: `not checked: ${clashes}` } : clashes ? { interference: clashes } : { interference: "not checked here" }),
          note: "a component that can still slide or turn is fine when it should (a hinge, a slider); otherwise add a mate that stops it",
        },
      };
    }
  }
  return fail(`unknown assembly tool "${name}"`);
}
