// Move ▾: Move, Copy, Rotate and Scale entities. Pick the entities (or have
// them selected first); click in empty space (or press Enter) when they are
// all picked; then:
// - Move and Copy: click the base point and where it goes (each snapped to
//   sketch points and the grid), or type ΔX and ΔY and Apply;
// - Rotate: click the centre (the origin unless clicked) and type the angle,
//   or click a point and where it turns to; Apply;
// - Scale: click the centre and type the factor; Apply.
// Keep relations keeps what ties them to the rest (which then moves along).

import { angleBetween, transformEntities, type Transform } from "../../../geom/sketchEdit/transform";
import type { SketchState } from "../../../geom/sketchEdit/relations";
import type { FlyoutDef, ToolOption, ToolOptions } from "../tools/types";
import { changedBy, count, fromSelection, pickedEntity, toggle } from "./picks";
import type { EditPicks, EditStep, EditToolDef } from "./types";

const MOVE: FlyoutDef = { id: "move", label: "Move" };

const KEEP: ToolOption = { kind: "toggle", key: "keep", label: "Keep relations", title: "Keep the relations to entities that were not picked: they move along (or hold these back)", default: "off" };

/** Picking: a click on an entity adds or drops it; a click elsewhere (or Enter) ends the picking. */
function pickOrPlace(state: SketchState, picks: EditPicks, input: Parameters<EditToolDef["click"]>[2], placesWanted: number, verb: string, done: (picks: EditPicks) => EditStep | null): EditStep {
  if (picks.picking !== false) {
    const e = pickedEntity(state, input);
    if (e) return { picks: { ...picks, entities: toggle(picks.entities, e.id) } };
    if (!picks.entities.length) return { message: `click the entities to ${verb} first` };
    return { picks: { ...picks, picking: false } };
  }
  const next = { ...picks, places: [...picks.places, { p: input.p, ref: input.ref }].slice(-placesWanted) };
  return (next.places.length === placesWanted && done(next)) || { picks: next };
}

/** The transformation the picks and options make, or null while it isn't set. */
function transformOf(kind: "move" | "rotate" | "scale", picks: EditPicks, o: ToolOptions, typed: boolean): Transform | null {
  const [a, b, c] = picks.places.map((x) => x.p);
  if (kind === "move") {
    if (!typed && a && b) return { kind: "move", by: [b[0] - a[0], b[1] - a[1]] };
    return { kind: "move", by: [Number(o.dx), Number(o.dy)] };
  }
  const centre = a ?? [0, 0];
  if (kind === "rotate") return { kind: "rotate", center: centre, angle: !typed && b && c ? angleBetween(centre, b, c) : Number(o.angle) };
  return { kind: "scale", center: centre, factor: Number(o.factor) };
}

const moving = (picks: EditPicks) => picks.picking === false;

function def(name: "move" | "copy" | "rotate" | "scale"): EditToolDef {
  const kind = name === "copy" ? "move" : name;
  const copy = name === "copy";
  const opts: ToolOption[] =
    kind === "move"
      ? [
          { kind: "number", key: "dx", label: "ΔX", title: "How far along x (typed; or click a base point and where it goes)", default: 10, min: -100000, max: 100000, unit: "mm" },
          { kind: "number", key: "dy", label: "ΔY", title: "How far along y", default: 0, min: -100000, max: 100000, unit: "mm" },
          ...(copy ? [{ kind: "number", key: "count", label: "Copies", title: "Copies made, each on from the last", default: 1, min: 1, max: 100, integer: true } as ToolOption] : [KEEP]),
        ]
      : kind === "rotate"
        ? [{ kind: "number", key: "angle", label: "Angle", title: "Anticlockwise about the centre (typed; or click a point and where it turns to)", default: 90, min: -360, max: 360, step: 15, unit: "°" }, KEEP]
        : [
            { kind: "number", key: "factor", label: "Factor", title: "How many times bigger, about the centre", default: 2, min: 0.001, max: 1000, step: 0.5 },
            { kind: "toggle", key: "copy", label: "Copy", title: "Scale a copy, leave the originals", default: "off" },
          ];
  const places = kind === "move" ? 2 : kind === "rotate" ? 3 : 1;
  const run = (state: SketchState, picks: EditPicks, o: ToolOptions, typed: boolean) => {
    const t = transformOf(kind, picks, o, typed);
    if (!t || !picks.entities.length) return null;
    return transformEntities(state, picks.entities, t, { copy: copy || (kind === "scale" && o.copy === "on"), keepRelations: o.keep === "on", count: copy ? Number(o.count) : 1 });
  };
  const label = { move: "Move", copy: "Copy", rotate: "Rotate", scale: "Scale" }[name];
  return {
    id: `sketch.${name}`,
    name,
    label,
    icon: ({ move: "moveEntities", copy: "copyEntities", rotate: "rotateEntities", scale: "scaleEntities" } as const)[name],
    title: {
      move: "Move entities: pick them, then click a base point and where it goes (or type ΔX, ΔY and Apply)",
      copy: "Copy entities: pick them, then click a base point and where the copy goes (or type ΔX, ΔY and Apply)",
      rotate: "Rotate entities: pick them, click the centre, then type the angle and Apply (or click a point and where it turns to)",
      scale: "Scale entities: pick them, click the centre, type the factor and Apply",
    }[name],
    flyout: MOVE,
    kind: "collect",
    options: opts,
    start: (selection, state) => {
      const picks = fromSelection(selection, state);
      return { ...picks, picking: picks.entities.length ? false : true };
    },
    places: (picks) => moving(picks),
    prompt: (picks) => {
      if (!moving(picks)) return picks.entities.length ? `${count(picks.entities.length, "entity", "entities")}: pick more, or click in empty space (Enter) to go on` : `Click the entities to ${label.toLowerCase()}`;
      const n = picks.places.length;
      if (kind === "move") return n === 0 ? `Click the base point (or type ΔX, ΔY and Apply)` : `Click where the base point goes`;
      if (kind === "rotate") return n === 0 ? "Click the centre (or Apply to turn about the origin by the angle typed)" : n === 1 ? "Type the angle and Apply, or click a point to turn" : "Click where that point turns to";
      return n === 0 ? "Click the centre (or Apply to scale about the origin)" : "Type the factor and Apply";
    },
    click: (state, picks, input, o) =>
      pickOrPlace(state, picks, input, places, label.toLowerCase(), (next) => {
        // The last place clicked finishes a move or a rotation by clicks.
        if (kind === "scale") return null;
        const r = run(state, next, o, false);
        return r ? { edit: r } : null;
      }),
    apply: (state, picks, o) => {
      if (!picks.entities.length) return null;
      return run(state, picks, o, true);
    },
    preview: (state, picks, o, hover) => {
      if (!moving(picks)) return {};
      // While placing: the move as it would be with the pointer as the next place.
      const withHover = hover && ((kind === "move" && picks.places.length === 1) || (kind === "rotate" && picks.places.length === 2)) ? { ...picks, places: [...picks.places, { p: hover.p, ref: hover.ref }] } : null;
      return { add: changedBy(state, withHover ? run(state, withHover, o, false) : run(state, picks, o, true)).add };
    },
  };
}

export const tools: EditToolDef[] = [def("move"), def("copy"), def("rotate"), def("scale")];
