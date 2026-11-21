// Starter frame layouts, the usual first step of a frame: parameters for its
// sizes and a layout sketch driven by them, ready for Members from sketch.
// - wall: a rectangle with posts evenly between its sides, a 2D sketch on
//   Front, dimensioned by frame_w and frame_h (it re-solves when they change);
// - box: a table or stand, a 3D sketch frame_w × frame_d × frame_h;
// - portal: a pitched frame, posts frame_h to the eaves and the ridge
//   frame_rise above them, in bays frame_bay apart joined at the eaves and
//   the ridge (a 3D sketch).
// Pure: the commands that add it, as one change.

import type { Command, RawDocument } from "../doc/commands";

export type FrameTemplate = "wall" | "box" | "portal";

export interface TemplateSpec {
  kind: FrameTemplate;
  width: number;
  height: number;
  /** box: front to back. */
  depth?: number;
  /** wall: posts between the two sides. */
  posts?: number;
  /** portal: the ridge above the eaves, the bays, and how far apart. */
  rise?: number;
  bays?: number;
  bay?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The next free id with this stem: frame_layout, frame_layout_2, ... */
function freeId(doc: RawDocument, stem: string): string {
  const taken = new Set(doc.features.map((f) => String(f.id)));
  if (!taken.has(stem)) return stem;
  for (let k = 2; ; k++) if (!taken.has(`${stem}_${k}`)) return `${stem}_${k}`;
}

/** The commands that add the template's parameters and its sketch (and the sketch's id), or why not. */
export function frameTemplate(doc: RawDocument, spec: TemplateSpec): { commands: Command[]; sketch: string } | { error: string } {
  const positive = (x: number | undefined, what: string) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? null : `${what} must be more than 0`);
  const problem = positive(spec.width, "the width") ?? positive(spec.height, "the height") ?? (spec.kind === "box" ? positive(spec.depth, "the depth") : null) ?? (spec.kind === "portal" ? (positive(spec.rise, "the rise") ?? positive(spec.bay, "the bay")) : null);
  if (problem) return { error: problem };
  const params = isObject(doc.parameters) ? doc.parameters : {};
  const commands: Command[] = [];
  const param = (name: string, value: number) => {
    // An existing parameter of that name is used as it is (another frame's sizes may drive this one too).
    if (!(name in params)) commands.push({ type: "setParameter", name, value });
  };
  param("frame_w", spec.width);
  param("frame_h", spec.height);
  if (spec.kind === "wall") {
    const id = freeId(doc, "wall_layout");
    const w = spec.width;
    const h = spec.height;
    const n = Math.max(0, Math.min(20, Math.round(spec.posts ?? 0)));
    const line = (eid: string, start: [number, number], end: [number, number]) => ({ id: eid, type: "line", start, end });
    const entities = [line("bottom", [0, 0], [w, 0]), line("right", [w, 0], [w, h]), line("top", [w, h], [0, h]), line("left", [0, h], [0, 0])];
    const constraints: Record<string, unknown>[] = [
      { type: "coincident", points: ["bottom.start", "origin"] },
      { type: "coincident", points: ["bottom.end", "right.start"] },
      { type: "coincident", points: ["right.end", "top.start"] },
      { type: "coincident", points: ["top.end", "left.start"] },
      { type: "coincident", points: ["left.end", "bottom.start"] },
      { type: "horizontal", entity: "bottom" },
      { type: "horizontal", entity: "top" },
      { type: "vertical", entity: "left" },
      { type: "vertical", entity: "right" },
      { type: "distanceX", entity: "bottom", value: "=frame_w", name: "width" },
      { type: "distanceY", entity: "left", value: "=frame_h", name: "height" },
    ];
    for (let k = 1; k <= n; k++) {
      const x = (w * k) / (n + 1);
      const pid = `post${k}`;
      entities.push(line(pid, [x, 0], [x, h]));
      constraints.push(
        { type: "vertical", entity: pid },
        { type: "pointOn", point: `${pid}.start`, entity: "bottom" },
        { type: "pointOn", point: `${pid}.end`, entity: "top" },
        { type: "distanceX", points: ["origin", `${pid}.start`], value: `=frame_w * ${k} / ${n + 1}`, name: `post${k}_at` },
      );
    }
    commands.push({ type: "addFeature", feature: { id, op: "sketch", plane: { type: "ref", ref: { datum: "Front" } }, entities, constraints } });
    return { commands, sketch: id };
  }
  const id = freeId(doc, spec.kind === "box" ? "box_layout" : "portal_layout");
  const points: Record<string, unknown>[] = [];
  const lines: Record<string, unknown>[] = [];
  const pt = (pid: string, p: Record<string, unknown>) => points.push({ id: pid, ...p });
  const ln = (a: string, b: string) => lines.push({ id: `l${lines.length + 1}`, start: a, end: b });
  if (spec.kind === "box") {
    param("frame_d", spec.depth!);
    pt("b1", { at: [0, 0, 0] });
    pt("b2", { from: "b1", by: ["=frame_w", 0, 0] });
    pt("b3", { from: "b2", by: [0, "=frame_d", 0] });
    pt("b4", { from: "b1", by: [0, "=frame_d", 0] });
    for (const k of [1, 2, 3, 4]) pt(`t${k}`, { from: `b${k}`, by: [0, 0, "=frame_h"] });
    for (const r of ["b", "t"]) for (const [a, b] of [[1, 2], [2, 3], [3, 4], [4, 1]]) ln(`${r}${a}`, `${r}${b}`);
    for (const k of [1, 2, 3, 4]) ln(`b${k}`, `t${k}`);
  } else {
    param("frame_rise", spec.rise!);
    param("frame_bay", spec.bay!);
    const bays = Math.max(1, Math.min(20, Math.round(spec.bays ?? 1)));
    for (let k = 0; k <= bays; k++) {
      // Each portal: feet, eaves, ridge.
      if (k === 0) pt("f0a", { at: [0, 0, 0] });
      else pt(`f${k}a`, { from: `f${k - 1}a`, by: [0, "=frame_bay", 0] });
      pt(`f${k}b`, { from: `f${k}a`, by: ["=frame_w", 0, 0] });
      pt(`e${k}a`, { from: `f${k}a`, by: [0, 0, "=frame_h"] });
      pt(`e${k}b`, { from: `f${k}b`, by: [0, 0, "=frame_h"] });
      pt(`r${k}`, { from: `e${k}a`, by: ["=frame_w / 2", 0, "=frame_rise"] });
      ln(`f${k}a`, `e${k}a`);
      ln(`e${k}a`, `r${k}`);
      ln(`r${k}`, `e${k}b`);
      ln(`e${k}b`, `f${k}b`);
      if (k > 0) {
        // Eave rails and the ridge between this portal and the last.
        ln(`e${k - 1}a`, `e${k}a`);
        ln(`e${k - 1}b`, `e${k}b`);
        ln(`r${k - 1}`, `r${k}`);
      }
    }
  }
  commands.push({ type: "addFeature", feature: { id, op: "sketch3d", points, lines } });
  return { commands, sketch: id };
}
