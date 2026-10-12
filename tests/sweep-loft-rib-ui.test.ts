// Sweep, Helix, Loft and Rib in the UI (Phase O wave 4): what the tools make
// from the selection and the sketches no feature uses yet, the editors'
// fields (profile kind, path kind, how the helix is given), the loft's
// section list, and that what the tools make validates and builds.

import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { moved, sectionChoices, without } from "../src/features/loft/profiles";
import { LOFT_FIELDS } from "../src/features/loft/ui";
import { RIB_FIELDS } from "../src/features/rib/ui";
import { sketchUse } from "../src/features/sweep/fields";
import { SWEEP_FIELDS } from "../src/features/sweep/ui";
import { UI_OPS } from "../src/features/uiDefs";
import { loadOC, rebuild, type OC } from "../src/kernel";
import { EMPTY_SELECTION } from "../src/ui/model/selection";
import { helixFeature, loftFeature, ribFeature, sketchInfos, sweepFeature } from "../src/ui/model/tools/sweep";
import { commitPatch, visibleFields, type FieldSpec, type FormContext } from "../src/ui/props/spec";
import { faceWhere, harness, viewOf } from "./ui-fixtures";

type Raw = Record<string, unknown>;
const TOP = { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] };
const FRONT = { type: "datum", normal: [0, -1, 0], origin: [0, 0, 0] };
const sketch = (id: string, plane: unknown, entities: Raw[]): Raw => ({ id, op: "sketch", plane, entities, constraints: [] });
const doc = (...features: Raw[]): RawDocument => ({ version: 1, units: "mm", name: "ui", features });
const PATH = sketch("path", FRONT, [{ id: "l1", type: "line", start: [0, 0], end: [0, 100] }]);
const DISC = sketch("disc", TOP, [{ id: "c1", type: "circle", center: [0, 0], radius: 5 }]);
const BOX = [sketch("base", TOP, [{ id: "r", type: "rect", center: [0, 0], w: 40, h: 40 }]), { id: "box", op: "extrude", sketch: "base", distance: 20 }];
const errorsOf = (d: unknown) => allErrors(validateDocument(d));

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

const ctxFor = (f: Raw, before: Raw[], bodies: string[] = [], extra: Partial<FormContext> = {}): FormContext => ({
  f,
  resolved: f,
  before,
  bodies,
  doc: doc(...before, f),
  view: null,
  selection: EMPTY_SELECTION,
  ...extra,
});
const field = (specs: FieldSpec[], testId: string) => specs.find((s) => s.testId === testId)!;

describe("what a sketch can be used as", () => {
  it("a closed profile, a path, a lone point, or nothing", () => {
    expect(sketchUse(DISC.entities as never)).toBe("profile");
    expect(sketchUse(PATH.entities as never)).toBe("path");
    expect(sketchUse([{ id: "p", type: "point", at: [1, 2] }])).toBe("point");
    expect(sketchUse([])).toBe("none");
    const infos = sketchInfos([PATH, DISC, { id: "sw", op: "sweep", profile: "disc", path: { sketch: "path" } }]);
    expect(infos.map((s) => [s.id, s.use, s.open, s.used])).toEqual([
      ["path", "path", true, true],
      ["disc", "profile", false, true],
    ]);
  });
});

describe("Sweep tool", () => {
  it("sweeps the unused profile along the unused path, and that builds", () => {
    const d = doc(PATH, DISC);
    const f = sweepFeature(harness(d, null).ctx, false);
    expect(f).toEqual({ id: "sweep_1", op: "sweep", profile: "disc", path: { sketch: "path" } });
    expect(errorsOf({ ...d, features: [...d.features, f as Raw] })).toEqual([]);
  });

  it("with no profile sketch, a round section a twentieth of the path's length", () => {
    expect(sweepFeature(harness(doc(PATH), null).ctx, false)).toEqual({ id: "sweep_1", op: "sweep", circle: { diameter: 5 }, path: { sketch: "path" } });
  });

  it("a lone closed sketch becomes the path of a round section (a groove round a part, as a swept cut)", () => {
    const ring = sketch("ring", { type: "datum", normal: [0, 0, 1], origin: [0, 0, 10] }, [{ id: "c", type: "circle", center: [0, 0], radius: 20 }]);
    const d = doc(...BOX, ring);
    // The ring is 40π ≈ 125.7 long: a twentieth of it, rounded, is 6.
    expect(sweepFeature(harness(d, viewOf(oc, d)).ctx, true)).toEqual({ id: "sweep_cut_1", op: "sweep", circle: { diameter: 6 }, path: { sketch: "ring" }, operation: "remove" });
    expect(sweepFeature(harness(doc(PATH), null).ctx, true)).toBe("A swept cut needs a solid to cut: make one first.");
  });

  it("selected model edges are the path when no path sketch is drawn", () => {
    const d = doc(...BOX);
    const view = viewOf(oc, d);
    const edge = view.edges.findIndex((e) => e.kind === "line" && Math.abs(e.direction![0]) > 0.99 && e.mid[2] > 19);
    const f = sweepFeature(harness(d, view, { selection: { faces: [], edges: [edge] } }).ctx, false) as Raw;
    expect(f.circle).toEqual({ diameter: 2 });
    expect(Object.keys(f.path as Raw)).toEqual(["edges"]);
    expect(errorsOf({ ...d, features: [...d.features, f] })).toEqual([]);
  });

  it("says what to draw when there is nothing to sweep", () => {
    expect(sweepFeature(harness(doc(), null).ctx, false)).toBe("Sketch the path (a chain of lines and arcs) and the profile on a plane across its start, or select model edges, then Sweep.");
  });
});

describe("Helix tool", () => {
  it("a 2 mm wire on a helix about Z, radius 10, pitch 5, 4 turns; it builds", () => {
    const f = helixFeature(harness(doc(), null).ctx);
    expect(f).toEqual({ id: "helix_1", op: "sweep", circle: { diameter: 2 }, path: { helix: { axis: { datum: "Z" }, radius: 10, pitch: 5, turns: 4 } } });
    const r = rebuild(doc(f as Raw), oc);
    try {
      expect(r.errors).toEqual([]);
      expect(r.measurements!.volume / (Math.PI * 4 * Math.hypot(20 * Math.PI, 5))).toBeCloseTo(1, 4);
    } finally {
      r.dispose();
    }
  });

  it("winds round a selected cylinder at its radius, as a body of its own", () => {
    const d = doc(sketch("base", TOP, [{ id: "c", type: "circle", center: [0, 0], radius: 8 }]), { id: "rod", op: "extrude", sketch: "base", distance: 40 });
    const view = viewOf(oc, d);
    const side = faceWhere(view, (f) => f.type === "cylinder");
    const f = helixFeature(harness(d, view, { selection: { faces: [side], edges: [] } }).ctx) as Raw;
    expect((f.path as { helix: Raw }).helix).toMatchObject({ radius: 8, pitch: 5, turns: 4 });
    expect((f.path as { helix: { axis: Raw } }).helix.axis).toHaveProperty("face");
    expect(f.newBody).toBe("body_1");
    expect(f.circle).toEqual({ diameter: 1.6 });
    expect(errorsOf({ ...d, features: [...d.features, f] })).toEqual([]);
  });
});

describe("Loft tool and its section list", () => {
  const PLANE = { id: "plane_1", op: "plane", mode: "offset", refs: [{ datum: "Top" }], distance: 30 };
  const UPPER = sketch("upper", { type: "ref", ref: { datum: "plane_1" } }, [{ id: "r2", type: "rect", center: [0, 0], w: 10, h: 10 }]);
  const LOWER = sketch("lower", TOP, [{ id: "r1", type: "rect", center: [0, 0], w: 20, h: 20 }]);

  it("lofts the unused sections in order; with fewer than two, the newest two", () => {
    const d = doc(LOWER, PLANE, UPPER);
    const f = loftFeature(harness(d, null).ctx, false);
    expect(f).toEqual({ id: "loft_1", op: "loft", profiles: ["lower", "upper"] });
    expect(errorsOf({ ...d, features: [...d.features, f as Raw] })).toEqual([]);
    const used = doc(LOWER, { id: "e", op: "extrude", sketch: "lower", distance: 5 }, PLANE, UPPER);
    expect(loftFeature(harness(used, null).ctx, false)).toEqual({ id: "loft_1", op: "loft", profiles: ["lower", "upper"] });
    expect(loftFeature(harness(doc(LOWER), null).ctx, false)).toBe("Sketch two or more profiles on different planes (a plane feature offset from Top, say), then Loft.");
  });

  it("moves sections up and down, takes them out (keeping two), and offers the sketches that can be sections", () => {
    expect(moved(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moved(["a", "b", "c"], 2, 1)).toBeNull();
    expect(without(["a", "b", "c"], 0)).toEqual(["b", "c"]);
    expect(without(["a", "b"], 0)).toBeNull();
    const before = [LOWER, PATH, UPPER, sketch("tip", TOP, [{ id: "p", type: "point", at: [0, 0] }])];
    expect(sectionChoices(before, ["lower"])).toEqual([
      ["upper", "upper"],
      ["tip", "tip (a point)"],
    ]);
  });

  it("offers Closed only with three sections or more", () => {
    const c = (f: Raw) => visibleFields(LOFT_FIELDS, f, ctxFor(f, [LOWER, PLANE, UPPER])).map((s) => s.testId ?? s.key);
    expect(c({ id: "l", op: "loft", profiles: ["lower", "upper"] })).not.toContain("prop-closed");
    expect(c({ id: "l", op: "loft", profiles: ["lower", "upper", "x"] })).toContain("prop-closed");
  });
});

describe("Rib tool", () => {
  it("ribs the unused open sketch, 3 mm; needs a solid", () => {
    const line = sketch("g", TOP, [{ id: "g1", type: "line", start: [-10, 0], end: [10, 0] }]);
    expect(ribFeature(harness(doc(...BOX, line), null).ctx)).toEqual({ id: "rib_1", op: "rib", sketch: "g", thickness: 3 });
    expect(ribFeature(harness(doc(line), null).ctx)).toBe("A rib stiffens a solid: make the part first, then sketch the rib's line across it.");
    expect(ribFeature(harness(doc(...BOX), null).ctx)).toBe("Sketch the rib's line (an open line or chain) on a plane through the part, e.g. a bracket's middle plane, then Rib.");
  });

  it("words the thickness side for the way it extends", () => {
    const side = field(RIB_FIELDS, "prop-rib-side");
    const opts = (f: Raw) => (side.kind === "select" && typeof side.options === "function" ? side.options(f, ctxFor(f, [])).map(([v]) => v) : []);
    expect(opts({})).toEqual(["both", "left", "right"]);
    const dirField = field(RIB_FIELDS, "prop-rib-direction");
    expect(commitPatch(dirField, "normal", {}, ctxFor({}, []))).toEqual({ normal: true });
    expect(commitPatch(dirField, "parallel", { normal: true }, ctxFor({}, []))).toEqual({ normal: null });
  });
});

describe("Sweep editor", () => {
  const before = [PATH, DISC];
  const f: Raw = { id: "sw", op: "sweep", profile: "disc", path: { sketch: "path" } };

  it("switches the profile between a sketch and a circle, hollow or not", () => {
    const kind = field(SWEEP_FIELDS, "prop-sweep-profile-kind");
    expect(commitPatch(kind, "circle", f, ctxFor(f, before))).toEqual({ profile: null, circle: { diameter: 5 } });
    const circ = { ...f, profile: undefined, circle: { diameter: 8 } };
    expect(commitPatch(kind, "sketch", circ, ctxFor(circ, before))).toEqual({ circle: null, profile: "disc" });
    expect(() => commitPatch(kind, "sketch", circ, ctxFor(circ, [PATH]))).toThrow("No sketch before this sweep has a closed profile");
    const hollow = field(SWEEP_FIELDS, "prop-circle-hollow");
    expect(commitPatch(hollow, true, circ, ctxFor(circ, before))).toEqual({ circle: { diameter: 8, inner: 4 } });
    expect(commitPatch(hollow, false, { ...circ, circle: { diameter: 8, inner: 4 } }, ctxFor(circ, before))).toEqual({ circle: { diameter: 8 } });
  });

  it("switches the path between a sketch, edges and a helix, and gives the helix by any two numbers", () => {
    const kind = field(SWEEP_FIELDS, "prop-path-kind");
    expect(commitPatch(kind, "helix", f, ctxFor(f, before))).toEqual({ path: { helix: { axis: { datum: "Z" }, radius: 10, pitch: 5, turns: 4 } } });
    expect(() => commitPatch(kind, "edges", f, ctxFor(f, before))).toThrow("Select the path's edges in the view first");
    const h: Raw = { ...f, profile: undefined, circle: { diameter: 2 }, path: { helix: { axis: { datum: "Z" }, radius: 10, pitch: 5, turns: 4 } } };
    const by = field(SWEEP_FIELDS, "prop-helix-by");
    expect(commitPatch(by, "pitchHeight", h, ctxFor(h, before))).toEqual({ path: { helix: { axis: { datum: "Z" }, radius: 10, pitch: 5, height: 20 } } });
    expect(commitPatch(by, "heightTurns", h, ctxFor(h, before))).toEqual({ path: { helix: { axis: { datum: "Z" }, radius: 10, turns: 4, height: 20 } } });
    const shown = visibleFields(SWEEP_FIELDS, h, ctxFor(h, before)).map((s) => s.testId);
    expect(shown).toEqual(expect.arrayContaining(["prop-helix-axis", "prop-helix-radius", "prop-helix-pitch", "prop-helix-turns", "prop-helix-left", "prop-helix-taper", "prop-helix-start", "prop-twist"]));
    expect(shown).not.toContain("prop-helix-height");
    expect(shown).not.toContain("prop-path-sketch");
  });

  it("names itself in the tree", () => {
    expect(UI_OPS.sweep.summary!({ circle: { diameter: 2 }, path: { helix: { turns: 4 } } })).toBe("Ø2 helix 4 turns");
    expect(UI_OPS.sweep.summary!({ profile: "p", path: { sketch: "s" }, operation: "remove", twist: 90 })).toBe("90° twist cut");
    expect(UI_OPS.loft.summary!({ profiles: ["a", "b"], ruled: true })).toBe("2 sections ruled");
    expect(UI_OPS.rib.summary!({ thickness: 3, normal: true })).toBe("3 mm, normal");
  });
});
