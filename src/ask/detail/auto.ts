// Auto-detail (Phase Q wave Q3B): the detailing plan by rules, carried out
// and checked, with no model. The drawing workspace's Auto-detail runs it, the
// MCP server's autoDetail tool, the detailing agent's applyDetailPlan, and the
// tests; a model-driven detailing starts from it and refines.

import { apply, type Command, type RawDocument } from "../../doc/commands";
import { DEFAULT_VIEWS, planDrawing } from "../../drafting/plan";
import type { KernelPort } from "../kernel";
import { critique, type Finding } from "./critic";
import { detailState, executePlan, type DetailState, type ExecuteResult } from "./execute";
import { inferIntent } from "./intent";
import { planDetail, type DetailOptions, type DetailPlan } from "./plan";

export interface PlanRequest {
  /** Only this view ("Detail this view"). */
  view?: string;
  sheet?: string;
  options?: Partial<DetailOptions>;
  /** The title block's and revision's date. */
  date?: string;
}

/** The plan for a document: on its drawing, or on the drawing New drawing would make when it has none. */
export async function makePlan(doc: RawDocument, kernel: KernelPort, req: PlanRequest = {}): Promise<{ plan: DetailPlan; state: DetailState }> {
  let state = await detailState(doc, kernel, { sheet: req.sheet });
  let fresh = false;
  if (!state.drawing) {
    // No drawing yet: plan on the one New drawing makes (the plan's first item makes it).
    const drawing = planDrawing(doc, state.check.measurements, await kernel.project(doc, DEFAULT_VIEWS), req.date ? { date: req.date } : {});
    const r = apply(doc, { type: "setDrawing", drawing });
    if (!r.ok) throw new Error(`could not plan a drawing: ${r.error}`);
    state = await detailState(r.doc, kernel, { check: state.check, topology: state.topology });
    fresh = true;
  }
  if (!state.drawing || !state.sheet) throw new Error("the drawing has no sheet to detail");
  const intent = inferIntent(doc, state.check.measurements, state.geometry?.holes ?? [], state.topology);
  const plan = planDetail({ doc: state.doc, drawing: state.drawing, sheet: state.sheet, measurements: state.check.measurements, intent, fresh, ...(req.view ? { view: req.view } : {}), ...(req.options ? { options: req.options } : {}), ...(req.date ? { date: req.date } : {}) });
  return { plan, state };
}

export interface AutoDetailResult {
  plan: DetailPlan;
  /** The commands, in order: what a proposal replays. */
  commands: Command[];
  doc: RawDocument;
  execution: ExecuteResult;
  findings: Finding[];
}

/** The findings on a detailed state. */
export function findingsOf(state: DetailState, plan?: DetailPlan): Finding[] {
  if (!state.drawing || !state.composed) return [{ rule: "checks", severity: "error", message: "there is no drawing" }];
  return critique({ doc: state.doc, drawing: state.drawing, sheets: state.composed.sheets, measurements: state.check.measurements, geometry: state.geometry, ...(plan ? { intent: plan.intent, plan } : {}) });
}

/** Plans (or takes the plan given, as the user left it on the card), carries it out and checks the result. */
export async function autoDetail(doc: RawDocument, kernel: KernelPort, req: PlanRequest & { plan?: DetailPlan; scope?: string[] } = {}): Promise<AutoDetailResult> {
  const plan = req.plan ?? (await makePlan(doc, kernel, req)).plan;
  const base = await detailState(doc, kernel, { sheet: req.sheet });
  const execution = await executePlan(plan, base, kernel, { ...(req.scope ? { scope: req.scope } : {}), ...(req.date ? { date: req.date } : {}) });
  return { plan, commands: execution.commands, doc: execution.doc, execution, findings: findingsOf(execution.state, plan) };
}
