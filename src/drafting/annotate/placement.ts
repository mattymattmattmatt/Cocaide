// Where annotations go (Phase Q): what is already on the sheet (views, text,
// symbols, leaders, dimension and extension lines), and a search for a free
// place for each new callout, frame, symbol and balloon: outside its view if
// it can be, near what it points at, its text over nothing else, its leader
// crossing no other leader or dimension line, on the sheet and clear of the
// title block, the tables and the view labels.

import type { Vec2 } from "../../doc/types";
import { grow, inside, overlaps, type Box, type Prim } from "../sheet";
import { textWidth } from "../text";
import { dist, sub, unit } from "./common";

export type OccupantKind = "view" | "text" | "symbol" | "table" | "label" | "title" | "balloon";

interface Occupant {
  box: Box;
  kind: OccupantKind;
  owner: string;
}

interface Segment {
  a: Vec2;
  b: Vec2;
  kind: "leader" | "dimension" | "extension" | "geometry";
  owner: string;
}

/** What is on the sheet, for placing the next annotation. */
export class Occupancy {
  readonly boxes: Occupant[] = [];
  readonly segs: Segment[] = [];

  constructor(readonly frame: Box) {}

  addBox(box: Box | null | undefined, kind: OccupantKind, owner: string): void {
    if (box) this.boxes.push({ box, kind, owner });
  }

  addSeg(a: Vec2, b: Vec2, kind: Segment["kind"], owner: string): void {
    if (dist(a, b) > 1e-6) this.segs.push({ a, b, kind, owner });
  }

  /** An annotation's primitives: its text as boxes, its lines as leaders (or dimension lines). */
  addPrims(prims: Prim[], owner: string, lines: Segment["kind"] = "leader"): void {
    for (const p of prims) {
      if (p.k === "text") {
        const w = textWidth(p.text, p.size, p.bold);
        const x0 = p.anchor === "start" ? 0 : p.anchor === "middle" ? -w / 2 : -w;
        const a = ((p.angle ?? 0) * Math.PI) / 180;
        const c = Math.cos(a);
        const s = Math.sin(a);
        const pts: Vec2[] = [
          [x0, -0.22 * p.size],
          [x0 + w, -0.22 * p.size],
          [x0, 0.75 * p.size],
          [x0 + w, 0.75 * p.size],
        ].map(([x, y]) => [p.at[0] + x * c - y * s, p.at[1] + x * s + y * c] as Vec2);
        const xs = pts.map((q) => q[0]);
        const ys = pts.map((q) => q[1]);
        this.addBox({ min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] }, "text", owner);
      } else if (p.k === "line" && !p.fill) {
        for (let i = 1; i < p.pts.length; i++) this.addSeg(p.pts[i - 1], p.pts[i], lines, owner);
      } else if (p.k === "line" && p.fill && p.pts.length) {
        // A filled shape bigger than an arrowhead (a datum's triangle): a symbol other leaders keep off.
        const xs = p.pts.map((q) => q[0]);
        const ys = p.pts.map((q) => q[1]);
        const b: Box = { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
        if (Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) > 4) this.addBox(b, "symbol", owner);
      } else if (p.k === "circle" && p.r > 1.2) this.addBox({ min: [p.c[0] - p.r, p.c[1] - p.r], max: [p.c[0] + p.r, p.c[1] + p.r] }, "symbol", owner);
    }
  }

  /** How much of `box` other things cover (mm²), and how many of them; views count only when `views` is set. */
  overlap(box: Box, opts: { ignore?: string[]; views?: boolean; kinds?: OccupantKind[] } = {}): number {
    let area = 0;
    for (const o of this.boxes) {
      if (opts.ignore?.includes(o.owner)) continue;
      if (o.kind === "view" && !opts.views) continue;
      if (opts.kinds && !opts.kinds.includes(o.kind)) continue;
      if (!overlaps(box, o.box)) continue;
      const w = Math.min(box.max[0], o.box.max[0]) - Math.max(box.min[0], o.box.min[0]);
      const h = Math.min(box.max[1], o.box.max[1]) - Math.max(box.min[1], o.box.min[1]);
      area += Math.max(0, w) * Math.max(0, h) + 1;
    }
    return area;
  }

  /** Lines (leaders, dimension and extension lines) a box covers. */
  linesThrough(box: Box, ignore: string[] = []): number {
    let n = 0;
    for (const s of this.segs) {
      if (s.kind === "geometry" || ignore.includes(s.owner)) continue;
      if (segmentHitsBox(s.a, s.b, box)) n++;
    }
    return n;
  }

  /** How many of the views' own lines (their visible and hidden edges, when added as "geometry") a box covers. */
  geometryThrough(box: Box): number {
    let n = 0;
    for (const s of this.segs) if (s.kind === "geometry" && segmentHitsBox(s.a, s.b, box)) n++;
    return n;
  }

  /** True when the views' lines were added (a callout may then sit over a view's empty middle, at a price). */
  get hasGeometry(): boolean {
    return this.segs.some((s) => s.kind === "geometry");
  }

  /** How many leaders, dimension and extension lines the segment a–b crosses. */
  crossings(a: Vec2, b: Vec2, ignore: string[] = [], kinds: Segment["kind"][] = ["leader", "dimension", "extension"]): number {
    let n = 0;
    for (const s of this.segs) {
      if (ignore.includes(s.owner) || !kinds.includes(s.kind)) continue;
      if (segmentsCross(a, b, s.a, s.b)) n++;
    }
    return n;
  }

  /** How many text boxes and symbols the segment a–b runs through. */
  textCrossed(a: Vec2, b: Vec2, ignore: string[] = []): number {
    let n = 0;
    for (const o of this.boxes) {
      if (ignore.includes(o.owner) || o.kind === "view") continue;
      if (segmentHitsBox(a, b, grow(o.box, -0.3))) n++;
    }
    return n;
  }

  inFrame(box: Box): boolean {
    return inside(box, this.frame);
  }
}

/** True when the open segments a–b and c–d cross (touching at an end doesn't count). */
export function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  const eps = 1e-9;
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

/** True when the segment a–b passes through the box. */
export function segmentHitsBox(a: Vec2, b: Vec2, box: Box): boolean {
  if (box.max[0] < box.min[0] || box.max[1] < box.min[1]) return false;
  // Liang–Barsky clip.
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - box.min[0], box.max[0] - a[0], a[1] - box.min[1], box.max[1] - a[1]];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-12) {
      if (q[i] < 0) return false;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return t1 - t0 > 1e-9;
}

/** A candidate place for a callout: its leader's knee and which way its text runs from there. */
export interface Spot {
  knee: Vec2;
  /** The text runs right (+1) or left (−1) from the knee. */
  dir: 1 | -1;
  cost: number;
}

export interface SpotQuery {
  /** What the leader points at. */
  tip: Vec2;
  /** The view it is in: its box (geometry) is kept clear of text. */
  viewBox: Box | null;
  /** The text's box relative to the knee, for text running right (mirrored for left). */
  shape: (knee: Vec2, dir: 1 | -1) => Box;
  owner: string;
  /** Prefer the text up and to the right of the tip (the usual hole callout). */
  prefer?: Vec2;
  /** How far out of the view to try, mm. */
  rings?: number[];
  /** Leave the leader square to the sheet (a balloon's may be any way). */
  slanted?: boolean;
  /** Allowed over the view (a callout inside a big view's empty middle): default false. */
  overView?: boolean;
  ignore?: string[];
}

/**
 * The best place for a leadered callout: candidates on rings round its view
 * (and round the tip), each scored by its leader's length, text over other
 * text or symbols (heavily), text over the view's geometry, leaders and
 * dimension lines it crosses, leaders square to the sheet (they read as
 * extension lines), and text below the view (where its label and dimensions
 * are). Null when nothing fits on the sheet.
 */
export function findSpot(occ: Occupancy, q: SpotQuery): Spot | null {
  const rings = q.rings ?? [7, 12, 18, 26, 36];
  const cands: Vec2[] = [];
  const vb = q.viewBox;
  for (const r of rings) {
    for (let k = 0; k < 48; k++) {
      const t = (k / 48) * 2 * Math.PI;
      const d: Vec2 = [Math.cos(t), Math.sin(t)];
      // Out of the view's box (grown by the ring) along d from the tip; when there is no view, round the tip.
      cands.push(vb ? exitPoint(q.tip, d, grow(vb, r)) : [q.tip[0] + d[0] * r * 1.5, q.tip[1] + d[1] * r * 1.5]);
    }
  }
  let best: Spot | null = null;
  const ignore = [q.owner, ...(q.ignore ?? [])];
  for (const knee of cands) {
    for (const dir of [1, -1] as const) {
      const box = q.shape(knee, dir);
      if (!occ.inFrame(box)) continue;
      // Text over text or symbols is not allowed; over tables, titles, labels neither.
      const blocked = occ.overlap(grow(box, 0.8), { ignore, kinds: ["text", "symbol", "table", "label", "title", "balloon"] });
      if (blocked > 0) continue;
      let cost = dist(knee, q.tip);
      const overViews = occ.overlap(box, { ignore, views: true, kinds: ["view"] });
      // Over a view: dear, and dearer for each of its lines the text would cover (Q4 polish: when the views' lines are
      // known, text in a view's empty middle with a short leader beats text inside a dimension stack).
      if (overViews > 0) cost += q.overView ? overViews * 0.05 : occ.hasGeometry ? 70 + occ.geometryThrough(grow(box, 0.8)) * 60 : 200 + overViews;
      // Inside a dimension stack: each dimension or extension line through the text is another thing to read past.
      cost += occ.linesThrough(box, ignore) * 15;
      cost += occ.linesThrough(box, ignore) * 25;
      const crossings = occ.crossings(knee, q.tip, ignore);
      cost += crossings * 30;
      cost += occ.textCrossed(knee, q.tip, ignore) * 40;
      // The text should run away from the tip, not back over the leader.
      if ((knee[0] - q.tip[0]) * dir < -2) cost += 25;
      const d = sub(knee, q.tip);
      const ang = Math.abs(Math.atan2(d[1], d[0]));
      const fromAxis = Math.min(ang % (Math.PI / 2), Math.PI / 2 - (ang % (Math.PI / 2)));
      if (!q.slanted && fromAxis < (15 * Math.PI) / 180) cost += 14;
      if (q.prefer) {
        const u = unit(d);
        cost += (1 - (u[0] * q.prefer[0] + u[1] * q.prefer[1])) * 6;
      }
      if (vb && box.max[1] < vb.min[1]) cost += 18;
      if (!best || cost < best.cost) best = { knee, dir, cost };
    }
  }
  return best;
}

/** Where the ray from p along d leaves the box (p itself when it is outside). */
export function exitPoint(p: Vec2, d: Vec2, box: Box): Vec2 {
  const ts: number[] = [];
  for (const i of [0, 1]) {
    if (d[i] > 1e-9) ts.push((box.max[i] - p[i]) / d[i]);
    if (d[i] < -1e-9) ts.push((box.min[i] - p[i]) / d[i]);
  }
  const t = Math.max(0, Math.min(...ts));
  return [p[0] + d[0] * t, p[1] + d[1] * t];
}
