// The sketcher's side of references to the model (DESIGN §2.4): the model's
// edges projected with their identity, picked faces, references made from
// stand-ins when the sketch relates or dimensions to them, Convert Entities,
// readable names, the sketch axes in the suggestions, snapping onto the
// model, a polygon's grouped glyphs, and the part as it stood before a sketch.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import type { Constraint, SketchEntity } from "../src/doc/types";
import { planeFrame } from "../src/geom/frame";
import { buildProfile } from "../src/geom/profile";
import { sketchDof, solveSketch } from "../src/geom/solver";
import { describeEdges, describeFaces, loadOC, rebuild, scoped, tessellate, type OC } from "../src/kernel";
import { relationGlyphs, relationGroups } from "../src/ui/sketcher/annotate";
import { axesAllowed, constraintSentence, describeConstraint, itemEntities, suggestions } from "../src/ui/sketcher/draft";
import { convertEdges, faceAt, isModelId, materialize, modelEdge, modelEntities, modelIdsOf, modelView, renamed, type ModelView } from "../src/ui/sketcher/model";
import { directionWord, namer, referenceName } from "../src/ui/sketcher/names";
import { place, snapClick, toolByName } from "../src/ui/sketcher/tools/run";
import { beforeKey, documentBefore, Recent } from "../src/worker/before";
import { withAxes } from "../src/geom/axes";

const PI = Math.PI;
const bracket: RawDocument = JSON.parse(readFileSync(new URL("../examples/bracket.cocaide.json", import.meta.url), "utf8"));
const TOP_FRAME = planeFrame([0, 0, 1], [0, 0, 6]);

let oc: OC;
let model: ModelView;
beforeAll(async () => {
  oc = await loadOC();
  // The bracket as the app's worker describes it: mesh, faces and edges.
  const r = rebuild(bracket, oc);
  try {
    const mesh = tessellate(oc, r.solid!);
    const topo = scoped((s) => {
      const f = describeFaces(oc, s, r.solid!);
      return { faces: f.infos, edges: describeEdges(oc, s, r.solid!, f.faces).infos };
    });
    model = modelView({ mesh, ...topo }, TOP_FRAME);
  } finally {
    r.dispose();
  }
});

/** The model edge whose stand-in lies along x = 40 in the top face (the plate's right-hand edge). */
const rightEdge = () => model.edges.find((e) => e.inPlane && e.entity?.type === "line" && Math.abs(e.entity.start[0] - 40) < 1e-9 && Math.abs(e.entity.end[0] - 40) < 1e-9)!;

describe("the model as the sketcher sees it", () => {
  it("every edge but the hole's seam, with its identity, kind and exact projection; the top face's in the plane", () => {
    // 12 edges of the plate and the hole's two rims; the seam is no edge.
    expect(model.edges).toHaveLength(14);
    expect(model.edges.filter((e) => e.inPlane)).toHaveLength(5);
    // The 4 upright edges are seen end-on: points, which can't be referenced, and say so.
    const endOn = model.edges.filter((e) => !e.entity);
    expect(endOn).toHaveLength(4);
    expect(endOn[0].problem).toMatch(/square to the sketch plane/);
    expect(model.edges.filter((e) => e.entity?.type === "circle").map((e) => Math.round((e.entity as { radius: number }).radius * 1e9) / 1e9)).toEqual([3.3, 3.3]);
    expect(rightEdge().id).toMatch(/^@e\d+$/);
    expect(rightEdge().poly.length).toBeGreaterThanOrEqual(2);
    // Stand-ins in the plane come first, so they win a pick over the edges below them.
    const ents = modelEntities(model);
    expect(ents.slice(0, 5).every((e) => modelEdge(model, e.id)!.inPlane)).toBe(true);
    expect(ents.every((e) => isModelId(e.id) && e.ref && e.construction)).toBe(true);
  });

  it("the faces along the sketch: the top one in its plane, the bottom one under it; a click inside picks the top", () => {
    expect(model.faces.map((f) => f.inPlane).sort()).toEqual([false, true]);
    const top = faceAt(model, [-20, 10])!;
    expect(top.inPlane).toBe(true);
    expect(top.edges).toHaveLength(5); // 4 sides and the hole's rim
    expect(faceAt(model, [30, 0])).toBeNull(); // in the hole
    expect(faceAt(model, [60, 0])).toBeNull(); // off the part
  });
});

describe("references made from the model edges a relation names", () => {
  it("a stand-in becomes a construction reference with a selector that finds the edge again; a second use reuses it", () => {
    const c1: SketchEntity = { id: "c1", type: "circle", center: [20, 10], radius: 3 };
    const raw: Constraint = { type: "distance", point: "c1.center", line: rightEdge().id, value: 12 };
    expect(modelIdsOf(raw)).toEqual([rightEdge().id]);
    const made = materialize(modelIdsOf(raw), model, [c1]);
    if (typeof made === "string") throw new Error(made);
    expect(made.added).toHaveLength(1);
    const ref = made.added[0] as SketchEntity & { start: number[] };
    expect(ref).toMatchObject({ id: "l1", type: "line" });
    expect(ref.construction).toBeUndefined(); // construction by default, as a reference
    expect(ref.start[0]).toBe(40); // clean numbers in the document
    // The edge between the top face and the right-hand face: it stays that edge when the plate changes size.
    const sel = (ref.ref as { edge: { between: unknown[]; pick: string } }).edge;
    expect(sel.pick).toBe("all");
    expect(sel.between).toHaveLength(2);
    expect(sel.between).toContainEqual({ type: "planar", normal: [0, 0, 1], pick: "largest" });
    expect(sel.between).toContainEqual({ type: "planar", normal: [1, 0, 0], pick: "largest" });
    const k = renamed(raw, made.ids);
    expect(k).toEqual({ type: "distance", point: "c1.center", line: "l1", value: 12 });
    // Solved: the circle moves 12 from the edge; the reference doesn't move; no freedom but the circle's y and radius.
    const r = solveSketch(made.entities, [k]);
    expect(r.ok && (r.entities[0] as { center: number[] }).center[0]).toBeCloseTo(28, 9);
    expect(sketchDof(made.entities, [k])).toBe(2);
    // Used again (a point of it this time), the same reference.
    const again = materialize([`${rightEdge().id}.end`], model, made.entities);
    if (typeof again === "string") throw new Error(again);
    expect(again.added).toEqual([]);
    expect(again.ids.get(rightEdge().id)).toBe("l1");
    expect(renamed({ type: "coincident", points: [`${rightEdge().id}.end`, "c1.center"] }, again.ids)).toEqual({ type: "coincident", points: ["l1.end", "c1.center"] });
  });

  it("an edge seen end-on can't be referenced: the reason, not a guess", () => {
    const upright = model.edges.find((e) => !e.entity)!;
    expect(materialize([upright.id], model, [])).toMatch(/^that model edge can't be referenced: the straight edge is square to the sketch plane/);
  });

  it("Convert Entities: a face's outline as profile references, joined where they meet; it rebuilds and extrudes", () => {
    const top = faceAt(model, [-20, 10])!;
    const r = convertEdges([], [top.index], model, [], [], false);
    if (typeof r === "string") throw new Error(r);
    expect(r.count).toBe(5);
    expect(r.entities.every((e) => e.ref && e.construction === false)).toBe(true);
    expect(r.constraints).toHaveLength(4);
    expect(r.constraints.every((k) => k.type === "coincident")).toBe(true);
    expect(sketchDof(r.entities, r.constraints)).toBe(0);
    const p = buildProfile(r.entities);
    expect(p.ok && p.regions.length).toBe(1);
    expect(p.ok && p.area).toBeCloseTo(80 * 40 - PI * 3.3 ** 2, 6);
    // As construction: the same references, construction.
    const c = convertEdges([rightEdge().id], [], model, [], [], true);
    if (typeof c === "string") throw new Error(c);
    expect(c.entities.map((e) => e.construction)).toEqual([undefined]);
    // Converting an edge already referenced turns that reference into profile geometry, not a second copy.
    const twice = convertEdges([rightEdge().id], [], model, c.entities, [], false);
    if (typeof twice === "string") throw new Error(twice);
    expect(twice.entities).toHaveLength(1);
    expect(twice.entities[0].construction).toBe(false);
    // The rebuild finds every edge again from its selector.
    const doc = {
      ...bracket,
      features: [
        ...bracket.features,
        { id: "sk", op: "sketch", plane: { type: "ref", ref: { face: { type: "planar", normal: [0, 0, 1], pick: "largest" } } }, entities: r.entities, constraints: r.constraints },
        { id: "up", op: "extrude", sketch: "sk", distance: 10 },
      ],
    };
    const b = rebuild(doc, oc);
    try {
      expect(b.errors).toEqual([]);
      expect(b.measurements!.volume).toBeCloseTo(80 * 40 * 6 - PI * 3.3 ** 2 * 6 + (80 * 40 - PI * 3.3 ** 2) * 10, 4);
    } finally {
      b.dispose();
    }
  });

  it("nothing to convert says what to pick", () => {
    expect(convertEdges([], [], model, [], [])).toBe("nothing to convert: pick model edges or a face first");
  });
});

describe("names, rows and suggestions", () => {
  const ref = { edge: { type: "edge" as const, pick: "all" as const } };
  const e1: SketchEntity = { id: "l1", type: "line", start: [40, -20], end: [40, 20], ref };
  const c1: SketchEntity = { id: "c1", type: "circle", center: [28, 0], radius: 3 };

  it("a reference by what it is, a point by its entity and name, the axes by name", () => {
    const n = namer([e1, c1]);
    expect(n.entity("l1")).toBe("model edge (straight, 40 mm, +Y)");
    expect(n.point("c1.center")).toBe("c1 centre");
    expect(n.point("l1.start")).toBe("model edge (straight, 40 mm, +Y) start");
    expect(n.entity("X")).toBe("X axis");
    expect(n.point("origin")).toBe("origin");
    expect(referenceName({ id: "p1", type: "point", at: [0, 0], ref: { datum: "Origin" } })).toBe("Origin");
    expect(referenceName({ id: "a", type: "line", start: [0, 0], end: [0, 1], ref: { datum: "Z" } })).toBe("axis Z");
    expect(directionWord([3, 3])).toBe("at 45°");
    // Two that read the same are told apart by their ids.
    const twin: SketchEntity = { id: "l2", type: "line", start: [-40, -20], end: [-40, 20], ref };
    expect(namer([e1, twin]).entity("l2")).toBe("model edge l2 (straight, 40 mm, +Y)");
  });

  it("the relation list reads them; the row's sentence says it whole", () => {
    const n = namer([e1, c1]);
    const k: Constraint = { type: "distance", point: "c1.center", line: "l1", value: 12 };
    expect(describeConstraint(k, n)).toBe("c1 centre ↔ model edge (straight, 40 mm, +Y)");
    expect(constraintSentence(k, "Distance", n)).toBe("Distance 12 mm: c1 centre — model edge (straight, 40 mm, +Y)");
    // Without names, as before.
    expect(describeConstraint(k)).toBe("c1.center ↔ l1");
    expect(describeConstraint({ type: "horizontal", entity: "l9" })).toBe("l9 horizontal");
  });

  it("suggestions with a sketch axis: the relations a line can have with it, never one it can't", () => {
    const l2: SketchEntity = { id: "l2", type: "line", start: [0, 5], end: [10, 5] };
    const pool = withAxes([l2]);
    const offers = suggestions(pool, [
      { kind: "entity", id: "l2" },
      { kind: "entity", id: "X" },
    ]).map((o) => o.make(o.value ?? 0));
    expect(offers.map((k) => k.type)).toEqual(["parallel", "perpendicular", "collinear", "distance"]);
    // The distance between parallel lines is from a point of the sketch's own line to the axis.
    expect(offers[3]).toEqual({ type: "distance", point: "l2.start", line: "X", value: 5 });
    expect(axesAllowed({ type: "equal", entities: ["l2", "X"] })).toBe(false);
    expect(axesAllowed({ type: "distance", entity: "X", value: 1 })).toBe(false);
    expect(axesAllowed({ type: "pointOn", point: "l2.start", entity: "Y" })).toBe(true);
    // A circle and a model edge's stand-in: tangent, and centre to line.
    const stand = { ...e1, id: "@e3" } as SketchEntity;
    const s = suggestions([c1, stand], [
      { kind: "entity", id: "c1" },
      { kind: "entity", id: "@e3" },
    ]);
    expect(s.map((o) => o.testId)).toEqual(["c-tangent", "c-line-distance"]);
    expect(s[1].value).toBe(12);
  });

  it("a model edge picked beside sketch entities is not one of the sketch's to delete", () => {
    expect(itemEntities([{ kind: "entity", id: "c1" }, { kind: "entity", id: "@e3" }, { kind: "entity", id: "X" }, { kind: "face", index: 2 }], [c1])).toEqual(["c1"]);
  });
});

describe("snapping onto the model", () => {
  it("a click near a model corner lands on it, and the line drawn from there is tied to it by a coincident", () => {
    const line = toolByName("line")!;
    const ctx = { entities: [] as SketchEntity[], tol: 1, grid: 1, options: {}, model: modelEntities(model) };
    const at = snapClick(line, [], [40.4, 19.7], ctx);
    expect(at.p).toEqual([40, 20]);
    expect(at.ref).toMatch(/^@e\d+\.(start|end)$/);
    // Onto the edge's middle, and anywhere along it.
    expect(snapClick(line, [], [40.3, 0.2], ctx).on).toMatchObject({ type: "midpoint" });
    expect(snapClick(line, [], [40.3, 9], ctx)).toMatchObject({ p: [40, 9], on: { type: "pointOn" } });
    // The sketch's own geometry comes first.
    const mine: SketchEntity = { id: "p1", type: "point", at: [40, 20] };
    expect(snapClick(line, [], [40.4, 19.7], { ...ctx, entities: [mine] }).ref).toBe("p1.at");
    const made = place(line, [at, { p: [10, 30], ref: null }], {}, { entities: [] });
    expect(made!.inferred).toContainEqual({ type: "coincident", points: ["l1.start", at.ref] });
  });
});

describe("a polygon's relation glyphs, grouped", () => {
  it("one glyph for its equal sides and one for its corners on the circle; the rest as before", () => {
    const poly = place(toolByName("polygon")!, [{ p: [0, 0], ref: null }, { p: [10, 0], ref: null }], { sides: 6 }, { entities: [] })!;
    const ks = [...poly.relations, ...poly.inferred];
    const groups = relationGroups(ks);
    expect(groups.map((g) => g.map((i) => ks[i].type)[0]).sort()).toEqual(["equal", "pointOn"]);
    expect(groups.find((g) => ks[g[0]].type === "equal")).toHaveLength(5);
    expect(groups.find((g) => ks[g[0]].type === "pointOn")).toHaveLength(6);
    const glyphs = relationGlyphs(poly.entities, ks, 0.1);
    const grouped = glyphs.filter((g) => g.indices);
    expect(grouped).toHaveLength(2);
    // Without grouping there would be 10 + 6 glyphs for these alone; now 2.
    expect(glyphs.filter((g) => ks[g.index].type === "equal" || ks[g.index].type === "pointOn")).toHaveLength(2);
    // Two equal lines stay two glyphs each, as before.
    const two: Constraint[] = [{ type: "equal", entities: ["a", "b"] }];
    expect(relationGroups(two)).toEqual([]);
  });
});

describe("the part before a feature", () => {
  it("is the document up to, not including, the feature, without its drawing", () => {
    const doc = { ...bracket, drawing: { sheet: {} } };
    expect((documentBefore(doc, "hole_1") as RawDocument).features.map((f) => f.id)).toEqual(["sketch_1", "ext_1"]);
    expect((documentBefore(doc, "sketch_1") as RawDocument).features).toEqual([]);
    expect((documentBefore(doc, "nope") as RawDocument).features).toHaveLength(3);
    expect("drawing" in (documentBefore(doc, "hole_1") as object)).toBe(false);
    // A change after the feature doesn't change what is before it.
    const later = { ...bracket, features: bracket.features.map((f) => (f.id === "hole_1" ? { ...f, diameter: 9 } : f)) };
    expect(beforeKey(later, "hole_1")).toBe(beforeKey(bracket, "hole_1"));
    expect(beforeKey(later, "ext_1")).toBe(beforeKey(bracket, "ext_1"));
    expect(beforeKey(bracket, "ext_1")).not.toBe(beforeKey(bracket, "hole_1"));
  });

  it("is kept for a few documents, the oldest dropped first", () => {
    const r = new Recent<number>(2);
    r.set("a", 1);
    r.set("b", 2);
    expect(r.get("a")).toBe(1); // now the newest
    r.set("c", 3);
    expect(r.get("b")).toBeUndefined();
    expect(r.get("a")).toBe(1);
    expect(r.get("c")).toBe(3);
  });
});
