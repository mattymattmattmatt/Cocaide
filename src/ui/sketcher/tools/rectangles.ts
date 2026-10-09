// Rectangle ▾: Corner, Centre, 3-point and Parallelogram, as SOLIDWORKS has
// them. Each is four lines joined at the corners and held in shape by
// relations, so a side can be trimmed, filleted or dimensioned on its own:
// level and plumb sides for the corner and centre rectangles (4 degrees of
// freedom: where and how big), square corners for the 3-point one (5: it may
// turn), parallel sides for the parallelogram (6). A rectangle drawn with the
// old single-entity tool is still a valid "rect" in older documents.

import type { Constraint, LineEntity, SketchEntity, Vec2 } from "../../../doc/types";
import { cross2, dist2, dot2, sub2 } from "../../../geom/vec";
import { along, closedLoop, cornerAt, EPS, line, oriented, perp, unit } from "./shapes";
import type { Built, Click, ClickRole, FlyoutDef, IdMaker, SketchToolDef } from "./types";

const RECT: FlyoutDef = { id: "rect", label: "Rectangle" };

/** The corners of the level rectangle spanning two points, anticlockwise from the bottom left; null when it is flat. */
function boxCorners(a: Vec2, c: Vec2): Vec2[] | null {
  const [x0, x1] = [Math.min(a[0], c[0]), Math.max(a[0], c[0])];
  const [y0, y1] = [Math.min(a[1], c[1]), Math.max(a[1], c[1])];
  if (x1 - x0 < EPS || y1 - y0 < EPS) return null;
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** Four lines round the corners, bottom and top level, the sides plumb. */
function levelBox(ids: IdMaker, corners: Vec2[]): { lines: LineEntity[]; relations: Constraint[] } {
  const { lines, relations } = closedLoop(ids, corners);
  const [l1, l2, l3, l4] = lines;
  relations.push(
    { type: "horizontal", entity: l1.id },
    { type: "vertical", entity: l2.id },
    { type: "horizontal", entity: l3.id },
    { type: "vertical", entity: l4.id },
  );
  return { lines, relations };
}

/** A corner a click put down, as a role: the corner there, if there is one. */
const cornerRole = (lines: LineEntity[], p: Vec2): ClickRole => {
  const ref = cornerAt(lines, p);
  return ref ? { point: ref } : null;
};

/** The 3-point rectangle's or parallelogram's first side, from the first click to the second, as the preview shows it while the third is placed. */
const firstSide = (clicks: Click[]): SketchEntity[] =>
  clicks.length === 2 && dist2(clicks[0].p, clicks[1].p) > EPS ? [line("preview", clicks[0].p, clicks[1].p)] : [];

export const tools: SketchToolDef[] = [
  {
    id: "sketch.rect",
    name: "rect",
    label: "Corner rectangle",
    icon: "rect",
    title: "Corner rectangle: click one corner, then the opposite one. Four lines, level and plumb",
    flyout: RECT,
    clicks: 2,
    prompts: ["Click a corner", "Click the opposite corner"],
    build: (clicks, _options, ids): Built | null => {
      const corners = boxCorners(clicks[0].p, clicks[1].p);
      if (!corners) return null;
      const { lines, relations } = levelBox(ids, corners);
      return { entities: lines, relations, roles: clicks.map((c) => cornerRole(lines, c.p)) };
    },
  },
  {
    id: "sketch.rectCenter",
    name: "rect-center",
    label: "Centre rectangle",
    icon: "rectCenter",
    title: "Centre rectangle: click the centre, then a corner. Four lines with construction diagonals and a point at the centre",
    flyout: RECT,
    clicks: 2,
    prompts: ["Click the centre", "Click a corner"],
    build: (clicks, _options, ids): Built | null => {
      const [m, c] = clicks.map((k) => k.p);
      const dx = Math.abs(c[0] - m[0]);
      const dy = Math.abs(c[1] - m[1]);
      const corners = boxCorners([m[0] - dx, m[1] - dy], [m[0] + dx, m[1] + dy]);
      if (!corners) return null;
      const { lines, relations } = levelBox(ids, corners);
      const [l1, l2, l3, l4] = lines;
      const d1 = line(ids("l"), corners[0], corners[2], true);
      const d2 = line(ids("l"), corners[1], corners[3], true);
      const centre = ids("p");
      relations.push(
        { type: "coincident", points: [`${d1.id}.start`, `${l1.id}.start`] },
        { type: "coincident", points: [`${d1.id}.end`, `${l3.id}.start`] },
        { type: "coincident", points: [`${d2.id}.start`, `${l2.id}.start`] },
        { type: "coincident", points: [`${d2.id}.end`, `${l4.id}.start`] },
        // The diagonals of a rectangle cross at their middles: the centre point is the middle of one, so of both.
        { type: "midpoint", point: `${centre}.at`, entity: d1.id },
      );
      return {
        entities: [...lines, d1, d2, { id: centre, type: "point", at: m }],
        relations,
        roles: [{ point: `${centre}.at` }, cornerRole(lines, c)],
      };
    },
  },
  {
    id: "sketch.rect3",
    name: "rect3",
    label: "3-point rectangle",
    icon: "rect3",
    title: "3-point corner rectangle: click two corners along one side, then how far across. It may sit at any angle; its corners stay square",
    flyout: RECT,
    clicks: 3,
    prompts: ["Click a corner", "Click the next corner: the first side", "Click how far across the other side is"],
    alignTo: (pts) => (pts.length >= 1 ? pts[pts.length - 1] : undefined),
    preview: (clicks, _options, ids) => (clicks.length < 3 ? firstSide(clicks) : (rect3(clicks, ids)?.entities ?? [])),
    build: (clicks, _options, ids) => rect3(clicks, ids),
  },
  {
    id: "sketch.parallelogram",
    name: "parallelogram",
    label: "Parallelogram",
    icon: "parallelogram",
    title: "Parallelogram: click a corner, the next corner, then the one after; the fourth closes it with opposite sides parallel",
    flyout: RECT,
    clicks: 3,
    prompts: ["Click a corner", "Click the next corner", "Click the corner after that"],
    alignTo: (pts) => (pts.length >= 1 ? pts[pts.length - 1] : undefined),
    preview: (clicks, _options, ids) => (clicks.length < 3 ? firstSide(clicks) : (parallelogram(clicks, ids)?.entities ?? [])),
    build: (clicks, _options, ids) => parallelogram(clicks, ids),
  },
];

/** Two corners along the first side, then the width across it: square corners, opposite sides parallel. */
function rect3(clicks: Click[], ids: IdMaker): Built | null {
  const [a, b, q] = clicks.map((c) => c.p);
  if (dist2(a, b) < EPS) return null;
  const n = perp(unit(sub2(b, a)));
  const h = dot2(sub2(q, b), n);
  if (Math.abs(h) < EPS) return null;
  const c = along(b, n, h);
  const d = along(a, n, h);
  const { lines, relations } = closedLoop(ids, [a, b, c, d]);
  const [l1, l2, l3, l4] = lines;
  relations.push(
    { type: "perpendicular", entities: [l1.id, l2.id] },
    { type: "parallel", entities: [l1.id, l3.id] },
    { type: "parallel", entities: [l2.id, l4.id] },
  );
  return {
    entities: lines,
    relations,
    // The third click is on the far side (extended), and at its corner when it was clicked square across.
    roles: [{ point: `${l1.id}.start` }, { point: `${l1.id}.end` }, dist2(c, q) < EPS ? { point: `${l2.id}.end` } : { on: l3.id }],
    inferred: oriented(l1.id, a, b, clicks[1]),
  };
}

/** Three corners in turn; the fourth makes opposite sides parallel. */
function parallelogram(clicks: Click[], ids: IdMaker): Built | null {
  const [a, b, c] = clicks.map((k) => k.p);
  const ab = sub2(b, a);
  const bc = sub2(c, b);
  if (Math.hypot(...ab) < EPS || Math.hypot(...bc) < EPS || Math.abs(cross2(ab, bc)) < EPS * Math.hypot(...ab) * Math.hypot(...bc) + EPS) return null;
  const d: Vec2 = [a[0] + c[0] - b[0], a[1] + c[1] - b[1]];
  const { lines, relations } = closedLoop(ids, [a, b, c, d]);
  const [l1, l2, l3, l4] = lines;
  relations.push({ type: "parallel", entities: [l1.id, l3.id] }, { type: "parallel", entities: [l2.id, l4.id] });
  return {
    entities: lines,
    relations,
    roles: [{ point: `${l1.id}.start` }, { point: `${l1.id}.end` }, { point: `${l2.id}.end` }],
    inferred: [...oriented(l1.id, a, b, clicks[1]), ...oriented(l2.id, b, c, clicks[2])],
  };
}
