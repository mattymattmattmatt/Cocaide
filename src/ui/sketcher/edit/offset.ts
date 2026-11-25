// Offset entities: click a line, arc or circle (or a rectangle or slot) and its
// connected chain is taken (or pick several); hovering one before that shows
// its offset. The offset goes to the side the pointer is on (out of a closed
// chain or left of an open one until the pointer says otherwise; Reverse
// turns it round); a click away from the picks places it there, as does Apply
// (Enter). It is held to the base by one offset distance dimension.

import { flipTowards, offsetEntities, offsetSides, type OffsetOptions } from "../../../geom/sketchEdit/offset";
import type { SketchState } from "../../../geom/sketchEdit/relations";
import type { ToolOptions } from "../tools/types";
import { changedBy, count, fromSelection, pickedEntity, toggle } from "./picks";
import type { EditInput, EditPicks, EditPreview, EditToolDef } from "./types";

const OFFSETTABLE = new Set(["line", "arc", "circle", "rect", "slot"]);

/** The last preview made, for the sketch and picks it was made from. */
let last: { state: SketchState; key: string; preview: EditPreview } | null = null;

/** The options as the geometry wants them: each chain's side, from where the pointer went and Reverse. */
export function offsetOptions(state: SketchState, picks: EditPicks, o: ToolOptions): OffsetOptions {
  const chain = o.chain !== "off";
  const flip = !!picks.flip !== (o.reverse === "on");
  const sides = offsetSides(state, picks.entities, chain, flip);
  return {
    distance: Number(o.distance),
    side: sides[0] ?? (flip ? -1 : 1),
    sides,
    both: o.both === "on",
    cap: o.cap === "arcs" || o.cap === "lines" ? o.cap : "none",
    corners: o.corners === "round" ? "round" : "sharp",
    construction: o.construction === "on",
    chain,
  };
}

/** The picks with the side the pointer at `input` asks for (unchanged when it is too near the picks to tell). */
function towards(state: SketchState, picks: EditPicks, input: EditInput, o: ToolOptions, tol = input.tol): EditPicks {
  const flip = flipTowards(state, picks.entities, o.chain !== "off", input.p, tol);
  return flip === null || flip === !!picks.flip ? picks : { ...picks, flip };
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
        shown: (o) => o.both === "on",
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
    prompt: (picks) =>
      picks.entities.length
        ? `${count(picks.entities.length, "entity", "entities")} picked: point to the side to offset to, then click there (or Enter)`
        : "Click a line, arc or circle (its chain comes with it); hover one to see its offset",
    hover: (state, picks, input, o) => {
      if (!picks.entities.length) return null;
      const next = towards(state, picks, input, o);
      return next === picks ? null : next;
    },
    click: (state, picks, input, o) => {
      // Away from the geometry (empty space, or inside a region), with something picked: the offset goes there.
      if (!input.item || input.item.kind === "face") {
        if (picks.entities.length) return { edit: offsetEntities(state, picks.entities, offsetOptions(state, towards(state, picks, input, o, 0), o)) };
        return { message: "click a line, arc or circle to offset (its chain comes with it)" };
      }
      const e = pickedEntity(state, input);
      if (e && OFFSETTABLE.has(e.type)) return { picks: { ...picks, entities: toggle(picks.entities, e.id) } };
      if (e) return { message: `${e.id} is ${/^[aeiou]/.test(e.type) ? "an" : "a"} ${e.type}: offset takes lines, arcs, circles, rectangles and slots` };
      return { message: input.item.kind === "point" ? "click the line or arc itself, not its end, to offset it" : "that follows the model: Convert Entities copies it first, then offset the copy" };
    },
    apply: (state, picks, o) => (picks.entities.length ? offsetEntities(state, picks.entities, offsetOptions(state, picks, o)) : null),
    preview: (state, picks, o, hover) => {
      // Nothing picked yet: the chain under the pointer, offset its usual way.
      const e = !picks.entities.length && hover ? pickedEntity(state, hover) : null;
      const now = e && OFFSETTABLE.has(e.type) ? { ...picks, entities: [e.id] } : hover && picks.entities.length ? towards(state, picks, hover, o) : picks;
      if (!now.entities.length) return {};
      // The pointer moves often and the offset changes only with the side or the chain: the last one is kept.
      const key = JSON.stringify([now.entities, !!now.flip, o]);
      if (last && last.state === state && last.key === key) return last.preview;
      const r = offsetEntities(state, now.entities, offsetOptions(state, now, o));
      const preview = { add: changedBy(state, r).add?.filter((x) => typeof r !== "string" && r?.made?.includes(x.id)) };
      last = { state, key, preview };
      return preview;
    },
  },
];
