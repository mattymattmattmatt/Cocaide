// The common part of the drawing tools' sessions (Phase Q wave Q2B): a
// session edits the drawing inside its own transaction, so what it does is
// on the sheet while it is open (the new view is projected and drawn, the
// way a feature session previews), OK keeps it as one undo step, and Cancel
// leaves the drawing exactly as it was.

import type { Command } from "../../../doc/commands";
import type { DrawingView, Vec2 } from "../../../doc/types";
import type { ComposedView } from "../../../drafting/compose";
import type { DrawingSession, DrawingToolCtx, OverlayShape, SheetPointer } from "./types";

export abstract class BaseSession implements DrawingSession {
  /** Shapes kept from the last pointer move. */
  protected hover: SheetPointer | null = null;

  constructor(
    readonly tool: string,
    protected readonly ctx: () => DrawingToolCtx,
  ) {}

  abstract title(): string;
  abstract prompt(): string;
  abstract overlay(): OverlayShape[];

  move(p: SheetPointer): void {
    this.hover = p;
    this.ctx().refresh();
  }

  /** Applies a command inside the session's transaction, opening it first. */
  protected live(cmd: Command): string | null {
    const c = this.ctx();
    if (!c.inTransaction()) {
      const problem = c.begin(this.title());
      if (problem) {
        c.notice(problem, "error");
        return problem;
      }
    }
    const problem = c.live(cmd);
    if (problem) c.notice(problem, "error");
    c.refresh();
    return problem;
  }

  blocked(): string | null {
    return this.ctx().inTransaction() ? null : this.prompt();
  }

  ok(): string | null {
    const why = this.blocked();
    if (why) return why;
    const c = this.ctx();
    if (c.inTransaction()) c.commit(this.title());
    c.end();
    return null;
  }

  cancel(): void {
    const c = this.ctx();
    if (c.inTransaction()) c.rollback();
    c.end();
  }

  /** The composed view by id on the sheet shown. */
  protected cv(id: string | null | undefined): ComposedView | undefined {
    return id ? this.ctx().sheet?.views.find((v) => v.id === id) : undefined;
  }

  /** The stored view by id on the sheet shown. */
  protected view(id: string | null | undefined): DrawingView | undefined {
    return id ? this.ctx().sheetDoc.views.find((v) => v.id === id) : undefined;
  }

  /** The view selected when the tool started (one on this sheet), to start from. */
  protected selectedView(ok: (v: DrawingView) => boolean = () => true): string | null {
    const c = this.ctx();
    for (const id of c.selection) {
      const v = c.sheetDoc.views.find((x) => x.id === id);
      if (v && ok(v)) return v.id;
      const a = c.sheetDoc.annotations.find((x) => x.id === id) as { view?: string } | undefined;
      if (a?.view && c.sheetDoc.views.some((x) => x.id === a.view)) return a.view;
    }
    return null;
  }

  /** Screen pixels in sheet mm, now. */
  protected px(n: number): number {
    return n * this.ctx().mmPerPx();
  }
}

/** The view written for setView: its fields without the id. */
export function viewBody(v: DrawingView, patch: Partial<DrawingView> = {}): Record<string, unknown> {
  const next: Record<string, unknown> = { ...v, ...patch };
  delete next.id;
  for (const [k, x] of Object.entries(next)) if (x === undefined) delete next[k];
  return next;
}

/** A zigzag break line across a view box, at x (axis 0) or y (axis 1), sheet mm. */
export function breakLine(box: { min: Vec2; max: Vec2 }, axis: 0 | 1, at: number, amp: number): Vec2[] {
  const lo = box.min[1 - axis] - amp;
  const hi = box.max[1 - axis] + amp;
  const mid = (lo + hi) / 2;
  const pts: [number, number][] = [
    [at, lo],
    [at, mid - amp * 1.2],
    [at + amp, mid - amp * 0.4],
    [at - amp, mid + amp * 0.4],
    [at, mid + amp * 1.2],
    [at, hi],
  ];
  return pts.map(([a, b]) => (axis === 0 ? [a, b] : [b, a]));
}
