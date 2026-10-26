// References to another sketch's entities (Phase P wave 2A, DESIGN §2.9):
// { sketch, entity, at? } as a DatumRef. Validation (the sketch is earlier,
// the entity is there and can be what is asked), resolution from the solved
// sketch (a line is an axis, its end a point, an arc's centre a point), a
// sketch entity's ref re-projected from the other sketch (so a sketch
// dimensioned to another sketch's line follows it), renames that follow and
// deletes that are refused, and the sketcher's stand-ins for them.

import { beforeAll, describe, expect, it } from "vitest";
import { apply, dependants, type RawDocument } from "../src/doc/commands";
import type { SketchEntity, Vec3 } from "../src/doc/types";
import { allErrors, validateDocument } from "../src/doc/validate";
import { possibleKinds, sketchRefKinds, sketchRefText } from "../src/features/datum";
import { planeFrame } from "../src/geom/frame";
import { projectEdge } from "../src/geom/projection";
import { sketchEntityDatum, sketchEntityEdge, sketchEntityPoint2 } from "../src/geom/sketchEdge";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { danglingRefs, isModelId, isSketchStandIn, materialize, modelEdge, modelEntities, modelView, sketchStandIn, standInSource } from "../src/ui/sketcher/model";
import { namer, referenceName } from "../src/ui/sketcher/names";
import { REFERENCE } from "../src/mcp/reference";

const close = (a: readonly number[], b: readonly number[], digits = 9) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], digits));
const TOP = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };
const ABOVE = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 20] };

/** A vertical line 40 long at x = 10 (its distance from Y is constraint 1), an arc and a circle and a point, on Top. */
const sketchA = {
  id: "sketch_a",
  op: "sketch",
  plane: TOP,
  entities: [
    { id: "l1", type: "line", start: [10, 0], end: [10, 40] },
    { id: "a1", type: "arc", center: [-20, 0], start: [-10, 0], end: [-20, 10] },
    { id: "c1", type: "circle", center: [-40, 20], radius: 5 },
    { id: "p1", type: "point", at: [0, 30] },
    { id: "r1", type: "rect", center: [60, 0], w: 10, h: 10 },
  ],
  constraints: [
    { type: "vertical", entity: "l1" },
    { type: "distance", point: "l1.start", line: "Y", value: 10 },
    { type: "distance", point: "l1.start", line: "X", value: 0 },
    { type: "distance", entity: "l1", value: 40 },
  ],
};

/** 20 above Top: a reference to sketch_a's l1, and a Ø6 circle 15 from it, 20 up. */
const sketchB = {
  id: "sketch_b",
  op: "sketch",
  plane: ABOVE,
  entities: [
    { id: "r1", type: "line", start: [0, 0], end: [0, 1], ref: { sketch: "sketch_a", entity: "l1" } },
    { id: "c1", type: "circle", center: [25, 20], radius: 3 },
  ],
  constraints: [
    { type: "distance", point: "c1.center", line: "r1", value: 15 },
    { type: "distance", point: "c1.center", line: "X", value: 20 },
    { type: "diameter", entity: "c1", value: 6 },
  ],
};

const doc = (...features: Record<string, unknown>[]): RawDocument => ({ version: 1, units: "mm", name: "refs", features });
const errorsOf = (d: unknown) => allErrors(validateDocument(d));
const withRef = (ref: unknown, type = "line", extra: Record<string, unknown> = {}) =>
  doc(sketchA, { id: "sk", op: "sketch", plane: ABOVE, entities: [{ id: "e1", type, ...(type === "point" ? { at: [0, 0] } : type === "circle" ? { center: [0, 0], radius: 1 } : { start: [0, 0], end: [1, 0] }), ref, ...extra }] });

// ------------------------------------------------------------------ the document

describe("{ sketch, entity, at? } in the document", () => {
  it("a later sketch may reference an earlier one's line, circle, arc and point; the kinds come from the entity", () => {
    expect(errorsOf(doc(sketchA, sketchB))).toEqual([]);
    expect(errorsOf(withRef({ sketch: "sketch_a", entity: "c1" }, "circle"))).toEqual([]);
    expect(errorsOf(withRef({ sketch: "sketch_a", entity: "l1", at: "end" }, "point"))).toEqual([]);
    expect(errorsOf(withRef({ sketch: "sketch_a", entity: "a1" }, "point"))).toEqual([]); // an arc alone: its centre
    expect(errorsOf(withRef({ sketch: "sketch_a", entity: "p1" }, "point"))).toEqual([]);
    expect(sketchRefKinds("line")).toEqual(["axis"]);
    expect(sketchRefKinds("line", "end")).toEqual(["point"]);
    expect(sketchRefKinds("circle")).toEqual(["axis", "point"]);
    expect(sketchRefKinds("circle", "start")).toEqual([]);
    expect(sketchRefKinds("rect")).toEqual([]);
    expect(possibleKinds({ sketch: "s", entity: "e" })).toEqual(["axis", "point"]);
    expect(sketchRefText({ sketch: "sketch_a", entity: "a1", at: "center" })).toBe("the centre of sketch_a's a1");
  });

  it("refuses a sketch that is not earlier, not a sketch, or has no such entity, saying what to do", () => {
    expect(errorsOf(withRef({ sketch: "nope", entity: "l1" }))).toEqual([expect.stringMatching(/ref\.sketch: "nope" is not a feature before this one: a sketch can take only an earlier sketch's entities/)]);
    expect(errorsOf(withRef({ sketch: "sketch_a", entity: "zz" }))).toEqual([expect.stringMatching(/ref\.entity: sketch_a has no entity "zz" \(it has l1, a1, c1, p1, r1\): re-pick the reference, or delete it/)]);
    expect(errorsOf(withRef({ sketch: "sketch_a" }))).toEqual([expect.stringMatching(/needs one of datum, face, edge, point or sketch|ref\.entity: must be the id/)]);
    expect(errorsOf(withRef({ sketch: "sketch_a", entity: "r1" }))).toEqual([expect.stringMatching(/sketch_a's r1 is a rect: another sketch's lines, circles, arcs and points can be referenced/)]);
    expect(errorsOf(withRef({ sketch: "sketch_a", entity: "c1", at: "start" }, "point"))).toEqual([expect.stringMatching(/ref\.at: sketch_a's c1 is a circle: "at" may be "center" \(got "start"\)/)]);
    // A sketch referencing itself, or one after it: not earlier.
    const self = doc({ ...sketchB, entities: [...sketchB.entities, { id: "r2", type: "line", start: [0, 0], end: [1, 0], ref: { sketch: "sketch_b", entity: "c1" } }] }, sketchA);
    expect(errorsOf(self).join("\n")).toMatch(/"sketch_b" is not a feature before this one/);
    expect(errorsOf(self).join("\n")).toMatch(/"sketch_a" is not a feature before this one/);
    // An extrude is no sketch.
    const ext = doc(sketchA, { id: "ext", op: "extrude", sketch: "sketch_a", distance: 5 }, { ...sketchB, entities: [{ ...sketchB.entities[0], ref: { sketch: "ext", entity: "l1" } }, sketchB.entities[1]] });
    expect(errorsOf(ext).join("\n")).toMatch(/"ext" is an extrude, not a sketch/);
  });

  it("an entity takes only what it can be: a point needs a point of a line, a circle a circle, a line no point", () => {
    expect(errorsOf(withRef({ sketch: "sketch_a", entity: "l1" }, "point"))).toEqual([expect.stringMatching(/a point references .* not sketch_a's line l1 without "at" \(say which point of it\)/)]);
    expect(errorsOf(withRef({ sketch: "sketch_a", entity: "l1" }, "circle"))).toEqual([expect.stringMatching(/a circle references .* not sketch_a's line l1/)]);
    expect(errorsOf(withRef({ sketch: "sketch_a", entity: "p1" }))).toEqual([expect.stringMatching(/a line references .* not sketch_a's point p1/)]);
    expect(errorsOf(withRef({ sketch: "sketch_a", entity: "l1", at: "end" }))).toEqual([expect.stringMatching(/a line references .*not a point of sketch_a's line l1 \("at": "end"\); use a point entity for that/)]);
  });

  it("where a plane is needed a sketch entity is refused; where an axis or a point is, it is taken", () => {
    const plane = doc(sketchA, { id: "pl", op: "plane", mode: "offset", refs: [{ sketch: "sketch_a", entity: "l1" }], distance: 5 });
    expect(errorsOf(plane).join("\n")).toMatch(/sketch_a's l1 is an axis, but a plane is needed here/);
    const axis = doc(sketchA, { id: "ax", op: "axis", mode: "edge", refs: [{ sketch: "sketch_a", entity: "l1" }] });
    expect(errorsOf(axis)).toEqual([]);
    const point = doc(sketchA, { id: "pt", op: "point", mode: "center", refs: [{ sketch: "sketch_a", entity: "a1" }] });
    expect(errorsOf(point)).toEqual([]);
    const notPoint = doc(sketchA, { id: "pt", op: "point", mode: "intersection", refs: [{ sketch: "sketch_a", entity: "p1" }, { datum: "Top" }] });
    expect(errorsOf(notPoint).join("\n")).toMatch(/sketch_a's p1 is a point, but an axis is needed here/);
  });

  it("the referenced sketch is a dependant's parent: it can't be deleted, and a rename follows into the references", () => {
    const d = doc(sketchA, sketchB);
    expect(dependants(d.features, "sketch_a")).toEqual(["sketch_b"]);
    const del = apply(d, { type: "deleteFeature", id: "sketch_a" });
    expect(del).toEqual({ ok: false, error: "deleteFeature: sketch_a is used by sketch_b; delete or change it first" });
    const renamed = apply(d, { type: "updateFeature", id: "sketch_a", patch: { id: "layout" } });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    const b = renamed.doc.features.find((f) => f.id === "sketch_b") as { entities: { ref?: unknown }[] };
    expect(b.entities[0].ref).toEqual({ sketch: "layout", entity: "l1" });
    expect(errorsOf(renamed.doc)).toEqual([]);
    // Used some other way too (an extrude of it): the rename is refused, as before.
    const used = doc(sketchA, { id: "ext", op: "extrude", sketch: "sketch_a", distance: 5 }, sketchB);
    expect(apply(used, { type: "updateFeature", id: "sketch_a", patch: { id: "layout" } })).toEqual({ ok: false, error: "updateFeature: cannot rename sketch_a; ext uses it" });
  });

  it("an edit that deletes a referenced entity is refused, naming the sketch that references it", () => {
    const d = doc(sketchA, sketchB);
    const without = { ...sketchA, entities: sketchA.entities.filter((e) => e.id !== "l1"), constraints: [] };
    const r = apply(d, { type: "replaceFeature", id: "sketch_a", feature: without });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/replaceFeature rejected: sketch_b: entities\[0\] "r1" ref\.entity: sketch_a has no entity "l1" \(it has a1, c1, p1, r1\): re-pick the reference, or delete it/);
    expect(apply(d, { type: "deleteEntity", sketch: "sketch_a", id: "l1" }).ok).toBe(false);
  });
});

// ------------------------------------------------------------------ resolution (pure)

describe("another sketch's entity as reference geometry", () => {
  /** A sketch plane tilted 30° about X, raised 5: its y runs up the slope. */
  const c = Math.cos(Math.PI / 6);
  const s = Math.sin(Math.PI / 6);
  const tilted = planeFrame([0, -s, c], [0, 0, 5], [1, 0, 0]);
  const line: SketchEntity = { id: "l1", type: "line", start: [10, 0], end: [10, 40] };
  const arc: SketchEntity = { id: "a1", type: "arc", center: [-20, 0], start: [-10, 0], end: [-20, 10] };
  const cw: SketchEntity = { id: "a2", type: "arc", center: [0, 0], start: [0, 10], end: [10, 0], clockwise: true };

  it("a line is an axis from its start toward its end, in 3D through its sketch's frame", () => {
    const d = sketchEntityDatum(line, tilted, undefined, "axis");
    expect(d).toMatchObject({ kind: "axis" });
    if (typeof d === "string" || d.kind !== "axis") return;
    close(d.origin, [10, 0, 5]);
    close(d.direction, [0, c, s]); // the tilted y
    expect(sketchEntityDatum(line, tilted, undefined, "point")).toMatch(/l1 is a line: an axis, but a point is needed here; give "at"/);
  });

  it("a point of a line: its end, its middle", () => {
    const end = sketchEntityDatum(line, tilted, "end", "point");
    expect(end).toMatchObject({ kind: "point" });
    if (typeof end !== "string" && end.kind === "point") close(end.at, [10, 40 * c, 5 + 40 * s]);
    const mid = sketchEntityDatum(line, tilted, "mid", "any");
    if (typeof mid !== "string" && mid.kind === "point") close(mid.at, [10, 20 * c, 5 + 20 * s]);
    expect(sketchEntityPoint2(line, "center")).toMatch(/has no centre; use "mid"/);
  });

  it("an arc: its centre where a point is needed, else the axis through it square to its sketch (reversed when clockwise)", () => {
    const centre = sketchEntityDatum(arc, tilted, "center", "point");
    if (typeof centre !== "string" && centre.kind === "point") close(centre.at, [-20, 0, 5]);
    const axis = sketchEntityDatum(arc, tilted, undefined, "any");
    expect(axis).toMatchObject({ kind: "axis" });
    if (typeof axis !== "string" && axis.kind === "axis") {
      close(axis.origin, [-20, 0, 5]);
      close(axis.direction, [0, -s, c]);
    }
    const back = sketchEntityDatum(cw, tilted, undefined, "axis");
    if (typeof back !== "string" && back.kind === "axis") close(back.direction, [0, s, -c]);
    // Its middle: a quarter circle counter-clockwise from [-10, 0] about [-20, 0] is at 45°.
    const mid = sketchEntityPoint2(arc, "mid");
    close(mid as number[], [-20 + 10 * Math.SQRT1_2, 10 * Math.SQRT1_2]);
  });

  it("as an edge: a circle in a parallel sketch projects to a circle, a line square to the sketch to a point (refused)", () => {
    const top = planeFrame([0, 0, 1], [0, 0, 0]);
    const above = planeFrame([0, 0, 1], [0, 0, 20]);
    const circle = sketchEntityEdge({ id: "c1", type: "circle", center: [-40, 20], radius: 5 }, top);
    expect(typeof circle).not.toBe("string");
    if (typeof circle === "string") return;
    expect(projectEdge(circle, above)).toEqual({ ok: true, shape: { type: "circle", center: [-40, 20], radius: 5 } });
    const front = planeFrame([0, -1, 0], [0, 0, 0], [1, 0, 0]);
    const upright = sketchEntityEdge(line, front);
    if (typeof upright === "string") return;
    // l1 on Front runs up Z; projected onto Top it is a point.
    expect(projectEdge(upright, top).ok).toBe(false);
    expect(sketchEntityEdge({ id: "r1", type: "rect", center: [0, 0], w: 1, h: 1 }, top)).toMatch(/r1 is a rect: another sketch's lines, circles, arcs and points can be referenced/);
  });
});

// ------------------------------------------------------------------ rebuild

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

function built(d: unknown) {
  const r = rebuild(d, oc);
  try {
    return { errors: r.errors.filter((e) => !/no solid/.test(e)), sketches: r.sketches, datums: r.datums, features: r.features };
  } finally {
    r.dispose();
  }
}

const entityOf = (b: ReturnType<typeof built>, sketch: string, id: string) => b.sketches.find((s) => s.id === sketch)!.entities.find((e) => e.id === id) as unknown as Record<string, number[]>;

describe("the rebuild resolves sketch entities and re-projects references to them", () => {
  it("a circle dimensioned 15 from another sketch's line follows the line when that sketch changes", () => {
    const d = doc(sketchA, sketchB);
    const b = built(d);
    expect(b.errors).toEqual([]);
    // The reference is l1 projected 20 mm up: x = 10.
    close(entityOf(b, "sketch_b", "r1").start, [10, 0]);
    close(entityOf(b, "sketch_b", "r1").end, [10, 40]);
    close(entityOf(b, "sketch_b", "c1").center, [25, 20]);
    // l1 moves to x = 20: the circle goes with it, 15 from it (the solve starts from the stored geometry, x = 25).
    const moved = apply(d, { type: "setDimension", sketch: "sketch_a", index: 1, value: 20 });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const after = built(moved.doc);
    expect(after.errors).toEqual([]);
    close(entityOf(after, "sketch_b", "r1").start, [20, 0]);
    close(entityOf(after, "sketch_b", "c1").center, [35, 20]);
  });

  it("an axis along a sketch line, a point at an arc's centre and at a line's end", () => {
    const d = doc(
      sketchA,
      { id: "ax", op: "axis", mode: "edge", refs: [{ sketch: "sketch_a", entity: "l1" }] },
      { id: "pc", op: "point", mode: "center", refs: [{ sketch: "sketch_a", entity: "a1" }] },
      { id: "pe", op: "point", mode: "intersection", refs: [{ sketch: "sketch_a", entity: "a1" }, { datum: "Top" }] },
    );
    const b = built(d);
    expect(b.errors).toEqual([]);
    expect(b.datums.ax).toEqual({ kind: "axis", origin: [10, 0, 0], direction: [0, 1, 0] });
    expect(b.datums.pc).toEqual({ kind: "point", at: [-20, 0, 0] });
    // The arc's axis (square to Top through its centre) crosses Top at the centre.
    expect(b.datums.pe).toEqual({ kind: "point", at: [-20, 0, 0] });
  });

  it("a suppressed referenced sketch fails what references it, saying so", () => {
    const d = doc({ ...sketchA, suppressed: true }, sketchB);
    const b = built(d);
    expect(b.features.find((f) => f.id === "sketch_b")?.error).toMatch(/ref\.sketch: sketch "sketch_a" is suppressed.*so sketch_a's l1 is not there to use/);
  });
});

// ------------------------------------------------------------------ the sketcher

describe("the sketcher's stand-ins for other sketches' entities", () => {
  const frame = planeFrame([0, 0, 1], [0, 0, 20]);
  const a = { id: "sketch_a", ok: true, entities: sketchA.entities as SketchEntity[], frame: planeFrame([0, 0, 1], [0, 0, 0]) };
  const m = modelView({ mesh: null, edges: [], faces: [], sketches: [a, { ...a, id: "sketch_me" }] }, frame, { exclude: "sketch_me" });

  it("each entity of the other sketches in view stands in as @s:<sketch>:<entity>, projected into this plane", () => {
    expect(m.others.map((o) => o.id)).toEqual(["@s:sketch_a:l1", "@s:sketch_a:a1", "@s:sketch_a:c1", "@s:sketch_a:p1", "@s:sketch_a:r1"]);
    expect(sketchStandIn("sketch_a", "l1")).toBe("@s:sketch_a:l1");
    expect(isModelId("@s:sketch_a:l1.start") && isSketchStandIn("@s:sketch_a:l1.start")).toBe(true);
    expect(standInSource("@s:sketch_a:l1.end")).toEqual({ sketch: "sketch_a", entity: "l1" });
    const l1 = modelEdge(m, "@s:sketch_a:l1")!;
    expect(l1.entity).toMatchObject({ type: "line", start: [10, 0], end: [10, 40] });
    close(l1.poly3[0], [10, 0, 0]);
    expect(l1.inPlane).toBe(false);
    // The rectangle can't be referenced, and says so; the rest join the pool after the model's edges.
    expect(modelEdge(m, "@s:sketch_a:r1")!.problem).toMatch(/r1 is a rect/);
    expect(modelEntities(m).map((e) => e.id)).toEqual(["@s:sketch_a:l1", "@s:sketch_a:a1", "@s:sketch_a:c1", "@s:sketch_a:p1"]);
    expect(modelEdge(m, "@s:sketch_a:p1")!.source!.points).toEqual([{ name: "at", at: [0, 30, 0] }]);
  });

  it("used in a relation, a stand-in becomes a reference entity { sketch, entity }; one already there is reused", () => {
    const made = materialize(["@s:sketch_a:l1.start", "@s:sketch_a:c1"], m, []);
    if (typeof made === "string") throw new Error(made);
    expect(made.entities).toEqual([
      { id: "l1", type: "line", start: [10, 0], end: [10, 40], ref: { sketch: "sketch_a", entity: "l1" } },
      { id: "c1", type: "circle", center: [-40, 20], radius: 5, ref: { sketch: "sketch_a", entity: "c1" } },
    ]);
    expect([...made.ids]).toEqual([
      ["@s:sketch_a:l1", "l1"],
      ["@s:sketch_a:c1", "c1"],
    ]);
    const again = materialize(["@s:sketch_a:l1"], m, made.entities, { convert: true });
    if (typeof again === "string") throw new Error(again);
    expect(again.added).toEqual([]);
    expect(again.entities[0].construction).toBe(false);
    expect(referenceName(made.entities[0])).toBe("sketch_a l1 (straight, 40 mm, +Y)");
    expect(namer(made.entities, m).entity("@s:sketch_a:a1")).toBe("sketch_a a1 (arc R10)");
  });

  it("a reference whose sketch or entity is not in view dangles", () => {
    const refs: SketchEntity[] = [
      { id: "x1", type: "line", start: [0, 0], end: [1, 0], ref: { sketch: "sketch_a", entity: "l1" } },
      { id: "x2", type: "line", start: [0, 0], end: [1, 0], ref: { sketch: "sketch_a", entity: "gone" } },
      { id: "x3", type: "line", start: [0, 0], end: [1, 0], ref: { sketch: "sketch_me", entity: "l1" } },
    ];
    expect([...danglingRefs(refs, m)]).toEqual(["x2", "x3"]);
  });
});

describe("the AI reference documents the sketch form", () => {
  it("with examples", () => {
    expect(REFERENCE).toContain('{ "sketch": "<id>", "entity": "<entity id>", "at": "start" | "end" | "mid" | "center" (optional) }');
    expect(REFERENCE).toContain('"ref": { "sketch": "sk_base", "entity": "l2" }');
    const v: Vec3 = [0, 0, 0];
    expect(v).toHaveLength(3);
  });
});
