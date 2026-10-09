// Declared property editors (Phase O): a feature's fields as data, the
// patches they send (shallow, so nested keys send their whole object), which
// fields show, their defaults and test ids; references to planes, axes and
// points, from the defaults, reference features or what is picked in the
// view; several faces picked at once; and FeatureForm rendering every kind.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import { UI_OPS } from "../src/features/uiDefs";
import { loadOC, type OC } from "../src/kernel";
import { selectFaces } from "../src/kernel/selectors";
import { faceSelectorFor, facesSelectorFor } from "../src/kernel/synthesize";
import { ICON_NAMES } from "../src/ui/icons";
import { EMPTY_SELECTION, type Selection } from "../src/ui/model/selection";
import { datumChoices, describeRef, kindsText, refFromSelection } from "../src/ui/props/datumRef";
import { FeatureForm } from "../src/ui/props/FeatureForm";
import {
  asList,
  commitPatch,
  defaultsOf,
  featureChoices,
  fieldTestId,
  fieldValue,
  patchAt,
  sketchLineChoices,
  toggled,
  valueAt,
  visibleFields,
  type FieldProps,
  type FieldSpec,
  type FormContext,
} from "../src/ui/props/spec";
import { example, faceWhere, viewOf } from "./ui-fixtures";

let oc: OC;
beforeAll(async () => {
  oc = await loadOC();
});

type Raw = Record<string, unknown>;
const ctxOf = (f: Raw, more: Partial<FormContext> = {}): FormContext => ({
  f,
  resolved: f,
  before: [],
  bodies: [],
  doc: { features: [] } as RawDocument,
  view: null,
  selection: EMPTY_SELECTION,
  ...more,
});

describe("patches", () => {
  it("a top-level key is itself; null removes it", () => {
    expect(patchAt({ distance: 5 }, "distance", 8)).toEqual({ distance: 8 });
    expect(patchAt({ distance: 5 }, "distance", null)).toEqual({ distance: null });
    expect(patchAt({}, "distance", undefined)).toEqual({ distance: null });
  });

  it("a nested key sends the whole object, keeping its other fields", () => {
    const f = { thin: { thickness: 2, side: "inside" }, axis: { origin: [0, 0, 0], direction: [0, 0, 1] } };
    expect(patchAt(f, "thin.thickness", 3)).toEqual({ thin: { thickness: 3, side: "inside" } });
    expect(patchAt(f, "thin.side", null)).toEqual({ thin: { thickness: 2 } });
    expect(patchAt(f, "axis.origin", [5, 0, 0])).toEqual({ axis: { origin: [5, 0, 0], direction: [0, 0, 1] } });
    expect(patchAt({}, "direction2.extent", "blind")).toEqual({ direction2: { extent: "blind" } });
    // Two levels down, and an object left empty goes.
    expect(patchAt({ a: { b: { c: 1, d: 2 } } }, "a.b.c", 9)).toEqual({ a: { b: { c: 9, d: 2 } } });
    expect(patchAt({ thin: { thickness: 2 } }, "thin.thickness", null)).toEqual({ thin: null });
    expect(valueAt(f, "thin.thickness")).toBe(2);
    expect(valueAt(f, "thin.nothing.deeper")).toBeUndefined();
  });

  it("a bool's false and an omitted default remove the key; a field's own set wins", () => {
    const c = ctxOf({});
    expect(commitPatch({ kind: "bool", key: "flip", label: "Flip" }, false, {}, c)).toEqual({ flip: null });
    expect(commitPatch({ kind: "bool", key: "flip", label: "Flip" }, true, {}, c)).toEqual({ flip: true });
    const angle: FieldSpec = { kind: "number", key: "angle", label: "Angle", default: 360, omitDefault: true };
    expect(commitPatch(angle, 360, {}, c)).toEqual({ angle: null });
    expect(commitPatch(angle, 180, {}, c)).toEqual({ angle: 180 });
    expect(commitPatch(angle, "=a", {}, c)).toEqual({ angle: "=a" });
    const extent: FieldSpec = { kind: "select", key: "extent", label: "End", options: [["blind", "Blind"]], default: "blind", omitDefault: true };
    expect(commitPatch(extent, "blind", {}, c)).toEqual({ extent: null });
    const second: FieldSpec = { kind: "bool", key: "direction2", label: "Second", set: (on) => (on ? { direction2: [0, 1, 0] } : { direction2: null, count2: null }) };
    expect(commitPatch(second, false, {}, c)).toEqual({ direction2: null, count2: null });
  });
});

describe("fields", () => {
  it("show the document's value, else the default; a field's own get wins", () => {
    const c = ctxOf({});
    expect(fieldValue({ kind: "number", key: "angle", label: "A", default: 360 }, {}, c)).toBe(360);
    expect(fieldValue({ kind: "number", key: "angle", label: "A", default: 360 }, { angle: "=a" }, c)).toBe("=a");
    expect(fieldValue({ kind: "number", key: "thin.thickness", label: "T" }, { thin: { thickness: 1.5 } }, c)).toBe(1.5);
    expect(fieldValue({ kind: "bool", key: "two", label: "Two", get: (f) => f.direction2 !== undefined }, { direction2: [0, 1, 0] }, c)).toBe(true);
  });

  it("show only when their rule holds, against the feature and the context", () => {
    const specs: FieldSpec[] = [
      { kind: "number", key: "distance", label: "Depth", when: (f) => f.extent !== "throughAll" },
      { kind: "bodies", key: "bodies", label: "Bodies", when: (_f, c) => c.bodies.length > 1 },
      { kind: "number", key: "count", label: "Count" },
    ];
    expect(visibleFields(specs, { extent: "throughAll" }, ctxOf({}, { bodies: ["a"] })).map((s) => s.key)).toEqual(["count"]);
    expect(visibleFields(specs, {}, ctxOf({}, { bodies: ["a", "b"] })).map((s) => s.key)).toEqual(["distance", "bodies", "count"]);
  });

  it("get test ids prop-<key>, dots as dashes, unless they name their own", () => {
    expect(fieldTestId({ kind: "number", key: "thin.thickness", label: "T" })).toBe("prop-thin-thickness");
    expect(fieldTestId({ kind: "number", key: "radius", label: "R", testId: "prop-radius" })).toBe("prop-radius");
  });

  it("give a new feature its defaults, leaving out what the document omits", () => {
    const specs: FieldSpec[] = [
      { kind: "number", key: "angle", label: "A", default: 360, omitDefault: true },
      { kind: "number", key: "thickness", label: "T", default: 2 },
      { kind: "number", key: "thin.thickness", label: "T", default: 1 },
      { kind: "select", key: "thin.side", label: "S", options: [], default: "inside" },
      { kind: "bool", key: "flip", label: "F", default: false },
      { kind: "bool", key: "midplane", label: "M", default: true },
      { kind: "number", key: "count", label: "N" },
    ];
    expect(defaultsOf(specs)).toEqual({ thickness: 2, thin: { thickness: 1, side: "inside" }, midplane: true });
  });

  it("choose earlier features of the right ops, a sketch's lines, and keep ticked lists in order", () => {
    const before = [
      { id: "sketch_1", op: "sketch", entities: [{ id: "l1", type: "line" }, { id: "c1", type: "circle" }, { id: "ax", type: "line", construction: true }] },
      { id: "ext_1", op: "extrude" },
      { id: "hole_1", op: "hole" },
    ];
    expect(featureChoices(before, ["extrude", "hole"])).toEqual([["ext_1", "ext_1"], ["hole_1", "hole_1"]]);
    expect(featureChoices(before).map(([id]) => id)).toEqual(["sketch_1", "ext_1", "hole_1"]);
    expect(sketchLineChoices(before, "sketch_1")).toEqual([["l1", "l1"], ["ax", "ax (construction)"]]);
    expect(sketchLineChoices(before, "ext_1")).toEqual([]);
    const order = ["base", "upright", "arm"];
    expect(toggled(["arm"], "base", true, order, false)).toEqual(["base", "arm"]);
    expect(toggled(["arm"], "arm", false, order, false)).toBeNull();
    expect(toggled(["arm"], "arm", false, order, true)).toEqual([]);
    expect(asList({ type: "planar", normal: [0, 0, 1], pick: "largest" })).toHaveLength(1);
    expect(asList(undefined)).toEqual([]);
  });
});

describe("references to planes, axes and points", () => {
  const before = [
    { id: "plane_1", op: "plane" },
    { id: "axis_1", op: "axis" },
    { id: "ext_1", op: "extrude" },
  ];

  it("offer the default planes, axes and origin of the kinds a field takes, then the reference features", () => {
    expect(datumChoices(before, ["plane"]).map((c) => c.id)).toEqual(["Top", "Front", "Right", "plane_1"]);
    expect(datumChoices(before, ["axis"]).map((c) => c.label)).toEqual(["X axis", "Y axis", "Z axis", "axis_1 (axis)"]);
    expect(datumChoices(before, ["point", "axis"]).map((c) => c.id)).toEqual(["Origin", "X", "Y", "Z", "axis_1"]);
    expect(kindsText(["plane", "axis", "point"])).toBe("a plane, an axis or a point");
  });

  it("read as words", () => {
    expect(describeRef({ datum: "Top" })).toBe("Top plane (XY): the XY plane, normal +Z");
    expect(describeRef({ datum: "plane_1" }, before)).toBe("plane_1: a reference plane");
    expect(describeRef({ datum: "gone" }, before)).toBe("gone: no reference plane, axis or point of that id before this feature");
    expect(describeRef({ face: { type: "planar", normal: [0, 0, 1], pick: "largest" } })).toBe("the planar face normal +Z");
    expect(describeRef({ edge: { type: "edge", kind: "line", direction: [1, 0, 0], pick: "all" }, at: "mid" })).toBe("the line edge parallel to +X, its midpoint");
    expect(describeRef({ point: [1, 2.5, 0] })).toBe("the point 1, 2.5, 0");
    expect(describeRef(undefined)).toBe("none");
  });

  it("Use selected: a flat face is a plane, a round face an axis, an edge an axis or a point on it", () => {
    const doc = example("bracket");
    const view = viewOf(oc, doc);
    const top = faceWhere(view, (f) => f.type === "plane" && f.normal![2] > 0.99);
    const wall = faceWhere(view, (f) => f.type === "cylinder");
    const line = view.edges.findIndex((e) => !e.seam && e.kind === "line");
    const circle = view.edges.findIndex((e) => !e.seam && e.kind === "circle");
    const sel = (faces: number[], edges: number[] = []): Selection => ({ faces, edges });
    expect(refFromSelection(sel([top]), view, ["plane"])).toEqual({ ok: true, ref: { face: { type: "planar", normal: [0, 0, 1], pick: "largest" } } });
    const axis = refFromSelection(sel([wall]), view, ["axis"]);
    expect(axis.ok && "face" in axis.ref && axis.ref.face.type).toBe("cylindrical");
    expect(refFromSelection(sel([top]), view, ["axis"])).toEqual({ ok: false, error: "The face (normal +Z) is a plane, but an axis is needed here." });
    expect(refFromSelection(sel([wall]), view, ["plane", "point"])).toEqual({ ok: false, error: "A round face is an axis, but a plane or a point is needed here." });
    const asAxis = refFromSelection(sel([], [line]), view, ["axis", "point"]);
    expect(asAxis.ok && "edge" in asAxis.ref && asAxis.ref.at).toBeUndefined();
    const asPoint = refFromSelection(sel([], [line]), view, ["point"]);
    expect(asPoint.ok && "edge" in asPoint.ref && asPoint.ref.at).toBe("mid");
    const centre = refFromSelection(sel([], [circle]), view, ["point"]);
    expect(centre.ok && "edge" in centre.ref && centre.ref.at).toBe("center");
    expect(refFromSelection(sel([top, wall]), view, ["plane"])).toEqual({ ok: false, error: "Click one face, edge, vertex or plane in the view (a plane is needed here), then Use selected." });
    expect(refFromSelection(sel([top]), null, ["plane"]).ok).toBe(false);
  });
});

describe("several faces at once", () => {
  it("one selector per face, in the order picked, each finding its face alone", () => {
    const doc = example("mounting-plate");
    const view = viewOf(oc, doc);
    const picks = view.faces.flatMap((f, i) => (f.type === "cylinder" ? [i] : [])).slice(0, 3);
    picks.push(faceWhere(view, (f) => f.type === "plane" && f.normal![2] > 0.99));
    const s = facesSelectorFor(view.faces, [...picks, picks[0]]);
    expect(s.ok).toBe(true);
    const list = (s as { selector: Parameters<typeof selectFaces>[1][] }).selector;
    expect(list).toHaveLength(4);
    list.forEach((sel, k) => {
      const r = selectFaces(view.faces, sel);
      expect(r.matches.map((m) => m.index)).toEqual([picks[k]]);
      expect(sel).toEqual((faceSelectorFor(view.faces, picks[k]) as { selector: unknown }).selector);
    });
  });

  it("says which face can't be named, and that nothing was picked", () => {
    const faces = [{ index: 0, type: "other" as const, area: 1, centroid: [0, 0, 0] as [number, number, number] }];
    expect(facesSelectorFor(faces, [])).toEqual({ ok: false, error: "no faces picked" });
    expect(facesSelectorFor(faces, [0])).toEqual({ ok: false, error: "a freeform face cannot be selected yet; pick a flat or cylindrical face" });
  });
});

describe("the feature ops' UI registry", () => {
  it("names each op, gives it an icon, and declares its editor", () => {
    for (const u of Object.values(UI_OPS)) {
      expect(u.label, u.op).not.toBe("");
      expect(ICON_NAMES, u.op).toContain(u.icon);
      expect(u.fields || u.Editor, u.op).toBeTruthy();
    }
    expect(Object.keys(UI_OPS)).toEqual(["fillet", "chamfer", "linearPattern", "circularPattern", "plane", "axis", "point"]);
  });

  it("keeps the old editors' test ids", () => {
    const tids = (op: string) => UI_OPS[op].fields!.map(fieldTestId);
    expect(tids("fillet")).toEqual(["prop-edges", "prop-radius"]);
    expect(tids("chamfer")).toEqual(["prop-edges", "prop-chamfer-distance"]);
    expect(tids("linearPattern").slice(0, 4)).toEqual(["prop-pattern-feature", "prop-pattern-direction", "prop-spacing", "prop-count"]);
  });

  it("a second pattern direction comes and goes with its spacing and count", () => {
    const fields = UI_OPS.linearPattern.fields!;
    const f = { id: "p", op: "linearPattern", feature: "hole_1", direction: [1, 0, 0], spacing: 20, count: 3 };
    const c = ctxOf(f);
    const second = fields.find((s) => s.kind === "bool")!;
    expect(commitPatch(second, true, f, c)).toEqual({ direction2: [0, 1, 0], spacing2: 20, count2: 2 });
    expect(visibleFields(fields, f, c).map((s) => s.key)).toEqual(["feature", "direction", "spacing", "count", "direction2"]);
    const two = { ...f, direction2: [0, 1, 0], spacing2: 20, count2: 2 };
    expect(visibleFields(fields, two, ctxOf(two))).toHaveLength(8);
    expect(commitPatch(second, false, two, ctxOf(two))).toEqual({ direction2: null, spacing2: null, count2: null });
  });

  it("a circular pattern's axis point sends the whole axis, and 360° is left out", () => {
    const fields = UI_OPS.circularPattern.fields!;
    const f = { id: "c", op: "circularPattern", feature: "hole_1", axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, count: 4 };
    const origin = fields.find((s) => s.key === "axis.origin")!;
    expect(commitPatch(origin, [10, 0, 0], f, ctxOf(f))).toEqual({ axis: { origin: [10, 0, 0], direction: [0, 0, 1] } });
    const angle = fields.find((s) => s.key === "angle")!;
    expect(fieldValue(angle, f, ctxOf(f))).toBe(360);
    expect(commitPatch(angle, 360, f, ctxOf(f))).toEqual({ angle: null });
  });
});

describe("FeatureForm", () => {
  const render = (fields: FieldSpec[], f: Raw, more: Partial<FieldProps> = {}) => {
    const props: FieldProps & { fields: FieldSpec[] } = { ...ctxOf(f), update: () => null, rename: () => null, setError: () => undefined, fields, ...more };
    return renderToStaticMarkup(createElement(FeatureForm, props));
  };

  it("renders every kind of field, with its test id", () => {
    const before = [
      { id: "sketch_1", op: "sketch", entities: [{ id: "l1", type: "line" }] },
      { id: "ext_1", op: "extrude" },
      { id: "plane_1", op: "plane" },
    ];
    const f = {
      id: "r",
      op: "revolve",
      sketch: "sketch_1",
      axis: { line: "l1" },
      angle: 90,
      kind: "blind",
      thin: { thickness: 2 },
      flip: true,
      at: [1, 2, 3],
      dir: [0, 0, 1],
      plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 5] },
      neutral: { datum: "Top" },
      faces: [{ type: "planar", normal: [0, 0, 1], pick: "largest" }],
      face: { type: "planar", normal: [1, 0, 0], pick: "largest" },
      edges: { type: "edge", kind: "line", direction: [0, 0, 1], pick: "all" },
      seed: "ext_1",
      seeds: ["ext_1"],
      bodies: ["base"],
    };
    const fields: FieldSpec[] = [
      { kind: "sketch", key: "sketch", label: "Sketch" },
      { kind: "sketchLine", key: "axis", label: "Axis", get: (g) => (g.axis as { line?: string }).line, set: (v) => ({ axis: { line: v } }) },
      { kind: "number", key: "angle", label: "Angle", unit: "°" },
      { kind: "select", key: "kind", label: "End", options: [["blind", "Blind"], ["through", "Through all"]] },
      { kind: "number", key: "thin.thickness", label: "Thickness", unit: "mm" },
      { kind: "bool", key: "flip", label: "Flip" },
      { kind: "vec3", key: "at", label: "At", unit: "mm" },
      { kind: "direction", key: "dir", label: "Direction" },
      { kind: "plane", key: "plane", label: "Plane" },
      { kind: "datumRef", key: "neutral", label: "Neutral plane", accepts: ["plane"] },
      { kind: "faces", key: "faces", label: "Faces" },
      { kind: "face", key: "face", label: "Face" },
      { kind: "edges", key: "edges", label: "Edges" },
      { kind: "feature", key: "seed", label: "Feature", ops: ["extrude"] },
      { kind: "features", key: "seeds", label: "Features" },
      { kind: "bodies", key: "bodies", label: "Bodies" },
      { kind: "custom", key: "note", label: "Note", render: (p) => createElement("p", { "data-testid": "custom-note" }, `custom on ${String(p.f.id)}`) },
    ];
    const html = render(fields, f, { before, bodies: ["base", "upright"] });
    for (const id of [
      "prop-sketch",
      "prop-axis",
      "prop-angle",
      "prop-kind",
      "prop-thin-thickness",
      "prop-flip",
      "prop-at-x",
      "prop-dir",
      "prop-plane-origin-z",
      "prop-plane-normal",
      "prop-neutral",
      "prop-neutral-use",
      "prop-neutral-ref",
      "prop-faces",
      "prop-faces-use",
      "prop-face-use",
      "prop-edges-use",
      "prop-seed",
      "prop-seeds-ext_1",
      "prop-bodies-upright",
      "custom-note",
    ]) {
      expect(html, id).toContain(`data-testid="${id}"`);
    }
    expect(html).toContain("Top plane (XY): the XY plane, normal +Z");
    expect(html).toContain("planar face normal +Z");
    expect(html).toContain("line edges parallel to +Z");
    expect(html).toContain("custom on r");
    expect(html).toContain('value="2"'); // thin.thickness
  });

  it("a reference plane field offers the planes and shows the reference, its offset and flip", () => {
    const fields: FieldSpec[] = [{ kind: "plane", key: "plane", label: "Plane", refs: true }];
    const html = render(fields, { plane: { type: "ref", ref: { datum: "Front" }, offset: 5, flip: true } });
    expect(html).toContain("Front plane (XZ): the XZ plane, normal -Y");
    expect(html).toContain('data-testid="prop-plane-offset"');
    expect(html).toMatch(/data-testid="prop-plane-flip"[^>]*checked|checked=""[^>]*data-testid="prop-plane-flip"/);
    const inline = render(fields, { plane: { type: "datum", normal: [0, 0, 1], origin: [0, 0, 0] } });
    expect(inline).toContain("Through a point (custom)");
    expect(inline).toContain('data-testid="prop-plane-origin-x"');
  });

  it("an empty face list says how to fill it", () => {
    const html = render([{ kind: "faces", key: "faces", label: "Faces" }], {});
    expect(html).toContain("none: select in the view (Ctrl-click for more), then Use selected faces");
  });
});
