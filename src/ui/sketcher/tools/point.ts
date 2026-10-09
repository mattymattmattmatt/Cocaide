// Point, as SOLIDWORKS has it: a sketch point on its own, for a hole centre,
// a pattern instance or a dimension's anchor. Clicked on a line's middle or
// on a curve, it stays there.

import type { SketchToolDef } from "./types";

export const tools: SketchToolDef[] = [
  {
    id: "sketch.point",
    name: "point",
    label: "Point",
    icon: "point",
    title: "Point: click where it goes. A sketch point never makes a profile; holes and patterns can use it",
    clicks: 1,
    prompts: ["Click where the point goes"],
    build: (clicks, _options, ids) => {
      const id = ids("p");
      return { entities: [{ id, type: "point", at: clicks[0].p }], relations: [], roles: [{ point: `${id}.at` }] };
    },
  },
];
