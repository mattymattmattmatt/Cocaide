// Shared by the UI registry tests: example documents, the RebuildView the app
// would get for one (built in node, as the worker builds it), and a ToolCtx
// whose actions are recorded instead of acted on.

import { readFileSync } from "node:fs";
import type { RawDocument } from "../src/doc/commands";
import { resolvedDocument } from "../src/doc/parameters";
import type { PlaneSpec } from "../src/doc/types";
import { rebuild, scoped, type OC } from "../src/kernel";
import { labelBodies } from "../src/kernel/bodies";
import { describeEdges, describeFaces } from "../src/kernel/topology";
import { makeToolCtx, type ToolState } from "../src/ui/model/context";
import { EMPTY_SELECTION } from "../src/ui/model/selection";
import type { Raw, RightTab, ToolCtx } from "../src/ui/model/ToolContext";
import type { RebuildView } from "../src/worker/protocol";

export const example = (name: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${name}.cocaide.json`, import.meta.url), "utf8"));

/** The view the worker sends for a document: topology, bodies and measurements (no mesh). */
export function viewOf(oc: OC, doc: RawDocument): RebuildView {
  const r = rebuild(doc, oc);
  try {
    const topo = r.solid
      ? scoped((s) => {
          const f = describeFaces(oc, s, r.solid!);
          return { faces: f.infos, edges: describeEdges(oc, s, r.solid!, f.faces).infos };
        })
      : { faces: [], edges: [] };
    const bodies = r.bodies.map(({ name, faces, edges }) => ({ name, faces, edges }));
    if (bodies.length > 1) labelBodies(topo, bodies);
    return { ok: r.ok, name: r.name, errors: r.errors, features: r.features, sketches: r.sketches, measurements: r.measurements, mesh: null, faces: topo.faces, edges: topo.edges, bodies, datums: r.datums };
  } finally {
    r.dispose();
  }
}

export interface Recorded {
  created: Raw[];
  notices: [kind: string, text: string][];
  sketches: PlaneSpec[];
  tabs: RightTab[];
  replaced: [doc: RawDocument, select: string | undefined][];
}

/** A ToolCtx on this document and view; what the tools do lands in `out`. */
export function harness(doc: RawDocument, view: RebuildView | null, state: Partial<ToolState> = {}): { ctx: ToolCtx; out: Recorded } {
  const out: Recorded = { created: [], notices: [], sketches: [], tabs: [], replaced: [] };
  const ctx = makeToolCtx(
    { doc, view, selection: EMPTY_SELECTION, selected: undefined, resolved: resolvedDocument(doc).features as Raw[], features: doc.features, library: [], ...state },
    {
      run: () => null,
      create: (f) => void out.created.push(f),
      replace: (d, select) => void out.replaced.push([d, select]),
      notice: (text, kind = "error") => void out.notices.push([kind, text]),
      clearNotice: () => undefined,
      startSketch: (plane) => void out.sketches.push(plane),
      setSelection: () => undefined,
      selectFeature: () => undefined,
      setRightTab: (t) => void out.tabs.push(t),
    },
  );
  return { ctx, out };
}

/** The index of the face that matches, for clicking it in a test. */
export function faceWhere(view: RebuildView, test: (f: RebuildView["faces"][number]) => boolean): number {
  const i = view.faces.findIndex(test);
  if (i < 0) throw new Error("no such face");
  return i;
}

/** -0 as 0, so arrays compare as the document would save them. */
export const unsigned = (v: number[]) => v.map((x) => x + 0);
