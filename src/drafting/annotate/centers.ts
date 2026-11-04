// Centre marks and centre lines (Phase Q; Q1A drew them, Q2A adds styles):
// a circle's centre lines a little past it with the short cross where they
// meet ("lines"), the cross alone ("cross"), or a pattern's mark ("pitch":
// the arc of the pitch circle through the hole and a radial line); a centre
// line between a cylinder's two outlines or through two points.

import type { CenterlineAnnotation, CenterMarkAnnotation, Vec2 } from "../../doc/types";
import type { ComposedView } from "../compose";
import { viewToSheet } from "../compose";
import type { Prim } from "../sheet";
import { CENTER_DASH } from "../text";
import { dist, failed, type AnnotationContext, type LayoutResult } from "./common";
import { pitchCircle } from "./hole";

export function layoutCenterMark(a: CenterMarkAnnotation, ctx: AnnotationContext, cv: ComposedView): LayoutResult | { problem: string } {
  const g = ctx.resolve(a.at);
  if (!g) return failed(`${a.at} is not in ${cv.id} any more`);
  let c: Vec2;
  let r: number;
  let radius: number;
  if (g.kind === "circle") {
    c = g.inView.c;
    r = g.inView.r;
    radius = g.radius;
  } else if (g.kind === "point" && g.of === "centre") {
    c = g.inView;
    const e = cv.edges.find((x) => x.key === g.key && x.circle);
    r = e?.circle?.r ?? 0;
    radius = e?.model?.radius ?? r;
  } else return failed(`${a.at} is not a circle or an arc's centre`);
  const s = viewToSheet(cv, c);
  const w = ctx.style.thin;
  const R = r * cv.scale + (a.extend ?? 2.5);
  const cross = Math.min(1.5, R / 3);
  const prims: Prim[] = [];
  const style = a.style ?? "lines";
  if (style === "cross") {
    const k = Math.max(1.5, Math.min(3, r * cv.scale * 0.4));
    prims.push({ k: "line", pts: [[s[0] - k, s[1]], [s[0] + k, s[1]]], w }, { k: "line", pts: [[s[0], s[1] - k], [s[0], s[1] + k]], w });
  } else if (style === "pitch") {
    // The pattern's other centres seen in the view: the pitch circle they lie on.
    const others = cv.edges.filter((e) => e.look === "circle" && e.circle && Math.abs(e.circle.r - r) < 1e-6).map((e) => e.circle!.c);
    const uniq: Vec2[] = [];
    for (const p of others) if (!uniq.some((q) => dist(p, q) < 1e-6)) uniq.push(p);
    const pc = pitchCircle(uniq);
    if (pc) {
      const pcs = viewToSheet(cv, pc.c);
      const PR = pc.r * cv.scale;
      const ang = Math.atan2(s[1] - pcs[1], s[0] - pcs[0]);
      const half = (R / PR) * 1.0;
      const arc: Vec2[] = [];
      for (let i = 0; i <= 12; i++) {
        const t = ang - half + (2 * half * i) / 12;
        arc.push([pcs[0] + PR * Math.cos(t), pcs[1] + PR * Math.sin(t)]);
      }
      prims.push({ k: "line", pts: arc, w, dash: CENTER_DASH });
      const u: Vec2 = [Math.cos(ang), Math.sin(ang)];
      prims.push({ k: "line", pts: [[s[0] - u[0] * R, s[1] - u[1] * R], [s[0] + u[0] * R, s[1] + u[1] * R]], w, dash: R > 6 ? CENTER_DASH : undefined });
    } else {
      prims.push({ k: "line", pts: [[s[0] - R, s[1]], [s[0] + R, s[1]]], w, dash: R > 6 ? CENTER_DASH : undefined });
      prims.push({ k: "line", pts: [[s[0], s[1] - R], [s[0], s[1] + R]], w, dash: R > 6 ? CENTER_DASH : undefined });
    }
  } else {
    prims.push({ k: "line", pts: [[s[0] - R, s[1]], [s[0] + R, s[1]]], w, dash: R > 6 ? CENTER_DASH : undefined });
    prims.push({ k: "line", pts: [[s[0], s[1] - R], [s[0], s[1] + R]], w, dash: R > 6 ? CENTER_DASH : undefined });
    if (R > 6) {
      // The dash pattern may leave the centre open: a short solid cross marks it.
      prims.push({ k: "line", pts: [[s[0] - cross, s[1]], [s[0] + cross, s[1]]], w });
      prims.push({ k: "line", pts: [[s[0], s[1] - cross], [s[0], s[1] + cross]], w });
    }
  }
  return { prims, text: `centre mark Ø${Math.round(2 * radius * 10) / 10}`, at: s, grips: [] };
}

export function layoutCenterline(a: CenterlineAnnotation, ctx: AnnotationContext, cv: ComposedView): LayoutResult | { problem: string } {
  const [g1, g2] = a.between.map((r) => ctx.resolve(r));
  if (!g1 || !g2) return failed(`${!g1 ? a.between[0] : a.between[1]} is not in ${cv.id} any more`);
  let p: Vec2;
  let q: Vec2;
  if (g1.kind === "edge" && g2.kind === "edge" && g1.inView.a && g1.inView.b && g2.inView.a && g2.inView.b) {
    const [a1, b1] = [g1.inView.a, g1.inView.b];
    let [a2, b2] = [g2.inView.a, g2.inView.b];
    if (dist(a1, a2) > dist(a1, b2)) [a2, b2] = [b2, a2];
    p = [(a1[0] + a2[0]) / 2, (a1[1] + a2[1]) / 2];
    q = [(b1[0] + b2[0]) / 2, (b1[1] + b2[1]) / 2];
  } else if (g1.kind !== "edge" && g2.kind !== "edge") {
    p = g1.kind === "circle" ? g1.inView.c : g1.inView;
    q = g2.kind === "circle" ? g2.inView.c : g2.inView;
  } else return failed("a centre line is between two edges or through two points");
  const s = viewToSheet(cv, p);
  const t = viewToSheet(cv, q);
  const l = dist(s, t);
  if (l < 1e-6) return failed("its two ends are the same place");
  const ext = a.extend ?? 2.5;
  const u: Vec2 = [(t[0] - s[0]) / l, (t[1] - s[1]) / l];
  return { prims: [{ k: "line", pts: [[s[0] - u[0] * ext, s[1] - u[1] * ext], [t[0] + u[0] * ext, t[1] + u[1] * ext]], w: ctx.style.thin, dash: CENTER_DASH }], text: "centre line", at: [(s[0] + t[0]) / 2, (s[1] + t[1]) / 2], grips: [] };
}
