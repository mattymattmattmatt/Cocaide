// Balloons (Phase Q; Phase L had a circle per member): an item number of
// the cut list or BOM (itemNumberFor, kept numbering included) in a circle,
// hexagon, triangle, box, split circle (item over quantity) or flag, with a
// leader to the member or body (its longest visible line, a dot on it), the
// quantity "2×" beside it, and more items stacked under it on one leader.

import type { BalloonAnnotation, BalloonShape, Vec2 } from "../../doc/types";
import type { ComposedView } from "../compose";
import { viewToSheet } from "../compose";
import type { Box, Prim } from "../sheet";
import { CAP, textWidth } from "../text";
import { add, arrowHead, dist, failed, fromCentre, mul, sub, unit, type AnnotationContext, type LayoutResult } from "./common";
import { tipOf } from "./gdt";
import { exitPoint } from "./placement";

/** The middle of a body's longest visible line in a view (view mm), and how much of it shows. */
export function visibleAnchor(cv: Pick<ComposedView, "edges">, body: string): { at: Vec2; length: number } | null {
  let best: { at: Vec2; seg: number } | null = null;
  let total = 0;
  for (const e of cv.edges) {
    if (!e.visible || e.body !== body) continue;
    for (let i = 1; i < e.pts.length; i++) {
      const l = dist(e.pts[i], e.pts[i - 1]);
      total += l;
      if (!best || l > best.seg) best = { at: mul(add(e.pts[i], e.pts[i - 1]), 0.5), seg: l };
    }
  }
  return best && best.seg > 1e-6 ? { at: best.at, length: total } : null;
}

/** A balloon's outline round centre c, radius r. */
export function balloonShape(shape: BalloonShape, c: Vec2, r: number, w: number): Prim[] {
  const poly = (n: number, rot: number): Vec2[] => Array.from({ length: n }, (_, i) => [c[0] + r * Math.cos(rot + (2 * Math.PI * i) / n), c[1] + r * Math.sin(rot + (2 * Math.PI * i) / n)] as Vec2);
  switch (shape) {
    case "hexagon":
      return [{ k: "line", pts: poly(6, 0), closed: true, w }];
    case "triangle":
      return [{ k: "line", pts: poly(3, Math.PI / 2).map((p) => [p[0], p[1] - r * 0.25] as Vec2), closed: true, w }];
    case "box":
      return [{ k: "line", pts: [[c[0] - r, c[1] - r * 0.8], [c[0] + r, c[1] - r * 0.8], [c[0] + r, c[1] + r * 0.8], [c[0] - r, c[1] + r * 0.8]], closed: true, w }];
    case "split":
      return [{ k: "circle", c, r, w }, { k: "line", pts: [[c[0] - r, c[1]], [c[0] + r, c[1]]], w }];
    case "flag":
      return [{ k: "line", pts: [[c[0] - r, c[1] - r * 0.7], [c[0] + r * 0.6, c[1] - r * 0.7], [c[0] + r, c[1]], [c[0] + r * 0.6, c[1] + r * 0.7], [c[0] - r, c[1] + r * 0.7]], closed: true, w }];
    default:
      return [{ k: "circle", c, r, w }];
  }
}

export function layoutBalloon(a: BalloonAnnotation, ctx: AnnotationContext, cv: ComposedView): LayoutResult | { problem: string } {
  const style = ctx.style;
  const name = a.member ?? a.body;
  const m = a.member ? (ctx.data.members.find((x) => x.id === a.member) ?? ctx.data.members.find((x) => x.body === a.member)) : undefined;
  if (a.member && !m) return failed(`no member "${a.member}" built`);
  const body = m?.body ?? a.body;
  let item: number | null = a.item ?? null;
  if (item === null && name) {
    item = (m && ctx.data.cutList.find((i) => i.members.includes(m.id))?.item) ?? ctx.data.itemOf?.(m?.id ?? name) ?? (body ? ctx.data.itemOf?.(body) : null) ?? null;
    if (item === null) return failed(`${name} is not in the cut list`);
  }
  if (item === null) return failed("a balloon numbers a member (member), a body (body) or an item (item)");
  let tip: Vec2 | null = null;
  if (a.on) tip = tipOf(ctx, a.on)?.tip ?? null;
  else if (body) {
    const anchor = visibleAnchor(cv, body);
    if (!anchor) return failed(`${name} can't be seen in ${cv.id}: balloon it in a view that shows it`);
    tip = viewToSheet(cv, anchor.at);
  }
  if (!tip) return failed(`${a.on ?? name} is not in ${cv.id}`);
  const text = String(item);
  const size = style.classic ? 5 : style.font;
  const r = (a.size ?? (text.length > 2 ? 12 : style.classic ? 9 : 10)) / 2 + (style.classic && text.length > 1 ? 0.7 : 0);
  const stack = (a.stack ?? []).map((s) => (typeof s === "number" ? s : (ctx.data.cutList.find((i) => i.members.includes(s))?.item ?? ctx.data.itemOf?.(s) ?? null)));
  const qty = a.quantity === true ? (ctx.data.quantityOf?.(item) ?? ctx.data.cutList.find((i) => i.item === item)?.quantity) : typeof a.quantity === "number" ? a.quantity : undefined;
  const shape = a.shape ?? "circle";
  const height = 2 * r * (1 + stack.length);
  let c: Vec2;
  if (a.at) c = add(cv.centre, a.at);
  else c = balloonSpot(ctx, cv, tip, r, height, a.id);
  const prims: Prim[] = [];
  const d = sub(tip, c);
  if (dist(tip, c) > r + 0.5) {
    const from = add(c, mul(unit(d), r));
    prims.push({ k: "line", pts: [from, tip], w: style.thin });
    prims.push(...(a.arrow && a.arrow !== "dot" ? arrowHead(tip, d, style, a.arrow) : [{ k: "circle" as const, c: tip, r: 0.7, w: style.thin, fill: true }]));
  }
  const all = [item, ...stack];
  all.forEach((n, i) => {
    const cc: Vec2 = [c[0], c[1] - i * 2 * r];
    prims.push(...balloonShape(i === 0 ? shape : shape === "split" ? "circle" : shape, cc, r, style.thin));
    const t = n === null ? "?" : String(n);
    if (shape === "split" && i === 0) {
      prims.push({ k: "text", at: [cc[0], cc[1] + r * 0.2], text: t, size: size * 0.8, anchor: "middle" });
      prims.push({ k: "text", at: [cc[0], cc[1] - r * 0.75], text: qty !== undefined ? String(qty) : "", size: size * 0.7, anchor: "middle" });
    } else prims.push({ k: "text", at: [cc[0], cc[1] - (size * CAP) / 2], text: t, size, anchor: "middle" });
  });
  if (qty !== undefined && shape !== "split") {
    const q = `${qty}×`;
    const right = tip[0] < c[0];
    prims.push({ k: "text", at: [right ? c[0] + r + 1 : c[0] - r - 1, c[1] - (size * CAP) / 2], text: q, size: size * 0.85, anchor: right ? "start" : "end" });
  }
  const box: Box = { min: [c[0] - r - (qty !== undefined ? textWidth(`${qty}×`, size) + 1 : 0), c[1] - r - (height - 2 * r)], max: [c[0] + r + (qty !== undefined ? textWidth(`${qty}×`, size) + 1 : 0), c[1] + r] };
  return { prims, textBox: box, text: [text, ...stack.map(String)].join(", ") + (qty !== undefined ? ` (${qty}×)` : ""), item, at: c, grips: [{ name: "symbol", at: c, field: "at" }], place: { pts: [fromCentre(cv, tip), fromCentre(cv, c)], text } };
}

/**
 * Where a balloon goes: on a ring just outside its view, as near what it
 * points at as it can be while on the sheet, clear of the other balloons,
 * views, tables, labels and text, its leader crossing as few lines as can be.
 */
function balloonSpot(ctx: AnnotationContext, cv: ComposedView, tip: Vec2, r: number, height: number, owner: string): Vec2 {
  let best: { c: Vec2; cost: number } | null = null;
  const vb = cv.box!;
  for (const ring of [6 + r, 12 + r, 20 + r]) {
    for (let k = 0; k < 72; k++) {
      const t = (k / 72) * 2 * Math.PI;
      const c = exitPoint([(vb.min[0] + vb.max[0]) / 2, (vb.min[1] + vb.max[1]) / 2], [Math.cos(t), Math.sin(t)], { min: [vb.min[0] - ring, vb.min[1] - ring], max: [vb.max[0] + ring, vb.max[1] + ring] });
      const box: Box = { min: [c[0] - r - 1, c[1] - r - (height - 2 * r) - 1], max: [c[0] + r + 1, c[1] + r + 1] };
      if (!ctx.occ.inFrame(box)) continue;
      if (ctx.occ.overlap(box, { ignore: [owner], kinds: ["text", "symbol", "balloon", "label", "table", "title"] }) > 0) continue;
      if (ctx.occ.overlap(box, { ignore: [owner], views: true, kinds: ["view"] }) > 0) continue;
      const cost = dist(c, tip) + ctx.occ.crossings(c, tip, [owner]) * 25 + ctx.occ.textCrossed(c, tip, [owner]) * 40 + (ring > 6 + r ? 4 : 0);
      if (!best || cost < best.cost) best = { c, cost };
    }
    if (best) break;
  }
  return best?.c ?? add(tip, [r * 3, r * 3]);
}
