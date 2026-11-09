// The drawing packet v2 (Phase Q wave Q3B): what a drawing ask is told about
// the drawing and the part behind it, compactly. Per view: its kind, scale
// and what it shows, and every GeoRef it offers as one short line ("top:
// ebolt_hole/c0 circle Ø6.6 bolt_hole (counterbored M6)"); the part's
// features, parameters and design intent; every annotation with what it
// reads and its effective tolerance (toleranceOf); the general tolerance;
// the critic's findings. Its size is measured (about four characters a
// token) and kept within a budget: long GeoRef lists are cut per view (the
// rest summarised by kind) until the whole sheet fits. A small local model
// gets the compact budget.

import type { RawDocument } from "../../doc/commands";
import { allAnnotations } from "../../doc/drawing";
import { documentParameters } from "../../doc/parameters";
import { validateDocument } from "../../doc/validate";
import { listGeoRefs } from "../../drafting/georef";
import { toleranceOf } from "../../drafting/tolerance";
import { findingsOf } from "./auto";
import type { DetailState } from "./execute";
import type { DesignIntent } from "./intent";

/** Tokens a packet may take: a whole sheet for Claude, and for a small local model. */
export const PACKET_BUDGET = { full: 12000, compact: 3500 } as const;

/** About how many tokens a JSON value takes (four characters a token, as the API counts English and JSON roughly). */
export function packetTokens(x: unknown): number {
  return Math.ceil(JSON.stringify(x).length / 4);
}

export interface DrawingContext {
  design: Record<string, unknown>;
  model: { features: string[]; parameters?: Record<string, number> };
  standard: string;
  generalTolerance: string | null;
  views: { id: string; kind: string; look: string; scale: string; label?: string; parent?: string; geoRefs: string[]; more?: string }[];
  annotations: string[];
  findings: string[];
  /** Its size, tokens, and what was cut to keep it in budget. */
  tokens: number;
  trimmed?: string;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** A feature in a line: "hole_1 hole Ø6.6 thru (clearance M6)". */
function featureLine(f: Record<string, unknown>, intent: DesignIntent): string {
  const id = String(f.id);
  const op = String(f.op);
  const bits: string[] = [];
  for (const k of ["size", "diameter", "distance", "depth", "radius", "count", "profile", "from", "to", "type", "node"]) {
    const v = f[k];
    if (typeof v === "number" || typeof v === "string") bits.push(`${k} ${typeof v === "number" ? r2(v) : v}`);
  }
  const h = intent.holes.find((x) => x.makers.includes(id));
  const b = intent.bores.find((x) => x.feature === id);
  const why = h ? ` (${h.purpose}${h.fit ? ` ${h.pair ?? h.fit}` : ""}${h.size ? ` ${h.size}` : ""})` : b ? ` (bore Ø${b.diameter} ${b.pair})` : "";
  return `${id} ${op}${bits.length ? ` ${bits.join(", ")}` : ""}${why}`;
}

/** The context for a drawing ask, within the budget; `view` keeps to one view. */
export function drawingContext(state: DetailState, intent: DesignIntent, opts: { compact?: boolean; view?: string; findings?: boolean } = {}): DrawingContext | null {
  const { sheet, drawing } = state;
  if (!sheet || !drawing) return null;
  const doc: RawDocument = state.doc;
  const v = validateDocument(doc);
  const budget = opts.compact ? PACKET_BUDGET.compact : PACKET_BUDGET.full;
  const params = documentParameters(doc) as Record<string, unknown>;
  const numbers = Object.fromEntries(Object.entries(params).filter(([, x]) => typeof x === "number")) as Record<string, number>;
  const design = {
    kind: intent.kind,
    summary: intent.summary,
    holes: intent.holes.map((h) => `${h.features.join("+")}: ${h.count}× Ø${h.diameter} ${h.purpose}${h.size ? ` ${h.size}` : ""}${h.pattern !== "single" ? `, ${h.pattern} pattern` : ""}${h.fit ? `, ${h.fit}${h.pair && h.pair !== h.fit ? ` (fit ${h.pair})` : ""}` : ""} — ${h.why}`),
    bores: intent.bores.map((b) => `${b.feature}: bore Ø${b.diameter} ${b.purpose}, ${b.fit} (fit ${b.pair}) — ${b.why}`),
    ...(intent.kind === "weldment" ? { joints: intent.joints.map((j) => `${j.id}: ${j.type} at ${j.node} (${j.members.join(", ")})`), welds: intent.welds } : {}),
  };
  const model = { features: v.features.flatMap((f) => (f.feature ? [featureLine(f.feature as unknown as Record<string, unknown>, intent)] : [])), ...(Object.keys(numbers).length ? { parameters: numbers } : {}) };
  const composed = new Map(sheet.annotations.map((a) => [a.id, a]));
  const annotations = allAnnotations(drawing)
    .filter((a) => !opts.view || ("view" in a && a.view === opts.view))
    .filter((a) => a.type !== "centerMark" && a.type !== "centerline")
    .map((a) => {
      const c = composed.get(a.id);
      const where = "view" in a && a.view ? ` in ${a.view}` : "";
      if (c?.problem) return `${a.id} ${a.type}${where}: NOT DRAWN (${c.problem})`;
      let tol = "";
      if (a.type === "dimension" && c?.value !== undefined) {
        const t = toleranceOf({ value: c.value, kind: a.kind, tolerance: a.tolerance, places: a.precision }, drawing);
        tol = ` [${t.source}: ${t.text}]`;
      }
      const at = a.type === "dimension" ? ` ${[a.from, a.to].filter(Boolean).join("→") || (a.refs ?? []).join(",") || a.member || ""}` : a.type === "hole" ? ` ${a.hole}` : a.type === "gdt" ? ` ${a.dimension ? `on ${a.dimension}` : a.on ?? ""}` : a.type === "datum" ? ` ${a.on ?? a.dimension ?? ""}` : "";
      return `${a.id} ${a.type}${where}${at}: "${(c?.text ?? "").replace(/\n/g, " / ")}"${tol}`;
    });
  const views = sheet.views.filter((cv) => !opts.view || cv.id === opts.view || cv.id === sheet.views.find((x) => x.id === opts.view)?.parent);
  const refsOf = new Map(
    views.map((cv) => [
      cv.id,
      listGeoRefs(sheet, cv.id).map((r) => {
        const h = r.feature ? intent.holes.find((x) => x.makers.includes(r.feature!)) : undefined;
        const size = r.radius !== undefined ? ` Ø${r2(2 * r.radius)}` : r.length !== undefined ? ` L${r2(r.length)}` : "";
        return { visible: r.visible, line: `${r.ref} ${r.what}${size}${r.feature ? ` ${r.feature}${h ? ` (${h.purpose}${h.size ? ` ${h.size}` : ""})` : ""}` : ""}${r.visible ? "" : " hidden"}` };
      }),
    ]),
  );
  const findings = opts.findings === false ? [] : findingsOf(state).map((f) => `${f.severity}: ${f.message}`);
  const build = (limit: number, annLimit: number): DrawingContext => {
    const vs = views.map((cv) => {
      const all = refsOf.get(cv.id) ?? [];
      // Seen ones first: hidden lines are not dimensioned to.
      const sorted = [...all.filter((r) => r.visible), ...all.filter((r) => !r.visible)];
      const kept = sorted.slice(0, limit).map((r) => r.line);
      const rest = sorted.slice(limit);
      const kinds = new Map<string, number>();
      for (const r of rest) {
        const k = r.line.split(" ")[1];
        kinds.set(k, (kinds.get(k) ?? 0) + 1);
      }
      return {
        id: cv.id,
        kind: cv.kind,
        look: cv.look,
        scale: cv.scaleText,
        ...(cv.label ? { label: cv.label } : {}),
        ...(cv.parent ? { parent: cv.parent } : {}),
        geoRefs: kept,
        ...(rest.length ? { more: `${rest.length} more (${[...kinds].map(([k, n]) => `${n} ${k}`).join(", ")}): geoRefs(view) lists them` } : {}),
      };
    });
    const anns = annotations.slice(0, annLimit);
    const out: DrawingContext = {
      design,
      model,
      standard: drawing.standard ?? "ISO",
      generalTolerance: drawing.generalTolerance ?? null,
      views: vs,
      annotations: annotations.length > annLimit ? [...anns, `… and ${annotations.length - annLimit} more`] : anns,
      findings: findings.slice(0, opts.compact ? 8 : 20),
      tokens: 0,
    };
    out.tokens = packetTokens(out);
    return out;
  };
  // Shrink until it fits: GeoRefs per view first, then the annotations listed.
  let limit = opts.compact ? 30 : 80;
  let annLimit = opts.compact ? 40 : 200;
  let out = build(limit, annLimit);
  while (out.tokens > budget && (limit > 6 || annLimit > 10)) {
    if (limit > 6) limit = Math.max(6, Math.floor(limit / 2));
    else annLimit = Math.max(10, Math.floor(annLimit / 2));
    out = build(limit, annLimit);
    out.trimmed = `GeoRefs cut to ${limit} per view${annLimit < annotations.length ? `, annotations to ${annLimit}` : ""} to keep within ${budget} tokens`;
    out.tokens = packetTokens(out);
  }
  return out;
}
