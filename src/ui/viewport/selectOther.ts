// Select Other: every face (and edge) under the pointer, nearest first, by a
// name you can tell apart ("Face 7 (flat, +Z)"), so a face hidden behind
// another can be picked without turning the view; and Alt+click, which steps
// to the next face behind the one picked. Pure: the viewport hands in what
// its ray hit.

import type { EdgeInfo, FaceInfo } from "../../kernel/topology";
import { formatDirection } from "../../geom/vec";
import { fmt, type PickTarget, type Selection } from "../model/selection";

/** One thing under the pointer: a face or an edge, and how far along the ray. */
export interface UnderPointer {
  target: PickTarget & { kind: "face" | "edge" };
  distance: number;
}

/** What the ray hit, nearest first, each face and edge once (its nearest hit). */
export function underPointer(hits: readonly UnderPointer[]): UnderPointer[] {
  const seen = new Map<string, UnderPointer>();
  for (const h of hits) {
    const key = `${h.target.kind}:${h.target.index}`;
    const was = seen.get(key);
    if (!was || h.distance < was.distance) seen.set(key, h);
  }
  return [...seen.values()].sort((a, b) => a.distance - b.distance);
}

/** "Face 7 (flat, +Z)", "Face 3 (hole Ø6.6)", "Edge 12 (straight, 80 mm)": numbered from 1, as listed for people. */
export function otherLabel(t: PickTarget, faces: readonly FaceInfo[], edges: readonly EdgeInfo[]): string {
  if (t.kind === "face") {
    const f = faces[t.index];
    const of = f?.body && new Set(faces.map((x) => x.body)).size > 1 ? `, ${f.body}` : "";
    const what = !f
      ? ""
      : f.type === "plane" && f.normal
        ? `flat, ${formatDirection(f.normal)}`
        : f.type === "cylinder" && f.cylinder
          ? `${f.cylinder.concave ? "hole" : "round"} Ø${fmt(2 * f.cylinder.radius)}`
          : f.type === "cone"
            ? "conical"
            : "curved";
    return `Face ${t.index + 1}${what ? ` (${what}${of})` : ""}`;
  }
  if (t.kind === "edge") {
    const e = edges[t.index];
    const what = !e ? "" : e.kind === "line" ? `straight, ${fmt(e.length)} mm` : e.kind === "circle" ? `circle Ø${fmt(2 * (e.radius ?? 0))}` : `curved, ${fmt(e.length)} mm`;
    return `Edge ${t.index + 1}${what ? ` (${what})` : ""}`;
  }
  return t.kind === "vertex" ? "Vertex" : t.kind === "datum" ? t.id : "";
}

/**
 * Alt+click: the next face behind the one picked. With a face under the
 * pointer selected, the one behind it (round to the nearest again after the
 * last); otherwise the second nearest (the nearest is what a plain click
 * takes), or the nearest when there is only one. Null when no face is there.
 */
export function nextBehind(list: readonly UnderPointer[], selection: Selection): UnderPointer | null {
  const faces = list.filter((h) => h.target.kind === "face");
  if (!faces.length) return null;
  const at = faces.findIndex((h) => selection.faces.includes(h.target.index));
  if (at >= 0) return faces[(at + 1) % faces.length];
  return faces[Math.min(1, faces.length - 1)];
}
