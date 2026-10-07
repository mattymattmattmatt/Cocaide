// Selector health: does each selector still pick exactly what it should, and
// how close is it to picking something else? A selector that passes today can
// flip after a parameter change when it chooses the largest of two faces of
// nearly equal area, or picks by position. validate reports both.

import type { EdgeSelector, FaceSelector } from "../doc/types";
import { validateDocument } from "../doc/validate";
import { describeEdges, describeFaces, rebuild, scoped, selectEdges, selectFaces, type OC } from "../kernel";

export interface SelectorHealth {
  feature: string;
  /** Field path of the selector: "face", "edges", "edges[1]". */
  path: string;
  /** Faces or edges it picks on the body the feature runs on. */
  matched: number;
  ok: boolean;
  /** A reason the selector is fragile, or why it fails. */
  note?: string;
}

/** A runner-up this close (by area or length) to the pick is reported. */
const CLOSE = 0.8;

export function selectorHealth(doc: unknown, oc: OC): SelectorHealth[] {
  const v = validateDocument(doc);
  const out: SelectorHealth[] = [];
  const raw = (doc as { features: unknown[] }).features;
  v.features.forEach((vf, i) => {
    const f = vf.feature;
    if (!f || f.suppressed) return;
    let selectors: { path: string; face?: FaceSelector; edge?: EdgeSelector }[] = [];
    if (f.op === "hole") selectors = [{ path: "face", face: f.face }];
    else if (f.op === "fillet" || f.op === "chamfer") {
      selectors = Array.isArray(f.edges)
        ? f.edges.map((edge, k) => ({ path: `edges[${k}]`, edge }))
        : [{ path: "edges", edge: f.edges }];
    }
    if (selectors.length === 0) return;
    const before = rebuild({ ...(doc as object), features: raw.slice(0, i) }, oc);
    try {
      const body = before.solid;
      if (!body) {
        for (const s of selectors) out.push({ feature: f.id, path: s.path, matched: 0, ok: false, note: "there is no body before this feature" });
        return;
      }
      scoped((sc) => {
        const faces = describeFaces(oc, sc, body);
        const edges = describeEdges(oc, sc, body, faces.faces).infos;
        for (const s of selectors) {
          if (s.face) {
            const sel = selectFaces(faces.infos, s.face);
            const h: SelectorHealth = { feature: f.id, path: s.path, matched: sel.matches.length, ok: sel.matches.length === 1 && !sel.tie };
            if (sel.tie) h.note = `${sel.matches.length} faces tie for ${sel.tie}`;
            else if (sel.matches.length === 0) h.note = "matches no face";
            else if (s.face.near) h.note = "picks by position (near); moving geometry can change the face it picks";
            else if (s.face.pick !== "all") {
              const candidates = selectFaces(faces.infos, { ...s.face, pick: "all" }).matches.map((m) => m.area).sort((a, b) => b - a);
              const ratio = s.face.pick === "largest" ? candidates[1] / candidates[0] : candidates[candidates.length - 1] / candidates[candidates.length - 2];
              if (candidates.length > 1 && ratio > CLOSE) {
                h.note = `the next ${s.face.pick === "largest" ? "largest" : "smallest"} matching face is ${Math.round(ratio * 100)}% of its area; a size change could swap them`;
              }
            }
            out.push(h);
          } else if (s.edge) {
            const sel = selectEdges(edges, faces.infos, s.edge, s.path);
            const h: SelectorHealth = { feature: f.id, path: s.path, matched: sel.matches.length, ok: !sel.error && !sel.tie && sel.matches.length > 0 };
            if (sel.error) h.note = sel.error;
            else if (sel.tie) h.note = `${sel.matches.length} edges tie for ${sel.tie}`;
            else if (sel.matches.length === 0) h.note = "matches no edge";
            else if (s.edge.near) h.note = "picks by position (near); moving geometry can change the edge it picks";
            out.push(h);
          }
        }
      });
    } finally {
      before.dispose();
    }
  });
  return out;
}
