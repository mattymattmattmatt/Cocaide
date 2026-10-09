// The tools and editors of revolve, shell, draft and scale (Phase O wave 2):
// what each tool makes from the selection and the sketch (the revolve axis it
// finds, the faces a shell removes, the neutral plane a draft chooses), what
// they refuse and say, and the editors' rules (the patches their fields send).

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { REVOLVE_FIELDS, defaultAxisIn, preferredLine } from "../src/features/revolve/ui";
import { UI_OPS } from "../src/features/uiDefs";
import { loadOC, type OC } from "../src/kernel";
import { draftFeature, draftNeutral, shellFeature } from "../src/ui/model/tools/dress";
import { openProfile, revolveFeature, sketchAxisLine } from "../src/ui/model/tools/revolve";
import { mirrorFeature } from "../src/ui/model/tools/mirror";
import { PATTERNABLE } from "../src/ui/model/tools/pattern";
import { toolById } from "../src/ui/model/registry";
import { sketchFrameIn } from "../src/ui/model/sketchPlane";
import { scaleFeature } from "../src/ui/model/tools/scale";
import { commitPatch, visibleFields, type FieldSpec, type FormContext } from "../src/ui/props/spec";
import { EMPTY_SELECTION } from "../src/ui/model/selection";
import { example, faceWhere, harness, viewOf } from "./ui-fixtures";

type Raw = Record<string, unknown>;

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

const RECT = { id: "r1", type: "rect", center: [15, 10], w: 10, h: 20 };
const CENTERLINE = { id: "c1", type: "line", start: [0, 0], end: [0, 30], construction: true };
const sketchDoc = (entities: Raw[], ...more: Raw[]): RawDocument => ({
  version: 1,
  units: "mm",
  name: "t",
  features: [{ id: "sketch_1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities, constraints: [] }, ...more],
});
const boxDoc = (): RawDocument => ({
  version: 1,
  units: "mm",
  name: "box",
  features: [
    { id: "s1", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "r1", type: "rect", center: [0, 0], w: 20, h: 20 }], constraints: [] },
    { id: "ext_1", op: "extrude", sketch: "s1", distance: 20 },
  ],
});

describe("Revolve: the axis it finds", () => {
  it("a centreline with the profile on one side; not one through the profile", () => {
    expect(sketchAxisLine([RECT, CENTERLINE] as never)).toEqual({ line: "c1" });
    const through = { id: "c0", type: "line", start: [15, -5], end: [15, 30], construction: true };
    expect(sketchAxisLine([RECT, through, CENTERLINE] as never)).toEqual({ line: "c1" });
    expect(sketchAxisLine([RECT, through] as never)).toBe(
      "Every centreline of the sketch runs through the profile: draw one beside it (Shift+L), or select an axis or a straight edge, then Revolve.",
    );
  });

  it("else the one line drawn apart from the profile; else it asks for one", () => {
    expect(sketchAxisLine([RECT, { ...CENTERLINE, construction: undefined }] as never)).toEqual({ line: "c1" });
    expect(sketchAxisLine([RECT] as never)).toBe("Draw a centreline in the sketch to turn about (Shift+L), or select an axis or a straight edge, then Revolve.");
  });

  it("makes the revolve of the latest sketch about it, or a revolved cut; asks for a sketch first", () => {
    const doc = sketchDoc([RECT, CENTERLINE]);
    const { ctx, out } = harness(doc, viewOf(oc, doc));

    const f = revolveFeature(ctx, false);
    expect(f).toEqual({ id: "revolve_1", op: "revolve", sketch: "sketch_1", axis: { line: "c1" } });
    expect(allErrors(validateDocument({ ...doc, features: [...doc.features, f as Raw] }))).toEqual([]);
    expect(revolveFeature(ctx, true)).toBe("A revolved cut needs a solid to cut: make one first.");
    expect(out.created).toEqual([]);
    const empty = { version: 1, units: "mm", name: "e", features: [] } as RawDocument;
    expect(revolveFeature(harness(empty, null).ctx, false)).toBe("Make a sketch with a profile and a centreline first, then Revolve.");
  });

  it("a revolved cut on a part removes; an axis or straight edge selected in the view is the axis", () => {
    const bracket = example("bracket");
    const doc = { ...bracket, features: [...bracket.features, { id: "s2", op: "sketch", plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] }, entities: [{ id: "g", type: "rect", center: [0, 10], w: 10, h: 10 }], constraints: [] }] };
    const view = viewOf(oc, doc);
    const { ctx } = harness(doc, view, { selection: { faces: [], edges: [], datums: ["X"] } });
    expect(revolveFeature(ctx, true)).toEqual({ id: "revolve_cut_1", op: "revolve", sketch: "s2", axis: { datum: "X" }, operation: "remove" });
  });
});

describe("Shell and Draft: from the selection", () => {
  it("Shell removes the selected faces, 2 mm walls; nothing selected, a closed hollow body", () => {
    const doc = boxDoc();
    const view = viewOf(oc, doc);
    const top = faceWhere(view, (f) => f.type === "plane" && f.normal![2] > 0.5);
    const picked = harness(doc, view, { selection: { faces: [top], edges: [] } });
    expect(shellFeature(picked.ctx)).toEqual({ id: "shell_1", op: "shell", faces: [{ type: "planar", normal: [0, 0, 1], pick: "largest" }], thickness: 2 });
    expect(shellFeature(harness(doc, view).ctx)).toEqual({ id: "shell_1", op: "shell", faces: [], thickness: 2 });
    expect(shellFeature(harness({ ...doc, features: [] }, null).ctx)).toBe("Shell needs a solid: make one first.");
  });

  it("Draft about the bottom face when only the sides are picked; about a picked base face; 3°", () => {
    const doc = boxDoc();
    const view = viewOf(oc, doc);
    const side = (n: number[]) => faceWhere(view, (f) => f.type === "plane" && f.normal!.every((c, i) => Math.abs(c - n[i]) < 1e-9));
    const sides = [side([1, 0, 0]), side([-1, 0, 0]), side([0, 1, 0]), side([0, -1, 0])];
    const f = draftFeature(harness(doc, view, { selection: { faces: sides, edges: [] } }).ctx) as Raw;
    expect(f.neutral).toEqual({ face: { type: "planar", normal: [0, 0, -1], pick: "largest" } });
    expect(f.angle).toBe(3);
    expect(f.faces).toHaveLength(4);
    // The top face picked with one side: square to it, so it is the base the side drafts about.
    const withBase = draftFeature(harness(doc, view, { selection: { faces: [side([1, 0, 0]), side([0, 0, 1])], edges: [] } }).ctx) as Raw;
    expect(withBase.neutral).toEqual({ face: { type: "planar", normal: [0, 0, 1], pick: "largest" } });
    expect(withBase.faces).toEqual([{ type: "planar", normal: [1, 0, 0], pick: "largest" }]);
    // Two adjacent sides are square to each other, yet neither is a base: both are drafted, about the bottom.
    const adjacent = draftFeature(harness(doc, view, { selection: { faces: [side([1, 0, 0]), side([0, -1, 0])], edges: [] } }).ctx) as Raw;
    expect(adjacent.neutral).toEqual({ face: { type: "planar", normal: [0, 0, -1], pick: "largest" } });
    expect(adjacent.faces).toHaveLength(2);
    expect(draftFeature(harness(doc, view).ctx)).toBe("Click the faces to taper (Ctrl-click for more; add the base face to draft about it), then Draft.");
  });

  it("chooses a picked plane, or a default plane square to every face; else says to pick one", () => {
    const flat = (index: number, normal: number[], offset = 0) => ({ index, type: "plane" as const, area: 1, centroid: [0, 0, 0] as [number, number, number], normal: normal as [number, number, number], offset });
    const xFace = flat(0, [1, 0, 0]);
    expect(draftNeutral([xFace], [xFace], [{ id: "plane_1", kind: "plane" }])).toEqual({ neutral: { datum: "plane_1" }, faces: [xFace] });
    expect(draftNeutral([xFace], [xFace])).toEqual({ neutral: { datum: "Top" }, faces: [xFace] });
    const zFace = flat(1, [0, 0, 1]);
    expect(draftNeutral([zFace], [zFace])).toEqual({ neutral: { datum: "Front" }, faces: [zFace] });
    const slanted = flat(2, [Math.SQRT1_2, 0, Math.SQRT1_2]);
    expect(draftNeutral([slanted, flat(3, [0, 1, 0])], [slanted])).toBe(
      "No default plane is square to all those faces: pick the neutral plane (a flat face or a plane) with them, or set it in Properties.",
    );
  });

  it("Scale: every body of a one-body part, or the clicked body of several, 2 about its centroid", () => {
    const doc = boxDoc();
    expect(scaleFeature(harness(doc, viewOf(oc, doc)).ctx)).toEqual({ id: "scale_1", op: "scale", factor: 2, about: "centroid" });
    const stand = example("stand");
    const view = viewOf(oc, stand);
    const upright = faceWhere(view, (f) => f.body === "upright");
    expect(scaleFeature(harness(stand, view, { selection: { faces: [upright], edges: [] } }).ctx)).toEqual({ id: "scale_1", op: "scale", factor: 2, about: "centroid", bodies: ["upright"] });
  });
});

describe("the revolve editor's rules", () => {
  const field = (key: string, testId?: string) => REVOLVE_FIELDS.find((s) => s.key === key && (!testId || s.testId === testId)) as FieldSpec;
  const before = [{ id: "sketch_1", op: "sketch", entities: [{ id: "l1", type: "line" }, { id: "c1", type: "line", construction: true }] }];
  const ctx = (f: Raw, bodies: string[] = []): FormContext => ({ f, resolved: f, before, bodies, doc: { features: [] } as never, view: null, selection: EMPTY_SELECTION });
  const f = { id: "revolve_1", op: "revolve", sketch: "sketch_1", axis: { line: "c1" } };

  it("switches the axis between a line of the sketch (a centreline first) and a reference axis", () => {
    const from = field("axis", "prop-axis-from");
    expect(commitPatch(from, "ref", f, ctx(f))).toEqual({ axis: { datum: "Y" } });
    expect(commitPatch(from, "line", { ...f, axis: { datum: "Y" } }, ctx(f))).toEqual({ axis: { line: "c1" } });
    expect(preferredLine({ entities: [{ id: "a", type: "line" }] })).toBe("a");
    expect(() => commitPatch(from, "line", { ...f, sketch: "none" }, ctx(f))).toThrow(/The sketch has no lines/);
    expect(visibleFields(REVOLVE_FIELDS, f, ctx(f)).map((s) => s.testId)).toContain("prop-axis-line");
    expect(visibleFields(REVOLVE_FIELDS, { ...f, axis: { datum: "Y" } }, ctx(f)).map((s) => s.testId)).toContain("prop-axis");
  });

  it("the operation shows what it will do, and switching clears the body fields; the default is left out", () => {
    const op = field("operation");
    expect(visibleFields([op], f, ctx(f, ["main"]))).toHaveLength(1);
    expect(commitPatch(op, "remove", f, ctx(f, ["main"]))).toEqual({ operation: "remove", body: null, bodies: null, newBody: null });
    expect(commitPatch(op, "add", f, ctx(f, ["main"]))).toEqual({ operation: null, body: null, bodies: null, newBody: null });
    expect(commitPatch(op, "new", f, ctx(f, []))).toEqual({ operation: null, body: null, bodies: null, newBody: null });
    const shown = (g: Raw, bodies: string[]) => visibleFields(REVOLVE_FIELDS, g, ctx(g, bodies)).map((s) => s.testId);
    expect(shown({ ...f, operation: "remove" }, ["a", "b"])).toContain("prop-bodies");
    expect(shown(f, ["a", "b"])).toContain("prop-body");
    expect(shown(f, ["a"])).not.toContain("prop-body");
  });

  it("one direction, two, or mid-plane; thin on and off", () => {
    const dir = field("midplane");
    expect(commitPatch(dir, "mid", f, ctx(f))).toEqual({ midplane: true, angle2: null });
    expect(commitPatch(dir, "two", f, ctx(f))).toEqual({ midplane: null, angle2: 30, angle: 180 });
    expect(commitPatch(dir, "one", { ...f, angle2: 30 }, ctx(f))).toEqual({ midplane: null, angle2: null });
    const thin = field("thin");
    expect(commitPatch(thin, true, f, ctx(f))).toEqual({ thin: { thickness: 2 } });
    expect(commitPatch(thin, false, { ...f, thin: { thickness: 2 } }, ctx(f))).toEqual({ thin: null });
    expect(commitPatch(field("thin.side"), "inside", { ...f, thin: { thickness: 2 } }, ctx(f))).toEqual({ thin: { thickness: 2, side: "inside" } });
    expect(commitPatch(field("angle"), 360, f, ctx(f))).toEqual({ angle: null });
  });

  it("each new op's tree chip", () => {
    expect(UI_OPS.revolve.summary!({ ...f, angle: 90, operation: "remove" })).toBe("90° cut");
    expect(UI_OPS.revolve.summary!({ ...f, angle: 60, angle2: 30, thin: { thickness: 1 } })).toBe("90° thin");
    expect(UI_OPS.shell.summary!({ thickness: 2, faces: [] })).toBe("2 mm, closed");
    expect(UI_OPS.shell.summary!({ thickness: 2, faces: [{}] })).toBe("2 mm");
    expect(UI_OPS.draft.summary!({ angle: 3 })).toBe("3°");
    expect(UI_OPS.scale.summary!({ factor: 2 })).toBe("×2");
    expect(UI_OPS.revolve.sketchOf!(f)).toBe("sketch_1");
  });
});

describe("review fixes", () => {
  it("an open chain revolves as a thin wall from the tool (SOLIDWORKS offers the thin feature)", () => {
    const chain = [
      { id: "l1", type: "line", start: [10, 0], end: [10, 20] },
      { id: "l2", type: "line", start: [10, 20], end: [20, 20] },
    ];
    const doc = sketchDoc([...chain, CENTERLINE]);
    const { ctx, out } = harness(doc, viewOf(oc, doc));
    const f = revolveFeature(ctx, false) as Raw;
    expect(f).toEqual({ id: "revolve_1", op: "revolve", sketch: "sketch_1", axis: { line: "c1" }, thin: { thickness: 2 } });
    toolById("tool.revolve")!.run(ctx);
    expect(out.created).toEqual([f]);
    expect(out.notices).toEqual([["info", "The profile is open, so it turns as a thin wall (2 mm): change the wall in Properties."]]);
    expect(allErrors(validateDocument({ ...doc, features: [...doc.features, f] }))).toEqual([]);
    // A closed profile stays solid; a closed profile whose axis is a profile line drawn apart from it too.
    expect(openProfile([RECT, CENTERLINE] as never, { line: "c1" })).toBe(false);
    expect(openProfile([RECT, { ...CENTERLINE, construction: undefined }] as never, { line: "c1" })).toBe(false);
    expect(openProfile([...chain, CENTERLINE] as never, { line: "c1" })).toBe(true);
    expect(openProfile([...chain, { ...CENTERLINE, construction: undefined }] as never, { line: "c1" })).toBe(true);
    // Not one chain (a branch) is left to the revolve's own message.
    expect(openProfile([...chain, { id: "l3", type: "line", start: [10, 20], end: [10, 30] }] as never, { datum: "Y" })).toBe(false);
  });

  it("a reference axis starts from a default axis in the sketch's plane, the sketch's vertical first", () => {
    const sketch = (normal: number[], origin = [0, 0, 0]) => ({ id: "s", op: "sketch", plane: { type: "datum", normal, origin }, entities: [] });
    expect(defaultAxisIn(sketchFrameIn(sketch([0, 0, 1]), null))).toBe("Y");
    expect(defaultAxisIn(sketchFrameIn(sketch([0, -1, 0]), null))).toBe("Z");
    expect(defaultAxisIn(sketchFrameIn(sketch([1, 0, 0]), null))).toBe("Z");
    // Off the origin no default axis lies in the plane: Y, and the revolve says why.
    expect(defaultAxisIn(sketchFrameIn(sketch([0, 0, 1], [0, 0, 5]), null))).toBe("Y");
    const front = [{ ...sketch([0, -1, 0]), id: "sketch_1" }];
    const g = { id: "revolve_1", op: "revolve", sketch: "sketch_1", axis: { line: "c1" } };
    const from = REVOLVE_FIELDS.find((s) => s.testId === "prop-axis-from") as FieldSpec;
    expect(commitPatch(from, "ref", g, { f: g, resolved: g, before: front, bodies: [], doc: { features: [] } as never, view: null, selection: EMPTY_SELECTION })).toEqual({ axis: { datum: "Z" } });
  });

  it("Shell on a body picked whole (Bodies panel) hollows it closed; with several bodies and nothing picked, it asks which", () => {
    const stand = example("stand");
    const view = viewOf(oc, stand);
    const upright = view.bodies.find((b) => b.name === "upright")!;
    const faces = Array.from({ length: upright.faces[1] - upright.faces[0] }, (_, i) => upright.faces[0] + i);
    expect(shellFeature(harness(stand, view, { selection: { faces, edges: [] } }).ctx)).toEqual({ id: "shell_1", op: "shell", faces: [], thickness: 2, body: "upright" });
    expect(shellFeature(harness(stand, view).ctx)).toBe(
      `The part has ${view.bodies.length} bodies: click the faces to remove, or a body in the Bodies panel for a closed hollow one, then Shell.`,
    );
    // One body picked whole in a one-body part: the closed hollow, no body named.
    const doc = boxDoc();
    const box = viewOf(oc, doc);
    expect(shellFeature(harness(doc, box, { selection: { faces: [0, 1, 2, 3, 4, 5], edges: [] } }).ctx)).toEqual({ id: "shell_1", op: "shell", faces: [], thickness: 2 });
  });

  it("Pattern and Mirror take a revolve selected in the tree", () => {
    expect(PATTERNABLE).toContain("revolve");
    const ball = sketchDoc([{ id: "a", type: "arc", center: [0, 0], start: [0, -5], end: [0, 5] }, { id: "c1", type: "line", start: [0, -5], end: [0, 5] }], { id: "rev_1", op: "revolve", sketch: "sketch_1", axis: { line: "c1" } });
    const view = viewOf(oc, ball);
    const selected = harness(ball, view).ctx.resolved.find((f) => f.id === "rev_1");
    const { ctx, out } = harness(ball, view, { selected });
    expect(mirrorFeature(ctx)).toMatchObject({ op: "mirror", feature: "rev_1" });
    toolById("tool.linearPattern")!.run(ctx);
    expect(out.notices).toEqual([]);
    expect(out.created).toEqual([{ id: "pattern_1", op: "linearPattern", feature: "rev_1", direction: [1, 0, 0], spacing: 10, count: 3 }]);
  });
});
