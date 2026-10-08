// What the sketch shows over its geometry, as SOLIDWORKS does: each
// dimension drawn as a dimension (extension lines, arrows, the value), and
// each relation as a small glyph beside what it holds. Pure geometry in
// sketch millimetres, y up; the canvas draws it.

import type { Constraint, ConstraintType, SketchEntity, Vec2 } from "../../doc/types";
import { point as pointOf } from "../../geom/constraints";
import { angleOf, dist2, sub2 } from "../../geom/vec";
import type { IconName } from "../icons";

/** Each constraint type's name and icon, as on SOLIDWORKS's relation and dimension lists. */
export const RELATION: Record<ConstraintType, { label: string; icon: IconName }> = {
  coincident: { label: "Coincident", icon: "coincident" },
  horizontal: { label: "Horizontal", icon: "horizontal" },
  vertical: { label: "Vertical", icon: "vertical" },
  distance: { label: "Distance", icon: "smartDimension" },
  distanceX: { label: "Horizontal distance", icon: "smartDimension" },
  distanceY: { label: "Vertical distance", icon: "smartDimension" },
  radius: { label: "Radius", icon: "radius" },
  diameter: { label: "Diameter", icon: "diameter" },
  angle: { label: "Angle", icon: "angle" },
  equal: { label: "Equal", icon: "equal" },
  parallel: { label: "Parallel", icon: "parallel" },
  perpendicular: { label: "Perpendicular", icon: "perpendicular" },
  collinear: { label: "Collinear", icon: "collinear" },
  tangent: { label: "Tangent", icon: "tangent" },
  concentric: { label: "Concentric", icon: "concentric" },
  midpoint: { label: "Midpoint", icon: "midpoint" },
  pointOn: { label: "Coincident", icon: "pointOn" },
  symmetric: { label: "Symmetric", icon: "symmetric" },
  fix: { label: "Fix", icon: "fix" },
};

/** A dimension's text: R and Ø for radii and diameters, ° for angles, at most three decimals. */
export function dimensionText(k: Constraint): string {
  if (!("value" in k)) return "";
  const v = String(Math.round(k.value * 1000) / 1000);
  return k.type === "radius" ? `R${v}` : k.type === "diameter" ? `Ø${v}` : k.type === "angle" ? `${v}°` : v;
}

export interface DimensionShape {
  index: number;
  /** Extension and dimension lines. */
  lines: [Vec2, Vec2][];
  /** Arrowheads: the tip and the way it points. */
  arrows: { at: Vec2; dir: Vec2 }[];
  /** The angle dimension's arc. */
  arc?: { center: Vec2; r: number; from: number; sweep: number };
  text: string;
  at: Vec2;
}

/**
 * Where each dimension is drawn. `px` is millimetres per screen pixel, so
 * the offsets stay the same on screen at any zoom. Dimensions stand off on
 * the side away from the middle of the sketch.
 */
export function dimensionShapes(entities: SketchEntity[], constraints: Constraint[], px: number): DimensionShape[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const pts = entities.flatMap((e) => Object.values(e).filter((v): v is Vec2 => Array.isArray(v)));
  const middle: Vec2 = pts.length ? [avg(pts.map((p) => p[0])), avg(pts.map((p) => p[1]))] : [0, 0];
  const gap = 22 * px;
  const out: DimensionShape[] = [];
  const at = (ref: string): Vec2 | null => {
    try {
      const p = pointOf(ref, byId);
      return Array.isArray(p) ? p : null;
    } catch {
      return null;
    }
  };

  /** An aligned dimension between p and q, standing off along n (or away from the middle). */
  const aligned = (index: number, text: string, p: Vec2, q: Vec2, side?: Vec2) => {
    const d = sub2(q, p);
    const len = Math.hypot(d[0], d[1]);
    if (len < 1e-9) return;
    let n: Vec2 = [-d[1] / len, d[0] / len];
    const mid: Vec2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const away = side ?? sub2(mid, middle);
    if (n[0] * away[0] + n[1] * away[1] < 0) n = [-n[0], -n[1]];
    const p1: Vec2 = [p[0] + n[0] * gap, p[1] + n[1] * gap];
    const q1: Vec2 = [q[0] + n[0] * gap, q[1] + n[1] * gap];
    const over = 4 * px;
    const u: Vec2 = [d[0] / len, d[1] / len];
    // Extension lines stand a little off the points they measure, as on a drawing.
    const off = 3 * px;
    out.push({
      index,
      text,
      lines: [
        [[p[0] + n[0] * off, p[1] + n[1] * off], [p1[0] + n[0] * over, p1[1] + n[1] * over]],
        [[q[0] + n[0] * off, q[1] + n[1] * off], [q1[0] + n[0] * over, q1[1] + n[1] * over]],
        [p1, q1],
      ],
      arrows: [
        { at: p1, dir: [-u[0], -u[1]] },
        { at: q1, dir: u },
      ],
      at: [(p1[0] + q1[0]) / 2 + n[0] * 8 * px, (p1[1] + q1[1]) / 2 + n[1] * 8 * px],
    });
  };

  /** A horizontal (x) or vertical (y) dimension between p and q. */
  const straight = (index: number, text: string, p: Vec2, q: Vec2, axis: 0 | 1, beyond?: number) => {
    if (Math.abs(q[axis] - p[axis]) < 1e-9) return;
    const o = axis === 0 ? 1 : 0; // the other coordinate: where the dimension line stands
    const mid = (p[o] + q[o]) / 2;
    const up = (beyond ?? mid) >= middle[o] ? 1 : -1;
    const line = (up > 0 ? Math.max(p[o], q[o], beyond ?? -Infinity) : Math.min(p[o], q[o], beyond ?? Infinity)) + up * gap;
    const put = (v: number, w: number): Vec2 => (axis === 0 ? [v, w] : [w, v]);
    const p1 = put(p[axis], line);
    const q1 = put(q[axis], line);
    const s = Math.sign(q[axis] - p[axis]);
    const ext = up * 4 * px;
    const off = (from: number) => from + (line > from ? 3 : -3) * px;
    out.push({
      index,
      text,
      lines: [
        [put(p[axis], off(p[o])), put(p[axis], line + ext)],
        [put(q[axis], off(q[o])), put(q[axis], line + ext)],
        [p1, q1],
      ],
      arrows: [
        { at: p1, dir: put(-s, 0) },
        { at: q1, dir: put(s, 0) },
      ],
      at: put((p[axis] + q[axis]) / 2, line + up * 8 * px),
    });
  };

  constraints.forEach((k, index) => {
    if (!("value" in k)) return;
    const text = dimensionText(k);
    switch (k.type) {
      case "distance":
      case "distanceX":
      case "distanceY": {
        const e = k.entity ? byId.get(k.entity) : undefined;
        if (e?.type === "rect") {
          const [cx, cy] = e.center;
          if (k.type === "distanceX") straight(index, text, [cx - e.w / 2, cy + e.h / 2], [cx + e.w / 2, cy + e.h / 2], 0, cy + e.h / 2);
          else straight(index, text, [cx + e.w / 2, cy - e.h / 2], [cx + e.w / 2, cy + e.h / 2], 1, cx + e.w / 2);
          return;
        }
        let p: Vec2 | null = null;
        let q: Vec2 | null = null;
        if (e?.type === "line") [p, q] = [e.start, e.end];
        else if (e?.type === "slot") [p, q] = [e.center1, e.center2];
        else if (k.points) [p, q] = [at(k.points[0]), at(k.points[1])];
        else if (k.point && k.line) {
          const l = byId.get(k.line);
          p = at(k.point);
          if (l?.type === "line" && p) q = foot(l.start, l.end, p);
        }
        if (!p || !q) return;
        if (k.type === "distance") aligned(index, text, p, q);
        else straight(index, text, p, q, k.type === "distanceX" ? 0 : 1);
        return;
      }
      case "radius":
      case "diameter": {
        const e = byId.get(k.entity);
        if (!e || (e.type !== "circle" && e.type !== "arc")) return;
        const r = e.type === "circle" ? e.radius : dist2(e.start, e.center);
        // A circle's leader at 45°; an arc's through the middle of the arc.
        let a = Math.PI / 4;
        if (e.type === "arc") {
          const a0 = angleOf(sub2(e.start, e.center));
          const a1 = angleOf(sub2(e.end, e.center));
          let sweep = e.clockwise ? a0 - a1 : a1 - a0;
          while (sweep <= 0) sweep += 2 * Math.PI;
          a = e.clockwise ? a0 - sweep / 2 : a0 + sweep / 2;
        }
        const u: Vec2 = [Math.cos(a), Math.sin(a)];
        const c = e.center;
        const rim: Vec2 = [c[0] + u[0] * r, c[1] + u[1] * r];
        const out1: Vec2 = [c[0] + u[0] * (r + gap), c[1] + u[1] * (r + gap)];
        const from: Vec2 = k.type === "diameter" ? [c[0] - u[0] * r, c[1] - u[1] * r] : c;
        out.push({
          index,
          text,
          lines: [[from, out1]],
          arrows: [{ at: rim, dir: u }, ...(k.type === "diameter" ? [{ at: from, dir: [-u[0], -u[1]] as Vec2 }] : [])],
          at: [out1[0] + u[0] * 10 * px, out1[1] + u[1] * 10 * px],
        });
        return;
      }
      case "angle": {
        const [a, b] = k.entities.map((id) => byId.get(id));
        if (a?.type !== "line" || b?.type !== "line") return;
        const x = meet(a.start, a.end, b.start, b.end) ?? a.start;
        const ua = angleOf(sub2(a.end, a.start));
        const ub = angleOf(sub2(b.end, b.start));
        let sweep = ub - ua;
        while (sweep > Math.PI) sweep -= 2 * Math.PI;
        while (sweep <= -Math.PI) sweep += 2 * Math.PI;
        const r = Math.max(36 * px, Math.min(dist2(a.start, a.end), dist2(b.start, b.end)) * 0.4);
        const mid = ua + sweep / 2;
        const end = (t: number): Vec2 => [x[0] + r * Math.cos(t), x[1] + r * Math.sin(t)];
        const s = Math.sign(sweep) || 1;
        out.push({
          index,
          text,
          lines: [],
          arc: { center: x, r, from: ua, sweep },
          arrows: [
            { at: end(ua), dir: [Math.sin(ua) * s, -Math.cos(ua) * s] },
            { at: end(ub), dir: [-Math.sin(ub) * s, Math.cos(ub) * s] },
          ],
          at: [x[0] + (r + 12 * px) * Math.cos(mid), x[1] + (r + 12 * px) * Math.sin(mid)],
        });
        return;
      }
    }
  });
  return out;
}

export interface Glyph {
  /** The constraint it shows. */
  index: number;
  icon: IconName;
  /** Where it is drawn, in sketch mm: beside the entity or point, stacked when several share a place. */
  at: Vec2;
}

/**
 * A glyph for each relation, beside each entity or point it holds (a pair
 * relation shows on both), as SOLIDWORKS shows them. Dimensions draw as
 * dimensions instead. Glyphs that share a place line up side by side.
 */
export function relationGlyphs(entities: SketchEntity[], constraints: Constraint[], px: number): Glyph[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const stacks = new Map<string, number>();
  const out: Glyph[] = [];
  const place = (key: string, base: Vec2, index: number, icon: IconName) => {
    const n = stacks.get(key) ?? 0;
    stacks.set(key, n + 1);
    out.push({ index, icon, at: [base[0] + (10 + n * 17) * px, base[1] - 12 * px] });
  };
  const onEntity = (id: string, index: number, icon: IconName) => {
    const e = byId.get(id);
    if (e) place(`e:${id}`, anchorOf(e), index, icon);
  };
  const onPoint = (ref: string, index: number, icon: IconName) => {
    if (ref === "origin") return place("p:origin", [0, 0], index, icon);
    try {
      const p = pointOf(ref, byId);
      if (Array.isArray(p)) place(`p:${p[0].toFixed(6)},${p[1].toFixed(6)}`, p, index, icon);
    } catch {
      // a point of a deleted entity: nothing to show
    }
  };
  constraints.forEach((k, index) => {
    if ("value" in k) return;
    const icon = RELATION[k.type].icon;
    switch (k.type) {
      case "coincident":
        return onPoint(k.points[0] === "origin" ? k.points[1] : k.points[0], index, icon);
      case "horizontal":
      case "vertical":
        if (k.entity) return onEntity(k.entity, index, icon);
        return k.points!.forEach((r) => onPoint(r, index, icon));
      case "equal":
      case "parallel":
      case "perpendicular":
      case "collinear":
      case "tangent":
      case "concentric":
        return k.entities.forEach((id) => onEntity(id, index, icon));
      case "midpoint":
      case "pointOn":
        return onPoint(k.point, index, icon);
      case "symmetric":
        return k.points.forEach((r) => onPoint(r, index, icon));
      case "fix":
        return k.entity ? onEntity(k.entity, index, icon) : onPoint(k.point!, index, icon);
    }
  });
  return out;
}

/** Where an entity's glyphs sit: a line's middle, a circle's rim, an arc's middle, a slot's or rectangle's top. */
function anchorOf(e: SketchEntity): Vec2 {
  switch (e.type) {
    case "line":
      return [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2];
    case "circle":
      return [e.center[0] + e.radius * Math.SQRT1_2, e.center[1] - e.radius * Math.SQRT1_2];
    case "arc": {
      const r = dist2(e.start, e.center);
      const a0 = angleOf(sub2(e.start, e.center));
      const a1 = angleOf(sub2(e.end, e.center));
      let sweep = e.clockwise ? a0 - a1 : a1 - a0;
      while (sweep <= 0) sweep += 2 * Math.PI;
      const a = e.clockwise ? a0 - sweep / 2 : a0 + sweep / 2;
      return [e.center[0] + r * Math.cos(a), e.center[1] + r * Math.sin(a)];
    }
    case "rect":
      return [e.center[0], e.center[1] + e.h / 2];
    case "slot":
      return [(e.center1[0] + e.center2[0]) / 2, (e.center1[1] + e.center2[1]) / 2 + e.width / 2];
  }
}

/** The foot of the perpendicular from p to the line through a and b. */
function foot(a: Vec2, b: Vec2, p: Vec2): Vec2 {
  const d = sub2(b, a);
  const l2 = d[0] * d[0] + d[1] * d[1] || 1;
  const t = ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2;
  return [a[0] + t * d[0], a[1] + t * d[1]];
}

/** Where the lines through a-b and c-d cross, or null when they are parallel. */
function meet(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = sub2(b, a);
  const s = sub2(d, c);
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  return [a[0] + t * r[0], a[1] + t * r[1]];
}

function avg(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}
