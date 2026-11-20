// The AI's assembly tools, one implementation for every host (the bridge's
// agent session, the in-app ask): each reads the document and the parts'
// topology (the host builds them) and answers, or gives the one command
// that makes the change (setAssembly: the assembly with the mates solved).
// What the user can do in the Assembly tab, the AI can do here, and check.

import { nextComponentId, nextMateId, SELF, validateAssembly } from "../doc/assembly";
import type { Command, RawDocument } from "../doc/commands";
import { geometryKey } from "../doc/drawing";
import type { Assembly, AssemblyComponent, Mate, MateRef, Vec3 } from "../doc/types";
import { MATE_TYPES } from "../doc/types";
import { Checker } from "../doc/validate";
import { mateFeatures, suggestMates } from "./features";
import { componentStates, motionWords, partDocument, partDocuments, partName, placed, solveAssembly, type AssemblySolve } from "./model";
import type { PartTopology } from "./resolve";
import { placementOf, pointTo } from "./transform";

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
export const ASSEMBLY_WRITE_TOOLS = ["insertComponent", "setComponent", "deleteComponent", "addMate", "editMate", "deleteMate"] as const;
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
      // Where it sits: the box round its faces' centres, in the assembly.
      let box: { min: Vec3; max: Vec3 } | null = null;
      if (v?.faces.length) {
        const pts = v.faces.map((f) => pointTo(P, f.centroid));
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
      return fail(
        `${failing.map((m) => `${m.id} ${m.problem ?? `doesn't hold (${Number.isFinite(m.error) ? `${r3(m.error)} off` : "can't"})`}`).join("; ")}: nothing changed. Check the faces or edges with mateFeatures (a mate's two things must suit its type), and that it doesn't fight the component's other mates (checkAssembly lists them).`,
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
  const need = (id: unknown): AssemblyComponent | string => {
    const k = base.components.find((x) => x.id === id);
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
      if (!isObject(a.patch)) return fail('patch must be an object: { "at"?: [x, y, z], "rotation"?: [rx, ry, rz] degrees, "fixed"?: true | false, "hidden"?: true | false }');
      const extra = Object.keys(a.patch).filter((x) => !["at", "rotation", "fixed", "hidden"].includes(x));
      if (extra.length) return fail(`patch takes at, rotation, fixed, hidden (got ${extra.join(", ")})`);
      const nk = { ...k, ...(a.patch as Partial<AssemblyComponent>) } as AssemblyComponent;
      for (const key of ["fixed", "hidden"] as const) if (!nk[key]) delete nk[key];
      for (const key of ["at", "rotation"] as const) if (nk[key] === null) delete nk[key];
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
      return commit(env, { components: left, ...(mates.length ? { mates } : {}), ...(Object.keys(parts).length ? { parts } : {}) }, `Delete ${k.id}`, { extra: { deleted: k.id, matesRemoved: (base.mates ?? []).length - mates.length } });
    }

    case "addMate": {
      if (!MATE_TYPES.includes(a.type as never)) return fail(`type must be ${MATE_TYPES.map((t) => `"${t}"`).join(", ")} (got ${JSON.stringify(a.type)})`);
      const ra = mateRef(a.a, "a");
      const rb = mateRef(a.b, "b");
      if (typeof ra === "string") return fail(ra);
      if (typeof rb === "string") return fail(rb);
      const id = typeof a.id === "string" && a.id ? a.id : nextMateId(base, String(a.type));
      if ((base.mates ?? []).some((m) => m.id === id)) return fail(`a mate "${id}" exists already`);
      const m = { id, type: a.type, a: ra, b: rb, ...(a.value !== undefined ? { value: a.value } : {}), ...(a.aligned === true ? { aligned: true } : {}) } as Mate;
      const next = { ...base, mates: [...(base.mates ?? []), m] };
      const c = new Checker("document");
      validateAssembly(next, c);
      if (c.errors.length) return fail(c.errors.join("; "));
      return commit(env, next, `Mate ${id}`, { strict: [id], extra: { mate: id } });
    }

    case "editMate": {
      const m = (base.mates ?? []).find((x) => x.id === a.id);
      if (!m) return fail(`no mate "${String(a.id)}" (mates: ${(base.mates ?? []).map((x) => x.id).join(", ") || "none"})`);
      if (!isObject(a.patch)) return fail('patch must be an object: { "type"?, "value"?, "aligned"?, "suppressed"?, "a"?, "b"? }');
      const nm = { ...m, ...(a.patch as Partial<Mate>) } as Mate;
      for (const key of ["aligned", "suppressed"] as const) if (!nm[key]) delete nm[key];
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
      // A hole with a pin in it (a concentric mate holds it) isn't offered again.
      const taken = (base.mates ?? []).filter((m) => m.type === "concentric" && !m.suppressed).flatMap((m) => [m.a, m.b]);
      const s = suggestMates(ka, ta, kb, tb, { taken });
      return { ok: true, result: { suggestions: s, note: s.length ? "best first; add each of a suggestion's mates with addMate (check the result: a coincident may want aligned)" : "nothing obvious: pick faces with mateFeatures" } };
    }

    case "checkAssembly": {
      if (!asm) return fail("there is no assembly to check");
      const { views, problems } = await topologies(env, asm);
      const s = solveAssembly(asm, views);
      const states = componentStates(asm, s);
      const issues: string[] = [...problems];
      for (const m of s.mates) if (!m.ok) issues.push(`mate ${m.id} ${m.problem ?? `doesn't hold (${Number.isFinite(m.error) ? `${r3(m.error)} off` : "can't"})`}`);
      for (const st of states) {
        if (st.fixed) continue;
        if (st.motions.length === 6) issues.push(`${st.id} is held by nothing: mate it, or fix it`);
      }
      let clashes: { components: [string, string]; volume: number }[] | string | undefined;
      if (env.interference && asm.components.length > 1) {
        const docs = partDocuments(env.doc as Raw, asm);
        clashes = await env.interference(docs, asm.components.map((k) => ({ id: k.id, part: k.part, ...placementOf(k) })));
        if (Array.isArray(clashes)) for (const c of clashes) issues.push(`${c.components[0]} and ${c.components[1]} overlap by ${r3(c.volume)} mm³`);
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
