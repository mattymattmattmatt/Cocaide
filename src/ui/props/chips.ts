// The picked edges and faces of a feature as short chips (a fillet's 12 edges
// are 12 lines like "Straight · 120 mm", not 12 paragraphs of selector), one
// per edge or face actually found, plus the selectors that find nothing now
// (a reference broken by an upstream change: shown, to re-pick or remove).
// Pure: Vitest covers it.

import type { EdgeSelector, FaceSelector } from "../../doc/types";
import { formatDirection } from "../../geom/vec";
import { describeEdgeSelector, describeWanted, selectEdges, selectFaces } from "../../kernel/selectors";
import type { EdgeInfo, FaceInfo } from "../../kernel/topology";
import { edgeList } from "./picking";
import { asList } from "./spec";

const r = (x: number) => (Math.round(x * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });

/** An edge in a few words: "Straight · 120 mm", "Round · R 5", "Curved · 40 mm". */
export function edgeChipText(e: EdgeInfo): string {
  if (e.kind === "line") return `Straight · ${r(e.length)} mm`;
  if (e.kind === "circle" && e.radius !== undefined) {
    const full = Math.abs(e.length - 2 * Math.PI * e.radius) < 1e-6 * Math.max(1, e.length);
    return `${full ? "Circle" : "Arc"} · R ${r(e.radius)}`;
  }
  return `Curved · ${r(e.length)} mm`;
}

/** A face in a few words: "Flat · facing +Z", "Round · R 5". */
export function faceChipText(f: FaceInfo): string {
  if (f.type === "plane" && f.normal) return `Flat · facing ${formatDirection(f.normal)}`;
  if (f.type === "cylinder" && f.cylinder) return `Round · R ${r(f.cylinder.radius)}${f.cylinder.concave ? " (hole)" : ""}`;
  if (f.type === "cone") return "Conical";
  return "Curved";
}

export interface Chip {
  /** The edge's or face's index on the part shown (for highlighting and taking it out). */
  index: number;
  text: string;
  /** Its body, in a part of several. */
  body?: string;
  /** The selector it came from, in words (the chip's tooltip). */
  title: string;
}

export interface Missing {
  /** Its place in the stored list (to remove it). */
  at: number;
  title: string;
}

/** The edges a value finds, a chip each (in the order found, each once), and the selectors that find none. */
export function edgeChips(value: unknown, edges: EdgeInfo[], faces: FaceInfo[], multiBody: boolean): { chips: Chip[]; missing: Missing[] } {
  const chips: Chip[] = [];
  const missing: Missing[] = [];
  const seen = new Set<number>();
  edgeList(value).forEach((sel: EdgeSelector, at) => {
    const found = selectEdges(edges, faces, sel);
    const title = describeEdgeSelector(sel);
    if (found.error || found.matches.length === 0) return void missing.push({ at, title });
    for (const m of found.matches) {
      if (seen.has(m.index)) continue;
      seen.add(m.index);
      chips.push({ index: m.index, text: edgeChipText(m), ...(multiBody && m.body ? { body: m.body } : {}), title });
    }
  });
  return { chips, missing };
}

/** The same for faces. */
export function faceChips(value: unknown, faces: FaceInfo[], multiBody: boolean): { chips: Chip[]; missing: Missing[] } {
  const chips: Chip[] = [];
  const missing: Missing[] = [];
  const seen = new Set<number>();
  asList<FaceSelector>(value).forEach((sel, at) => {
    const found = selectFaces(faces, sel);
    const title = describeWanted(sel, 1).replace(/^1 /, "");
    if (found.matches.length === 0) return void missing.push({ at, title });
    for (const m of found.matches) {
      if (seen.has(m.index)) continue;
      seen.add(m.index);
      chips.push({ index: m.index, text: faceChipText(m), ...(multiBody && m.body ? { body: m.body } : {}), title });
    }
  });
  return { chips, missing };
}

/** "5 edges: 4 straight, 1 circle". */
export function chipsSummary(chips: Chip[], noun: "edge" | "face"): string {
  if (!chips.length) return `no ${noun}s`;
  const kinds = new Map<string, number>();
  for (const c of chips) {
    const k = c.text.split(" · ")[0].toLowerCase();
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  const head = `${chips.length} ${noun}${chips.length === 1 ? "" : "s"}`;
  return kinds.size > 1 ? `${head}: ${[...kinds].map(([k, n]) => `${n} ${k}`).join(", ")}` : head;
}
