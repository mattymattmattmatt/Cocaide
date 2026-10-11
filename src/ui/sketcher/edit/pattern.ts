// Pattern ▾: Linear and Circular sketch patterns. Pick the seed entities;
// set the count, spacing and direction (or the total angle, round the
// origin or a sketch point clicked as the centre); the preview marks each
// place, and clicking one leaves it out (and back in); Apply (Enter) makes
// the copies, equal to the seed, with one spacing (or angle) dimension.

import { circularPattern, linearPattern, patternPlaces } from "../../../geom/sketchEdit/pattern";
import type { SketchState } from "../../../geom/sketchEdit/relations";
import { dist2 } from "../../../geom/vec";
import type { FlyoutDef, ToolOptions } from "../tools/types";
import { changedBy, count, fromSelection, pickedEntity, toggle } from "./picks";
import type { EditInput, EditPicks, EditPreview, EditStep, EditToolDef } from "./types";

const PATTERN: FlyoutDef = { id: "pattern", label: "Pattern" };

const linearOptions = (o: ToolOptions, picks: EditPicks) => ({ count: Number(o.count), spacing: Number(o.spacing), angle: Number(o.angle), skip: picks.skip ?? [] });
const circularOptions = (o: ToolOptions, picks: EditPicks) => ({ count: Number(o.count), total: Number(o.total), center: picks.points[0] ?? "origin", skip: picks.skip ?? [] });

/** A click on a place the preview marks leaves that instance out, or puts it back. */
function skipAt(state: SketchState, picks: EditPicks, input: EditInput, kind: "linear" | "circular", o: ToolOptions): EditStep | null {
  if (!picks.entities.length) return null;
  const places = patternPlaces(state, picks.entities, kind, kind === "linear" ? linearOptions(o, picks) : circularOptions(o, picks));
  const hit = places.find((x) => dist2(x.at, input.p) <= Math.max(2 * input.tol, 1e-9));
  if (!hit) return null;
  const skip = picks.skip ?? [];
  return { picks: { ...picks, skip: skip.includes(hit.k) ? skip.filter((k) => k !== hit.k) : [...skip, hit.k] } };
}

function preview(state: SketchState, picks: EditPicks, kind: "linear" | "circular", o: ToolOptions, apply: EditToolDef["apply"]): EditPreview {
  if (!picks.entities.length) return {};
  const shown = changedBy(state, apply!(state, picks, o));
  const places = patternPlaces(state, picks.entities, kind, kind === "linear" ? linearOptions(o, picks) : circularOptions(o, picks));
  return { ...shown, marks: places.map((x) => ({ at: x.at, label: String(x.k), off: (picks.skip ?? []).includes(x.k) })) };
}

const COUNT = { kind: "number" as const, key: "count", label: "Instances", title: "How many, the seed included", default: 3, min: 2, max: 200, integer: true };

export const tools: EditToolDef[] = [
  {
    id: "sketch.linearPattern",
    name: "linear-pattern",
    label: "Linear pattern",
    icon: "linearSketchPattern",
    title: "Linear sketch pattern: copies of the picked entities in a row, equal to them, spaced by one dimension; click a place to skip it; Apply or Enter",
    flyout: PATTERN,
    kind: "collect",
    options: [
      COUNT,
      { kind: "number", key: "spacing", label: "Spacing", title: "From one instance to the next: the dimension that drives them all", default: 20, min: 0.001, max: 100000, unit: "mm" },
      { kind: "number", key: "angle", label: "Direction", title: "The row's direction, anticlockwise from the sketch's x axis", default: 0, min: -360, max: 360, step: 15, unit: "°" },
    ],
    start: (selection, state) => fromSelection(selection, state),
    prompt: (picks) => (picks.entities.length ? `${count(picks.entities.length, "entity", "entities")} to pattern: click a place to skip it; Apply (Enter)` : "Click the entities to pattern"),
    click: (state, picks, input, o) => {
      const skipped = skipAt(state, picks, input, "linear", o);
      if (skipped) return skipped;
      const e = pickedEntity(state, input);
      if (!e) return { message: "click the entities to pattern (a place the preview marks skips that instance)" };
      return { picks: { ...picks, entities: toggle(picks.entities, e.id), skip: [] } };
    },
    apply: (state, picks, o) => (picks.entities.length ? linearPattern(state, picks.entities, linearOptions(o, picks)) : null),
    preview: (state, picks, o) => preview(state, picks, "linear", o, tools[0].apply),
  },
  {
    id: "sketch.circularPattern",
    name: "circular-pattern",
    label: "Circular pattern",
    icon: "circularSketchPattern",
    title: "Circular sketch pattern: copies of the picked entities round the origin or a sketch point (click it), equally spaced by one angle dimension; Apply or Enter",
    flyout: PATTERN,
    kind: "collect",
    options: [
      { ...COUNT, default: 6 },
      { kind: "number", key: "total", label: "Total angle", title: "The angle the instances span; 360 spaces them all the way round", default: 360, min: -360, max: 360, step: 15, unit: "°" },
    ],
    start: (selection, state) => fromSelection(selection, state),
    prompt: (picks) =>
      picks.entities.length
        ? `${count(picks.entities.length, "entity", "entities")} round ${picks.points[0] ?? "the origin"}: click a sketch point for another centre, a place to skip it; Apply (Enter)`
        : "Click the entities to pattern",
    click: (state, picks, input, o) => {
      const skipped = skipAt(state, picks, input, "circular", o);
      if (skipped) return skipped;
      // A point clicked once there is a seed: the centre (the origin's dot too).
      if (picks.entities.length && input.item?.kind === "point") return { picks: { ...picks, points: picks.points[0] === input.item.ref ? [] : [input.item.ref] } };
      const e = pickedEntity(state, input);
      if (!e) return { message: "click the entities to pattern, then a sketch point for the centre (or leave it at the origin)" };
      return { picks: { ...picks, entities: toggle(picks.entities, e.id), skip: [] } };
    },
    apply: (state, picks, o) => (picks.entities.length ? circularPattern(state, picks.entities, circularOptions(o, picks)) : null),
    preview: (state, picks, o) => preview(state, picks, "circular", o, tools[1].apply),
  },
];
