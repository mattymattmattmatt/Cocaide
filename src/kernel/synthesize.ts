// Picking: turn a clicked face or edge into a selector. A candidate is kept
// only if running it selects exactly what was clicked, so a pick never
// produces a selector that means something else. Candidates are tried from
// the most robust to the most specific: "the largest face facing +Z" survives
// a thickness change, "the face at offset 6" does not.
//
// Pure: works on FaceInfo / EdgeInfo, so it runs on either side of the worker.

import type { EdgeSelector, FaceSelector, Vec3 } from "../doc/types";
import { selectEdges, selectFaces } from "./selectors";
import type { EdgeInfo, FaceInfo } from "./topology";

export type Synthesis<T> = { ok: true; selector: T } | { ok: false; error: string };

export function faceSelectorFor(faces: FaceInfo[], index: number): Synthesis<FaceSelector> {
  const f = faces[index];
  if (!f) return { ok: false, error: `no face ${index}` };
  const candidates: FaceSelector[] = [];
  if (f.type === "plane" && f.normal) {
    const normal = clean(f.normal);
    const offset = cleanScalar(f.offset ?? 0);
    candidates.push(
      { type: "planar", normal, pick: "largest" },
      { type: "planar", normal, pick: "smallest" },
      { type: "planar", normal, offset, pick: "largest" },
      { type: "planar", normal, offset, pick: "smallest" },
      { type: "planar", normal, near: clean3(f.centroid), pick: "all" },
    );
  } else if (f.type === "cylinder" && f.cylinder) {
    const radius = cleanScalar(f.cylinder.radius);
    const axis = clean(f.cylinder.axis);
    candidates.push(
      { type: "cylindrical", radius, pick: "largest" },
      { type: "cylindrical", radius, axis, pick: "largest" },
      { type: "cylindrical", radius, axis, pick: "smallest" },
      { type: "cylindrical", radius, near: clean3(f.centroid), pick: "all" },
    );
  } else {
    return { ok: false, error: `a ${f.type === "other" ? "freeform" : f.type} face cannot be selected yet; pick a flat or cylindrical face` };
  }
  // In a part of several bodies the selector names the face's body: it keeps meaning this face when other bodies change.
  for (const c of f.body ? candidates.map((x) => ({ ...x, body: f.body })) : candidates) {
    const r = selectFaces(faces, c);
    if (!r.tie && r.matches.length === 1 && r.matches[0].index === index) return { ok: true, selector: c };
  }
  return { ok: false, error: "no selector picks out this face alone (another face matches it exactly)" };
}

/**
 * One selector per picked face, in the order they were picked (a face picked
 * twice counts once), for features that take a list of faces (shell, draft).
 * Each is faceSelectorFor's: it finds that face alone, and the most robust
 * selector that does is kept.
 */
export function facesSelectorFor(faces: FaceInfo[], indices: number[]): Synthesis<FaceSelector[]> {
  const want = [...new Set(indices)];
  if (want.length === 0) return { ok: false, error: "no faces picked" };
  const out: FaceSelector[] = [];
  for (const i of want) {
    const s = faceSelectorFor(faces, i);
    if (!s.ok) return { ok: false, error: want.length === 1 ? s.error : `face ${out.length + 1} of ${want.length}: ${s.error}` };
    out.push(s.selector);
  }
  return { ok: true, selector: out };
}

export function edgeSelectorFor(edges: EdgeInfo[], faces: FaceInfo[], index: number): Synthesis<EdgeSelector> {
  const e = edges[index];
  if (!e) return { ok: false, error: `no edge ${index}` };
  if (e.seam) return { ok: false, error: "that is a seam on a curved face, not a real edge" };
  const faceSels = e.faces.map((fi) => faceSelectorFor(faces, fi)).filter((s): s is { ok: true; selector: FaceSelector } => s.ok).map((s) => s.selector);
  const candidates: EdgeSelector[] = [];
  const planarFaces = e.faces.filter((fi) => faces[fi]?.type === "plane");
  const onPlanar = planarFaces.map((fi) => faceSelectorFor(faces, fi)).filter((s) => s.ok).map((s) => (s as { selector: FaceSelector }).selector);

  if (e.kind === "circle") {
    const radius = cleanScalar(e.radius!);
    for (const on of onPlanar) candidates.push({ type: "edge", kind: "circle", radius, onFace: on, pick: "all" });
    candidates.push({ type: "edge", kind: "circle", radius, pick: "all" });
  }
  if (faceSels.length === 2) {
    candidates.push({ type: "edge", between: [faceSels[0], faceSels[1]], pick: "all" });
    if (e.kind !== "other") candidates.push({ type: "edge", kind: e.kind, between: [faceSels[0], faceSels[1]], pick: "all" });
  }
  if (e.kind === "line") {
    const direction = clean(e.direction!);
    for (const on of faceSels) candidates.push({ type: "edge", kind: "line", direction, onFace: on, length: cleanScalar(e.length), pick: "all" });
    candidates.push({ type: "edge", kind: "line", direction, length: cleanScalar(e.length), pick: "all" });
  }
  for (const on of faceSels) {
    candidates.push({ type: "edge", onFace: on, pick: "longest" }, { type: "edge", onFace: on, pick: "shortest" });
  }
  const near = clean3(e.centroid);
  if (e.kind === "circle") candidates.push({ type: "edge", kind: "circle", radius: cleanScalar(e.radius!), near, pick: "all" });
  if (e.kind === "line") candidates.push({ type: "edge", kind: "line", direction: clean(e.direction!), near, pick: "all" });
  candidates.push({ type: "edge", near, pick: "all" });
  for (const c of e.body ? candidates.map((x) => ({ ...x, body: e.body })) : candidates) {
    const r = selectEdges(edges, faces, c);
    if (!r.error && !r.tie && r.matches.length === 1 && r.matches[0].index === index) return { ok: true, selector: c };
  }
  return { ok: false, error: "no selector picks out this edge alone" };
}

/**
 * Selector(s) for a set of picked edges. One selector that matches exactly
 * the set is preferred ("every edge of the top face"); otherwise one selector
 * per edge.
 */
export function edgesSelectorFor(edges: EdgeInfo[], faces: FaceInfo[], indices: number[]): Synthesis<EdgeSelector | EdgeSelector[]> {
  const want = [...new Set(indices)].sort((a, b) => a - b);
  if (want.length === 0) return { ok: false, error: "no edges picked" };
  if (want.length === 1) return edgeSelectorFor(edges, faces, want[0]);
  const same = (sel: EdgeSelector) => {
    const r = selectEdges(edges, faces, sel);
    if (r.error || r.tie) return false;
    const got = r.matches.map((m) => m.index).sort((a, b) => a - b);
    return got.length === want.length && got.every((v, i) => v === want[i]);
  };
  const picked = want.map((i) => edges[i]);
  const group: EdgeSelector[] = [];
  const kinds = new Set(picked.map((e) => e.kind));
  const kind = kinds.size === 1 ? picked[0].kind : undefined;
  // Shared face.
  const shared = picked[0].faces.filter((fi) => picked.every((e) => e.faces.includes(fi)));
  for (const fi of shared) {
    const fs = faceSelectorFor(faces, fi);
    if (!fs.ok) continue;
    group.push({ type: "edge", onFace: fs.selector, pick: "all" });
    if (kind && kind !== "other") group.push({ type: "edge", kind, onFace: fs.selector, pick: "all" });
  }
  // Shared direction (parallel straight edges).
  if (kind === "line") {
    const d = picked[0].direction!;
    if (picked.every((e) => Math.abs(dot(e.direction!, d)) > 1 - 1e-9)) {
      group.push({ type: "edge", kind: "line", direction: clean(d), pick: "all" });
      const lengths = new Set(picked.map((e) => cleanScalar(e.length)));
      if (lengths.size === 1) group.push({ type: "edge", kind: "line", direction: clean(d), length: [...lengths][0], pick: "all" });
    }
  }
  // Shared circle radius.
  if (kind === "circle") {
    const radii = new Set(picked.map((e) => cleanScalar(e.radius!)));
    if (radii.size === 1) group.push({ type: "edge", kind: "circle", radius: [...radii][0], pick: "all" });
  }
  for (const c of group) if (same(c)) return { ok: true, selector: c };

  const each: EdgeSelector[] = [];
  for (const i of want) {
    const s = edgeSelectorFor(edges, faces, i);
    if (!s.ok) return { ok: false, error: `edge ${i}: ${s.error}` };
    each.push(s.selector);
  }
  return { ok: true, selector: each };
}

/** A point with document-friendly precision. */
function clean3(v: Vec3): Vec3 {
  return v.map((x) => Math.round(x * 1e6) / 1e6 + 0) as Vec3;
}

/** Snap a direction to clean numbers so the saved document reads well. */
function clean(v: Vec3): Vec3 {
  const l = Math.hypot(...v);
  return v.map((x) => cleanScalar(x / l)) as Vec3;
}

function cleanScalar(x: number): number {
  const r = Math.round(x * 1e9) / 1e9;
  return Object.is(r, -0) ? 0 : r;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
