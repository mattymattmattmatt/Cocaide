// "Fully detail this drawing" as the app runs it (Phase Q wave Q3B), the same
// for every provider: first the plan by rules, shown as a card (no model
// needed); then, as the user left it, carried out by rules only (Auto-detail)
// or by the model, which starts from it and refines with the critic (Claude,
// a local model through Ollama, or Claude Code through the bridge, whose MCP
// tools carry the same plan). Either way the result is a proposal.

import { drawingChecks } from "../../drafting/checks";
import type { RawDocument } from "../../doc/commands";
import { diffDocs, touchedIds, type AskResult, type Proposal } from "../agent";
import type { KernelPort } from "../kernel";
import type { AskTarget } from "../packet";
import { autoDetail, makePlan } from "./auto";
import { activeItems, PLAN_GROUP_LABELS, type DetailOptions, type DetailPlan } from "./plan";

type DrawingTarget = Extract<AskTarget, { kind: "view" | "sheet" | "drawing" | "annotation" | "table" }>;

/** Where on the drawing a detailing ask is about: one view, one sheet, or the whole drawing. */
function where(target: DrawingTarget): { view?: string; sheet?: string } {
  return target.kind === "view" ? { view: target.id } : target.kind === "sheet" ? { sheet: target.id } : {};
}

/** The scope a detailing ask writes under. */
export function detailScope(target: DrawingTarget): string[] {
  return target.kind === "view" ? [`view:${target.id}`] : ["drawing"];
}

/** Step one: the plan by rules, as a card result (no model). */
export async function planDetailAsk(doc: RawDocument, target: DrawingTarget, kernel: KernelPort, model = "rules"): Promise<AskResult> {
  try {
    const { plan } = await makePlan(doc, kernel, where(target));
    const n = plan.items.filter((i) => i.on).length;
    return {
      outcome: "questions",
      text: `${plan.intent.summary}. The plan has ${n} item${n === 1 ? "" : "s"}: untick what you do not want, change the standard or tolerance, then detail it.`,
      mode: "edit",
      visual: false,
      packet: null,
      proposal: null,
      calls: [],
      model,
      turns: 0,
      detailPlan: plan,
    };
  } catch (e) {
    return { outcome: "failed", text: `Could not plan the detailing: ${(e as Error).message}`, mode: "edit", visual: false, packet: null, proposal: null, calls: [], model, turns: 0 };
  }
}

/** Auto-detail: the plan carried out by rules only, as a proposal (no model). */
export async function rulesDetailAsk(doc: RawDocument, target: DrawingTarget, kernel: KernelPort, plan: DetailPlan, date?: string): Promise<AskResult> {
  const scope = detailScope(target);
  try {
    const r = await autoDetail(doc, kernel, { plan, scope, ...(date ? { date } : {}), ...where(target) });
    const failed = r.execution.results.filter((x) => !x.ok);
    const st = r.execution.state;
    const proposal: Proposal = {
      ...(st.composed ? { checks: drawingChecks(st.composed.sheets, r.doc, st.check.measurements, st.geometry) } : {}),
      notes: [...failed.map((x) => `Left out ${x.item}: ${x.error}`), ...r.findings.map((f) => `Critic (${f.severity}): ${f.message}`)],
      commands: r.commands,
      scope,
      base: doc,
      doc: r.doc,
      changes: diffDocs(doc, r.doc),
      touched: touchedIds(doc, r.doc),
      volumeBefore: null,
      volumeAfter: null,
    };
    const done = r.execution.results.filter((x) => x.ok).length;
    return {
      outcome: r.commands.length ? "proposal" : "answer",
      text: r.commands.length ? `Detailed by rules: ${done} item${done === 1 ? "" : "s"} carried out${r.findings.length ? `; the critic still finds ${r.findings.length} thing${r.findings.length === 1 ? "" : "s"} to look at` : "; the critic finds nothing more"}.` : "The drawing already has everything the plan adds.",
      mode: "edit",
      visual: false,
      packet: null,
      proposal: r.commands.length ? proposal : null,
      calls: [{ tool: "applyDetailPlan", input: { skip: plan.items.filter((i) => !i.on).map((i) => i.id) }, ok: true, revision: 1, hash: "" }],
      model: "rules",
      turns: 0,
    };
  } catch (e) {
    return { outcome: "failed", text: `Auto-detail failed: ${(e as Error).message}`, mode: "edit", visual: false, packet: null, proposal: null, calls: [], model: "rules", turns: 0 };
  }
}

/**
 * The plan as the user left it, as words for a model that drives the MCP tools (Claude Code through the
 * bridge): the items to leave out and the options to pass to applyDetailPlan.
 */
export function detailInstructions(plan: DetailPlan): string {
  const skip = plan.items.filter((i) => !i.on).map((i) => i.id);
  const options: Partial<DetailOptions> = plan.options;
  const call = `applyDetailPlan(${JSON.stringify({ ...(skip.length ? { skip } : {}), options, ...(plan.view ? { view: plan.view } : {}) })})`;
  const kept = activeItems(plan);
  const groups = [...new Set(kept.map((i) => i.group))].map((g) => PLAN_GROUP_LABELS[g].toLowerCase()).join(", ");
  return `The user reviewed the detailing plan (${kept.length} items: ${groups}). Carry it out first with ${call}, then refine it with what the rules cannot judge, check with checkDrawing and renderSheet, fix the findings, and stop when checkDrawing has no errors. Keep to the user's choices: do not add what they left out.`;
}
