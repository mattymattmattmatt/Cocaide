// The View Layout tools (Phase Q wave Q2B), each a session on the sheet:
// Standard 3 View; Model View (an orientation picked from a palette of the
// part seen each way, the 3D view's own among them); Projected View (pick
// the parent, move to a side: the preview follows, lined up); Section View
// (pick the parent, draw the cutting line, snapping to circle centres, then
// slide the section out along its projection line: across to the other side
// turns it round); Detail View (a circle on the parent, then place it);
// Auxiliary View (pick a slanted edge, place); Broken-out Section and Crop
// (a closed outline on the view); Break (two break lines on a view).

import { useEffect, useState, type ReactNode } from "react";
import type { Command } from "../../../doc/commands";
import { STANDARD_SCALES, viewKind } from "../../../doc/drawing";
import { DETAIL_STYLES, DISPLAY_MODES, VIEW_LOOKS, type DrawingView, type ProjectDirection, type Vec2, type Vec3, type ViewLook } from "../../../doc/types";
import type { ProjectedView } from "../../../kernel/drawingViews";
import { DIRECTION_VECTORS } from "../../../drafting/views";
import { attachSide } from "../align";
import { BaseSession, breakLine, viewBody } from "./session";
import { alignedCoordinate, extendThrough, r2, sheetToView, squareTurn, squareUp } from "./geometry";
import { registerDrawingTool } from "./registry";
import type { DrawingToolCtx, OverlayShape, SheetPointer } from "./types";

const LOOK_LABEL: Record<ViewLook, string> = { front: "Front", back: "Back", top: "Top", bottom: "Bottom", left: "Left", right: "Right", iso: "Isometric", dimetric: "Dimetric", trimetric: "Trimetric" };
const DISPLAY_LABEL: Record<(typeof DISPLAY_MODES)[number], string> = { removed: "Hidden lines removed", hidden: "Hidden lines dashed", visible: "Wireframe", shaded: "Shaded", shadedEdges: "Shaded with edges" };

const noViews = (c: DrawingToolCtx) => (c.sheetDoc.views.length ? undefined : "Add a view first (Model View or Standard 3 View)");
const noPart = (c: DrawingToolCtx) => (c.measurements ? undefined : "The part needs to rebuild first");

/** A view's id: the word when it is free, else the word with the next number. */
function freeId(c: DrawingToolCtx, word: string): string {
  const used = new Set(c.drawing.sheets.flatMap((s) => [...s.views.map((v) => v.id), ...s.annotations.map((a) => a.id), ...(s.tables ?? []).map((t) => t.id)]));
  return used.has(word) ? c.nextId(`${word}_`) : word;
}

// ------------------------------------------------------------ Standard 3 View

registerDrawingTool({
  id: "view.standard3",
  tab: "layout",
  group: "views",
  label: "Standard 3 View",
  icon: "examples",
  title: "Front, top and right views of the part, lined up (third or first angle, as the sheet projects)",
  testId: "tool-view-standard3",
  disabled: noPart,
  run: (get) => {
    const c = get();
    const front = freeId(c, "front");
    const first = c.sheetDoc.projection === "first";
    const top = freeId(c, "top");
    const right = freeId(c, "right");
    const cmds: Command[] = [
      { type: "setView", id: front, view: { look: "front" }, sheet: c.sheetDoc.id },
      { type: "setView", id: top, view: { kind: "projected", parent: front, direction: first ? "down" : "up" }, sheet: c.sheetDoc.id },
      { type: "setView", id: right, view: { kind: "projected", parent: front, direction: first ? "left" : "right" }, sheet: c.sheetDoc.id },
    ];
    if (!c.batch(cmds)) {
      c.select([front]);
      c.notice(`Added ${front}, ${top} and ${right}, lined up in ${first ? "first" : "third"} angle.`);
    }
  },
});

// ------------------------------------------------------------ Model View

/** A spec for each orientation's thumbnail: the looks, and the 3D view's. */
function thumbSpecs(camera: { eye: Vec3; up: Vec3 } | null) {
  return [...VIEW_LOOKS.map((look) => ({ id: `__thumb_${look}`, look })), ...(camera ? [{ id: "__thumb_camera", frame: { frame: frameOf(camera) } }] : [])];
}

function frameOf(cam: { eye: Vec3; up: Vec3 }) {
  const e = cam.eye;
  const up = cam.up;
  const right: Vec3 = [up[1] * e[2] - up[2] * e[1], up[2] * e[0] - up[0] * e[2], up[0] * e[1] - up[1] * e[0]];
  return { eye: e, up, right };
}

/** The part's visible edges as a little picture, fitted to its box. */
function Thumb({ pv }: { pv: ProjectedView | undefined }) {
  if (!pv) return <svg className="thumb" viewBox="0 0 10 10" aria-hidden="true" />;
  const lines = pv.edges.filter((e) => e.visible).map((e) => e.pts);
  const all = lines.flat();
  if (!all.length) return <svg className="thumb" viewBox="0 0 10 10" aria-hidden="true" />;
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const s = Math.max(x1 - x0, y1 - y0) || 1;
  const pad = s * 0.08;
  return (
    <svg className="thumb" viewBox={`${x0 - pad} ${-y1 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {lines.map((l, i) => (
        <polyline key={i} points={l.map((p) => `${p[0]},${-p[1]}`).join(" ")} fill="none" stroke="currentColor" strokeWidth={s / 90} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

/** The orientations, each a picture of the part seen that way. */
export function OrientationPalette({ ctx, value, onPick }: { ctx: () => DrawingToolCtx; value: string; onPick(v: string): void }) {
  const [pics, setPics] = useState<Map<string, ProjectedView> | null>(null);
  const camera = ctx().camera?.() ?? null;
  useEffect(() => {
    let live = true;
    const c = ctx();
    if (!c.project) return;
    c.project(thumbSpecs(camera) as never).then(
      (g) => live && setPics(new Map((g?.views ?? []).map((v) => [v.id.replace("__thumb_", ""), v]))),
      () => live && setPics(new Map()),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const entries: [string, string][] = [...VIEW_LOOKS.map((l): [string, string] => [l, LOOK_LABEL[l]]), ...(camera ? [["camera", "3D view"] as [string, string]] : [])];
  return (
    <div className="orient-palette" role="listbox" aria-label="Orientation" data-testid="orient-palette">
      {entries.map(([k, label]) => (
        <button key={k} role="option" aria-selected={value === k} className={`orient${value === k ? " on" : ""}`} onClick={() => onPick(k)} title={k === "camera" ? "The 3D view's orientation as you left it" : `${label} view`} data-testid={`orient-${k}`}>
          {pics ? <Thumb pv={pics.get(k)} /> : <span className="thumb loading" />}
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

class ModelViewSession extends BaseSession {
  orient: string = "front";
  scale = "";
  display = "";
  id: string | null = null;

  constructor(ctx: () => DrawingToolCtx) {
    super("view.model", ctx);
    // The first look the sheet doesn't show yet.
    const have = new Set(ctx().sheetDoc.views.map((v) => v.look ?? ""));
    this.orient = (["front", "iso", "top", "right"] as ViewLook[]).find((l) => !have.has(l)) ?? "front";
  }
  title() {
    return this.id ? `Add ${this.id}` : "Model view";
  }
  prompt() {
    return this.id ? "Click to move it, pick another orientation, or OK" : `Click on the sheet where the ${this.orient === "camera" ? "3D view's" : LOOK_LABEL[this.orient as ViewLook].toLowerCase()} view goes`;
  }
  private body(): Record<string, unknown> | null {
    const c = this.ctx();
    let v: Record<string, unknown>;
    if (this.orient === "camera") {
      const cam = c.camera?.();
      if (!cam) return null;
      v = { orientation: { eye: cam.eye, up: cam.up } };
    } else v = { look: this.orient };
    if (this.scale) v.scale = this.scale;
    if (this.display) v.display = this.display;
    return v;
  }
  private write(at?: Vec2) {
    const body = this.body();
    if (!body) return this.ctx().notice("The 3D view's orientation isn't known yet: turn the part in the model first.", "error");
    const c = this.ctx();
    if (!this.id) this.id = freeId(c, this.orient === "camera" ? "view" : this.orient);
    const old = this.view(this.id);
    if (!at && old?.at) at = old.at;
    this.live({ type: "setView", id: this.id, view: { ...body, ...(at ? { at: r2(at) } : {}) }, sheet: c.sheetDoc.id });
    c.select([this.id]);
  }
  click(p: SheetPointer) {
    this.write(p.raw);
  }
  set(patch: { orient?: string; scale?: string; display?: string }) {
    Object.assign(this, patch);
    if (this.id) this.write();
    this.ctx().refresh();
  }
  overlay(): OverlayShape[] {
    if (!this.hover || this.id) return [];
    const s = this.px(60);
    const at = this.hover.raw;
    return [
      { k: "rect", box: { min: [at[0] - s, at[1] - s * 0.7], max: [at[0] + s, at[1] + s * 0.7] }, tone: "preview", dash: true },
      { k: "label", at: [at[0], at[1] + s * 0.7 + this.px(8)], text: this.orient === "camera" ? "3D view" : LOOK_LABEL[this.orient as ViewLook], tone: "preview" },
    ];
  }
  panel(): ReactNode {
    return (
      <div className="session-options">
        <OrientationPalette ctx={this.ctx} value={this.orient} onPick={(orient) => this.set({ orient })} />
        <label className="field">
          <span className="field-label">Scale</span>
          <select value={this.scale} onChange={(e) => this.set({ scale: e.target.value })} data-testid="model-view-scale">
            <option value="">the sheet's</option>
            {STANDARD_SCALES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Display</span>
          <select value={this.display} onChange={(e) => this.set({ display: e.target.value })} data-testid="model-view-display">
            <option value="">{DISPLAY_LABEL.removed}</option>
            {DISPLAY_MODES.filter((m) => m !== "removed").map((m) => (
              <option key={m} value={m}>
                {DISPLAY_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  }
}

registerDrawingTool({
  id: "view.model",
  tab: "layout",
  group: "views",
  label: "Model View",
  icon: "view",
  title: "A view of the part from a named orientation, iso, dimetric, trimetric or the 3D view's: pick it, click where it goes",
  testId: "tool-view-model",
  disabled: noPart,
  run: (get) => new ModelViewSession(get),
});

// ------------------------------------------------------------ Projected View

/** The side of a view a point is toward: a corner when it is past the box both ways, else the nearer side. */
export function projectSide(box: { min: Vec2; max: Vec2 }, p: Vec2): ProjectDirection {
  const right = p[0] > box.max[0];
  const left = p[0] < box.min[0];
  const up = p[1] > box.max[1];
  const down = p[1] < box.min[1];
  if ((right || left) && (up || down)) return `${up ? "up" : "down"}${right ? "Right" : "Left"}` as ProjectDirection;
  const cx = (box.min[0] + box.max[0]) / 2;
  const cy = (box.min[1] + box.max[1]) / 2;
  const w = (box.max[0] - box.min[0]) / 2 || 1;
  const h = (box.max[1] - box.min[1]) / 2 || 1;
  const dx = (p[0] - cx) / w;
  const dy = (p[1] - cy) / h;
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "right" : "left") : dy >= 0 ? "up" : "down";
}

const SIDE_WORD: Record<ProjectDirection, string> = { right: "right", left: "left", up: "top", down: "bottom", upLeft: "iso", upRight: "iso", downLeft: "iso", downRight: "iso" };

class ProjectedSession extends BaseSession {
  parent: string | null;
  made: string[] = [];
  constructor(ctx: () => DrawingToolCtx) {
    super("view.projected", ctx);
    this.parent = this.selectedView((v) => viewKind(v) !== "detail");
  }
  title() {
    return this.made.length ? `Add ${this.made.join(", ")}` : "Projected view";
  }
  prompt() {
    if (!this.parent) return "Click the view to project from";
    return this.made.length ? `Move to another side of ${this.parent} and click for another view, or OK` : `Move to a side of ${this.parent}: the view goes where you click`;
  }
  picksViews() {
    return !this.parent;
  }
  private target(p: Vec2): { dir: ProjectDirection; at: Vec2 } | null {
    const pcv = this.cv(this.parent);
    if (!pcv?.box) return null;
    const dir = projectSide(pcv.box, p);
    const d = DIRECTION_VECTORS[dir];
    // Lined up across, free along: the parent's centre line.
    const at: Vec2 = d[0] !== 0 && d[1] !== 0 ? p : d[0] !== 0 ? [p[0], pcv.centre[1]] : [pcv.centre[0], p[1]];
    return { dir, at };
  }
  click(p: SheetPointer) {
    if (!this.parent) {
      if (p.view) this.parent = p.view;
      return this.ctx().refresh();
    }
    if (p.view === this.parent) return;
    const t = this.target(p.raw);
    if (!t) return;
    const c = this.ctx();
    const word = SIDE_WORD[t.dir];
    const id = freeId(c, this.made.length || c.sheetDoc.views.some((v) => v.id === word) ? `${this.parent}_${word}` : word);
    if (!this.live({ type: "setView", id, view: { kind: "projected", parent: this.parent, direction: t.dir, at: r2(t.at) }, sheet: c.sheetDoc.id })) {
      this.made.push(id);
      c.select([id]);
    }
  }
  overlay(): OverlayShape[] {
    const pcv = this.cv(this.parent);
    if (!this.hover || !pcv?.box || this.hover.view === this.parent) return [];
    const t = this.target(this.hover.raw);
    if (!t) return [];
    const half: Vec2 = [(pcv.box.max[0] - pcv.box.min[0]) / 2, (pcv.box.max[1] - pcv.box.min[1]) / 2];
    return [
      { k: "line", pts: [pcv.centre, t.at], tone: "preview", dash: true },
      { k: "rect", box: { min: [t.at[0] - half[0], t.at[1] - half[1]], max: [t.at[0] + half[0], t.at[1] + half[1]] }, tone: "preview", dash: true },
      { k: "label", at: [t.at[0], t.at[1] - half[1] - this.px(14)], text: `${SIDE_WORD[t.dir] === "iso" ? "Iso" : LOOK_LABEL[SIDE_WORD[t.dir] as ViewLook] ?? t.dir} (projected ${t.dir})`, tone: "preview" },
    ];
  }
}

registerDrawingTool({
  id: "view.projected",
  tab: "layout",
  group: "views",
  label: "Projected View",
  icon: "viewFront",
  title: "A view projected from another, lined up with it: pick the view, then click on the side it goes",
  testId: "tool-view-projected",
  disabled: noViews,
  run: (get) => new ProjectedSession(get),
});

// ------------------------------------------------------------ Section View

type LineMode = "straight" | "offset" | "aligned";

class SectionSession extends BaseSession {
  parent: string | null;
  mode: LineMode = "straight";
  pts: Vec2[] = [];
  id: string | null = null;
  placing = false;
  half = false;
  constructor(ctx: () => DrawingToolCtx) {
    super("view.section", ctx);
    this.parent = this.selectedView((v) => viewKind(v) !== "detail");
  }
  label() {
    return this.view(this.id)?.label;
  }
  title() {
    const l = this.label();
    return l ? `Section ${l}-${l}` : "Section view";
  }
  prompt() {
    if (!this.parent) return "Click the view to cut";
    if (!this.id) {
      if (this.mode === "aligned") return `Click the cutting line's ${["first end", "centre it turns about", "other end"][this.pts.length]} on ${this.parent}`;
      if (this.mode === "offset") return this.pts.length < 2 ? `Click the cutting line's ${this.pts.length ? "next corner" : "first point"} on ${this.parent} (it snaps to centres)` : "Click the next corner, or Enter to finish the line";
      return `Click the cutting line's ${this.pts.length ? "other end" : "first point"} on ${this.parent} (it snaps to circle centres; Shift: any angle)`;
    }
    return this.placing ? "Move along the projection line and click to place the section (across the line turns it round)" : "Set its options, or OK";
  }
  picksViews() {
    return !this.parent;
  }
  snaps() {
    return this.parent && !this.id ? { kinds: ["centre", "vertex", "midpoint", "quadrant"] as const as never, view: this.parent } : null;
  }
  private next(p: SheetPointer): Vec2 {
    const at = p.at;
    if (!this.pts.length || this.mode === "aligned") return at;
    const last = this.pts[this.pts.length - 1];
    if (this.mode === "straight") return p.shift ? at : squareUp(last, at);
    if (this.pts.length === 1) return squareUp(last, at);
    return squareTurn(this.pts[this.pts.length - 2], last, at);
  }
  click(p: SheetPointer) {
    const c = this.ctx();
    if (!this.parent) {
      if (p.view) this.parent = p.view;
      return c.refresh();
    }
    if (!this.id) {
      const q = this.next(p);
      const last = this.pts[this.pts.length - 1];
      if (last && Math.hypot(q[0] - last[0], q[1] - last[1]) < 0.5) return;
      this.pts.push(q);
      if ((this.mode === "straight" && this.pts.length === 2) || (this.mode === "aligned" && this.pts.length === 3)) this.finishLine();
      return c.refresh();
    }
    if (this.placing) this.place(p.raw);
  }
  doubleClick() {
    if (this.mode === "offset" && !this.id && this.pts.length >= 2) this.finishLine();
  }
  key(e: KeyboardEvent): boolean {
    if (e.key === "Enter" && this.mode === "offset" && !this.id && this.pts.length >= 2) {
      this.finishLine();
      return true;
    }
    if (e.key === "Backspace" && !this.id && this.pts.length) {
      this.pts.pop();
      this.ctx().refresh();
      return true;
    }
    if (e.key === "Enter" && this.placing && this.hover) {
      this.place(this.hover.raw);
      return true;
    }
    return false;
  }
  /** A straight cut across the middle of the parent, up and down or across: the quick way. */
  quick(dir: "vertical" | "horizontal") {
    const pcv = this.cv(this.parent);
    if (!pcv?.box) return;
    const c: Vec2 = [(pcv.box.min[0] + pcv.box.max[0]) / 2, (pcv.box.min[1] + pcv.box.max[1]) / 2];
    this.mode = "straight";
    this.pts = dir === "vertical" ? [[c[0], pcv.box.max[1]], [c[0], pcv.box.min[1]]] : [[pcv.box.max[0], c[1]], [pcv.box.min[0], c[1]]];
    this.finishLine();
  }
  private finishLine() {
    const pcv = this.cv(this.parent);
    const c = this.ctx();
    if (!pcv || !this.parent) return;
    let line = this.pts.map((p) => r2(sheetToView(pcv, p)));
    const o = pcv.outline;
    if (o && this.mode !== "aligned" && !this.half) {
      // The line runs past the part at both ends, so the cut goes right through.
      const margin = Math.max(2, 0.06 * Math.max(o.max[0] - o.min[0], o.max[1] - o.min[1]));
      const [a0] = extendThrough(line[0], line[1], o, margin);
      const n = line.length;
      const [, b1] = extendThrough(line[n - 2], line[n - 1], o, margin);
      line = [r2(a0), ...line.slice(1, n - 1), r2(b1)];
    }
    const id = c.nextId("section_");
    const view: Record<string, unknown> = { kind: "section", parent: this.parent, line, ...(this.half ? { half: true } : {}), ...(this.mode === "aligned" ? { aligned: true } : {}) };
    if (this.live({ type: "setView", id, view, sheet: c.sheetDoc.id })) {
      this.pts = [];
      return;
    }
    this.id = id;
    this.placing = true;
    c.select([id]);
  }
  /** Where the section goes for a pointer at p: along its line when it is lined up; and which side. */
  private target(p: Vec2): { at: Vec2; flip: boolean } | null {
    const v = this.view(this.id);
    const pcv = this.cv(this.parent);
    if (!v || !pcv) return null;
    const side = attachSide(v, this.ctx().sheetDoc.projection);
    if (!side) return { at: p, flip: !!v.flip };
    const s = (p[0] - pcv.centre[0]) * side[0] + (p[1] - pcv.centre[1]) * side[1];
    const half = pcv.box ? (side[0] !== 0 ? (pcv.box.max[0] - pcv.box.min[0]) / 2 : (pcv.box.max[1] - pcv.box.min[1]) / 2) : 0;
    // Pulled well across to the other side of the parent: it looks the other way.
    const flip = s < -half ? !v.flip : !!v.flip;
    const cv = this.cv(this.id);
    const across = cv ? alignedCoordinate(cv, pcv, side) : { axis: (side[0] !== 0 ? 1 : 0) as 0 | 1, value: pcv.centre[side[0] !== 0 ? 1 : 0] };
    const at: Vec2 = !across ? p : across.axis === 1 ? [p[0], across.value] : [across.value, p[1]];
    return { at, flip };
  }
  private place(p: Vec2) {
    const t = this.target(p);
    const v = this.view(this.id);
    if (!t || !v || !this.id) return;
    if (t.flip !== !!v.flip) {
      this.live({ type: "setView", id: this.id, view: viewBody(v, { flip: t.flip || undefined, at: r2(t.at) }) });
    } else this.live({ type: "moveView", id: this.id, at: r2(t.at) });
    this.placing = false;
  }
  set(patch: Partial<DrawingView>) {
    const v = this.view(this.id);
    if (!v || !this.id) return;
    this.live({ type: "setView", id: this.id, view: viewBody(v, patch) });
  }
  overlay(): OverlayShape[] {
    const out: OverlayShape[] = [];
    if (!this.id) {
      if (!this.parent || !this.hover) return out;
      const pts = [...this.pts, ...(this.hover ? [this.next(this.hover)] : [])];
      if (pts.length >= 2) out.push({ k: "line", pts, tone: "accent", dash: true, w: 2 });
      for (const p of this.pts) out.push({ k: "dot", at: p, tone: "accent" });
      return out;
    }
    if (this.placing && this.hover) {
      const t = this.target(this.hover.raw);
      const cv = this.cv(this.id);
      const pcv = this.cv(this.parent);
      if (t && cv) out.push({ k: "move", id: this.id, delta: [t.at[0] - cv.centre[0], t.at[1] - cv.centre[1]] });
      if (t && pcv) out.push({ k: "line", pts: [pcv.centre, t.at], tone: "preview", dash: true });
      if (t && !cv) out.push({ k: "dot", at: t.at, tone: "preview" });
    }
    return out;
  }
  panel(): ReactNode {
    const v = this.view(this.id);
    return (
      <div className="session-options">
        {!this.id && (
          <>
            <div className="segmented" role="radiogroup" aria-label="Cutting line">
              {(["straight", "offset", "aligned"] as LineMode[]).map((m) => (
                <button
                  key={m}
                  role="radio"
                  aria-checked={this.mode === m}
                  className={this.mode === m ? "on" : ""}
                  onClick={() => {
                    this.mode = m;
                    this.pts = [];
                    this.ctx().refresh();
                  }}
                  data-testid={`section-mode-${m}`}
                >
                  {m === "straight" ? "Straight" : m === "offset" ? "Offset" : "Aligned"}
                </button>
              ))}
            </div>
            <label className="field">
              <span className="field-label">Half section</span>
              <input
                type="checkbox"
                checked={this.half}
                onChange={(e) => {
                  this.half = e.target.checked;
                  this.ctx().refresh();
                }}
                data-testid="section-half"
              />
            </label>
            {this.parent && (
              <div className="drawing-buttons">
                <button onClick={() => this.quick("vertical")} data-testid="section-quick-vertical" title="A straight cut up and down through the middle of the view">
                  Through the middle, up and down
                </button>
                <button onClick={() => this.quick("horizontal")} data-testid="section-quick-horizontal" title="A straight cut across the middle of the view">
                  Through the middle, across
                </button>
              </div>
            )}
          </>
        )}
        {v && (
          <>
            <label className="field">
              <span className="field-label">Look the other way</span>
              <input type="checkbox" checked={!!v.flip} onChange={(e) => this.set({ flip: e.target.checked || undefined })} data-testid="section-flip" />
            </label>
            <label className="field">
              <span className="field-label">Half section</span>
              <input type="checkbox" checked={!!v.half} disabled={!!v.aligned} onChange={(e) => this.set({ half: e.target.checked || undefined })} data-testid="section-half-made" />
            </label>
            <label className="field">
              <span className="field-label">Show what is behind</span>
              <input type="checkbox" checked={v.showBehind !== false} onChange={(e) => this.set({ showBehind: e.target.checked ? undefined : false })} data-testid="section-behind" />
            </label>
            <div className="drawing-buttons">
              <button
                onClick={() => {
                  this.placing = true;
                  this.ctx().refresh();
                }}
                data-testid="section-place"
              >
                Place it again
              </button>
            </div>
          </>
        )}
      </div>
    );
  }
}

registerDrawingTool({
  id: "view.section",
  tab: "layout",
  group: "derived",
  label: "Section View",
  icon: "section",
  title: "Cut a view along a line you draw on it (straight, offset or aligned, snapping to circle centres); place the section beside it",
  testId: "tool-view-section",
  disabled: noViews,
  run: (get) => new SectionSession(get),
});

// ------------------------------------------------------------ Detail View

class DetailSession extends BaseSession {
  parent: string | null;
  centre: Vec2 | null = null;
  profile: Vec2[] = [];
  shape: "circle" | "profile" = "circle";
  id: string | null = null;
  placing = false;
  constructor(ctx: () => DrawingToolCtx) {
    super("view.detail", ctx);
    this.parent = this.selectedView();
  }
  title() {
    const l = this.view(this.id)?.label;
    return l ? `Detail ${l}` : "Detail view";
  }
  prompt() {
    if (!this.parent) return "Click the view to take the detail from";
    if (!this.id) {
      if (this.shape === "profile") return this.profile.length < 3 ? "Click round the detail's outline" : "Click the next corner, or Enter to close the outline";
      return this.centre ? "Click to set the circle's size" : `Click the circle's centre on ${this.parent} (it snaps to the geometry)`;
    }
    return this.placing ? "Click where the detail goes" : "Set its scale and style, or OK";
  }
  picksViews() {
    return !this.parent;
  }
  snaps() {
    return this.parent && !this.id ? { kinds: ["centre", "vertex", "midpoint", "quadrant", "edge", "circle", "arc"] as never, view: this.parent } : null;
  }
  click(p: SheetPointer) {
    const c = this.ctx();
    if (!this.parent) {
      if (p.view) this.parent = p.view;
      return c.refresh();
    }
    if (!this.id) {
      if (this.shape === "profile") {
        this.profile.push(p.at);
        return c.refresh();
      }
      if (!this.centre) {
        this.centre = p.at;
        return c.refresh();
      }
      const r = Math.hypot(p.raw[0] - this.centre[0], p.raw[1] - this.centre[1]);
      if (r < 1) return;
      return this.make({ circle: this.centre, r });
    }
    if (this.placing) {
      this.live({ type: "moveView", id: this.id, at: r2(p.raw) });
      this.placing = false;
    }
  }
  key(e: KeyboardEvent) {
    if (e.key === "Enter" && this.shape === "profile" && !this.id && this.profile.length >= 3) {
      this.make({ profile: this.profile });
      return true;
    }
    if (e.key === "Enter" && this.placing && this.hover && this.id) {
      this.live({ type: "moveView", id: this.id, at: r2(this.hover.raw) });
      this.placing = false;
      return true;
    }
    return false;
  }
  doubleClick() {
    if (this.shape === "profile" && !this.id && this.profile.length >= 3) this.make({ profile: this.profile });
  }
  private make(shape: { circle: Vec2; r: number } | { profile: Vec2[] }) {
    const pcv = this.cv(this.parent);
    const c = this.ctx();
    if (!pcv || !this.parent) return;
    const id = c.nextId("detail_");
    const body: Record<string, unknown> =
      "circle" in shape
        ? { kind: "detail", parent: this.parent, circle: { at: r2(sheetToView(pcv, shape.circle)), r: Math.round((shape.r / pcv.scale) * 100) / 100 } }
        : { kind: "detail", parent: this.parent, profile: shape.profile.map((p) => r2(sheetToView(pcv, p))) };
    // It starts beside its parent, up and to the right; the pointer then takes it.
    const start: Vec2 = pcv.box ? [pcv.box.max[0] + 40, pcv.centre[1]] : pcv.centre;
    if (this.live({ type: "setView", id, view: { ...body, at: r2(start) }, sheet: c.sheetDoc.id })) return;
    this.id = id;
    this.placing = true;
    c.select([id]);
  }
  set(patch: Partial<DrawingView>) {
    const v = this.view(this.id);
    if (v && this.id) this.live({ type: "setView", id: this.id, view: viewBody(v, patch) });
  }
  overlay(): OverlayShape[] {
    const out: OverlayShape[] = [];
    const h = this.hover;
    if (!this.id) {
      if (this.shape === "profile") {
        const pts = [...this.profile, ...(h ? [h.at] : [])];
        if (pts.length >= 2) out.push({ k: "line", pts, tone: "accent", dash: true, closed: pts.length >= 3, w: 2 });
        for (const p of this.profile) out.push({ k: "dot", at: p, tone: "accent" });
      } else if (this.centre) {
        out.push({ k: "dot", at: this.centre, tone: "accent" });
        if (h) out.push({ k: "circle", c: this.centre, r: Math.hypot(h.raw[0] - this.centre[0], h.raw[1] - this.centre[1]), tone: "accent", dash: true, w: 2 });
      }
      return out;
    }
    const cv = this.cv(this.id);
    if (this.placing && h && cv) out.push({ k: "move", id: this.id, delta: [h.raw[0] - cv.centre[0], h.raw[1] - cv.centre[1]] });
    return out;
  }
  panel(): ReactNode {
    const v = this.view(this.id);
    return (
      <div className="session-options">
        {!this.id && (
          <div className="segmented" role="radiogroup" aria-label="Detail shape">
            {(["circle", "profile"] as const).map((s) => (
              <button
                key={s}
                role="radio"
                aria-checked={this.shape === s}
                className={this.shape === s ? "on" : ""}
                onClick={() => {
                  this.shape = s;
                  this.centre = null;
                  this.profile = [];
                  this.ctx().refresh();
                }}
                data-testid={`detail-shape-${s}`}
              >
                {s === "circle" ? "Circle" : "Outline"}
              </button>
            ))}
          </div>
        )}
        {v && (
          <>
            <label className="field">
              <span className="field-label">Scale</span>
              <select value={v.scale ?? ""} onChange={(e) => this.set({ scale: e.target.value || undefined })} data-testid="detail-scale">
                <option value="">twice its parent's</option>
                {STANDARD_SCALES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Style</span>
              <select value={v.style ?? "circle"} onChange={(e) => this.set({ style: e.target.value === "circle" ? undefined : (e.target.value as DrawingView["style"]) })} data-testid="detail-style">
                {DETAIL_STYLES.map((s) => (
                  <option key={s} value={s}>
                    {s === "circle" ? "circle and label" : s === "connected" ? "connected by a leader" : "no boundary"}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
    );
  }
}

registerDrawingTool({
  id: "view.detail",
  tab: "layout",
  group: "derived",
  label: "Detail View",
  icon: "zoomArea",
  title: "Circle (or outline) a part of a view, then place it larger",
  testId: "tool-view-detail",
  disabled: noViews,
  run: (get) => new DetailSession(get),
});

// ------------------------------------------------------------ Auxiliary View

class AuxiliarySession extends BaseSession {
  edge: string | null = null;
  parent: string | null = null;
  id: string | null = null;
  title() {
    return this.id ? `Add ${this.id}` : "Auxiliary view";
  }
  prompt() {
    if (!this.edge) return "Click a straight edge of a view: the new view looks square at it";
    return this.id ? "Click to move it, or OK" : "Click where the view goes";
  }
  snaps() {
    return !this.edge ? { kinds: ["edge"] as never } : null;
  }
  click(p: SheetPointer) {
    const c = this.ctx();
    if (!this.edge) {
      if (p.snap?.kind === "edge") {
        this.edge = p.snap.ref;
        this.parent = p.snap.view;
      } else c.notice("Click a straight edge: the view looks square at it.", "error");
      return c.refresh();
    }
    if (!this.id) {
      const id = c.nextId("aux_");
      if (!this.live({ type: "setView", id, view: { kind: "auxiliary", parent: this.parent, edge: this.edge, at: r2(p.raw) }, sheet: c.sheetDoc.id })) {
        this.id = id;
        c.select([id]);
      }
    } else this.live({ type: "moveView", id: this.id, at: r2(p.raw) });
  }
  overlay(): OverlayShape[] {
    const out: OverlayShape[] = [];
    const e = this.edge ? this.ctx().snap?.targets.find((t) => t.ref === this.edge) : null;
    if (e?.pts) for (const l of e.pts) out.push({ k: "line", pts: l, tone: "accent", w: 3 });
    if (this.edge && !this.id && this.hover) {
      const s = this.px(50);
      const at = this.hover.raw;
      out.push({ k: "rect", box: { min: [at[0] - s, at[1] - s * 0.7], max: [at[0] + s, at[1] + s * 0.7] }, tone: "preview", dash: true });
    }
    return out;
  }
}

registerDrawingTool({
  id: "view.auxiliary",
  tab: "layout",
  group: "derived",
  label: "Auxiliary View",
  icon: "viewIso",
  title: "A view looking square at a slanted edge: click the edge, then where the view goes",
  testId: "tool-view-auxiliary",
  disabled: noViews,
  run: (get) => new AuxiliarySession("view.auxiliary", get),
});

// ------------------------------------------------------------ outlines on a view: broken-out, crop

class OutlineSession extends BaseSession {
  parent: string | null;
  pts: Vec2[] = [];
  done = false;
  depth: number;
  constructor(
    tool: string,
    ctx: () => DrawingToolCtx,
    readonly what: "brokenOut" | "crop",
  ) {
    super(tool, ctx);
    this.parent = this.selectedView();
    const size = ctx().measurements?.boundingBox?.size;
    this.depth = size ? Math.round(Math.min(...size) / 2) || 5 : 5;
  }
  title() {
    return this.what === "crop" ? `Crop ${this.parent ?? "view"}` : `Broken-out section of ${this.parent ?? "a view"}`;
  }
  prompt() {
    if (!this.parent) return `Click the view to ${this.what === "crop" ? "crop" : "break out"}`;
    if (this.done) return "Set it, or OK";
    return this.pts.length < 3 ? "Click round the outline" : "Click the next corner; Enter or double-click closes it";
  }
  picksViews() {
    return !this.parent;
  }
  snaps() {
    return this.parent && !this.done ? { kinds: ["vertex", "centre", "midpoint", "quadrant"] as never, view: this.parent } : null;
  }
  click(p: SheetPointer) {
    if (!this.parent) {
      if (p.view) this.parent = p.view;
      return this.ctx().refresh();
    }
    if (this.done) return;
    this.pts.push(p.at);
    this.ctx().refresh();
  }
  doubleClick() {
    this.close();
  }
  key(e: KeyboardEvent) {
    if (e.key === "Enter" && !this.done && this.pts.length >= 3) {
      this.close();
      return true;
    }
    if (e.key === "Backspace" && !this.done && this.pts.length) {
      this.pts.pop();
      this.ctx().refresh();
      return true;
    }
    return false;
  }
  private close() {
    const v = this.view(this.parent);
    const cv = this.cv(this.parent);
    if (!v || !cv || this.pts.length < 3 || !this.parent) return;
    const profile = this.pts.map((p) => r2(sheetToView(cv, p)));
    const patch: Partial<DrawingView> = this.what === "crop" ? { crop: profile } : { brokenOut: [...(v.brokenOut ?? []), { profile, depth: this.depth }] };
    if (!this.live({ type: "setView", id: this.parent, view: viewBody(v, patch) })) this.done = true;
  }
  overlay(): OverlayShape[] {
    if (this.done || !this.parent) return [];
    const pts = [...this.pts, ...(this.hover ? [this.hover.at] : [])];
    const out: OverlayShape[] = this.pts.map((p) => ({ k: "dot", at: p, tone: "accent" }));
    if (pts.length >= 2) out.push({ k: "line", pts, tone: "accent", dash: true, w: 2, closed: pts.length >= 3 });
    return out;
  }
  panel(): ReactNode {
    if (this.what !== "brokenOut") return null;
    return (
      <div className="session-options">
        <label className="field">
          <span className="field-label">Depth</span>
          <input
            type="number"
            min={0.1}
            step={0.5}
            defaultValue={this.depth}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (!(n > 0)) return;
              this.depth = n;
              const v = this.view(this.parent);
              if (this.done && v?.brokenOut?.length && this.parent) {
                const list = [...v.brokenOut];
                list[list.length - 1] = { ...list[list.length - 1], depth: n };
                this.live({ type: "setView", id: this.parent, view: viewBody(v, { brokenOut: list }) });
              }
            }}
            data-testid="broken-out-depth"
          />
          <span className="unit">mm into the part</span>
        </label>
      </div>
    );
  }
}

registerDrawingTool({
  id: "view.brokenOut",
  tab: "layout",
  group: "modify",
  label: "Broken-out Section",
  icon: "cut",
  title: "Draw a closed outline on a view: what is inside is cut away to a depth, and hatched",
  testId: "tool-view-broken-out",
  disabled: noViews,
  run: (get) => new OutlineSession("view.brokenOut", get, "brokenOut"),
});

registerDrawingTool({
  id: "view.crop",
  tab: "layout",
  group: "modify",
  label: "Crop View",
  icon: "rect",
  title: "Draw a closed outline on a view: only what is inside shows",
  testId: "tool-view-crop",
  disabled: noViews,
  run: (get) => new OutlineSession("view.crop", get, "crop"),
});

// ------------------------------------------------------------ Break

class BreakSession extends BaseSession {
  parent: string | null;
  axis: 0 | 1 = 0;
  from: number | null = null;
  gap = 6;
  style: "zigzag" | "straight" | "curved" = "zigzag";
  done = false;
  constructor(ctx: () => DrawingToolCtx) {
    super("view.break", ctx);
    this.parent = this.selectedView();
    this.pickAxis();
  }
  private pickAxis() {
    const b = this.cv(this.parent)?.box;
    if (b) this.axis = b.max[0] - b.min[0] >= b.max[1] - b.min[1] ? 0 : 1;
  }
  title() {
    return `Break ${this.parent ?? "a view"}`;
  }
  prompt() {
    if (!this.parent) return "Click the view to shorten";
    if (this.done) return "Set the gap and style, or OK";
    return this.from === null ? "Click where the left out part starts" : "Click where it ends";
  }
  picksViews() {
    return !this.parent;
  }
  click(p: SheetPointer) {
    if (!this.parent) {
      if (p.view) {
        this.parent = p.view;
        this.pickAxis();
      }
      return this.ctx().refresh();
    }
    if (this.done) return;
    const cv = this.cv(this.parent);
    const v = this.view(this.parent);
    if (!cv || !v) return;
    const at = sheetToView(cv, p.raw)[this.axis];
    if (this.from === null) {
      this.from = at;
      return this.ctx().refresh();
    }
    const [from, to] = [Math.min(this.from, at), Math.max(this.from, at)].map((x) => Math.round(x * 100) / 100);
    if (to - from < 1) return;
    const br = { axis: this.axis === 0 ? "x" : "y", from, to, ...(this.gap !== 6 ? { gap: this.gap } : {}), ...(this.style !== "zigzag" ? { style: this.style } : {}) };
    if (!this.live({ type: "setView", id: this.parent, view: viewBody(v, { breaks: [...(v.breaks ?? []), br as never] }) })) this.done = true;
  }
  private update() {
    const v = this.view(this.parent);
    if (!this.done || !v?.breaks?.length || !this.parent) return this.ctx().refresh();
    const list = [...v.breaks];
    const last = { ...list[list.length - 1] };
    if (this.gap !== 6) last.gap = this.gap;
    else delete last.gap;
    if (this.style !== "zigzag") last.style = this.style;
    else delete last.style;
    list[list.length - 1] = last;
    this.live({ type: "setView", id: this.parent, view: viewBody(v, { breaks: list }) });
  }
  overlay(): OverlayShape[] {
    const cv = this.cv(this.parent);
    if (!cv?.box || this.done) return [];
    const out: OverlayShape[] = [];
    const amp = this.px(5);
    const at = (x: number) => {
      const p = viewToSheetAxis(cv, this.axis, x);
      return breakLine(cv.box!, this.axis, p, amp);
    };
    if (this.from !== null) out.push({ k: "line", pts: at(this.from), tone: "accent", w: 2 });
    if (this.hover) out.push({ k: "line", pts: breakLine(cv.box, this.axis, this.hover.raw[this.axis], amp), tone: "preview", w: 2, dash: true });
    return out;
  }
  panel(): ReactNode {
    return (
      <div className="session-options">
        <div className="segmented" role="radiogroup" aria-label="Break lines">
          {([0, 1] as const).map((a) => (
            <button
              key={a}
              role="radio"
              aria-checked={this.axis === a}
              className={this.axis === a ? "on" : ""}
              disabled={this.done}
              onClick={() => {
                this.axis = a;
                this.from = null;
                this.ctx().refresh();
              }}
              data-testid={`break-axis-${a === 0 ? "x" : "y"}`}
            >
              {a === 0 ? "Shorten across" : "Shorten up and down"}
            </button>
          ))}
        </div>
        <label className="field">
          <span className="field-label">Gap</span>
          <input
            type="number"
            min={1}
            step={1}
            defaultValue={this.gap}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (n > 0) {
                this.gap = n;
                this.update();
              }
            }}
            data-testid="break-gap"
          />
          <span className="unit">mm</span>
        </label>
        <label className="field">
          <span className="field-label">Style</span>
          <select
            value={this.style}
            onChange={(e) => {
              this.style = e.target.value as typeof this.style;
              this.update();
            }}
            data-testid="break-style"
          >
            <option value="zigzag">zigzag</option>
            <option value="straight">straight</option>
            <option value="curved">curved (round bars, tubes)</option>
          </select>
        </label>
      </div>
    );
  }
}

/** Where a view coordinate along one axis lands on the sheet. */
function viewToSheetAxis(cv: { centre: Vec2; origin: Vec2; scale: number }, axis: 0 | 1, x: number): number {
  return cv.centre[axis] + (x - cv.origin[axis]) * cv.scale;
}

registerDrawingTool({
  id: "view.break",
  tab: "layout",
  group: "modify",
  label: "Break",
  icon: "splitEntity",
  title: "Shorten a long view: click it, then where the part left out starts and ends (dimensions still read true)",
  testId: "tool-view-break",
  disabled: noViews,
  run: (get) => new BreakSession(get),
});
