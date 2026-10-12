// Sweep's properties: the profile (a sketch, or a circle of a diameter,
// hollow or not), the path (a sketch, model edges picked in the view, or a
// helix: its axis, radius, and pitch with turns or height, hand, taper), the
// twist and orientation, and what it does to the part.

import { edgesSelectorFor } from "../../kernel/synthesize";
import type { FieldSpec, FormContext } from "../../ui/props/spec";
import type { UiOp } from "../uiDefs";
import { pathKind } from "./doc";
import { entitiesOf, operationFields, sketchUse } from "./fields";
import { helixNumbers } from "./helix";

type Raw = Record<string, unknown>;

const isCircle = (f: Raw) => typeof f.circle === "object" && f.circle !== null;
const circleOf = (f: Raw) => (isCircle(f) ? (f.circle as Raw) : {});
const helixOf = (f: Raw) => (pathKind(f.path) === "helix" ? ((f.path as Raw).helix as Raw) : {});
const kind = (k: "sketch" | "edges" | "helix") => (f: Raw) => pathKind(f.path) === k;

/** The latest sketch before the feature that can serve this way, not one of `not`. */
function latestSketch(c: FormContext, use: "profile" | "path", not: unknown[] = []): string | undefined {
  const found = [...c.before].reverse().find((g) => g.op === "sketch" && !not.includes(g.id) && sketchUse(entitiesOf(g)) === use);
  return found ? String(found.id) : undefined;
}

/** Which two of pitch, turns and height the helix is given by. */
const HELIX_BY: [string, string, ("pitch" | "turns" | "height")[]][] = [
  ["pitchTurns", "Pitch and turns", ["pitch", "turns"]],
  ["pitchHeight", "Pitch and height", ["pitch", "height"]],
  ["heightTurns", "Height and turns", ["height", "turns"]],
];
const helixBy = (f: Raw) => HELIX_BY.find(([, , keys]) => keys.every((k) => helixOf(f)[k] !== undefined))?.[0] ?? "pitchTurns";
const hasHelix = (k: "pitch" | "turns" | "height") => (f: Raw) => kind("helix")(f) && helixOf(f)[k] !== undefined;

export const SWEEP_FIELDS: FieldSpec[] = [
  {
    kind: "select",
    key: "profile",
    label: "Profile",
    testId: "prop-sweep-profile-kind",
    options: [
      ["sketch", "A sketch's profile"],
      ["circle", "A circle (a pipe, a wire, a spring)"],
    ],
    get: (f) => (isCircle(f) ? "circle" : "sketch"),
    set: (v, f, c) => {
      if (v === "circle") return { profile: null, circle: { diameter: 5 } };
      const profile = latestSketch(c, "profile", [pathKind(f.path) === "sketch" ? (f.path as Raw).sketch : undefined]);
      if (!profile) throw new Error("No sketch before this sweep has a closed profile: draw one (on a plane across the path's start), or keep the circle.");
      return { circle: null, profile };
    },
  },
  { kind: "sketch", key: "profile", label: "Profile sketch", testId: "prop-profile", when: (f) => !isCircle(f), hint: "A closed profile, on a plane through the path's start" },
  { kind: "number", key: "circle.diameter", label: "Diameter", unit: "mm", min: 0, testId: "prop-circle-diameter", when: isCircle },
  {
    kind: "bool",
    key: "circle.inner",
    label: "Hollow (a tube)",
    testId: "prop-circle-hollow",
    when: isCircle,
    get: (f) => circleOf(f).inner !== undefined,
    set: (on, f, c) => {
      const circle = { ...circleOf(f) };
      if (on) circle.inner = Math.round((Number(circleOf(c.resolved).diameter) / 2) * 1000) / 1000 || 1;
      else delete circle.inner;
      return { circle };
    },
  },
  { kind: "number", key: "circle.inner", label: "Bore", unit: "mm", min: 0, testId: "prop-circle-inner", when: (f) => circleOf(f).inner !== undefined },
  {
    kind: "select",
    key: "path",
    label: "Path",
    testId: "prop-path-kind",
    options: [
      ["sketch", "A sketch (lines and arcs)"],
      ["edges", "Model edges"],
      ["helix", "A helix (a spring, a coil, a thread)"],
    ],
    get: (f) => pathKind(f.path) ?? "sketch",
    set: (v, f, c) => {
      if (v === "helix") return { path: { helix: { axis: { datum: "Z" }, radius: 10, pitch: 5, turns: 4 } } };
      if (v === "edges") {
        const { selection, view } = c;
        if (!view || selection.edges.length === 0) throw new Error("Select the path's edges in the view first (Ctrl-click for more), then choose Model edges.");
        const s = edgesSelectorFor(view.edges, view.faces, selection.edges);
        if (!s.ok) throw new Error(s.error);
        return { path: { edges: Array.isArray(s.selector) ? s.selector : [s.selector] } };
      }
      const sketch = latestSketch(c, "path", [f.profile]) ?? latestSketch(c, "profile", [f.profile]);
      if (!sketch) throw new Error("No other sketch before this sweep is a chain of lines and arcs: draw the path in a sketch first.");
      return { path: { sketch } };
    },
  },
  { kind: "sketch", key: "path.sketch", label: "Path sketch", testId: "prop-path-sketch", when: kind("sketch"), hint: "One chain of lines and arcs; it must start on the profile's plane" },
  { kind: "edges", key: "path.edges", label: "Path edges", testId: "prop-path-edges", when: kind("edges"), hint: "Edges that follow on from each other, in one chain" },
  { kind: "datumRef", key: "path.helix.axis", label: "Helix axis", accepts: ["axis"], testId: "prop-helix-axis", when: kind("helix"), hint: "A default axis, an axis feature, a straight or circular edge, or a cylinder" },
  { kind: "number", key: "path.helix.radius", label: "Radius", unit: "mm", min: 0, testId: "prop-helix-radius", when: kind("helix") },
  {
    kind: "select",
    key: "path.helix",
    label: "Defined by",
    testId: "prop-helix-by",
    options: HELIX_BY.map(([v, label]): [string, string] => [v, label]),
    when: kind("helix"),
    get: helixBy,
    set: (v, f, c) => {
      const numbers = helixNumbers(helixOf(c.resolved) as { pitch?: number; turns?: number; height?: number });
      const keep = HELIX_BY.find(([id]) => id === v)![2];
      const h: Raw = { ...helixOf(f) };
      for (const k of ["pitch", "turns", "height"] as const) {
        if (!keep.includes(k)) delete h[k];
        else if (h[k] === undefined) h[k] = typeof numbers === "string" ? (k === "pitch" ? 5 : k === "turns" ? 4 : 20) : Math.round(numbers[k] * 1000) / 1000;
      }
      return { path: { helix: h } };
    },
  },
  { kind: "number", key: "path.helix.pitch", label: "Pitch", unit: "mm", min: 0, testId: "prop-helix-pitch", when: hasHelix("pitch"), hint: "How far it climbs each turn" },
  { kind: "number", key: "path.helix.turns", label: "Turns", min: 0, testId: "prop-helix-turns", when: hasHelix("turns") },
  { kind: "number", key: "path.helix.height", label: "Height", unit: "mm", min: 0, testId: "prop-helix-height", when: hasHelix("height") },
  { kind: "bool", key: "path.helix.leftHanded", label: "Left-handed", testId: "prop-helix-left", when: kind("helix") },
  { kind: "bool", key: "path.helix.reverse", label: "Reverse direction", testId: "prop-helix-reverse", when: kind("helix"), hint: "Climb the other way along the axis" },
  { kind: "number", key: "path.helix.taper", label: "Taper", unit: "°", default: 0, omitDefault: true, testId: "prop-helix-taper", when: kind("helix"), hint: "Wider along the axis (negative: narrower): a conical spring" },
  { kind: "number", key: "path.helix.startAngle", label: "Start angle", unit: "°", default: 0, omitDefault: true, testId: "prop-helix-start", when: (f) => kind("helix")(f) && isCircle(f), hint: "Where it starts round the axis (a profile sketch sets this itself)" },
  { kind: "number", key: "twist", label: "Twist", unit: "°", default: 0, omitDefault: true, testId: "prop-twist", when: (f) => f.orientation !== "fixed", hint: "How far the profile turns about the path, start to end" },
  {
    kind: "select",
    key: "orientation",
    label: "Orientation",
    testId: "prop-orientation",
    options: [
      ["follow", "Follow the path"],
      ["fixed", "Keep its orientation"],
    ],
    default: "follow",
    omitDefault: true,
    when: (f) => !f.twist,
  },
  ...operationFields("Cut (swept cut)"),
];

export const ui: UiOp = {
  op: "sweep",
  label: "Sweep",
  icon: "sweep",
  fields: SWEEP_FIELDS,
  summary: (f) => {
    const parts: string[] = [];
    if (isCircle(f)) parts.push(`Ø${circleOf(f).diameter}${circleOf(f).inner !== undefined ? ` / ${circleOf(f).inner}` : ""}`);
    const k = pathKind(f.path);
    if (k === "helix") {
      const h = helixOf(f);
      const turns = h.turns ?? (typeof h.height === "number" && typeof h.pitch === "number" ? Math.round((h.height / h.pitch) * 100) / 100 : undefined);
      parts.push(turns !== undefined ? `helix ${turns} turns` : "helix");
    } else if (k === "edges") parts.push("along edges");
    if (f.twist) parts.push(`${f.twist}° twist`);
    if (f.operation === "remove") parts.push("cut");
    return parts.join(" ") || null;
  },
  sketchOf: (f) => (typeof f.profile === "string" ? f.profile : pathKind(f.path) === "sketch" ? String((f.path as Raw).sketch) : null),
};
