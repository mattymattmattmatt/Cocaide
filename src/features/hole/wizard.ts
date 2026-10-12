// The Hole Wizard's rules, pure: what the editor shows for a hole (its kind,
// its numbers from the table or its own, the callout it will get), and the
// patch each choice sends. Patches are shallow (updateFeature merges
// top-level keys; null removes one). Vitest covers these in node.

import type { Vec2 } from "../../doc/types";
import {
  COUNTERSINK_ANGLE,
  defaultThreadDepth,
  HOLE_SIZES,
  holeKind,
  holeSpec,
  ISO_METRIC,
  screwSize,
  threadCallout,
  type HoleAsk,
  type HoleFit,
  type HoleKind,
  type HoleSpec,
} from "./standards";

type Raw = Record<string, unknown>;

/** What the editor reads off a hole (expressions already numbers). */
export function holeAsk(f: Raw): HoleAsk {
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const part = (v: unknown, keys: string[]) => {
    if (typeof v !== "object" || v === null) return undefined;
    const out: Record<string, number> = {};
    for (const k of keys) {
      const n = num((v as Raw)[k]);
      if (n !== undefined) out[k] = n;
    }
    return out;
  };
  return {
    size: typeof f.size === "string" ? f.size : undefined,
    kind: typeof f.kind === "string" ? (f.kind as HoleKind) : undefined,
    fit: typeof f.fit === "string" ? (f.fit as HoleFit) : undefined,
    diameter: num(f.diameter),
    counterbore: part(f.counterbore, ["diameter", "depth"]),
    countersink: part(f.countersink, ["diameter", "angle"]),
    thread: part(f.thread, ["pitch", "depth"]),
    depth: typeof f.depth === "number" || typeof f.depth === "string" ? f.depth : undefined,
  };
}

/** The hole's numbers as the rebuild will use them, or why it can't work them out. */
export function wizardSpec(f: Raw): HoleSpec | string {
  return holeSpec(holeAsk(f));
}

export const KIND_LABEL: Record<HoleKind, string> = { simple: "Simple", counterbore: "Counterbore", countersink: "Countersink", tapped: "Tapped" };
export const FIT_LABEL: Record<HoleFit, string> = { close: "Close", normal: "Normal", loose: "Loose" };

/** The end conditions of a hole: blind (a depth), through all, up to next. */
export type HoleEnd = "blind" | "through" | "upToNext";
export const END_LABEL: Record<HoleEnd, string> = { blind: "Blind", through: "Through all", upToNext: "Up to next" };

export function holeEnd(f: Raw): HoleEnd {
  return f.depth === "through" ? "through" : f.depth === "upToNext" ? "upToNext" : "blind";
}

/** The patch for a new end condition; blind starts at the depth the hole had, else deep enough for its thread or size. */
export function endPatch(f: Raw, end: HoleEnd, resolved: Raw = f): Raw {
  if (end !== "blind") return { depth: end, ...(holeKind(holeAsk(resolved)) === "tapped" ? { thread: threadWithout(f, "depth") } : {}) };
  if (holeEnd(f) === "blind") return {};
  return { depth: blindDepth(resolved) };
}

/** A sensible blind depth: a tapped hole's two diameters of thread plus three pitches; else two diameters; at least 1 mm. */
export function blindDepth(f: Raw): number {
  const ask = holeAsk(f);
  const std = ask.size ? screwSize(ask.size) : undefined;
  if (holeKind(ask) === "tapped" && std) return round(2 * std.d + 3 * (ask.thread?.pitch ?? std.pitch));
  const spec = holeSpec(ask);
  const d = typeof spec === "string" ? (ask.diameter ?? 5) : spec.diameter;
  const floor = typeof spec === "string" ? 0 : (spec.counterbore?.depth ?? 0) + 1;
  return round(Math.max(1, 2 * (std?.d ?? d), floor));
}

/**
 * The patch for another kind. With a size, the table gives the new kind's
 * numbers (the hole's own for the old kind are dropped); without one, a
 * counterbore or countersink gets numbers in proportion to the bore, and a
 * tapped hole takes the size whose tap drill is nearest the bore.
 */
export function kindPatch(f: Raw, kind: HoleKind, resolved: Raw = f): Raw {
  const ask = holeAsk(resolved);
  const patch: Raw = { kind, counterbore: null, countersink: null, thread: null };
  if (kind === "tapped") {
    patch.fit = null;
    if (!ask.size) {
      const d = ask.diameter ?? 5;
      patch.size = ISO_METRIC.reduce((best, r) => (Math.abs(r.tapDrill - d) < Math.abs(best.tapDrill - d) ? r : best)).size;
    }
    // The tap drill comes from the thread.
    patch.diameter = null;
  } else if (holeKind(ask) === "tapped") {
    // Leaving tapped: the clearance comes from the table again.
    patch.diameter = null;
  }
  if (!ask.size && kind !== "tapped") {
    const d = ask.diameter ?? 5;
    const deep = typeof ask.depth === "number" ? ask.depth : Infinity;
    if (kind === "counterbore") patch.counterbore = { diameter: round(d * 1.8), depth: round(Math.min(d, deep / 2)) };
    if (kind === "countersink") patch.countersink = { diameter: round(d * 2), angle: COUNTERSINK_ANGLE };
  }
  return patch;
}

/**
 * The patch for a size (or "" for none). Picking a size takes every number
 * from the table: the hole's own are dropped. Leaving the sizes, the hole
 * keeps the numbers it had, written out.
 */
export function sizePatch(f: Raw, size: string, resolved: Raw = f): Raw {
  if (size) return { size, diameter: null, counterbore: null, countersink: null, thread: null };
  const spec = wizardSpec(resolved);
  if (typeof spec === "string") return { size: null, fit: null };
  return {
    size: null,
    fit: null,
    kind: spec.kind === "tapped" ? "simple" : (f.kind ?? null),
    diameter: spec.kind === "tapped" ? spec.thread!.major : spec.diameter,
    counterbore: spec.counterbore ?? null,
    countersink: spec.countersink ?? null,
    thread: null,
  };
}

/** The patch for a fit: normal is the default, left out of the document; the table's diameter applies again. */
export function fitPatch(fit: HoleFit): Raw {
  return { fit: fit === "normal" ? null : fit, diameter: null };
}

/** The hole's `thread` object without one key (the rest of what it gives itself kept), or null when nothing is left. */
function threadWithout(f: Raw, key: string): Raw | null {
  const t = typeof f.thread === "object" && f.thread !== null ? { ...(f.thread as Raw) } : {};
  delete t[key];
  return Object.keys(t).length ? t : null;
}

/** The callout a drawing will give the hole (one hole of it): "Ø6.6 THRU" + "CBORE Ø11 × 6.5 DEEP", "M6×1 - 6H ⌴12" + "Ø5 ⌴15". */
export function calloutPreview(spec: HoleSpec, depth: unknown): string[] {
  const n = (x: number) => String(Math.round(x * 1e6) / 1e6);
  const through = typeof depth !== "number";
  if (spec.thread) {
    const lines = [threadCallout(spec.thread)];
    if (!through) lines.push(`Ø${n(spec.diameter)} ⌴${n(depth as number)}`);
    return lines;
  }
  const lines = [`Ø${n(spec.diameter)} ${through ? "THRU" : `× ${n(depth as number)} DEEP`}`];
  if (spec.counterbore) lines.push(`CBORE Ø${n(spec.counterbore.diameter)} × ${n(spec.counterbore.depth)} DEEP`);
  if (spec.countersink) lines.push(`CSK Ø${n(spec.countersink.diameter)} × ${n(spec.countersink.angle)}°`);
  return lines;
}

/** Where the holes are: one centre, several, or a sketch's points. */
export type Placement = "centers" | "points";

export function placement(f: Raw): Placement {
  return typeof f.points === "string" ? "points" : "centers";
}

/** The hole's centres (one or several), as the document holds them (numbers or "=expr"). */
export function centresOf(f: Raw): unknown[][] {
  if (Array.isArray(f.centers)) return f.centers as unknown[][];
  return Array.isArray(f.center) ? [f.center as unknown[]] : [];
}

/** The patch that sets the centres: one is `center`, several are `centers`. */
export function centresPatch(list: unknown[][]): Raw {
  if (list.length === 1) return { center: list[0], centers: null, points: null };
  return { centers: list, center: null, points: null };
}

/** Adds a centre (where a face was clicked, in the face's frame), unless the hole has one there already. */
export function addCentrePatch(f: Raw, at: Vec2, resolved: Raw = f): Raw | null {
  const have = centresOf(resolved).map((c) => c as number[]);
  if (have.some((c) => Math.hypot(c[0] - at[0], c[1] - at[1]) < 1e-6)) return null;
  return centresPatch([...centresOf(f), at]);
}

/** Removes centre `i` (the last one can't go). */
export function removeCentrePatch(f: Raw, i: number): Raw | null {
  const list = centresOf(f);
  if (list.length <= 1) return null;
  return centresPatch(list.filter((_, k) => k !== i));
}

/** Sets one coordinate (0 x, 1 y) of centre `i`. */
export function setCentrePatch(f: Raw, i: number, axis: 0 | 1, value: unknown): Raw {
  const list = centresOf(f).map((c) => [...c]);
  list[i][axis] = value;
  return centresPatch(list);
}

/** The patch that places the holes at a sketch's points (the face kept: the points are dropped onto it). */
export function pointsPatch(sketch: string): Raw {
  return { points: sketch, center: null, centers: null };
}

/** How many holes the feature drills: its centres, or its sketch's points. */
export function holeCount(f: Raw, before: Raw[]): number {
  if (typeof f.points === "string") {
    const sk = before.find((g) => g.id === f.points);
    return Array.isArray(sk?.entities) ? (sk.entities as Raw[]).filter((e) => e.type === "point").length : 0;
  }
  return centresOf(f).length;
}

/** The earlier sketches with points: what `points` may name, [id, "sketch_2 (4 points)"]. */
export function pointSketches(before: Raw[]): [string, string][] {
  return before.flatMap((g) => {
    if (g.op !== "sketch" || !Array.isArray(g.entities)) return [];
    const n = (g.entities as Raw[]).filter((e) => e.type === "point").length;
    return n ? [[String(g.id), `${String(g.id)} (${n} point${n === 1 ? "" : "s"})`] as [string, string]] : [];
  });
}

/**
 * What a new hole takes from the hole before it in the document (the Hole
 * Wizard remembers): its size, kind, fit, depth and its own numbers. None
 * before it: a plain Ø5 hole through all.
 */
export function rememberedHole(features: Raw[]): Raw {
  const last = [...features].reverse().find((g) => g.op === "hole");
  if (!last) return { diameter: 5, depth: "through" };
  const out: Raw = {};
  for (const k of ["size", "kind", "fit", "diameter", "depth", "counterbore", "countersink", "thread"]) if (last[k] !== undefined) out[k] = structuredClone(last[k]);
  if (out.depth === undefined) out.depth = "through";
  return out;
}

/** The sizes for the size select: "Custom" (no size), then M3 ... M24. */
export const SIZE_OPTIONS: [string, string][] = [["", "Custom (no size)"], ...HOLE_SIZES.map((s): [string, string] => [s, s])];

/** A tree chip: "M6 counterbore", "3 × Ø6.6", "M8 tapped ⌴15". */
export function holeSummary(f: Raw, before: Raw[] = []): string | null {
  const ask = holeAsk(f);
  const kind = holeKind(ask);
  const n = holeCount(f, before);
  const what = ask.size ? `${ask.size}${kind === "simple" ? "" : ` ${kind}`}` : typeof f.diameter === "number" ? `Ø${round(f.diameter)}` : null;
  if (!what) return null;
  return `${n > 1 ? `${n} × ` : ""}${what}`;
}

/** The thread depth to show for a tapped hole: its own, or the default for its depth. */
export function threadDepthOf(f: Raw): number | "through" | undefined {
  const spec = wizardSpec(f);
  if (typeof spec === "string" || !spec.thread) return undefined;
  return spec.thread.depth ?? defaultThreadDepth(f.depth as number | string | undefined, spec.thread.pitch);
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}
