// Line ▾: Line, Centreline and Midpoint line, as SOLIDWORKS has them. Line
// and Centreline draw in a chain (each click carries on from the last end);
// a line drawn nearly level or plumb comes out so, with that relation.

import { dist2 } from "../../../geom/vec";
import { EPS, line, oriented } from "./shapes";
import type { Built, Click, FlyoutDef, SketchToolDef } from "./types";

const LINE: FlyoutDef = { id: "line", label: "Line" };

/** A line from the first click to the second; with `construction`, a centreline. */
function buildLine(clicks: Click[], id: string, construction: boolean): Built | null {
  const [a, b] = clicks.map((c) => c.p);
  if (dist2(a, b) < EPS) return null;
  return {
    entities: [line(id, a, b, construction)],
    relations: [],
    roles: [{ point: `${id}.start` }, { point: `${id}.end` }],
    inferred: oriented(id, a, b, clicks[1]),
    next: { p: b, ref: `${id}.end` },
  };
}

export const tools: SketchToolDef[] = [
  {
    id: "sketch.line",
    name: "line",
    label: "Line",
    icon: "line",
    title: "Line: click where it starts, then each corner; double-click, Esc or the first point ends it",
    flyout: LINE,
    clicks: 2,
    chain: true,
    prompts: ["Click where the line starts", "Click where it ends; keep clicking to chain lines, Esc to stop"],
    alignTo: (pts) => (pts.length === 1 ? pts[0] : undefined),
    build: (clicks, _options, ids) => buildLine(clicks, ids("l"), false),
  },
  {
    id: "sketch.centerline",
    name: "centerline",
    label: "Centreline",
    icon: "centerline",
    title: "Centreline: a construction line, for symmetry, mirrors and revolve axes; it never becomes profile",
    flyout: LINE,
    clicks: 2,
    chain: true,
    prompts: ["Click where the centreline starts", "Click where it ends; Esc to stop"],
    alignTo: (pts) => (pts.length === 1 ? pts[0] : undefined),
    build: (clicks, _options, ids) => buildLine(clicks, ids("l"), true),
  },
  {
    id: "sketch.midpointLine",
    name: "midpoint-line",
    label: "Midpoint line",
    icon: "midpointLine",
    title: "Midpoint line: click its middle, then one end; it runs the same length both ways (on a point, that point stays its midpoint)",
    flyout: LINE,
    clicks: 2,
    prompts: ["Click the middle of the line", "Click one end: the other mirrors it"],
    alignTo: (pts) => (pts.length === 1 ? pts[0] : undefined),
    build: (clicks, _options, ids) => {
      const [m, b] = clicks.map((c) => c.p);
      if (dist2(m, b) < EPS) return null;
      const id = ids("l");
      const a: [number, number] = [2 * m[0] - b[0], 2 * m[1] - b[1]];
      return {
        entities: [line(id, a, b)],
        relations: [],
        roles: [{ middle: id }, { point: `${id}.end` }],
        inferred: oriented(id, a, b, clicks[1]),
      };
    },
  },
];
