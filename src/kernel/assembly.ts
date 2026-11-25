// An assembly in the kernel: each part its components use, rebuilt once,
// and each component's solid placed (x ↦ R·x + t) under its own name: what
// the assembly's STEP file and its interference check are made of.

import { isMeshPart } from "../mesh/meshPart";
import type { TopoDS_Shape } from "replicad-opencascadejs";
import { interference } from "./measure";
import type { OC, Scope } from "./oc";
import { compoundOf } from "./ops";
import { rebuild, type RebuildResult } from "./rebuild";
import { exportSTEP } from "./step";
import { componentLook, partLooks, type ItemLook } from "./stepColours";
import type { Appearance } from "../doc/types";

export interface PlacedComponent {
  id: string;
  part: string;
  R: number[][];
  t: number[];
  /** Its own colour, over its part's (the STEP file carries it). */
  appearance?: Appearance;
}

/** Runs `use` with each component's placed solid (components whose part didn't build are left out, and named). */
export function withAssemblyShapes<T>(oc: OC, s: Scope, parts: Record<string, unknown>, components: PlacedComponent[], use: (shapes: { name: string; shape: TopoDS_Shape }[], missing: string[], built: Map<string, RebuildResult>) => T): T {
  const built = new Map<string, RebuildResult>();
  try {
    const shapes: { name: string; shape: TopoDS_Shape }[] = [];
    const missing: string[] = [];
    for (const k of components) {
      // A mesh part (a .glb model) has no solid: left out of what needs one, not counted as broken.
      if (isMeshPart(parts[k.part])) continue;
      let r = built.get(k.part);
      if (!r) {
        r = rebuild(parts[k.part], oc);
        built.set(k.part, r);
      }
      if (!r.solid) {
        missing.push(k.id);
        continue;
      }
      const trsf = s.track(new oc.gp_Trsf());
      const R = k.R;
      trsf.SetValues(R[0][0], R[0][1], R[0][2], k.t[0], R[1][0], R[1][1], R[1][2], k.t[1], R[2][0], R[2][1], R[2][2], k.t[2]);
      const moved = s.track(s.track(new oc.BRepBuilderAPI_Transform(r.solid, trsf, true, false)).Shape());
      shapes.push({ name: k.id, shape: moved });
    }
    return use(shapes, missing, built);
  } finally {
    for (const r of built.values()) r.dispose();
  }
}

/** The assembly as a STEP file: one named solid per component, each coloured as it looks (its own colour, else its part's). */
export function assemblySTEP(oc: OC, s: Scope, name: string, parts: Record<string, unknown>, components: PlacedComponent[]): string {
  return withAssemblyShapes(oc, s, parts, components, (shapes, missing, built) => {
    if (missing.length) throw new Error(`${missing.join(", ")}: ${missing.length === 1 ? "its part doesn't" : "their parts don't"} build`);
    if (!shapes.length) throw new Error("the assembly has no components to export");
    const partLook = new Map<string, Map<string, ItemLook> | null>();
    const looks = new Map<string, ItemLook>();
    for (const k of components) {
      const r = built.get(k.part);
      if (!r) continue;
      if (!partLook.has(k.part)) partLook.set(k.part, partLooks(oc, s, r, parts[k.part]));
      const look = componentLook(k.appearance ?? null, partLook.get(k.part)!, r.bodies);
      if (look) looks.set(k.id, look);
    }
    return exportSTEP(oc, compoundOf(oc, s, shapes.map((x) => x.shape)), name, null, shapes, {}, looks.size ? looks : null);
  });
}

/** Pairs of components that share volume, with how much. */
export function assemblyInterference(oc: OC, s: Scope, parts: Record<string, unknown>, components: PlacedComponent[]): { components: [string, string]; volume: number }[] {
  return withAssemblyShapes(oc, s, parts, components, (shapes) => interference(oc, s, new Map(shapes.map((x) => [x.name, x.shape]))).map((i) => ({ components: i.bodies, volume: i.volume })));
}
