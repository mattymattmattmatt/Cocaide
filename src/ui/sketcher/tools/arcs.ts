// Arc ▾: Centrepoint arc, Tangent arc and 3-point arc, as SOLIDWORKS has
// them. An arc bends the way the pointer went: a centrepoint arc runs
// anticlockwise or clockwise as the pointer swept round its centre, and a
// tangent arc leaves its line or arc forwards, or backwards when the pointer
// first heads back.

import type { ArcEntity, SketchEntity, Vec2 } from "../../../doc/types";
import { angleOf, dist2, dot2, len2, polar, scale2, sub2, wrapAngle } from "../../../geom/vec";
import { along, circumcircle, EPS, lead, line, perp, turning, unit } from "./shapes";
import type { Click, FlyoutDef, SketchToolDef, ToolContext } from "./types";

const ARC: FlyoutDef = { id: "arc", label: "Arc" };

function arc(id: string, center: Vec2, start: Vec2, end: Vec2, clockwise: boolean): ArcEntity {
  return { id, type: "arc", center, start, end, ...(clockwise ? { clockwise: true } : {}) };
}

/**
 * The end of a line or arc a tangent arc can start from, and the way out of
 * it along the curve: a line's end onward, its start back; an arc's end the
 * way it was turning, its start the other way. Null when the click is on no end.
 */
export function tangentStart(click: Click, entities: SketchEntity[]): { entity: string; p: Vec2; out: Vec2 } | null {
  const m = click.ref?.match(/^(.+)\.(start|end)$/);
  if (!m) return null;
  const e = entities.find((x) => x.id === m[1]);
  const atEnd = m[2] === "end";
  if (e?.type === "line") {
    const d = sub2(e.end, e.start);
    if (len2(d) < EPS) return null;
    return { entity: e.id, p: atEnd ? e.end : e.start, out: unit(atEnd ? d : scale2(d, -1)) };
  }
  if (e?.type === "arc") {
    const p = atEnd ? e.end : e.start;
    const radial = unit(sub2(p, e.center));
    // Turning anticlockwise, an arc runs a quarter turn on from its radius; it leaves its start going backwards.
    const turn = e.clockwise ? scale2(perp(radial), -1) : perp(radial);
    return { entity: e.id, p, out: atEnd ? turn : scale2(turn, -1) };
  }
  return null;
}

/** The tangent arc from where it starts to e: forwards along `out`, or backwards when the pointer first went back. */
function tangentArc(id: string, from: { p: Vec2; out: Vec2 }, e: Vec2, ctx: ToolContext): ArcEntity | null {
  const { p } = from;
  const pe = sub2(e, p);
  if (len2(pe) < EPS) return null;
  const first = lead(p, ctx.trail, 6 * (ctx.px ?? 0)) ?? e;
  const d = dot2(sub2(first, p), from.out) >= 0 ? from.out : scale2(from.out, -1);
  const n = perp(d);
  const k = dot2(pe, n);
  if (Math.abs(k) < 1e-6 * len2(pe)) return null; // straight on or straight back: a line, not an arc
  // The centre is on the normal at p, as far from e as from p.
  const rho = dot2(pe, pe) / (2 * k);
  return arc(id, along(p, n, rho), p, e, rho < 0);
}

export const tools: SketchToolDef[] = [
  {
    id: "sketch.arc",
    name: "arc",
    label: "Centrepoint arc",
    icon: "arc",
    title: "Centrepoint arc: click the centre, where it starts, then where it ends; it turns the way you sweep",
    flyout: ARC,
    clicks: 3,
    prompts: ["Click the centre", "Click where the arc starts", "Sweep round and click where it ends"],
    preview: (clicks, options, ids, ctx) => {
      if (clicks.length === 2) return dist2(clicks[0].p, clicks[1].p) < EPS ? [] : [line(ids("l"), clicks[0].p, clicks[1].p, true)];
      return tools[0].build(clicks, options, ids, ctx)?.entities ?? [];
    },
    build: (clicks, _options, ids, ctx) => {
      const [c, s, q] = clicks.map((k) => k.p);
      const r = dist2(c, s);
      if (r < EPS) return null;
      // The end lands on the circle through the start, in the direction clicked.
      const end = polar(c, r, angleOf(sub2(q, c)));
      if (dist2(end, s) < EPS) return null;
      const id = ids("a");
      const clockwise = turning(c, s, [...(ctx.trail ?? []), q]) < 0;
      return {
        entities: [arc(id, c, s, end, clockwise)],
        relations: [],
        roles: [{ point: `${id}.center` }, { point: `${id}.start` }, dist2(end, q) < EPS ? { point: `${id}.end` } : null],
      };
    },
  },
  {
    id: "sketch.tangentArc",
    name: "tangent-arc",
    label: "Tangent arc",
    icon: "tangentArc",
    title: "Tangent arc: click the end of a line or arc, then where the arc ends; it carries on smoothly (head back first to turn the other way). While drawing lines, A switches to it and back",
    flyout: ARC,
    clicks: 2,
    chain: true,
    prompts: ["Click the end of a line or arc", "Click where the arc ends; keep clicking to chain arcs, Esc to stop"],
    accept: (click, index, ctx) => (index === 0 && !tangentStart(click, ctx.entities) ? "A tangent arc starts at the end of a line or arc: click one's end" : null),
    preview: (clicks, _options, ids, ctx) => {
      const from = tangentStart(clicks[0], ctx.entities);
      const a = from && clicks[1] ? tangentArc(ids("a"), from, clicks[1].p, ctx) : null;
      return a ? [a] : [];
    },
    build: (clicks, _options, ids, ctx) => {
      const from = tangentStart(clicks[0], ctx.entities);
      if (!from) return null;
      const id = ids("a");
      const a = tangentArc(id, from, clicks[1].p, ctx);
      if (!a) return null;
      return {
        entities: [a],
        relations: [{ type: "tangent", entities: [id, from.entity] }],
        roles: [{ point: `${id}.start` }, { point: `${id}.end` }],
        next: { p: a.end, ref: `${id}.end` },
      };
    },
  },
  {
    id: "sketch.arc3",
    name: "arc3",
    label: "3-point arc",
    icon: "arc3",
    title: "3-point arc: click where it starts, where it ends, then a point it passes through",
    flyout: ARC,
    clicks: 3,
    prompts: ["Click where the arc starts", "Click where it ends", "Click a point it passes through"],
    preview: (clicks, options, ids, ctx) => {
      if (clicks.length === 2) return dist2(clicks[0].p, clicks[1].p) < EPS ? [] : [line(ids("l"), clicks[0].p, clicks[1].p, true)];
      return tools[2].build(clicks, options, ids, ctx)?.entities ?? [];
    },
    build: (clicks, _options, ids) => {
      const [s, e, m] = clicks.map((k) => k.p);
      if (dist2(s, e) < EPS) return null;
      const circle = circumcircle(s, e, m);
      if (!circle) return null;
      const c = circle.center;
      const at = (p: Vec2) => angleOf(sub2(p, c));
      // Anticlockwise from start to end if the third point is on that way round.
      const clockwise = wrapAngle(at(m) - at(s)) > wrapAngle(at(e) - at(s));
      const id = ids("a");
      return {
        entities: [arc(id, c, s, e, clockwise)],
        relations: [],
        roles: [{ point: `${id}.start` }, { point: `${id}.end` }, { on: id }],
      };
    },
  },
];
