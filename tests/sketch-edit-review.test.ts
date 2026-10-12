// Regressions found in review of the sketch edit tools: trimming away a whole
// offset entity keeps the rest of the offset driven; scaling a dimension typed
// as an expression keeps the scaled number; Check sketch names the right end;
// a chamfer's angle dimension reads as typed at every corner; offset
// relations are validated strictly; the edit strip hides options that do not
// apply.

import { describe, expect, it } from "vitest";
import type { Constraint, SketchEntity, Vec2 } from "../src/doc/types";
import { allErrors, validateDocument } from "../src/doc/validate";
import { checkConstraints } from "../src/geom/constraints";
import { sketchDof, solveSketch } from "../src/geom/solver";
import { checkSketch } from "../src/geom/sketchEdit/check";
import { chamferCorners, cornersOf } from "../src/geom/sketchEdit/fillet";
import { offsetEntities } from "../src/geom/sketchEdit/offset";
import type { Edit, SketchState } from "../src/geom/sketchEdit/relations";
import { transformEntities } from "../src/geom/sketchEdit/transform";
import { trimAt } from "../src/geom/sketchEdit/trim";
import { renamed } from "../src/ui/sketcher/model";
import { editByName } from "../src/ui/sketcher/edit";
import { optionValues } from "../src/ui/sketcher/tools/run";

const ok = (r: Edit | string): Edit => {
  if (typeof r === "string") throw new Error(r);
  return r;
};
const line = (id: string, start: Vec2, end: Vec2): SketchEntity => ({ id, type: "line", start, end });

/** A 40 × 30 rectangle from the origin: four joined lines, level and plumb. */
function rectangle(): SketchState {
  const p: Vec2[] = [[0, 0], [40, 0], [40, 30], [0, 30]];
  const entities: SketchEntity[] = p.map((a, i) => line(`l${i + 1}`, a, p[(i + 1) % 4]));
  const constraints: Constraint[] = [
    ...entities.map((l, i): Constraint => ({ type: "coincident", points: [`${l.id}.end`, `l${((i + 1) % 4) + 1}.start`] })),
    { type: "horizontal", entity: "l1" },
    { type: "vertical", entity: "l2" },
    { type: "horizontal", entity: "l3" },
    { type: "vertical", entity: "l4" },
  ];
  return { entities, constraints };
}

describe("trim keeps an offset driven", () => {
  it("trimming away a whole offset side drops only that side's pair: the other three stay at the one distance", () => {
    // Inside (the rectangle runs anticlockwise: its left), 34 × 24.
    const off = ok(offsetEntities(rectangle(), ["l1"], { distance: 3, side: 1 }));
    const made = off.made!;
    const at = (s: { entities: SketchEntity[] }, y: number) =>
      s.entities.find((e) => made.includes(e.id) && e.type === "line" && Math.abs(e.start[1] - y) < 1e-6 && Math.abs(e.end[1] - y) < 1e-6)!;
    const bottom = at(off, 3);
    // Its ends meet only its neighbours' ends: trimming it takes it all.
    const r = ok(trimAt(off, bottom.id, [20, 3]));
    expect(r.entities.some((e) => e.id === bottom.id)).toBe(false);
    const k = r.constraints.find((c) => c.type === "offset");
    expect(k?.type === "offset" && k.offsets).toEqual(made.filter((id) => id !== bottom.id));
    expect(checkConstraints(r.entities, r.constraints)).toEqual([]);
    // The one value still drives the rest: 5 puts the top side 5 under the rectangle's top.
    const driven = solveSketch(r.entities, r.constraints.map((c) => (c.type === "offset" ? { ...c, value: 5 } : c)));
    if (!driven.ok) throw new Error(driven.error);
    const y = (id: string) => {
      const e = driven.entities.find((x) => x.id === id);
      return e?.type === "line" ? e.start[1] : NaN;
    };
    expect(y("l3") - y(at(r, 27).id)).toBeCloseTo(5, 6);
  });
});

describe("scale and expressions", () => {
  it("a dimension typed as an expression keeps its scaled number, not the expression that would put the old size back", () => {
    const s = rectangle();
    const withDims: SketchState = {
      entities: s.entities,
      constraints: [...s.constraints, { type: "distance", entity: "l1", value: 40, expr: "=w" } as Constraint, { type: "distance", entity: "l2", value: 30 }],
    };
    const r = ok(transformEntities(withDims, ["l1", "l2", "l3", "l4"], { kind: "scale", center: [0, 0], factor: 2 }));
    const dims = r.constraints.filter((c) => c.type === "distance");
    expect(dims).toEqual([
      { type: "distance", entity: "l1", value: 80 },
      { type: "distance", entity: "l2", value: 60 },
    ]);
    // A move keeps the expression: the size does not change.
    const m = ok(transformEntities(withDims, ["l1", "l2", "l3", "l4"], { kind: "move", by: [5, 0] }));
    expect(m.constraints).toContainEqual({ type: "distance", entity: "l1", value: 40, expr: "=w" });
  });
});

describe("check sketch names the end that touches", () => {
  it("a line's start on another line part way along reads 'start', its end 'end'", () => {
    const entities = [line("l1", [0, 0], [40, 0]), line("l2", [10, 0], [10, 10]), line("l3", [20, 10], [20, 0])];
    const texts = checkSketch(entities).problems.filter((p) => p.kind === "touch").map((p) => p.text);
    expect(texts).toEqual(["l2's start touches l1 part way along", "l3's end touches l1 part way along"]);
  });

  it("an arc's two ends on a line read as its start and its end", () => {
    const arc: SketchEntity = { id: "a1", type: "arc", center: [20, 0], start: [10, 0], end: [30, 0], clockwise: true };
    const texts = checkSketch([line("l1", [0, 0], [40, 0]), arc]).problems.filter((p) => p.kind === "touch").map((p) => p.text);
    expect(texts.sort()).toEqual(["a1's end touches l1 part way along", "a1's start touches l1 part way along"]);
  });
});

describe("chamfer by distance and angle", () => {
  it("the angle dimension reads as typed at every corner of a rectangle (never 180° less it)", () => {
    for (const pt of ["l1.end", "l2.end", "l3.end", "l4.end"]) {
      const c = cornersOf(rectangle(), { entities: [], points: [pt] });
      if (typeof c === "string") throw new Error(c);
      const r = ok(chamferCorners(c.state, c.corners, { kind: "angle", d: 5, angle: 30 }));
      const angle = r.constraints.find((k) => k.type === "angle");
      expect(angle && "value" in angle ? angle.value : NaN).toBeCloseTo(30, 9);
      expect(checkConstraints(r.entities, r.constraints)).toEqual([]);
      expect(sketchDof(r.entities, r.constraints)).toBe(4);
      // Its length: 5 along the first side, 5·tan 30° along the other.
      const l5 = r.entities.find((e) => e.id === "l5");
      expect(l5?.type === "line" ? Math.hypot(l5.end[0] - l5.start[0], l5.end[1] - l5.start[1]) : NaN).toBeCloseTo(5 / Math.cos(Math.PI / 6), 9);
    }
  });
});

describe("the offset relation's validation", () => {
  const doc = (k: unknown) =>
    allErrors(
      validateDocument({
        version: 1,
        name: "t",
        units: "mm",
        features: [
          {
            id: "s1",
            op: "sketch",
            plane: { type: "datum", origin: [0, 0, 0], normal: [0, 0, 1] },
            entities: [
              line("l1", [0, 0], [10, 0]),
              line("l2", [0, 2], [10, 2]),
              { id: "a1", type: "arc", center: [0, 0], start: [0, 2], end: [-2, 0] },
              { id: "c1", type: "circle", center: [20, 0], radius: 3 },
            ],
            constraints: [k],
          },
        ],
      }),
    ).join("; ");
  it("takes lines beside lines and arcs round points", () => {
    expect(doc({ type: "offset", entities: ["l1", "l1.start"], offsets: ["l2", "a1"], value: 2 })).toBe("");
  });
  it("refuses what it can't mean, saying why", () => {
    expect(doc({ type: "offset", entities: ["l1"], offsets: ["l2", "a1"], value: 2 })).toContain("same length");
    expect(doc({ type: "offset", entities: ["l1"], offsets: ["c1"], value: 2 })).toMatch(/offsets\[0\]/);
    expect(doc({ type: "offset", entities: ["l1"], offsets: ["l1"], value: 2 })).toContain("its own base");
    expect(doc({ type: "offset", entities: ["l1", "l1.end"], offsets: ["l2", "l2"], value: 2 })).toMatch(/offsets\[1\]/);
    expect(doc({ type: "offset", entities: ["l1"], offsets: ["l2"], value: -2 })).toContain("value");
    expect(doc({ type: "offset", entities: ["l1"], offsets: ["l2"], value: 2, side: 1 })).toContain("side");
    expect(doc({ type: "offset", entities: ["nope"], offsets: ["l2"], value: 2 })).toContain("nope");
  });
});

describe("renaming model stand-ins", () => {
  it("renames an offset relation's point bases as well as its entity bases", () => {
    const k: Constraint = { type: "offset", entities: ["m1", "m1.end"], offsets: ["l2", "a1"], value: 2 };
    expect(renamed(k, new Map([["m1", "l9"]]))).toEqual({ type: "offset", entities: ["l9", "l9.end"], offsets: ["l2", "a1"], value: 2 });
  });
});

describe("the edit strip shows the options that apply", () => {
  const shown = (tool: string, stored: Record<string, string | number>) => {
    const def = editByName(tool)!;
    const values = optionValues(def, stored);
    return (def.options ?? []).filter((o) => o.shown?.(values) ?? true).map((o) => o.key);
  };
  it("chamfer: Equal hides Distance 2; Angle shows the angle and hides the distances' choices", () => {
    expect(shown("chamfer", {})).toEqual(["mode", "distance", "equal"]);
    expect(shown("chamfer", { equal: "off" })).toEqual(["mode", "distance", "equal", "distance2"]);
    expect(shown("chamfer", { mode: "angle" })).toEqual(["mode", "distance", "angle"]);
  });
  it("offset: the end caps only with both directions", () => {
    expect(shown("offset", {})).not.toContain("cap");
    expect(shown("offset", { both: "on" })).toContain("cap");
  });
});
