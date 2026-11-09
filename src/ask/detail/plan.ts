// The detailing plan (Phase Q wave Q3B): what "Fully detail this drawing"
// will add, item by item, from the part's design intent and by rules only
// (no model), so it is the same every time, works without a model (Auto-
// detail, small local models, tests) and is where a model-driven detailing
// starts. The user sees it as a card: each item ticked or not, with why, and
// the standard and tolerance level to change before anything is drawn.
//
// The rules (each item's `why` says which one it follows):
// - views: a new drawing gets the planned views (a section through hidden
//   insides, a detail of small features); one with hidden insides and no
//   section gets a section through the most holes;
// - every feature sized and located once (the auto-dimension engine fills
//   what a view lacks);
// - a datum scheme: A the mounting face (the face the holes are drilled
//   from's opposite, seen edge on), B and C the locating edges of a
//   prismatic part (the left and bottom of the plan view), B the bore of a
//   round one;
// - fits by purpose: a bore or bearing seat H7 (the shaft k6), a dowel hole
//   H7 (dowel m6), a guide H7/g6; clearance holes (ISO 273) stay plain sizes;
// - position Ø0.1 Ⓜ to A|B|C (round: A|B) for every hole pattern or located
//   hole, its locating dimensions made basic; flatness on A (0.05 up to
//   100 mm, 0.1 up to 300, 0.2 beyond); perpendicularity Ø0.02 of a fitted
//   bore to A;
// - threads called out from the Hole Wizard (they are in the callouts);
// - surface texture: Ra 3.2 on A, Ra 1.6 in fitted bores, a general Ra 6.3;
//   a weldment is as fabricated;
// - weld symbols from the weld table, or fillet a3 all round at each joint;
// - the general tolerance (ISO 2768-mK; a weldment ISO 13920-BF), the notes
//   (material, deburr and break edges, finish, units), the cut list with a
//   balloon for every item, the title block's material and revision, and a
//   revision row "A FIRST ISSUE".

import type { RawDocument } from "../../doc/commands";
import type { Annotation, Drawing, DrawingView, GdtRow, GeoRef, SurfaceAnnotation, Vec3, WeldAnnotation } from "../../doc/types";
import { allAnnotations, parseGeoRef } from "../../doc/drawing";
import { autoDimensionSheetView } from "../../drafting/autodim";
import type { ComposedSheet, ComposedView } from "../../drafting/compose";
import { parseGeneralTolerance } from "../../drafting/tolerance";
import type { Measurements } from "../../kernel/measure";
import { cutList } from "../../weldment/cutlist";
import type { DesignIntent } from "./intent";

export const PLAN_GROUPS = ["views", "dimensions", "datums", "fits", "gdt", "surface", "welds", "tolerance", "notes", "tables", "title"] as const;
export type PlanGroup = (typeof PLAN_GROUPS)[number];

export const PLAN_GROUP_LABELS: Record<PlanGroup, string> = {
  views: "Views",
  dimensions: "Sizes and locations",
  datums: "Datums",
  fits: "Fits and size tolerances",
  gdt: "Geometric tolerances",
  surface: "Surface texture",
  welds: "Welds",
  tolerance: "General tolerance",
  notes: "Notes",
  tables: "Tables and balloons",
  title: "Title block and revision",
};

/** What the user may change on the card before it is drawn. */
export interface DetailOptions {
  standard: "ISO" | "ASME";
  /** "ISO 2768-mK", "ISO 13920-BF", or an ASME block "X.X ±0.5, X.XX ±0.1, ANG ±0.5°". */
  generalTolerance: string;
  /** Position tolerance of hole patterns, mm (Ø zone). */
  position: number;
  /** The general surface texture ("Ra 6.3"); none for as-fabricated. */
  roughness: string | null;
}

/** What one item does, as data (the executor turns it into commands on the drawing as it then is). */
export type PlanAction =
  | { do: "drawing"; drawing: Drawing }
  | { do: "view"; id: string; view: DrawingView }
  | { do: "fill"; view: string; annotations: Annotation[] }
  | { do: "datum"; id: string; label: string; view: string; on?: GeoRef; dimension?: string }
  | { do: "fit"; target: string; fit: string; make?: Annotation; replaces?: string }
  | { do: "basic"; ids: string[] }
  | { do: "gdt"; id: string; view: string; rows: GdtRow[]; on?: GeoRef; dimension?: string; under?: string }
  | { do: "surface"; id: string; surface: Omit<SurfaceAnnotation, "id" | "type"> }
  | { do: "weld"; id: string; weld: Omit<WeldAnnotation, "id" | "type"> }
  | { do: "tolerance" }
  | { do: "notes"; id: string }
  | { do: "table"; id: string; annotation: Annotation }
  | { do: "balloons"; annotations: Annotation[] }
  | { do: "title"; patch: Record<string, string> }
  | { do: "revision" };

export interface PlanItem {
  id: string;
  group: PlanGroup;
  /** "Datum A on the mounting face (bottom, in front)". */
  label: string;
  why: string;
  on: boolean;
  /** Items it builds on: it is left out when one of them is unticked. */
  needs?: string[];
  /** A view it belongs to (a "Detail this view" plan keeps these). */
  view?: string;
  action: PlanAction;
}

export interface DetailPlan {
  /** The part as the plan reads it. */
  intent: DesignIntent;
  options: DetailOptions;
  items: PlanItem[];
  /** Only this view (a "Detail this view" ask). */
  view?: string;
}

/** The plan's starting point: the drawing as composed (or as New drawing would make it) and what the part is. */
export interface PlanInput {
  doc: RawDocument;
  /** The drawing the plan works on: the document's, or the planned one when it has none (then `fresh`). */
  drawing: Drawing;
  sheet: ComposedSheet;
  measurements: Measurements | null;
  intent: DesignIntent;
  fresh: boolean;
  /** Only this view. */
  view?: string;
  options?: Partial<DetailOptions>;
  date?: string;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const r2 = (x: number) => Math.round(x * 100) / 100;

/** The default options for a part: ISO, 2768-mK (a weldment 13920-BF), position Ø0.1, Ra 6.3 (a weldment none). */
export function defaultOptions(intent: DesignIntent, drawing?: Drawing): DetailOptions {
  const weld = intent.kind === "weldment";
  const given = drawing?.generalTolerance && parseGeneralTolerance(drawing.generalTolerance) ? drawing.generalTolerance : undefined;
  return { standard: drawing?.standard ?? "ISO", generalTolerance: given ?? (weld ? "ISO 13920-BF" : "ISO 2768-mK"), position: 0.1, roughness: weld ? null : "Ra 6.3" };
}

/** The general tolerances the card offers. */
export function toleranceChoices(intent: DesignIntent): string[] {
  if (intent.kind === "weldment") return ["ISO 13920-AE", "ISO 13920-BF", "ISO 13920-CG", "ISO 13920-DH"];
  return ["ISO 2768-fH", "ISO 2768-mK", "ISO 2768-cL", "ISO 2768-vL", "X.X ±0.5, X.XX ±0.1, X.XXX ±0.05, ANG ±0.5°"];
}

/** Flatness of a mounting face by its size: 0.05 up to 100 mm, 0.1 up to 300 mm, 0.2 beyond. */
export function flatnessFor(size: number): number {
  return size <= 100 ? 0.05 : size <= 300 ? 0.1 : 0.2;
}

/** The square views of a sheet, and which side of each a model direction points to. */
function sideOf(cv: ComposedView, dir: Vec3): "@bottom" | "@top" | "@left" | "@right" | null {
  const u = dot(cv.frame.up, dir);
  const r = dot(cv.frame.right, dir);
  if (Math.abs(u) > 0.999) return u < 0 ? "@bottom" : "@top";
  if (Math.abs(r) > 0.999) return r < 0 ? "@left" : "@right";
  return null;
}

/** The plan by rules. */
export function planDetail(input: PlanInput): DetailPlan {
  const { drawing, sheet, intent, doc } = input;
  const options = { ...defaultOptions(intent, input.fresh ? undefined : drawing), ...(input.options ?? {}) };
  const items: PlanItem[] = [];
  const add = (it: PlanItem) => {
    // "Detail this view": only what goes in that view (the drawing-wide items are for the whole drawing).
    if (!input.view || it.view === input.view) items.push(it);
  };
  const annotations = allAnnotations(drawing);
  const used = new Set(annotations.map((a) => a.id));
  const free = (base: string) => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
    used.add(id);
    return id;
  };
  const square = sheet.views.filter((v) => v.square && v.outline);
  const weld = intent.kind === "weldment";

  if (input.fresh) {
    const names = drawing.sheets[0].views.map((v) => (v.kind === "section" ? `section ${v.label ?? ""}–${v.label ?? ""}` : v.kind === "detail" ? `detail ${v.label ?? ""}` : v.id)).join(", ");
    items.push({ id: "drawing", group: "views", label: `New drawing: ${names}`, why: "the part has no drawing: its views (a section through hidden insides, a detail of small features), sizes, callouts and centre marks as New drawing plans them", on: true, action: { do: "drawing", drawing } });
  } else if (!weld && !sheet.views.some((v) => v.kind === "section")) {
    // Hidden insides and no section: cut one through the plan view's holes.
    const section = sectionFor(sheet, drawing);
    if (section) add({ id: "section", group: "views", label: `Section ${section.view.label}–${section.view.label} through ${section.through}`, why: "the part has hidden insides (bores, counterbores) that a section shows without dashed lines", on: true, view: section.view.parent, action: { do: "view", id: section.view.id, view: section.view } });
  }
  // Each view's missing sizes and locations (an existing drawing; a new one already has them).
  if (!input.fresh && !weld) {
    let n = 0;
    for (const cv of square) {
      if (cv.kind === "section" || cv.kind === "detail") continue;
      const fill = autoDimensionSheetView(doc, sheet, cv.id, input.measurements, (p) => free(`${p}${++n}`));
      const real = fill.filter((a) => a.type !== "centerMark" && a.type !== "centerline");
      if (!real.length) continue;
      add({ id: `fill_${cv.id}`, group: "dimensions", label: `${real.length} size${real.length === 1 ? "" : "s"} and location${real.length === 1 ? "" : "s"} missing in ${cv.id}`, why: "every feature sized and located once (the auto-dimension engine: overall sizes, hole positions from the datums, no duplicates)", on: true, view: cv.id, action: { do: "fill", view: cv.id, annotations: fill } });
    }
  }

  // ---- datums
  const existing = new Map(annotations.filter((a) => a.type === "datum").map((a) => [a.label, a]));
  const datumItem = new Map<string, string>();
  const datum = (label: string, view: string, at: { on?: GeoRef; dimension?: string }, what: string, why: string) => {
    if (existing.has(label)) return;
    const id = free(`datum_${label}`);
    datumItem.set(label, `datum_${label}`);
    add({ id: `datum_${label}`, group: "datums", label: `Datum ${label}: ${what}`, why, on: true, view, action: { do: "datum", id, label, view, ...at } });
  };
  const mount = intent.mounting;
  const elevation = mount ? square.find((cv) => cv.kind !== "detail" && sideOf(cv, mount) !== null && (cv.kind === "section" || !sheet.views.some((x) => x.kind === "section" && x.parent === undefined))) : undefined;
  const elev = mount ? (square.filter((cv) => cv.kind !== "detail" && sideOf(cv, mount)).sort((a, b) => (a.kind === "section" ? -1 : 0) - (b.kind === "section" ? -1 : 0) || (sideOf(a, mount) === "@bottom" ? -1 : 1) - (sideOf(b, mount) === "@bottom" ? -1 : 1))[0] ?? elevation) : undefined;
  const plan = mount ? square.find((cv) => cv.kind !== "section" && cv.kind !== "detail" && Math.abs(dot(cv.frame.eye, mount)) > 0.999) : undefined;
  const aSide = elev && mount ? sideOf(elev, mount) : null;
  if (!weld && elev && aSide) datum("A", elev.id, { on: `${elev.id}:${aSide}` }, `the mounting face (${aSide.slice(1)} in ${elev.id})`, "primary: the face the part is bolted down on (the holes are drilled toward it)");

  // A fitted bore's diameter dimension: the one the plan tolerances (and B hangs on, for a round part).
  const composedDims = sheet.annotations.filter((a) => a.type === "dimension" && !a.problem && a.value !== undefined);
  const boreDims = intent.bores.map((b) => {
    const hit = composedDims.find((a) => a.text.includes("Ø") && Math.abs((a.value ?? 0) - b.diameter) < 0.01);
    // In a section the bore's walls are seen: its Ø goes there (the datum and its frames sit clear of the part), replacing one on its circle.
    const cut = boreInSection(sheet, b.diameter, b.axis);
    if (cut) {
      const id = free("d_bore");
      return { bore: b, dim: id, make: { id, type: "dimension", view: cut.view, kind: "diameter", refs: cut.refs } as Annotation, replaces: hit?.id };
    }
    if (hit) return { bore: b, dim: hit.id, make: undefined as Annotation | undefined, replaces: undefined as string | undefined };
    // None yet: dimension it where it is seen round.
    const cv = square.find((x) => x.kind !== "section" && x.edges.some((e) => e.visible && e.look === "circle" && e.circle && Math.abs(2 * (e.model?.radius ?? e.circle.r) - b.diameter) < 0.01 && Math.abs(dot(x.frame.eye, b.axis)) > 0.999));
    const e = cv?.edges.find((x) => x.visible && x.look === "circle" && x.circle && Math.abs(2 * (x.model?.radius ?? x.circle.r) - b.diameter) < 0.01);
    if (!cv || !e) return { bore: b, dim: null, make: undefined, replaces: undefined };
    const id = free("d_bore");
    return { bore: b, dim: id, make: { id, type: "dimension", view: cv.id, kind: "diameter", refs: [`${cv.id}:e${e.key}`] } as Annotation, replaces: undefined };
  });
  const firstBore = boreDims.find((x) => x.dim);
  if (!weld && intent.kind === "round" && firstBore?.dim) {
    const viewOf = firstBore.make ? (firstBore.make as { view: string }).view : (annotations.find((a) => a.id === firstBore.dim) as { view?: string } | undefined)?.view;
    if (viewOf) datum("B", viewOf, { dimension: firstBore.dim }, `the bore Ø${firstBore.bore.diameter} (its axis)`, "secondary: a round part locates on its bore");
  } else if (!weld && plan) {
    datum("B", plan.id, { on: `${plan.id}:@left` }, `the left edge in ${plan.id}`, "secondary: the edge the hole positions are measured from");
    datum("C", plan.id, { on: `${plan.id}:@bottom` }, `the bottom edge in ${plan.id}`, "tertiary: the other edge the positions are measured from");
  }
  const labels = new Set([...existing.keys(), ...datumItem.keys()]);
  const refs = (list: string[], mod?: "M") => list.filter((l) => labels.has(l)).map((label, i) => ({ label, ...(mod && i > 0 && intent.kind === "round" && label === "B" ? { modifier: mod } : {}) }));
  const needsDatums = (list: string[]) => list.map((l) => datumItem.get(l)).filter((x): x is string => !!x);

  // ---- fits
  for (const x of boreDims) {
    if (!x.dim) continue;
    const view = x.make ? (x.make as { view: string }).view : (annotations.find((a) => a.id === x.dim) as { view?: string } | undefined)?.view;
    add({ id: `fit_${x.dim}`, group: "fits", label: `Bore Ø${x.bore.diameter} ${x.bore.fit}${x.bore.pair ? ` (fit ${x.bore.pair})` : ""}`, why: x.bore.why, on: true, view, action: { do: "fit", target: x.dim, fit: x.bore.fit, ...(x.make ? { make: x.make } : {}), ...(x.replaces ? { replaces: x.replaces } : {}) } });
  }
  const callouts = annotations.filter((a) => a.type === "hole");
  const calloutOf = (features: string[]) => callouts.find((a) => a.type === "hole" && features.includes(a.hole)) as Extract<Annotation, { type: "hole" }> | undefined;
  for (const h of intent.holes) {
    const c = calloutOf(h.features);
    if (!c) continue;
    if (h.fit) add({ id: `fit_${c.id}`, group: "fits", label: `${h.count > 1 ? `${h.count}× ` : ""}Ø${h.diameter} ${h.purpose} hole ${h.fit}${h.pair && h.pair !== h.fit ? ` (fit ${h.pair})` : ""}`, why: h.why, on: true, view: c.view, action: { do: "fit", target: c.id, fit: h.fit } });
    else if (h.purpose === "tapped") add({ id: `thread_${c.id}`, group: "fits", label: `${h.count > 1 ? `${h.count}× ` : ""}${h.size} - 6H: from the Hole Wizard, in callout ${c.id}`, why: h.why, on: true, view: c.view, action: { do: "basic", ids: [] } });
  }

  // ---- geometric tolerances
  const size = intent.size;
  const aDatum = labels.has("A") && elev && aSide ? `${elev.id}:${aSide}` : null;
  if (aDatum && elev && !annotations.some((a) => a.type === "gdt" && a.rows.some((r) => r.characteristic === "flatness"))) {
    const t = flatnessFor(size);
    add({ id: "flatness_A", group: "gdt", label: `Flatness ${t} on datum A`, why: `the mounting face carries the part: flat to ${t} mm over ${r2(size)} mm`, on: true, needs: needsDatums(["A"]), view: elev.id, action: { do: "gdt", id: free("gdt_flatness"), view: elev.id, on: aDatum, rows: [{ characteristic: "flatness", tolerance: t }] } });
  }
  for (const x of boreDims) {
    if (!x.dim || !labels.has("A")) continue;
    const view = x.make ? (x.make as { view: string }).view : (annotations.find((a) => a.id === x.dim) as { view?: string } | undefined)?.view;
    if (!view) continue;
    add({ id: `perp_${x.dim}`, group: "gdt", label: `Perpendicularity Ø0.02 of the bore Ø${x.bore.diameter} to A`, why: "a shaft or bearing in the bore runs square to the mounting face", on: true, needs: [...needsDatums(["A"]), `fit_${x.dim}`], view, action: { do: "gdt", id: free("gdt_perp"), view, dimension: x.dim, rows: [{ characteristic: "perpendicularity", diameter: true, tolerance: 0.02, datums: refs(["A"]) }] } });
  }
  const scheme = intent.kind === "round" ? ["A", "B"] : ["A", "B", "C"];
  for (const h of intent.holes) {
    const c = calloutOf(h.features);
    if (!c) continue;
    const located = h.count > 1 || h.purpose !== "plain";
    if (!located || !scheme.every((l) => labels.has(l))) continue;
    // Its locating dimensions become basic (the frame tolerances the place).
    const basics = locatingDims(sheet, drawing, c.view, h.makers).filter((id) => !annotations.some((a) => a.id === id && a.type === "dimension" && a.tolerance));
    const tol = h.fit ? Math.min(options.position, 0.05) : options.position;
    const mmc = h.purpose !== "tapped" && !h.fit;
    // A bearing seat or a guide also runs square to the mounting face: a second row.
    const perp = (h.purpose === "bearing" || h.purpose === "sliding") && labels.has("A");
    add({
      id: `position_${c.id}`,
      group: "gdt",
      label: `Position Ø${tol}${mmc ? " Ⓜ" : ""} ${scheme.join("|")}${perp ? " and perpendicularity Ø0.02 A" : ""} on ${h.count > 1 ? `the ${h.count} ` : "the "}Ø${h.diameter} ${h.purpose} hole${h.count > 1 ? "s" : ""}${basics.length ? `, ${basics.length} locating dimension${basics.length === 1 ? "" : "s"} basic` : ""}`,
      why: `${h.count > 1 ? "a hole pattern is located as one, to the datum scheme" : "a located hole: its place toleranced to the datum scheme"}${mmc ? ", at maximum material (a bonus tolerance as the holes grow, as bolts allow)" : h.fit ? ", tighter for a fitted hole; no Ⓜ: what fits in it must not float" : ""}${perp ? ", and square to A (it carries a shaft or bearing)" : ""}`,
      on: true,
      needs: needsDatums(scheme),
      view: c.view,
      action: { do: "gdt", id: free("gdt_position"), view: c.view, dimension: c.id, rows: [{ characteristic: "position", diameter: true, tolerance: tol, ...(mmc ? { material: "M" as const } : {}), datums: refs(scheme, mmc ? "M" : undefined) }, ...(perp ? [{ characteristic: "perpendicularity" as const, diameter: true, tolerance: 0.02, datums: refs(["A"]) }] : [])] },
    });
    if (basics.length) add({ id: `basic_${c.id}`, group: "gdt", label: `Basic: ${basics.join(", ")}`, why: "dimensions that place toleranced positions are theoretically exact (boxed)", on: true, needs: [`position_${c.id}`], view: c.view, action: { do: "basic", ids: basics } });
  }

  // ---- surface texture
  if (!weld) {
    if (aDatum && elev) add({ id: "surface_A", group: "surface", label: "Ra 3.2 on the mounting face A", why: "a mating face: machined", on: true, view: elev.id, action: { do: "surface", id: free("surface_A"), surface: { view: elev.id, symbol: "removal", values: ["Ra 3.2"], on: aDatum } } });
    for (const x of boreDims) {
      if (!x.dim) continue;
      const view = x.make ? (x.make as { view: string }).view : (annotations.find((a) => a.id === x.dim) as { view?: string } | undefined)?.view;
      const dimA = (x.make ?? annotations.find((a) => a.id === x.dim)) as { refs?: string[] } | undefined;
      const on = dimA?.refs?.[0];
      if (view && on) add({ id: `surface_${x.dim}`, group: "surface", label: `Ra 1.6 in the bore Ø${x.bore.diameter}`, why: "a fitted bore: fine-turned or reamed", on: true, needs: [`fit_${x.dim}`], view, action: { do: "surface", id: free("surface_bore"), surface: { view, symbol: "removal", values: ["Ra 1.6"], on } } });
    }
    // Fitted holes: Ra 1.6 on the bore (a leader to its circle).
    for (const h of intent.holes) {
      const c = calloutOf(h.features);
      const cv = c ? square.find((v) => v.id === c.view) : undefined;
      const e = cv?.edges.find((x) => x.visible && x.look === "circle" && x.circle && h.makers.includes(x.feature ?? "") && Math.abs(2 * (x.model?.radius ?? x.circle.r) - h.diameter) < 0.01);
      if (!h.fit || !c || !cv || !e) continue;
      add({ id: `surface_${c.id}`, group: "surface", label: `Ra ${h.purpose === "dowel" ? "0.8" : "1.6"} in the Ø${h.diameter} ${h.purpose} hole${h.count > 1 ? "s" : ""}`, why: h.purpose === "dowel" ? "a dowel hole is reamed" : "a fitted bore: fine-bored or reamed", on: true, needs: [`fit_${c.id}`], view: cv.id, action: { do: "surface", id: free("surface_hole"), surface: { view: cv.id, symbol: "removal", values: [h.purpose === "dowel" ? "Ra 0.8" : "Ra 1.6"], on: `${cv.id}:e${e.key}` } } });
    }
    if (!annotations.some((a) => a.type === "surface" && a.general)) add({ id: "surface_general", group: "surface", label: `General ${options.roughness ?? "Ra 6.3"} (√) for every other surface`, why: "ISO 1302: one general requirement by the title block", on: options.roughness !== null, action: { do: "surface", id: free("surface_general"), surface: { general: true, symbol: "removal", values: [options.roughness ?? "Ra 6.3"] } } });
  }

  // ---- welds
  if (weld) {
    const front = square.find((v) => v.id === "front") ?? square[0];
    const symbols = new Set(annotations.filter((a) => a.type === "weld").map((a) => (a.type === "weld" ? (a.weld ?? a.on ?? "") : "")));
    const v = (doc as { welds?: { id: string }[] }).welds ?? [];
    for (const w of v) {
      if (symbols.has(w.id) || !front) continue;
      add({ id: `weld_${w.id}`, group: "welds", label: `Weld symbol for ${w.id}`, why: "from the weld table: its type, size and length", on: true, view: front.id, action: { do: "weld", id: free(`w_${w.id}`), weld: { view: front.id, weld: w.id } } });
    }
    if (!v.length && front) {
      // No weld table: a fillet a3 all round at each joint the front view shows (the note covers the rest).
      const shown = new Set<string>();
      for (const j of intent.joints) {
        if (!j.node || shown.has(j.node)) continue;
        const at = sheet.points.nodes[j.node];
        if (!at) continue;
        const key = `${r2(dot(at, front.frame.right))},${r2(dot(at, front.frame.up))}`;
        if (shown.has(key)) continue;
        shown.add(key);
        shown.add(j.node);
        add({ id: `weld_${j.id}`, group: "welds", label: `Fillet weld a3 all round at ${j.node} (${j.type} ${j.members.join(" / ")})`, why: "every joint of the frame is welded: a 3 mm throat suits 3 mm walls", on: true, view: front.id, action: { do: "weld", id: free(`w_${j.id}`), weld: { view: front.id, on: `${front.id}:${j.node}`, arrowSide: { symbol: "fillet", size: "a3" }, allAround: true, process: "135" } } });
      }
    }
  }

  // ---- general tolerance, notes, tables, title block
  add({ id: "tolerance", group: "tolerance", label: `General tolerance ${options.generalTolerance}`, why: weld ? "ISO 13920 for welded constructions: B for lengths and angles, F for straightness, flatness and parallelism" : "ISO 2768: m (medium) for linear and angular sizes, K for the geometric tolerances not shown", on: true, action: { do: "tolerance" } });
  add({ id: "notes", group: "notes", label: weld ? "Notes: material, tolerances, welding (ISO 2553, ISO 5817 C), cleaning and paint, units" : "Notes: material, tolerances, surface, deburr and break edges, finish, units", why: "what the shop needs that no symbol says", on: true, action: { do: "notes", id: "general_notes" } });
  if (weld) {
    const items = cutList(input.measurements?.members ?? []);
    const iso = sheet.views.find((v) => v.look === "iso") ?? sheet.views[0];
    const ballooned = new Set(annotations.filter((a) => a.type === "balloon").map((a) => (a.type === "balloon" ? a.member : "")));
    const missing = items.filter((it) => !it.members.some((m) => ballooned.has(m)));
    if (missing.length && iso) add({ id: "balloons", group: "tables", label: `Balloons for ${missing.length} cut list item${missing.length === 1 ? "" : "s"}`, why: "every cut list item numbered on the sheet", on: true, view: iso.id, action: { do: "balloons", annotations: missing.map((it) => ({ id: free("b"), type: "balloon", view: iso.id, member: it.members[0] }) as Annotation) } });
    const hasCut = annotations.some((a) => a.type === "table" && a.table === "cutList") || drawing.sheets.some((s) => (s.tables ?? []).some((t) => t.kind === "cutList"));
    if (!hasCut) add({ id: "cut_list", group: "tables", label: "Cut list table", why: "the weldment's members: item, quantity, profile, length, angles", on: true, action: { do: "table", id: "cut_list", annotation: { id: free("cut_list"), type: "table", table: "cutList" } } });
  }
  const s0 = drawing.sheets[0];
  const patch: Record<string, string> = {};
  const material = intent.material;
  if (material && !s0.format.material) patch.material = material;
  if (!s0.format.revision) patch.revision = "A";
  if (!s0.format.title && typeof doc.name === "string") patch.title = String(doc.name).toUpperCase();
  if (Object.keys(patch).length) add({ id: "title", group: "title", label: `Title block: ${Object.entries(patch).map(([k, v]) => `${k} ${v}`).join(", ")}`, why: "the title block names the part, its material and its revision", on: true, action: { do: "title", patch } });
  if (!(drawing.revisions ?? []).length) add({ id: "revision", group: "title", label: "Revision A: FIRST ISSUE", why: "a released drawing starts its revision history", on: true, action: { do: "revision" } });
  return { intent, options, items, ...(input.view ? { view: input.view } : {}) };
}

/** A bore's two walls where a section cuts them (lines along its axis, its diameter apart): their GeoRefs. */
function boreInSection(sheet: ComposedSheet, diameter: number, axis: Vec3): { view: string; refs: [GeoRef, GeoRef] } | null {
  for (const cv of sheet.views) {
    if (cv.kind !== "section" || !cv.square) continue;
    const up = Math.abs(dot(cv.frame.up, axis)) > 0.999;
    const right = Math.abs(dot(cv.frame.right, axis)) > 0.999;
    if (!up && !right) continue;
    const k = up ? 0 : 1;
    const walls = cv.edges.filter((e) => e.visible && e.look === "line" && e.pts.length >= 2 && Math.abs(e.pts[0][k] - e.pts[e.pts.length - 1][k]) < 1e-6 && Math.abs(e.pts[0][1 - k] - e.pts[e.pts.length - 1][1 - k]) > 0.5);
    const mid = cv.outline ? (cv.outline.min[k] + cv.outline.max[k]) / 2 : 0;
    for (const a of walls) {
      const b = walls.find((x) => x !== a && Math.abs(x.pts[0][k] - a.pts[0][k] - diameter) < 0.01 && Math.abs((x.pts[0][k] + a.pts[0][k]) / 2 - mid) < 0.5);
      if (b) return { view: cv.id, refs: [`${cv.id}:e${a.key}`, `${cv.id}:e${b.key}`] };
    }
  }
  return null;
}

/** The dimensions in a view that place the holes of these features (to their centres). */
export function locatingDims(sheet: ComposedSheet, drawing: Drawing, view: string, features: string[]): string[] {
  const cv = sheet.views.find((v) => v.id === view);
  if (!cv) return [];
  const makers = new Set(features);
  const keyFeature = new Map(cv.edges.map((e) => [e.key, e.feature ?? ""]));
  const toHole = (p: unknown) => {
    const g = typeof p === "string" ? parseGeoRef(p) : null;
    if (!g || g.view !== view || (g.form !== "c" && g.form !== "e")) return false;
    const f = keyFeature.get(g.key) ?? g.key.split("/")[0];
    return makers.has(f);
  };
  return allAnnotations(drawing)
    .filter((a) => a.type === "dimension" && a.view === view && (a.kind === undefined || a.kind === "linear" || a.kind === "ordinate") && [a.from, a.to, ...(a.refs ?? []), ...(a.points ?? [])].some(toHole))
    .map((a) => a.id);
}

/** A full section of the plan view through the most circles (as New drawing cuts one), when the sheet has a top view. */
function sectionFor(sheet: ComposedSheet, drawing: Drawing): { view: DrawingView; through: string } | null {
  const top = sheet.views.find((v) => v.look === "top" && v.kind !== "section" && v.outline);
  if (!top || !top.outline) return null;
  const hidden = top.edges.some((e) => !e.visible) || sheet.views.some((v) => v.edges.some((e) => !e.visible));
  if (!hidden) return null;
  const o = top.outline;
  const score = new Map<number, number>();
  for (const e of top.edges) {
    if (!e.circle || e.look !== "circle") continue;
    const y = Math.round(e.circle.c[1] * 1000) / 1000;
    if (y <= o.min[1] + 1e-6 || y >= o.max[1] - 1e-6) continue;
    score.set(y, (score.get(y) ?? 0) + 1);
  }
  const mid = (o.min[1] + o.max[1]) / 2;
  const best = [...score].sort((p, q) => q[1] - p[1] || Math.abs(p[0] - mid) - Math.abs(q[0] - mid))[0];
  const y = best ? best[0] : mid;
  const margin = Math.max(2, 0.08 * Math.max(o.max[0] - o.min[0], o.max[1] - o.min[1]));
  const labels = new Set(drawing.sheets.flatMap((s) => s.views.map((v) => v.label)).filter(Boolean));
  const label = ["A", "B", "C", "D", "E", "F", "G", "H"].find((l) => !labels.has(l)) ?? "S";
  const ids = new Set(drawing.sheets.flatMap((s) => s.views.map((v) => v.id)));
  let id = `section_${label}`;
  for (let n = 2; ids.has(id); n++) id = `section_${label}${n}`;
  return { view: { id, kind: "section", parent: top.id, line: [[r2(o.max[0] + margin), r2(y)], [r2(o.min[0] - margin), r2(y)]], label }, through: best ? `the ${best[1]} circle${best[1] === 1 ? "" : "s"} on one line` : "the middle" };
}

/** The items that will run: ticked, and everything they build on ticked too. */
export function activeItems(plan: DetailPlan): PlanItem[] {
  const on = new Map(plan.items.map((i) => [i.id, i.on]));
  const ok = (i: PlanItem, seen = new Set<string>()): boolean => {
    // A loop of needs runs nothing.
    if (!i.on || seen.has(i.id)) return false;
    const path = new Set(seen).add(i.id);
    return (i.needs ?? []).every((n) => {
      const dep = plan.items.find((x) => x.id === n);
      return dep ? on.get(n) === true && ok(dep, path) : true;
    });
  };
  return plan.items.filter((i) => ok(i));
}

/** The plan as the agent reads it: the part, the options, and each item as one line (its why too, unless compact). */
export function planBrief(plan: DetailPlan, compact: boolean): { design: string; options: DetailOptions; items: string[] } {
  return {
    design: plan.intent.summary,
    options: plan.options,
    items: plan.items.map((i) => `[${i.on ? "x" : " "}] ${i.id} (${i.group}): ${i.label}${compact ? "" : ` — ${i.why}`}`),
  };
}

/** The plan with items left out (skip), only some kept (only), or other options. */
export function planWith(plan: DetailPlan, change: { skip?: string[]; only?: string[]; options?: Partial<DetailOptions> }): DetailPlan {
  const skip = new Set(change.skip ?? []);
  const only = change.only?.length ? new Set(change.only) : null;
  return {
    ...plan,
    options: { ...plan.options, ...(change.options ?? {}) },
    items: plan.items.map((i) => ({ ...i, on: i.on && !skip.has(i.id) && (!only || only.has(i.id)) })),
  };
}

/** The plan as a few lines of text (the agent's packet, the MCP reply). */
export function planText(plan: DetailPlan): string {
  const lines = [`Part: ${plan.intent.summary}.`, `Standard ${plan.options.standard}, general tolerance ${plan.options.generalTolerance}${plan.options.roughness ? `, general surface ${plan.options.roughness}` : ""}.`];
  for (const g of PLAN_GROUPS) {
    const list = plan.items.filter((i) => i.group === g);
    if (!list.length) continue;
    lines.push(`${PLAN_GROUP_LABELS[g]}:`);
    for (const i of list) lines.push(`  [${i.on ? "x" : " "}] ${i.id}: ${i.label} — ${i.why}`);
  }
  return lines.join("\n");
}
