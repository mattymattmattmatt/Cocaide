// The Annotation tools of today's annotation kinds (Phase Q wave Q2B): a
// dimension between two points you pick (placed where you click: across,
// up or aligned by where the pointer is), a note, a balloon on a member, a
// hole callout on a hole's circle, centre marks and centre lines, weld
// symbols, Auto Balloon and Auto Dimension. Each pick is its own undo step
// and the tool stays on for the next until Esc or OK. A later wave replaces
// any of these by registering a tool with the same id.

import type { ReactNode } from "react";
import type { Command } from "../../../doc/commands";
import type { Vec2 } from "../../../doc/types";
import { validateDocument } from "../../../doc/validate";
import { autoDimensionSheetView } from "../../../drafting/autodim";
import { fmt } from "../../../drafting/compose";
import type { SnapKind, SnapTarget } from "../snap";
import { annotationKind, offsetFor } from "./kinds";
import { BaseSession } from "./session";
import { registerDrawingTool } from "./registry";
import type { DrawingToolCtx, OverlayShape, SheetPointer } from "./types";

const POINTS: SnapKind[] = ["vertex", "centre", "midpoint", "quadrant"];
/** True when lengths along the view are true (not an iso or a slanted view). */
const isSquare = (c: DrawingToolCtx, view: string) => c.sheet?.views.find((v) => v.id === view)?.square ?? false;
const noViews = (c: DrawingToolCtx) => (c.sheetDoc.views.length ? undefined : "Add a view first");

/** A tool that acts on each pick at once (each its own undo step) and stays on: OK and Esc just end it. */
abstract class PickSession extends BaseSession {
  made: string[] = [];
  blocked(): string | null {
    return null;
  }
  ok(): string | null {
    this.ctx().end();
    return null;
  }
  cancel(): void {
    this.ctx().end();
  }
  /** Adds an annotation now; true when it went in. */
  protected add(type: string, a: Record<string, unknown>): boolean {
    const c = this.ctx();
    const id = c.nextId(annotationKind(type)?.prefix ?? "a");
    if (c.run({ type: "setAnnotation", id, annotation: { type, ...a }, sheet: c.sheetDoc.id })) return false;
    this.made.push(id);
    c.select([id]);
    return true;
  }
  protected highlight(t: SnapTarget | null | undefined, tone: "accent" | "preview" = "accent"): OverlayShape[] {
    if (!t) return [];
    if (t.circle) return [{ k: "circle", c: t.circle.c, r: t.circle.r, tone, w: 3 }];
    if (t.pts) return t.pts.map((l) => ({ k: "line", pts: l, tone, w: 3 }) as OverlayShape);
    return [{ k: "dot", at: t.at, tone }];
  }
  title() {
    return this.made.length ? `${this.name()} (${this.made.length} added)` : this.name();
  }
  abstract name(): string;
}

// ------------------------------------------------------------ Smart Dimension (between two points)

type DimDir = "horizontal" | "vertical" | "aligned";

class DimensionSession extends PickSession {
  first: SnapTarget | null = null;
  second: SnapTarget | null = null;
  name() {
    return "Dimension";
  }
  prompt() {
    if (!this.first) return "Click a point (a vertex, a circle's centre, a midpoint) or a straight edge";
    if (!this.second) return `Click the second point in ${this.first.view}, or click again to dimension the edge`;
    return "Click where the dimension line goes (Shift: aligned)";
  }
  snaps() {
    return { kinds: this.first && !this.second ? [...POINTS, "edge"] : !this.first ? [...POINTS, "edge"] : [], view: this.first?.view ?? null } as { kinds: SnapKind[]; view: string | null };
  }
  /** The two points as sheet points and their references. */
  private ends(): { a: Vec2; b: Vec2; from: string; to: string; view: string } | null {
    const f = this.first;
    if (!f) return null;
    if (!this.second) return null;
    return { a: f.at, b: this.second.at, from: f.ref, to: this.second.ref, view: f.view };
  }
  private edgeEnds(e: SnapTarget): SnapTarget[] | null {
    const s = this.ctx().snap;
    const key = e.ref.replace(":e", ":v");
    const ends = [0, 1].map((i) => s?.targets.find((t) => t.ref === `${key}.${i}`));
    if (ends.every(Boolean)) return ends as SnapTarget[];
    // A corner is listed once, by whichever edge ends there: the vertex at the edge's end.
    const pts = e.pts?.flat();
    if (!pts?.length || !s) return null;
    const near = (p: Vec2) => s.targets.find((t) => t.kind === "vertex" && t.view === e.view && Math.hypot(t.at[0] - p[0], t.at[1] - p[1]) < 1e-6);
    const a = near(pts[0]);
    const b = near(pts[pts.length - 1]);
    return a && b ? [a, b] : null;
  }
  private dir(p: Vec2, shift: boolean): DimDir {
    const e = this.ends();
    if (!e || shift) return "aligned";
    const [x0, x1] = [Math.min(e.a[0], e.b[0]), Math.max(e.a[0], e.b[0])];
    const [y0, y1] = [Math.min(e.a[1], e.b[1]), Math.max(e.a[1], e.b[1])];
    const inX = p[0] >= x0 && p[0] <= x1;
    const inY = p[1] >= y0 && p[1] <= y1;
    if (inX && !inY) return "horizontal";
    if (inY && !inX) return "vertical";
    // Beyond both: the way the points are further apart.
    return x1 - x0 >= y1 - y0 ? "horizontal" : "vertical";
  }
  click(p: SheetPointer) {
    const c = this.ctx();
    if (!this.first || !this.second) {
      const s = p.snap;
      if (!s) return c.notice("Click a point or an edge of a view.", "error");
      const view = c.sheetDoc.views.find((v) => v.id === s.view);
      if (view && !isSquare(c, view.id)) return c.notice(`${s.view} is at an angle: dimension it in a front, top or side view, where lengths are true.`, "error");
      if (s.kind === "edge") {
        if (this.first && s.ref !== this.first.ref) return c.notice("Click a point for the second end, or the same edge again.", "error");
        const ends = this.edgeEnds(s);
        if (!ends) return c.notice("That edge's ends aren't points of the view: pick its ends instead.", "error");
        [this.first, this.second] = ends;
        return c.refresh();
      }
      if (!this.first) this.first = s;
      else if (s.ref !== this.first.ref) this.second = s;
      return c.refresh();
    }
    const e = this.ends()!;
    const dir = this.dir(p.raw, p.shift);
    const cv = this.cv(e.view);
    if (!cv?.box) return;
    const offset = dir === "aligned" ? Math.max(4, Math.round(distToLine(p.raw, e.a, e.b) * 10) / 10) : offsetFor(dir === "horizontal" ? "h" : "v", dir === "horizontal" ? p.raw[1] : p.raw[0], cv.box);
    this.add("dimension", { view: e.view, from: e.from, to: e.to, direction: dir, offset });
    this.first = this.second = null;
  }
  key(e: KeyboardEvent) {
    if (e.key === "Backspace" && (this.first || this.second)) {
      if (this.second) this.second = null;
      else this.first = null;
      this.ctx().refresh();
      return true;
    }
    return false;
  }
  overlay(): OverlayShape[] {
    const out: OverlayShape[] = [...this.highlight(this.first), ...this.highlight(this.second)];
    const e = this.ends();
    const h = this.hover;
    if (!e || !h) return out;
    const dir = this.dir(h.raw, h.shift);
    const cv = this.cv(e.view);
    let u: Vec2;
    if (dir === "horizontal") u = [1, 0];
    else if (dir === "vertical") u = [0, 1];
    else {
      const l = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) || 1;
      u = [(e.b[0] - e.a[0]) / l, (e.b[1] - e.a[1]) / l];
    }
    const n: Vec2 = [-u[1], u[0]];
    const level = h.raw[0] * n[0] + h.raw[1] * n[1];
    const foot = (q: Vec2): Vec2 => {
      const t = level - (q[0] * n[0] + q[1] * n[1]);
      return [q[0] + n[0] * t, q[1] + n[1] * t];
    };
    const fa = foot(e.a);
    const fb = foot(e.b);
    const value = Math.abs((fb[0] - fa[0]) * u[0] + (fb[1] - fa[1]) * u[1]) / (cv?.scale ?? 1);
    out.push({ k: "line", pts: [e.a, fa], tone: "preview" }, { k: "line", pts: [e.b, fb], tone: "preview" }, { k: "line", pts: [fa, fb], tone: "preview", w: 2 });
    out.push({ k: "label", at: [(fa[0] + fb[0]) / 2 + n[0] * this.px(10), (fa[1] + fb[1]) / 2 + n[1] * this.px(10)], text: fmt(value), tone: "preview" });
    return out;
  }
}

function distToLine(p: Vec2, a: Vec2, b: Vec2): number {
  const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const l = Math.hypot(d[0], d[1]) || 1;
  return Math.abs(((p[0] - a[0]) * d[1] - (p[1] - a[1]) * d[0]) / l);
}

registerDrawingTool({
  id: "annotation.smartDimension",
  tab: "annotation",
  group: "dimension",
  label: "Smart Dimension",
  icon: "smartDimension",
  title: "Dimension between two points you pick, or along an edge; click where the line goes (across, up or aligned by where you click)",
  key: "D",
  testId: "tool-annotation-dimension",
  disabled: noViews,
  run: (get) => new DimensionSession("annotation.smartDimension", get),
});

// ------------------------------------------------------------ Note and Text

class NoteSession extends BaseSession {
  at: Vec2 | null = null;
  text = "";
  title() {
    return "Note";
  }
  prompt() {
    return this.at ? "Type the note in the panel; Enter keeps it (Shift+Enter: a new line)" : "Click where the note goes";
  }
  blocked() {
    if (!this.at) return "Click where the note goes";
    return this.text.trim() ? null : "Type the note's text";
  }
  click(p: SheetPointer) {
    this.at = [Math.round(p.raw[0] * 10) / 10, Math.round(p.raw[1] * 10) / 10];
    this.ctx().refresh();
    requestAnimationFrame(() => (document.querySelector('[data-testid="note-text"]') as HTMLTextAreaElement | null)?.focus());
  }
  ok() {
    const why = this.blocked();
    if (why) return why;
    const c = this.ctx();
    const id = c.nextId("n");
    if (c.run({ type: "setAnnotation", id, annotation: { type: "note", text: this.text.trim(), at: this.at }, sheet: c.sheetDoc.id })) return "refused";
    c.select([id]);
    c.end();
    return null;
  }
  cancel() {
    this.ctx().end();
  }
  overlay(): OverlayShape[] {
    const at = this.at ?? this.hover?.raw;
    if (!at) return [];
    return [{ k: "dot", at, tone: "accent" }, ...(this.text ? [{ k: "label", at: [at[0], at[1] + this.px(4)], text: this.text.split("\n")[0], tone: "preview" } as OverlayShape] : [])];
  }
  panel(): ReactNode {
    return (
      <div className="session-options">
        <textarea
          rows={4}
          defaultValue={this.text}
          placeholder={'DEBURR ALL EDGES\nMaterial: $PRPMODEL:"material"'}
          onChange={(e) => {
            this.text = e.target.value;
            this.ctx().refresh();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              this.ok();
            }
          }}
          data-testid="note-text"
        />
        <p className="muted small">Links read the properties: $PRP:"name", $PRPMODEL:"mass", $PRPSHEET:"scale".</p>
      </div>
    );
  }
}

for (const [id, tab, group, label, icon] of [
  ["annotation.note", "annotation", "notes", "Note", "note"],
  ["sketch.text", "sketch", "text", "Text", "sketchText"],
] as const) {
  registerDrawingTool({ id, tab, group, label, icon, title: "Text on the sheet: click where it goes, then type it", testId: `tool-${id.replace(".", "-")}`, run: (get) => new NoteSession(id, get) });
}

// ------------------------------------------------------------ picks that make one annotation each

class OnePickSession extends PickSession {
  constructor(
    tool: string,
    ctx: () => DrawingToolCtx,
    readonly what: string,
    readonly kinds: SnapKind[],
    readonly ask: string,
    readonly make: (t: SnapTarget, c: DrawingToolCtx) => { type: string; a: Record<string, unknown> } | string,
  ) {
    super(tool, ctx);
  }
  name() {
    return this.what;
  }
  prompt() {
    return this.ask;
  }
  snaps() {
    return { kinds: this.kinds };
  }
  click(p: SheetPointer) {
    const c = this.ctx();
    if (!p.snap) return c.notice(this.ask, "error");
    const r = this.make(p.snap, c);
    if (typeof r === "string") return c.notice(r, "error");
    this.add(r.type, r.a);
  }
  overlay(): OverlayShape[] {
    return this.highlight(this.hover?.snap, "preview");
  }
}

const memberOf = (c: DrawingToolCtx, body: string | undefined) => (body ? c.measurements?.members.find((m) => m.body === body)?.id : undefined);
const holeFeatures = (c: DrawingToolCtx) => new Set(validateDocument(c.doc).features.flatMap((f) => (f.feature?.op === "hole" ? [f.feature.id] : [])));

registerDrawingTool({
  id: "annotation.balloon",
  tab: "annotation",
  group: "notes",
  label: "Balloon",
  icon: "balloon",
  title: "A balloon with the cut list item number: click a member in a view",
  testId: "tool-annotation-balloon",
  disabled: (c) => noViews(c) ?? (c.measurements?.members.length ? undefined : "Balloons number a weldment's cut list items: this part has no members"),
  run: (get) =>
    new OnePickSession("annotation.balloon", get, "Balloon", ["edge", "arc", "circle"], "Click an edge of a member", (t, c) => {
      const member = memberOf(c, t.body);
      return member ? { type: "balloon", a: { view: t.view, member } } : "That edge isn't a member's: click a member";
    }),
});

registerDrawingTool({
  id: "annotation.hole",
  tab: "annotation",
  group: "notes",
  label: "Hole Callout",
  icon: "hole",
  title: "Call out a hole (size, depth, thread, count): click its circle where the view looks into it",
  testId: "tool-annotation-hole",
  disabled: noViews,
  run: (get) =>
    new OnePickSession("annotation.hole", get, "Hole callout", ["circle", "centre"], "Click a hole's circle", (t, c) => {
      const f = t.feature;
      if (!f || !holeFeatures(c).has(f)) return `${f ?? "That"} is not a hole feature: click the circle of a hole made with the Hole tool`;
      if (c.sheetDoc.annotations.some((a) => a.type === "hole" && a.view === t.view && a.hole === f)) return `${f} is called out in ${t.view} already`;
      return { type: "hole", a: { view: t.view, hole: f } };
    }),
});

registerDrawingTool({
  id: "annotation.centerMark",
  tab: "annotation",
  group: "marks",
  label: "Centre Mark",
  icon: "plus",
  title: "A centre mark on a circle or arc: click it",
  testId: "tool-annotation-center-mark",
  disabled: noViews,
  run: (get) =>
    new OnePickSession("annotation.centerMark", get, "Centre mark", ["circle", "arc", "centre"], "Click a circle or an arc", (t, c) => {
      const ref = t.kind === "centre" ? t.ref : t.ref;
      if (c.sheetDoc.annotations.some((a) => a.type === "centerMark" && (a.at === ref || a.at === ref.replace(":c", ":e") || a.at === ref.replace(":e", ":c")))) return "That circle has a centre mark already";
      return { type: "centerMark", a: { view: t.view, at: ref } };
    }),
});

class CenterlineSession extends PickSession {
  first: SnapTarget | null = null;
  name() {
    return "Centreline";
  }
  prompt() {
    return this.first ? "Click the other edge (or the other circle's centre)" : "Click an edge (a cylinder's side) or a circle's centre";
  }
  snaps() {
    return { kinds: ["edge", "centre"] as SnapKind[], view: this.first?.view ?? null };
  }
  click(p: SheetPointer) {
    const c = this.ctx();
    if (!p.snap) return c.notice(this.prompt(), "error");
    if (!this.first) {
      this.first = p.snap;
      return c.refresh();
    }
    if (p.snap.ref === this.first.ref) return;
    this.add("centerline", { view: this.first.view, between: [this.first.ref, p.snap.ref] });
    this.first = null;
  }
  overlay(): OverlayShape[] {
    return [...this.highlight(this.first), ...this.highlight(this.hover?.snap, "preview")];
  }
}

registerDrawingTool({
  id: "annotation.centerline",
  tab: "annotation",
  group: "marks",
  label: "Centreline",
  icon: "centerline",
  title: "A centre line midway between two edges (a cylinder's sides), or through two circles' centres",
  testId: "tool-annotation-centerline",
  disabled: noViews,
  run: (get) => new CenterlineSession("annotation.centerline", get),
});

registerDrawingTool({
  id: "annotation.weld",
  tab: "annotation",
  group: "symbols",
  label: "Weld Symbol",
  icon: "joint",
  title: "The weld symbol of a weld in the weld table: click one of the bodies it joins",
  testId: "tool-annotation-weld",
  disabled: (c) => noViews(c) ?? (validateDocument(c.doc).welds.length ? undefined : "Add a weld first (Weldments: Weld): the symbol shows a weld of the weld table"),
  run: (get) =>
    new OnePickSession("annotation.weld", get, "Weld symbol", ["edge", "arc", "circle"], "Click an edge of a welded body", (t, c) => {
      const welds = validateDocument(c.doc).welds.filter((w) => t.body && w.between.includes(t.body));
      if (!welds.length) return `No weld joins ${t.body ?? "that"}: click a body a weld joins`;
      const shown = new Set(c.sheetDoc.annotations.flatMap((a) => (a.type === "weld" && a.view === t.view ? [a.weld] : [])));
      const w = welds.find((x) => !shown.has(x.id));
      if (!w) return `Every weld on ${t.body} has a symbol in ${t.view}`;
      return { type: "weld", a: { view: t.view, weld: w.id } };
    }),
});

registerDrawingTool({
  id: "annotation.autoBalloon",
  tab: "annotation",
  group: "notes",
  label: "Auto Balloon",
  icon: "balloon",
  title: "A balloon for every cut list item that has none",
  testId: "drawing-balloon-all",
  disabled: (c) => (c.sheet && c.sheet.cutList.length ? undefined : "Balloons number a weldment's cut list items: this sheet has none"),
  run: (get) => get().actions.balloonAll(),
});

// ------------------------------------------------------------ Auto Dimension (a view)

/**
 * The commands that dimension a view the way New drawing does (the current
 * engine; wave Q2A's replaces it): its overall size where it has none, each
 * hole it looks into called out and located from the view's left and bottom,
 * and a centre mark on every other circle.
 */
export function autoDimensionView(c: DrawingToolCtx, viewId: string): Command[] {
  // The auto-dimension engine v2 (src/drafting/autodim.ts, wave Q2A): what New drawing would put in this view that it lacks.
  if (!c.sheet || !isSquare(c, viewId)) return [];
  const taken = new Set<string>();
  const id = (prefix: string) => {
    let n = c.nextId(prefix);
    while (taken.has(n)) n = `${prefix}${Number(n.slice(prefix.length)) + 1}`;
    taken.add(n);
    return n;
  };
  return autoDimensionSheetView(c.doc, c.sheet, viewId, c.measurements, id).map(({ id: aid, ...annotation }) => ({ type: "setAnnotation", id: aid, annotation, sheet: c.sheetDoc.id }) as Command);
}

registerDrawingTool({
  id: "annotation.autoDimension",
  tab: "annotation",
  group: "dimension",
  label: "Auto Dimension",
  icon: "fullyDefine",
  title: "Dimension the selected view: its overall size, its holes called out and located, centre marks",
  testId: "tool-annotation-auto-dimension",
  disabled: (c) => noViews(c) ?? (c.selection.some((id) => c.sheetDoc.views.some((v) => v.id === id)) ? undefined : "Select a view first"),
  run: (get) => {
    const c = get();
    const viewId = c.selection.find((id) => c.sheetDoc.views.some((v) => v.id === id));
    if (!viewId) return c.notice("Select a view first.", "error");
    runAutoDimension(c, viewId);
  },
});

/** Auto Dimension on one view, one undo step, with what it added said. */
export function runAutoDimension(c: DrawingToolCtx, viewId: string): void {
  if (!isSquare(c, viewId)) return c.notice(`${viewId} is at an angle: dimensions go in front, top and side views.`, "error");
  const cmds = autoDimensionView(c, viewId);
  if (!cmds.length) return c.notice(`${viewId} is dimensioned already.`);
  if (!c.batch(cmds)) c.notice(`Auto dimension: ${cmds.length} annotation${cmds.length === 1 ? "" : "s"} added to ${viewId}. Ctrl+Z takes them away.`);
}
