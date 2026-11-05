// Sketching on the sheet (Phase Q wave Q3A): lines (one after another, Shift
// keeps them square), rectangles, circles, arcs and text, drawn in a line
// type of ISO 128 (thick, thin, centre, hidden, phantom). They snap to the
// views' points; each shape is its own sketch annotation (one undo step),
// dragged and nudged like any annotation.

import type { ReactNode } from "react";
import { SKETCH_LINES, type SketchItem, type SketchLine, type Vec2 } from "../../../doc/types";
import { tenth } from "../align";
import type { SnapKind } from "../snap";
import { annotationKind, registerAnnotationKind } from "./kinds";
import { registerDrawingTool } from "./registry";
import { ToolSession } from "./toolSession";
import type { DrawingToolCtx, OverlayShape, SheetPointer } from "./types";
import { Commit, numberOf, Row } from "./ui";

type Shape = "line" | "rectangle" | "circle" | "arc";
const SNAPS: SnapKind[] = ["vertex", "centre", "midpoint", "quadrant"];
const r1 = (p: Vec2): Vec2 => [tenth(p[0]), tenth(p[1])];

/** The items a shape makes from its clicked points (arc: centre, start, end; counter-clockwise). */
export function sketchItems(shape: Shape, pts: Vec2[], line?: SketchLine): SketchItem[] | null {
  const st = line && line !== "thick" ? { line } : {};
  const [a, b, c] = pts;
  if (shape === "line" && a && b) return Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6 ? [{ kind: "line", a, b, ...st }] : null;
  if (shape === "rectangle" && a && b) return Math.abs(b[0] - a[0]) > 1e-6 && Math.abs(b[1] - a[1]) > 1e-6 ? [{ kind: "rect", a, b, ...st }] : null;
  if (shape === "circle" && a && b) {
    const r = tenth(Math.hypot(b[0] - a[0], b[1] - a[1]));
    return r > 0 ? [{ kind: "circle", c: a, r, ...st }] : null;
  }
  if (shape === "arc" && a && b && c) {
    const r = tenth(Math.hypot(b[0] - a[0], b[1] - a[1]));
    const ang = (p: Vec2) => tenth((((Math.atan2(p[1] - a[1], p[0] - a[0]) * 180) / Math.PI) % 360 + 360) % 360);
    return r > 0 ? [{ kind: "arc", c: a, r, start: ang(b), end: ang(c), ...st }] : null;
  }
  return null;
}

const NEED: Record<Shape, number> = { line: 2, rectangle: 2, circle: 2, arc: 3 };
const ASK: Record<Shape, string[]> = {
  line: ["Click the line's start", "Click its end (Shift: square); it goes on from there"],
  rectangle: ["Click a corner", "Click the opposite corner"],
  circle: ["Click the centre", "Click a point on the circle"],
  arc: ["Click the centre", "Click where the arc starts", "Click where it ends (counter-clockwise)"],
};

class SketchSession extends ToolSession {
  pts: Vec2[] = [];
  line: SketchLine;
  constructor(
    get: () => DrawingToolCtx,
    readonly shape: Shape,
  ) {
    super(`sketch.${shape}`, get);
    this.line = shape === "line" || shape === "rectangle" || shape === "circle" || shape === "arc" ? "thick" : "thin";
  }
  name() {
    return { line: "Line", rectangle: "Rectangle", circle: "Circle", arc: "Arc" }[this.shape];
  }
  busy() {
    return this.pts.length > 0;
  }
  reset() {
    this.pts = [];
  }
  prompt() {
    return ASK[this.shape][Math.min(this.pts.length, ASK[this.shape].length - 1)];
  }
  snaps() {
    return { kinds: SNAPS };
  }
  point(p: SheetPointer): Vec2 {
    let q = p.snap ? p.at : p.raw;
    const last = this.pts[this.pts.length - 1];
    if (p.shift && last && this.shape === "line") q = Math.abs(q[0] - last[0]) >= Math.abs(q[1] - last[1]) ? [q[0], last[1]] : [last[0], q[1]];
    return r1(q);
  }
  click(p: SheetPointer) {
    const c = this.ctx();
    this.pts.push(this.point(p));
    if (this.pts.length < NEED[this.shape]) return c.refresh();
    const items = sketchItems(this.shape, this.pts, this.line);
    if (!items) {
      this.pts.pop();
      return c.notice("That shape has no size: click further away", "error");
    }
    if (this.add({ type: "sketch", items })) this.pts = this.shape === "line" ? [this.pts[this.pts.length - 1]] : [];
    c.refresh();
  }
  doubleClick() {
    this.pts = [];
    this.ctx().refresh();
  }
  overlay(): OverlayShape[] {
    const h = this.hover;
    if (!h || !this.pts.length) return [];
    const items = sketchItems(this.shape, [...this.pts, this.point(h)].slice(0, NEED[this.shape]), this.line);
    if (this.shape === "arc" && this.pts.length === 1) return [{ k: "circle", c: this.pts[0], r: Math.hypot(h.raw[0] - this.pts[0][0], h.raw[1] - this.pts[0][1]), tone: "preview", dash: true }];
    return items ? this.preview({ type: "sketch", items }) : [];
  }
  panel(): ReactNode {
    return <LineType value={this.line} onChange={(l) => {
      this.line = l;
      this.ctx().refresh();
    }} />;
  }
}

function LineType({ value, onChange }: { value: SketchLine; onChange(l: SketchLine): void }) {
  return (
    <div className="session-options">
      <Row label="Line">
        <select value={value} onChange={(e) => onChange(e.target.value as SketchLine)} data-testid="sketch-line-type">
          {SKETCH_LINES.map((l) => (
            <option key={l} value={l}>
              {{ thick: "thick (visible outline)", thin: "thin", center: "centre (chain)", hidden: "hidden (dashed)", phantom: "phantom" }[l]}
            </option>
          ))}
        </select>
      </Row>
    </div>
  );
}

for (const [shape, label, icon] of [
  ["line", "Line", "line"],
  ["rectangle", "Rectangle", "rect"],
  ["circle", "Circle", "circle"],
  ["arc", "Arc", "arc"],
] as const) {
  registerDrawingTool({ id: `sketch.${shape}`, tab: "sketch", group: "draw", label, icon, title: `A ${label.toLowerCase()} drawn on the sheet, in a line type of your choice; it snaps to the views' points`, testId: `tool-sketch-${shape}`, run: (get) => new SketchSession(get, shape) });
}

// ------------------------------------------------------------ text

class TextSession extends ToolSession {
  text = "";
  height = "";
  at: Vec2 | null = null;
  constructor(get: () => DrawingToolCtx) {
    super("sketch.text", get);
  }
  name() {
    return "Text";
  }
  busy() {
    return !!this.at;
  }
  reset() {
    this.at = null;
  }
  prompt() {
    return this.at ? "Type it in the panel; Enter keeps it" : "Click where the text goes";
  }
  click(p: SheetPointer) {
    this.at = r1(p.raw);
    this.ctx().refresh();
    requestAnimationFrame(() => (document.querySelector('[data-testid="note-text"]') as HTMLInputElement | null)?.focus());
  }
  item(): Record<string, unknown> & { type: string } {
    const h = numberOf(this.height);
    return { type: "text", text: this.text, at: this.at!, ...(h && h > 0 ? { height: h } : {}) };
  }
  ok(): string | null {
    if (!this.at) {
      this.ctx().end();
      return null;
    }
    if (!this.text.trim()) return "Type the text";
    if (!this.add({ ...this.item(), text: this.text.trim() })) return "refused";
    this.ctx().end();
    return null;
  }
  overlay(): OverlayShape[] {
    const at = this.at ?? this.hover?.raw;
    if (!at) return [];
    return this.at && this.text.trim() ? this.preview(this.item(), at) : [{ k: "dot", at, tone: "accent" }];
  }
  panel(): ReactNode {
    const c = this.ctx();
    return (
      <div className="session-options">
        <input
          type="text"
          value={this.text}
          placeholder="Text"
          onChange={(e) => {
            this.text = e.target.value;
            c.refresh();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const why = this.ok();
              if (why) c.notice(why, "error");
            }
          }}
          data-testid="note-text"
        />
        <Row label="Height">
          <Commit value={this.height} numeric width={60} placeholder="3.5" onCommit={(s) => {
            this.height = s;
            c.refresh();
          }} testId="text-height" />
        </Row>
      </div>
    );
  }
}

registerDrawingTool({ id: "sketch.text", tab: "sketch", group: "text", label: "Text", icon: "sketchText", title: "Text on the sheet: click where it goes, then type it", testId: "tool-sketch-text", run: (get) => new TextSession(get) });

// A sketch drags and nudges as a whole: every point of every item moves.
const sketch = annotationKind("sketch");
if (sketch) {
  registerAnnotationKind({
    ...sketch,
    move: (a, d) => {
      const mv = (p: Vec2): Vec2 => [tenth(p[0] + d[0]), tenth(p[1] + d[1])];
      const items = ((a.items as SketchItem[]) ?? []).map((it) => {
        if (it.kind === "line" || it.kind === "rect") return { ...it, a: mv(it.a), b: mv(it.b) };
        if (it.kind === "circle" || it.kind === "arc") return { ...it, c: mv(it.c) };
        if (it.kind === "polyline") return { ...it, pts: it.pts.map(mv) };
        return { ...it, at: mv(it.at) };
      });
      return { items };
    },
  });
}
