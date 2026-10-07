// The ask-if-missing rule (spec 5.1), in code rather than in the prompt:
// - A number counts as typed only if it is in the request. The model saying
//   "stated" is not enough; a number the request does not contain is a guess.
// - Hole diameter and thickness are ask-first: a guess is a blank.
// - Anything the part needs that is missing or under 0.8 confidence is a
//   blank the user fills in the confirmation card.
// - What the user typed is kept exactly; the planner never rounds it.

import { blank, type HoleGroup, type Intent, type NumberField, type Placement, type PointsField } from "./schema";

export const CONFIDENT = 0.8;

/** Metric clearance holes (normal fit) and tap drills, for "M6 hole" and "M6 tapped". */
export const METRIC_CLEARANCE: Record<string, number> = { M2: 2.4, M2_5: 2.9, M3: 3.4, M4: 4.5, M5: 5.5, M6: 6.6, M8: 9, M10: 11, M12: 13.5, M16: 17.5, M20: 22 };
export const METRIC_TAP_DRILL: Record<string, number> = { M2: 1.6, M2_5: 2.05, M3: 2.5, M4: 3.3, M5: 4.2, M6: 5, M8: 6.8, M10: 8.5, M12: 10.2, M16: 14, M20: 17.5 };

export type RowKind = "number" | "placement" | "points" | "question";

export interface Row {
  /** Where the value lives: "thickness", "holes[0].diameter", "holes[0].placement", "questions[1]". */
  path: string;
  label: string;
  kind: RowKind;
  value: number | string | { x: number; y: number }[] | null;
  unit: string;
  evidence: string;
  source: string;
  confidence: number;
  /** The user must fill it before the part is built. */
  blank: boolean;
  /** Why it is blank, or what default was used. */
  note?: string;
  askFirst?: boolean;
}

export interface Review {
  /** The intent with every untrusted value removed. */
  intent: Intent;
  rows: Row[];
  blanks: Row[];
  /** Things no answer in the card can fix (a corner pattern on a disc). */
  problems: string[];
  ready: boolean;
}

export interface Source {
  /** The request text. Numbers marked stated must appear in it. */
  text?: string;
  /** The request came with a drawing: printed numbers are trusted at high confidence. */
  drawing?: boolean;
  /** Paths the user filled in the card. */
  confirmed?: Set<string>;
}

export function reviewIntent(input: Intent, src: Source): Review {
  const intent = structuredClone(input);
  const rows: Row[] = [];
  const problems: string[] = [];
  const confirmed = src.confirmed ?? new Set<string>();
  const unit = intent.units;

  /** Checks a number field; returns whether it is usable, and records the row. */
  const num = (f: NumberField, path: string, label: string, opts: { required: boolean; askFirst?: boolean; count?: boolean; optionalNote?: string }): boolean => {
    const trust = trusted(f, path, confirmed, src, opts.count ?? false);
    const usable = trust.ok && f.value !== null;
    if (!usable) {
      f.value = null;
    }
    const isBlank = opts.required && !usable;
    rows.push({
      path,
      label,
      kind: "number",
      value: usable ? f.value : null,
      unit: opts.count ? "" : unit,
      evidence: f.evidence,
      source: confirmed.has(path) ? "entered" : f.source,
      confidence: f.confidence,
      blank: isBlank,
      askFirst: opts.askFirst,
      note: isBlank ? trust.why : !usable && opts.optionalNote ? opts.optionalNote : undefined,
    });
    return usable;
  };

  if (intent.action !== "create") return { intent, rows, blanks: [], problems, ready: true };

  if (intent.kind === "plate") {
    num(intent.width, "width", "Width (X)", { required: true });
    num(intent.height, "height", "Height (Y)", { required: true });
    num(intent.thickness, "thickness", "Thickness", { required: true, askFirst: true });
    num(intent.cornerRadius, "cornerRadius", "Corner radius", { required: false, optionalNote: "not given: sharp corners" });
  } else if (intent.kind === "disc") {
    num(intent.diameter, "diameter", "Diameter", { required: true });
    num(intent.thickness, "thickness", "Thickness", { required: true, askFirst: true });
  } else {
    if (!intent.description.trim()) problems.push("Say what the part is.");
    intent.questions.forEach((q, i) => {
      const path = `questions[${i}]`;
      rows.push({ path, label: q, kind: "question", value: null, unit: "", evidence: "", source: "missing", confidence: 0, blank: !confirmed.has(path) });
    });
  }

  intent.holes.forEach((h, i) => reviewHoles(h, i, intent, num, rows, problems, confirmed));

  const blanks = rows.filter((r) => r.blank);
  return { intent, rows, blanks, problems, ready: blanks.length === 0 && problems.length === 0 };
}

type Num = (f: NumberField, path: string, label: string, opts: { required: boolean; askFirst?: boolean; count?: boolean; optionalNote?: string }) => boolean;

function reviewHoles(h: HoleGroup, i: number, intent: Intent, num: Num, rows: Row[], problems: string[], confirmed: Set<string>) {
  const p = `holes[${i}]`;
  const label = (s: string) => `Holes${intent.holes.length > 1 ? ` ${i + 1}` : ""}: ${s}`;
  num(h.diameter, `${p}.diameter`, label("diameter"), { required: true, askFirst: true });
  num(h.depth, `${p}.depth`, label("depth"), { required: false, optionalNote: "not given: through" });

  const placementRow: Row = {
    path: `${p}.placement`,
    label: label("where"),
    kind: "placement",
    value: h.placement === "unspecified" ? null : h.placement,
    unit: "",
    evidence: "",
    source: confirmed.has(`${p}.placement`) ? "entered" : h.placement === "unspecified" ? "missing" : "stated",
    confidence: h.placement === "unspecified" ? 0 : 1,
    blank: h.placement === "unspecified",
    note: h.placement === "unspecified" ? "the request does not say where the holes go" : undefined,
  };
  rows.push(placementRow);
  if (intent.kind === "disc" && (h.placement === "corners" || h.placement === "grid")) {
    problems.push(`${label("where")}: a disc has no corners or grid; use centre, circle or points.`);
  }

  switch (h.placement) {
    case "corners":
      num(h.inset, `${p}.inset`, label("distance from the edges"), { required: true });
      fixCount(h, 4, `${p}.count`, label("count"), rows, problems);
      break;
    case "center":
      fixCount(h, 1, `${p}.count`, label("count"), rows, problems);
      break;
    case "grid": {
      const r = num(h.rows, `${p}.rows`, label("rows"), { required: true, count: true });
      const c = num(h.columns, `${p}.columns`, label("columns"), { required: true, count: true });
      if (c && h.columns.value! > 1) num(h.pitchX, `${p}.pitchX`, label("pitch along X"), { required: true });
      if (r && h.rows.value! > 1) num(h.pitchY, `${p}.pitchY`, label("pitch along Y"), { required: true });
      if (r && c) fixCount(h, h.rows.value! * h.columns.value!, `${p}.count`, label("count"), rows, problems);
      break;
    }
    case "points": {
      const ok = trustedPoints(h.points, `${p}.points`, confirmed);
      if (!ok) h.points.value = null;
      rows.push({
        path: `${p}.points`,
        label: label(intent.kind === "disc" ? "centres from the disc centre" : "centres from the lower-left corner"),
        kind: "points",
        value: ok ? h.points.value : null,
        unit: intent.units,
        evidence: h.points.evidence,
        source: confirmed.has(`${p}.points`) ? "entered" : h.points.source,
        confidence: h.points.confidence,
        blank: !ok,
        note: ok ? undefined : "the request does not give the hole positions",
      });
      if (ok) fixCount(h, h.points.value!.length, `${p}.count`, label("count"), rows, problems);
      break;
    }
    case "circle":
      num(h.circleDiameter, `${p}.circleDiameter`, label("circle diameter"), { required: true });
      num(h.count, `${p}.count`, label("count"), { required: true, count: true });
      break;
    case "unspecified":
      num(h.count, `${p}.count`, label("count"), { required: true, count: true });
      break;
  }
}

/** A placement that implies the count: a stated count must agree with it. */
function fixCount(h: HoleGroup, n: number, path: string, label: string, rows: Row[], problems: string[]) {
  if (h.count.value !== null && h.count.value !== n && h.count.source !== "missing") {
    problems.push(`${label}: the request says ${h.count.value}, but that placement makes ${n}.`);
  }
  h.count = { value: n, evidence: h.count.evidence, source: h.count.source === "missing" ? "inferred" : h.count.source, confidence: 1 };
  rows.push({ path, label, kind: "number", value: n, unit: "", evidence: h.count.evidence, source: "placement", confidence: 1, blank: false });
}

/** Whether a value can be used without asking, and if not, why. */
function trusted(f: NumberField, path: string, confirmed: Set<string>, src: Source, isCount: boolean): { ok: boolean; why?: string } {
  if (confirmed.has(path)) return { ok: f.value !== null, why: "enter a value" };
  if (f.value === null || f.source === "missing") return { ok: false, why: "the request does not say" };
  if (!Number.isFinite(f.value)) return { ok: false, why: "not a number" };
  const conf = Math.max(0, Math.min(1, f.confidence));
  if (f.source === "inferred") return { ok: false, why: "a guess: the request does not say" };
  if (conf < CONFIDENT) return { ok: false, why: `read with low confidence (${Math.round(conf * 100)}%)` };
  if (f.source === "standard") {
    return standardValue(f) ? { ok: true } : { ok: false, why: `"${f.evidence}" does not give ${f.value}` };
  }
  // Stated: the number has to be in what the user wrote. A drawing's numbers are trusted at high confidence (Phase F checks them against the page).
  if (src.text === undefined) return src.drawing ? { ok: true } : { ok: false, why: "nothing to check it against" };
  if (numbersIn(src.text, isCount).some((x) => Math.abs(x - f.value!) <= 1e-9 * Math.max(1, Math.abs(x)))) return { ok: true };
  if (src.drawing) return { ok: true };
  return { ok: false, why: `${f.value} is not in the request` };
}

function trustedPoints(f: PointsField, path: string, confirmed: Set<string>): boolean {
  if (confirmed.has(path)) return !!f.value?.length;
  return !!f.value?.length && f.source === "stated" && f.confidence >= CONFIDENT;
}

/** "M6" in the evidence names the value: its clearance hole or tap drill. */
function standardValue(f: NumberField): boolean {
  const m = /\bM(\d+(?:\.\d+)?)\b/i.exec(f.evidence);
  if (!m) return false;
  const key = `M${m[1].replace(".", "_")}`;
  return [METRIC_CLEARANCE[key], METRIC_TAP_DRILL[key]].some((v) => v !== undefined && Math.abs(v - f.value!) < 1e-9);
}

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, single: 1, pair: 2, a: 1, an: 1 };

/** Every number written in the text: 6, 6.6, .5, 1/4, and for counts, number words. */
export function numbersIn(text: string, words = false): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?<![\d.])(\d+(?:\.\d+)?|\.\d+)(?:\s*\/\s*(\d+))?/g)) {
    const a = Number(m[1]);
    out.push(m[2] ? a / Number(m[2]) : a);
    if (m[2]) out.push(a, Number(m[2]));
  }
  if (words) {
    for (const m of text.toLowerCase().matchAll(/\b[a-z]+\b/g)) if (m[0] in WORDS && m[0] !== "a" && m[0] !== "an") out.push(WORDS[m[0]]);
  }
  return out;
}

/** The intent with the user's answers from the card filled in. */
export function answerIntent(intent: Intent, answers: Record<string, number | string | { x: number; y: number }[]>): { intent: Intent; confirmed: Set<string> } {
  const next = structuredClone(intent);
  const confirmed = new Set<string>();
  for (const [path, value] of Object.entries(answers)) {
    const m = /^holes\[(\d+)\]\.(\w+)$/.exec(path);
    const q = /^questions\[(\d+)\]$/.exec(path);
    if (q) {
      next.questions[Number(q[1])] = `${next.questions[Number(q[1])]} — ${String(value)}`;
      confirmed.add(path);
      continue;
    }
    const holder = (m ? next.holes[Number(m[1])] : next) as unknown as Record<string, unknown>;
    const key = m ? m[2] : path;
    if (!holder) continue;
    if (key === "placement") holder.placement = value as Placement;
    else holder[key] = { value, evidence: "entered in the card", source: "stated", confidence: 1 };
    confirmed.add(path);
  }
  return { intent: next, confirmed };
}

export { blank };
