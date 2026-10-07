// The ask-if-missing rule (spec 5.1), in code rather than in the prompt:
// - A number counts as typed only if it is in the request. The model saying
//   "stated" is not enough; a number the request does not contain is a guess.
// - Hole diameter and thickness are ask-first: a guess is a blank.
// - Anything the part needs that is missing or under 0.8 confidence is a
//   blank the user fills in the confirmation card.
// - What the user typed is kept exactly; the planner never rounds it.
// - A frame's section is the user's words, matched against the section
//   library by code. The model never picks one (Phase K).

import { blank, emptyFrame, type FrameIntent, type HoleGroup, type Intent, type NumberField, type Placement, type PointsField } from "./schema";

export const CONFIDENT = 0.8;

/** Metric clearance holes (normal fit) and tap drills, for "M6 hole" and "M6 tapped". */
export const METRIC_CLEARANCE: Record<string, number> = { M2: 2.4, M2_5: 2.9, M3: 3.4, M4: 4.5, M5: 5.5, M6: 6.6, M8: 9, M10: 11, M12: 13.5, M16: 17.5, M20: 22 };
export const METRIC_TAP_DRILL: Record<string, number> = { M2: 1.6, M2_5: 2.05, M3: 2.5, M4: 3.3, M5: 4.2, M6: 5, M8: 6.8, M10: 8.5, M12: 10.2, M16: 14, M20: 17.5 };

export type RowKind = "number" | "placement" | "points" | "question" | "choice" | "text";

export interface Row {
  /** Where the value lives: "thickness", "holes[0].diameter", "holes[0].placement", "questions[1]". */
  path: string;
  label: string;
  kind: RowKind;
  /** For a choice row. */
  options?: { value: string; label: string }[];
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
  /** The request text. Numbers marked stated must appear in it (or on the drawing). */
  text?: string;
  /**
   * The request came with a drawing. `text` is its PDF text layer ("" for a
   * scan): a number read from a drawing that has one must be printed in it.
   * Nothing is trusted from a drawing too blurry to read.
   */
  drawing?: { text: string; legible: boolean };
  /** Paths the user filled in the card. */
  confirmed?: Set<string>;
  /** The sections a frame can be made of: the section library's sizes, and the part's own copies. */
  sections?: SectionOption[];
}

/** One size of one profile a frame can be built from. */
export interface SectionOption {
  /** What the card gives back: "lib|<library id>|<designation>" or "part|<profile>|<designation>". */
  value: string;
  /** The family ("SHS") and the size ("SHS 40x40x3"). */
  profile: string;
  designation: string;
  from: "library" | "part";
}

export const EMPTY_LIBRARY = "The section library is empty, so there is nothing to build the frame from. Draw the section as a sketch, tick Weldment profile, save it, then ask again.";

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

  if (intent.kind === "frame") {
    const fr = (intent.frame ??= emptyFrame());
    num(fr.length, "frame.length", "Length (X), outside", { required: true });
    num(fr.width, "frame.width", "Width (Y), outside", { required: true });
    if (fr.type === "table") num(fr.height, "frame.height", "Height, floor to top", { required: true });
    rows.push(sectionRow(fr, src, confirmed, problems), cornersRow(fr, src, confirmed));
    intent.holes = [];
  } else if (intent.kind === "plate") {
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

  intent.holes.forEach((h, i) => reviewHoles(h, i, intent, num, rows, problems, confirmed, src));

  const blanks = rows.filter((r) => r.blank);
  return { intent, rows, blanks, problems, ready: blanks.length === 0 && problems.length === 0 };
}

type Num = (f: NumberField, path: string, label: string, opts: { required: boolean; askFirst?: boolean; count?: boolean; optionalNote?: string }) => boolean;

function reviewHoles(h: HoleGroup, i: number, intent: Intent, num: Num, rows: Row[], problems: string[], confirmed: Set<string>, src: Source) {
  const p = `holes[${i}]`;
  const label = (s: string) => `Holes${intent.holes.length > 1 ? ` ${i + 1}` : ""}: ${s}`;
  // Where the holes go, read off a sheet nobody can read, is as invented as a number would be.
  const blurry = !!src.drawing && !src.drawing.legible && !confirmed.has(`${p}.placement`);
  if (blurry) h.placement = "unspecified";
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
    note: h.placement !== "unspecified" ? undefined : blurry ? TOO_BLURRY : `${from(src)} does not say where the holes go`,
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
      const { ok, why } = trustedPoints(h.points, `${p}.points`, confirmed, src);
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
        note: ok ? undefined : why,
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
  if (f.value === null || f.source === "missing") return { ok: false, why: `${from(src)} does not say` };
  if (!Number.isFinite(f.value)) return { ok: false, why: "not a number" };
  const conf = Math.max(0, Math.min(1, f.confidence));
  if (f.source === "inferred") return { ok: false, why: `a guess: ${from(src)} does not say` };
  if (conf < CONFIDENT) return { ok: false, why: `read with low confidence (${Math.round(conf * 100)}%)` };
  if (f.source === "standard") {
    return standardValue(f) ? { ok: true } : { ok: false, why: `"${f.evidence}" does not give ${f.value}` };
  }
  return printed(f.value, src, isCount);
}

/** A stated number must be written somewhere: in what the user typed, or on the drawing. */
function printed(v: number, src: Source, isCount: boolean): { ok: boolean; why?: string } {
  const has = (text?: string) => !!text && numbersIn(text, isCount).some((x) => Math.abs(x - v) <= 1e-9 * Math.max(1, Math.abs(x)));
  if (has(src.text)) return { ok: true };
  if (src.drawing) {
    if (!src.drawing.legible) return { ok: false, why: TOO_BLURRY };
    // A vector PDF says exactly what is printed on it; a scan has only the model's reading, at its confidence.
    if (src.drawing.text) return has(src.drawing.text) ? { ok: true } : { ok: false, why: `${v} is not printed on the drawing` };
    return { ok: true };
  }
  return { ok: false, why: src.text === undefined ? "nothing to check it against" : `${v} is not in the request` };
}

function trustedPoints(f: PointsField, path: string, confirmed: Set<string>, src: Source): { ok: boolean; why?: string } {
  if (confirmed.has(path)) return f.value?.length ? { ok: true } : { ok: false, why: "enter the positions" };
  if (!f.value?.length || f.source === "missing") return { ok: false, why: `${from(src)} does not give the hole positions` };
  if (f.source !== "stated") return { ok: false, why: `a guess: ${from(src)} does not give the hole positions` };
  if (f.confidence < CONFIDENT) return { ok: false, why: `read with low confidence (${Math.round(f.confidence * 100)}%)` };
  for (const pt of f.value) {
    for (const v of [pt.x, pt.y]) {
      const r = printed(v, src, false);
      if (!r.ok) return r;
    }
  }
  return { ok: true };
}

const TOO_BLURRY = "the drawing is too blurry to read this";
const from = (src: Source) => (src.drawing ? "the drawing" : "the request");

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

/** "SHS 40×40×3", "shs 40 x 40 x 3" and "SHS 40 by 40 by 3" are the same words. */
export function sectionKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+by\s+/g, "x")
    .replace(/[×*]/g, "x")
    .replace(/\s+/g, "");
}

/** The library sizes the user's words name: the same words, or the same numbers in the named family. */
export function matchSection(words: string, options: SectionOption[]): SectionOption[] {
  const key = sectionKey(words);
  const exact = options.filter((o) => sectionKey(o.designation) === key);
  if (exact.length) return exact;
  const nums = numbersIn(words);
  if (!nums.length) return [];
  const families = [...new Set(options.map((o) => o.profile.toLowerCase()))].filter((f) => new RegExp(`\\b${f.replace(/[^a-z0-9]/g, "")}\\b`).test(words.toLowerCase()));
  return options.filter((o) => {
    if (families.length && !families.includes(o.profile.toLowerCase())) return false;
    const own = numbersIn(o.designation);
    return own.length === nums.length && own.every((x, i) => Math.abs(x - nums[i]) < 1e-9);
  });
}

/** The section: the request's words, found in the library. Never a guess. */
function sectionRow(fr: FrameIntent, src: Source, confirmed: Set<string>, problems: string[]): Row {
  const options = src.sections ?? [];
  if (!options.length) problems.push(EMPTY_LIBRARY);
  const words = fr.section.value;
  const row: Row = {
    path: "frame.section",
    label: "Section",
    kind: "choice",
    options: options.map((o) => ({ value: o.value, label: o.from === "part" ? `${o.designation} (this part)` : o.designation })),
    value: null,
    unit: "",
    evidence: fr.section.evidence,
    source: fr.section.source,
    confidence: fr.section.confidence,
    blank: true,
  };
  const chosen = options.find((o) => o.value === words);
  // Chosen in the card, or already matched on an earlier pass: an option's own value.
  if (chosen) return { ...row, value: chosen.value, source: confirmed.has(row.path) ? "entered" : "stated", blank: false };
  fr.section.value = null;
  if (!words || fr.section.source === "missing") return { ...row, note: "the request does not name a section" };
  if (!src.text || !sectionKey(src.text).includes(sectionKey(words))) return { ...row, note: `a guess: the request does not say "${words}"` };
  if (fr.section.confidence < CONFIDENT) return { ...row, note: `read with low confidence (${Math.round(fr.section.confidence * 100)}%)` };
  const found = matchSection(words, options);
  if (found.length === 1) {
    fr.section.value = found[0].value;
    return { ...row, value: found[0].value, blank: false, note: `${found[0].designation}, from ${found[0].from === "part" ? "this part" : "the section library"}` };
  }
  return {
    ...row,
    note: found.length ? `"${words}" could be ${found.map((o) => o.designation).join(" or ")}: choose one` : `"${words}" is not in the section library: choose one, or add it there first`,
  };
}

/** How the corners are joined: stated in the request, or chosen in the card. */
function cornersRow(fr: FrameIntent, src: Source, confirmed: Set<string>): Row {
  const read = fr.corners;
  const said = read === "mitre" ? /\bmit(re|er)/i : read === "butt" ? /\bbutt/i : null;
  const ok = !!said && (confirmed.has("frame.corners") || said.test(src.text ?? ""));
  if (!ok) fr.corners = "unspecified";
  return {
    path: "frame.corners",
    label: "Corners",
    kind: "choice",
    options: [
      { value: "mitre", label: "Mitred" },
      { value: "butt", label: fr.type === "table" ? "Butt: the legs run through" : "Butt: the long sides run through" },
    ],
    value: ok ? fr.corners : null,
    unit: "",
    evidence: "",
    source: confirmed.has("frame.corners") ? "entered" : ok ? "stated" : "missing",
    confidence: ok ? 1 : 0,
    blank: !ok,
    note: ok ? undefined : said ? `a guess: the request does not say ${read}` : "the request does not say how the corners are joined",
  };
}

/** The intent with the user's answers from the card filled in. */
export function answerIntent(intent: Intent, answers: Record<string, number | string | { x: number; y: number }[]>): { intent: Intent; confirmed: Set<string> } {
  const next = structuredClone(intent);
  const confirmed = new Set<string>();
  for (const [path, value] of Object.entries(answers)) {
    const m = /^holes\[(\d+)\]\.(\w+)$/.exec(path);
    const q = /^questions\[(\d+)\]$/.exec(path);
    const fr = /^frame\.(\w+)$/.exec(path);
    if (fr) {
      const frame = (next.frame ??= emptyFrame()) as unknown as Record<string, unknown>;
      frame[fr[1]] = fr[1] === "corners" ? value : { value, evidence: "entered in the card", source: "stated", confidence: 1 };
      confirmed.add(path);
      continue;
    }
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
    // Positions typed in are the placement, too.
    if (m && key === "points") {
      holder.placement = "points";
      confirmed.add(`holes[${m[1]}].placement`);
    }
    confirmed.add(path);
  }
  return { intent: next, confirmed };
}

export { blank };
