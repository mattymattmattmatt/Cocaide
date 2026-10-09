// How the sketcher names what it shows: an entity by its id ("c1"), a point
// by its entity and name ("c1 centre", "l2 end"), the sketch axes ("X axis"),
// and references to the model by what they are ("model edge (straight,
// 40 mm, +Y)", "model edge (circle Ø6.6)", "axis Z"). Pure.

import type { DatumRef, SketchEntity, Vec2 } from "../../doc/types";
import { dist2 } from "../../geom/vec";
import { isModelId, modelEdge, type ModelView } from "./model";

export interface Namer {
  /** An entity, a model edge's stand-in, or a sketch axis. */
  entity(id: string): string;
  /** A point ref. */
  point(ref: string): string;
}

const POINT_WORD: Record<string, string> = { start: "start", end: "end", center: "centre", center1: "first centre", center2: "second centre", at: "" };

/** Names for this sketch's entities and the model edges in view. */
export function namer(entities: SketchEntity[], model?: ModelView): Namer {
  const byId = new Map(entities.map((e) => [e.id, e]));
  // Two references that read the same (a converted rectangle's opposite sides) are told apart by their ids.
  const said = new Map<string, number>();
  for (const e of entities) if (e.ref) said.set(referenceName(e), (said.get(referenceName(e)) ?? 0) + 1);
  const refName = (e: SketchEntity) => {
    const words = referenceName(e);
    return (said.get(words) ?? 0) > 1 ? words.replace(/^(model edge|model point)/, `$1 ${e.id}`).replace(/^(?!model)/, `${e.id} `) : words;
  };
  const entity = (id: string): string => {
    if (id === "X" || id === "Y") return `${id} axis`;
    if (isModelId(id)) {
      const e = model && modelEdge(model, id)?.entity;
      return e ? `model edge (${shapeWords(e)})` : "model edge";
    }
    const e = byId.get(id);
    return e?.ref ? refName(e) : id;
  };
  return {
    entity,
    point(ref) {
      if (ref === "origin") return "origin";
      const [owner, name] = ref.split(".");
      const word = POINT_WORD[name] ?? name;
      return word ? `${entity(owner)} ${word}` : entity(owner);
    },
  };
}

/** What a reference entity references, as the sketcher says it: "model edge (straight, 40 mm, +Y)", "axis Z", "Origin". */
export function referenceName(e: SketchEntity): string {
  const ref = e.ref as DatumRef;
  if ("datum" in ref) return /^[XYZ]$/.test(ref.datum) ? `axis ${ref.datum}` : ref.datum === "Origin" ? "Origin" : ref.datum;
  if ("point" in ref) return `point [${ref.point.map((x) => Math.round(x * 1000) / 1000).join(", ")}]`;
  if ("face" in ref) return "model face";
  if (e.type === "point") return ref.at ? `${ref.at === "mid" ? "middle" : ref.at === "center" ? "centre" : ref.at} of a model edge` : "centre of a model edge";
  return `model edge (${shapeWords(e)})`;
}

/** "straight, 40 mm, +Y", "circle Ø6.6", "arc R5". */
export function shapeWords(e: SketchEntity): string {
  switch (e.type) {
    case "line":
      return `straight, ${num(dist2(e.start, e.end))} mm, ${directionWord([e.end[0] - e.start[0], e.end[1] - e.start[1]])}`;
    case "circle":
      return `circle Ø${num(2 * e.radius)}`;
    case "arc":
      return `arc R${num(dist2(e.start, e.center))}`;
    case "point":
      return "point";
    default:
      return e.type;
  }
}

/** A sketch direction, either way along: "+X", "+Y", or "at 30°" from X. */
export function directionWord(d: Vec2): string {
  const l = Math.hypot(d[0], d[1]) || 1;
  const [x, y] = [d[0] / l, d[1] / l];
  if (Math.abs(y) < 1e-9) return "+X";
  if (Math.abs(x) < 1e-9) return "+Y";
  let a = (Math.atan2(y, x) * 180) / Math.PI;
  if (a < 0) a += 180;
  return `at ${num(a)}°`;
}

function num(x: number): string {
  return String(Math.round(x * 1000) / 1000);
}
