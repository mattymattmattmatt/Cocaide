// The selection fields of a declared editor (src/ui/props/spec.ts) as live
// pick fields during a session (picking.ts): what each kind takes from the
// view, what it holds, and how a click changes it. FeatureForm makes one per
// selection field it shows; this is the pure part, so the routing (a click
// goes into the active field, a field takes only what it can) is tested in
// node.

import type { DatumRef, FaceSelector } from "../../doc/types";
import type { DatumKind } from "../../features/datum";
import type { RebuildView } from "../../worker/protocol";
import { only, type PickTarget } from "../model/selection";
import type { EdgeKindFilter } from "../model/smartSelect";
import { addEdges, edgeList, fieldTakes, holds, refTargets, resolveEdges, resolveFaces, takesForKinds, toggleEdges, toggleFace, toggleId, toggleRef, treeTakes, type PickField } from "./picking";
import { acceptsOf, asList, fieldValue, featureChoices, type FieldSpec, type FormContext } from "./spec";

type Raw = Record<string, unknown>;

/** How an edge field takes picks: with each edge's tangency chain, and which corners. */
export interface EdgeOptions {
  /** Tangent propagation: an edge comes with the edges that run on smoothly from it. */
  propagate: boolean;
  /** Outside corners only, inside ones only, or both. */
  kinds: EdgeKindFilter;
}

export const DEFAULT_EDGE_OPTIONS: EdgeOptions = { propagate: true, kinds: "all" };

/** What the fields read besides the feature: the part picks are made on, and the edge helpers on it. */
export interface PickEnv extends Pick<FormContext, "before" | "bodies"> {
  view: RebuildView | null;
  edge: EdgeOptions;
  /** The edges that go with a picked one (its tangency chain), it first. */
  chainOf(edge: number): number[];
  /** Does an edge pass the corner filter? */
  passes(edge: number): boolean;
}

/** The field kinds that pick: everything that holds geometry, references, bodies or features. */
export function isPickSpec(spec: FieldSpec): boolean {
  if (spec.pickable === false) return false;
  return ["faces", "face", "edges", "datumRef", "features", "feature", "sketch", "bodies"].includes(spec.kind);
}

/** "Pick edges", or the field's own words. */
function promptOf(spec: FieldSpec): string {
  if (spec.prompt) return spec.prompt;
  const what = spec.label.toLowerCase();
  if (spec.kind === "features" || spec.kind === "feature" || spec.kind === "sketch") return `Pick ${spec.kind === "sketch" ? "a sketch" : what} in the tree`;
  return `Pick ${spec.kind === "face" || spec.kind === "datumRef" ? `the ${what}` : what}`;
}

/**
 * The live pick field for a selection field shown in a session, or null for
 * a kind that does not pick. `commit` sends the new value (through the
 * field's own `set` and the feature's update) and returns the refusal, if any.
 */
export function pickFieldFor(spec: FieldSpec, f: Raw, c: FormContext, order: number, env: PickEnv, commit: (value: unknown) => string | null | void): PickField | null {
  if (!isPickSpec(spec)) return null;
  const value = fieldValue(spec, f, c);
  const view = env.view;
  const base = { key: spec.key, label: spec.label, order, prompt: promptOf(spec) };
  const result = (r: string | null | void) => (typeof r === "string" ? r : null);
  switch (spec.kind) {
    case "faces": {
      const list = asList<FaceSelector>(value);
      const per = view ? resolveFaces(list, view.faces) : [];
      return {
        ...base,
        kind: "faces",
        takes: ["faces"],
        count: list.length,
        required: !spec.optional,
        items: per.flat().map((i) => ({ kind: "face" as const, index: i, point: view!.faces[i]?.centroid ?? [0, 0, 0] })),
        toggle(t) {
          if (t.kind !== "face" || !view) return `${spec.label} takes faces: click a face`;
          const next = toggleFace(list, view.faces, t.index);
          return typeof next === "string" ? next : result(commit(next.length || spec.optional ? next : null));
        },
        addAll(ts) {
          if (!view) return null;
          let next: FaceSelector[] = list;
          for (const t of ts) {
            if (t.kind !== "face" || resolveFaces(next, view.faces).flat().includes(t.index)) continue;
            const r = toggleFace(next, view.faces, t.index);
            if (typeof r === "string") return r;
            next = r;
          }
          return next === list ? null : result(commit(next));
        },
      };
    }
    case "face": {
      const sel = value as FaceSelector | undefined;
      const items = sel && view ? resolveFaces([sel], view.faces)[0].map((i) => ({ kind: "face" as const, index: i, point: view.faces[i]?.centroid ?? [0, 0, 0] })) : [];
      return {
        ...base,
        kind: "face",
        takes: ["faces"],
        count: sel ? 1 : 0,
        required: true,
        items,
        toggle(t) {
          if (t.kind !== "face" || !view) return `${spec.label} takes a face: click one`;
          const next = toggleFace([], view.faces, t.index);
          if (typeof next === "string") return next;
          return result(commit(next[0]));
        },
      };
    }
    case "edges": {
      const r = view ? resolveEdges(value, view.edges, view.faces) : { indices: [], unresolved: [] };
      return {
        ...base,
        kind: "edges",
        takes: ["edges"],
        count: view ? r.indices.length + r.unresolved.length : edgeList(value).length,
        required: !spec.optional,
        items: r.indices.map((i) => ({ kind: "edge" as const, index: i, point: view!.edges[i]?.mid ?? [0, 0, 0] })),
        toggle(t) {
          if (t.kind !== "edge" || !view) return `${spec.label} takes edges: click an edge`;
          const inAlready = r.indices.includes(t.index);
          if (!inAlready && !env.passes(t.index)) return `That is ${env.edge.kinds === "convex" ? "an inside" : "an outside"} edge: the filter takes only ${env.edge.kinds === "convex" ? "outside (convex)" : "inside (concave)"} edges`;
          // Out goes the edge with its chain as it is in the field; in comes its chain, filtered.
          const chain = env.edge.propagate ? env.chainOf(t.index).filter((i, k) => k === 0 || inAlready || env.passes(i)) : [t.index];
          const next = toggleEdges(value, view.edges, view.faces, inAlready ? chain.filter((i) => r.indices.includes(i)) : chain);
          return typeof next === "string" ? next : result(commit(next));
        },
        addAll(ts) {
          if (!view) return null;
          const add = ts.flatMap((t) => (t.kind === "edge" && env.passes(t.index) ? [t.index] : []));
          if (!add.length) return null;
          const next = addEdges(value, view.edges, view.faces, add);
          return typeof next === "string" ? next : result(commit(next));
        },
      };
    }
    case "datumRef": {
      const accepts: DatumKind[] = acceptsOf(spec, f, c);
      const items = refTargets(value, view);
      return {
        ...base,
        kind: "datumRef",
        takes: spec.forms && !spec.forms.includes("datum") ? takesForKinds(accepts).filter((k) => k !== "planes") : takesForKinds(accepts),
        count: value ? 1 : 0,
        required: !spec.optional,
        items,
        toggle(t) {
          // A field that makes its reference its own way (up to a face, which a curved face will do for) reads the click as the selection.
          if (spec.pick) {
            if (value && holds(items, t)) return spec.optional ? result(commit(null)) : null;
            try {
              return result(commit(spec.pick(f, { ...c, view, selection: only(t) })));
            } catch (e) {
              return e instanceof Error ? e.message.replace(/,? then Use selected\.?$/, ".") : String(e);
            }
          }
          const next = toggleRef(value, t, view, accepts, env.before, !!spec.optional);
          if (typeof next === "string") return next;
          if (next === value) return null;
          return result(commit(next as DatumRef | null));
        },
      };
    }
    case "bodies": {
      const list = Array.isArray(value) ? (value as string[]) : [];
      return {
        ...base,
        kind: "bodies",
        takes: ["faces"],
        count: list.length,
        required: false,
        items: [],
        toggle(t) {
          if (t.kind !== "face" || !view) return "Click a face of the body";
          const body = view.faces[t.index]?.body ?? view.bodies[0]?.name;
          if (!body || !env.bodies.includes(body)) return `That face's body is not one ${spec.label.toLowerCase()} can take here`;
          const next = toggleId(list, body, env.bodies);
          return result(commit(next.length ? next : null));
        },
      };
    }
    case "features":
    case "feature":
    case "sketch": {
      const ops = spec.kind === "sketch" ? ["sketch"] : spec.ops;
      const choices = featureChoices(env.before, ops).map(([id]) => id);
      const list = spec.kind === "features" ? (Array.isArray(value) ? (value as string[]) : []) : typeof value === "string" && value ? [value] : [];
      return {
        ...base,
        kind: spec.kind,
        takes: [],
        treeOps: ops ?? "any",
        count: list.length,
        required: spec.kind !== "features",
        items: [],
        toggle: () => `${spec.label}: pick ${spec.kind === "sketch" ? "the sketch" : "features"} in the feature tree`,
        takeFeature(id) {
          const g = env.before.find((x) => x.id === id);
          if (!g || !choices.includes(id)) return `${id} can't go in ${spec.label.toLowerCase()} here${g ? "" : " (it comes after this feature)"}`;
          if (!treeTakes(ops ?? "any", g.op)) return `${spec.label} takes ${(ops ?? []).join(", ")}`;
          if (spec.kind === "features") {
            const next = toggleId(list, id, choices);
            return result(commit(next.length ? next : null));
          }
          return result(commit(id));
        },
      };
    }
    default:
      return null;
  }
}

/** Does a pick field take this click? */
export function takesClick(field: PickField, t: PickTarget): boolean {
  return fieldTakes(field, t);
}
