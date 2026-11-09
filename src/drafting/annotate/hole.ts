// Hole callouts (Phase Q v2; Phase L wrote "CBORE Ø11 × 4 DEEP"): from the
// hole feature (the Hole Wizard), in the symbols of ISO 129-1 / ASME Y14.5:
//   4× Ø6.6 THRU            a clearance hole and its copies
//   ⌴ Ø11 ↧4                its counterbore
//   ⌵ Ø13 × 90°             or countersink
//   M8×1.25 - 6H ↧16        a tapped hole, its thread
//   Ø6.8 ↧20                and its tap drill when it stops short
//   6× Ø9 THRU EQ SP        a circular pattern of it, equally spaced
//   ON PCD Ø80              on its pitch circle
// and cosmetic thread callouts. The leader goes to the hole of the feature
// (or its copies) the callout reads best from, its text clear of the view.

import type { CosmeticThreadAnnotation, HoleAnnotation, Vec2, Vec3 } from "../../doc/types";
import type { HoleRecord } from "../../kernel/rebuild";
import { threadCallout } from "../../features/hole/standards";
import type { ComposedView } from "../compose";
import { viewToSheet } from "../compose";
import type { Box, Prim } from "../sheet";
import { parseRich, richWidth } from "../symbols/richtext";
import { CAP } from "../text";
import { toleranceLine } from "../tolerance";
import { inView } from "../views";
import { add, arrowHead, dist, failed, fromCentre, labelPrims, mul, sub, unit, type AnnotationContext, type Label, type LayoutResult } from "./common";
import { sizeText } from "./dimension";
import { findSpot } from "./placement";

/** "6.6", "12.5": a size in a callout. */
const f = (x: number) => sizeText(x, undefined);

/**
 * A hole's callout lines in the standards' symbols. `count` is how many it
 * stands for; `pcd` the pitch circle's diameter of a circular pattern.
 */
export function holeCallout(h: HoleRecord, count: number, opts: { pcd?: number; tolerance?: HoleAnnotation["tolerance"]; prefix?: string; suffix?: string } = {}): string[] {
  const n = count > 1 ? `${count}× ` : "";
  const pre = opts.prefix ? `${opts.prefix} ` : "";
  const bore = opts.tolerance ? toleranceLine(h.diameter, `Ø${f(h.diameter)}`, opts.tolerance) : `Ø${f(h.diameter)}`;
  const lines: string[] = [];
  if (h.thread) {
    const t = h.thread;
    lines.push(`${pre}${n}${t.designation} - ${t.class} ${t.depth === "through" ? "THRU" : `↧${f(t.depth)}`}`);
    if (!h.through) lines.push(`${bore} ↧${f(h.depth)}`);
  } else lines.push(`${pre}${n}${bore} ${h.through ? "THRU" : `↧${f(h.depth)}`}`);
  if (h.counterbore) lines.push(`⌴ Ø${f(h.counterbore.diameter)} ↧${f(h.counterbore.depth)}`);
  if (h.countersink) lines.push(`⌵ Ø${f(h.countersink.diameter)} × ${f(h.countersink.angle)}°`);
  if (opts.pcd !== undefined) {
    lines[0] += " EQ SP";
    lines.push(`ON PCD Ø${f(opts.pcd)}`);
  }
  if (opts.suffix) lines[lines.length - 1] += ` ${opts.suffix}`;
  return lines;
}

/** The centres (view mm) of a hole feature's holes the view sees end on: it and its pattern copies. */
export function holeCentres(cv: Pick<ComposedView, "edges" | "frame">, h: HoleRecord, makers: Set<string>): { c: Vec2; r: number; key: string }[] {
  const f = cv.frame;
  const out: { c: Vec2; r: number; key: string }[] = [];
  const outerR = (h.counterbore?.diameter ?? h.countersink?.diameter ?? h.diameter) / 2;
  const radii = [h.diameter / 2, outerR, ...(h.thread ? [h.thread.major / 2] : [])];
  const axis = unit3(h.axis);
  for (const e of cv.edges) {
    const m = e.model;
    if (!e.circle || e.look !== "circle" || !m || m.kind !== "circle" || !m.axis || m.radius === undefined) continue;
    if (!radii.some((r) => Math.abs(m.radius! - r) < 1e-3)) continue;
    if (Math.abs(Math.abs(dot3(unit3(m.axis), axis)) - 1) > 1e-6) continue;
    if (e.feature && !makers.has(e.feature) && !e.feature.startsWith("?")) continue;
    const c = e.circle.c;
    const at = out.find((x) => dist(x.c, c) < 1e-3);
    if (at) {
      if (e.circle.r > at.r) Object.assign(at, { r: e.circle.r, key: e.key });
      continue;
    }
    out.push({ c, r: e.circle.r, key: e.key });
  }
  if (!out.length) out.push({ c: inView(h.entry, f), r: outerR, key: "" });
  return out;
}

/** The circle the centres lie on (a circular pattern's pitch circle), when there are three or more equally far from their middle. */
export function pitchCircle(centres: Vec2[]): { c: Vec2; r: number } | null {
  if (centres.length < 3) return null;
  const c: Vec2 = [centres.reduce((s, p) => s + p[0], 0) / centres.length, centres.reduce((s, p) => s + p[1], 0) / centres.length];
  const rs = centres.map((p) => dist(p, c));
  const r = rs.reduce((s, x) => s + x, 0) / rs.length;
  return r > 1e-6 && rs.every((x) => Math.abs(x - r) < 1e-3 * Math.max(1, r)) ? { c, r } : null;
}

/** The features whose holes are this hole feature's: itself and the patterns and mirrors of it. */
export function holeMakers(ctx: AnnotationContext, hole: string): Set<string> {
  const p = ctx.data.patterns.get(hole);
  return new Set([hole, ...(p ? [p.id] : [])]);
}

interface CalloutDraw {
  lines: string[];
  /** The circles the leader may point at, on the sheet. */
  targets: { c: Vec2; r: number }[];
  at?: Vec2;
  owner: string;
}

/** A leadered block of callout lines: the knee where the leader turns, the text on a landing as wide as its longest line. */
export function drawCallout(ctx: AnnotationContext, cv: ComposedView, d: CalloutDraw): { prims: Prim[]; knee: Vec2; textBox: Box; tip: Vec2 } {
  const style = ctx.style;
  const size = style.font;
  const gap = size * 1.25;
  const widths = d.lines.map((l) => richWidth(parseRich(l), size));
  const w = Math.max(...widths);
  const lines = d.lines.length;
  const shape = (knee: Vec2, dir: 1 | -1): Box => {
    const x0 = dir > 0 ? knee[0] : knee[0] - w - 1.5;
    return { min: [x0, knee[1] + style.lift - (lines - 1) * gap - 0.3 * size], max: [x0 + w + 1.5, knee[1] + style.lift + size * CAP + 0.4] };
  };
  let best: { knee: Vec2; dir: 1 | -1; target: { c: Vec2; r: number }; cost: number } | null = null;
  if (d.at) {
    const knee = d.at;
    const target = d.targets.reduce((b, t) => (dist(t.c, knee) < dist(b.c, knee) ? t : b), d.targets[0]);
    best = { knee, dir: knee[0] >= target.c[0] ? 1 : -1, target, cost: 0 };
  } else {
    for (const target of d.targets) {
      const s = findSpot(ctx.occ, { tip: target.c, viewBox: cv.box, shape, owner: d.owner, prefer: [Math.SQRT1_2, Math.SQRT1_2] });
      if (s && (!best || s.cost < best.cost)) best = { knee: s.knee, dir: s.dir, target, cost: s.cost };
    }
    if (!best) {
      const t = d.targets[0];
      best = { knee: add(t.c, [t.r + 10, t.r + 10]), dir: 1, target: t, cost: 0 };
    }
  }
  const { knee, dir, target } = best;
  const toward = unit(sub(knee, target.c));
  const tip = add(target.c, mul(toward, target.r));
  const landing: Vec2 = [knee[0] + dir * (w + 1.5), knee[1]];
  const prims: Prim[] = [{ k: "line", pts: [landing, knee, tip], w: style.thin }, ...arrowHead(tip, mul(toward, -1), style)];
  let box: Box | null = null;
  d.lines.forEach((l, i) => {
    const label: Label = { parts: [{ kind: "rich", spans: parseRich(l), size }], size };
    const lp = labelPrims(label, [knee[0] + dir * 0.75, knee[1] + style.lift - i * gap], dir > 0 ? "start" : "end", 0, style);
    prims.push(...lp.prims);
    box = box ? { min: [Math.min(box.min[0], lp.box.min[0]), Math.min(box.min[1], lp.box.min[1])], max: [Math.max(box.max[0], lp.box.max[0]), Math.max(box.max[1], lp.box.max[1])] } : lp.box;
  });
  return { prims, knee, textBox: box!, tip };
}

export function layoutHole(a: HoleAnnotation, ctx: AnnotationContext, cv: ComposedView): LayoutResult | { problem: string } {
  const h = ctx.data.holes.get(a.hole);
  if (!h) return failed(`no hole "${a.hole}" built`);
  const f = cv.frame;
  const facing = Math.abs(dot3(h.axis, f.eye));
  if (facing < 0.999) return failed(`${a.hole} isn't seen as a circle in ${cv.id}: call it out in a view that looks along it`);
  const centres = holeCentres(cv, h, holeMakers(ctx, a.hole));
  const total = a.count ?? ctx.data.holeCounts.get(a.hole) ?? h.copies + 1;
  const pattern = ctx.data.patterns.get(a.hole);
  const pc = (a.pattern ?? pattern?.op === "circularPattern") ? pitchCircle(centres.map((x) => x.c)) : null;
  const lines = ctx.style.classic ? classicHoleText(h, total) : holeCallout(h, total, { ...(pc ? { pcd: 2 * pc.r } : {}), ...(a.tolerance ? { tolerance: a.tolerance } : {}), ...(a.prefix ? { prefix: a.prefix } : {}), ...(a.suffix ? { suffix: a.suffix } : {}) });
  // The circle it points at: the one named, else the one it reads best from.
  let targets = centres.map((x) => ({ c: viewToSheet(cv, x.c), r: x.r * cv.scale, key: x.key }));
  if (a.on) {
    const g = ctx.resolve(a.on);
    if (g?.kind === "circle") targets = [{ c: g.c, r: g.r, key: g.key ?? "" }];
  }
  const d = drawCallout(ctx, cv, { lines, targets, ...(a.at ? { at: add(cv.centre, a.at) } : {}), owner: a.id });
  const prims = d.prims;
  // Its centre mark, when the view has none on it (Phase L callouts draw their own).
  const hasMark = [...ctx.all.values()].some((x) => x.type === "centerMark" && x.view === cv.id);
  if (!hasMark || ctx.style.classic) {
    const t = targets.find((x) => dist(add(x.c, mul(unit(sub(d.tip, x.c)), x.r)), d.tip) < 1e-6) ?? targets[0];
    const m = t.r + 2;
    prims.push({ k: "line", pts: [[t.c[0] - m, t.c[1]], [t.c[0] + m, t.c[1]]], w: ctx.style.thin, dash: [6, 1.5, 1, 1.5], layer: "CENTER" });
    prims.push({ k: "line", pts: [[t.c[0], t.c[1] - m], [t.c[0], t.c[1] + m]], w: ctx.style.thin, dash: [6, 1.5, 1, 1.5], layer: "CENTER" });
  }
  // `under`: a frame naming the callout (gdt.dimension) hangs under its text (ISO 1101: under the size it tolerances).
  return { prims, textBox: d.textBox, under: [(d.textBox.min[0] + d.textBox.max[0]) / 2, d.textBox.min[1]], text: lines.join(" "), at: d.knee, grips: [{ name: "knee", at: d.knee, field: "at" }], place: { pts: [fromCentre(cv, d.tip), fromCentre(cv, d.knee)], text: lines.join(" ") } };
}

/** Phase L's callout words (the classic template keeps them). */
export function classicHoleText(h: HoleRecord, count = h.copies + 1): string[] {
  const n = count;
  if (h.thread) {
    // Phase L drew its depth sign as an open box (written ⌴).
    const lines = [`${n > 1 ? `${n}× ` : ""}${threadCallout(h.thread)}`];
    if (!h.through) lines.push(`Ø${f(h.diameter)} ⌴${f(h.depth)}`);
    return lines;
  }
  const lines = [`${n > 1 ? `${n}× ` : ""}Ø${f(h.diameter)} ${h.through ? "THRU" : `× ${f(h.depth)} DEEP`}`];
  if (h.counterbore) lines.push(`CBORE Ø${f(h.counterbore.diameter)} × ${f(h.counterbore.depth)} DEEP`);
  if (h.countersink) lines.push(`CSK Ø${f(h.countersink.diameter)} × ${f(h.countersink.angle)}°`);
  return lines;
}

/** A cosmetic thread's callout: its thread line alone, on a leader to the thread. */
export function layoutThread(a: CosmeticThreadAnnotation, ctx: AnnotationContext, cv: ComposedView): LayoutResult | { problem: string } {
  const h = ctx.data.holes.get(a.hole);
  if (!h) return failed(`no tapped hole or thread "${a.hole}" built`);
  if (!h.thread) return failed(`${a.hole} has no thread: call it out as a hole`);
  const t = h.thread;
  const line = `${t.designation} - ${t.class} ${t.depth === "through" ? "THRU" : `↧${f(t.depth)}`}`;
  const f3 = cv.frame;
  const facing = Math.abs(dot3(h.axis, f3.eye));
  let targets: { c: Vec2; r: number }[];
  if (a.on) {
    const g = ctx.resolve(a.on);
    if (!g) return failed(`${a.on} is not in ${cv.id} any more`);
    targets = [g.kind === "circle" ? { c: g.c, r: g.r } : g.kind === "point" ? { c: g.at, r: 0 } : { c: g.a && g.b ? mul(add(g.a, g.b), 0.5) : g.pts[0][0], r: 0 }];
  } else if (facing > 0.999) targets = holeCentres(cv, h, holeMakers(ctx, a.hole)).map((x) => ({ c: viewToSheet(cv, x.c), r: ((t.external ? t.major : t.major) / 2) * cv.scale }));
  else {
    // From the side: at the thread's line, a quarter of its length in.
    const len = t.depth === "through" ? h.depth : t.depth;
    const r = t.major / 2;
    const n = sideNormal(h.axis, f3);
    const p3: Vec3 = [0, 1, 2].map((i) => h.entry[i] + h.axis[i] * len * 0.35 + n[i] * r) as Vec3;
    targets = [{ c: viewToSheet(cv, inView(p3, f3)), r: 0 }];
  }
  const d = drawCallout(ctx, cv, { lines: [line], targets, ...(a.at ? { at: add(cv.centre, a.at) } : {}), owner: a.id });
  return { prims: d.prims, textBox: d.textBox, text: line, at: d.knee, grips: [{ name: "knee", at: d.knee, field: "at" }] };
}

/** A unit vector across the view, square to the hole's axis (to a thread's side line). */
function sideNormal(axis: Vec3, f: { eye: Vec3; up: Vec3; right: Vec3 }): Vec3 {
  // eye × axis lies in the view, square to the axis.
  const c: Vec3 = [f.eye[1] * axis[2] - f.eye[2] * axis[1], f.eye[2] * axis[0] - f.eye[0] * axis[2], f.eye[0] * axis[1] - f.eye[1] * axis[0]];
  const l = Math.hypot(...c) || 1;
  const n: Vec3 = [c[0] / l, c[1] / l, c[2] / l];
  // Toward the view's up or right.
  return dot3(n, f.up) + dot3(n, f.right) * 0.01 >= 0 ? n : [-n[0], -n[1], -n[2]];
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function unit3(v: Vec3): Vec3 {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
