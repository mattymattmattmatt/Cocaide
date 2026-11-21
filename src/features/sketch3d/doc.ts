// sketch3d: a 3D sketch (src/geom/sketch3d.ts), points in space and lines
// between them: the layout of a frame that isn't flat. It makes no body;
// members are put on its lines (membersFromSketch) on nodes that follow its
// points, so editing it moves the frame.

import type { FeatureBase, Vec3 } from "../../doc/types";
import { sketch3dPositions, type Sketch3dLine, type Sketch3dPoint } from "../../geom/sketch3d";
import type { FeatureDef } from "../defs";

export interface Sketch3dFeature extends FeatureBase {
  op: "sketch3d";
  points: Sketch3dPoint[];
  lines: Sketch3dLine[];
  /** Shown in the view (default) or hidden. View only. */
  shown?: boolean;
  /** Where each point is (worked out by validation). */
  placed: Record<string, Vec3>;
}

export const def: FeatureDef<Sketch3dFeature> = {
  op: "sketch3d",
  validate(raw, c, x) {
    c.keys(raw, "", ["id", "op", "points", "lines", "shown"]);
    const shown = x.bool(raw, "shown", "");
    if (!Array.isArray(raw.points)) {
      c.fail("points", 'must be a list of points: { "id", "at": [x, y, z] } or { "id", "from", "by": [dx, dy, dz] }');
      return null;
    }
    raw.points.forEach((p, i) => x.isObject(p) && c.keys(p, `points[${i}]`, ["id", "at", "from", "by"]));
    raw.points.forEach((p, i) => x.isObject(p) && p.at !== undefined && p.from !== undefined && c.fail(`points[${i}]`, 'is at "at" or measured "from" a point, not both'));
    const placed = sketch3dPositions(raw.points);
    if (!placed.ok) c.fail(placed.path, placed.error);
    const lines = raw.lines === undefined ? [] : raw.lines;
    if (!Array.isArray(lines)) c.fail("lines", 'must be a list of lines: { "id", "start": <point>, "end": <point> }');
    const ids = new Set<string>(placed.ok ? placed.at.keys() : []);
    const pairs = new Set<string>();
    (Array.isArray(lines) ? lines : []).forEach((l, i) => {
      const path = `lines[${i}]`;
      if (!x.isObject(l)) return c.fail(path, 'must be { "id", "start", "end" }');
      c.keys(l, path, ["id", "start", "end", "construction"]);
      if (typeof l.id !== "string" || !l.id) return c.fail(`${path}.id`, "needed: the line's id, like l1");
      if (ids.has(l.id)) return c.fail(`${path}.id`, `duplicate id "${l.id}"`);
      ids.add(l.id);
      if (!placed.ok) return;
      for (const k of ["start", "end"] as const) if (typeof l[k] !== "string" || !placed.at.has(l[k] as string)) c.fail(`${path}.${k}`, `must name one of the points (${[...placed.at.keys()].join(", ") || "there are none"})`);
      const a = placed.at.get(String(l.start));
      const b = placed.at.get(String(l.end));
      if (a && b && Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6) c.fail(path, `${String(l.start)} and ${String(l.end)} are the same place: a line needs length`);
      const key = [String(l.start), String(l.end)].sort().join(" ");
      if (pairs.has(key)) c.fail(path, `another line already joins ${String(l.start)} and ${String(l.end)}`);
      pairs.add(key);
      if (l.construction !== undefined && typeof l.construction !== "boolean") c.fail(`${path}.construction`, "must be true or false");
    });
    if (c.errors.length || !placed.ok) return null;
    return {
      id: raw.id as string,
      op: "sketch3d",
      points: raw.points as Sketch3dPoint[],
      lines: lines as Sketch3dLine[],
      ...(shown !== undefined ? { shown } : {}),
      placed: Object.fromEntries(placed.at),
    };
  },
  reference: `## sketch3d
{ "id": "frame3d", "op": "sketch3d",
  "points": [{ "id": "p1", "at": [0, 0, 0] }, { "id": "p2", "from": "p1", "by": [0, 0, "=post_h"] }, { "id": "p3", "from": "p2", "by": [1200, 0, 300] }],
  "lines": [{ "id": "l1", "start": "p1", "end": "p2" }, { "id": "l2", "start": "p2", "end": "p3" }] }
A 3D sketch: points in space and straight lines between them, the layout of a frame that isn't flat. No body.
A point is "at" [x, y, z], or measured "from" an earlier point "by" [dx, dy, dz] (so it moves with that point);
numbers may be "=expressions". Lines name their points, so lines that meet share one. "construction": true keeps
a line for the layout only. Put members on its lines with membersFromSketch ({ "size", "sketch": "frame3d" }):
their nodes follow the points ("A": { "sketch": "frame3d", "point": "p2.at" }, or "l1.end"), so editing the
sketch moves the frame.
`,
};
