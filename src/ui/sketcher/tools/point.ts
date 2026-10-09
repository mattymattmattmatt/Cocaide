// Point, as SOLIDWORKS has it: a sketch point on its own, for a hole centre,
// a pattern instance or a dimension's anchor. Clicked on a line's middle or
// on a curve, it stays there. A click on a sketch point adds nothing: one
// point there is enough (a double-click would otherwise stack two).

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
    build: (clicks, _options, ids, ctx) => {
      // On a sketch point there is one already (a double-click lands twice): no second on top of it.
      const on = clicks[0].ref?.match(/^(.+)\.at$/)?.[1];
      if (on && ctx.entities.some((e) => e.id === on && e.type === "point")) return null;
      const id = ids("p");
      return { entities: [{ id, type: "point", at: clicks[0].p }], relations: [], roles: [{ point: `${id}.at` }] };
    },
  },
];
