// The part-level prompt (spec 5.1, 6, Phase E): a right-click on empty space,
// or a dropped drawing. Its scope is the whole part, so it never applies
// itself: it answers, proposes an edit, or proposes a new part.
//
// A new part goes request -> intent -> review (ask if missing) -> plan ->
// rebuild -> critic -> at most one correction -> proposal. When the review
// finds missing numbers it asks for them instead of guessing; the answers
// come back through continuePartAsk.

import type Anthropic from "@anthropic-ai/sdk";
import type { RawDocument } from "../doc/commands";
import { critique, type Critique } from "../intent/critic";
import { planPart } from "../intent/plan";
import { answerIntent, reviewIntent, type Review } from "../intent/review";
import { Intent } from "../intent/schema";
import { round6 } from "../kernel/inspect";
import { diffDocs, runAsk, type AskEvent, type AskResult, type Proposal } from "./agent";
import type { KernelPort } from "./kernel";
import type { AskModel } from "./model";
import { classify } from "./prompt";

export interface Drawing {
  name: string;
  /** image/png, image/jpeg, image/webp, image/gif or application/pdf. */
  mediaType: string;
  /** Base64. */
  data: string;
}

export interface PartAskRequest {
  doc: RawDocument;
  text: string;
  drawing?: Drawing;
  model: AskModel;
  kernel: KernelPort;
  signal?: AbortSignal;
  onEvent?(e: AskEvent | { type: "intent"; intent: Intent }): void;
}

export interface PartAskResult extends AskResult {
  /** For a new part: what was read, and the review of it (the confirmation card). */
  intent?: Intent;
  review?: Review;
  /** Paths the user has filled in the card so far. */
  confirmed?: string[];
  critique?: Critique;
}

export const INTENT_SYSTEM = `You read requests for mechanical parts in Cocaide, a parametric CAD program, into intent JSON. You do not design the part; a planner does that from your intent, and the user confirms anything you are not sure of.

action: "create" when the request describes a part to make (always when there is no current part, or a drawing is attached and the request does not say otherwise); "edit" when it asks to change the current part; "answer" when it is a question.
kind: "plate" (rectangular, possibly with rounded corners), "disc" (round), or "other" (anything else; describe it in description).

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
questions: what you would need to ask before the part can be made, one short question each.`;

/** Runs a part-level ask: answer, edit proposal, new-part proposal, or questions. */
export async function runPartAsk(req: PartAskRequest): Promise<PartAskResult> {
  const base = { target: { kind: "part" } as const, doc: req.doc, model: req.model, kernel: req.kernel, signal: req.signal, onEvent: req.onEvent };
  if (!req.drawing && classify(req.text) === "explain") return runAsk({ ...base, text: req.text, mode: "explain" });

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

  if (!req.drawing && intent.action === "answer") return runAsk({ ...base, text: req.text, mode: "explain" });
  if (!req.drawing && intent.action === "edit" && req.doc.features.length > 0) return runAsk({ ...base, text: req.text, mode: "edit" });
  return createFrom(req, { ...intent, action: "create" }, new Set());
}

/** The user answered the card: fill the blanks and try again. */
export async function continuePartAsk(
  req: Omit<PartAskRequest, "text"> & { text: string },
  prev: PartAskResult,
  answers: Record<string, number | string | { x: number; y: number }[]>,
): Promise<PartAskResult> {
  if (!prev.review) return failed(req, "There is nothing to answer.");
  const { intent, confirmed } = answerIntent(prev.review.intent, answers);
  return createFrom(req, intent, new Set([...(prev.confirmed ?? []), ...confirmed]));
}

async function createFrom(req: PartAskRequest, intent: Intent, confirmed: Set<string>): Promise<PartAskResult> {
  const review = reviewIntent(intent, { text: req.drawing ? undefined : req.text, drawing: !!req.drawing, confirmed });
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
    common.text = [
      n ? `I need ${n === 1 ? "one number" : `${n} things`} before I build this: ${review.blanks.map((b) => b.label.toLowerCase()).join(", ")}.` : "",
      ...review.problems,
    ]
      .filter(Boolean)
      .join(" ");
    return common;
  }
  if (review.intent.kind === "other") return buildOther(req, review, common);

  const plan = planPart(review.intent);
  if (!plan.ok) return { ...common, outcome: "failed", text: `Could not plan the part: ${plan.error}` };
  let doc = plan.doc;
  let check = await req.kernel.check(doc);
  let crit = critique(plan.expect, check.measurements, check.errors);
  const notes = [...plan.notes];
  let correction: AskResult | null = null;

  // One correction pass (spec 5.1): the agent sees what disagrees and fixes the plan once. Then it is the human's.
  if (!crit.ok) {
    correction = await runAsk({
      doc,
      target: { kind: "part" },
      mode: "edit",
      text: `This part was planned from the request "${req.text}". Checked against the request, these measurements disagree:\n- ${crit.findings.join("\n- ")}\nFix the features so they match. One pass; then stop.`,
      model: req.model,
      kernel: req.kernel,
      signal: req.signal,
      onEvent: req.onEvent,
    });
    if (correction.proposal) {
      doc = correction.proposal.doc;
      check = await req.kernel.check(doc);
      crit = critique(plan.expect, check.measurements, check.errors);
      notes.push("The first plan did not match the request; one correction pass was made.");
    }
  }

  const proposal = replaceProposal(req.doc, doc, check.measurements?.volume ?? null, crit, notes);
  const m = check.measurements;
  const what = describe(review.intent, m ? m.boundingBox!.size : null, m?.holeCount ?? 0);
  return {
    ...common,
    outcome: "proposal",
    proposal,
    critique: crit,
    calls: correction?.calls ?? [],
    text: crit.ok
      ? `${what} Checked against the request: ${crit.checks.length} of ${crit.checks.length} checks pass.`
      : `${what} It still does not match the request after one correction: ${crit.findings.join("; ")}. Over to you.`,
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

function describe(intent: Intent, size: number[] | null, holes: number): string {
  const s = size ? size.map((v) => round6(v)).join(" × ") : "?";
  const shape = intent.kind === "disc" ? "disc" : "plate";
  return `A ${s} mm ${shape}${holes ? ` with ${holes} hole${holes === 1 ? "" : "s"}` : ""}${intent.name && intent.name !== shape ? ` ("${intent.name}")` : ""}.`;
}

function intentContent(req: PartAskRequest): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  if (req.drawing) {
    blocks.push(
      req.drawing.mediaType === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: req.drawing.data } }
        : { type: "image", source: { type: "base64", media_type: req.drawing.mediaType as "image/png", data: req.drawing.data } },
    );
  }
  const current = req.doc.features.length
    ? `The current part is "${req.doc.name}", ${req.doc.features.length} features.`
    : "There is no current part: the document is empty.";
  const ask = req.text.trim() || (req.drawing ? "Read the part from this drawing." : "");
  blocks.push({ type: "text", text: `${current}${req.drawing ? `\nA drawing is attached: ${req.drawing.name}. Numbers printed on it count as stated; anything you cannot read clearly is missing, not guessed.` : ""}\n\nThe request:\n${ask}` });
  return blocks;
}

function failed(req: { model: AskModel }, text: string): PartAskResult {
  return { outcome: "failed", text, mode: "edit", visual: false, packet: null, proposal: null, calls: [], model: req.model.name, turns: 0 };
}
