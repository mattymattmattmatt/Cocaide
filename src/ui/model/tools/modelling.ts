// Phase P wave 3B tools: fill, curve-driven and table-driven patterns (in the
// Pattern menu), Thread and Dome (dress group), Coordinate system (Reference
// tab). Each opens a feature session: with what is selected filled in (a
// face, a feature in the tree), else with the field it waits on active for
// a pick in the view or the tree.

import type { FaceSelector } from "../../../doc/types";
import { faceSelectorFor } from "../../../kernel/synthesize";
import { refFromSelection } from "../../props/datumRef";
import type { Raw, ToolCtx, ToolDef, ToolMenuDef } from "../ToolContext";
import { PATTERNABLE } from "./pattern";

const PATTERN_MENU: ToolMenuDef = {
  id: "pattern",
  label: "Pattern",
  icon: "pattern",
  title: "Repeat the selected feature in a row, around an axis or at a sketch's points",
  testId: "tool-pattern",
};

/** The one face selected in the view, as a selector, if it is of the kind wanted. */
function pickedFace(ctx: ToolCtx, kind: "plane" | "cylinder"): FaceSelector | null {
  if (!ctx.view || ctx.selection.faces.length !== 1) return null;
  const f = ctx.view.faces[ctx.selection.faces[0]];
  if (f?.type !== kind) return null;
  const s = faceSelectorFor(ctx.view.faces, f.index);
  return s.ok ? s.selector : null;
}

/** The seed: the patternable feature selected in the tree, if any. */
const seedOf = (ctx: ToolCtx): string | null => (ctx.selected && PATTERNABLE.includes(String(ctx.selected.op)) ? String(ctx.selected.id) : null);

/** Opens it whole, or as a draft with `active` waiting for a pick (a notice when the host can't). */
function open(ctx: ToolCtx, f: Raw, missing: string | null, what: string): void {
  if (!missing) return ctx.create(f);
  if (ctx.draft) return ctx.draft(f, { active: missing });
  ctx.notice(what);
}

/** The latest sketch with a closed profile or a chain, other than `not`. */
function latestSketch(ctx: ToolCtx): string | null {
  const s = [...ctx.resolved].reverse().find((g) => g.op === "sketch");
  return s ? String(s.id) : null;
}

export const tools: ToolDef[] = [
  {
    id: "tool.fillPattern",
    label: "Fill pattern",
    icon: "fillPattern",
    tab: "features",
    group: "pattern",
    menu: PATTERN_MENU,
    title: "Copies of the selected feature filling a flat face (or a sketch's region): select the feature, click the face, then Fill pattern",
    hint: "Copies filling a face",
    testId: "tool-fill-pattern",
    run(ctx) {
      const seed = seedOf(ctx);
      const face = pickedFace(ctx, "plane");
      const f: Raw = { id: ctx.nextId("fill"), op: "fillPattern", ...(seed ? { feature: seed } : {}), ...(face ? { face } : {}), spacing: 15, margin: 3 };
      open(ctx, f, !seed ? "features" : !face ? "face" : null, "Select the feature to repeat in the tree and click the flat face to fill, then Fill pattern.");
    },
  },
  {
    id: "tool.curvePattern",
    label: "Curve-driven pattern",
    icon: "curvePattern",
    tab: "features",
    group: "pattern",
    menu: PATTERN_MENU,
    title: "Copies of the selected feature along a curve: a sketch's chain (the latest sketch) or model edges selected in the view",
    hint: "Copies along a curve",
    testId: "tool-curve-pattern",
    run(ctx) {
      const seed = seedOf(ctx);
      const edges = ctx.view && ctx.selection.edges.length ? ctx.selection.edges : [];
      let path: Raw | null = null;
      if (edges.length && ctx.view) {
        const view = ctx.view;
        const sels = edges.map((i) => refFromSelection({ faces: [], edges: [i] }, view, ["axis", "point"], ctx.resolved)).flatMap((r) => (r.ok && "edge" in r.ref ? [r.ref.edge] : []));
        if (sels.length) path = { edges: sels };
      }
      const sketch = latestSketch(ctx);
      path ??= sketch ? { sketch } : null;
      const f: Raw = { id: ctx.nextId("curvePattern"), op: "curvePattern", ...(seed ? { feature: seed } : {}), path: path ?? { sketch: "" }, count: 4 };
      open(ctx, f, !seed ? "features" : !path ? "path.sketch" : null, "Select the feature to repeat in the tree, and draw the curve in a sketch first.");
    },
  },
  {
    id: "tool.tablePattern",
    label: "Table-driven pattern",
    icon: "tablePattern",
    tab: "features",
    group: "pattern",
    menu: PATTERN_MENU,
    title: "Copies of the selected feature at a table of X, Y positions in a coordinate system or plane (paste the table from a spreadsheet)",
    hint: "Copies at a table of positions",
    testId: "tool-table-pattern",
    run(ctx) {
      const seed = seedOf(ctx);
      const cs = [...ctx.resolved].reverse().find((g) => g.op === "coordinateSystem");
      const f: Raw = { id: ctx.nextId("tablePattern"), op: "tablePattern", ...(seed ? { feature: seed } : {}), ...(cs ? { system: { datum: cs.id } } : {}), positions: [[0, 0], [20, 0], [0, 20]] };
      open(ctx, f, !seed ? "features" : null, "Select the feature to repeat in the tree, then Table-driven pattern.");
    },
  },
  {
    id: "tool.thread",
    label: "Thread",
    icon: "thread",
    tab: "features",
    group: "dress",
    title: "An ISO metric thread on a round face: click a shaft or a hole's wall, then Thread (cosmetic: shown and called out; or modelled)",
    testId: "tool-thread",
    disabled: (ctx) => (ctx.view && ctx.view.bodies.length === 0 ? "Thread needs a solid" : undefined),
    run(ctx) {
      const face = pickedFace(ctx, "cylinder");
      const f: Raw = { id: ctx.nextId("thread"), op: "thread", ...(face ? { face } : {}) };
      open(ctx, f, face ? null : "face", "Click a shaft or a hole's wall, then Thread.");
    },
    contextOn: "face",
    contextLabel: "Thread this face",
    contextTestId: "ctx-thread",
    contextWhen: (ctx, t) => t.kind === "face" && ctx.view?.faces[t.index]?.type === "cylinder",
  },
  {
    id: "tool.dome",
    label: "Dome",
    icon: "dome",
    tab: "features",
    group: "dress",
    title: "A dome on a flat face: click the face, then Dome",
    testId: "tool-dome",
    disabled: (ctx) => (ctx.view && ctx.view.bodies.length === 0 ? "Dome needs a solid" : undefined),
    run(ctx) {
      const face = pickedFace(ctx, "plane");
      const f: Raw = { id: ctx.nextId("dome"), op: "dome", ...(face ? { face } : {}), height: 5 };
      open(ctx, f, face ? null : "face", "Click a flat face, then Dome.");
    },
    contextOn: "face",
    contextLabel: "Dome on this face",
    contextTestId: "ctx-dome",
    contextWhen: (ctx, t) => t.kind === "face" && ctx.view?.faces[t.index]?.type === "plane",
  },
  {
    id: "tool.coordinateSystem",
    label: "Coordinate system",
    icon: "coordinateSystem",
    tab: "reference",
    group: "datum",
    title: "A coordinate system: at the vertex or point selected (else the origin), X along the edge selected; it follows them",
    testId: "tool-coordinate-system",
    run(ctx) {
      const sel = ctx.selection;
      const view = ctx.view;
      const f: Raw = { id: ctx.nextId("cs"), op: "coordinateSystem" };
      if (view && sel.vertices?.length) {
        const r = refFromSelection({ faces: [], edges: [], vertices: [sel.vertices[0]] }, view, ["point"], ctx.resolved);
        if (r.ok) f.origin = r.ref;
      }
      if (view && sel.edges.length) {
        const r = refFromSelection({ faces: [], edges: [sel.edges[0]] }, view, ["axis"], ctx.resolved);
        if (r.ok) f.x = r.ref;
      }
      ctx.create(f);
    },
  },
];
