// The detailing critic (Phase Q wave Q3B): what checkDrawing reports, the
// agent's correction rounds read, and the plan card shows after a detailing.
// Each finding is one sentence that says what to do.
//
// - completeness: every hole sized (a callout or a Ø) and located (to its
//   centre, by a pattern's pitch circle, by the part's symmetry, or by a
//   position frame), exactly once; no size given twice (across views too);
//   no dimension to a hidden line;
// - GD&T: every frame valid (gdtProblems, with the datums on the drawing);
//   the tolerances the plan asked for present;
// - the tolerance stack of each chain of dimensions (the worst case of the
//   effective tolerances from toleranceOf) within its limit;
// - readability: text over text, a table or the title block;
// - standards: a general tolerance, the material, the drawing checks.

import type { RawDocument } from "../../doc/commands";
import type { Annotation, DimensionAnnotation, Drawing, Vec3 } from "../../doc/types";
import { allAnnotations, parseGeoRef } from "../../doc/drawing";
import { validateDocument } from "../../doc/validate";
import { datumLabels, gdtProblems } from "../../drafting/annotate";
import { drawingChecks } from "../../drafting/checks";
import type { ComposedAnnotation, ComposedSheet } from "../../drafting/compose";
import { resolveGeoRef } from "../../drafting/georef";
import { parseGeneralTolerance, toleranceOf, type EffectiveTolerance } from "../../drafting/tolerance";
import type { Measurements } from "../../kernel/measure";
import type { DrawingGeometry } from "../kernel";
import { boxGap, crossingsOf, lineConflictsOf, overlapsOf } from "./execute";
import type { DesignIntent } from "./intent";
import { activeItems, type DetailPlan } from "./plan";

export const FINDING_RULES = ["checks", "sized", "located", "twice", "hidden", "gdt", "planned", "stack", "overlap", "standard"] as const;
export type FindingRule = (typeof FINDING_RULES)[number];

export interface Finding {
  rule: FindingRule;
  severity: "error" | "warning";
  message: string;
  /** The annotations or features it is about. */
  ids?: string[];
}

export interface CriticInput {
  doc: RawDocument;
  drawing: Drawing;
  sheets: ComposedSheet[];
  measurements: Measurements | null;
  geometry: DrawingGeometry | null;
  intent?: DesignIntent;
  plan?: DetailPlan;
  /** The worst-case stack a chain may reach, mm (default: twice the general tolerance of its span, at least 0.4). */
  stackLimit?: number;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Everything the critic finds, errors first. */
export function critique(input: CriticInput): Finding[] {
  const { drawing, sheets } = input;
  const out: Finding[] = [];
  const anns = allAnnotations(drawing);
  const composed = sheets.flatMap((s) => s.annotations);
  const byId = new Map(composed.map((a) => [a.id, a]));
  const drawn = (id: string) => {
    const c = byId.get(id);
    return !!c && !c.problem;
  };

  // The drawing checks (every view shows the part, every annotation attached, overall size, holes called out, welds, layout).
  for (const c of drawingChecks(sheets, input.doc, input.measurements, input.geometry)) if (!c.ok) out.push({ rule: "checks", severity: c.label.startsWith("Nothing overlaps") ? "warning" : "error", message: `${c.label}: ${c.actual}.` });

  // ---- sized and located, once
  const holes = input.geometry?.holes ?? [];
  const weldment = (input.measurements?.members?.length ?? 0) > 0;
  if (!weldment) {
    for (const h of holes) {
      const makers = new Set([h.feature, ...(input.intent?.holes.find((x) => x.features.includes(h.feature))?.makers ?? [])]);
      const sized = anns.some((a) => drawn(a.id) && ((a.type === "hole" && (a.hole === h.feature || sameKind(input, a.hole, h.feature))) || (a.type === "dimension" && (a.kind === "diameter" || a.kind === "radius") && (a.refs ?? []).some((r) => edgeFeature(sheets, r, makers)))));
      if (!sized) out.push({ rule: "sized", severity: "error", message: `hole ${h.feature} (Ø${r3(h.diameter)}) has no size: call it out (a hole callout on its circle).`, ids: [h.feature] });
      const where = locationOf(input, h.feature, makers);
      if (!where) out.push({ rule: "located", severity: "error", message: `hole ${h.feature} is not located: dimension its centre from the datum edges (or give it a position frame with basic dimensions).`, ids: [h.feature] });
    }
  }

  // No size twice: the same value along the same model direction, in any view (reference and basic ones excepted).
  const dims = composed.filter((a) => a.type === "dimension" && !a.problem && a.value !== undefined && a.along);
  const docDim = (id: string) => anns.find((a) => a.id === id) as DimensionAnnotation | undefined;
  for (let i = 0; i < dims.length; i++) {
    for (let j = i + 1; j < dims.length; j++) {
      const a = dims[i];
      const b = dims[j];
      if (Math.abs(a.value! - b.value!) > 0.01 || Math.abs(Math.abs(dot(a.along!, b.along!)) - 1) > 1e-6) continue;
      const ka = docDim(a.id);
      const kb = docDim(b.id);
      if (!ka || !kb) continue;
      if ([ka, kb].some((d) => d.tolerance?.kind === "reference")) continue;
      if (ka.count || kb.count) continue;
      // The same points measured: a true duplicate; different points of the same length are fine.
      if (!samePoints(ka, kb)) continue;
      out.push({ rule: "twice", severity: "error", message: `${a.id} and ${b.id} both give ${a.text}: keep one (delete ${b.id}, or make it a reference dimension).`, ids: [a.id, b.id] });
    }
  }

  // No dimension to a hidden line.
  for (const a of anns) {
    if (a.type !== "dimension" || !drawn(a.id)) continue;
    for (const r of [a.from, a.to, a.origin, ...(a.refs ?? []), ...(a.points ?? [])]) {
      if (typeof r !== "string" || !r.includes(":")) continue;
      const g = resolveGeoRef(sheets, r);
      if (g && g.visible === false) {
        out.push({ rule: "hidden", severity: "error", message: `${a.id} measures to ${r}, a hidden line: dimension it where it is seen (or in a section).`, ids: [a.id] });
        break;
      }
    }
  }

  // ---- GD&T
  const datums = datumLabels(anns.filter((a) => drawn(a.id)));
  const standard = drawing.standard ?? "ISO";
  for (const a of anns) {
    if (a.type !== "gdt") continue;
    const target = a.dimension ? anns.find((x) => x.id === a.dimension) : undefined;
    const sizeFeature = target ? target.type === "hole" || (target.type === "dimension" && (target.kind === "diameter" || (target.prefix ?? "").includes("Ø"))) : a.on ? isCircle(sheets, a.on) : true;
    for (const p of gdtProblems(a, { datums, standard, sizeFeature })) out.push({ rule: "gdt", severity: "error", message: `${a.id}: ${p}.`, ids: [a.id] });
  }
  for (const label of datums) if (["I", "O", "Q"].includes(label)) out.push({ rule: "standard", severity: "error", message: `datum ${label}: I, O and Q are not used as datum letters.` });

  // ---- what the plan asked for
  if (input.plan) {
    for (const item of activeItems(input.plan)) {
      const act = item.action;
      if (act.do === "fit") {
        const t = anns.find((x) => x.id === (act.make?.id ?? act.target)) as { tolerance?: { fit?: string } } | undefined;
        if (!t?.tolerance?.fit) out.push({ rule: "planned", severity: "error", message: `the plan gives ${act.make?.id ?? act.target} the fit ${act.fit}, but it has none: editAnnotation it with { "tolerance": { "kind": "fit", "fit": "${act.fit}" } }.`, ids: [act.target] });
      }
      if (act.do === "gdt" && !anns.some((x) => x.type === "gdt" && x.rows.some((r) => r.characteristic === act.rows[0].characteristic) && (x.id === act.id || x.dimension === act.dimension))) out.push({ rule: "planned", severity: "error", message: `the plan's ${act.rows[0].characteristic} frame (${item.label}) is missing.`, ids: [act.id] });
      if (act.do === "datum" && !datums.has(act.label)) out.push({ rule: "planned", severity: "error", message: `datum ${act.label} (${item.label}) is not on the drawing.` });
    }
  }

  for (const loop of closedLoops(input)) out.push({ rule: "twice", severity: "error", message: `${loop.id} closes a loop with ${loop.via.join(" + ")}: the same size is given twice; make one of them a reference dimension ({ "tolerance": { "kind": "reference" } }) or delete it.`, ids: [loop.id, ...loop.via] });

  // ---- tolerance stacks along chains
  for (const s of stacks(input)) if (!s.ok) out.push({ rule: "stack", severity: "warning", message: `the chain ${s.ids.join(" + ")} (${r3(s.span)} mm) stacks up to ±${r3(s.worst)} worst case (RSS ±${r3(s.rss)}), over its ±${r3(s.limit)}: dimension the critical size directly from the datum, or tighten the links.`, ids: s.ids });

  // ---- readability
  for (const sh of sheets) {
    const seen = new Set<string>();
    for (const a of sh.annotations) {
      if (!a.textBox || a.type === "centerMark" || a.type === "centerline") continue;
      for (const o of overlapsOf(sh, a.id)) {
        const key = [a.id, o.with].sort().join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ rule: "overlap", severity: "warning", message: `${a.id} (${short(a)}) runs into ${o.with}: move one of them (editAnnotation "at").`, ids: [a.id, o.with] });
      }
      for (const w of lineConflictsOf(sh, a.id).along) {
        const key = [a.id, w].sort().join("~");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ rule: "overlap", severity: "warning", message: `${a.id} and ${w} are drawn over one another (their lines lie along each other): move one to its own row (editAnnotation "at").`, ids: [a.id, w] });
      }
      for (const w of crossingsOf(sh, a.id)) out.push({ rule: "overlap", severity: "warning", message: `a line of ${w} runs through ${a.id} (${short(a)}): move ${a.id} clear of it (editAnnotation "at").`, ids: [a.id, w] });
    }
  }

  // A frame or datum on a callout or dimension drawn away from it reads as belonging to nothing.
  for (const a of anns) {
    const host = "dimension" in a && typeof a.dimension === "string" ? a.dimension : null;
    if (!host || a.type !== "gdt") continue;
    const mine = byId.get(a.id)?.textBox;
    const theirs = byId.get(host)?.textBox;
    if (mine && theirs && boxGap(mine, theirs) > 4) out.push({ rule: "overlap", severity: "warning", message: `${a.id} is drawn ${Math.round(boxGap(mine, theirs))} mm away from ${host}, which it is attached to: put it against it (editAnnotation "at": null hangs it under ${host}).`, ids: [a.id, host] });
  }

  // ---- standards
  if (!parseGeneralTolerance(drawing.generalTolerance)) out.push({ rule: "standard", severity: "error", message: 'no general tolerance: setDrawingOptions { "generalTolerance": "ISO 2768-mK" } (a weldment "ISO 13920-BF").' });
  const material = validateDocument(input.doc).material?.name ?? sheets[0]?.format.material;
  if (!material) out.push({ rule: "standard", severity: "warning", message: "no material: give the part a material (or the title block's material)." });
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
}

function short(a: ComposedAnnotation): string {
  return a.text.length > 24 ? `${a.text.slice(0, 22)}…` : a.text || a.type;
}

/** A hole callout of another feature counts for this one when they are alike (one callout, "4×"). */
function sameKind(input: CriticInput, a: string, b: string): boolean {
  const h = input.intent?.holes.find((x) => x.features.includes(a));
  return !!h && h.features.includes(b);
}

function edgeFeature(sheets: ComposedSheet[], ref: string, makers: Set<string>): boolean {
  const g = parseGeoRef(ref);
  if (!g || g.form === "point") return false;
  const key = (g as { key?: string }).key ?? "";
  for (const s of sheets) {
    const cv = s.views.find((v) => v.id === g.view);
    const e = cv?.edges.find((x) => x.key === key);
    if (e) return makers.has(e.feature ?? key.split("/")[0]);
  }
  return makers.has(key.split("/")[0]);
}

function isCircle(sheets: ComposedSheet[], ref: string): boolean {
  const g = resolveGeoRef(sheets, ref);
  return !!g && (g.kind === "circle" || (g.kind === "edge" && "circle" in g && !!(g as { circle?: unknown }).circle));
}

/** Where a hole is located from: a dimension to it, its pattern's pitch circle, the part's symmetry, a centre line it shares with a located hole, or a position frame. */
function locationOf(input: CriticInput, feature: string, makers: Set<string>): string | null {
  const anns = allAnnotations(input.drawing);
  const composed = new Map(input.sheets.flatMap((s) => s.annotations).map((a) => [a.id, a]));
  // A circular pattern's callout places it by its pitch circle.
  const callout = composed.get(anns.find((a) => a.type === "hole" && a.hole === feature)?.id ?? "");
  if (callout?.text.includes("PCD")) return "PCD";
  const h = input.geometry?.holes.find((x) => x.feature === feature);
  const bb = input.measurements?.boundingBox;
  const direct = directions(input, feature, makers);
  if (!h || !bb) return direct.size ? "dimensions" : null;
  // On the part's middle both ways (a round part's bore, a centred hole), or located each way: by a dimension to it, by
  // the middle, or on a centre line with a hole that is dimensioned that way (holes in a row share their dimension).
  const mid = bb.min.map((v, i) => (v + bb.max[i]) / 2);
  const axis = h.axis.map(Math.abs);
  const across = [0, 1, 2].filter((i) => axis[i] < 0.5);
  const centred = across.filter((i) => Math.abs(h.entry[i] - mid[i]) < 1e-3);
  if (centred.length === across.length) return "symmetry";
  const others = (input.geometry?.holes ?? []).filter((g) => g.feature !== feature && Math.abs(Math.abs(g.axis[0] * h.axis[0] + g.axis[1] * h.axis[1] + g.axis[2] * h.axis[2]) - 1) < 1e-6);
  const shared = (i: number) =>
    others.some((g) => Math.abs(g.entry[i] - h.entry[i]) < 1e-3 && directions(input, g.feature, new Set([g.feature, ...(input.intent?.holes.find((x) => x.features.includes(g.feature))?.makers ?? [])])).has(i));
  if (across.every((i) => centred.includes(i) || direct.has(i) || shared(i))) return "dimensions";
  return null;
}

/** The model axes (0 x, 1 y, 2 z) a hole's centre is dimensioned along, directly (a dimension to its edge or centre). */
function directions(input: CriticInput, feature: string, makers: Set<string>): Set<number> {
  const anns = allAnnotations(input.drawing);
  const composed = new Map(input.sheets.flatMap((s) => s.annotations).map((a) => [a.id, a]));
  const ok = (a: Annotation) => !composed.get(a.id)?.problem;
  const toHole = (p: unknown) => {
    if (typeof p !== "string") return false;
    if (p === feature) return true;
    const g = parseGeoRef(p);
    return !!g && (g.form === "c" || g.form === "e") && edgeFeature(input.sheets, p, makers);
  };
  const dims = anns.filter((a): a is DimensionAnnotation => a.type === "dimension" && ok(a) && (a.kind === undefined || a.kind === "linear" || a.kind === "ordinate" || a.kind === "baseline" || a.kind === "chain"));
  const out = new Set<number>();
  for (const d of dims) {
    if (![d.from, d.to, d.origin, ...(d.points ?? []), ...(d.kind === undefined || d.kind === "linear" ? [] : d.refs ?? [])].some(toHole)) continue;
    const along = composed.get(d.id)?.along;
    if (along) for (let i = 0; i < 3; i++) if (Math.abs(along[i]) > 0.999) out.add(i);
  }
  return out;
}

function samePoints(a: DimensionAnnotation, b: DimensionAnnotation): boolean {
  if (a.member && a.member === b.member) return true;
  const pa = [a.from, a.to].filter(Boolean).map(String).map(stripView).sort().join("|");
  const pb = [b.from, b.to].filter(Boolean).map(String).map(stripView).sort().join("|");
  if (pa && pa === pb) return true;
  // Outline sides in different views measure the overall size: the same size twice.
  const sides = (d: DimensionAnnotation) => [d.from, d.to].every((p) => typeof p === "string" && p.startsWith("@"));
  if (sides(a) && sides(b)) return true;
  const ra = (a.refs ?? []).map(stripView).sort().join("|");
  const rb = (b.refs ?? []).map(stripView).sort().join("|");
  if (ra && ra === rb) return true;
  // A diameter given in two views.
  if (a.kind === "diameter" && b.kind === "diameter") return true;
  return false;
}

const stripView = (p: string) => p.replace(/^[^:]+:/, "");

// ------------------------------------------------------------ tolerance stacks

export interface Stack {
  /** The dimensions of the chain, end to end. */
  ids: string[];
  /** The span the chain adds up to, mm. */
  span: number;
  /** Worst case (the sum of the half bands) and root-sum-square, mm. */
  worst: number;
  rss: number;
  /** What the span may vary by: the stack limit. */
  limit: number;
  ok: boolean;
}

/** The half band (± equivalent) of an effective tolerance. */
export function halfBand(t: EffectiveTolerance): number {
  return (t.upper - t.lower) / 2;
}

/**
 * Chains of dimensions in one view along one direction, each starting where
 * the one before ends (a chain set counts link by link), and the tolerance
 * they stack up to: the sum of the links' effective half bands (worst case)
 * and their root-sum-square, against the limit (stackLimit, else twice the
 * general tolerance of the chain's span, at least 0.4 mm).
 */
export function stacks(input: CriticInput): Stack[] {
  const anns = allAnnotations(input.drawing).filter((a): a is DimensionAnnotation => a.type === "dimension");
  const composed = new Map(input.sheets.flatMap((s) => s.annotations).map((a) => [a.id, a]));
  const links: { id: string; from: string; to: string; value: number; along: Vec3; view: string; tol: EffectiveTolerance }[] = [];
  for (const a of anns) {
    const c = composed.get(a.id);
    if (!c || c.problem || c.value === undefined || !c.along) continue;
    const tol = toleranceOf({ value: c.value, kind: a.kind, tolerance: a.tolerance, places: a.precision }, input.drawing);
    if (a.kind === "chain" && a.points && a.origin) {
      const pts = [a.origin, ...a.points];
      for (let i = 1; i < pts.length; i++) links.push({ id: `${a.id}[${i}]`, from: pts[i - 1], to: pts[i], value: c.value, along: c.along, view: a.view, tol });
      continue;
    }
    if ((a.kind === undefined || a.kind === "linear") && a.from && a.to) links.push({ id: a.id, from: a.from, to: a.to, value: c.value, along: c.along, view: a.view, tol });
  }
  const out: Stack[] = [];
  const same = (p: (typeof links)[number], q: (typeof links)[number]) => p.view === q.view && Math.abs(Math.abs(dot(p.along, q.along)) - 1) < 1e-6;
  // A link whose ends other links already join (an overall size over a chain) closes a loop: not part of a chain.
  const closing = new Set(
    links
      .filter((l) => {
        const via = pathBetween(links.filter((x) => x !== l && same(x, l) && tolSource(x.tol) !== "basic"), l.from, l.to);
        // The loop's longest link is the one over the others.
        return !!via && via.every((id) => (links.find((x) => x.id === id)?.value ?? 0) <= l.value + 1e-9);
      })
      .map((l) => l.id),
  );
  const usable = links.filter((l) => !closing.has(l.id) && tolSource(l.tol) !== "basic");
  const used = new Set<string>();
  for (const start of usable) {
    if (used.has(start.id)) continue;
    // Walk both ways from it: links sharing an end, along the same direction.
    const chain = [start];
    for (const dir of [0, 1] as const) {
      let end = dir === 0 ? start.to : start.from;
      for (;;) {
        const next = usable.find((l) => !chain.includes(l) && same(l, start) && (l.from === end || l.to === end));
        if (!next) break;
        if (dir === 0) chain.push(next);
        else chain.unshift(next);
        end = next.from === end ? next.to : next.from;
      }
    }
    if (chain.length < 2) continue;
    chain.forEach((l) => used.add(l.id));
    out.push({ ids: chain.map((l) => l.id), ...stackUp(chain, input.drawing, input.stackLimit) });
  }
  return out;
}

/** Dimensions that close a loop: an overall size given again by a chain of others (over-dimensioned). */
export function closedLoops(input: CriticInput): { id: string; via: string[] }[] {
  const anns = allAnnotations(input.drawing).filter((a): a is DimensionAnnotation => a.type === "dimension" && (a.kind === undefined || a.kind === "linear") && !!a.from && !!a.to);
  const composed = new Map(input.sheets.flatMap((s) => s.annotations).map((a) => [a.id, a]));
  const links = anns.flatMap((a) => {
    const c = composed.get(a.id);
    return c && !c.problem && c.along && c.value !== undefined && a.tolerance?.kind !== "reference" && a.tolerance?.kind !== "basic" ? [{ id: a.id, from: a.from!, to: a.to!, along: c.along, view: a.view, value: c.value }] : [];
  });
  const out: { id: string; via: string[] }[] = [];
  for (const l of links) {
    const others = links.filter((x) => x !== l && x.view === l.view && Math.abs(Math.abs(dot(x.along, l.along)) - 1) < 1e-6);
    const via = pathBetween(others, l.from, l.to);
    if (via && via.length >= 2 && via.every((id) => (links.find((x) => x.id === id)?.value ?? 0) <= l.value + 1e-9)) out.push({ id: l.id, via });
  }
  return out;
}

/** The links (ids) of a path from one point to another, or null. */
function pathBetween(links: { id: string; from: string; to: string }[], from: string, to: string): string[] | null {
  const seen = new Set<string>([from]);
  const queue: { at: string; path: string[] }[] = [{ at: from, path: [] }];
  while (queue.length) {
    const { at, path } = queue.shift()!;
    for (const l of links) {
      const other = l.from === at ? l.to : l.to === at ? l.from : null;
      if (!other || seen.has(other)) continue;
      if (other === to) return [...path, l.id];
      seen.add(other);
      queue.push({ at: other, path: [...path, l.id] });
    }
  }
  return null;
}

/**
 * One chain's stack: worst case = the sum of the links' half bands, RSS =
 * their root-sum-square, against the limit (given, else twice the general
 * tolerance of the span, at least 0.4 mm). ISO 2768-m: 20 + 30 + 30 is
 * ±0.2 ×3 = ±0.6 worst, ±0.35 RSS, against ±0.6 for 80 mm (2 × 0.3): within.
 */
export function stackUp(links: { value: number; tol: EffectiveTolerance }[], drawing: { generalTolerance?: string } | null, stackLimit?: number): Omit<Stack, "ids"> {
  const worst = links.reduce((t, l) => t + halfBand(l.tol), 0);
  const rss = Math.sqrt(links.reduce((t, l) => t + halfBand(l.tol) ** 2, 0));
  const span = links.reduce((t, l) => t + l.value, 0);
  const g = toleranceOf({ value: span }, drawing);
  const limit = stackLimit ?? Math.max(0.4, 2 * halfBand(g));
  return { span, worst, rss, limit, ok: worst <= limit + 1e-9 };
}

const tolSource = (t: EffectiveTolerance) => t.source;
