// The sessions of the annotation tools (Phase Q wave Q3A): pick what the
// annotation is on, see it drawn as it will be (the engine's layout, in the
// preview colour) following the pointer, click to place it. Each placed
// annotation is its own undo step and the tool stays on for the next; Esc
// first lets go of the picks, then ends the tool; Enter ends it.

import type { Annotation, Vec2 } from "../../../doc/types";
import type { SnapTarget } from "../snap";
import { keep } from "./editing";
import { annotationKind } from "./kinds";
import { previewAnnotation } from "./preview";
import { BaseSession } from "./session";
import type { OverlayShape } from "./types";

export abstract class ToolSession extends BaseSession {
  made: string[] = [];
  abstract name(): string;
  /** Something picked and not yet placed: Esc lets it go first. */
  abstract busy(): boolean;
  abstract reset(): void;
  /** Redraws the overlay and the panel (an option changed). */
  redraw(): void {
    this.ctx().refresh();
  }
  title() {
    return this.made.length ? `${this.name()} (${this.made.length} added)` : this.name();
  }
  blocked(): string | null {
    return null;
  }
  ok(): string | null {
    this.ctx().end();
    return null;
  }
  cancel(): void {
    if (this.busy()) {
      this.reset();
      this.ctx().refresh();
      return;
    }
    this.ctx().end();
  }
  /** Adds an annotation (one undo step, the sheet's places remembered); its id, or null when refused. */
  protected add(a: Record<string, unknown> & { type: string }): string | null {
    const c = this.ctx();
    const id = c.nextId(annotationKind(a.type)?.prefix ?? "a");
    if (keep(c, [{ type: "setAnnotation", id, annotation: a, sheet: c.sheetDoc.id }])) return null;
    this.made.push(id);
    c.select([id]);
    return id;
  }
  /** The annotation drawn as it will be, in the preview colour; or why it can't be, by the pointer. */
  protected preview(a: Record<string, unknown> | string, at?: Vec2): OverlayShape[] {
    if (typeof a === "string") return at ? [{ k: "label", at: [at[0], at[1] - this.px(18)], text: a, tone: "warn" }] : [];
    const l = previewAnnotation(this.ctx().sheet, { ...a, id: "__preview" } as unknown as Annotation);
    if (!l) return [];
    if (l.problem && !l.prims.length) return at ? [{ k: "label", at: [at[0], at[1] - this.px(18)], text: l.problem, tone: "warn" }] : [];
    return [{ k: "prims", prims: l.prims, tone: "preview" }];
  }
  protected highlight(t: SnapTarget | null | undefined, tone: "accent" | "preview" = "accent"): OverlayShape[] {
    if (!t) return [];
    if (t.circle) return [{ k: "circle", c: t.circle.c, r: t.circle.r, tone, w: 3 }];
    if (t.pts) return t.pts.map((l) => ({ k: "line", pts: l, tone, w: 3 }) as OverlayShape);
    return [{ k: "dot", at: t.at, tone }];
  }
  /** A point relative to a view's centre (what `at` holds), to a tenth. */
  protected rel(view: string, p: Vec2): Vec2 {
    const cv = this.cv(view);
    const c = cv ? cv.centre : [0, 0];
    return [Math.round((p[0] - c[0]) * 10) / 10 + 0, Math.round((p[1] - c[1]) * 10) / 10 + 0];
  }
}

/** Views a tool can annotate: there is at least one. */
export const noViews = (c: { sheetDoc: { views: unknown[] } }) => (c.sheetDoc.views.length ? undefined : "Add a view first");
