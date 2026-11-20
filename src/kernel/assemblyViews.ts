// A drawing's views, each from what it shows: the part, or the document's
// assembly (each component a body named by its id, placed; exploded: moved
// by its explode steps). What the BOM needs of each part comes back too: its
// mass and material. The kernel's projector does the rest, as for a part of
// many bodies.

import { explodeOffsets } from "../doc/assembly";
import { partDocuments } from "../assembly/model";
import { placementOf } from "../assembly/transform";
import type { Assembly } from "../doc/types";
import { withAssemblyShapes, type PlacedComponent } from "./assembly";
import { projectDrawingViews, type BuiltPart, type KeyCache, type ProjectedView, type ViewSpec } from "./drawingViews";
import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { Vec3 } from "../doc/types";
import { inView, viewFrame } from "../drafting/views";
import { boundingBoxOf } from "./measure";
import { scoped, type OC, type Scope } from "./oc";

/** A part of the assembly as the BOM lists it. */
export interface AssemblyPartInfo {
  massKg: number;
  material: string;
  /** Its name and properties (description, number), from its document. */
  name: string;
}

export interface AllViews {
  views: ProjectedView[];
  /** By part key ("self" for this document's own), when a view showed the assembly. */
  parts?: Record<string, AssemblyPartInfo>;
}

/** The components placed (exploded: moved apart), hidden ones left out. */
export function placedComponents(asm: Assembly, exploded: boolean): PlacedComponent[] {
  const offsets = exploded ? explodeOffsets(asm) : new Map();
  return asm.components
    .filter((k) => !k.hidden)
    .map((k) => {
      const P = placementOf(k);
      const o = offsets.get(k.id);
      return { id: k.id, part: k.part, R: P.R, t: o ? [P.t[0] + o[0], P.t[1] + o[1], P.t[2] + o[2]] : P.t };
    });
}

/**
 * Every view projected from its source, in the specs' order. `part` is the
 * part as built (null: it doesn't build; its views say so).
 */
export function projectAllViews(oc: OC, doc: Record<string, unknown>, specs: ViewSpec[], part: BuiltPart | null, cache: KeyCache = new Map(), known?: Map<string, ProjectedView>): AllViews {
  const out = new Map<string, ProjectedView>();
  const own = specs.filter((s) => !s.source);
  if (own.length) {
    if (part) for (const pv of projectDrawingViews(oc, part, own, cache, known)) out.set(pv.id, pv);
    else for (const s of own) out.set(s.id, { ...emptyView(s.id), problems: ["the part doesn't build"] });
  }
  let parts: Record<string, AssemblyPartInfo> | undefined;
  const asm = doc.assembly as Assembly | undefined;
  for (const source of ["assembly", "exploded"] as const) {
    const group = specs.filter((s) => s.source === source);
    if (!group.length) continue;
    if (!asm?.components?.length) {
      for (const s of group) out.set(s.id, { ...emptyView(s.id), problems: ["the document has no assembly: put parts together on the Assembly tab first"] });
      continue;
    }
    const docs = partDocuments(doc, asm);
    scoped((s) =>
      withAssemblyShapes(oc, s, docs, placedComponents(asm, source === "exploded"), (shapes, missing, built) => {
        // Each component's edges named by it ("bolt-1"), so two copies of a part keep apart.
        const asBuilt: BuiltPart = {
          bodies: shapes,
          label: (topo, body) => {
            for (const f of topo.faces) f.createdBy = body;
            for (const e of topo.edges) e.createdBy = body;
          },
        };
        // Explode lines: each moved component's middle, from where the part it comes off is drawn to where it is.
        const lines = source === "exploded" ? explodeLines(oc, s, asm, shapes) : [];
        for (const pv of projectDrawingViews(oc, asBuilt, group, new Map(), undefined)) {
          if (missing.length) pv.problems = [...(pv.problems ?? []), `${missing.join(", ")}: ${missing.length === 1 ? "its part doesn't" : "their parts don't"} build`];
          const spec = group.find((x) => x.id === pv.id);
          const shown = lines.filter((l) => !spec?.bodies || spec.bodies.includes(l.id));
          if (shown.length) pv.trails = shown.map((l) => [inView(l.from, pv.frame), inView(l.to, pv.frame)]);
          out.set(pv.id, pv);
        }
        parts ??= {};
        for (const [key, r] of built) {
          const d = docs[key] as Record<string, unknown> | undefined;
          parts[key] = { massKg: r.measurements?.mass.kg ?? 0, material: r.measurements?.mass.material ?? "", name: typeof d?.name === "string" ? d.name : key };
        }
      }),
    );
  }
  return { views: specs.map((s) => out.get(s.id)!).filter(Boolean), ...(parts ? { parts } : {}) };
}

/**
 * Each moved component's explode line, model mm: its middle as drawn, back to
 * where it was before its own move — the part it comes off moved as that one
 * is (the mated component whose move is nearest its own: a bolt's block).
 */
function explodeLines(oc: OC, s: Scope, asm: Assembly, shapes: { name: string; shape: TopoDS_Shape }[]): { id: string; from: Vec3; to: Vec3 }[] {
  const offsets = explodeOffsets(asm);
  const out: { id: string; from: Vec3; to: Vec3 }[] = [];
  for (const { name, shape } of shapes) {
    const o = offsets.get(name);
    if (!o || Math.hypot(...o) < 1e-6) continue;
    const box = boundingBoxOf(oc, s, shape);
    if (!box) continue;
    const to: Vec3 = [0, 1, 2].map((i) => (box.min[i] + box.max[i]) / 2) as Vec3;
    const partners = new Set((asm.mates ?? []).filter((m) => !m.suppressed && (m.a.component === name || m.b.component === name)).map((m) => (m.a.component === name ? m.b.component : m.a.component)));
    let base: Vec3 = [0, 0, 0];
    let best = Math.hypot(...o);
    for (const p of partners) {
      const op = offsets.get(p);
      // Only a part moved less than it can be what it comes off (a block's bolts, moved further, are not).
      if (!op || Math.hypot(...op) >= Math.hypot(...o) - 1e-6) continue;
      const d = Math.hypot(o[0] - op[0], o[1] - op[1], o[2] - op[2]);
      if (d < best - 1e-9) {
        best = d;
        base = op;
      }
    }
    if (best < 1e-6) continue;
    out.push({ id: name, from: [to[0] - o[0] + base[0], to[1] - o[1] + base[1], to[2] - o[2] + base[2]], to });
  }
  return out;
}

function emptyView(id: string): ProjectedView {
  return { id, frame: viewFrame("front"), bodies: [], edges: [], problems: [] };
}
