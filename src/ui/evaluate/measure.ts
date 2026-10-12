// The Measure tool's arithmetic: what CAD users read off one or two picked
// things (faces, edges, vertices, planes, axes, points). Everything that can
// be worked out from the rebuild's plain face and edge data is done here; the
// one thing that needs the B-rep, the minimum distance between two shapes,
// comes from the kernel (src/kernel/evaluate.ts) and is passed in.
//
// Pure: Vitest covers it in node.

import type { Vec3 } from "../../doc/types";
import { DEFAULT_DATUMS, type Datum } from "../../features/datum";
import { add3, cross3, dot3, len3, normalize3, scale3, sub3 } from "../../geom/vec";
import type { MeasureRef } from "../../kernel/evaluate";
import type { EdgeInfo, FaceInfo } from "../../kernel/topology";
import { DEFAULT_DATUM_LABEL, EMPTY_SELECTION, fmt, only, pickInto, selectionSize, vertexPoint, type PickTarget, type Selection } from "../model/selection";

/** One picked thing, with what the rebuild knows about it. */
export type MeasureItem =
  | { kind: "face"; index: number; face: FaceInfo }
  | { kind: "edge"; index: number; edge: EdgeInfo }
  | { kind: "vertex"; at: Vec3 }
  | { kind: "datum"; id: string; datum: Datum };

export type Unit = "mm" | "mm²" | "°" | "";

/** A line of the results: a number with its unit (copied as "12.5 mm"), or a description. */
export interface MeasureRow {
  key: string;
  label: string;
  value?: number;
  unit?: Unit;
  /** XYZ rows: three numbers. */
  xyz?: Vec3;
  text?: string;
}

export interface MeasureResult {
  /** "Plate top face", "Edge", "2 faces"… */
  title: string;
  rows: MeasureRow[];
  /** What to draw in the view: the measured line (with its label), and points. */
  line?: { from: Vec3; to: Vec3; label: string };
  points: Vec3[];
}

/** The things selected, in order (faces, edges, vertices, then planes/axes/points), with their data. Unknown indices are left out. */
export function measureItems(sel: Selection, faces: FaceInfo[], edges: EdgeInfo[], datums: Readonly<Record<string, Datum>> = {}): MeasureItem[] {
  const out: MeasureItem[] = [];
  for (const i of sel.faces) if (faces[i]) out.push({ kind: "face", index: i, face: faces[i] });
  for (const i of sel.edges) if (edges[i]) out.push({ kind: "edge", index: i, edge: edges[i] });
  for (const v of sel.vertices ?? []) {
    const at = vertexPoint(v, edges);
    if (at) out.push({ kind: "vertex", at });
  }
  for (const id of sel.datums ?? []) {
    const d = Object.hasOwn(DEFAULT_DATUMS, id) ? DEFAULT_DATUMS[id] : Object.hasOwn(datums, id) ? datums[id] : undefined;
    if (d) out.push({ kind: "datum", id, datum: d });
  }
  return out;
}

/** The item as the kernel measures it. */
export function kernelRef(item: MeasureItem): MeasureRef {
  switch (item.kind) {
    case "face":
      return { kind: "face", index: item.index };
    case "edge":
      return { kind: "edge", index: item.index };
    case "vertex":
      return { kind: "point", at: item.at };
    case "datum": {
      const d = item.datum;
      return d.kind === "plane" ? { kind: "plane", origin: d.origin, normal: d.normal } : d.kind === "axis" ? { kind: "axis", origin: d.origin, direction: d.direction } : { kind: "point", at: d.at };
    }
  }
}

/** A plane the item is, if it is one: a flat face or a datum plane. */
export function planeOf(item: MeasureItem): { point: Vec3; normal: Vec3 } | null {
  if (item.kind === "face" && item.face.type === "plane" && item.face.normal && item.face.point) return { point: item.face.point, normal: item.face.normal };
  if (item.kind === "datum" && item.datum.kind === "plane") return { point: item.datum.origin, normal: item.datum.normal };
  return null;
}

/** A line the item is or has: a straight edge, a datum axis, a round face's or circular edge's axis. */
export function lineOf(item: MeasureItem): { point: Vec3; direction: Vec3; axis: boolean } | null {
  if (item.kind === "edge" && item.edge.kind === "line" && item.edge.direction) return { point: item.edge.start, direction: item.edge.direction, axis: false };
  if (item.kind === "edge" && item.edge.kind === "circle" && item.edge.center && item.edge.axis) return { point: item.edge.center, direction: item.edge.axis, axis: true };
  if (item.kind === "face" && item.face.cylinder) return { point: item.face.cylinder.origin, direction: item.face.cylinder.axis, axis: true };
  if (item.kind === "datum" && item.datum.kind === "axis") return { point: item.datum.origin, direction: item.datum.direction, axis: true };
  return null;
}

/** Is the item round (a cylinder, a circle or arc)? Then centre-to-centre distances mean something. */
export function isRound(item: MeasureItem): boolean {
  return (item.kind === "face" && !!item.face.cylinder) || (item.kind === "edge" && item.edge.kind === "circle");
}

/** The item's centre: a point (vertex, point, circle centre) or a line (a round face's axis, a datum axis). */
export function centreOf(item: MeasureItem): { point: Vec3 } | { line: { point: Vec3; direction: Vec3 } } | null {
  if (item.kind === "vertex") return { point: item.at };
  if (item.kind === "datum" && item.datum.kind === "point") return { point: item.datum.at };
  if (item.kind === "edge" && item.edge.kind === "circle" && item.edge.center) return { point: item.edge.center };
  if (item.kind === "face" && item.face.cylinder) {
    const c = item.face.cylinder;
    // The point on the axis level with the middle of the face.
    const mid = (c.axial[0] + c.axial[1]) / 2;
    return { line: { point: add3(c.origin, scale3(c.axis, mid)), direction: c.axis } };
  }
  if (item.kind === "datum" && item.datum.kind === "axis") return { line: { point: item.datum.origin, direction: item.datum.direction } };
  return null;
}

const PARALLEL = 1e-9;

/** Closest points between two centres (points or lines): the centre-to-centre distance and where it runs. */
export function centreDistance(
  a: { point: Vec3 } | { line: { point: Vec3; direction: Vec3 } },
  b: { point: Vec3 } | { line: { point: Vec3; direction: Vec3 } },
): { distance: number; from: Vec3; to: Vec3 } {
  const onLine = (p: Vec3, l: { point: Vec3; direction: Vec3 }) => {
    const d = normalize3(l.direction);
    return add3(l.point, scale3(d, dot3(sub3(p, l.point), d)));
  };
  if ("point" in a && "point" in b) return { distance: len3(sub3(b.point, a.point)), from: a.point, to: b.point };
  if ("point" in a && "line" in b) {
    const to = onLine(a.point, b.line);
    return { distance: len3(sub3(to, a.point)), from: a.point, to };
  }
  if ("line" in a && "point" in b) {
    const from = onLine(b.point, a.line);
    return { distance: len3(sub3(b.point, from)), from, to: b.point };
  }
  // Two lines: parallel ones from the first's point straight across; others along their common perpendicular.
  const la = (a as { line: { point: Vec3; direction: Vec3 } }).line;
  const lb = (b as { line: { point: Vec3; direction: Vec3 } }).line;
  const u = normalize3(la.direction);
  const v = normalize3(lb.direction);
  const n = cross3(u, v);
  if (len3(n) < PARALLEL) {
    const to = onLine(la.point, lb);
    return { distance: len3(sub3(to, la.point)), from: la.point, to };
  }
  const w = sub3(la.point, lb.point);
  const b2 = dot3(u, v);
  const d = dot3(u, w);
  const e = dot3(v, w);
  const den = 1 - b2 * b2;
  const s = (b2 * e - d) / den;
  const t = (e - b2 * d) / den;
  const from = add3(la.point, scale3(u, s));
  const to = add3(lb.point, scale3(v, t));
  return { distance: len3(sub3(to, from)), from, to };
}

/** The angle between two directions, 0..180°. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const c = dot3(normalize3(a), normalize3(b));
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}

/** The name of one item, for the panel's title. */
export function itemName(item: MeasureItem): string {
  switch (item.kind) {
    case "face":
      return item.face.type === "plane" ? "flat face" : item.face.type === "cylinder" ? (item.face.cylinder?.concave ? "hole wall" : "round face") : item.face.type === "cone" ? "conical face" : "face";
    case "edge":
      return item.edge.kind === "line" ? "straight edge" : item.edge.kind === "circle" ? (isFullCircle(item.edge) ? "circular edge" : "arc edge") : "curved edge";
    case "vertex":
      return "vertex";
    case "datum":
      return Object.hasOwn(DEFAULT_DATUM_LABEL, item.id) ? DEFAULT_DATUM_LABEL[item.id] : `${item.id} (${item.datum.kind})`;
  }
}

function isFullCircle(e: EdgeInfo): boolean {
  return len3(sub3(e.start, e.end)) < 1e-6;
}

/** The rows for one item on its own. */
export function singleRows(item: MeasureItem): MeasureRow[] {
  switch (item.kind) {
    case "face": {
      const f = item.face;
      const rows: MeasureRow[] = [];
      if (f.cylinder) {
        rows.push({ key: "diameter", label: "Diameter", value: 2 * f.cylinder.radius, unit: "mm" }, { key: "radius", label: "Radius", value: f.cylinder.radius, unit: "mm" });
        rows.push({ key: "axis", label: "Axis", xyz: f.cylinder.axis });
      }
      rows.push({ key: "area", label: "Area", value: f.area, unit: "mm²" });
      if (f.type === "plane" && f.normal) rows.push({ key: "normal", label: "Normal", xyz: f.normal });
      rows.push({ key: "centroid", label: "Centroid", xyz: f.centroid });
      return rows;
    }
    case "edge": {
      const e = item.edge;
      const rows: MeasureRow[] = [];
      if (e.kind === "circle" && e.radius !== undefined) {
        rows.push({ key: "diameter", label: "Diameter", value: 2 * e.radius, unit: "mm" }, { key: "radius", label: "Radius", value: e.radius, unit: "mm" });
        if (e.center) rows.push({ key: "center", label: "Centre", xyz: e.center });
      }
      rows.push({ key: "length", label: e.kind === "circle" && !isFullCircle(e) ? "Arc length" : "Length", value: e.length, unit: "mm" });
      if (e.kind === "line" && e.direction) rows.push({ key: "direction", label: "Direction", xyz: e.direction });
      if (!isFullCircle(e)) rows.push({ key: "start", label: "Start", xyz: e.start }, { key: "end", label: "End", xyz: e.end });
      return rows;
    }
    case "vertex":
      return [{ key: "point", label: "Point", xyz: item.at }];
    case "datum": {
      const d = item.datum;
      if (d.kind === "plane") return [{ key: "origin", label: "Origin", xyz: d.origin }, { key: "normal", label: "Normal", xyz: d.normal }];
      if (d.kind === "axis") return [{ key: "origin", label: "Through", xyz: d.origin }, { key: "direction", label: "Direction", xyz: d.direction }];
      return [{ key: "point", label: "Point", xyz: d.at }];
    }
  }
}

/** The rows for two items together. `closest` is the kernel's minimum distance, when it has answered. */
export function pairRows(a: MeasureItem, b: MeasureItem, closest: { distance: number; a: Vec3; b: Vec3 } | null): { rows: MeasureRow[]; line?: { from: Vec3; to: Vec3; label: string } } {
  const rows: MeasureRow[] = [];
  let line: { from: Vec3; to: Vec3; label: string } | undefined;
  const pa = planeOf(a);
  const pb = planeOf(b);
  const la = lineOf(a);
  const lb = lineOf(b);

  // Parallel planes: the distance between them along the normal (a plate's thickness).
  if (pa && pb && Math.abs(Math.abs(dot3(normalize3(pa.normal), normalize3(pb.normal))) - 1) < 1e-9) {
    const n = normalize3(pa.normal);
    const d = Math.abs(dot3(sub3(pb.point, pa.point), n));
    rows.push({ key: "normal", label: "Normal distance", value: d, unit: "mm" });
    const from = closest?.a ?? pa.point;
    line = { from, to: add3(from, scale3(n, dot3(sub3(pb.point, from), n))), label: `${fmt(d)} mm` };
  }

  // Round things: centre to centre.
  const ca = centreOf(a);
  const cb = centreOf(b);
  if (ca && cb && (isRound(a) || isRound(b))) {
    const c = centreDistance(ca, cb);
    rows.push({ key: "centre", label: "Centre distance", value: c.distance, unit: "mm" });
    if (!line && c.distance > 1e-9) line = { from: c.from, to: c.to, label: `${fmt(c.distance)} mm (centres)` };
  }

  if (closest) {
    rows.push({ key: "distance", label: "Minimum distance", value: closest.distance, unit: "mm" });
    const d = sub3(closest.b, closest.a);
    rows.push({ key: "dx", label: "dX", value: Math.abs(d[0]), unit: "mm" }, { key: "dy", label: "dY", value: Math.abs(d[1]), unit: "mm" }, { key: "dz", label: "dZ", value: Math.abs(d[2]), unit: "mm" });
    if (!line && closest.distance > 1e-9) line = { from: closest.a, to: closest.b, label: `${fmt(closest.distance)} mm` };
  }

  // Angles: two planes (between their normals), two lines (0–90°: lines have no direction), a plane and a line.
  if (pa && pb) rows.push({ key: "angle", label: "Angle", value: angleBetween(pa.normal, pb.normal), unit: "°" });
  else if (la && lb) {
    const t = angleBetween(la.direction, lb.direction);
    rows.push({ key: "angle", label: "Angle", value: Math.min(t, 180 - t), unit: "°" });
  } else if ((pa && lb) || (la && pb)) {
    const p = (pa ?? pb)!;
    const l = (la ?? lb)!;
    const t = angleBetween(p.normal, l.direction);
    rows.push({ key: "angle", label: "Angle", value: Math.abs(90 - Math.min(t, 180 - t)), unit: "°" });
  }
  return { rows, line };
}

/** Everything the panel shows for what is picked. `closest`: the kernel's answer for exactly two things. */
export function measure(items: MeasureItem[], closest: { distance: number; a: Vec3; b: Vec3 } | null = null): MeasureResult {
  if (items.length === 0) return { title: "Nothing picked", rows: [], points: [] };
  if (items.length === 1) {
    const it = items[0];
    return { title: cap(itemName(it)), rows: singleRows(it), points: it.kind === "vertex" ? [it.at] : it.kind === "datum" && it.datum.kind === "point" ? [it.datum.at] : [] };
  }
  if (items.length === 2) {
    const { rows, line } = pairRows(items[0], items[1], closest);
    // What each one is, below what they are together: the usual lengths and areas.
    const own = (it: MeasureItem, n: 1 | 2): MeasureRow[] =>
      singleRows(it)
        .filter((r) => ["diameter", "length", "area"].includes(r.key))
        .map((r) => ({ ...r, key: `${r.key}${n}`, label: `${r.label} (${n === 1 ? "first" : "second"})` }));
    return { title: `${cap(itemName(items[0]))} to ${itemName(items[1])}`, rows: [...rows, ...own(items[0], 1), ...own(items[1], 2)], line, points: line ? [line.from, line.to] : [] };
  }
  // More: totals.
  const faces = items.filter((i): i is Extract<MeasureItem, { kind: "face" }> => i.kind === "face");
  const edges = items.filter((i): i is Extract<MeasureItem, { kind: "edge" }> => i.kind === "edge");
  const rows: MeasureRow[] = [];
  if (faces.length) rows.push({ key: "area", label: `Total area (${faces.length} faces)`, value: faces.reduce((s, f) => s + f.face.area, 0), unit: "mm²" });
  if (edges.length) rows.push({ key: "length", label: `Total length (${edges.length} edges)`, value: edges.reduce((s, e) => s + e.edge.length, 0), unit: "mm" });
  if (!rows.length) rows.push({ key: "note", label: "Pick two", text: "Pick two things for the distance between them" });
  return { title: `${items.length} things`, rows, points: [] };
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** A row as copied: "12.5 mm", "30°", "X 10, Y -5, Z 6". */
export function rowText(r: MeasureRow): string {
  if (r.xyz) return `X ${fmt(r.xyz[0])}, Y ${fmt(r.xyz[1])}, Z ${fmt(r.xyz[2])}`;
  if (r.value !== undefined) return `${fmt(r.value)}${r.unit === "°" ? "°" : r.unit ? ` ${r.unit}` : ""}`;
  return r.text ?? "";
}

/**
 * A click while measuring: it adds to what is picked (no Ctrl needed), or
 * takes it out again; a third thing starts a new measurement with just it;
 * empty space clears.
 */
export function measurePick(sel: Selection, target: PickTarget | null): Selection {
  if (!target) return EMPTY_SELECTION;
  const next = pickInto(sel, target, true);
  return selectionSize(next) > 2 ? only(target) : next;
}
