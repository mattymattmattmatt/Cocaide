// Model Items (Phase Q wave Q3A): the dimensions the part was designed with,
// brought onto the sheet. Each feature's own numbers — its sketch's radii,
// diameters and lengths, an extrusion's depth, a hole (as its callout), a
// fillet's radius, a chamfer, a member's cut length — go into the first of
// the chosen views that shows the edge true size, each once on the sheet (a
// size dimensioned already, in any view, is not repeated). The layout
// engine places them. Pure: the annotations to add, without ids.

import type { RawDocument } from "../../../doc/commands";
import type { Annotation, DimensionAnnotation, HoleAnnotation, Vec3 } from "../../../doc/types";
import { validateDocument } from "../../../doc/validate";
import type { ComposedSheet, ComposedView } from "../../../drafting/compose";
import type { ProjectedEdge } from "../../../kernel/drawingViews";

export interface ModelItemsOptions {
  /** The features to take items from (default: every one). */
  features?: string[];
  /** The views to put them in, in order of preference (default: every square view on the sheet). */
  views?: string[];
  /** Sketch dimensions (radii, diameters, lengths), feature dimensions (depths, fillets, chamfers, member lengths), hole callouts. */
  sketch?: boolean;
  feature?: boolean;
  holes?: boolean;
}

export type NewItem = Omit<DimensionAnnotation, "id"> | Omit<HoleAnnotation, "id">;

export interface ModelItemsResult {
  items: NewItem[];
  /** Model dimensions that found no view showing them true size (said to the user). */
  missed: string[];
}

const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= Math.max(tol, Math.abs(b) * 1e-6);
const polyLength = (e: ProjectedEdge) => e.pts.reduce((t, p, i) => (i ? t + Math.hypot(p[0] - e.pts[i - 1][0], p[1] - e.pts[i - 1][1]) : t), 0);
const dirOf = (e: ProjectedEdge): Vec3 | null => {
  const m = e.model;
  if (!m || m.kind !== "line" || m.length < 1e-9) return null;
  return [(m.end[0] - m.start[0]) / m.length, (m.end[1] - m.start[1]) / m.length, (m.end[2] - m.start[2]) / m.length];
};
const parallel = (a: Vec3, b: Vec3) => Math.abs(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) - 1) < 1e-6;

/** The model items for a sheet: what to add, and what found no place. */
export function modelItems(doc: RawDocument, sheet: ComposedSheet, existing: Annotation[], opts: ModelItemsOptions = {}): ModelItemsResult {
  const v = validateDocument(doc);
  const want = { sketch: opts.sketch ?? true, feature: opts.feature ?? true, holes: opts.holes ?? true };
  const views = (opts.views ?? sheet.views.filter((x) => x.square && x.kind !== "detail").map((x) => x.id)).map((id) => sheet.views.find((x) => x.id === id)).filter((x): x is ComposedView => !!x && x.square && !!x.box);
  const items: NewItem[] = [];
  const missed: string[] = [];
  // What is on the sheet already: sizes by model direction, radial sizes, hole callouts, the edges dimensioned.
  const lengths: { along: Vec3; value: number }[] = [];
  const radial = new Set<string>();
  const holes = new Set<string>();
  const usedRefs = new Set<string>();
  for (const a of existing) {
    if (a.type === "hole") holes.add(a.hole);
    if (a.type === "dimension") for (const r of a.refs ?? []) usedRefs.add(r.split(":")[1] ?? r);
  }
  for (const a of sheet.annotations) {
    if (a.type !== "dimension" || a.value === undefined) continue;
    if (a.along) lengths.push({ along: a.along, value: a.value });
  }
  for (const a of existing) {
    if (a.type !== "dimension" || (a.kind !== "diameter" && a.kind !== "radius")) continue;
    const said = sheet.annotations.find((x) => x.id === a.id);
    if (said?.value !== undefined) radial.add(`${a.kind === "radius" ? "R" : "Ø"}${Math.round(said.value * 1000) / 1000}`);
  }
  const lengthTaken = (along: Vec3, value: number) => lengths.some((d) => near(d.value, value, 0.01) && parallel(d.along, along));
  const radialTaken = (key: string) => radial.has(key);

  /** The first chosen view with an edge that passes, visible and true size. */
  const find = (ok: (e: ProjectedEdge, cv: ComposedView) => boolean): { cv: ComposedView; e: ProjectedEdge } | null => {
    for (const cv of views) {
      const e = cv.edges.find((x) => x.visible && !usedRefs.has(x.key) && ok(x, cv));
      if (e) return { cv, e };
    }
    return null;
  };
  const trueLength = (e: ProjectedEdge) => !!e.model && e.look === "line" && near(polyLength(e), e.model.length, 0.01);
  const endOn = (e: ProjectedEdge) => e.look === "circle" || e.look === "arc";
  const radiusOf = (e: ProjectedEdge) => e.model?.radius ?? e.circle?.r ?? 0;
  const ref = (cv: ComposedView, e: ProjectedEdge) => `${cv.id}:e${e.key}`;

  const addLength = (feature: string, value: number, what: string) => {
    const hit = find((e) => e.feature === feature && trueLength(e) && near(e.model!.length, value, 0.01) && !lengthTaken(dirOf(e)!, value));
    if (!hit) return missed.push(`${feature}: ${what} ${value}`);
    const along = dirOf(hit.e)!;
    lengths.push({ along, value });
    usedRefs.add(hit.e.key);
    items.push({ type: "dimension", view: hit.cv.id, refs: [ref(hit.cv, hit.e)] });
  };
  const addRadial = (feature: string, r: number, kind: "diameter" | "radius", what: string, typ = false) => {
    const key = `${kind === "radius" ? "R" : "Ø"}${Math.round((kind === "radius" ? r : 2 * r) * 1000) / 1000}`;
    if (radialTaken(`${feature}|${key}`) || radialTaken(key)) return;
    // The feature's own circle; else one of that size another feature took over (a chamfered rim, a hole through two extrusions).
    const hit = find((e) => e.feature === feature && endOn(e) && near(radiusOf(e), r, 0.01)) ?? find((e) => endOn(e) && near(radiusOf(e), r, 0.01));
    if (!hit) return missed.push(`${feature}: ${what}`);
    radial.add(`${feature}|${key}`);
    usedRefs.add(hit.e.key);
    const many = typ && hit.cv.edges.filter((e) => e.visible && e.feature === feature && endOn(e) && near(radiusOf(e), r, 0.01)).length > 1;
    items.push({ type: "dimension", view: hit.cv.id, kind: hit.e.look === "arc" && kind === "diameter" ? "radius" : kind, refs: [ref(hit.cv, hit.e)], ...(many ? { typ: true } : {}) });
  };

  const scope = opts.features ? new Set(opts.features) : null;
  const sketches = new Map(v.features.flatMap((f) => (f.feature?.op === "sketch" ? [[f.feature.id, f.feature] as const] : [])));
  /** Which feature's edges a sketch's entities became (the extrude or cut that uses it). */
  for (const vf of v.features) {
    const f = vf.feature as unknown as Record<string, unknown> & { id: string; op: string; suppressed?: boolean };
    if (!f || f.suppressed) continue;
    const id = f.id;
    if (scope && !scope.has(id) && !(typeof f.sketch === "string" && scope.has(f.sketch))) continue;
    if (f.op === "extrude" || f.op === "cut" || f.op === "revolve") {
      const sk = typeof f.sketch === "string" ? (sketches.get(f.sketch) as unknown as { entities: { id: string; type: string }[]; constraints?: { type: string; entity?: string; value?: number }[] } | undefined) : undefined;
      if (want.sketch && sk) {
        for (const c of sk.constraints ?? []) {
          if (typeof c.value !== "number") continue;
          const ent = sk.entities.find((e) => e.id === c.entity);
          if (c.type === "radius" || c.type === "diameter") {
            const r = c.type === "radius" ? c.value : c.value / 2;
            // A whole circle by its diameter (drafting practice); an arc by its radius.
            addRadial(id, r, ent?.type === "arc" ? "radius" : "diameter", `${c.type} ${c.value}`);
          } else if ((c.type === "distance" || c.type === "distanceX" || c.type === "distanceY") && c.entity) addLength(id, c.value, "length");
        }
      }
      if (want.feature && typeof f.distance === "number" && f.op !== "revolve") addLength(id, f.distance, "depth");
    } else if (f.op === "hole" && want.holes) {
      if (holes.has(id)) continue;
      const hit = find((e) => e.feature === id && e.look === "circle");
      if (!hit) {
        missed.push(`${id}: no view sees the hole end on`);
        continue;
      }
      holes.add(id);
      items.push({ type: "hole", view: hit.cv.id, hole: id });
    } else if (f.op === "fillet" && want.feature && typeof f.radius === "number") addRadial(id, f.radius, "radius", `radius ${f.radius}`, true);
    else if (f.op === "chamfer" && want.feature && typeof f.distance === "number") {
      const hit = find((e) => e.feature === id && e.look === "line" && e.pts.length >= 2 && Math.abs(e.pts[0][0] - e.pts[e.pts.length - 1][0]) > 1e-6 && Math.abs(e.pts[0][1] - e.pts[e.pts.length - 1][1]) > 1e-6);
      if (!hit) missed.push(`${id}: no view sees the chamfer from the side`);
      else {
        usedRefs.add(hit.e.key);
        items.push({ type: "dimension", view: hit.cv.id, kind: "chamfer", refs: [ref(hit.cv, hit.e)] });
      }
    } else if (f.op === "member" && want.feature) {
      const m = sheet.points.members.find((x) => x.id === id);
      if (!m) continue;
      const along: Vec3 = [(m.ends[1][0] - m.ends[0][0]) / m.length, (m.ends[1][1] - m.ends[0][1]) / m.length, (m.ends[1][2] - m.ends[0][2]) / m.length];
      if (lengthTaken(along, m.length)) continue;
      const cv = views.find((x) => {
        const p = (q: Vec3) => [q[0] * x.frame.right[0] + q[1] * x.frame.right[1] + q[2] * x.frame.right[2], q[0] * x.frame.up[0] + q[1] * x.frame.up[1] + q[2] * x.frame.up[2]];
        const a = p(m.ends[0]);
        const b = p(m.ends[1]);
        return near(Math.hypot(b[0] - a[0], b[1] - a[1]), m.length, 0.01);
      });
      if (!cv) missed.push(`${id}: no view sees the member lying flat`);
      else {
        lengths.push({ along, value: m.length });
        items.push({ type: "dimension", view: cv.id, member: id });
      }
    }
  }
  return { items, missed };
}
