// Circle ▾: Circle (centre, then a point on it) and Perimeter circle (three
// points on it), as SOLIDWORKS has them. A point clicked on goes on the circle.

import type { Vec2 } from "../../../doc/types";
import { dist2 } from "../../../geom/vec";
import { circumcircle, EPS } from "./shapes";
import type { FlyoutDef, SketchToolDef } from "./types";

const CIRCLE: FlyoutDef = { id: "circle", label: "Circle" };

export const tools: SketchToolDef[] = [
  {
    id: "sketch.circle",
    name: "circle",
    label: "Circle",
    icon: "circle",
    title: "Circle: click the centre, then a point on it",
    flyout: CIRCLE,
    clicks: 2,
    prompts: ["Click the centre", "Click a point on the circle"],
    build: (clicks, _options, ids) => {
      const [c, q] = clicks.map((k) => k.p);
      const radius = dist2(c, q);
      if (radius < EPS) return null;
      const id = ids("c");
      return { entities: [{ id, type: "circle", center: c, radius }], relations: [], roles: [{ point: `${id}.center` }, { on: id }] };
    },
  },
  {
    id: "sketch.circle3",
    name: "circle3",
    label: "Perimeter circle",
    icon: "circle3",
    title: "Perimeter circle: click three points it passes through",
    flyout: CIRCLE,
    clicks: 3,
    prompts: ["Click a point on the circle", "Click a second point on it", "Click a third point on it"],
    preview: (clicks, _options, ids) => {
      if (clicks.length !== 2) return [];
      // Two points so far: the circle they are the ends of a diameter of.
      const [a, b] = clicks.map((k) => k.p);
      const center: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      return dist2(a, b) < EPS ? [] : [{ id: ids("c"), type: "circle", center, radius: dist2(a, b) / 2 }];
    },
    build: (clicks, _options, ids) => {
      const [a, b, c] = clicks.map((k) => k.p);
      const circle = circumcircle(a, b, c);
      if (!circle || circle.r < EPS) return null;
      const id = ids("c");
      return { entities: [{ id, type: "circle", center: circle.center, radius: circle.r }], relations: [], roles: [{ on: id }, { on: id }, { on: id }] };
    },
  },
];
