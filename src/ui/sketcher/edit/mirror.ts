// Mirror entities: pick what to mirror, then the line to mirror about (a
// centreline, any line, or the sketch's X or Y axis; a centreline or an axis
// clicked after the entities is taken as the mirror line at once, any other
// line after "Mirror about" in the strip); Apply (Enter) makes the copies,
// held by symmetric relations.

import { constraintTargets, isAxisId } from "../../../geom/axes";
import { mirrorEntities } from "../../../geom/sketchEdit/mirror";
import { isConstruction } from "../../../doc/sketch";
import { changedBy, count, fromSelection, lineAt, pickedEntity, toggle } from "./picks";
import type { EditToolDef } from "./types";

export const tools: EditToolDef[] = [
  {
    id: "sketch.mirror",
    name: "mirror",
    label: "Mirror",
    icon: "mirrorEntities",
    title: "Mirror entities about a line or centreline: copies held symmetric to the originals; Apply or Enter",
    kind: "collect",
    options: [{ kind: "toggle", key: "copy", label: "Copy", title: "Keep the originals and add mirrored copies (off: move them over)", default: "on" }],
    start: (selection, state) => {
      const picks = fromSelection(selection, state);
      // A centreline picked last with the entities is the mirror line, as SOLIDWORKS takes it; not one tied to
      // them by a relation (a slot's own centreline, in a box round the slot), which is one of the entities.
      const last = picks.entities[picks.entities.length - 1];
      const e = state.entities.find((x) => x.id === last);
      const tied = state.constraints.some((k) => {
        const ids = constraintTargets(k);
        return ids.includes(last) && ids.some((id) => id !== last && picks.entities.includes(id));
      });
      const line = e?.type === "line" && isConstruction(e) && !tied ? last : undefined;
      const axis = selection.find((i) => i.kind === "entity" && isAxisId(i.id));
      const about = line && picks.entities.length > 1 ? line : axis && axis.kind === "entity" ? axis.id : undefined;
      return { ...picks, entities: picks.entities.filter((id) => id !== about), ...(about ? { about } : {}) };
    },
    prompt: (picks) =>
      !picks.entities.length
        ? "Click the entities to mirror"
        : !picks.about
          ? `${count(picks.entities.length, "entity", "entities")} to mirror: now click the line to mirror about (a centreline is taken at once)`
          : `Mirror ${count(picks.entities.length, "entity", "entities")} about ${picks.about}: Apply (Enter)`,
    click: (state, picks, input) => {
      const line = lineAt(state, input);
      if (line && line === picks.about) return { picks: { ...picks, about: undefined } };
      const lineEntity = line ? state.entities.find((x) => x.id === line) : undefined;
      // The mirror line: an axis; a centreline once there is something to mirror; any line once "Mirror about" is pressed.
      const about =
        !!line && !input.additive && (isAxisId(line) || (picks.entities.length > 0 && ((!!lineEntity && isConstruction(lineEntity)) || picks.picking === false)));
      if (about) return { picks: { ...picks, about: line!, entities: picks.entities.filter((id) => id !== line), picking: undefined } };
      const e = pickedEntity(state, input);
      if (!e) return { message: "click the entities to mirror, then the line to mirror about" };
      return { picks: { ...picks, entities: toggle(picks.entities, e.id) } };
    },
    apply: (state, picks, o) => (picks.entities.length && picks.about ? mirrorEntities(state, picks.entities, picks.about, { copy: o.copy !== "off" }) : null),
    preview: (state, picks, o) => changedBy(state, tools[0].apply!(state, picks, o)),
  },
];
