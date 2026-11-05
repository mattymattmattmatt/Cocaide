// The dimensioning tools (Phase Q wave Q3A): Smart Dimension (D) inferred
// from what is picked, its preview following the pointer exactly as it will
// be drawn; chain, baseline and ordinate sets; the chamfer dimension; the
// hole callout; centre marks (one, a row, a bolt circle) and centre lines
// (two edges, two centres, or one side of a cylinder); Model Items (the
// part's own dimensions brought into chosen views). Each replaces or fills
// the slot Q2B named, by id.

import type { ReactNode } from "react";
import type { Command } from "../../../doc/commands";
import type { DimensionDirection, Vec2 } from "../../../doc/types";
import { validateDocument } from "../../../doc/validate";
import { centerlineFromPicks, centerMarkFromPick, holeFromPick } from "../../../drafting/annotate";
import type { SnapKind, SnapTarget } from "../snap";
import { keep } from "./editing";
import { centreRef, inferDimension, setFromPicks, type DimPick, type InferOptions } from "./inference";
import { modelItems } from "./modelItems";
import { registerDrawingTool } from "./registry";
import { BUILT_IN_FAVOURITES, applyFavourite, loadFavourites, type DimFavourite } from "./styles";
import { ToolSession, noViews } from "./toolSession";
import type { DrawingToolCtx, OverlayShape, SheetPointer } from "./types";
import { Row, Segmented } from "./ui";

const POINTS: SnapKind[] = ["vertex", "centre", "midpoint", "quadrant"];
const ALL: SnapKind[] = [...POINTS, "edge", "circle", "arc"];
const square = (c: DrawingToolCtx, view: string) => c.sheet?.views.find((v) => v.id === view)?.square ?? false;
const pickOf = (s: SnapTarget): DimPick => ({ ref: s.ref, kind: s.kind, view: s.view, at: s.at });
const favourites = (): DimFavourite[] => [...BUILT_IN_FAVOURITES, ...loadFavourites()];

// ------------------------------------------------------------ Smart Dimension

export class SmartDimensionSession extends ToolSession {
  picks: SnapTarget[] = [];
  radial: InferOptions["radial"];
  lock: DimensionDirection | undefined;
  /** A favourite every new dimension gets ("±0.1", "H7"). */
  style: string = "";
  constructor(get: () => DrawingToolCtx) {
    super("annotation.smartDimension", get);
  }
  name() {
    return "Smart Dimension";
  }
  busy() {
    return this.picks.length > 0;
  }
  reset() {
    this.picks = [];
  }
  prompt() {
    if (!this.picks.length) return "Click an edge, a circle, an arc or a point (two for a distance or an angle)";
    const p = this.picks[0];
    if (this.picks.length === 1 && POINTS.includes(p.kind)) return "Click a second point or an edge";
    if (this.picks.length === 1) return "Click where the dimension goes, or a second item (an edge for an angle or a distance)";
    return "Click where the dimension goes (where the pointer is picks across, up, along, or the angle's quadrant)";
  }
  snaps() {
    return this.picks.length < 2 ? { kinds: ALL, view: this.picks[0]?.view ?? null } : { kinds: [] as SnapKind[] };
  }
  opts(): InferOptions {
    return { ...(this.radial ? { radial: this.radial } : {}), ...(this.lock ? { direction: this.lock } : {}) };
  }
  /** The dimension the picks (and a candidate) make with the text at `at`. */
  infer(picks: SnapTarget[], at: Vec2) {
    const sheet = this.ctx().sheet;
    if (!sheet) return "The sheet is still being drawn";
    return inferDimension(sheet, picks.map(pickOf), at, this.opts());
  }
  /** True when a sheet point is on a view (inside its lines' box). */
  onView(view: string, p: Vec2): boolean {
    const b = this.cv(view)?.box;
    return !!b && p[0] >= b.min[0] - 0.5 && p[0] <= b.max[0] + 0.5 && p[1] >= b.min[1] - 0.5 && p[1] <= b.max[1] + 0.5;
  }
  /** A hovered item that would be a good second pick. */
  candidate(p: SheetPointer | null): SnapTarget | null {
    const s = p?.snap;
    if (!s || this.picks.length !== 1 || this.picks.some((x) => x.ref === s.ref) || s.view !== this.picks[0].view || !this.onView(s.view, p!.raw)) return null;
    return typeof this.infer([...this.picks, s], p!.raw) === "string" ? null : s;
  }
  click(p: SheetPointer) {
    const c = this.ctx();
    const s = p.snap;
    if (!this.picks.length) {
      if (!s) return c.notice("Click an edge, a circle or a point of a view.", "error");
      if (!square(c, s.view)) return c.notice(`${s.view} looks at the part at an angle, which shortens every length: dimension in a front, top, side or section view.`, "error");
      this.picks = [s];
      return c.refresh();
    }
    // A click off the view places the dimension, whatever is under the pointer; on it, it may be a second pick.
    if (s && this.picks.length === 1 && !this.picks.some((x) => x.ref === s.ref) && this.onView(this.picks[0].view, p.raw)) {
      if (this.candidate(p)) {
        this.picks.push(s);
        return c.refresh();
      }
      if (POINTS.includes(this.picks[0].kind)) return c.notice(String(this.infer([...this.picks, s], p.raw)), "error");
    }
    this.place(p.raw);
  }
  place(at: Vec2) {
    const c = this.ctx();
    const d = this.infer(this.picks, at);
    if (typeof d === "string") return c.notice(d, "error");
    const fav = favourites().find((f) => f.name === this.style);
    const extra = fav ? applyFavourite({ id: "", ...d }, fav) : {};
    if (typeof extra === "string") c.notice(extra);
    if (this.add({ ...d, ...(typeof extra === "string" ? {} : extra) })) this.picks = [];
    c.refresh();
  }
  key(e: KeyboardEvent) {
    const k = e.key.toLowerCase();
    if (e.key === "Backspace" && this.picks.length) {
      this.picks.pop();
      this.ctx().refresh();
      return true;
    }
    if (k === "r" && !e.ctrlKey) {
      this.radial = this.radial === "diameter" ? "radius" : this.radial === "radius" ? undefined : "diameter";
      this.ctx().refresh();
      return true;
    }
    const locks: Record<string, DimensionDirection> = { h: "horizontal", v: "vertical", a: "aligned" };
    if (locks[k] && !e.ctrlKey) {
      this.lock = this.lock === locks[k] ? undefined : locks[k];
      this.ctx().refresh();
      return true;
    }
    return false;
  }
  overlay(): OverlayShape[] {
    const out: OverlayShape[] = this.picks.flatMap((t) => this.highlight(t));
    const h = this.hover;
    if (!this.picks.length || !h) return out;
    const cand = this.candidate(h);
    if (cand) out.push(...this.highlight(cand, "preview"));
    const picks = cand ? [...this.picks, cand] : this.picks;
    if (picks.length === 1 && POINTS.includes(picks[0].kind)) return out;
    return [...out, ...this.preview(this.infer(picks, h.raw), h.raw)];
  }
  panel(): ReactNode {
    const set = (f: () => void) => {
      f();
      this.ctx().refresh();
    };
    return (
      <div className="session-options">
        <Row label="Circles and arcs" hint="R toggles">
          <Segmented
            label="Circles and arcs"
            value={this.radial ?? "auto"}
            options={[
              ["auto", "Auto", "A circle by its diameter, an arc by its radius"],
              ["diameter", "Ø", "Diameter"],
              ["radius", "R", "Radius"],
            ]}
            onChange={(v) => set(() => (this.radial = v === "auto" ? undefined : v))}
            testId="dim-radial"
          />
        </Row>
        <Row label="Direction" hint="H, V, A lock it">
          <Segmented
            label="Direction"
            value={this.lock ?? "auto"}
            options={[
              ["auto", "Pointer", "Across, up or along by where the pointer is"],
              ["horizontal", "H", "Horizontal"],
              ["vertical", "V", "Vertical"],
              ["aligned", "Along", "Aligned with the points"],
            ]}
            onChange={(v) => set(() => (this.lock = v === "auto" ? undefined : v))}
            testId="dim-lock"
          />
        </Row>
        <Row label="New dimensions get" hint="A favourite style each new dimension takes">
          <select value={this.style} onChange={(e) => set(() => (this.style = e.target.value))} data-testid="dim-style">
            <option value="">no tolerance</option>
            {favourites().map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </Row>
        <div className="drawing-buttons">
          {(["chain", "baseline", "ordinate"] as const).map((m) => (
            <button key={m} type="button" onClick={() => this.ctx().startSession?.(new SetSession(this.ctx, m))} data-testid={`dim-mode-${m}`} title={`${m[0].toUpperCase()}${m.slice(1)} dimensions: an origin, then points`}>
              {m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
        <p className="muted small">Two edges at an angle: the angle, of the quadrant the pointer is in. A point and an edge: the distance square from it. A cylinder's two sides: Ø. Backspace drops the last pick; Esc lets go.</p>
      </div>
    );
  }
}

registerDrawingTool({
  id: "annotation.smartDimension",
  tab: "annotation",
  group: "dimension",
  label: "Smart Dimension",
  icon: "smartDimension",
  title: "Dimension what you pick: an edge's length, a circle's Ø, an arc's R, two points, two edges' distance or angle, a cylinder's Ø; the preview follows the pointer",
  key: "D",
  testId: "tool-annotation-dimension",
  disabled: noViews,
  run: (get) => new SmartDimensionSession(get),
});

// ------------------------------------------------------------ chain, baseline, ordinate

type SetMode = "chain" | "baseline" | "ordinate";

export class SetSession extends ToolSession {
  origin: SnapTarget | null = null;
  points: SnapTarget[] = [];
  constructor(
    get: () => DrawingToolCtx,
    public mode: SetMode,
  ) {
    super(`annotation.${mode}Dimension`, get);
  }
  name() {
    return `${this.mode[0].toUpperCase()}${this.mode.slice(1)} dimensions`;
  }
  busy() {
    return !!this.origin;
  }
  reset() {
    this.origin = null;
    this.points = [];
  }
  prompt() {
    if (!this.origin) return this.mode === "chain" ? "Click the chain's first point" : "Click the origin (a corner, an edge's end, a hole's centre)";
    return this.points.length ? "Click more points; click off the part (or double-click) to place the set" : "Click the points to measure";
  }
  snaps() {
    return { kinds: [...POINTS, "circle", "arc"] as SnapKind[], view: this.origin?.view ?? null };
  }
  refOf(s: SnapTarget): string {
    return s.kind === "circle" || s.kind === "arc" ? centreRef(s.ref) : s.ref;
  }
  set(at: Vec2, extra?: SnapTarget) {
    const sheet = this.ctx().sheet;
    if (!sheet || !this.origin) return "Click the origin first";
    return setFromPicks(sheet, this.mode, this.refOf(this.origin), [...this.points, ...(extra ? [extra] : [])].map((s) => this.refOf(s)), at);
  }
  click(p: SheetPointer) {
    const c = this.ctx();
    const b = this.origin ? this.cv(this.origin.view)?.box : null;
    const off = !!b && (p.raw[0] < b.min[0] - 0.5 || p.raw[0] > b.max[0] + 0.5 || p.raw[1] < b.min[1] - 0.5 || p.raw[1] > b.max[1] + 0.5);
    // Off the view: the set is placed there, whatever is under the pointer.
    const s = off && this.points.length ? null : p.snap;
    if (s) {
      if (!this.origin) {
        if (!square(c, s.view)) return c.notice(`${s.view} looks at the part at an angle: dimension in a square view.`, "error");
        this.origin = s;
        return c.refresh();
      }
      if (s.view === this.origin.view && ![this.origin, ...this.points].some((x) => this.refOf(x) === this.refOf(s))) {
        this.points.push(s);
        return c.refresh();
      }
    }
    this.place(p.raw);
  }
  doubleClick(p: SheetPointer) {
    this.place(p.raw);
  }
  place(at: Vec2) {
    const c = this.ctx();
    if (!this.origin || !this.points.length) return c.notice(this.prompt(), "error");
    const d = this.set(at);
    if (typeof d === "string") return c.notice(d, "error");
    if (this.add(d)) this.reset();
    c.refresh();
  }
  key(e: KeyboardEvent) {
    if (e.key === "Backspace" && this.origin) {
      if (this.points.length) this.points.pop();
      else this.origin = null;
      this.ctx().refresh();
      return true;
    }
    return false;
  }
  overlay(): OverlayShape[] {
    const out: OverlayShape[] = [this.origin, ...this.points].flatMap((t) => (t ? [{ k: "dot", at: t.circle?.c ?? t.at, tone: "accent" } as OverlayShape] : []));
    const h = this.hover;
    if (!h || !this.origin) return out;
    const b = this.cv(this.origin.view)?.box;
    const off = !!b && (h.raw[0] < b.min[0] - 0.5 || h.raw[0] > b.max[0] + 0.5 || h.raw[1] < b.min[1] - 0.5 || h.raw[1] > b.max[1] + 0.5);
    const extra = h.snap && h.snap.view === this.origin.view && !off ? h.snap : undefined;
    if (!this.points.length && !extra) return out;
    return [...out, ...this.preview(this.set(h.raw, extra), h.raw)];
  }
  panel(): ReactNode {
    return (
      <div className="session-options">
        <Row label="Kind">
          <Segmented
            label="Kind of set"
            value={this.mode}
            options={[
              ["chain", "Chain", "Each from the one before, on one line"],
              ["baseline", "Baseline", "Each from the origin, stacked outward"],
              ["ordinate", "Ordinate", "Each point's distance from the origin, on its own extension line"],
            ]}
            onChange={(m) => {
              this.mode = m;
              this.ctx().refresh();
            }}
            testId="set-mode"
          />
        </Row>
        <p className="muted small" data-testid="set-picked">
          {this.origin ? `Origin ${this.origin.label}; ${this.points.length} point${this.points.length === 1 ? "" : "s"}` : "Nothing picked yet"}
        </p>
      </div>
    );
  }
}

for (const [mode, label, title] of [
  ["chain", "Chain Dimension", "Dimensions in a row, each from the one before: click the first point, the next ones, then where the line goes"],
  ["baseline", "Baseline Dimension", "Dimensions from one origin, stacked outward: click the origin, the points, then where they go"],
  ["ordinate", "Ordinate Dimension", "Each point's distance from an origin, on its own extension line: click the origin, the points, then where they go"],
] as const) {
  registerDrawingTool({ id: `annotation.${mode}Dimension`, tab: "annotation", group: "dimension", label, icon: mode === "ordinate" ? "linearPattern" : mode === "chain" ? "horizontal" : "dimension", title, testId: `tool-annotation-${mode}`, disabled: noViews, run: (get) => new SetSession(get, mode) });
}

// ------------------------------------------------------------ chamfer, hole callout

/** Pick something, then click where its text goes. */
class PickPlaceSession extends ToolSession {
  target: SnapTarget | null = null;
  constructor(
    tool: string,
    get: () => DrawingToolCtx,
    readonly what: string,
    readonly kinds: SnapKind[],
    readonly ask: string,
    readonly make: (t: SnapTarget, at: Vec2, c: DrawingToolCtx) => Record<string, unknown> | string,
    readonly options?: (s: PickPlaceSession) => ReactNode,
  ) {
    super(tool, get);
  }
  name() {
    return this.what;
  }
  busy() {
    return !!this.target;
  }
  reset() {
    this.target = null;
  }
  prompt() {
    return this.target ? "Click where the text goes" : this.ask;
  }
  snaps() {
    return this.target ? { kinds: [] as SnapKind[] } : { kinds: this.kinds };
  }
  click(p: SheetPointer) {
    const c = this.ctx();
    if (!this.target) {
      if (!p.snap) return c.notice(this.ask, "error");
      const r = this.make(p.snap, p.raw, c);
      if (typeof r === "string") return c.notice(r, "error");
      this.target = p.snap;
      return c.refresh();
    }
    const r = this.make(this.target, p.raw, c);
    if (typeof r === "string") return c.notice(r, "error");
    if (this.add(r as Record<string, unknown> & { type: string })) this.target = null;
    c.refresh();
  }
  overlay(): OverlayShape[] {
    const h = this.hover;
    if (!this.target) return h?.snap ? this.highlight(h.snap, "preview") : [];
    return [...this.highlight(this.target), ...(h ? this.preview(this.make(this.target, h.raw, this.ctx()), h.raw) : [])];
  }
  panel(): ReactNode {
    return this.options?.(this) ?? null;
  }
}

registerDrawingTool({
  id: "annotation.chamfer",
  tab: "annotation",
  group: "dimension",
  label: "Chamfer Dimension",
  icon: "chamfer",
  title: "A chamfer's size and angle (C2, or 2 × 45°): click the chamfer's slanted edge, then where the text goes",
  testId: "tool-annotation-chamfer",
  disabled: noViews,
  run: (get) =>
    new PickPlaceSession("annotation.chamfer", get, "Chamfer dimension", ["edge"], "Click a chamfer's slanted edge", (t, at, c) => {
      const pts = t.pts?.flat() ?? [];
      const a = pts[0];
      const b = pts[pts.length - 1];
      if (!a || !b || Math.abs(a[0] - b[0]) < 1e-6 || Math.abs(a[1] - b[1]) < 1e-6) return "A chamfer is seen as a slanted edge: click one";
      if (!square(c, t.view)) return `${t.view} is at an angle to the part`;
      return { type: "dimension", view: t.view, kind: "chamfer", refs: [t.ref], at: rel(c, t.view, at) };
    }),
});

function rel(c: DrawingToolCtx, view: string, p: Vec2): Vec2 {
  const cv = c.sheet?.views.find((v) => v.id === view);
  const o = cv ? cv.centre : [0, 0];
  return [Math.round((p[0] - o[0]) * 10) / 10 + 0, Math.round((p[1] - o[1]) * 10) / 10 + 0];
}

const HOLE_TOLERANCES: [string, string][] = [
  ["", "none"],
  ["H7", "H7"],
  ["H8", "H8"],
  ["H11", "H11"],
  ["±0.1", "±0.1"],
];

registerDrawingTool({
  id: "annotation.hole",
  tab: "annotation",
  group: "notes",
  label: "Hole Callout",
  icon: "hole",
  title: "Call out a hole from its feature (Ø, depth ↧, counterbore ⌴, countersink ⌵, thread, n×): click its circle, then where the text goes",
  testId: "tool-annotation-hole",
  disabled: noViews,
  run: (get) => {
    let tol = "";
    return new PickPlaceSession(
      "annotation.hole",
      get,
      "Hole callout",
      ["circle", "centre"],
      "Click a hole's circle (where the view looks into it)",
      (t, at, c) => {
        if (!c.sheet) return "The sheet is still being drawn";
        const h = holeFromPick(c.sheet, t.kind === "centre" ? t.ref : t.ref, at);
        if (typeof h === "string") return h.charAt(0).toUpperCase() + h.slice(1);
        if (c.sheetDoc.annotations.some((a) => a.type === "hole" && a.view === h.view && a.hole === h.hole)) return `${h.hole} is called out in ${h.view} already`;
        const tolerance = tol === "±0.1" ? { kind: "symmetric", plus: 0.1 } : tol ? { kind: "fitWithTol", fit: tol } : undefined;
        return { ...h, ...(tolerance ? { tolerance } : {}) };
      },
      (s) => (
        <div className="session-options">
          <Row label="Bore tolerance">
            <Segmented
              label="Bore tolerance"
              value={tol}
              options={HOLE_TOLERANCES.map(([v, l]) => [v, l] as const)}
              onChange={(v) => {
                tol = v;
                s.redraw();
              }}
              testId="hole-tol"
            />
          </Row>
        </div>
      ),
    );
  },
});

// ------------------------------------------------------------ centre marks and centre lines

type MarkMode = "single" | "linear" | "circular";

class CentreMarkSession extends ToolSession {
  mode: MarkMode = "single";
  constructor(get: () => DrawingToolCtx) {
    super("annotation.centerMark", get);
  }
  name() {
    return "Centre mark";
  }
  busy() {
    return false;
  }
  reset() {}
  prompt() {
    return this.mode === "single" ? "Click a circle or an arc" : this.mode === "linear" ? "Click a circle of a row: every alike circle in line gets a mark, joined by a centre line" : "Click a circle of a bolt circle: every alike circle gets a mark on the pitch circle";
  }
  snaps() {
    return { kinds: ["circle", "arc", "centre"] as SnapKind[] };
  }
  /** The alike circles (same feature, same size) in the view, by centre. */
  alike(t: SnapTarget): SnapTarget[] {
    const s = this.ctx().snap;
    const r = t.circle?.r;
    if (!s || r === undefined) return [t];
    return s.targets.filter((x) => x.view === t.view && x.kind === "circle" && x.visible && x.feature === t.feature && Math.abs((x.circle?.r ?? 0) - r) < 1e-3);
  }
  click(p: SheetPointer) {
    const c = this.ctx();
    const t = p.snap;
    if (!t || !c.sheet) return c.notice(this.prompt(), "error");
    const has = (ref: string) => c.sheetDoc.annotations.some((a) => a.type === "centerMark" && (a.at === ref || a.at === ref.replace(":c", ":e") || a.at === ref.replace(":e", ":c")));
    if (this.mode === "single") {
      const m = centerMarkFromPick(c.sheet, t.ref);
      if (typeof m === "string") return c.notice(m, "error");
      if (has(m.at)) return c.notice("That circle has a centre mark already", "error");
      return void this.add(m);
    }
    const group = this.alike(t);
    const cmds: Command[] = [];
    const taken = new Set<string>();
    const id = (prefix: string) => {
      let n = c.nextId(prefix);
      while (taken.has(n)) n = `${prefix}${Number(n.slice(prefix.length)) + 1}`;
      taken.add(n);
      return n;
    };
    for (const g of group) {
      if (has(g.ref)) continue;
      cmds.push({ type: "setAnnotation", id: id("c"), annotation: { type: "centerMark", view: g.view, at: g.ref, ...(this.mode === "circular" ? { style: "pitch" } : {}) }, sheet: c.sheetDoc.id });
    }
    if (this.mode === "linear" && group.length > 1) {
      // Joined in order along the row they make.
      const xs = group.map((g) => g.circle!.c);
      const spreadX = Math.max(...xs.map((p) => p[0])) - Math.min(...xs.map((p) => p[0]));
      const spreadY = Math.max(...xs.map((p) => p[1])) - Math.min(...xs.map((p) => p[1]));
      const axis = spreadX >= spreadY ? 0 : 1;
      const sorted = [...group].sort((a, b) => a.circle!.c[axis] - b.circle!.c[axis]);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const line = centerlineFromPicks(c.sheet, centreRef(first.ref), centreRef(last.ref));
      if (typeof line !== "string") cmds.push({ type: "setAnnotation", id: id("c"), annotation: line, sheet: c.sheetDoc.id });
    }
    if (!cmds.length) return c.notice("Those circles are marked already", "error");
    if (!keep(c, cmds)) {
      this.made.push(...cmds.map((x) => (x as { id: string }).id));
      c.notice(`${cmds.length} centre mark${cmds.length === 1 ? "" : "s"}${this.mode === "linear" && group.length > 1 ? " and a centre line" : ""} added.`);
    }
  }
  overlay(): OverlayShape[] {
    const t = this.hover?.snap;
    if (!t) return [];
    return (this.mode === "single" ? [t] : this.alike(t)).flatMap((x) => this.highlight(x, "preview"));
  }
  panel(): ReactNode {
    return (
      <div className="session-options">
        <Row label="Marks">
          <Segmented
            label="Centre marks"
            value={this.mode}
            options={[
              ["single", "One", "One circle"],
              ["linear", "Row", "A row of alike holes: each marked, joined by a centre line"],
              ["circular", "Bolt circle", "A circular pattern: each marked on its pitch circle"],
            ]}
            onChange={(m) => {
              this.mode = m;
              this.ctx().refresh();
            }}
            testId="mark-mode"
          />
        </Row>
      </div>
    );
  }
}

registerDrawingTool({
  id: "annotation.centerMark",
  tab: "annotation",
  group: "marks",
  label: "Centre Mark",
  icon: "plus",
  title: "Centre marks: on one circle, on a row of alike holes (joined by a centre line), or round a bolt circle",
  testId: "tool-annotation-center-mark",
  disabled: noViews,
  run: (get) => new CentreMarkSession(get),
});

class CentrelineSession extends ToolSession {
  first: SnapTarget | null = null;
  constructor(get: () => DrawingToolCtx) {
    super("annotation.centerline", get);
  }
  name() {
    return "Centreline";
  }
  busy() {
    return !!this.first;
  }
  reset() {
    this.first = null;
  }
  prompt() {
    return this.first ? "Click the other edge (or the other circle's centre)" : "Click a cylinder's side (its other side is found), an edge, or a circle's centre";
  }
  snaps() {
    return { kinds: ["edge", "centre", "circle"] as SnapKind[], view: this.first?.view ?? null };
  }
  /** A cylinder's other outline: "…s0a" ↔ "…s0b". */
  partner(t: SnapTarget): SnapTarget | null {
    const m = /^(.*s\d+)([ab])$/.exec(t.ref);
    if (!m) return null;
    const other = `${m[1]}${m[2] === "a" ? "b" : "a"}`;
    return this.ctx().snap?.targets.find((x) => x.ref === other) ?? null;
  }
  click(p: SheetPointer) {
    const c = this.ctx();
    const t = p.snap;
    if (!t || !c.sheet) return c.notice(this.prompt(), "error");
    const ref = t.kind === "circle" ? centreRef(t.ref) : t.ref;
    if (!this.first) {
      const other = this.partner(t);
      if (other) {
        const l = centerlineFromPicks(c.sheet, t.ref, other.ref);
        if (typeof l === "string") return c.notice(l, "error");
        return void this.add(l);
      }
      this.first = { ...t, ref };
      return c.refresh();
    }
    if (ref === this.first.ref) return;
    const l = centerlineFromPicks(c.sheet, this.first.ref, ref);
    if (typeof l === "string") return c.notice(l, "error");
    if (this.add(l)) this.first = null;
  }
  overlay(): OverlayShape[] {
    const h = this.hover?.snap;
    const other = h && !this.first ? this.partner(h) : null;
    return [...this.highlight(this.first), ...this.highlight(h, "preview"), ...this.highlight(other, "preview")];
  }
}

registerDrawingTool({
  id: "annotation.centerline",
  tab: "annotation",
  group: "marks",
  label: "Centreline",
  icon: "centerline",
  title: "A centre line: click one side of a cylinder (the other is found), or two edges, or two circles' centres",
  testId: "tool-annotation-centerline",
  disabled: noViews,
  run: (get) => new CentrelineSession(get),
});

// ------------------------------------------------------------ Model Items

class ModelItemsSession extends ToolSession {
  source = "";
  views: string[] = [];
  sketch = true;
  feature = true;
  holes = true;
  constructor(get: () => DrawingToolCtx) {
    super("annotation.modelItems", get);
    const c = get();
    const chosen = c.selection.filter((id) => c.sheetDoc.views.some((v) => v.id === id));
    this.views = chosen.length ? chosen : (c.sheet?.views ?? []).filter((v) => v.square && v.kind !== "detail").map((v) => v.id);
  }
  name() {
    return "Model items";
  }
  busy() {
    return false;
  }
  reset() {}
  prompt() {
    return "Choose what to bring in and the views (click a view to add or take it away), then Import";
  }
  picksViews() {
    return true;
  }
  click(p: SheetPointer) {
    const v = p.view;
    if (!v) return;
    this.views = this.views.includes(v) ? this.views.filter((x) => x !== v) : [...this.views, v];
    this.ctx().refresh();
  }
  features(): { id: string; op: string }[] {
    return validateDocument(this.ctx().doc).features.flatMap((f) => (f.feature && f.feature.op !== "sketch" && !(f.feature as { suppressed?: boolean }).suppressed ? [{ id: f.feature.id, op: f.feature.op }] : []));
  }
  run(): string | null {
    const c = this.ctx();
    if (!c.sheet) return "The sheet is still being drawn";
    if (!this.views.length) return "Choose a view to put them in";
    const r = modelItems(c.doc, c.sheet, c.sheetDoc.annotations, { views: this.views, sketch: this.sketch, feature: this.feature, holes: this.holes, ...(this.source ? { features: [this.source] } : {}) });
    if (!r.items.length) return r.missed.length ? `Nothing to bring in that a chosen view shows true size (${r.missed.slice(0, 3).join("; ")})` : "Every model dimension is on the sheet already";
    const taken = new Set<string>();
    const cmds: Command[] = r.items.map((a) => {
      const prefix = a.type === "hole" ? "h" : "d";
      let id = c.nextId(prefix);
      while (taken.has(id)) id = `${prefix}${Number(id.slice(prefix.length)) + 1}`;
      taken.add(id);
      return { type: "setAnnotation", id, annotation: a, sheet: c.sheetDoc.id };
    });
    if (keep(c, cmds)) return "refused";
    this.made.push(...cmds.map((x) => (x as { id: string }).id));
    c.select(this.made);
    c.notice(`Model items: ${cmds.length} brought in${r.missed.length ? `; ${r.missed.length} not shown true size in the chosen views` : ""}. Ctrl+Z takes them away.`);
    return null;
  }
  ok(): string | null {
    if (!this.made.length) {
      const why = this.run();
      if (why) return why;
    }
    this.ctx().end();
    return null;
  }
  overlay(): OverlayShape[] {
    const s = this.ctx().sheet;
    return this.views.flatMap((id) => {
      const b = s?.views.find((v) => v.id === id)?.box;
      return b ? [{ k: "rect", box: { min: [b.min[0] - 2, b.min[1] - 2], max: [b.max[0] + 2, b.max[1] + 2] }, tone: "accent", fill: true } as OverlayShape] : [];
    });
  }
  panel(): ReactNode {
    const c = this.ctx();
    const set = (f: () => void) => {
      f();
      c.refresh();
    };
    return (
      <div className="session-options">
        <Row label="From">
          <select value={this.source} onChange={(e) => set(() => (this.source = e.target.value))} data-testid="model-items-source">
            <option value="">the entire model</option>
            {this.features().map((f) => (
              <option key={f.id} value={f.id}>
                {f.id} ({f.op})
              </option>
            ))}
          </select>
        </Row>
        <fieldset className="check-list">
          <legend>Bring in</legend>
          {(
            [
              ["sketch", "Sketch dimensions (radii, diameters, lengths)"],
              ["feature", "Feature dimensions (depths, fillets, chamfers, member lengths)"],
              ["holes", "Hole callouts"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="check">
              <input type="checkbox" checked={this[k]} onChange={(e) => set(() => (this[k] = e.target.checked))} data-testid={`model-items-${k}`} /> {label}
            </label>
          ))}
        </fieldset>
        <fieldset className="check-list">
          <legend>Into the views</legend>
          {(c.sheet?.views ?? [])
            .filter((v) => v.square)
            .map((v) => (
              <label key={v.id} className="check">
                <input type="checkbox" checked={this.views.includes(v.id)} onChange={(e) => set(() => (this.views = e.target.checked ? [...this.views, v.id] : this.views.filter((x) => x !== v.id)))} data-testid={`model-items-view-${v.id}`} /> {v.id}
              </label>
            ))}
        </fieldset>
        <div className="drawing-buttons">
          <button
            type="button"
            className="primary"
            onClick={() => {
              const why = this.run();
              if (why) c.notice(why, "error");
              c.refresh();
            }}
            data-testid="model-items-import"
          >
            Import
          </button>
        </div>
      </div>
    );
  }
}

registerDrawingTool({
  id: "annotation.modelItems",
  tab: "annotation",
  group: "dimension",
  label: "Model Items",
  icon: "drivenDimension",
  title: "Bring the part's own dimensions into views: its sketches' sizes, depths, holes, fillets, chamfers, member lengths; each once on the sheet",
  testId: "tool-annotation-model-items",
  disabled: noViews,
  run: (get) => new ModelItemsSession(get),
});
