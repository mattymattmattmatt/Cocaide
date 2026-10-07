// The part-level prompt (spec 5.1, 6, Phase E): a right-click on empty space,
// or a dropped drawing. Its scope is the whole part, so it never applies
// itself: it answers, proposes an edit, or proposes a new part.
//
// A new part goes request -> intent -> review (ask if missing) -> plan ->
// rebuild -> critic -> at most one correction -> proposal. When the review
// finds missing numbers it asks for them instead of guessing; the answers
// come back through continuePartAsk.
//
// A drawing (spec 5.2) goes rasterised pages -> structured reading ->
// confirmation card, always: nothing is built until the user confirms the
// numbers against the drawing.
//
// A photo (spec 5.3) goes reading in pixels -> sizes scaled from one known
// dimension -> a proposal pinned over the photo. Every size is an estimate;
// the part is not exported until the user confirms the scale on the photo.

import type Anthropic from "@anthropic-ai/sdk";
import type { RawDocument } from "../doc/commands";
import type { PreparedDrawing } from "../drawing/rasterize";
import { critique, critiqueFrame, type Critique } from "../intent/critic";
import { frameWords, planFrame } from "../intent/frame";
import { answerDrawing, DrawingReading, reviewDrawing } from "../intent/drawing";
import { PhotoReading, planPhoto } from "../intent/photo";
import type { PreparedPhoto } from "../photo/prepare";
import { planPart, type Plan } from "../intent/plan";
import { answerIntent, reviewIntent, type Review, type SectionOption } from "../intent/review";
import { Intent } from "../intent/schema";
import { round6 } from "../kernel/inspect";
import type { ProfileDef } from "../doc/types";
import { partCopy, type LibraryEntry } from "../weldment/library";
import { diffDocs, runAsk, type AskEvent, type AskResult, type Proposal } from "./agent";
import type { KernelPort } from "./kernel";
import type { AskModel } from "./model";
import { classify } from "./prompt";

/** A dropped drawing, rasterised at 200 dpi with its text layer and legibility (src/drawing/rasterize.ts). */
export type Drawing = PreparedDrawing;

/** A dropped photo, scaled to the model's image size (src/photo/prepare.ts). */
export type Photo = PreparedPhoto;

export interface PartAskRequest {
  doc: RawDocument;
  text: string;
  drawing?: Drawing;
  photo?: Photo;
  model: AskModel;
  kernel: KernelPort;
  signal?: AbortSignal;
  onEvent?(e: AskEvent | { type: "intent"; intent: Intent }): void;
  /** The section library in this browser: what a frame can be made of (Phase K). */
  library?: LibraryEntry[];
}

export interface PartAskResult extends AskResult {
  /** For a new part: what was read, and the review of it (the confirmation card). */
  intent?: Intent;
  review?: Review;
  /** Paths the user has filled in the card so far. */
  confirmed?: string[];
  critique?: Critique;
  /** From a drawing: what was read from the sheet, and the views found. */
  reading?: DrawingReading;
  views?: string[];
  /** From a photo: what was read, in its pixels. */
  photoReading?: PhotoReading;
}

export const INTENT_SYSTEM = `You read requests for mechanical parts in Cocaide, a parametric CAD program, into intent JSON. You do not design the part; a planner does that from your intent, and the user confirms anything you are not sure of.

action: "create" when the request describes a part to make (always when there is no current part, or a drawing is attached and the request does not say otherwise); "edit" when it asks to change the current part; "answer" when it is a question.
kind: "plate" (rectangular, possibly with rounded corners), "disc" (round), "frame" (a weldment of structural members: a table frame, a rectangular frame), or "other" (anything else; describe it in description).

Every number is a field: { value, evidence, source, confidence }.
- value: the number, in the units the user used. Never round, never convert, never "tidy" a number: 6.6 stays 6.6.
- source "stated": the number is written in the request (or printed on the drawing). evidence: the exact words, e.g. "6.6 holes".
- source "standard": derived from a standard size the user named. Only metric screws: "M6 clearance" is 6.6, "M6 tapped" is 5 (M3 3.4/2.5, M4 4.5/3.3, M5 5.5/4.2, M8 9/6.8, M10 11/8.5). evidence: the words, e.g. "M6".
- source "inferred": your guess. source "missing" with value null: nobody said. Do not guess numbers that change the part: thickness and hole diameter in particular must be stated or left missing. A missing number is asked, not invented.
- confidence: how sure you are of the reading, 0 to 1. Below 0.8 the user is asked.
Unused fields: value null, evidence "", source "missing", confidence 0.

Plates: width is along X, height along Y, thickness along Z. "80 x 40 x 6" is width 80, height 40, thickness 6.
Holes come in groups with one diameter each. List every group the request mentions, even with no numbers: "some holes" is one group with its diameter, count and placement missing. placement:
- "corners": one hole near each corner; inset is the distance from each of the two nearest edges to the hole centre ("8 mm from corners": inset 8). Count is 4.
- "center": one hole in the middle.
- "grid": rows (along Y) x columns (along X) at pitchX / pitchY, centred on the part.
- "circle": count holes evenly on a circle of circleDiameter, centred.
- "points": explicit centres, from the plate's lower-left corner (x right, y up); for a disc, from its centre.
- "unspecified": the request does not say where.
depth: null value for through holes (the usual case).
units: "in" only if the user wrote inches; otherwise "mm".
frame: null unless kind is "frame". For a frame:
- type "table": a rectangle on top with a leg at each corner. "rectangle": one flat rectangular frame.
- length along X, width along Y, height (tables) floor to top; all outside sizes. "1200 × 600 table frame, 900 high" is length 1200, width 600, height 900.
- section: the section exactly as the user wrote it ("SHS 40×40×3"), with source "stated"; value null and source "missing" if the request does not name one. Never choose a section yourself: code finds it in the user's section library.
- corners: "mitre" or "butt" only if the request says so; else "unspecified".
holes: [] for a frame.
questions: what you would need to ask before the part can be made, one short question each.`;

export const DRAWING_SYSTEM = `You read 2D engineering drawings for Cocaide, a parametric CAD program, into a structured reading. You do not design the part: the user checks your reading on a confirmation card, then a planner builds it.

Report what is on the sheet, field by field: { value, evidence, source, confidence }.
- evidence: the exact text on the drawing the value comes from ("Ø6.6 THRU", "80", "UNITS: mm"), or "inferred".
- source "stated": printed on the drawing. "inferred": your deduction (for example a dimension computed from two others). "missing": not on the drawing, value null.
- confidence: how sure you are of the reading. Under 0.8 the user is asked. If the scan is hard to read, say so with low confidence or missing; never guess a number you cannot read.
- Never round or convert: report numbers as printed, in the title block's units.

views: every view on the sheet (top, front, side, section, detail, isometric), with its label.
projection: from the projection symbol or note ("THIRD ANGLE PROJECTION").
units, title (the part name), drawingNumber, material: from the title block, as written. The material is a note; quote it.
notes: thickness notes and other notes, quoted.
partsShown: how many distinct parts the sheet shows.

part: the part as intent. Map the views to the part: the top view gives the outline (width along X, height along Y) and the holes; a front, side or section view or a thickness note gives the thickness. Do not invent geometry no view shows.
- kind "plate" for a flat rectangular outline, "disc" for a round one, "other" for anything else.
- Holes: one group per callout ("4X Ø6.6 THRU" is one group, count 4). placement "points" with centres measured from the outline's lower-left corner (x right, y up) when the drawing dimensions hole positions from the edges; "corners" with inset when it dimensions them as an equal inset from both edges at each corner; "circle" for holes on a pitch circle; "center" for one central hole. depth: null value for THRU.
- action "create". questions: anything the drawing leaves out that the part needs.`;

export const PHOTO_SYSTEM = `You read photos of mechanical parts for Cocaide, a parametric CAD program, into a structured reading. A photo has no scale and is never a source of dimensions: report what you see in the photo's pixels, and code turns them into millimetres from one dimension the user knows.

category: "prismatic" (flat faces and straight cuts), "turned" (round, made on a lathe), "freeform" (organic, sculpted curves), or "not-a-part". evidence: what in the photo says so.
view: "face-on" when the camera looks straight at the face with the outline, else "oblique".
kind: "plate" for a flat part with a rectangular outline, "disc" for a flat round one, "other" for anything else.
outline: the box around that face in pixels (x right, y down), tight to its edges.
holes: each hole through that face: centre x, y and diameter, in pixels.
thickness: two points across the part's thickness, only where the photo shows an edge side-on; null when it doesn't (a photo from straight above doesn't). Never guess it.
typedThickness: the thickness only if the user's note gives it, with the words they used; else value null.
scale: the one known dimension.
- If the user's note gives a size ("the long edge is 80 mm"), use it: source "typed", length and units as typed, and dimension "width" (left to right), "height" (top to bottom) or "diameter" when it is that size of the outline; else "none" with from and to on the two ends of what they measured.
- Else, if a reference of known size is in the photo (a rule, a tape), use two marks on it: source "reference", the length between the marks as printed on it, dimension "none".
- Else give your best guess of the part's longest side: source "guess", dimension "width" or "height".
Never round or convert. notes: anything else that matters, briefly.`;

/** Runs a part-level ask: answer, edit proposal, new-part proposal, or questions. */
export async function runPartAsk(req: PartAskRequest): Promise<PartAskResult> {
  const base = { target: { kind: "part" } as const, doc: req.doc, model: req.model, kernel: req.kernel, signal: req.signal, onEvent: req.onEvent };
  if (req.photo) return readPhoto(req, req.photo);
  if (req.drawing) return readDrawing(req, req.drawing);
  if (classify(req.text) === "explain") return runAsk({ ...base, text: req.text, mode: "explain" });

  let intent: Intent;
  try {
    req.onEvent?.({ type: "thinking", turn: 1 });
    const raw = await req.model.readIntent({ system: INTENT_SYSTEM, content: intentContent(req) }, req.signal);
    const parsed = Intent.safeParse(raw);
    if (!parsed.success) return failed(req, `The model's reading did not fit the intent schema: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    intent = parsed.data;
  } catch (e) {
    return failed(req, req.signal?.aborted ? "Cancelled." : `Could not read the request: ${(e as Error).message}`);
  }
  req.onEvent?.({ type: "intent", intent });

  if (intent.action === "answer") return runAsk({ ...base, text: req.text, mode: "explain" });
  if (intent.action === "edit" && req.doc.features.length > 0) return runAsk({ ...base, text: req.text, mode: "edit" });
  return createFrom(req, { ...intent, action: "create" }, new Set(), false);
}

/** What a frame can be made of: every size in the section library, and the part's own copies that aren't from it. */
export function sectionOptions(doc: RawDocument, library: LibraryEntry[] = []): SectionOption[] {
  const out: SectionOption[] = [];
  for (const e of library) for (const s of e.sizes) out.push({ value: `lib|${e.id}|${s.designation}`, profile: e.name, designation: s.designation, from: "library" });
  const ids = new Set(library.map((e) => e.id));
  for (const [name, p] of Object.entries((doc.profiles ?? {}) as Record<string, ProfileDef>)) {
    if (p.library && ids.has(p.library.id)) continue;
    for (const s of p.sizes) out.push({ value: `part|${name}|${s.designation}`, profile: name, designation: s.designation, from: "part" });
  }
  return out;
}

/** The profile a chosen section is built from: a fresh copy of the library entry, or the part's own. */
function sectionDef(doc: RawDocument, library: LibraryEntry[], value: string): { def: ProfileDef; designation: string } | null {
  const [where, key, designation] = value.split("|");
  if (where === "lib") {
    const e = library.find((x) => x.id === key);
    return e ? { def: partCopy(e), designation } : null;
  }
  const p = ((doc.profiles ?? {}) as Record<string, ProfileDef>)[key];
  return p ? { def: structuredClone(p), designation } : null;
}

/** A drawing: read the sheet, then the confirmation card. */
/** A photo: read in pixels, scaled from one dimension, proposed over the photo. */
async function readPhoto(req: PartAskRequest, photo: Photo): Promise<PartAskResult> {
  let reading: PhotoReading;
  try {
    req.onEvent?.({ type: "thinking", turn: 1 });
    const raw = await req.model.readIntent({ system: PHOTO_SYSTEM, content: photoContent(req, photo), schema: "photo" }, req.signal);
    const parsed = PhotoReading.safeParse(raw);
    if (!parsed.success) return failed(req, `The model's reading of the photo did not fit the schema: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    reading = parsed.data;
  } catch (e) {
    return failed(req, req.signal?.aborted ? "Cancelled." : `Could not read the photo: ${(e as Error).message}`);
  }
  const common: PartAskResult = { ...failed(req, ""), visual: true, turns: 1, photoReading: reading };
  const p = planPhoto(reading, req.text, photo);
  if (!p.ok) return { ...common, outcome: "refused", text: p.problems.join(" ") };
  const built = await build(req, p.intent, { ...p.plan, notes: p.notes }, common, `the photo ${photo.name}`);
  if (built.outcome !== "proposal") return built;
  const s = p.photo.scale;
  const from = s.source === "typed" ? "from your note" : s.source === "reference" ? "read off the photo" : "a guess";
  const guessed = p.guesses.length
    ? ` ${p.guesses.join(", ")} ${p.guesses.length === 1 ? "is a guess" : "are guesses"}: the photo doesn't show ${p.guesses.length === 1 ? "it" : "them"}.`
    : "";
  built.text = [
    built.text,
    `Scale: ${s.what} = ${s.length} mm (${from}); every other size is measured on the photo and scaled from it.${guessed}`,
    `Export stays off until you confirm the scale on the photo${p.guesses.length ? " and set the guesses" : ""}. It is an estimate, not a part ready to make.`,
  ].join(" ");
  return built;
}

async function readDrawing(req: PartAskRequest, drawing: Drawing): Promise<PartAskResult> {
  let reading: DrawingReading;
  try {
    req.onEvent?.({ type: "thinking", turn: 1 });
    const raw = await req.model.readIntent({ system: DRAWING_SYSTEM, content: drawingContent(req, drawing), schema: "drawing" }, req.signal);
    const parsed = DrawingReading.safeParse(raw);
    if (!parsed.success) return failed(req, `The model's reading of the drawing did not fit the schema: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    reading = parsed.data;
  } catch (e) {
    return failed(req, req.signal?.aborted ? "Cancelled." : `Could not read the drawing: ${(e as Error).message}`);
  }
  return fromDrawing(req, drawing, reading, new Set(), false);
}

/**
 * The confirmation card for a drawing, or, once the user has confirmed it
 * and nothing is blank, the part built from it.
 */
async function fromDrawing(req: PartAskRequest, drawing: Drawing, reading: DrawingReading, confirmed: Set<string>, userConfirmed: boolean): Promise<PartAskResult> {
  const legible = !drawing.legibility.blurry;
  const review = reviewDrawing(reading, { text: req.text, drawing: { text: drawing.text, legible }, confirmed, file: drawing.name });
  const common: PartAskResult = {
    outcome: "questions",
    text: "",
    mode: "edit",
    visual: true,
    packet: null,
    proposal: null,
    calls: [],
    model: req.model.name,
    turns: 1,
    intent: review.intent,
    review,
    confirmed: [...confirmed],
    reading,
    views: review.views,
  };
  if (userConfirmed && review.ready) {
    return build(req, review.intent, planPart(review.intent, { name: review.name, source: review.source }), common, `the drawing ${drawing.name}`);
  }
  const read = review.rows.filter((r) => !r.blank && r.value !== null && r.source !== "placement" && r.source !== "entered").length;
  const n = review.blanks.length;
  common.text = [
    legible ? "" : `The drawing is too blurry to read numbers from (legibility ${Math.round(drawing.legibility.score * 100)}%), so nothing read from it is used.`,
    `Read ${read} value${read === 1 ? "" : "s"} from ${drawing.name}${review.views.length ? ` (views: ${review.views.join(", ")})` : ""}.`,
    n ? `${n} to fill in: ${review.blanks.map((b) => b.label.toLowerCase()).join(", ")}.` : "",
    ...review.problems,
    n === 0 && review.problems.length === 0 ? "Check every number against the drawing, then confirm." : "",
  ]
    .filter(Boolean)
    .join(" ");
  return common;
}

/** The user answered the card: fill the blanks and try again. */
export async function continuePartAsk(
  req: Omit<PartAskRequest, "text"> & { text: string },
  prev: PartAskResult,
  answers: Record<string, number | string | { x: number; y: number }[]>,
): Promise<PartAskResult> {
  if (!prev.review) return failed(req, "There is nothing to answer.");
  if (prev.reading && req.drawing) {
    // The Build button on a drawing's card is the user's confirmation of everything on it.
    const { reading, confirmed } = answerDrawing(prev.reading, answers);
    return fromDrawing(req, req.drawing, reading, new Set([...(prev.confirmed ?? []), ...confirmed]), true);
  }
  const { intent, confirmed } = answerIntent(prev.review.intent, answers);
  // Build on a frame's card is the user's confirmation of it.
  return createFrom(req, intent, new Set([...(prev.confirmed ?? []), ...confirmed]), true);
}

async function createFrom(req: PartAskRequest, intent: Intent, confirmed: Set<string>, userConfirmed: boolean): Promise<PartAskResult> {
  const frame = intent.kind === "frame";
  const review = reviewIntent(intent, { text: req.text, confirmed, ...(frame ? { sections: sectionOptions(req.doc, req.library) } : {}) });
  const common: PartAskResult = {
    outcome: "questions",
    text: "",
    mode: "edit",
    visual: !!req.drawing,
    packet: null,
    proposal: null,
    calls: [],
    model: req.model.name,
    turns: 1,
    intent,
    review,
    confirmed: [...confirmed],
  };
  if (!review.ready) {
    const n = review.blanks.length;
    const what = frame && review.blanks.every((b) => b.kind === "choice") ? (n === 1 ? "one choice" : `${n} choices`) : n === 1 ? "one number" : `${n} things`;
    common.text = [n ? `I need ${what} before I build this: ${review.blanks.map((b) => b.label.toLowerCase()).join(", ")}.` : "", ...review.problems].filter(Boolean).join(" ");
    return common;
  }
  if (frame) return userConfirmed ? buildFrame(req, review, common) : frameCard(review, common);
  if (review.intent.kind === "other") return buildOther(req, review, common);
  return build(req, review.intent, planPart(review.intent), common, `the request "${req.text}"`);
}

/** A frame's card: everything read is filled in, and building it is the user's confirmation (it commits stock and cuts). */
function frameCard(review: Review, common: PartAskResult): PartAskResult {
  const fr = review.intent.frame!;
  const section = review.rows.find((r) => r.path === "frame.section");
  const label = section?.options?.find((o) => o.value === section.value)?.label ?? "?";
  const size = [fr.length.value, fr.width.value, ...(fr.type === "table" ? [fr.height.value] : [])];
  common.text = `${frameWords(fr, size as number[])} in ${label}, ${fr.corners === "mitre" ? "mitred" : "butted"} at the corners. Check the section and the sizes, then build it.`;
  return common;
}

/** A confirmed frame: the library's profile, planned, built and checked for fabrication. */
async function buildFrame(req: PartAskRequest, review: Review, common: PartAskResult): Promise<PartAskResult> {
  const fr = review.intent.frame!;
  const section = sectionDef(req.doc, req.library ?? [], fr.section.value ?? "");
  if (!section) return { ...common, outcome: "failed", text: "The chosen section is no longer in the library or the part." };
  const plan = planFrame(review.intent, section);
  if (!plan.ok) return { ...common, outcome: "failed", text: `Could not plan the frame: ${plan.error}` };
  return build(req, review.intent, { ...plan, paths: {} } as unknown as Plan, common, `the request "${req.text}"`, {
    judge: (doc, check) => critiqueFrame(plan.expect, check.measurements, check.errors, doc),
    made: (check) => {
      const m = check.measurements;
      const corners = fr.corners === "mitre" ? "mitred corners" : fr.type === "table" ? "butt corners, the legs running through" : "butt corners";
      return `${frameWords(fr, m?.boundingBox?.size ?? null)} of ${section.designation}: ${m?.members.length ?? 0} members, ${corners}.`;
    },
  });
}

interface Judge {
  judge(doc: RawDocument, check: Awaited<ReturnType<KernelPort["check"]>>): Critique;
  made(check: Awaited<ReturnType<KernelPort["check"]>>): string;
}

/** Rebuild the plan, criticise, one correction pass, proposal. */
async function build(req: PartAskRequest, intent: Intent, plan: Plan, common: PartAskResult, what: string, custom?: Judge): Promise<PartAskResult> {
  if (!plan.ok) return { ...common, outcome: "failed", text: `Could not plan the part: ${plan.error}` };
  const judge = custom?.judge ?? ((_: RawDocument, c: Awaited<ReturnType<KernelPort["check"]>>) => critique(plan.expect, c.measurements, c.errors));
  let doc = plan.doc;
  let check = await req.kernel.check(doc);
  let crit = judge(doc, check);
  const notes = [...plan.notes];
  let correction: AskResult | null = null;

  // One correction pass (spec 5.1): the agent sees what disagrees and fixes the plan once. Then it is the human's.
  if (!crit.ok) {
    correction = await runAsk({
      doc,
      target: { kind: "part" },
      mode: "edit",
      text: `This part was planned from ${what}. Checked against it, these measurements disagree:\n- ${crit.findings.join("\n- ")}\nFix the features so they match. One pass; then stop.`,
      model: req.model,
      kernel: req.kernel,
      signal: req.signal,
      onEvent: req.onEvent,
    });
    if (correction.proposal) {
      doc = correction.proposal.doc;
      check = await req.kernel.check(doc);
      crit = judge(doc, check);
      notes.push("The first plan did not match the request; one correction pass was made.");
    }
  }

  const proposal = replaceProposal(req.doc, doc, check.measurements?.volume ?? null, crit, notes);
  const m = check.measurements;
  const made = custom ? custom.made(check) : describe(intent, m ? m.boundingBox!.size : null, m?.holeCount ?? 0, !!req.photo);
  const against = req.photo ? "what was read from the photo" : req.drawing ? "the drawing" : "the request";
  return {
    ...common,
    outcome: "proposal",
    proposal,
    critique: crit,
    calls: correction?.calls ?? [],
    text: crit.ok
      ? `${made} Checked against ${against}: ${crit.checks.length} of ${crit.checks.length} checks pass.`
      : `${made} It still does not match ${against} after one correction: ${crit.findings.join("; ")}. Over to you.`,
  };
}

/** A part the planner has no template for: the agent builds it from the confirmed description. */
async function buildOther(req: PartAskRequest, review: Review, common: PartAskResult): Promise<PartAskResult> {
  const answers = review.intent.questions.filter((q) => q.includes(" — "));
  const empty: RawDocument = { version: 1, units: "mm", name: review.intent.name || "part", features: [] };
  const r = await runAsk({
    doc: empty,
    target: { kind: "part" },
    mode: "edit",
    text: `Build this part from scratch with addFeature: ${review.intent.description}\nThe request: "${req.text}"${answers.length ? `\nThe user's answers: ${answers.join("; ")}` : ""}\nUse only numbers the request or the answers give. Rebuild, measure, and stop.`,
    model: req.model,
    kernel: req.kernel,
    signal: req.signal,
    onEvent: req.onEvent,
  });
  if (!r.proposal) return { ...common, ...r, outcome: r.outcome === "proposal" ? "failed" : r.outcome, intent: review.intent, review };
  const check = await req.kernel.check(r.proposal.doc);
  const crit = critique({ size: check.measurements?.boundingBox?.size ?? [0, 0, 0], holes: [] }, check.measurements, check.errors);
  // No template to check sizes against: the critic checks it rebuilds as one solid; the agent measured the rest.
  crit.checks = crit.checks.filter((c) => c.label === "Rebuilds without errors" || c.label === "One solid");
  crit.ok = crit.checks.every((c) => c.ok);
  return {
    ...common,
    ...r,
    outcome: "proposal",
    intent: review.intent,
    review,
    critique: crit,
    proposal: replaceProposal(req.doc, r.proposal.doc, check.measurements?.volume ?? null, crit, []),
  };
}

function replaceProposal(base: RawDocument, doc: RawDocument, volume: number | null, crit: Critique, notes: string[]): Proposal {
  return {
    replace: true,
    commands: [],
    scope: ["*"],
    base,
    doc,
    changes: diffDocs(base, doc),
    touched: [...new Set([...base.features, ...doc.features].map((f) => String(f.id)))],
    volumeBefore: null,
    volumeAfter: volume === null ? null : round6(volume),
    checks: crit.checks,
    notes,
  };
}

function describe(intent: Intent, size: number[] | null, holes: number, estimated = false): string {
  const s = size ? size.map((v) => round6(v)).join(" × ") : "?";
  const shape = intent.kind === "disc" ? "disc" : "plate";
  const article = estimated ? "An estimated" : /^(8|1[18](\D|$))/.test(s) ? "An" : "A";
  return `${article} ${s} mm ${shape}${holes ? ` with ${holes} hole${holes === 1 ? "" : "s"}` : ""}${intent.name && intent.name !== shape ? ` ("${intent.name}")` : ""}.`;
}

function intentContent(req: PartAskRequest): Anthropic.ContentBlockParam[] {
  const current = req.doc.features.length
    ? `The current part is "${req.doc.name}", ${req.doc.features.length} features.`
    : "There is no current part: the document is empty.";
  return [{ type: "text", text: `${current}\n\nThe request:\n${req.text.trim()}` }];
}

/** The pages at 200 dpi, the PDF's text layer, and the user's note last. */
function photoContent(req: PartAskRequest, p: Photo): Anthropic.ContentBlockParam[] {
  return [
    { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } },
    {
      type: "text",
      text: [
        `The photo: ${p.name}, ${p.width} × ${p.height} pixels. Give every position in this image's pixels: x from its left edge, y down from its top edge.`,
        `\nThe user's note:\n${req.text.trim() || "(none)"}`,
      ].join("\n"),
    },
  ];
}

function drawingContent(req: PartAskRequest, d: Drawing): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = d.pages.map((p) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: p.png } }));
  const lines = [
    `The drawing: ${d.name}, ${d.pageCount} page${d.pageCount === 1 ? "" : "s"}${d.dpi ? `, rasterised at ${d.dpi} dpi` : " (a scan)"}${d.pageCount > d.pages.length ? `; only the first ${d.pages.length} are shown` : ""}.`,
    d.text
      ? `Its text layer, exactly as printed on the sheet:\n${d.text}`
      : "It has no text layer: read the numbers from the image, and mark anything you cannot read clearly as missing.",
  ];
  if (d.legibility.blurry) lines.push("The scan measures as blurry. Do not guess numbers you cannot read: leave them missing.");
  lines.push(`\nThe user's note:\n${req.text.trim() || "(none)"}`);
  blocks.push({ type: "text", text: lines.join("\n") });
  return blocks;
}

function failed(req: { model: AskModel }, text: string): PartAskResult {
  return { outcome: "failed", text, mode: "edit", visual: false, packet: null, proposal: null, calls: [], model: req.model.name, turns: 0 };
}
