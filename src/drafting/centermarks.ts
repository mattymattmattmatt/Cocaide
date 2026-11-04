// Centre marks and centre lines, added for a view (Phase Q): a mark on every
// circle the view sees end on (one per centre: a counterbore and its hole,
// or a hole's two ends, share one), a centre line along every round face it
// sees from the side (between its two outlines). They are annotations, so a
// user or the AI deletes the ones not wanted; nothing redraws them.

import type { Annotation, Vec2 } from "../doc/types";
import type { ProjectedView } from "../kernel/drawingViews";

export interface CenterOptions {
  /** Hidden edges are drawn in the view: hidden circles and round faces get theirs too. */
  hidden?: boolean;
  /** Centres that already have a mark (a hole callout draws its own), view mm. */
  skip?: Vec2[];
  /** Circles smaller than this radius (view mm) get none. */
  minRadius?: number;
}

/** The centre marks and centre lines a view should have, as annotations with ids from `id()`. */
export function autoCenterMarks(view: string, pv: ProjectedView, id: () => string, opts: CenterOptions = {}): Annotation[] {
  const out: Annotation[] = [];
  const centres: { c: Vec2; r: number; key: string; full: boolean }[] = [];
  for (const e of pv.edges) {
    if (!e.circle || (e.look !== "circle" && e.look !== "arc")) continue;
    if (!e.visible && !opts.hidden) continue;
    if (e.circle.r < (opts.minRadius ?? 0)) continue;
    // An arc gets a mark when it is at least half a circle (a slot's end, a boss's round), not a fillet's quarter.
    if (e.look === "arc" && e.circle.a0 !== undefined && e.circle.a1 !== undefined) {
      let span = e.circle.a1 - e.circle.a0;
      if (span < 0) span += 2 * Math.PI;
      if (span < Math.PI - 1e-6) continue;
    }
    const at = centres.find((x) => Math.hypot(x.c[0] - e.circle!.c[0], x.c[1] - e.circle!.c[1]) < 1e-6);
    if (at) {
      if (e.circle.r > at.r) Object.assign(at, { r: e.circle.r, key: e.key, full: e.look === "circle" });
      continue;
    }
    centres.push({ c: e.circle.c, r: e.circle.r, key: e.key, full: e.look === "circle" });
  }
  centres.sort((a, b) => a.c[0] - b.c[0] || a.c[1] - b.c[1]);
  for (const c of centres) {
    if ((opts.skip ?? []).some((s) => Math.hypot(s[0] - c.c[0], s[1] - c.c[1]) < 1e-6)) continue;
    out.push({ id: id(), type: "centerMark", view, at: `${view}:${c.full ? "e" : "c"}${c.key}` });
  }
  // Round faces from the side: their two outlines, "…/s3a" and "…/s3b".
  const sides = new Map<string, { a?: string; b?: string }>();
  for (const e of pv.edges) {
    if (e.type !== "outline" || e.look !== "line" || e.key.startsWith("?")) continue;
    if (!e.visible && !opts.hidden) continue;
    const face = e.key.slice(0, -1);
    const side = e.key.slice(-1) as "a" | "b";
    sides.set(face, { ...sides.get(face), [side]: e.key });
  }
  const seen = new Set<string>();
  for (const [, s] of [...sides].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    if (!s.a || !s.b) continue;
    // Two faces on one axis (a stepped shaft) still want one line each; the same pair twice, one.
    const k = `${s.a}|${s.b}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ id: id(), type: "centerline", view, between: [`${view}:e${s.a}`, `${view}:e${s.b}`] });
  }
  return out;
}
