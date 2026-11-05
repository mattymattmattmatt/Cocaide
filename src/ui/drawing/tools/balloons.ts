// Auto Balloon (Phase Q wave Q3A): a balloon for every cut list (or BOM)
// item that a view shows and that has none yet, each on the member or body
// it numbers, arranged by a layout: round the view where each one is free
// (the engine places them), or in a row above or below it, a column to its
// left or right, or square round it, in the order their parts are, so the
// leaders don't cross. Pure.

import type { Annotation, BalloonAnnotation, Vec2 } from "../../../doc/types";
import { visibleAnchor } from "../../../drafting/annotate";
import type { ComposedSheet, ComposedView } from "../../../drafting/compose";
import { viewToSheet } from "../../../drafting/compose";

export const BALLOON_LAYOUTS = ["around", "top", "bottom", "left", "right", "square"] as const;
export type BalloonLayout = (typeof BALLOON_LAYOUTS)[number];

export interface AutoBalloonOptions {
  /** The views to balloon (default: every view on the sheet), the first that shows an item gets it. */
  views?: string[];
  layout?: BalloonLayout;
  /** Distance of a row or column from the view, sheet mm (default 14). */
  gap?: number;
}

/** The balloons to add (without ids), and the items no view shows. */
export function autoBalloons(sheet: ComposedSheet, existing: Annotation[], opts: AutoBalloonOptions = {}): { balloons: Omit<BalloonAnnotation, "id">[]; unseen: number[] } {
  const layout = opts.layout ?? "around";
  const gap = opts.gap ?? 14;
  const views = (opts.views ?? sheet.views.map((v) => v.id)).map((id) => sheet.views.find((v) => v.id === id)).filter((v): v is ComposedView => !!v?.box);
  const said = new Map(sheet.annotations.map((a) => [a.id, a]));
  const done = new Set<number>();
  for (const a of existing) {
    if (a.type !== "balloon") continue;
    const item = a.item ?? said.get(a.id)?.item;
    if (item !== undefined) done.add(item);
  }
  const memberBody = new Map(sheet.points.members.map((m) => [m.id, m.body]));
  const picks = new Map<string, { view: ComposedView; member: string; at: Vec2 }[]>();
  const unseen: number[] = [];
  for (const item of sheet.cutList) {
    if (done.has(item.item)) continue;
    let placed = false;
    for (const cv of views) {
      // The member of the item that shows most in this view.
      let best: { member: string; at: Vec2; length: number } | null = null;
      for (const m of item.members) {
        const body = memberBody.get(m);
        const anchor = body ? visibleAnchor(cv, body) : null;
        if (anchor && (!best || anchor.length > best.length)) best = { member: m, at: viewToSheet(cv, anchor.at), length: anchor.length };
      }
      if (!best) continue;
      picks.set(cv.id, [...(picks.get(cv.id) ?? []), { view: cv, member: best.member, at: best.at }]);
      placed = true;
      break;
    }
    if (!placed) unseen.push(item.item);
  }
  const balloons: Omit<BalloonAnnotation, "id">[] = [];
  for (const list of picks.values()) {
    const cv = list[0].view;
    const b = cv.box!;
    const rel = (p: Vec2): Vec2 => [Math.round((p[0] - cv.centre[0]) * 10) / 10 + 0, Math.round((p[1] - cv.centre[1]) * 10) / 10 + 0];
    const spread = (n: number, lo: number, hi: number, i: number) => (n === 1 ? (lo + hi) / 2 : lo + ((hi - lo) * i) / (n - 1));
    if (layout === "around") {
      for (const x of list) balloons.push({ type: "balloon", view: cv.id, member: x.member });
      continue;
    }
    if (layout === "top" || layout === "bottom") {
      const sorted = [...list].sort((p, q) => p.at[0] - q.at[0]);
      const y = layout === "top" ? b.max[1] + gap : b.min[1] - gap;
      const w = Math.max(b.max[0] - b.min[0], 12 * (sorted.length - 1));
      const mid = (b.min[0] + b.max[0]) / 2;
      sorted.forEach((x, i) => balloons.push({ type: "balloon", view: cv.id, member: x.member, at: rel([spread(sorted.length, mid - w / 2, mid + w / 2, i), y]) }));
      continue;
    }
    if (layout === "left" || layout === "right") {
      const sorted = [...list].sort((p, q) => q.at[1] - p.at[1]);
      const x0 = layout === "right" ? b.max[0] + gap : b.min[0] - gap;
      const h = Math.max(b.max[1] - b.min[1], 12 * (sorted.length - 1));
      const mid = (b.min[1] + b.max[1]) / 2;
      sorted.forEach((x, i) => balloons.push({ type: "balloon", view: cv.id, member: x.member, at: rel([x0, spread(sorted.length, mid + h / 2, mid - h / 2, i)]) }));
      continue;
    }
    // Square: each on the box round the view, in the direction of its part from the view's middle, in angle order.
    const c: Vec2 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2];
    const hw = (b.max[0] - b.min[0]) / 2 + gap;
    const hh = (b.max[1] - b.min[1]) / 2 + gap;
    const onBox = (ang: number): Vec2 => {
      const d: Vec2 = [Math.cos(ang), Math.sin(ang)];
      const t = Math.min(Math.abs(d[0]) > 1e-9 ? hw / Math.abs(d[0]) : Infinity, Math.abs(d[1]) > 1e-9 ? hh / Math.abs(d[1]) : Infinity);
      return [c[0] + d[0] * t, c[1] + d[1] * t];
    };
    const angles = list.map((x) => Math.atan2(x.at[1] - c[1], x.at[0] - c[0]));
    const order = list.map((_, i) => i).sort((i, j) => angles[i] - angles[j]);
    // Keep neighbours at least 12 mm apart along the box: spread their angles out where they bunch.
    const minStep = (2 * Math.PI) / Math.max(order.length, 1) / 2;
    const placed = order.map((i) => angles[i]);
    for (let k = 1; k < placed.length; k++) placed[k] = Math.max(placed[k], placed[k - 1] + Math.min(minStep, 0.35));
    order.forEach((i, k) => balloons.push({ type: "balloon", view: cv.id, member: list[i].member, at: rel(onBox(placed[k])) }));
  }
  return { balloons, unseen };
}
