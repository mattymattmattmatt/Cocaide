// Surface texture symbols (Phase Q): ISO 1302 / ISO 21920-1 and ASME
// Y14.36. The symbol's two legs at 60° (the short one 1.4h, the long one
// 3h), a bar across them when material must be removed, a circle in them
// when it may not, the long leg's extension carrying the requirements under
// it (position a, b: "Ra 1.6"), the process over it (c), the lay (d) at its
// foot, the machining allowance (e) left of it, and a circle at its knee
// for "all round". It stands on the surface (an edge seen edge on), on an
// extension line, or on a leader's landing; a general requirement sits by
// the title block as "√Ra 3.2 (√)".

import type { SurfaceAnnotation, Vec2 } from "../../doc/types";
import type { ComposedView } from "../compose";
import type { Box, Prim } from "../sheet";
import { parseRich, richPrims, richWidth } from "../symbols/richtext";
import { CAP } from "../text";
import { numberText } from "../tolerance";
import { add, arrowHead, failed, fromCentre, mul, sub, unit, type AnnotationContext, type LayoutResult } from "./common";
import { edgeTips, tipOf } from "./gdt";
import { findSpot } from "./placement";
import type { DraftStyle } from "./style";

/** The symbol with its apex at the origin, upright: its primitives and the box it takes. */
export function surfacePrims(a: Pick<SurfaceAnnotation, "symbol" | "values" | "process" | "lay" | "allowance" | "allAround">, style: DraftStyle): { prims: Prim[]; box: Box; width: number } {
  const h = style.h;
  const w = style.symbol;
  const H1 = 1.4 * h;
  const H2 = 3 * h;
  const t60 = Math.tan(Math.PI / 6);
  const prims: Prim[] = [];
  const shortTop: Vec2 = [-H1 * t60, H1];
  const longTop: Vec2 = [H2 * t60, H2];
  prims.push({ k: "line", pts: [shortTop, [0, 0], longTop], w });
  if (a.symbol === "removal") prims.push({ k: "line", pts: [shortTop, [H1 * t60, H1]], w });
  if (a.symbol === "noRemoval") {
    // The circle in the V, touching both legs.
    const r = H1 * 0.42;
    prims.push({ k: "circle", c: [0, r / Math.sin(Math.PI / 6) * 0.5 + r * 0.55], r, w });
  }
  const size = style.small;
  const lines = a.values ?? [];
  const textW = Math.max(0, ...lines.map((l) => richWidth(parseRich(l), size)), a.process ? richWidth(parseRich(a.process), size) : 0);
  const barLen = Math.max(h * 1.2, textW + 1.5);
  const values = lines.length || a.process;
  if (values) prims.push({ k: "line", pts: [longTop, [longTop[0] + barLen, longTop[1]]], w });
  lines.forEach((l, i) => prims.push(...richPrims(parseRich(l), [longTop[0] + 0.9, longTop[1] - 1.2 - size * CAP - i * size * 1.3], { size, stroke: w * 0.8 })));
  if (a.process) prims.push(...richPrims(parseRich(a.process), [longTop[0] + 0.9, longTop[1] + 1.0], { size, stroke: w * 0.8 }));
  if (a.lay) {
    const lay = a.lay === "⊥" ? "⊥" : a.lay;
    prims.push(...richPrims(parseRich(lay), [H1 * t60 + 1.2, 0.2], { size, stroke: w * 0.8 }));
  }
  if (a.allowance !== undefined) prims.push(...richPrims(parseRich(numberText(a.allowance)), [shortTop[0] - 0.8, h * 0.6], { size, anchor: "end", stroke: w * 0.8 }));
  if (a.allAround) prims.push({ k: "circle", c: longTop, r: 0.9, w });
  const right = longTop[0] + (values ? barLen : 0) + (a.lay ? 2 : 0);
  const left = shortTop[0] - (a.allowance !== undefined ? 4 : 0);
  return { prims, box: { min: [left, -0.2], max: [right, H2 + (a.process ? size * CAP + 1.4 : 0.4)] }, width: right - left };
}

function moved(prims: Prim[], by: Vec2): Prim[] {
  const t = (p: Vec2): Vec2 => [p[0] + by[0], p[1] + by[1]];
  return prims.map((p) => (p.k === "line" ? { ...p, pts: p.pts.map(t) } : p.k === "circle" ? { ...p, c: t(p.c) } : p.k === "area" ? { ...p, loops: p.loops.map((l) => l.map(t)) } : { ...p, at: t(p.at) }));
}

export function layoutSurface(a: SurfaceAnnotation, ctx: AnnotationContext, cv: ComposedView | undefined): LayoutResult | { problem: string } {
  const style = ctx.style;
  const s = surfacePrims(a, style);
  const text = `surface ${a.symbol ?? "basic"}${a.values?.length ? ` ${a.values.join(", ")}` : ""}${a.process ? ` ${a.process}` : ""}`;
  if (a.general || !cv) {
    // The general requirement: the symbol, then "(√)" meaning "unless shown otherwise", above the title block.
    const tb = ctx.sheet.titleBlock;
    const apex: Vec2 = a.at ? a.at : [tb.min[0] + 8, tb.max[1] + 4];
    const prims = moved(s.prims, apex);
    const paren = surfacePrims({ symbol: a.symbol }, { ...style, h: style.h * 0.7 });
    const px = apex[0] + s.box.max[0] + 6;
    prims.push({ k: "text", at: [px, apex[1] + 2], text: "(", size: style.font * 1.4, anchor: "start" });
    prims.push(...moved(paren.prims, [px + 4.6, apex[1] + 1.5]));
    prims.push({ k: "text", at: [px + 9.5, apex[1] + 2], text: ")", size: style.font * 1.4, anchor: "start" });
    const box: Box = { min: [apex[0] + s.box.min[0], apex[1]], max: [px + 12, apex[1] + s.box.max[1]] };
    return { prims, textBox: box, text: `general ${text}`, at: apex, grips: [{ name: "symbol", at: apex, field: "at" }] };
  }
  let tip: Vec2;
  let normal: Vec2 = [0, 1];
  if (a.dimension) {
    const d = ctx.layouts.get(a.dimension);
    const e = d?.extensions?.[a.extension ?? 0];
    if (!e) return failed(`its dimension ${a.dimension} isn't drawn`);
    tip = mul(add(e[0], e[1]), 0.5);
    normal = unit(sub(e[1], e[0]));
  } else if (a.on) {
    const t = tipOf(ctx, a.on, a.at ? add(cv.centre, a.at) : undefined);
    if (!t) return failed(`${a.on} is not in ${cv.id} any more`);
    tip = t.tip;
    normal = t.normal;
  } else return failed("a surface symbol is on a surface (on), a dimension's extension line (dimension), or general");
  const prims: Prim[] = [];
  let apex: Vec2;
  if (!a.at && normal[1] > 0.99) {
    // On a top edge: standing on the surface itself, outside the material.
    apex = tip;
    const b = { min: add(apex, s.box.min), max: add(apex, s.box.max) };
    if (ctx.occ.overlap(b, { ignore: [a.id], kinds: ["text", "symbol", "balloon", "label", "table"] }) > 0) apex = add(tip, [6, 0]);
  } else {
    // On a leader's landing, upright: the arrow on the surface.
    const shape = (knee: Vec2, dir: 1 | -1): Box => (dir > 0 ? { min: add(knee, [0, -0.5]), max: add(knee, [s.width + 2, s.box.max[1]]) } : { min: add(knee, [-s.width - 2, -0.5]), max: add(knee, [0, s.box.max[1]]) });
    const spot = a.at ? { knee: add(cv.centre, a.at), dir: 1 as const } : findSpot(ctx.occ, { tip, viewBox: cv.box, shape, owner: a.id, prefer: [normal[0] * 0.7 + 0.3, normal[1] * 0.7 + 0.5], rings: [6, 10, 16, 24], ...(a.on ? { tips: edgeTips(ctx, a.on) } : {}) });
    if (spot && "tip" in spot && spot.tip) tip = spot.tip;
    const knee = spot?.knee ?? add(tip, mul(normal, 10));
    const dir = spot?.dir ?? 1;
    const landing: Vec2 = [knee[0] + dir * (s.width + 2), knee[1]];
    prims.push({ k: "line", pts: [landing, knee, tip], w: style.thin }, ...arrowHead(tip, sub(tip, knee), style));
    apex = [knee[0] + dir * (2 - s.box.min[0]) - (dir < 0 ? s.width : 0), knee[1]];
  }
  prims.push(...moved(s.prims, apex));
  const box: Box = { min: add(apex, s.box.min), max: add(apex, s.box.max) };
  return { prims, textBox: box, text, at: apex, grips: [{ name: "symbol", at: apex, field: "at" }], place: { pts: [fromCentre(cv, tip), fromCentre(cv, apex)], text } };
}
