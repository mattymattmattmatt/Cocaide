// The sketch tool registry (Phase O): every drawing tool builds plain lines,
// arcs, circles and points held in shape by relations, so the result trims,
// fillets and dimensions like anything else and keeps its shape under a drag
// with only its natural degrees of freedom left; the clicks' snaps become
// relations; and the registry's commands, icons and test ids hang together.

import { describe, expect, it } from "vitest";
import type { Constraint, SketchEntity, Vec2 } from "../src/doc/types";
import { checkConstraints } from "../src/geom/constraints";
import { buildProfile } from "../src/geom/profile";
import { sketchStatus, solveSketch, wouldOverDefine } from "../src/geom/solver";
import { place, toolByName, type Placement } from "../src/ui/sketcher/tools/run";
import type { Click, ToolOptions } from "../src/ui/sketcher/tools/types";

const at = (...pts: Vec2[]): Click[] => pts.map((p) => ({ p, ref: null }));

/** Places a tool's clicks on an empty sketch (or the given one), as the canvas would. */
function draw(name: string, clicks: Click[], options: ToolOptions = {}, entities: SketchEntity[] = [], trail?: Vec2[]): Placement {
  const def = toolByName(name);
  if (!def) throw new Error(`no tool ${name}`);
  const made = place(def, clicks, options, { entities, trail });
  if (!made) throw new Error(`${name} made nothing`);
  return made;
}

/** The shape's own relations hold, none repeats another, and this many degrees of freedom are left. */
function expectSound(made: Placement, dof: number, base: SketchEntity[] = [], baseRelations: Constraint[] = []) {
  const entities = [...base, ...made.entities];
  const relations = [...baseRelations, ...made.relations];
  expect(checkConstraints(entities, relations)).toEqual([]);
  relations.forEach((k, i) => expect(wouldOverDefine(entities, relations.filter((_, j) => j !== i), k), JSON.stringify(k)).toBe(false));
  expect(sketchStatus(entities, relations).dof).toBe(dof);
}

describe("degrees of freedom: what each shape can still do", () => {
  it.each([
    ["line", at([0, 0], [30, 10]), {}, 4],
    ["centerline", at([0, 0], [30, 10]), {}, 4],
    ["midpoint-line", at([5, 5], [30, 10]), {}, 4],
    ["rect", at([-30, -10], [20, 15]), {}, 4],
    ["rect-center", at([3, 4], [20, 15]), {}, 4],
    ["rect3", at([0, 0], [30, 10], [20, 30]), {}, 5],
    ["parallelogram", at([0, 0], [30, 5], [40, 25]), {}, 6],
    ["polygon", at([1, 2], [21, 7]), { sides: 6 }, 4],
    ["polygon", at([1, 2], [21, 7]), { sides: 5, mode: "circumscribed" }, 4],
    ["polygon", at([1, 2], [21, 7]), { sides: 8, mode: "circumscribed" }, 4],
    ["polygon", at([1, 2], [21, 7]), { sides: 3 }, 4],
    ["polygon", at([1, 2], [21, 7]), { sides: 40 }, 4],
    ["circle", at([0, 0], [10, 0]), {}, 3],
    ["circle3", at([0, 0], [10, 3], [4, 12]), {}, 3],
    ["arc", at([0, 0], [10, 0], [0, 10]), {}, 5],
    ["arc3", at([0, 0], [20, 0], [10, 6]), {}, 5],
    ["slot", at([0, 0], [30, 10], [10, 12]), {}, 5],
    ["slot-center", at([0, 0], [30, 10], [10, 12]), {}, 5],
    ["point", at([3, 4]), {}, 2],
  ] as [string, Click[], ToolOptions, number][])("%s leaves %#", (name, clicks, options, dof) => {
    expectSound(draw(name, clicks, options), dof);
  });
});
