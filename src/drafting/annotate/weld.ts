// Weld symbols (Phase Q; Phase L drew a fillet or butt glyph and two
// numbers): ISO 2553 (system A: a continuous reference line with a dashed
// identification line, the arrow side's symbol on the continuous line, the
// other side's on the dashed one; no dashed line when both sides are alike)
// and AWS A2.4 (the arrow side below the line, the other side above). The
// elementary symbols (fillet, square / V / bevel / U / J / flare-V /
// flare-bevel butts, plug or slot, spot, seam, edge, back weld, backing,
// surfacing, stud) stand on the line; the size (a5 / z7, or the depth) to
// their left, the length and pitch (ISO "n × l (e)", AWS "l-p") to their
// right, the groove angle beyond them and the root opening in them, the
// contour (flush, convex, concave) and finish over them; staggered
// intermittent welds offset; all-around a circle at the knee, a field weld a
// flag there; the tail a fork with the process and a reference; more
// reference lines above for welds made in turn.

import type { Vec2, Vec3, Weld, WeldAnnotation, WeldSymbolSide, WeldSymbolType } from "../../doc/types";
import type { ComposedView } from "../compose";
import { viewToSheet } from "../compose";
import type { Box, Prim } from "../sheet";
import { parseRich, richPrims, richWidth } from "../symbols/richtext";
import { CAP } from "../text";
import { numberText } from "../tolerance";
import { inView } from "../views";
import { add, arrowHead, failed, fromCentre, sub, type AnnotationContext, type LayoutResult } from "./common";
import { tipOf } from "./gdt";
import { findSpot } from "./placement";
import type { DraftStyle } from "./style";

/** The sides a weld from the weld table has, as symbol sides. */
export function sidesOfWeld(w: Weld, standard: "ISO" | "ASME"): { arrowSide?: WeldSymbolSide; otherSide?: WeldSymbolSide } {
  const symbol: WeldSymbolType = w.type === "fillet" ? "fillet" : w.type === "plug" ? "plug" : w.size > 4 ? "v" : "square";
  const size = w.type === "fillet" ? (standard === "ISO" ? `z${numberText(w.size)}` : numberText(w.size)) : w.type === "butt" ? (standard === "ISO" ? `s${numberText(w.size)}` : numberText(w.size)) : numberText(w.size);
  const side: WeldSymbolSide = { symbol, size, ...(w.allRound ? {} : { length: w.length }) };
  const which = w.side ?? "arrow";
  return { ...(which !== "other" ? { arrowSide: side } : {}), ...(which !== "arrow" ? { otherSide: { ...side } } : {}) };
}

/** One elementary symbol standing on the line at x (local: the line is y = 0, the symbol on +y), s its size. */
function elementary(type: WeldSymbolType, x: number, s: number): Prim[] {
  const out: Prim[] = [];
  const L = (...pts: Vec2[]) => out.push({ k: "line", pts, w: 0 });
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number): Vec2[] => {
    const p: Vec2[] = [];
    for (let i = 0; i <= 14; i++) {
      const a = ((a0 + ((a1 - a0) * i) / 14) * Math.PI) / 180;
      p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return p;
  };
  const c = x + s / 2;
  switch (type) {
    case "fillet":
      out.push({ k: "line", pts: [[x, 0], [x, s], [x + s, 0]], w: 0, closed: true });
      break;
    case "square":
      L([x + 0.25 * s, 0], [x + 0.25 * s, s]);
      L([x + 0.75 * s, 0], [x + 0.75 * s, s]);
      break;
    case "v":
      L([x, s], [c, 0], [x + s, s]);
      break;
    case "bevel":
      L([x + 0.2 * s, s], [x + 0.2 * s, 0], [x + s, s]);
      break;
    case "u":
      L([c, 0], [c, 0.25 * s]);
      L(...arc(c, 0.7 * s, 0.45 * s, 180, 360));
      L([x + 0.05 * s, 0.7 * s], [x + 0.05 * s, s]);
      L([x + 0.95 * s, 0.7 * s], [x + 0.95 * s, s]);
      break;
    case "j":
      L([x + 0.15 * s, 0], [x + 0.15 * s, s]);
      L(...arc(x + 0.15 * s, 0.75 * s, 0.6 * s, 270, 360), [x + 0.75 * s, s]);
      break;
    case "flareV":
      L(...arc(x - 0.25 * s, 0.55 * s, 0.6 * s, -60, 60));
      L(...arc(x + 1.25 * s, 0.55 * s, 0.6 * s, 120, 240));
      break;
    case "flareBevel":
      L([x + 0.15 * s, 0], [x + 0.15 * s, s]);
      L(...arc(x + 1.25 * s, 0.55 * s, 0.6 * s, 120, 240));
      break;
    case "plug":
    case "slot":
      L([x, 0], [x, 0.55 * s], [x + s, 0.55 * s], [x + s, 0]);
      break;
    case "spot":
      out.push({ k: "circle", c: [c, 0.45 * s], r: 0.45 * s, w: 0 });
      break;
    case "seam":
      out.push({ k: "circle", c: [c, 0.45 * s], r: 0.45 * s, w: 0 });
      L([x - 0.15 * s, 0.3 * s], [x + 1.15 * s, 0.3 * s]);
      L([x - 0.15 * s, 0.6 * s], [x + 1.15 * s, 0.6 * s]);
      break;
    case "edge":
      L(...arc(x + 0.05 * s, 0.55 * s, 0.35 * s, 0, 90).reverse(), [x + 0.4 * s, 0]);
      L([x + 0.6 * s, 0], ...arc(x + 0.95 * s, 0.55 * s, 0.35 * s, 90, 180));
      break;
    case "backWeld":
      L(...arc(c, 0, 0.45 * s, 0, 180));
      break;
    case "backing":
      out.push({ k: "line", pts: [[x, 0], [x, 0.45 * s], [x + s, 0.45 * s], [x + s, 0]], w: 0 });
      out.push({ k: "text", at: [c, 0.06 * s], text: "M", size: 0.5 * s, anchor: "middle" });
      break;
    case "surfacing":
      L(...arc(x + 0.25 * s, 0, 0.25 * s, 0, 180));
      L(...arc(x + 0.75 * s, 0, 0.25 * s, 0, 180));
      break;
    case "stud":
      out.push({ k: "circle", c: [c, 0.5 * s], r: 0.5 * s, w: 0 });
      L([c - 0.35 * s, 0.15 * s], [c + 0.35 * s, 0.85 * s]);
      L([c - 0.35 * s, 0.85 * s], [c + 0.35 * s, 0.15 * s]);
      break;
  }
  return out;
}

/** Text for an intermittent or continuous weld's length: ISO "3 × 50 (100)" (the gap), AWS "50-150" (the pitch). */
function lengthText(side: WeldSymbolSide, standard: "ISO" | "ASME"): string {
  if (side.length === undefined) return "";
  if (side.pitch === undefined && side.count === undefined) return numberText(side.length);
  if (standard === "ISO") return `${side.count ?? 2} × ${numberText(side.length)}${side.pitch !== undefined ? ` (${numberText(side.pitch - side.length)})` : ""}`;
  return `${numberText(side.length)}${side.pitch !== undefined ? `-${numberText(side.pitch)}` : ""}`;
}

function sizeText(side: WeldSymbolSide): string {
  return side.size === undefined ? "" : typeof side.size === "number" ? numberText(side.size) : side.size;
}

/** One reference line's symbols and text, local: knee at 0, the line along +x to `length`. y +1 is above. */
function lineContent(arrow: WeldSymbolSide | undefined, other: WeldSymbolSide | undefined, standard: "ISO" | "ASME", style: DraftStyle, staggered: boolean): { prims: Prim[]; length: number; dashed: boolean } {
  const h = style.h;
  const s = 0.9 * h;
  const size = style.font * 0.85;
  const prims: Prim[] = [];
  // ISO: arrow side above the continuous line, the other side below the dashed one. AWS: arrow side below.
  const arrowY = standard === "ISO" ? 1 : -1;
  const both = !!arrow && !!other;
  const dashed = standard === "ISO" && !(both && arrow!.symbol === other!.symbol && sizeText(arrow!) === sizeText(other!));
  const dashGap = dashed ? 1.1 : 0;
  const sizeW = Math.max(arrow ? richWidth(parseRich(sizeText(arrow)), size) : 0, other ? richWidth(parseRich(sizeText(other)), size) : 0);
  const x = 4 + sizeW + 0.8;
  let right = x + s;
  for (const [side, ySign] of [
    [arrow, arrowY],
    [other, -arrowY],
  ] as const) {
    if (!side) continue;
    const base = side === other && dashed && standard === "ISO" ? -dashGap : 0;
    const sx = x + (staggered && side === other ? s * 1.6 : 0);
    const flip = (p: Prim): Prim => {
      const t = (q: Vec2): Vec2 => [q[0], base + ySign * q[1]];
      if (p.k === "line") return { ...p, pts: p.pts.map(t), w: style.symbol };
      if (p.k === "circle") return { ...p, c: t(p.c), w: style.symbol };
      if (p.k === "text") {
        const at = t(p.at);
        return { ...p, at: ySign < 0 ? [at[0], at[1] - p.size * CAP] : at };
      }
      return p;
    };
    prims.push(...elementary(side.symbol, sx, s).map(flip));
    const textY = (y: number) => base + ySign * y - (ySign < 0 ? size * CAP : 0);
    const st = sizeText(side);
    if (st) prims.push(...richPrims(parseRich(st), [sx - 0.8, textY(0.6)], { size, anchor: "end" }));
    const lt = lengthText(side, standard);
    if (lt) prims.push(...richPrims(parseRich(lt), [sx + s + 0.8, textY(0.6)], { size }));
    right = Math.max(right, sx + s + 0.8 + richWidth(parseRich(lt), size));
    // Beyond the symbol: its contour, then the finish; the groove angle; the root opening inside it.
    let top = s + 0.8;
    if (side.contour) {
      const cy = top;
      const pts: Vec2[] = [];
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const bulge = side.contour === "convex" ? 0.35 * s * Math.sin(Math.PI * t) : side.contour === "concave" ? -0.35 * s * Math.sin(Math.PI * t) + 0.35 * s : 0;
        pts.push([sx - 0.1 * s + 1.2 * s * t, cy + bulge]);
      }
      prims.push(...[{ k: "line", pts, w: 0 } as Prim].map(flip));
      top += 0.5 * s + 0.6;
    }
    if (side.angle !== undefined) {
      prims.push(...richPrims(parseRich(`${numberText(side.angle)}°`), [sx + s / 2, textY(top + 0.4)], { size: size * 0.9, anchor: "middle" }));
      top += size * CAP + 0.8;
    }
    if (side.finish) prims.push(...richPrims(parseRich(side.finish), [sx + s / 2, textY(top + 0.4)], { size: size * 0.9, anchor: "middle" }));
    if (side.root !== undefined) prims.push(...richPrims(parseRich(numberText(side.root)), [sx + s / 2, textY(0.15)], { size: size * 0.7, anchor: "middle" }));
  }
  const length = Math.max(right + 3, 22);
  prims.unshift({ k: "line", pts: [[0, 0], [length, 0]], w: style.thin });
  if (dashed) prims.push({ k: "line", pts: [[1, -dashGap], [length, -dashGap]], w: style.thin, dash: [2, 1] });
  return { prims, length, dashed };
}

/** Where two bodies meet: the middle of where their boxes overlap (or come closest). */
export function weldPoint(ctx: AnnotationContext, between: string[]): Vec3 | null {
  const boxes = between.slice(0, 2).map((n) => ctx.data.bodies.find((b) => b.name === n)?.boundingBox);
  if (boxes.length < 2 || !boxes[0] || !boxes[1]) return null;
  const [p, q] = boxes as NonNullable<(typeof boxes)[0]>[];
  return [0, 1, 2].map((i) => (Math.max(p.min[i], q.min[i]) + Math.min(p.max[i], q.max[i])) / 2) as Vec3;
}

export function layoutWeld(a: WeldAnnotation, ctx: AnnotationContext, cv: ComposedView): LayoutResult | { problem: string } {
  const style = ctx.style;
  const standard = ctx.drawing.standard ?? "ISO";
  const w = a.weld ? ctx.data.welds.find((x) => x.id === a.weld) : undefined;
  if (a.weld && !w) return failed(`no weld "${a.weld}" in the weld table`);
  const fromTable = w ? sidesOfWeld(w, standard) : {};
  const arrowSide = a.arrowSide ?? fromTable.arrowSide;
  const otherSide = a.otherSide ?? fromTable.otherSide;
  if (!arrowSide && !otherSide) return failed("a weld symbol has a weld on the arrow side, the other side, or both (or a weld from the weld table)");
  let tip: Vec2;
  if (a.on) {
    const t = tipOf(ctx, a.on);
    if (!t) return failed(`${a.on} is not in ${cv.id} any more`);
    tip = t.tip;
  } else if (w) {
    const p3 = weldPoint(ctx, w.between);
    if (!p3) return failed(`the bodies of ${w.id} (${w.between.join(", ")}) aren't built`);
    tip = viewToSheet(cv, inView(p3, cv.frame));
  } else return failed("a weld symbol points at the joint (on) or is a weld of the weld table (weld)");
  const lines = [lineContent(arrowSide, otherSide, standard, style, !!a.staggered), ...(a.more ?? []).map((m) => lineContent(m.arrowSide, m.otherSide, standard, style, false))];
  const length = Math.max(...lines.map((l) => l.length));
  const tail = [a.process ?? w?.process, a.reference, w && (w.count ?? 1) > 1 ? `${w.count}×` : ""].filter(Boolean).join(" ");
  const tailW = tail ? richWidth(parseRich(tail), style.font * 0.85) + 4 : 0;
  const step = 2.8 * style.h;
  const totalW = length + tailW;
  const shape = (knee: Vec2, dir: 1 | -1): Box => (dir > 0 ? { min: [knee[0], knee[1] - style.h * 1.6], max: [knee[0] + totalW, knee[1] + style.h * 1.6 + (lines.length - 1) * step] } : { min: [knee[0] - totalW, knee[1] - style.h * 1.6], max: [knee[0], knee[1] + style.h * 1.6 + (lines.length - 1) * step] });
  let knee: Vec2;
  let dir: 1 | -1;
  if (a.at) {
    knee = add(cv.centre, a.at);
    dir = a.at[0] >= sub(tip, cv.centre)[0] ? 1 : -1;
  } else {
    const s = findSpot(ctx.occ, { tip, viewBox: cv.box, shape, owner: a.id, prefer: [0.5, 0.85], rings: [8, 14, 22, 32] });
    knee = s?.knee ?? add(tip, [12, 12]);
    dir = s?.dir ?? 1;
  }
  const prims: Prim[] = [];
  // The line's content is laid out left to right; running left, it sits left of the knee (the arrow end on its right).
  const ox = dir > 0 ? knee[0] : knee[0] - length;
  lines.forEach((l, i) => {
    const y = knee[1] + i * step;
    const shift = dir > 0 ? 0 : length - l.length;
    for (const p of l.prims) {
      const t = (q: Vec2): Vec2 => [ox + shift + q[0], y + q[1]];
      if (p.k === "line") prims.push({ ...p, pts: p.pts.map(t), w: p.w || style.symbol });
      else if (p.k === "circle") prims.push({ ...p, c: t(p.c), w: p.w || style.symbol });
      else if (p.k === "text") prims.push({ ...p, at: t(p.at) });
      else prims.push(p);
    }
  });
  if (lines.length > 1) prims.push({ k: "line", pts: [knee, [knee[0], knee[1] + (lines.length - 1) * step]], w: style.thin });
  prims.push({ k: "line", pts: [tip, knee], w: style.thin }, ...arrowHead(tip, sub(tip, knee), style));
  if (a.allAround ?? w?.allRound) prims.push({ k: "circle", c: knee, r: 1.5, w: style.symbol });
  if (a.field) {
    const fx = knee[0];
    prims.push({ k: "line", pts: [knee, [fx, knee[1] + 5.5]], w: style.symbol });
    prims.push({ k: "line", pts: [[fx, knee[1] + 5.5], [fx + dir * 3.2, knee[1] + 4.6], [fx, knee[1] + 3.6]], closed: true, fill: true, w: style.thin });
  }
  if (tail) {
    const end: Vec2 = [dir > 0 ? knee[0] + length : knee[0] - length, knee[1]];
    prims.push({ k: "line", pts: [[end[0] + dir * 2.5, end[1] + 2.5], end, [end[0] + dir * 2.5, end[1] - 2.5]], w: style.thin });
    prims.push(...richPrims(parseRich(tail), [end[0] + dir * 3.2, end[1] - (style.font * 0.85 * CAP) / 2], { size: style.font * 0.85, anchor: dir > 0 ? "start" : "end" }));
  }
  const box = shape(knee, dir);
  const describe = (s?: WeldSymbolSide) => (s ? `${s.symbol}${s.size !== undefined ? ` ${sizeText(s)}` : ""}${s.length !== undefined ? ` ${lengthText(s, standard)}` : ""}` : "");
  const text = [w ? `${w.id}:` : "weld", arrowSide ? `arrow side ${describe(arrowSide)}` : "", otherSide ? `other side ${describe(otherSide)}` : "", (a.allAround ?? w?.allRound) ? "all around" : "", a.field ? "field weld" : "", tail].filter(Boolean).join(" ");
  return { prims, textBox: box, text, at: knee, grips: [{ name: "knee", at: knee, field: "at" }], place: { pts: [fromCentre(cv, tip), fromCentre(cv, knee)], text } };
}
