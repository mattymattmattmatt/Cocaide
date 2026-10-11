// Offset entities: click a line, arc or circle and its connected chain is
// taken (or pick several); the preview shows the offset to the side it will
// go (outside a closed chain, left of an open one; Reverse turns it round);
// Apply (Enter) makes it, held to the base by one offset distance dimension.

import { chainsOf, insideOf, offsetEntities, type OffsetOptions } from "../../../geom/sketchEdit/offset";
import type { SketchState } from "../../../geom/sketchEdit/relations";
import type { ToolOptions } from "../tools/types";
import { changedBy, count, fromSelection, pickedEntity, toggle } from "./picks";
import type { EditPicks, EditToolDef } from "./types";

/** The options as the geometry wants them: the side each chain goes, from Reverse and whether it is closed. */
export function offsetOptions(state: SketchState, picks: EditPicks, o: ToolOptions): OffsetOptions {
  const chain = o.chain !== "off";
  // Closed: outward unless reversed. Open: to its left (the way it was drawn) unless reversed.
  const chains = chainsOf(state.entities, picks.entities, chain);
  const first = typeof chains === "string" ? null : chains[0];
  const base: 1 | -1 = first?.closed ? (-insideOf(state.entities, first) as 1 | -1) : 1;
  return {
    distance: Number(o.distance),
    side: o.reverse === "on" ? (-base as 1 | -1) : base,
    both: o.both === "on",
    cap: o.cap === "arcs" || o.cap === "lines" ? o.cap : "none",
    corners: o.corners === "round" ? "round" : "sharp",
    construction: o.construction === "on",
    chain,
  };
}

export const tools: EditToolDef[] = [
  {
    id: "sketch.offset",
    name: "offset",
    label: "Offset",
    icon: "offset",
    title: "Offset entities: a copy of a chain of lines and arcs (or a circle) at a distance, held to it by one dimension; Apply or Enter",
    kind: "collect",
    options: [
      { kind: "number", key: "distance", label: "Distance", title: "How far from the base: one dimension moves the whole offset", default: 5, min: 0.001, max: 100000, unit: "mm" },
      { kind: "toggle", key: "reverse", label: "Reverse", title: "To the other side (a closed chain goes outside by default)", default: "off" },
      { kind: "toggle", key: "both", label: "Both directions", title: "Offset to both sides", default: "off" },
      {
        kind: "choice",
        key: "cap",
        label: "Cap ends",
        title: "An open chain offset both ways: close its ends",
        default: "none",
        choices: [
          { value: "none", label: "Open", title: "Leave the ends open" },
          { value: "arcs", label: "Arcs", title: "Close each end with an arc round it" },
          { value: "lines", label: "Lines", title: "Close each end with a line across it" },
        ],
      },
      {
        kind: "choice",
        key: "corners",
        label: "Corners",
        title: "Where the offsets of two lines open apart (the outside of a corner)",
        default: "sharp",
        choices: [
          { value: "sharp", label: "Sharp", title: "Run the lines on to meet" },
          { value: "round", label: "Round", title: "An arc round the corner" },
        ],
      },
      { kind: "toggle", key: "construction", label: "Base construction", title: "Make the base geometry construction", default: "off" },
      { kind: "toggle", key: "chain", label: "Select chain", title: "Take the whole chain joined to each picked entity", default: "on" },
    ],
    start: (selection, state) => fromSelection(selection, state),
    prompt: (picks) => (picks.entities.length ? `${count(picks.entities.length, "entity", "entities")} picked: Apply (Enter) offsets ${picks.entities.length === 1 ? "its chain" : "them"}` : "Click a line, arc or circle: its chain is offset"),
    click: (state, picks, input) => {
      const e = pickedEntity(state, input);
      if (!e || e.type === "point") return { message: "click a line, arc or circle to offset (its chain comes with it)" };
      return { picks: { ...picks, entities: toggle(picks.entities, e.id) } };
    },
    apply: (state, picks, o) => (picks.entities.length ? offsetEntities(state, picks.entities, offsetOptions(state, picks, o)) : null),
    preview: (state, picks, o) => {
      const r = tools[0].apply!(state, picks, o);
      return { add: changedBy(state, r).add?.filter((e) => typeof r !== "string" && r?.made?.includes(e.id)) };
    },
  },
];
