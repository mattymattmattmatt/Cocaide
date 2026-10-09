// Revolve's properties: the sketch, the axis (a line of the sketch, or a
// reference axis or straight model edge picked in the view), what it does to
// the part (add, cut, new body, intersect), how far it turns and which way
// (one direction, two, or split about the sketch plane), and a thin wall.

import type { Vec3 } from "../../doc/types";
import { sketchFrameIn } from "../../ui/model/sketchPlane";
import type { FieldSpec } from "../../ui/props/spec";
import type { UiOp } from "../uiDefs";
import { isLineAxis } from "./doc";

type Raw = Record<string, unknown>;

const lineAxis = (f: Raw) => isLineAxis(f.axis);
const thin = (f: Raw) => typeof f.thin === "object" && f.thin !== null;
const direction = (f: Raw) => (f.midplane === true ? "mid" : f.angle2 !== undefined ? "two" : "one");
/** The operation as it will be: the one written, else add when there is a body before it, else new. */
const operationOf = (f: Raw, bodies: string[]) => (typeof f.operation === "string" ? f.operation : f.newBody !== undefined ? "new" : f.body !== undefined || bodies.length > 0 ? "add" : "new");

/** The sketch's line to turn about: a construction line (a centreline) first, else any line. */
export function preferredLine(sketch: Raw | undefined): string | undefined {
  const lines = (Array.isArray(sketch?.entities) ? sketch.entities : []) as { id: string; type: string; construction?: boolean }[];
  return (lines.find((e) => e.type === "line" && e.construction) ?? lines.find((e) => e.type === "line"))?.id;
}

const DEFAULT_AXES: [string, Vec3][] = [
  ["X", [1, 0, 0]],
  ["Y", [0, 1, 0]],
  ["Z", [0, 0, 1]],
];

/**
 * The default axis to start a reference axis from: one lying in the sketch's
 * plane (through the origin, square to its normal), the one nearest the
 * sketch's own vertical first (where a centreline usually runs); Y when
 * none does (the revolve then says why, until one is picked).
 */
export function defaultAxisIn(frame: { origin: Vec3; x: Vec3; y: Vec3; z: Vec3 } | string): string {
  if (typeof frame === "string") return "Y";
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (Math.abs(dot(frame.origin, frame.z)) > 1e-6) return "Y";
  const inPlane = DEFAULT_AXES.filter(([, d]) => Math.abs(dot(d, frame.z)) < 1e-6);
  const best = inPlane.sort((a, b) => Math.abs(dot(b[1], frame.y)) - Math.abs(dot(a[1], frame.y)))[0];
  return best ? best[0] : "Y";
}

export const REVOLVE_FIELDS: FieldSpec[] = [
  { kind: "sketch", key: "sketch", label: "Sketch", testId: "prop-sketch" },
  {
    kind: "select",
    key: "axis",
    label: "Axis",
    testId: "prop-axis-from",
    options: [
      ["line", "A line of the sketch"],
      ["ref", "An axis or straight edge"],
    ],
    get: (f) => (lineAxis(f) ? "line" : "ref"),
    set: (v, f, c) => {
      if (v === "ref") return { axis: { datum: defaultAxisIn(sketchFrameIn(c.before.find((g) => g.id === f.sketch), c.view)) } };
      const line = preferredLine(c.before.find((g) => g.id === f.sketch));
      if (!line) throw new Error("The sketch has no lines: draw a centreline in it to turn about, or pick an axis or a straight edge instead.");
      return { axis: { line } };
    },
  },
  { kind: "sketchLine", key: "axis.line", label: "Axis line", testId: "prop-axis-line", when: lineAxis, hint: "Any line of the sketch: a centreline, usually" },
  { kind: "datumRef", key: "axis", label: "Axis", accepts: ["axis"], testId: "prop-axis", when: (f) => !lineAxis(f), hint: "A default axis, an axis feature, or a straight edge or a cylinder picked in the view; it must lie in the sketch's plane" },
  {
    kind: "select",
    key: "operation",
    label: "Operation",
    testId: "prop-operation",
    options: [
      ["add", "Add material"],
      ["remove", "Cut (revolved cut)"],
      ["new", "New body"],
      ["intersect", "Keep the common part"],
    ],
    get: (f, c) => operationOf(f, c.bodies),
    // The body fields belong to one operation each: switching clears them.
    set: (v, _f, c) => ({ operation: v === (c.bodies.length > 0 ? "add" : "new") ? null : v, body: null, bodies: null, newBody: null }),
  },
  {
    kind: "select",
    key: "body",
    label: "Body",
    testId: "prop-body",
    options: (_f, c) => c.bodies.map((b): [string, string] => [b, b]),
    when: (f, c) => c.bodies.length > 1 && ["add", "intersect"].includes(operationOf(f, c.bodies)),
  },
  { kind: "bodies", key: "bodies", label: "Cut from", allowEmpty: true, emptyHint: "none ticked: every body it reaches", testId: "prop-bodies", when: (f, c) => c.bodies.length > 1 && operationOf(f, c.bodies) === "remove" },
  {
    kind: "select",
    key: "midplane",
    label: "Direction",
    testId: "prop-revolve-direction",
    options: [
      ["one", "One direction"],
      ["two", "Two directions"],
      ["mid", "Mid-plane"],
    ],
    get: direction,
    set: (v, f) => (v === "mid" ? { midplane: true, angle2: null } : v === "two" ? { midplane: null, angle2: f.angle2 ?? 30, angle: typeof f.angle === "number" && f.angle > 330 ? 180 : f.angle ?? 180 } : { midplane: null, angle2: null }),
  },
  { kind: "number", key: "angle", label: "Angle", unit: "°", min: 0, default: 360, omitDefault: true, testId: "prop-angle", get: (f) => f.angle ?? 360 },
  { kind: "number", key: "angle2", label: "Angle 2", unit: "°", min: 0, testId: "prop-angle2", when: (f) => direction(f) === "two" },
  { kind: "bool", key: "reverse", label: "Reverse direction", testId: "prop-reverse", when: (f) => direction(f) !== "mid" },
  {
    kind: "bool",
    key: "thin",
    label: "Thin feature",
    testId: "prop-thin",
    hint: "Thicken the profile into a wall: an open chain of lines and arcs, or the profile's loops",
    get: thin,
    set: (on) => ({ thin: on ? { thickness: 2 } : null }),
  },
  { kind: "number", key: "thin.thickness", label: "Wall", unit: "mm", min: 0, testId: "prop-thin-thickness", when: thin },
  {
    kind: "select",
    key: "thin.side",
    label: "Wall side",
    testId: "prop-thin-side",
    options: [
      ["outside", "Outside (away from the axis)"],
      ["inside", "Inside"],
      ["mid", "Centred on the profile"],
    ],
    default: "outside",
    omitDefault: true,
    when: thin,
  },
];

export const ui: UiOp = {
  op: "revolve",
  label: "Revolve",
  icon: "revolve",
  fields: REVOLVE_FIELDS,
  summary: (f) => {
    const angle = f.midplane ? Number(f.angle ?? 360) : Number(f.angle ?? 360) + Number(f.angle2 ?? 0);
    const parts = [`${Number.isFinite(angle) ? angle : f.angle}°`];
    if (f.operation === "remove") parts.push("cut");
    if (thin(f)) parts.push("thin");
    return parts.join(" ");
  },
  sketchOf: (f) => (typeof f.sketch === "string" ? f.sketch : null),
};
