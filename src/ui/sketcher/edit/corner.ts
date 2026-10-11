// Fillet ▾: Sketch fillet and Sketch chamfer. Pick corners (the point where
// two lines or arcs meet), or the two entities, or a whole rectangle for all
// its corners; the preview shows the result; Apply (Enter) makes them, one
// radius dimension for every fillet made at once (the rest equal to it).

import { chamferCorners, cornersOf, filletCorners, type ChamferMode } from "../../../geom/sketchEdit/fillet";
import type { SketchState } from "../../../geom/sketchEdit/relations";
import type { FlyoutDef, ToolOptions } from "../tools/types";
import { changedBy, count, fromSelection, pickedEntity, toggle } from "./picks";
import type { EditPicks, EditToolDef } from "./types";

const FILLET: FlyoutDef = { id: "fillet", label: "Fillet" };

function pickCorner(state: SketchState, picks: EditPicks, input: Parameters<EditToolDef["click"]>[2]) {
  const item = input.item;
  // A corner by its point: an end shared by two lines or arcs.
  if (item?.kind === "point") {
    const owner = state.entities.find((e) => e.id === item.ref.split(".")[0]);
    if (owner && owner.type !== "point" && !owner.ref) return { picks: { ...picks, points: toggle(picks.points, item.ref) } };
  }
  const e = pickedEntity(state, input);
  if (!e) return { message: "click a corner (where two lines or arcs meet), or the two entities to round between" };
  if (e.type === "circle" || e.type === "point") return { message: `${e.id} is a ${e.type}: corners are where lines and arcs meet` };
  return { picks: { ...picks, entities: toggle(picks.entities, e.id) } };
}

/** The corners picked, with the sketch (rectangles exploded), or why there are none. */
function corners(state: SketchState, picks: EditPicks) {
  if (!picks.points.length && !picks.entities.length) return null;
  // A corner picked twice (by its point, and by the point of the other entity there) is one corner.
  const seen = new Set<string>();
  const points = picks.points.filter((r) => {
    const e = state.entities.find((x) => x.id === r.split(".")[0]);
    const p = e ? (e as unknown as Record<string, [number, number]>)[r.split(".")[1]] : null;
    const key = p ? `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}` : r;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return cornersOf(state, { entities: picks.entities, points });
}

const picked = (picks: EditPicks) => picks.points.length + picks.entities.length;

function chamferMode(o: ToolOptions): ChamferMode {
  return o.mode === "angle" ? { kind: "angle", d: Number(o.distance), angle: Number(o.angle) } : { kind: "distances", d1: Number(o.distance), d2: o.equal === "on" ? Number(o.distance) : Number(o.distance2) };
}

export const tools: EditToolDef[] = [
  {
    id: "sketch.fillet",
    name: "fillet",
    label: "Fillet",
    icon: "sketchFillet",
    title: "Sketch fillet: round corners with a tangent arc of one radius (pick the corner points, the two entities, or a rectangle); Apply or Enter",
    flyout: FILLET,
    kind: "collect",
    options: [
      { kind: "number", key: "radius", label: "Radius", title: "The fillet radius: one dimension drives every fillet made at once", default: 5, min: 0.001, max: 100000, step: 1, unit: "mm" },
      {
        kind: "toggle",
        key: "keep",
        label: "Keep constrained corners",
        title: "Leave a construction point at each old corner (a virtual sharp) for the relations and dimensions that ran to it",
        default: "on",
      },
    ],
    start: (selection, state) => fromSelection(selection, state, { points: true }),
    prompt: (picks) => (picked(picks) ? `${count(picked(picks), "pick", "picks")}: Apply (Enter) rounds them, or pick more` : "Click the corners to round (or the two entities, or a rectangle)"),
    click: (state, picks, input) => pickCorner(state, picks, input),
    apply: (state, picks, o) => {
      const c = corners(state, picks);
      if (!c) return null;
      if (typeof c === "string") return c;
      return filletCorners(c.state, c.corners, Number(o.radius), { keepCorners: o.keep === "on" });
    },
    preview: (state, picks, o) => changedBy(state, tools[0].apply!(state, picks, o)),
  },
  {
    id: "sketch.chamfer",
    name: "chamfer",
    label: "Chamfer",
    icon: "sketchChamfer",
    title: "Sketch chamfer: cut corners between two lines with a straight edge, by two distances or a distance and an angle; Apply or Enter",
    flyout: FILLET,
    kind: "collect",
    options: [
      {
        kind: "choice",
        key: "mode",
        label: "Chamfer by",
        title: "Two distances from the corner, or a distance and an angle",
        default: "distances",
        choices: [
          { value: "distances", label: "Distances", title: "Set back by a distance along each line" },
          { value: "angle", label: "Angle", title: "Set back by a distance along the first line, at an angle to it" },
        ],
      },
      { kind: "number", key: "distance", label: "Distance", title: "Along the first line from the corner", default: 3, min: 0.001, max: 100000, unit: "mm" },
      { kind: "toggle", key: "equal", label: "Equal", title: "The same distance along both lines", default: "on" },
      { kind: "number", key: "distance2", label: "Distance 2", title: "Along the second line (Distances, not equal)", default: 5, min: 0.001, max: 100000, unit: "mm" },
      { kind: "number", key: "angle", label: "Angle", title: "Between the chamfer and the first line (Angle)", default: 45, min: 0.1, max: 179, unit: "°" },
    ],
    start: (selection, state) => fromSelection(selection, state, { points: true }),
    prompt: (picks) => (picked(picks) ? `${count(picked(picks), "pick", "picks")}: Apply (Enter) cuts them, or pick more` : "Click the corners to cut (or the two lines)"),
    click: (state, picks, input) => pickCorner(state, picks, input),
    apply: (state, picks, o) => {
      const c = corners(state, picks);
      if (!c) return null;
      if (typeof c === "string") return c;
      return chamferCorners(c.state, c.corners, chamferMode(o));
    },
    preview: (state, picks, o) => changedBy(state, tools[1].apply!(state, picks, o)),
  },
];
