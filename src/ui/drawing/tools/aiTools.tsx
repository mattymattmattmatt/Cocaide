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
import type { MenuEntry } from "../../ContextMenu";
import type { Vec2 } from "../../../doc/types";
import { snapAt, type SnapTarget } from "../snap";

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

registerMenuEntries("ai", (hit, ctx, at) => {
  const ask = ctx.actions.ask;
  if (!ask) return [];
  // What was right-clicked in a view: a circle (a hole or bore) gets "Add a fit…", an edge or face seen edge-on "Add GD&T…".
  const geometryEntries = (view: string, geo: SnapTarget | null, gdtAlways: boolean): MenuEntry[] => {
    const out: MenuEntry[] = [];
    if (geo && (geo.kind === "circle" || geo.kind === "arc") && geo.visible) {
      out.push({ label: "Add a fit…", icon: "ask", hint: `ISO 286 fit for ${geo.label}`, onClick: () => ask({ kind: "view", id: view, selection: [geo.ref] }, fitPrompt(geo.ref), false), testId: "ctx-ai-fit-geo" });
    }
    if (geo || gdtAlways)
      out.push({
        label: "Add GD&T…",
        icon: "grid",
        hint: geo ? `A feature control frame on ${geo.label}` : "Datums and geometric tolerances this view needs",
        onClick: () => (geo ? ask({ kind: "view", id: view, selection: [geo.ref] }, gdtPrompt(geo.ref), false) : ask({ kind: "view", id: view }, GDT_VIEW_PROMPT, false)),
        testId: "ctx-ai-gdt",
      });
    return out;
  };
  if (hit.kind === "view") {
    const geo = at ? geometryAt(ctx, hit.id, at) : null;
    return [{ label: "Detail this view", icon: "ask", hint: "Size, locate and tolerance what this view shows", onClick: () => ask({ kind: "view", id: hit.id }, DETAIL_VIEW_PROMPT, true), testId: "ctx-ai-detail-view" }, ...geometryEntries(hit.id, geo, true)];
  }
  if (hit.kind === "annotation") {
    const a = ctx.drawing.sheets.flatMap((s) => s.annotations).find((x) => x.id === hit.id);
    // A centre mark or centre line covers its hole: the right-click is on the hole as much as on the mark.
    if ((a?.type === "centerMark" || a?.type === "centerline") && at) {
      const geo = geometryAt(ctx, a.view, at);
      return geometryEntries(a.view, geo, false);
    }
    if (a?.type === "hole") return [{ label: "Add a fit…", icon: "ask", hint: "An ISO 286 fit by what goes in the hole", onClick: () => ask({ kind: "annotation", id: a.id }, `Give hole callout ${a.id} the ISO 286 fit its purpose needs (bearing seat H7, dowel H7 for an m6 dowel, sliding H7/g6): `, false), testId: "ctx-ai-fit" }];
    if (a?.type === "dimension") return [{ label: "Tolerance this…", icon: "ask", hint: "A tolerance or fit by what the size is for", onClick: () => ask({ kind: "annotation", id: a.id }, `Tolerance dimension ${a.id} by what it is for (a fit, ± limits, basic or reference): `, false), testId: "ctx-ai-tolerance" }];
  }
  return [];
});

export const DETAIL_VIEW_PROMPT = "Fully detail this view: every feature it shows sized and located once, the fits, GD&T and surface texture its features need.";
export const GDT_VIEW_PROMPT = "Add the geometric tolerances this view needs (datums, position of hole patterns, flatness of mating faces): ";
export const fitPrompt = (ref: string) => `Give the hole or bore at ${ref} the ISO 286 fit its purpose needs (a Ø dimension or its callout toleranced): `;
export const gdtPrompt = (ref: string) => `Add a geometric tolerance on ${ref} (a datum feature, flatness, perpendicularity or position to the datums): `;

/** The geometry under a right-click in a view (a few screen pixels round it). */
function geometryAt(ctx: DrawingToolCtx, view: string, at: Vec2): SnapTarget | null {
  if (!ctx.snap) return null;
  const tol = 6 * ctx.mmPerPx();
  // An edge or circle, not a point on it (the GD&T goes on the feature).
  return snapAt(ctx.snap, at, tol, { view, kinds: ["circle", "arc", "edge"] });
}
