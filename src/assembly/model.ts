// The assembly as the app works with it: which part document each
// component is, the mates' geometry found on the parts, the solve, and the
// assembly with its components where the solve puts them. Pure.

import { SELF } from "../doc/assembly";
import type { Assembly, AssemblyComponent, Mate, Vec3 } from "../doc/types";
import { mateGeometry, type PartTopology } from "./resolve";
import { freeMotions, solveMates, type FreeMotion, type MateStatus, type SolverMate } from "./solve";
import { placementOf, written, type Placement } from "./transform";

/** The part document a component uses: this document's own part (without its drawing and assembly), or one the assembly carries. */
export function partDocument(doc: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  if (key === SELF) {
    const { assembly: _a, drawing: _d, ...part } = doc;
    void _a;
    void _d;
    return part;
  }
  const parts = (doc.assembly as Assembly | undefined)?.parts;
  return parts?.[key] as Record<string, unknown> | undefined;
}

/** Each part key the assembly uses and its document. */
export function partDocuments(doc: Record<string, unknown>, asm: Assembly): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const k of asm.components) {
    if (out[k.part]) continue;
    const d = partDocument(doc, k.part);
    if (d) out[k.part] = d;
  }
  return out;
}

/** What a part is called: its document's name. */
export function partName(doc: Record<string, unknown>, key: string): string {
  const d = partDocument(doc, key);
  return typeof d?.name === "string" ? d.name : key;
}

export interface AssemblySolve {
  placements: Map<string, Placement>;
  mates: MateStatus[];
  solved: boolean;
  /** The mates as the solver held them (those whose geometry was found, not suppressed). */
  held: SolverMate[];
}

/** The assembly solved on its parts as built (`views` by part key). */
export function solveAssembly(asm: Assembly, views: Map<string, PartTopology>): AssemblySolve {
  const placements = new Map(asm.components.map((k) => [k.id, placementOf(k)]));
  const fixed = new Set(asm.components.filter((k) => k.fixed).map((k) => k.id));
  const byId = new Map(asm.components.map((k) => [k.id, k]));
  const solverMates: SolverMate[] = [];
  const problems: MateStatus[] = [];
  for (const m of asm.mates ?? []) {
    if (m.suppressed) continue;
    const ga = mateGeometry(m.a, views.get(byId.get(m.a.component)?.part ?? ""));
    const gb = mateGeometry(m.b, views.get(byId.get(m.b.component)?.part ?? ""));
    if (typeof ga === "string" || typeof gb === "string") {
      problems.push({ id: m.id, error: Infinity, ok: false, problem: typeof ga === "string" ? ga : (gb as string) });
      continue;
    }
    solverMates.push({ id: m.id, type: m.type, a: { component: m.a.component, geom: ga }, b: { component: m.b.component, geom: gb }, ...(m.value !== undefined ? { value: m.value } : {}), ...(m.aligned ? { aligned: true } : {}) });
  }
  const r = solveMates(placements, fixed, solverMates);
  const order = new Map((asm.mates ?? []).map((m, i) => [m.id, i]));
  const mates = [...r.mates, ...problems].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { placements: r.placements, mates, solved: mates.every((m) => m.ok), held: solverMates };
}

export interface ComponentState {
  id: string;
  fixed: boolean;
  /** What it can still do with its mates holding (none: fully placed). */
  motions: FreeMotion[];
}

/** Each component's freedom, on the solved assembly: what a check reports as under-constrained. */
export function componentStates(asm: Assembly, solve: AssemblySolve): ComponentState[] {
  const held = new Set(asm.components.filter((k) => k.fixed).map((k) => k.id));
  if (!held.size && asm.components.length) held.add(asm.components[0].id);
  return asm.components.map((k) => ({ id: k.id, fixed: held.has(k.id), motions: held.has(k.id) ? [] : freeMotions(solve.placements, solve.held, k.id) }));
}

/** A motion in words, after "can still": "slide along [1, 0, 0]", "turn about an axis along [0, 0, 1] through [30, 0, 0]". */
export function motionWords(m: FreeMotion): string {
  return m.kind === "slide" ? `slide along [${m.along.join(", ")}]` : `turn about an axis along [${m.axis.join(", ")}] through [${m.through.join(", ")}]`;
}

/** The assembly with each component where `placements` puts it (written to the micron and the millionth of a degree). */
export function placed(asm: Assembly, placements: Map<string, Placement>): Assembly {
  return {
    ...asm,
    components: asm.components.map((k) => {
      const p = placements.get(k.id);
      if (!p) return k;
      const w = written(p);
      const next: AssemblyComponent = { ...k };
      delete next.at;
      delete next.rotation;
      if (w.at.some((x) => x !== 0)) next.at = w.at;
      if (w.rotation.some((x) => x !== 0)) next.rotation = w.rotation;
      return next;
    }),
  };
}

/** Whether two assemblies place their components the same, to a micron (a solve that moved nothing). */
export function samePlaces(a: Assembly, b: Assembly): boolean {
  const close = (x?: Vec3, y?: Vec3) => [0, 1, 2].every((i) => Math.abs((x?.[i] ?? 0) - (y?.[i] ?? 0)) < 1e-6);
  return a.components.every((k, i) => close(k.at, b.components[i]?.at) && close(k.rotation, b.components[i]?.rotation));
}

/**
 * Whether a mate's two faces or planes face the same way now (normals
 * within 90°): a new coincident or distance mate keeps them so ("aligned"),
 * else they are mated face to face.
 */
export function facesAlign(n1: Vec3 | undefined, n2: Vec3 | undefined): boolean {
  if (!n1 || !n2) return false;
  return n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] > 0;
}

export type { Mate };
