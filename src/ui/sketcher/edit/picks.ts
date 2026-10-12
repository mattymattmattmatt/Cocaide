// Gathering picks for the collecting edit tools, the same way for each: what
// a selection made beforehand gives them, a click that adds or drops an
// entity or a point, and a changed sketch's entities for the preview. Pure.

import type { SketchEntity } from "../../../doc/types";
import { isAxisId } from "../../../geom/axes";
import type { Edit, SketchState } from "../../../geom/sketchEdit/relations";
import type { SketchItem } from "../draft";
import { NO_PICKS, type EditInput, type EditPicks, type EditPreview } from "./types";

/** The sketch's own editable entities and points among the items: not model edges, faces, axes or references. */
export function fromSelection(selection: SketchItem[], state: SketchState, opts: { points?: boolean } = {}): EditPicks {
  const byId = new Map(state.entities.map((e) => [e.id, e]));
  const entities: string[] = [];
  const points: string[] = [];
  for (const i of selection) {
    if (i.kind === "entity") {
      const e = byId.get(i.id);
      if (e && !e.ref && !entities.includes(e.id)) entities.push(e.id);
    } else if (i.kind === "point") {
      const owner = byId.get(i.ref.split(".")[0]);
      if (!owner || owner.ref) continue;
      // A sketch point picked by its dot is the point entity itself, unless the tool wants points.
      if (owner.type === "point" && !opts.points) entities.includes(owner.id) || entities.push(owner.id);
      else if (opts.points && !points.includes(i.ref)) points.push(i.ref);
    }
  }
  return { ...NO_PICKS, entities, points };
}

/** The entity a click picks, if it is the sketch's own and not a reference (a point entity by its dot too). */
export function pickedEntity(state: SketchState, input: EditInput): SketchEntity | null {
  const item = input.item;
  if (!item || item.kind === "face") return null;
  const id = item.kind === "entity" ? item.id : item.ref.split(".")[0];
  const e = state.entities.find((x) => x.id === id);
  if (!e || e.ref) return null;
  if (item.kind === "point" && e.type !== "point") return null;
  return e;
}

/** A line the sketch can mirror about: its own line (a reference line too) or an axis. */
export function lineAt(state: SketchState, input: EditInput): string | null {
  const item = input.item;
  if (item?.kind !== "entity") return null;
  if (isAxisId(item.id)) return item.id;
  return state.entities.find((e) => e.id === item.id)?.type === "line" ? item.id : null;
}

/**
 * The picks without what is no longer in the sketch (an undo or redo took it
 * away): entities, points and the mirror line that name a missing entity
 * go (a placed point stays: where it is still means something). The same
 * object back when nothing went.
 */
export function livePicks(picks: EditPicks, state: SketchState): EditPicks {
  const ids = new Set(state.entities.map((e) => e.id));
  const live = (ref: string) => ref === "origin" || isAxisId(ref) || ids.has(ref.split(".")[0]);
  const entities = picks.entities.filter(live);
  const points = picks.points.filter(live);
  const about = picks.about && !live(picks.about) ? undefined : picks.about;
  if (entities.length === picks.entities.length && points.length === picks.points.length && about === picks.about) return picks;
  // A move that lost every entity it was moving goes back to picking them.
  const picking = picks.picking === false && !entities.length && picks.entities.length ? true : picks.picking;
  return { ...picks, entities, points, about, ...(picking !== undefined ? { picking } : {}) };
}

export function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** An edit as a preview: the entities it made or changed (drawn as they would be), and those it deletes. */
export function changedBy(state: SketchState, edit: Edit | string | null): EditPreview {
  if (!edit || typeof edit === "string") return {};
  const before = new Map(state.entities.map((e) => [e.id, JSON.stringify(e)]));
  const after = new Set(edit.entities.map((e) => e.id));
  return {
    add: edit.entities.filter((e) => before.get(e.id) !== JSON.stringify(e)),
    remove: state.entities.filter((e) => !after.has(e.id)),
  };
}

/** A count for a prompt: "1 entity", "3 entities". */
export function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
