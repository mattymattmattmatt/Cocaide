// Explode: a legacy rectangle or slot entity becomes the lines and arcs it
// is drawn with, held in shape by relations (as the Rectangle and Slot tools
// draw them now), so it can be trimmed, filleted, offset and dimensioned
// piece by piece. What was related or dimensioned to it moves onto the
// pieces: its width and height onto its sides, its centre onto a point at
// the middle of a construction diagonal, a slot's centres onto its arcs'.

import type { Constraint, LineEntity, SketchEntity, Vec2 } from "../../doc/types";
import { add2, dist2, scale2, sub2 } from "../vec";
import { freshIds, mapRefs, settle, type Edit, type SketchState } from "./relations";

/** Can it be exploded? */
export function explodable(e: SketchEntity | undefined): boolean {
  return e?.type === "rect" || e?.type === "slot";
}

/** The rectangle or slot `id` as lines and arcs; its relations carried over. The ids made are in `made`, in drawing order. */
export function explode(state: SketchState, id: string): Edit | string {
  const e = state.entities.find((x) => x.id === id);
  if (!e) return `there is no entity "${id}"`;
  if (e.type === "rect") return explodeRect(state, e);
  if (e.type === "slot") return explodeSlot(state, e);
  return `${id} is a ${e.type}: only a rectangle or slot entity explodes (it is already lines and arcs)`;
}

/** Every rectangle and slot among `ids` exploded; the ids with each replaced by its pieces. */
export function explodeAll(state: SketchState, ids: string[]): { state: SketchState; ids: string[] } {
  let s = state;
  const out: string[] = [];
  for (const id of ids) {
    if (!explodable(s.entities.find((e) => e.id === id))) {
      out.push(id);
      continue;
    }
    const r = explode(s, id);
    if (typeof r === "string") {
      out.push(id);
      continue;
    }
    s = r;
    out.push(...(r.made ?? []));
  }
  return { state: s, ids: out };
}

const line = (id: string, start: Vec2, end: Vec2, construction?: boolean): LineEntity => ({ id, type: "line", start, end, ...(construction ? { construction } : {}) });

function explodeRect(state: SketchState, r: Extract<SketchEntity, { type: "rect" }>): Edit {
  const ids = freshIds(state.entities);
  const [x0, x1, y0, y1] = [r.center[0] - r.w / 2, r.center[0] + r.w / 2, r.center[1] - r.h / 2, r.center[1] + r.h / 2];
  const p: Vec2[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const sides = p.map((a, i) => line(ids("l"), a, p[(i + 1) % 4], r.construction));
  const [bottom, right, top, left] = sides;
  const relations: Constraint[] = [
    ...sides.map((l, i): Constraint => ({ type: "coincident", points: [`${l.id}.end`, `${sides[(i + 1) % 4].id}.start`] })),
    { type: "horizontal", entity: bottom.id },
    { type: "vertical", entity: right.id },
    { type: "horizontal", entity: top.id },
    { type: "vertical", entity: left.id },
  ];
  const made: SketchEntity[] = [...sides];
  // Its centre, when something names it: the middle of a construction diagonal, as the centre rectangle draws it.
  const names = (ref: string) => state.constraints.some((k) => JSON.stringify(k).includes(`"${ref}"`));
  let centre: string | null = null;
  if (names(`${r.id}.center`)) {
    const d = line(ids("l"), p[0], p[2], true);
    centre = ids("p");
    made.push(d, { id: centre, type: "point", at: r.center, construction: true });
    relations.push(
      { type: "coincident", points: [`${d.id}.start`, `${bottom.id}.start`] },
      { type: "coincident", points: [`${d.id}.end`, `${top.id}.start`] },
      { type: "midpoint", point: `${centre}.at`, entity: d.id },
    );
  }
  const carried = state.constraints.flatMap((k): Constraint[] => {
    if (k.type === "distanceX" && k.entity === r.id) return [{ type: "distance", entity: bottom.id, value: k.value }];
    if (k.type === "distanceY" && k.entity === r.id) return [{ type: "distance", entity: left.id, value: k.value }];
    if (k.type === "fix" && k.entity === r.id) return sides.map((l) => ({ type: "fix", entity: l.id }));
    const m = mapRefs(k, (ref) => (ref === `${r.id}.center` ? (centre ? `${centre}.at` : null) : ref), (id) => (id === r.id ? null : id));
    return m ? [m] : [];
  });
  return finish(state, r.id, made, [...carried, ...relations]);
}

function explodeSlot(state: SketchState, s: Extract<SketchEntity, { type: "slot" }>): Edit | string {
  const length = dist2(s.center1, s.center2);
  if (length < 1e-9) return `slot ${s.id} has both centres in one place: delete it and draw a circle`;
  const ids = freshIds(state.entities);
  const u = scale2(sub2(s.center2, s.center1), 1 / length);
  const n: Vec2 = [-u[1], u[0]];
  const r = s.width / 2;
  const at = (c: Vec2, k: number): Vec2 => add2(c, scale2(n, k * r));
  // As the Slot tool draws it: a side, the far arc, the other side, the near arc, and the centreline.
  const la = line(ids("l"), at(s.center1, -1), at(s.center2, -1), s.construction);
  const a1 = ids("a");
  const lb = line(ids("l"), at(s.center2, 1), at(s.center1, 1), s.construction);
  const a2 = ids("a");
  const cl = line(ids("l"), s.center1, s.center2, true);
  const cons = s.construction ? { construction: true } : {};
  const made: SketchEntity[] = [
    la,
    { id: a1, type: "arc", center: s.center2, start: la.end, end: lb.start, ...cons },
    lb,
    { id: a2, type: "arc", center: s.center1, start: lb.end, end: la.start, ...cons },
    cl,
  ];
  const relations: Constraint[] = [
    { type: "coincident", points: [`${la.id}.end`, `${a1}.start`] },
    { type: "coincident", points: [`${a1}.end`, `${lb.id}.start`] },
    { type: "coincident", points: [`${lb.id}.end`, `${a2}.start`] },
    { type: "coincident", points: [`${a2}.end`, `${la.id}.start`] },
    { type: "coincident", points: [`${a1}.center`, `${cl.id}.end`] },
    { type: "coincident", points: [`${a2}.center`, `${cl.id}.start`] },
    { type: "tangent", entities: [la.id, a1] },
    { type: "tangent", entities: [la.id, a2] },
    { type: "tangent", entities: [lb.id, a1] },
    { type: "tangent", entities: [lb.id, a2] },
    { type: "equal", entities: [a1, a2] },
  ];
  const carried = state.constraints.flatMap((k): Constraint[] => {
    if (k.type === "fix" && k.entity === s.id) return [la, lb, cl].map((l) => ({ type: "fix", entity: l.id }));
    const m = mapRefs(
      k,
      (ref) => (ref === `${s.id}.center1` ? `${a2}.center` : ref === `${s.id}.center2` ? `${a1}.center` : ref),
      // Its length (centre to centre) and a point at its middle go to the centreline.
      (id) => (id === s.id ? cl.id : id),
    );
    return m ? [m] : [];
  });
  return finish(state, s.id, made, [...carried, ...relations]);
}

function finish(state: SketchState, id: string, made: SketchEntity[], constraints: Constraint[]): Edit {
  // The pieces go where the entity was in the list, so the sketch reads in the same order.
  const at = state.entities.findIndex((e) => e.id === id);
  const entities = [...state.entities.slice(0, at), ...made, ...state.entities.slice(at + 1)];
  return { entities, constraints: settle(entities, constraints, made.map((e) => e.id)), made: made.map((e) => e.id) };
}
