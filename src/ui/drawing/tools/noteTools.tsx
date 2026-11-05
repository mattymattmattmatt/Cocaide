// The note tools (Phase Q wave Q3A): the Note (rich text — bold, italic,
// underline, height —, the symbols palette, linked properties read live,
// leaders added by clicking what they point at, their arrowheads), the
// general notes block (a numbered list with the usual notes to pick from),
// Balloon (click a member or body, then where the balloon goes), Auto
// Balloon (every item a view shows, laid out round it or in a row), and the
// revision cloud.

import { useRef, type ReactNode } from "react";
import type { Command } from "../../../doc/commands";
import { ARROW_STYLES, BALLOON_SHAPES, type ArrowStyle, type BalloonShape, type NoteAnnotation, type Vec2 } from "../../../doc/types";
import { balloonFromPick } from "../../../drafting/annotate";
import type { SnapKind, SnapTarget } from "../snap";
import { autoBalloons, BALLOON_LAYOUTS, type BalloonLayout } from "./balloons";
import { keep } from "./editing";
import { annotationKind, registerAnnotationKind } from "./kinds";
import { registerDrawingTool } from "./registry";
import { ToolSession, noViews } from "./toolSession";
import type { DrawingToolCtx, OverlayShape, SheetPointer } from "./types";
import { Commit, numberOf, Row, Segmented, SymbolPalette } from "./ui";

// ------------------------------------------------------------ the rich text editor

export interface NoteSpec {
  text: string;
  height?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  frame?: boolean;
}

/** The property links a note may hold, by group. */
function linkChoices(c: DrawingToolCtx): { value: string; label: string }[] {
  const props = Object.keys(c.drawing.properties ?? {});
  const part = Object.keys(((c.doc as Record<string, unknown>).properties as Record<string, unknown> | undefined) ?? {});
  return [
    ...[...new Set([...props, ...part])].map((n) => ({ value: `$PRP:"${n}"`, label: `Property: ${n}` })),
    ...["mass", "material", "volume", "name"].map((n) => ({ value: `$PRPMODEL:"${n}"`, label: `Model: ${n}` })),
    ...["scale", "sheet", "sheets", "size", "name"].map((n) => ({ value: `$PRPSHEET:"${n}"`, label: `Sheet: ${n}` })),
  ];
}

export function NoteEditor({ value, onChange, links, onEnter, autoFocus }: { value: NoteSpec; onChange(v: NoteSpec): void; links: { value: string; label: string }[]; onEnter?: () => void; autoFocus?: boolean }) {
  const area = useRef<HTMLTextAreaElement>(null);
  /** Text put in at the cursor, or the selection wrapped. */
  const insert = (before: string, after = "") => {
    const el = area.current;
    const t = value.text;
    const a = el?.selectionStart ?? t.length;
    const b = el?.selectionEnd ?? t.length;
    const next = t.slice(0, a) + before + t.slice(a, b) + after + t.slice(b);
    onChange({ ...value, text: next });
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = b + before.length + after.length;
    });
  };
  const flag = (k: "bold" | "italic" | "underline" | "frame") => onChange({ ...value, [k]: value[k] ? undefined : true });
  return (
    <div className="note-editor" data-testid="note-editor">
      <div className="note-toolbar" role="toolbar" aria-label="Text">
        <button type="button" className={value.bold ? "on" : ""} aria-pressed={!!value.bold} title="Bold, the whole note (or **wrap** a part)" onClick={() => flag("bold")} data-testid="note-bold">
          <b>B</b>
        </button>
        <button type="button" className={value.italic ? "on" : ""} aria-pressed={!!value.italic} title="Italic" onClick={() => flag("italic")} data-testid="note-italic">
          <i>I</i>
        </button>
        <button type="button" className={value.underline ? "on" : ""} aria-pressed={!!value.underline} title="Underlined" onClick={() => flag("underline")} data-testid="note-underline">
          <u>U</u>
        </button>
        <button type="button" title="Bold the selection" onClick={() => insert("**", "**")} data-testid="note-wrap-bold">
          **
        </button>
        <select value={value.height ?? ""} onChange={(e) => onChange({ ...value, height: numberOf(e.target.value) })} title="Text height (ISO 3098)" data-testid="note-height">
          <option value="">3.5 mm</option>
          {[2.5, 5, 7, 10].map((h) => (
            <option key={h} value={h}>
              {h} mm
            </option>
          ))}
        </select>
        <button type="button" className={value.frame ? "on" : ""} aria-pressed={!!value.frame} title="A box round it" onClick={() => flag("frame")} data-testid="note-frame">
          ▭
        </button>
      </div>
      <textarea
        ref={area}
        rows={4}
        value={value.text}
        autoFocus={autoFocus}
        placeholder={'DEBURR ALL EDGES\nMATERIAL: $PRPMODEL:"material"'}
        onChange={(e) => onChange({ ...value, text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && onEnter) {
            e.preventDefault();
            onEnter();
          }
        }}
        data-testid="note-text"
      />
      <SymbolPalette testId="note-symbols" onPick={(ch) => insert(ch)} />
      <Row label="Link a property">
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) insert(e.target.value);
          }}
          data-testid="note-link"
        >
          <option value="">insert…</option>
          {links.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </Row>
    </div>
  );
}

// ------------------------------------------------------------ Note

class NoteSession extends ToolSession {
  spec: NoteSpec = { text: "" };
  at: Vec2 | null = null;
  leaders: string[] = [];
  arrow: ArrowStyle = "closed";
  constructor(get: () => DrawingToolCtx) {
    super("annotation.note", get);
  }
  name() {
    return "Note";
  }
  busy() {
    return !!this.at;
  }
  reset() {
    this.at = null;
    this.leaders = [];
  }
  prompt() {
    if (!this.at) return "Click where the note goes";
    return "Type it in the panel; click edges or points to add leaders to them; Enter keeps it (Shift+Enter: a new line)";
  }
  snaps() {
    return this.at ? { kinds: ["edge", "circle", "arc", "vertex", "midpoint", "centre"] as SnapKind[] } : { kinds: [] as SnapKind[] };
  }
  note(): Record<string, unknown> & { type: string } {
    const s = this.spec;
    return {
      type: "note",
      text: s.text,
      at: this.at!,
      ...(s.height ? { height: s.height } : {}),
      ...(s.bold ? { bold: true } : {}),
      ...(s.italic ? { italic: true } : {}),
      ...(s.underline ? { underline: true } : {}),
      ...(s.frame ? { frame: true } : {}),
      ...(this.leaders.length ? { leaders: this.leaders.map((to) => ({ to, ...(this.arrow !== "closed" ? { arrow: this.arrow } : {}) })) } : {}),
    };
  }
  click(p: SheetPointer) {
    const c = this.ctx();
    if (!this.at) {
      this.at = [Math.round(p.raw[0] * 10) / 10, Math.round(p.raw[1] * 10) / 10];
      c.refresh();
      requestAnimationFrame(() => (document.querySelector('[data-testid="note-text"]') as HTMLTextAreaElement | null)?.focus());
      return;
    }
    if (p.snap && !this.leaders.includes(p.snap.ref)) {
      this.leaders.push(p.snap.ref);
      c.refresh();
    }
  }
  ok(): string | null {
    if (!this.at) {
      this.ctx().end();
      return null;
    }
    if (!this.spec.text.trim()) return "Type the note's text";
    if (this.add({ ...this.note(), text: this.spec.text.trim() })) {
      this.ctx().end();
      return null;
    }
    return "refused";
  }
  overlay(): OverlayShape[] {
    const at = this.at ?? this.hover?.raw;
    if (!at) return [];
    if (!this.at || !this.spec.text.trim()) return [{ k: "dot", at, tone: "accent" }];
    return this.preview(this.note(), at);
  }
  panel(): ReactNode {
    const c = this.ctx();
    return (
      <div className="session-options">
        <NoteEditor value={this.spec} links={linkChoices(c)} autoFocus={!!this.at} onEnter={() => {
          const why = this.ok();
          if (why) c.notice(why, "error");
        }} onChange={(v) => {
          this.spec = v;
          c.refresh();
        }} />
        <Row label="Leader ends">
          <select value={this.arrow} onChange={(e) => {
            this.arrow = e.target.value as ArrowStyle;
            c.refresh();
          }} data-testid="note-arrow">
            {ARROW_STYLES.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </Row>
        <p className="muted small" data-testid="note-leaders">
          {this.leaders.length ? `${this.leaders.length} leader${this.leaders.length === 1 ? "" : "s"}` : "No leaders: click what it points at"}
        </p>
      </div>
    );
  }
}

registerDrawingTool({
  id: "annotation.note",
  tab: "annotation",
  group: "notes",
  label: "Note",
  icon: "note",
  title: "A note: click where it goes, type it (bold, symbols, linked properties), click what its leaders point at",
  testId: "tool-annotation-note",
  run: (get) => new NoteSession(get),
});

registerAnnotationKind({
  ...annotationKind("note")!,
  panel: ({ a, write, ctx }) => {
    const n = a as unknown as NoteAnnotation;
    if (n.numbered) return <GeneralNotesEditor lines={n.text.split("\n")} onChange={(lines) => write({ text: lines.join("\n") })} />;
    return (
      <NoteEditor
        value={{ text: n.text, height: n.height, bold: n.bold, italic: n.italic, underline: n.underline, frame: n.frame }}
        links={linkChoices(ctx())}
        onChange={(v) => {
          if (!v.text.trim()) return;
          write({ text: v.text, height: v.height ?? null, bold: v.bold ?? null, italic: v.italic ?? null, underline: v.underline ?? null, frame: v.frame ?? null });
        }}
      />
    );
  },
});

// ------------------------------------------------------------ general notes

export const NOTE_PRESETS = [
  "REMOVE ALL BURRS AND BREAK SHARP EDGES 0.5 MAX",
  'MATERIAL: $PRPMODEL:"material"',
  'UNLESS OTHERWISE SPECIFIED: GENERAL TOLERANCES TO ISO 2768-mK',
  "DIMENSIONS IN MILLIMETRES",
  "DO NOT SCALE DRAWING",
  "FINISH: HOT DIP GALVANISE TO ISO 1461",
  "ALL WELDS 135 (MAG) TO ISO 5817 QUALITY LEVEL C UNLESS NOTED",
  "SURFACE FINISH Ra 3.2 UNLESS NOTED",
  "INTERPRET DRAWING PER ISO 8015",
];

function GeneralNotesEditor({ lines, onChange }: { lines: string[]; onChange(lines: string[]): void }) {
  const list = lines.filter((l) => l.trim());
  const move = (i: number, d: number) => {
    const next = [...list];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    onChange(next);
  };
  return (
    <div className="general-notes" data-testid="general-notes">
      <ol>
        {list.map((l, i) => (
          <li key={`${i}:${l}`}>
            <Commit value={l} onCommit={(s) => onChange(s.trim() ? list.map((x, k) => (k === i ? s.trim() : x)) : list.filter((_, k) => k !== i))} testId={`gn-line-${i}`} />
            <button type="button" title="Up" disabled={i === 0} onClick={() => move(i, -1)}>
              ↑
            </button>
            <button type="button" title="Down" disabled={i === list.length - 1} onClick={() => move(i, 1)}>
              ↓
            </button>
            <button type="button" title="Remove" onClick={() => onChange(list.filter((_, k) => k !== i))} data-testid={`gn-remove-${i}`}>
              ×
            </button>
          </li>
        ))}
      </ol>
      <Row label="Add a note">
        <Commit value="" placeholder="type, Enter adds it" onCommit={(s) => s.trim() && onChange([...list, s.trim()])} testId="gn-add" />
      </Row>
      <div className="fit-chips" role="group" aria-label="Usual notes">
        {NOTE_PRESETS.filter((p) => !list.includes(p)).map((p) => (
          <button key={p} type="button" className="chip" onClick={() => onChange([...list, p])} title={p} data-testid={`gn-preset-${NOTE_PRESETS.indexOf(p)}`}>
            {p.length > 34 ? `${p.slice(0, 32)}…` : p}
          </button>
        ))}
      </div>
    </div>
  );
}

class GeneralNotesSession extends ToolSession {
  lines: string[];
  existing: NoteAnnotation | undefined;
  at: Vec2 | null = null;
  constructor(get: () => DrawingToolCtx) {
    super("annotation.generalNotes", get);
    const c = get();
    this.existing = c.sheetDoc.annotations.find((a): a is NoteAnnotation & { hidden?: boolean } => a.type === "note" && !!a.numbered);
    this.lines = this.existing ? this.existing.text.split("\n").filter(Boolean) : [NOTE_PRESETS[0], NOTE_PRESETS[1], NOTE_PRESETS[3]];
  }
  name() {
    return "General notes";
  }
  busy() {
    return false;
  }
  reset() {}
  prompt() {
    return this.existing ? "Edit the notes in the panel; OK keeps them" : "Pick the notes in the panel, click where the block goes (default: the lower left), OK keeps it";
  }
  click(p: SheetPointer) {
    if (this.existing) return;
    this.at = [Math.round(p.raw[0] * 10) / 10, Math.round(p.raw[1] * 10) / 10];
    this.ctx().refresh();
  }
  place(): Vec2 {
    const f = this.ctx().sheet?.frame;
    return this.at ?? (f ? [f.min[0] + 6, f.min[1] + 10 + 6 * this.lines.length] : [30, 60]);
  }
  ok(): string | null {
    const c = this.ctx();
    if (!this.lines.length) return "Add a note";
    const text = this.lines.join("\n");
    if (this.existing) {
      if (keep(c, [{ type: "editAnnotation", id: this.existing.id, patch: { text } }])) return "refused";
    } else if (!this.add({ type: "note", text, at: this.place(), numbered: true, title: "NOTES:" })) return "refused";
    c.end();
    return null;
  }
  overlay(): OverlayShape[] {
    if (this.existing) return [];
    const at = this.at ?? this.hover?.raw ?? this.place();
    return this.preview({ type: "note", text: this.lines.join("\n") || " ", at, numbered: true, title: "NOTES:" }, at);
  }
  panel(): ReactNode {
    return <GeneralNotesEditor lines={this.lines} onChange={(l) => {
      this.lines = l;
      this.ctx().refresh();
    }} />;
  }
}

registerDrawingTool({
  id: "annotation.generalNotes",
  tab: "annotation",
  group: "notes",
  label: "General Notes",
  icon: "properties",
  title: "The sheet's numbered general notes: deburr, material, tolerances, finish … pick, type, order them",
  testId: "tool-annotation-general-notes",
  run: (get) => new GeneralNotesSession(get),
});

// ------------------------------------------------------------ balloons

class BalloonSession extends ToolSession {
  target: SnapTarget | null = null;
  shape: BalloonShape = "circle";
  quantity = false;
  constructor(get: () => DrawingToolCtx) {
    super("annotation.balloon", get);
  }
  name() {
    return "Balloon";
  }
  busy() {
    return !!this.target;
  }
  reset() {
    this.target = null;
  }
  prompt() {
    return this.target ? "Click where the balloon goes" : "Click an edge of a member or a body";
  }
  snaps() {
    return this.target ? { kinds: [] as SnapKind[] } : { kinds: ["edge", "arc", "circle"] as SnapKind[] };
  }
  make(t: SnapTarget, at?: Vec2) {
    const sheet = this.ctx().sheet;
    if (!sheet) return "The sheet is still being drawn";
    const b = balloonFromPick(sheet, t.ref, at);
    if (typeof b === "string") return b.charAt(0).toUpperCase() + b.slice(1);
    return { ...b, ...(this.shape !== "circle" ? { shape: this.shape } : {}), ...(this.quantity ? { quantity: true } : {}) };
  }
  click(p: SheetPointer) {
    const c = this.ctx();
    if (!this.target) {
      if (!p.snap) return c.notice(this.prompt(), "error");
      const r = this.make(p.snap);
      if (typeof r === "string") return c.notice(r, "error");
      this.target = p.snap;
      return c.refresh();
    }
    const r = this.make(this.target, p.raw);
    if (typeof r === "string") return c.notice(r, "error");
    if (this.add(r)) this.target = null;
    c.refresh();
  }
  overlay(): OverlayShape[] {
    const h = this.hover;
    if (!h || !this.target) return h?.snap ? this.highlight(h.snap, "preview") : [];
    return [...this.highlight(this.target), ...this.preview(this.make(this.target, h.raw), h.raw)];
  }
  panel(): ReactNode {
    const c = this.ctx();
    return (
      <div className="session-options">
        <Row label="Shape">
          <select value={this.shape} onChange={(e) => {
            this.shape = e.target.value as BalloonShape;
            c.refresh();
          }} data-testid="balloon-shape">
            {BALLOON_SHAPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Row>
        <label className="check">
          <input type="checkbox" checked={this.quantity} onChange={(e) => {
            this.quantity = e.target.checked;
            c.refresh();
          }} data-testid="balloon-quantity" /> Quantity (2×)
        </label>
      </div>
    );
  }
}

registerDrawingTool({
  id: "annotation.balloon",
  tab: "annotation",
  group: "notes",
  label: "Balloon",
  icon: "balloon",
  title: "A balloon with the item number from the cut list or BOM: click a member or body, then where it goes",
  testId: "tool-annotation-balloon",
  disabled: noViews,
  run: (get) => new BalloonSession(get),
});

class AutoBalloonSession extends ToolSession {
  views: string[];
  layout: BalloonLayout = "square";
  constructor(get: () => DrawingToolCtx) {
    super("annotation.autoBalloon", get);
    const c = get();
    const chosen = c.selection.filter((id) => c.sheetDoc.views.some((v) => v.id === id));
    this.views = chosen.length ? chosen : c.sheetDoc.views.map((v) => v.id);
  }
  name() {
    return "Auto balloon";
  }
  busy() {
    return false;
  }
  reset() {}
  prompt() {
    return "Choose the views (click one to add or take it away) and the layout; OK balloons every item they show that has none";
  }
  picksViews() {
    return true;
  }
  click(p: SheetPointer) {
    if (!p.view) return;
    this.views = this.views.includes(p.view) ? this.views.filter((v) => v !== p.view) : [...this.views, p.view];
    this.ctx().refresh();
  }
  plan() {
    const c = this.ctx();
    return c.sheet ? autoBalloons(c.sheet, c.sheetDoc.annotations, { views: this.views, layout: this.layout }) : { balloons: [], unseen: [] };
  }
  ok(): string | null {
    const c = this.ctx();
    const { balloons, unseen } = this.plan();
    if (!balloons.length) {
      c.end();
      c.notice(unseen.length ? `No chosen view shows item${unseen.length === 1 ? "" : "s"} ${unseen.join(", ")}` : "Every item has a balloon already");
      return null;
    }
    const taken = new Set<string>();
    const cmds: Command[] = balloons.map((b) => {
      let id = c.nextId("b");
      while (taken.has(id)) id = `b${Number(id.slice(1)) + 1}`;
      taken.add(id);
      return { type: "setAnnotation", id, annotation: b, sheet: c.sheetDoc.id };
    });
    if (keep(c, cmds)) return "refused";
    c.end();
    c.notice(`Auto balloon: ${cmds.length} balloon${cmds.length === 1 ? "" : "s"}${unseen.length ? `; item${unseen.length === 1 ? "" : "s"} ${unseen.join(", ")} not in the chosen views` : ""}. Ctrl+Z takes them away.`);
    return null;
  }
  overlay(): OverlayShape[] {
    const s = this.ctx().sheet;
    const out: OverlayShape[] = this.views.flatMap((id) => {
      const b = s?.views.find((v) => v.id === id)?.box;
      return b ? [{ k: "rect", box: b, tone: "accent", dash: true } as OverlayShape] : [];
    });
    for (const b of this.plan().balloons) out.push(...this.preview(b));
    return out;
  }
  panel(): ReactNode {
    const c = this.ctx();
    const n = this.plan().balloons.length;
    return (
      <div className="session-options">
        <Row label="Layout">
          <Segmented
            label="Layout"
            value={this.layout}
            options={BALLOON_LAYOUTS.map((l) => [l, l === "around" ? "Free" : l[0].toUpperCase() + l.slice(1)] as const)}
            onChange={(l) => {
              this.layout = l;
              c.refresh();
            }}
            testId="auto-balloon-layout"
          />
        </Row>
        <p className="muted small" data-testid="auto-balloon-count">
          {n} balloon{n === 1 ? "" : "s"} to add in {this.views.join(", ") || "no view"}
        </p>
      </div>
    );
  }
}

registerDrawingTool({
  id: "annotation.autoBalloon",
  tab: "annotation",
  group: "notes",
  label: "Auto Balloon",
  icon: "balloon",
  title: "A balloon for every cut list item the chosen views show that has none: round the view, in a row or a column",
  testId: "drawing-balloon-all",
  disabled: (c) => (c.sheet && c.sheet.cutList.length ? undefined : "Balloons number a weldment's cut list items: this sheet has none"),
  run: (get) => new AutoBalloonSession(get),
});

// ------------------------------------------------------------ revision cloud

class CloudSession extends ToolSession {
  pts: Vec2[] = [];
  rev: string;
  constructor(get: () => DrawingToolCtx) {
    super("annotation.revisionCloud", get);
    const revs = get().drawing.revisions ?? [];
    this.rev = revs.length ? revs[revs.length - 1].rev : "";
  }
  name() {
    return "Revision cloud";
  }
  busy() {
    return this.pts.length > 0;
  }
  reset() {
    this.pts = [];
  }
  prompt() {
    return this.pts.length < 3 ? "Click round what changed (three points or more)" : "Click more points; double-click or Enter closes the cloud";
  }
  cloud(extra?: Vec2): Record<string, unknown> & { type: string } {
    return { type: "revisionCloud", pts: extra ? [...this.pts, extra] : this.pts, ...(this.rev ? { rev: this.rev } : {}) };
  }
  click(p: SheetPointer) {
    this.pts.push([Math.round(p.raw[0] * 10) / 10, Math.round(p.raw[1] * 10) / 10]);
    this.ctx().refresh();
  }
  doubleClick() {
    this.close();
  }
  close() {
    const c = this.ctx();
    // A double-click's second click added the same point twice.
    const pts = this.pts.filter((p, i) => i === 0 || Math.hypot(p[0] - this.pts[i - 1][0], p[1] - this.pts[i - 1][1]) > 0.5);
    if (pts.length < 3) return c.notice("A cloud needs three points or more", "error");
    this.pts = pts;
    if (this.add(this.cloud())) this.pts = [];
    c.refresh();
  }
  ok(): string | null {
    if (this.pts.length >= 3) this.close();
    this.ctx().end();
    return null;
  }
  overlay(): OverlayShape[] {
    const h = this.hover?.raw;
    if (!this.pts.length) return [];
    if (this.pts.length + (h ? 1 : 0) < 3) return [{ k: "line", pts: h ? [...this.pts, h] : this.pts, tone: "preview", dash: true }];
    return this.preview(this.cloud(h ?? undefined));
  }
  panel(): ReactNode {
    const c = this.ctx();
    return (
      <div className="session-options">
        <Row label="Revision">
          <Commit value={this.rev} width={60} placeholder="B" onCommit={(s) => {
            this.rev = s.trim();
            c.refresh();
          }} testId="cloud-rev" />
        </Row>
      </div>
    );
  }
}

registerDrawingTool({
  id: "annotation.revisionCloud",
  tab: "annotation",
  group: "notes",
  label: "Revision Cloud",
  icon: "warning",
  title: "A revision cloud round what changed, with its revision's letter: click round it, double-click to close",
  testId: "tool-annotation-revision-cloud",
  run: (get) => new CloudSession(get),
});


