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
  // A group mated together but to nothing fixed keeps its first component where it is, so the rest come to it (none tilts the pair).
  if (!fixed.size && asm.components.length) fixed.add(asm.components[0].id);
  for (const g of floatingGroups(asm)) fixed.add(g[0]);
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

/** Each component's freedom, on the solved assembly: what a check reports as under-constrained. `sizes`: each part's size (mm), so turns and slides weigh alike. */
export function componentStates(asm: Assembly, solve: AssemblySolve, sizes: Map<string, number> = new Map()): ComponentState[] {
  const held = new Set(asm.components.filter((k) => k.fixed).map((k) => k.id));
  if (!held.size && asm.components.length) held.add(asm.components[0].id);
  return asm.components.map((k) => ({ id: k.id, fixed: held.has(k.id), motions: held.has(k.id) ? [] : freeMotions(solve.placements, solve.held, k.id, sizes.get(k.part) ?? 100) }));
}

/** A part's box in its own frame, from its edges (a round edge by its rim, not its centre); null for a part with none. */
export function partBox(part: PartTopology): { min: Vec3; max: Vec3 } | null {
  const pts: Vec3[] = [];
  for (const e of part.edges) {
    pts.push(e.start, e.end, e.mid);
    if (e.kind === "circle" && e.center && e.axis && e.radius) {
      // Two directions square to the axis, and the rim at eight points round it.
      const a = e.axis;
      const u = Math.abs(a[0]) < 0.9 ? [0, -a[2], a[1]] : [-a[2], 0, a[0]];
      const lu = Math.hypot(u[0], u[1], u[2]);
      const U = [u[0] / lu, u[1] / lu, u[2] / lu];
      const V = [a[1] * U[2] - a[2] * U[1], a[2] * U[0] - a[0] * U[2], a[0] * U[1] - a[1] * U[0]];
      for (let i = 0; i < 8; i++) {
        const t = (i * Math.PI) / 4;
        pts.push([0, 1, 2].map((j) => e.center![j] + e.radius! * (Math.cos(t) * U[j] + Math.sin(t) * V[j])) as Vec3);
      }
    }
  }
  if (!pts.length) for (const f of part.faces) pts.push(f.centroid);
  if (!pts.length) return null;
  return { min: [0, 1, 2].map((i) => Math.min(...pts.map((p) => p[i]))) as Vec3, max: [0, 1, 2].map((i) => Math.max(...pts.map((p) => p[i]))) as Vec3 };
}

/** A part's size: its box's diagonal (100 when it has none). */
export function partSize(part: PartTopology | undefined): number {
  const b = part ? partBox(part) : null;
  return b ? Math.max(1, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2])) : 100;
}

/** Components mated to each other but, through their mates, to nothing fixed: each group floats together. */
export function floatingGroups(asm: Assembly): string[][] {
  const held = new Set(asm.components.filter((k) => k.fixed).map((k) => k.id));
  if (!held.size && asm.components.length) held.add(asm.components[0].id);
  const links = new Map<string, Set<string>>(asm.components.map((k) => [k.id, new Set()]));
  for (const m of asm.mates ?? []) {
    if (m.suppressed) continue;
    links.get(m.a.component)?.add(m.b.component);
    links.get(m.b.component)?.add(m.a.component);
  }
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const k of asm.components) {
    if (seen.has(k.id)) continue;
    const group: string[] = [];
    const stack = [k.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      group.push(id);
      for (const n of links.get(id) ?? []) stack.push(n);
    }
    if (group.length > 1 && !group.some((id) => held.has(id))) groups.push(group);
  }
  return groups;
}

/** A motion in words, after "can still": "slide along [1, 0, 0]", "turn about an axis along [0, 0, 1] through [30, 0, 0]". */
export function motionWords(m: FreeMotion): string {
  // Directions to the thousandth, points to the hundredth of a mm: enough to read, no noise.
  const r = (v: number[], d: number) => `[${v.map((x) => Math.round(x * d) / d + 0).join(", ")}]`;
  return m.kind === "slide" ? `slide along ${r(m.along, 1000)}` : `turn about an axis along ${r(m.axis, 1000)} through ${r(m.through, 100)}`;
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
