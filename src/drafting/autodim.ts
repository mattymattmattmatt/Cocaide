// The auto-dimension engine v2 (Phase Q): what New drawing (and "Auto-
// dimension view") puts on a part's views, from its features and their
// design intent rather than from every edge:
//
// - the overall sizes once: in the plan view (the one the holes are seen in)
//   its length and width, a round part's diameter instead; the height in the
//   elevation; a weldment's on the front and side;
// - each kind of hole called out once from the Hole Wizard (alike holes of
//   several features together, "4×"), a circular pattern "EQ SP ON PCD";
// - hole and feature positions from the part's datums (the outline's left
//   and bottom edges), or from each other when they sit symmetric about the
//   part's middle; few positions as dimensions stacked outward, many as an
//   ordinate set, an equally spaced row once as "n× pitch (= total)";
// - other circles' diameters, pockets' and slots' sizes, corner radii and
//   fillets once with TYP, chamfers as "C1" / "1 × 45°";
// - no dimension twice (across views too), none to a hidden line;
// - centre marks and lines; datum symbols A, B, C on the primary faces; the
//   general notes block with the general tolerance.
// A weldment gets its overall sizes, its members' lengths where they differ
// from them, balloons, weld symbols and the cut list.

import type { DrawingGeometry } from "../ask/kernel";
import type { Annotation, DimensionAnnotation, DrawingView, Vec2, Vec3, ViewLook } from "../doc/types";
import type { ValidationResult } from "../doc/validate";
import * as validateModule from "../doc/validate";
import type { ProjectedEdge, ProjectedView } from "../kernel/drawingViews";
import type { Measurements } from "../kernel/measure";
import type { HoleRecord } from "../kernel/rebuild";
import { autoCenterMarks } from "./centermarks";
import { viewFrame } from "./views";

export interface AutoDimInput {
  v: ValidationResult;
  m: Measurements | null;
  geometry: DrawingGeometry | null;
  views: DrawingView[];
  /** The look each view's geometry was projected with ("front", "top" ...). */
  looks: Record<string, ViewLook>;
  id: (prefix: string) => string;
  /** The general tolerance written in the notes. */
  generalTolerance?: string;
}

export interface AutoDimResult {
  annotations: Annotation[];
  /** Views with nothing to show that the plan may leave out. */
  unneeded: string[];
}

const EPS = 1e-3;
const same = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;
const r2 = (x: number) => Math.round(x * 100) / 100;

function outlineOf(pv: ProjectedView | undefined): { min: Vec2; max: Vec2 } | null {
  if (!pv) return null;
  let min: Vec2 = [Infinity, Infinity];
  let max: Vec2 = [-Infinity, -Infinity];
  for (const e of pv.edges)
    for (const p of e.pts) {
      min = [Math.min(min[0], p[0]), Math.min(min[1], p[1])];
      max = [Math.max(max[0], p[0]), Math.max(max[1], p[1])];
    }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

function facing(axis: Vec3, look: ViewLook): boolean {
  const e = viewFrame(look).eye;
  return Math.abs(axis[0] * e[0] + axis[1] * e[1] + axis[2] * e[2]) > 0.999;
}

/** A hole's kind: alike holes (size, depth, counterbore, countersink, thread, direction) are called out together. */
export function holeSignature(h: HoleRecord): string {
  const ax = h.axis.map((x) => Math.round(Math.abs(x) * 1000) / 1000).join(",");
  return JSON.stringify([r2(h.diameter), h.through ? "thru" : r2(h.depth), h.counterbore ? [r2(h.counterbore.diameter), r2(h.counterbore.depth)] : 0, h.countersink ? [r2(h.countersink.diameter), r2(h.countersink.angle)] : 0, h.thread?.designation ?? "", ax]);
}

interface Pos {
  /** The point as a DrawingPoint ("top:chole_1/c1"). */
  ref: string;
  p: Vec2;
  /** Which group of alike features it belongs to (a linear pattern's row is dimensioned once). */
  group: string;
}

/** Every annotation New drawing puts on a part's views. */
export function autoDimension(input: AutoDimInput): AutoDimResult {
  const { v, m, geometry, views, looks, id } = input;
  const out: Annotation[] = [];
  const members = m?.members ?? [];
  const weldment = members.length > 0;
  const pvOf = (viewId: string) => geometry?.views.find((x) => x.id === viewId);
  const square = views.filter((x) => looks[x.id] && !["iso", "dimetric", "trimetric"].includes(looks[x.id]));
  const section = views.find((x) => x.kind === "section");
  const dim = (a: Omit<DimensionAnnotation, "id" | "type">) => out.push({ id: id("d"), type: "dimension", ...a } as DimensionAnnotation);
  /** What is dimensioned already, as model direction and value: no size twice. */
  const done: { along: Vec3; value: number }[] = [];
  const taken = (along: Vec3, value: number) => done.some((d) => same(d.value, value, 0.05) && Math.abs(Math.abs(d.along[0] * along[0] + d.along[1] * along[1] + d.along[2] * along[2]) - 1) < 1e-6);
  const mark = (along: Vec3, value: number) => done.push({ along, value });

  if (weldment) return { annotations: out, unneeded: [] };

  // The plan view: the square view most holes are seen end on in (else the top, else the first).
  const holes = geometry?.holes ?? [];
  const plan =
    [...square]
      .filter((x) => x.kind !== "section")
      .map((x) => ({ x, n: holes.filter((h) => facing(h.axis, looks[x.id])).reduce((t, h) => t + h.copies + 1, 0) }))
      .sort((a, b) => b.n - a.n || (a.x.id === "top" ? -1 : b.x.id === "top" ? 1 : 0))[0]?.x ?? square[0];
  if (!plan) return { annotations: out, unneeded: [] };
  const elevation = section ?? square.find((x) => x.id !== plan.id && (x.id === "front" || x.id === "top")) ?? square.find((x) => x.id !== plan.id);
  const pPv = pvOf(plan.id);
  const pO = outlineOf(pPv);
  const pF = viewFrame(looks[plan.id]);
  if (!pPv || !pO) return { annotations: out, unneeded: [] };
  const visible = pPv.edges.filter((e) => e.visible);

  // ---- overall sizes
  const w = pO.max[0] - pO.min[0];
  const h = pO.max[1] - pO.min[1];
  const outer = visible.filter((e) => e.look === "circle" && e.circle).sort((a, b) => b.circle!.r - a.circle!.r)[0];
  const round = !!outer && same(2 * outer.circle!.r, w, 0.02 * w) && same(2 * outer.circle!.r, h, 0.02 * h);
  /** Diameters given already (a turned part's in its side view), so the round view doesn't repeat them. */
  const diameters = new Set<number>();
  const usedViews = new Set<string>();
  // A round part: its diameters and steps on a side view that is not cut (a section's edges have no keys yet), else the circles.
  const side = round ? square.find((x) => x.kind !== "section" && x.id !== plan.id && !facing(outer.model?.axis ?? [0, 0, 1], looks[x.id])) : undefined;
  if (round && side) {
    usedViews.add(side.id);
    const sPv = pvOf(side.id)!;
    const sO = outlineOf(sPv)!;
    const sF = viewFrame(looks[side.id]);
    // Each round face seen from the side: its two outlines ("…/s1a", "…/s1b") apart, written Ø.
    const pairs = new Map<string, { a?: ProjectedEdge; b?: ProjectedEdge }>();
    for (const e of sPv.edges) {
      if (!e.visible || e.type !== "outline" || e.look !== "line" || e.key.startsWith("?")) continue;
      const k = e.key.slice(0, -1);
      pairs.set(k, { ...pairs.get(k), [e.key.slice(-1)]: e });
    }
    const list = [...pairs.values()].filter((x) => x.a && x.b).map((x) => ({ ...x, d: Math.abs(x.a!.pts[0][0] - x.b!.pts[0][0]) })).sort((p, q) => q.d - p.d);
    for (const x of list) {
      if (diameters.has(r2(x.d))) continue;
      diameters.add(r2(x.d));
      dim({ view: side.id, kind: "diameter", refs: [`${side.id}:e${x.a!.key}`, `${side.id}:e${x.b!.key}`] });
      mark(sF.right, x.d);
    }
    mark(pF.right, w);
    mark(pF.up, h);
    const sh = sO.max[1] - sO.min[1];
    dim({ view: side.id, from: "@bottom", to: "@top" });
    mark(sF.up, sh);
    // Its steps: each flat face across it (edge-on circles at one height), from the bottom, once. A chamfer or
    // fillet puts circles a little either side of the face: of a cluster of heights, the one most edges are at.
    const at = new Map<number, ProjectedEdge[]>();
    const sw = sO.max[0] - sO.min[0];
    // Heights the edge-on circles are at; hidden ones count (a fillet's edge on the face), seen ones carry the GeoRef.
    const makers = new Map<number, Set<string>>();
    for (const e of sPv.edges) {
      if (e.pts.length < 2) continue;
      const ys = e.pts.map((p) => p[1]);
      const xs = e.pts.map((p) => p[0]);
      if (Math.max(...ys) - Math.min(...ys) > EPS || Math.max(...xs) - Math.min(...xs) < 0.2 * sw) continue;
      const y = r2(ys[0]);
      makers.set(y, (makers.get(y) ?? new Set()).add(e.feature ?? e.key));
      if (e.visible) at.set(y, [...(at.get(y) ?? []), e]);
    }
    const heights = [...at.keys()].sort((p, q) => p - q);
    const levels = new Map<number, ProjectedEdge>();
    for (let i = 0; i < heights.length; ) {
      let j = i;
      while (j + 1 < heights.length && heights[j + 1] - heights[j] < 2.5) j++;
      const cluster = heights.slice(i, j + 1);
      const seen = cluster.filter((y) => at.has(y));
      const best = seen.sort((p, q) => (makers.get(q)?.size ?? 0) - (makers.get(p)?.size ?? 0) || p - q)[0];
      if (best === undefined) {
        i = j + 1;
        continue;
      }
      if (!cluster.some((y) => same(y, sO.min[1]) || same(y, sO.max[1]))) levels.set(best, at.get(best)!.find((e) => !e.key.startsWith("?")) ?? at.get(best)![0]);
      i = j + 1;
    }
    for (const [y, e] of [...levels].sort((p, q) => p[0] - q[0])) {
      if (taken(sF.up, y - sO.min[1])) continue;
      dim({ view: side.id, from: "@bottom", to: `${side.id}:v${e.key}.0`, direction: "vertical" });
      mark(sF.up, y - sO.min[1]);
    }
  } else if (round) {
    dim({ view: plan.id, kind: "diameter", refs: [`${plan.id}:e${outer.key}`] });
    diameters.add(r2(2 * (outer.model?.radius ?? outer.circle!.r)));
    mark(pF.right, w);
    mark(pF.up, h);
  } else {
    dim({ view: plan.id, from: "@left", to: "@right" });
    dim({ view: plan.id, from: "@bottom", to: "@top" });
    mark(pF.right, w);
    mark(pF.up, h);
  }
  if (elevation && !(round && side)) {
    const eLook = elevation.kind === "section" ? "front" : looks[elevation.id];
    const eF = viewFrame(eLook ?? "front");
    const eO = outlineOf(pvOf(elevation.kind === "section" ? "front" : elevation.id));
    if (eO) {
      const ew = eO.max[0] - eO.min[0];
      const eh = eO.max[1] - eO.min[1];
      if (!taken(eF.up, eh)) {
        dim({ view: elevation.id, from: "@bottom", to: "@top" });
        mark(eF.up, eh);
      }
      if (!taken(eF.right, ew)) {
        dim({ view: elevation.id, from: "@left", to: "@right" });
        mark(eF.right, ew);
      }
    }
  }

  // ---- holes: alike ones called out once; their centres located
  const positions: Pos[] = [];
  const groups = new Map<string, HoleRecord[]>();
  for (const hr of holes) {
    const s = holeSignature(hr);
    groups.set(s, [...(groups.get(s) ?? []), hr]);
  }
  const holeCircleKeys = new Set<string>();
  const sideViews = new Set<string>();
  for (const [sig, list] of groups) {
    const view = facing(list[0].axis, looks[plan.id]) ? plan : square.find((x) => x.kind !== "section" && facing(list[0].axis, looks[x.id]));
    if (!view) continue;
    if (view.id !== plan.id) sideViews.add(view.id);
    const total = list.reduce((t, hr) => t + hr.copies + 1, 0);
    out.push({ id: id("h"), type: "hole", view: view.id, hole: list[0].feature, ...(list.length > 1 ? { count: total } : {}) });
    const pv = pvOf(view.id);
    if (!pv) continue;
    const f = viewFrame(looks[view.id]);
    const makers = new Set(list.flatMap((hr) => [hr.feature, ...patternsOf(v, hr.feature)]));
    // A circular pattern is placed by its pitch circle (in its callout), not hole by hole.
    const circular = list.some((hr) => feats(v).some((f) => (f as { op?: string }).op === "circularPattern" && patternsOf(v, hr.feature).includes(f.id)));
    for (const e of pv.edges) {
      if (!e.visible || e.look !== "circle" || !e.circle || !e.feature || !makers.has(e.feature)) continue;
      holeCircleKeys.add(e.key);
      if (Math.abs(e.circle.r - list[0].diameter / 2) > 1e-3 && !(list[0].thread && Math.abs(e.circle.r - list[0].thread.major / 2) < 1e-3)) continue;
      if (circular || positions.some((p) => p.p[0] === e.circle!.c[0] && p.p[1] === e.circle!.c[1])) continue;
      if (view.id !== plan.id) {
        // A hole seen in a side view: its place from that view's datums.
        locate(view.id, [{ ref: `${view.id}:c${e.key}`, p: e.circle.c, group: sig }], outlineOf(pv)!, f, dim, taken, mark);
        continue;
      }
      positions.push({ ref: `${view.id}:c${e.key}`, p: e.circle.c, group: sig });
    }
  }

  // ---- other circles (a bore, a boss): their diameters; those off the part's middle located too
  const centre: Vec2 = [(pO.min[0] + pO.max[0]) / 2, (pO.min[1] + pO.max[1]) / 2];
  const holeFeatures = new Set(holes.flatMap((hr) => [hr.feature, ...patternsOf(v, hr.feature)]));
  const seenR = new Set<string>();
  const holeRadii = holes.flatMap((hr) => [hr.diameter / 2, (hr.counterbore?.diameter ?? 0) / 2, (hr.countersink?.diameter ?? 0) / 2, (hr.thread?.major ?? 0) / 2]).filter((x) => x > 0);
  for (const e of visible) {
    if (e.look !== "circle" || !e.circle || holeCircleKeys.has(e.key) || (e.feature && holeFeatures.has(e.feature))) continue;
    if (round && e === outer) continue;
    const op = (feats(v).find((f) => f.id === e.feature) as { op?: string } | undefined)?.op;
    if (op === "fillet" || op === "chamfer") continue;
    // A copy of a hole whose maker isn't recorded is still a hole.
    if (holeRadii.some((r) => same(r, e.model?.radius ?? e.circle!.r, 1e-3)) && e.feature === undefined) continue;
    const k = `${r2(e.circle.r)}`;
    if (seenR.has(k) || diameters.has(r2(2 * (e.model?.radius ?? e.circle.r)))) continue;
    seenR.add(k);
    dim({ view: plan.id, kind: "diameter", refs: [`${plan.id}:e${e.key}`] });
    if (!(same(e.circle.c[0], centre[0]) && same(e.circle.c[1], centre[1]))) positions.push({ ref: `${plan.id}:c${e.key}`, p: e.circle.c, group: `circle:${e.key}` });
  }

  // ---- pockets, slots, cut-outs: their size and place
  const body = new Set(visible.filter((e) => onOutline(e, pO)).map((e) => e.feature ?? ""));
  const byFeature = new Map<string, ProjectedEdge[]>();
  for (const e of visible) {
    if (!e.feature || body.has(e.feature) || holeFeatures.has(e.feature) || holeCircleKeys.has(e.key)) continue;
    const op = feats(v).find((x) => x.id === e.feature) as { op?: string } | undefined;
    if (op && (op.op === "fillet" || op.op === "chamfer")) continue;
    byFeature.set(e.feature, [...(byFeature.get(e.feature) ?? []), e]);
  }
  const notes: string[] = [];
  for (const [feature, edges] of byFeature) {
    if (edges.every((e) => e.look === "circle")) continue;
    const lines = edges.filter((e) => e.look === "line");
    const pts = edges.flatMap((e) => e.pts);
    const bx = { min: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))] as Vec2, max: [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))] as Vec2 };
    const arcs = edges.filter((e) => e.look === "arc" && e.circle);
    const vert = lines.filter((e) => same(e.pts[0][0], e.pts[e.pts.length - 1][0], EPS));
    const horz = lines.filter((e) => same(e.pts[0][1], e.pts[e.pts.length - 1][1], EPS));
    const left = vert.find((e) => same(e.pts[0][0], bx.min[0]));
    const right = vert.find((e) => same(e.pts[0][0], bx.max[0]));
    const bottom = horz.find((e) => same(e.pts[0][1], bx.min[1]));
    const top = horz.find((e) => same(e.pts[0][1], bx.max[1]));
    // Its width and height: between its parallel sides, or a slot's width and its ends' centres.
    if (left && right) dim({ view: plan.id, refs: [`${plan.id}:e${left.key}`, `${plan.id}:e${right.key}`] });
    if (bottom && top) dim({ view: plan.id, refs: [`${plan.id}:e${bottom.key}`, `${plan.id}:e${top.key}`] });
    if (arcs.length >= 2 && (left && right) !== (bottom && top)) {
      // A slot: the centres of its ends apart, along it.
      const [a1, a2] = arcs;
      dim({ view: plan.id, from: `${plan.id}:c${a1.key}`, to: `${plan.id}:c${a2.key}` });
    }
    // Its place: its middle, located like a hole's centre (a vertex of it when its middle is no point of it).
    const mid: Vec2 = [(bx.min[0] + bx.max[0]) / 2, (bx.min[1] + bx.max[1]) / 2];
    const sym = same(mid[0], centre[0]) && same(mid[1], centre[1]);
    if (!sym) {
      const corner = arcs.length >= 2 ? `${plan.id}:c${arcs[0].key}` : bottom ? `${plan.id}:v${bottom.key}.0` : left ? `${plan.id}:v${left.key}.0` : null;
      const cp = arcs.length >= 2 ? arcs[0].circle!.c : bottom ? lineStart(bottom) : left ? lineStart(left) : null;
      if (corner && cp) positions.push({ ref: corner, p: cp, group: `feature:${feature}` });
    }
    // A pocket's depth: written on it.
    const f = feats(v).find((x) => x.id === feature) as { op?: string; distance?: unknown; extent?: unknown } | undefined;
    if (f && f.op === "cut" && typeof f.distance === "number" && f.extent !== "throughAll") {
      const on = top ?? left ?? lines[0];
      if (on) out.push({ id: id("n"), type: "leader", view: plan.id, to: `${plan.id}:m${on.key}`, text: `↧${r2(f.distance)}` });
      notes.push("");
    }
  }

  // ---- positions from the datums (the outline's left and bottom), or from each other when symmetric
  locate(plan.id, positions, pO, pF, dim, taken, mark);

  // ---- corner radii and fillets once, TYP; chamfers
  const arcs = visible.filter((e) => e.look === "arc" && e.circle && body.has(e.feature ?? "") && onOutline(e, pO));
  const byR = new Map<number, ProjectedEdge[]>();
  for (const e of arcs) byR.set(r2(e.model?.radius ?? e.circle!.r), [...(byR.get(r2(e.model?.radius ?? e.circle!.r)) ?? []), e]);
  for (const [, list] of byR) {
    const e = list.sort((a, b) => b.circle!.c[0] - a.circle!.c[0] || b.circle!.c[1] - a.circle!.c[1])[0];
    dim({ view: plan.id, kind: "radius", refs: [`${plan.id}:e${e.key}`], ...(list.length > 1 ? { typ: true } : {}) });
  }
  for (const f of feats(v)) {
    const op = (f as { op?: string }).op;
    if (op !== "fillet" && op !== "chamfer") continue;
    let placed = false;
    for (const view of [plan, ...square.filter((x) => x !== plan && x.kind !== "section")]) {
      const pv = pvOf(view.id);
      const e = pv?.edges.find((x) => x.visible && x.feature === f.id && (op === "fillet" ? x.look === "arc" && x.circle : x.look === "line" && x.pts.length >= 2 && !same(x.pts[0][0], x.pts[1][0], EPS) && !same(x.pts[0][1], x.pts[1][1], EPS)));
      if (!e) continue;
      dim({ view: view.id, kind: op === "fillet" ? "radius" : "chamfer", refs: [`${view.id}:e${e.key}`], typ: true });
      placed = true;
      break;
    }
    if (!placed) {
      const ff = f as { radius?: unknown; distance?: unknown };
      if (op === "fillet" && typeof ff.radius === "number") notes.push(`FILLETS R${r2(ff.radius)} UNLESS OTHERWISE SHOWN.`);
      if (op === "chamfer" && typeof ff.distance === "number") notes.push(`CHAMFERS ${r2(ff.distance)} × 45° UNLESS OTHERWISE SHOWN.`);
    }
  }

  // ---- centre marks and lines
  for (const view of square) {
    if (view.kind === "section") continue;
    const pv = pvOf(view.id);
    if (pv) out.push(...autoCenterMarks(view.id, pv, () => id("c"), { hidden: view.display === "hidden" }));
  }

  // ---- datums A (the face it stands on, in the elevation), B and C (the plan's left and bottom), when anything is located from them
  const located = out.some((a) => a.type === "dimension" && typeof a.from === "string" && a.from.startsWith("@") && a.to?.includes(":"));
  if (located && !round) {
    if (elevation) out.push({ id: "datum_A", type: "datum", view: elevation.id, label: "A", on: `${elevation.id}:@bottom` });
    out.push({ id: "datum_B", type: "datum", view: plan.id, label: "B", on: `${plan.id}:@left` });
    out.push({ id: "datum_C", type: "datum", view: plan.id, label: "C", on: `${plan.id}:@bottom` });
  }

  // ---- the general notes
  const tol = input.generalTolerance;
  const lines = [
    "BREAK ALL SHARP EDGES 0.5 × 45° MAX.",
    ...(tol ? [`GENERAL TOLERANCES ${tol.startsWith("ISO") || tol.startsWith("EN") ? tol : `ISO ${tol}`}.`] : []),
    ...notes.filter(Boolean),
    "DIMENSIONS IN MILLIMETRES. DO NOT SCALE.",
  ];
  out.push({ id: "general_notes", type: "note", text: lines.join("\n"), at: [0, 0], numbered: true, title: "NOTES:" });

  const unneeded = square.filter((x) => x.kind === "projected" && x.id !== plan.id && x.id !== elevation?.id && !sideViews.has(x.id) && !usedViews.has(x.id) && !out.some((a) => "view" in a && a.view === x.id && a.type !== "centerMark" && a.type !== "centerline")).map((x) => x.id);
  return { annotations: out.filter((a) => !("view" in a) || !unneeded.includes(String(a.view))), unneeded };
}

function lineStart(e: ProjectedEdge): Vec2 {
  // The GeoRef "v<key>.0" is the line's left (then lower) end.
  const [a, b] = [e.pts[0], e.pts[e.pts.length - 1]];
  return a[0] < b[0] - 1e-9 || (Math.abs(a[0] - b[0]) <= 1e-9 && a[1] <= b[1]) ? a : b;
}

/** True when an edge lies on the view's outline box (the part's boundary seen in it). */
function onOutline(e: ProjectedEdge, o: { min: Vec2; max: Vec2 }): boolean {
  return e.pts.some((p) => same(p[0], o.min[0]) || same(p[0], o.max[0]) || same(p[1], o.min[1]) || same(p[1], o.max[1]));
}

/** The features copying this one (patterns and mirrors of it). */
function patternsOf(v: ValidationResult, feature: string): string[] {
  return feats(v)
    .filter((f) => {
      const x = f as unknown as { features?: unknown; feature?: unknown };
      return (Array.isArray(x.features) && (x.features as string[]).includes(feature)) || x.feature === feature;
    })
    .map((f) => f.id);
}

/**
 * Locates points in a view along x and y: symmetric about the part's middle
 * → centre to centre across it; else from the datum side (left, bottom):
 * up to three places each its own dimension (stacked outward), four or more
 * an ordinate set; an equally spaced row of three or more once, "n× pitch".
 */
function locate(viewId: string, positions: Pos[], o: { min: Vec2; max: Vec2 }, f: { right: Vec3; up: Vec3 }, dim: (a: Omit<DimensionAnnotation, "id" | "type">) => void, taken: (along: Vec3, value: number) => boolean, mark: (along: Vec3, value: number) => void): void {
  for (const axis of [0, 1] as const) {
    const along = axis === 0 ? f.right : f.up;
    const side = axis === 0 ? "@left" : "@bottom";
    const mid = (o.min[axis] + o.max[axis]) / 2;
    const direction = axis === 0 ? "horizontal" : "vertical";
    // One point per place along the axis.
    const placesOf = (list: Pos[]) => {
      const out: Pos[] = [];
      for (const p of [...list].sort((x, y) => x.p[axis] - y.p[axis])) if (!out.some((q) => same(q.p[axis], p.p[axis]))) out.push(p);
      return out;
    };
    // The holes together (alike or not, a bolt pattern is one), then each other feature on its own.
    const holes = positions.filter((p) => !p.group.startsWith("feature:") && !p.group.startsWith("circle:"));
    const others = positions.filter((p) => !holes.includes(p));
    const rest: Pos[] = [];
    const hp = placesOf(holes);
    const off = hp.filter((p) => !same(p.p[axis], mid));
    const symmetric = off.length > 0 && off.every((p) => hp.some((q) => same(q.p[axis], 2 * mid - p.p[axis])));
    if (symmetric) {
      // Symmetric about the part's middle: centre to centre across it (the centre lines show the symmetry).
      for (const p of off.filter((x) => x.p[axis] < mid)) {
        const q = hp.find((x) => same(x.p[axis], 2 * mid - p.p[axis]))!;
        const value = Math.abs(q.p[axis] - p.p[axis]);
        if (taken(along, value)) continue;
        dim({ view: viewId, from: p.ref, to: q.ref, direction });
        mark(along, value);
      }
    } else {
      // An equally spaced row (three or more of one group): the first from the datum, then "n× pitch".
      const groups = new Map<string, Pos[]>();
      for (const p of off) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
      for (const [, g] of groups) {
        const xs = g.map((p) => p.p[axis]);
        const steps = xs.slice(1).map((x, i) => x - xs[i]);
        if (g.length >= 3 && steps.every((st) => same(st, steps[0], 0.01))) {
          dim({ view: viewId, from: side, to: g[0].ref, direction });
          dim({ view: viewId, from: g[0].ref, to: g[1].ref, direction, count: g.length - 1, suffix: `(= ${r2(xs[xs.length - 1] - xs[0])})` });
        } else rest.push(...g);
      }
    }
    for (const p of placesOf(others)) if (!same(p.p[axis], mid) && !hp.some((q) => same(q.p[axis], p.p[axis])) && !rest.some((q) => same(q.p[axis], p.p[axis]))) rest.push(p);
    rest.sort((x, y) => x.p[axis] - y.p[axis]);
    if (rest.length >= 5) dim({ view: viewId, kind: "ordinate", origin: side, points: rest.map((p) => p.ref), direction });
    else for (const p of rest) dim({ view: viewId, from: side, to: p.ref, direction });
  }
}

/** The part's valid features themselves. */
function feats(v: ValidationResult): { id: string; op: string }[] {
  return v.features.flatMap((f) => (f.feature ? [f.feature as unknown as { id: string; op: string }] : []));
}

/**
 * Auto-dimension one view of a composed sheet (the editor's Auto Dimension
 * tool): the engine run over the sheet's views as they are, keeping what it
 * puts in `viewId` that the view hasn't already (the same points, edges,
 * hole or circle). Ids come from `nextId`.
 */
export function autoDimensionSheetView(doc: unknown, sheet: import("./compose").ComposedSheet, viewId: string, m: Measurements | null, nextId: (prefix: string) => string): Annotation[] {
  const { validateDocument } = validateModule;
  const v = validateDocument(doc);
  const sheetDoc = v.drawing?.sheets.find((s) => s.id === sheet.id);
  if (!sheetDoc) return [];
  const looks: Record<string, ViewLook> = {};
  for (const cv of sheet.views) if (cv.look !== "custom") looks[cv.id] = cv.look;
  if (!looks[viewId]) return [];
  const geometry: DrawingGeometry = {
    views: sheet.views.map((cv) => ({ id: cv.id, frame: cv.frame, edges: cv.edges, bodies: [] }) as unknown as ProjectedView),
    holes: [...sheet.points.holes.values()],
  };
  let n = 0;
  const r = autoDimension({ v, m, geometry, views: sheetDoc.views.filter((x) => x.kind !== "section"), looks, id: (p) => `${p}__${++n}`, generalTolerance: v.drawing?.generalTolerance });
  const mine = sheetDoc.annotations.filter((a) => "view" in a && a.view === viewId);
  const key = (a: Annotation) => JSON.stringify([a.type, "from" in a ? [a.from, a.to].sort() : null, "refs" in a ? a.refs : null, "hole" in a ? a.hole : null, a.type === "centerMark" ? a.at.replace(":c", ":e") : null, "points" in a ? a.points : null]);
  const have = new Set(mine.map(key));
  return r.annotations
    .filter((a) => "view" in a && a.view === viewId && a.type !== "note" && a.type !== "datum" && !have.has(key(a)))
    .map((a) => ({ ...a, id: nextId(a.type === "dimension" ? "d" : a.type === "hole" ? "h" : a.type === "centerMark" || a.type === "centerline" ? "c" : "a") }) as Annotation);
}
