// The AI's way into the drawing workspace (Phase Q wave Q3B): "Detail with
// AI…" (the ask on this sheet with "Fully detail this drawing": the plan as a
// card, then the model detailing from it, then the proposal to accept),
// "Auto-detail" (the same plan by rules only, no model: carried out on the
// sheet inside the tool's own undo step, OK keeps it, Cancel leaves the
// drawing as it was), and right-click entries: a view's "Detail this view"
// and "Add GD&T…", a hole callout's "Add a fit…", a dimension's
// "Tolerance this…".

import { autoDetail, makePlan } from "../../../ask/detail/auto";
import type { Finding } from "../../../ask/detail/critic";
import type { DetailPlan } from "../../../ask/detail/plan";
import { DETAIL_PROMPT } from "../../../ask/prompt";
import { DetailPlanCard } from "../../ask/DetailPlanCard";
import { registerDrawingTool, registerMenuEntries } from "./registry";
import { BaseSession } from "./session";
import type { DrawingToolCtx, OverlayShape } from "./types";

registerDrawingTool({
  id: "ai.detail",
  tab: "annotation",
  group: "ai",
  label: "Detail with AI…",
  icon: "ask",
  title: "Fully detail this sheet: a plan from the part (datums, fits, GD&T, surface texture, welds, notes) you can change, then the AI details it and checks it; you accept the result",
  testId: "tool-ai-detail",
  disabled: (ctx) => (ctx.actions.ask ? undefined : "The AI is not available here"),
  run(getCtx) {
    const c = getCtx();
    c.actions.ask?.({ kind: "sheet", id: c.sheetDoc.id }, DETAIL_PROMPT, true);
  },
});

registerDrawingTool({
  id: "ai.autoDetail",
  tab: "annotation",
  group: "ai",
  label: "Auto-detail",
  icon: "fullyDefine",
  title: "Detail this sheet by rules, no AI: datums, fits by each hole's purpose, position and flatness, surface texture, welds, the general tolerance, notes and tables. You see the plan first",
  testId: "tool-ai-auto-detail",
  disabled: (ctx) => (ctx.actions.kernel ? undefined : "Needs the part's kernel"),
  run: (getCtx) => new AutoDetailSession(getCtx),
});

/** Auto-detail: the plan (a card in the panel), then carried out on the sheet inside the session's transaction. */
class AutoDetailSession extends BaseSession {
  private phase: "planning" | "card" | "applying" | "done" | "failed" = "planning";
  private plan: DetailPlan | null = null;
  private findings: Finding[] = [];
  private made = 0;
  private error = "";

  constructor(ctx: () => DrawingToolCtx) {
    super("ai.autoDetail", ctx);
    void this.start();
  }

  private async start() {
    const c = this.ctx();
    try {
      this.plan = (await makePlan(c.doc, c.actions.kernel!, { sheet: c.sheetDoc.id })).plan;
      this.phase = "card";
    } catch (e) {
      this.phase = "failed";
      this.error = (e as Error).message;
    }
    this.ctx().refresh();
  }

  private async apply(plan: DetailPlan) {
    this.phase = "applying";
    this.ctx().refresh();
    const c = this.ctx();
    try {
      const r = await autoDetail(c.doc, c.actions.kernel!, { plan, sheet: c.sheetDoc.id });
      // One transaction for all of it (opened once: the document's state catches up after the commands).
      const now = this.ctx();
      const opened = now.inTransaction() ? null : now.begin(this.title());
      if (opened) throw new Error(opened);
      for (const cmd of r.commands) {
        const problem = now.live(cmd);
        if (problem) throw new Error(problem);
      }
      this.made = r.execution.results.filter((x) => x.ok).length;
      this.findings = r.findings;
      this.phase = "done";
    } catch (e) {
      if (this.ctx().inTransaction()) this.ctx().rollback();
      this.phase = "failed";
      this.error = (e as Error).message;
    }
    this.ctx().refresh();
  }

  title() {
    return "Auto-detail";
  }

  prompt() {
    switch (this.phase) {
      case "planning":
        return "Reading the part: what each feature is for…";
      case "card":
        return "Untick what you do not want, then Apply the plan";
      case "applying":
        return "Detailing the sheet…";
      case "done":
        return "OK keeps the detailing as one step; Cancel takes it away";
      default:
        return `Auto-detail could not run: ${this.error}`;
    }
  }

  overlay(): OverlayShape[] {
    return [];
  }

  blocked() {
    return this.phase === "done" ? null : this.prompt();
  }

  panel() {
    if (this.phase === "card" && this.plan) return <DetailPlanCard plan={this.plan} rulesOnly onRun={(p) => void this.apply(p)} />;
    if (this.phase === "done")
      return (
        <div className="detail-card" data-testid="auto-detail-done">
          <div>
            {this.made} item{this.made === 1 ? "" : "s"} carried out.
          </div>
          {this.findings.length ? (
            <ul className="ask-checks" data-testid="auto-detail-findings">
              {this.findings.map((f, i) => (
                <li key={i} className={f.severity === "error" ? "bad" : ""}>
                  {f.message}
                </li>
              ))}
            </ul>
          ) : (
            <div className="muted small">The critic finds nothing more.</div>
          )}
        </div>
      );
    return <div className="muted small" data-testid="auto-detail-status">{this.prompt()}</div>;
  }
}

// ------------------------------------------------------------ right-click entries

registerMenuEntries("ai", (hit, ctx) => {
  const ask = ctx.actions.ask;
  if (!ask) return [];
  if (hit.kind === "view") {
    return [
      { label: "Detail this view", icon: "ask", hint: "Size, locate and tolerance what this view shows", onClick: () => ask({ kind: "view", id: hit.id }, "Fully detail this view: every feature it shows sized and located once, the fits, GD&T and surface texture its features need.", true), testId: "ctx-ai-detail-view" },
      { label: "Add GD&T…", icon: "grid", onClick: () => ask({ kind: "view", id: hit.id }, "Add the geometric tolerances this view needs (datums, position of hole patterns, flatness of mating faces): ", false), testId: "ctx-ai-gdt" },
    ];
  }
  if (hit.kind === "annotation") {
    const a = ctx.drawing.sheets.flatMap((s) => s.annotations).find((x) => x.id === hit.id);
    if (a?.type === "hole") return [{ label: "Add a fit…", icon: "ask", onClick: () => ask({ kind: "annotation", id: a.id }, "Give this hole the ISO 286 fit ", false), testId: "ctx-ai-fit" }];
    if (a?.type === "dimension") return [{ label: "Tolerance this…", icon: "ask", onClick: () => ask({ kind: "annotation", id: a.id }, "Tolerance this dimension: ", false), testId: "ctx-ai-tolerance" }];
  }
  return [];
});
