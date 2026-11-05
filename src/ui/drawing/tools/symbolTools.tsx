// The symbol tools (Phase Q wave Q3A): the GD&T builder (characteristic
// palette, zone Ø, value, material and zone modifiers, up to three datums
// from the ones on the drawing with their modifiers, a second or composite
// row, a live preview of the frame and the rule checks as you build it),
// attached to a feature, a dimension or a leader point; the datum feature
// symbol (its letter counts up) and datum targets; the surface texture
// symbol; the weld symbol builder (arrow and other side, sizes, intermittent
// length and pitch, contour, finish, all around, field weld, tail; ISO or AWS
// preview; filled from a weld of the weld table).

import type { ReactNode } from "react";
import type { Annotation, DatumAnnotation, GdtAnnotation, GdtDatumRef, GdtModifier, GdtRow, SurfaceAnnotation, Vec2, Weld, WeldAnnotation, WeldSymbolSide } from "../../../doc/types";
import { LAY_SYMBOLS, SURFACE_SYMBOLS, WELD_CONTOURS, WELD_SYMBOLS } from "../../../doc/types";
import { validateDocument } from "../../../doc/validate";
import { CHARACTERISTIC_INFO, datumFromPick, datumLabels, draftStyle, framePrims, gdtFromPick, gdtProblems, sidesOfWeld, surfaceFromPick, surfacePrims } from "../../../drafting/annotate";
import { CHARACTERISTIC_CHAR, GDT_CHARACTERISTICS, type GdtCharacteristic } from "../../../drafting/symbols/glyphs";
import type { SnapKind, SnapTarget } from "../snap";
import { annotationKind, registerAnnotationKind, type KindPanelProps } from "./kinds";
import { previewAnnotation } from "./preview";
import { registerDrawingTool } from "./registry";
import { ToolSession, noViews } from "./toolSession";
import type { DrawingToolCtx, OverlayShape, SheetPointer } from "./types";
import { Commit, numberOf, PrimThumb, Row, Segmented } from "./ui";

const FEATURE: SnapKind[] = ["edge", "circle", "arc", "vertex", "midpoint", "centre", "quadrant"];
const LETTERS = "ABCDEFGHJKLMNPRSTUVWXYZ";

/** Every datum letter on the drawing (all sheets). */
function drawingDatums(c: { drawing: { sheets: { annotations: Annotation[] }[] } }): string[] {
  return [...datumLabels(c.drawing.sheets.flatMap((s) => s.annotations))].sort();
}

/** The next free datum letter, past the ones given too. */
export function nextLetter(used: Iterable<string>): string {
  const u = new Set(used);
  for (const l of LETTERS) if (!u.has(l)) return l;
  return "AA";
}

/** A pick of a feature or a dimension (the annotation under the pointer when it is a dimension). */
type Target = { ref?: string; dimension?: string; view: string; size?: boolean; at: Vec2 };

function targetAt(c: DrawingToolCtx, p: SheetPointer, dimensions = true): Target | null {
  // Geometry under the pointer first (a dimension's extension lines run over the part); else a dimension.
  if (dimensions && !p.snap && p.hit?.kind === "annotation") {
    const a = c.sheetDoc.annotations.find((x) => x.id === p.hit!.id);
    if (a?.type === "dimension") return { dimension: a.id, view: a.view, size: true, at: p.raw };
  }
  const s = p.snap;
  if (!s) return null;
  return { ref: s.ref, view: s.view, size: s.kind === "circle" || s.kind === "arc" || s.kind === "centre" ? true : s.kind === "edge" ? false : undefined, at: s.at };
}

// ------------------------------------------------------------ the GD&T builder

export interface GdtSpec {
  rows: GdtRow[];
  composite?: boolean;
  count?: number;
  above?: string;
  below?: string;
}

const MODS: [GdtModifier, string, string][] = [
  ["P", "Ⓟ", "Projected tolerance zone (height after it)"],
  ["F", "Ⓕ", "Free state"],
  ["T", "Ⓣ", "Tangent plane"],
  ["U", "Ⓤ", "Unequally disposed (amount after it)"],
  ["CZ", "CZ", "Common zone"],
  ["ST", "ST", "Statistical"],
  ["E", "Ⓔ", "Envelope"],
];

/** The frame's builder: used by the tool and by a frame's own panel. */
export function GdtEditor({ value, datums, onChange, problems, standard, template }: { value: GdtSpec; datums: string[]; onChange(v: GdtSpec): void; problems: string[]; standard: "ISO" | "ASME"; template: string }) {
  const rows = value.rows;
  const setRow = (i: number, r: Partial<GdtRow>) => {
    const next = rows.map((x, k) => (k === i ? ({ ...x, ...r } as GdtRow) : x));
    for (const x of next) for (const k of Object.keys(x) as (keyof GdtRow)[]) if (x[k] === undefined) delete x[k];
    onChange({ ...value, rows: next });
  };
  const datumChoices = [...new Set([...datums, ...(datums.length >= 2 ? [`${datums[0]}-${datums[1]}`] : [])])];
  const thumb = framePrims(value, draftStyle(standard, template)).prims;
  return (
    <div className="gdt-editor" data-testid="gdt-editor">
      <div className="gdt-palette" role="radiogroup" aria-label="Characteristic">
        {GDT_CHARACTERISTICS.map((ch) => (
          <button key={ch} type="button" role="radio" aria-checked={rows[0].characteristic === ch} className={rows[0].characteristic === ch ? "on" : ""} title={CHARACTERISTIC_INFO[ch].label} onClick={() => setRow(0, { characteristic: ch as GdtCharacteristic, ...(CHARACTERISTIC_INFO[ch].datums === "none" ? { datums: undefined } : {}), ...(CHARACTERISTIC_INFO[ch].size === "never" ? { material: undefined, diameter: undefined } : {}) })} data-testid={`gdt-char-${ch}`}>
            {CHARACTERISTIC_CHAR[ch]}
          </button>
        ))}
      </div>
      <p className="muted small">{CHARACTERISTIC_INFO[rows[0].characteristic].label}</p>
      {rows.map((r, i) => (
        <div className="gdt-row" key={i} data-testid={`gdt-row-${i}`}>
          {i > 0 && (
            <Row label="Row 2">
              <select value={r.characteristic} onChange={(e) => setRow(i, { characteristic: e.target.value as GdtCharacteristic })} data-testid={`gdt-char2-${i}`}>
                {GDT_CHARACTERISTICS.map((ch) => (
                  <option key={ch} value={ch}>
                    {CHARACTERISTIC_CHAR[ch]} {CHARACTERISTIC_INFO[ch].label}
                  </option>
                ))}
              </select>
            </Row>
          )}
          <div className="gdt-zone">
            <button type="button" className={`chip${r.diameter ? " on" : ""}`} aria-pressed={!!r.diameter} title="A cylindrical zone (an axis)" onClick={() => setRow(i, { diameter: r.diameter ? undefined : true, spherical: undefined })} data-testid={`gdt-dia-${i}`}>
              Ø
            </button>
            <button type="button" className={`chip${r.spherical ? " on" : ""}`} aria-pressed={!!r.spherical} title="A spherical zone" onClick={() => setRow(i, { spherical: r.spherical ? undefined : true, diameter: undefined })} data-testid={`gdt-sph-${i}`}>
              SØ
            </button>
            <Commit
              value={String(r.tolerance)}
              numeric
              width={70}
              onCommit={(s) => {
                const n = numberOf(s);
                if (n !== undefined && Number.isFinite(n) && n > 0) setRow(i, { tolerance: n });
              }}
              testId={`gdt-tol-${i}`}
            />
            <select value={r.material ?? ""} onChange={(e) => setRow(i, { material: (e.target.value || undefined) as GdtRow["material"] })} title="Material condition" data-testid={`gdt-mat-${i}`}>
              <option value="">RFS</option>
              <option value="M">Ⓜ MMC</option>
              <option value="L">Ⓛ LMC</option>
            </select>
          </div>
          <div className="gdt-mods">
            {MODS.map(([m, glyph, title]) => {
              const on = r.modifiers?.includes(m);
              return (
                <button key={m} type="button" className={`chip${on ? " on" : ""}`} aria-pressed={!!on} title={title} onClick={() => setRow(i, { modifiers: on ? r.modifiers!.filter((x) => x !== m) : [...(r.modifiers ?? []), m], ...(m === "P" && on ? { projected: undefined } : {}), ...(m === "U" && on ? { unequal: undefined } : {}) })} data-testid={`gdt-mod-${m}-${i}`}>
                  {glyph}
                </button>
              );
            })}
            {r.modifiers?.includes("P") && <Commit value={r.projected !== undefined ? String(r.projected) : ""} placeholder="height" numeric width={56} onCommit={(s) => setRow(i, { projected: numberOf(s) })} testId={`gdt-proj-${i}`} />}
            {r.modifiers?.includes("U") && <Commit value={r.unequal !== undefined ? String(r.unequal) : ""} placeholder="amount" numeric width={56} onCommit={(s) => setRow(i, { unequal: numberOf(s) })} testId={`gdt-uneq-${i}`} />}
          </div>
          {CHARACTERISTIC_INFO[r.characteristic].datums !== "none" && (
            <div className="gdt-datums">
              {[0, 1, 2].map((j) => {
                const d = r.datums?.[j];
                const setD = (nd: GdtDatumRef | undefined) => {
                  const list = [...(r.datums ?? [])];
                  if (nd) list[j] = nd;
                  else list.splice(j);
                  setRow(i, { datums: list.filter(Boolean).length ? list.filter(Boolean) : undefined });
                };
                if (j > (r.datums?.length ?? 0)) return null;
                return (
                  <span className="gdt-datum" key={j}>
                    <select value={d?.label ?? ""} onChange={(e) => setD(e.target.value ? { label: e.target.value, ...(d?.modifier ? { modifier: d.modifier } : {}) } : undefined)} data-testid={`gdt-datum-${i}-${j}`} title={["Primary", "Secondary", "Tertiary"][j]}>
                      <option value="">{["primary", "secondary", "tertiary"][j]}</option>
                      {datumChoices.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                      {d && !datumChoices.includes(d.label) && <option value={d.label}>{d.label} (not on the drawing)</option>}
                    </select>
                    {d && (
                      <select value={d.modifier ?? ""} onChange={(e) => setD({ label: d.label, ...(e.target.value ? { modifier: e.target.value as "M" | "L" } : {}) })} data-testid={`gdt-dmod-${i}-${j}`}>
                        <option value="">—</option>
                        <option value="M">Ⓜ</option>
                        <option value="L">Ⓛ</option>
                      </select>
                    )}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      ))}
      <div className="drawing-buttons">
        {rows.length === 1 ? (
          <button type="button" onClick={() => onChange({ ...value, rows: [...rows, { ...rows[0], tolerance: rows[0].tolerance / 2, datums: rows[0].datums?.slice(0, 1) }] })} data-testid="gdt-row2">
            Add a second row
          </button>
        ) : (
          <>
            <button type="button" onClick={() => onChange({ ...value, rows: rows.slice(0, 1), composite: undefined })} data-testid="gdt-row2-remove">
              Remove row 2
            </button>
            <label className="check" title="Both rows share the symbol: a pattern located to the datums (upper), its features to each other (lower)">
              <input type="checkbox" checked={!!value.composite} onChange={(e) => onChange({ ...value, composite: e.target.checked || undefined })} data-testid="gdt-composite" /> Composite
            </label>
          </>
        )}
      </div>
      <div className="tol-fields">
        <Row label="n×">
          <Commit value={value.count ? String(value.count) : ""} numeric width={50} onCommit={(s) => onChange({ ...value, count: numberOf(s) && numberOf(s)! > 1 ? numberOf(s) : undefined })} testId="gdt-count" />
        </Row>
        <Row label="Above">
          <Commit value={value.above ?? ""} onCommit={(s) => onChange({ ...value, above: s || undefined })} testId="gdt-above" />
        </Row>
        <Row label="Below">
          <Commit value={value.below ?? ""} placeholder="EACH ELEMENT" onCommit={(s) => onChange({ ...value, below: s || undefined })} testId="gdt-below" />
        </Row>
      </div>
      <PrimThumb prims={thumb} testId="gdt-preview" height={48} />
      {problems.length > 0 ? (
        <ul className="rule-checks bad" data-testid="gdt-problems">
          {problems.map((p) => (
            <li key={p}>⚠ {p}</li>
          ))}
        </ul>
      ) : (
        <p className="rule-checks ok" data-testid="gdt-ok">
          ✓ The frame follows the rules
        </p>
      )}
    </div>
  );
}

function specOf(a: Partial<GdtAnnotation>): GdtSpec {
  return { rows: a.rows ?? [], ...(a.composite ? { composite: true } : {}), ...(a.count ? { count: a.count } : {}), ...(a.above ? { above: a.above } : {}), ...(a.below ? { below: a.below } : {}) };
}

class GdtSession extends ToolSession {
  spec: GdtSpec = { rows: [{ characteristic: "position", diameter: true, tolerance: 0.1, material: "M", datums: [] }] };
  target: Target | null = null;
  constructor(get: () => DrawingToolCtx) {
    super("annotation.gdt", get);
    const d = drawingDatums(get());
    this.spec.rows[0].datums = d.slice(0, 3).map((label) => ({ label }));
  }
  name() {
    return "Geometric tolerance";
  }
  busy() {
    return !!this.target;
  }
  reset() {
    this.target = null;
  }
  prompt() {
    return this.target ? "Click where the frame goes" : "Build the frame in the panel, then click the feature (an edge, a circle) or a dimension it controls";
  }
  snaps() {
    return this.target ? { kinds: [] as SnapKind[] } : { kinds: FEATURE };
  }
  problems(): string[] {
    const c = this.ctx();
    const a = { type: "gdt", id: "", view: "", ...this.spec } as GdtAnnotation;
    return gdtProblems(a, { datums: new Set(drawingDatums(c)), standard: c.drawing.standard ?? "ISO", ...(this.target?.size !== undefined ? { sizeFeature: this.target.size } : {}) });
  }
  make(t: Target, at?: Vec2) {
    const sheet = this.ctx().sheet;
    if (!sheet) return "The sheet is still being drawn";
    const r = gdtFromPick(sheet, { ...(t.ref ? { ref: t.ref } : {}), ...(t.dimension ? { dimension: t.dimension } : {}) }, this.spec.rows, at);
    if (typeof r === "string") return r;
    return { ...r, ...specOf(this.spec) };
  }
  click(p: SheetPointer) {
    const c = this.ctx();
    if (!this.target) {
      const t = targetAt(c, p);
      if (!t) return c.notice("Click the feature (an edge, a circle) or a dimension", "error");
      if (t.dimension) {
        const r = this.make(t);
        if (typeof r === "string") return c.notice(r, "error");
        this.add(r);
        return c.refresh();
      }
      this.target = t;
      return c.refresh();
    }
    const r = this.make(this.target, p.raw);
    if (typeof r === "string") return c.notice(r, "error");
    if (this.add(r)) this.target = null;
    c.refresh();
  }
  overlay(): OverlayShape[] {
    const h = this.hover;
    if (!h) return [];
    if (!this.target) {
      const t = targetAt(this.ctx(), h);
      if (t?.dimension) {
        const r = this.make(t);
        return typeof r === "string" ? [] : this.preview(r, h.raw);
      }
      return [];
    }
    return [{ k: "dot", at: this.target.at, tone: "accent" }, ...this.preview(this.make(this.target, h.raw), h.raw)];
  }
  panel(): ReactNode {
    const c = this.ctx();
    return <GdtEditor value={this.spec} datums={drawingDatums(c)} standard={c.drawing.standard ?? "ISO"} template={c.sheet?.template ?? "iso"} problems={this.problems()} onChange={(v) => {
      this.spec = v;
      c.refresh();
    }} />;
  }
}

registerDrawingTool({
  id: "annotation.gdt",
  tab: "annotation",
  group: "symbols",
  label: "Geometric Tolerance",
  icon: "grid",
  title: "A feature control frame: build it (characteristic, Ø zone, value, Ⓜ/Ⓛ, datums), then click the feature or the dimension it controls",
  testId: "tool-annotation-gdt",
  disabled: noViews,
  run: (get) => new GdtSession(get),
});

registerAnnotationKind({
  ...annotationKind("gdt")!,
  panel: ({ a, write, ctx, env }: KindPanelProps) => {
    const g = a as unknown as GdtAnnotation;
    const c = ctx();
    const targetKind = g.dimension ? true : g.on && /:[ec]/.test(g.on) ? (c.snap?.targets.find((t) => t.ref === g.on)?.kind === "edge" ? false : true) : undefined;
    const problems = gdtProblems(g, { datums: new Set(drawingDatums(c)), standard: env.drawing.standard ?? "ISO", ...(targetKind !== undefined ? { sizeFeature: targetKind } : {}) });
    return <GdtEditor value={specOf(g)} datums={drawingDatums(c)} standard={env.drawing.standard ?? "ISO"} template={c.sheet?.template ?? "iso"} problems={problems} onChange={(v) => write({ rows: v.rows, composite: v.composite ?? null, count: v.count ?? null, above: v.above ?? null, below: v.below ?? null })} />;
  },
});

// ------------------------------------------------------------ datums

class DatumSession extends ToolSession {
  label: string;
  open = false;
  target: Target | null = null;
  constructor(get: () => DrawingToolCtx) {
    super("annotation.datum", get);
    this.label = nextLetter(drawingDatums(get()));
  }
  name() {
    return `Datum ${this.label}`;
  }
  busy() {
    return !!this.target;
  }
  reset() {
    this.target = null;
  }
  prompt() {
    return this.target ? `Click where datum ${this.label}'s frame goes` : `Click the surface (a straight edge) or the size's dimension that is datum ${this.label}`;
  }
  snaps() {
    return this.target ? { kinds: [] as SnapKind[] } : { kinds: ["edge", "vertex", "midpoint"] as SnapKind[] };
  }
  make(t: Target, at?: Vec2) {
    const sheet = this.ctx().sheet;
    if (!sheet) return "The sheet is still being drawn";
    const r = datumFromPick(sheet, { ...(t.ref ? { ref: t.ref } : {}), ...(t.dimension ? { dimension: t.dimension } : {}) }, this.label, at);
    if (typeof r === "string") return r.charAt(0).toUpperCase() + r.slice(1);
    return this.open ? { ...r, open: true } : r;
  }
  placed() {
    this.target = null;
    this.label = nextLetter([...drawingDatums(this.ctx()), this.label]);
  }
  click(p: SheetPointer) {
    const c = this.ctx();
    if (drawingDatums(c).includes(this.label)) return c.notice(`Datum ${this.label} is on the drawing already: choose another letter`, "error");
    if (!this.target) {
      const t = targetAt(c, p);
      if (!t) return c.notice(this.prompt(), "error");
      if (t.dimension) {
        const r = this.make(t);
        if (typeof r === "string") return c.notice(r, "error");
        if (this.add(r)) this.placed();
        return c.refresh();
      }
      const trial = this.make(t);
      if (typeof trial === "string") return c.notice(trial, "error");
      this.target = t;
      return c.refresh();
    }
    const r = this.make(this.target, p.raw);
    if (typeof r === "string") return c.notice(r, "error");
    if (this.add(r)) this.placed();
    c.refresh();
  }
  overlay(): OverlayShape[] {
    const h = this.hover;
    if (!h || !this.target) return [];
    return [{ k: "dot", at: this.target.at, tone: "accent" }, ...this.preview(this.make(this.target, h.raw), h.raw)];
  }
  panel(): ReactNode {
    const c = this.ctx();
    return (
      <div className="session-options">
        <Row label="Letter" hint="I, O and Q are not used; it counts up after each">
          <Commit value={this.label} width={60} onCommit={(s) => {
            const l = s.trim().toUpperCase();
            if (!/^[A-HJ-NPR-Z]{1,2}$/.test(l)) return c.notice(`"${s}" is not a datum letter (I, O and Q are not used)`, "error");
            this.label = l;
            c.refresh();
          }} testId="datum-label" />
        </Row>
        <label className="check">
          <input type="checkbox" checked={this.open} onChange={(e) => {
            this.open = e.target.checked;
            c.refresh();
          }} data-testid="datum-open" /> Open triangle
        </label>
        <p className="muted small">On the drawing: {drawingDatums(c).join(", ") || "none yet"}</p>
      </div>
    );
  }
}

registerDrawingTool({
  id: "annotation.datum",
  tab: "annotation",
  group: "symbols",
  label: "Datum Feature",
  icon: "datumPoint",
  title: "A datum feature symbol (A, B, C …, counting up): click the surface's edge or the size's dimension, then where its letter goes",
  testId: "tool-annotation-datum",
  disabled: noViews,
  run: (get) => new DatumSession(get),
});

class DatumTargetSession extends ToolSession {
  letter: string;
  target: SnapTarget | null = null;
  kind: "point" | "line" | "area" = "point";
  size = "";
  constructor(get: () => DrawingToolCtx) {
    super("annotation.datumTarget", get);
    this.letter = drawingDatums(get())[0] ?? "A";
  }
  name() {
    return "Datum target";
  }
  busy() {
    return !!this.target;
  }
  reset() {
    this.target = null;
  }
  label(): string {
    const used = this.ctx().drawing.sheets.flatMap((s) => s.annotations.flatMap((a) => (a.type === "datumTarget" ? [a.label] : [])));
    let n = 1;
    while (used.includes(`${this.letter}${n}`)) n++;
    return `${this.letter}${n}`;
  }
  prompt() {
    return this.target ? `Click where target ${this.label()}'s symbol goes` : `Click the target's point on the part (${this.kind})`;
  }
  snaps() {
    return this.target ? { kinds: [] as SnapKind[] } : { kinds: ["vertex", "midpoint", "centre", "quadrant"] as SnapKind[] };
  }
  make(t: SnapTarget, at?: Vec2): Record<string, unknown> & { type: string } {
    const n = numberOf(this.size);
    return { type: "datumTarget", view: t.view, label: this.label(), target: this.kind, on: t.ref, ...(this.kind === "area" && n && n > 0 ? { size: n } : {}), ...(at ? { at: this.rel(t.view, at) } : {}) };
  }
  click(p: SheetPointer) {
    const c = this.ctx();
    if (!this.target) {
      if (!p.snap) return c.notice(this.prompt(), "error");
      this.target = p.snap;
      return c.refresh();
    }
    if (this.add(this.make(this.target, p.raw))) this.target = null;
    c.refresh();
  }
  overlay(): OverlayShape[] {
    const h = this.hover;
    if (!h || !this.target) return [];
    return [...this.highlight(this.target), ...this.preview(this.make(this.target, h.raw), h.raw)];
  }
  panel(): ReactNode {
    const c = this.ctx();
    const set = (f: () => void) => {
      f();
      c.refresh();
    };
    return (
      <div className="session-options">
        <Row label="Datum">
          <Commit value={this.letter} width={50} onCommit={(s) => set(() => (this.letter = s.trim().toUpperCase() || "A"))} testId="target-letter" />
        </Row>
        <Row label="Target">
          <Segmented label="Target" value={this.kind} options={[["point", "Point"], ["line", "Line"], ["area", "Area"]]} onChange={(k) => set(() => (this.kind = k))} testId="target-kind" />
        </Row>
        {this.kind === "area" && (
          <Row label="Area Ø">
            <Commit value={this.size} numeric width={60} onCommit={(s) => set(() => (this.size = s))} testId="target-size" />
          </Row>
        )}
        <p className="muted small">Next: {this.label()}</p>
      </div>
    );
  }
}

registerDrawingTool({
  id: "annotation.datumTarget",
  tab: "annotation",
  group: "symbols",
  label: "Datum Target",
  icon: "x",
  title: "A datum target (A1, A2 …): a point, a line or an area of a datum feature",
  testId: "tool-annotation-datum-target",
  disabled: noViews,
  run: (get) => new DatumTargetSession(get),
});

// ------------------------------------------------------------ surface texture

export type SurfaceSpec = Pick<SurfaceAnnotation, "symbol" | "values" | "process" | "lay" | "allowance" | "allAround">;
const RA = ["Ra 0.4", "Ra 0.8", "Ra 1.6", "Ra 3.2", "Ra 6.3", "Ra 12.5", "Ra 25", "Rz 6.3", "Rz 25"];

export function SurfaceEditor({ value, onChange, standard, template, general }: { value: SurfaceSpec; onChange(v: SurfaceSpec): void; standard: "ISO" | "ASME"; template: string; general?: () => void }) {
  const set = (p: Partial<SurfaceSpec>) => {
    const next = { ...value, ...p } as Record<string, unknown>;
    for (const k of Object.keys(next)) if (next[k] === undefined || (Array.isArray(next[k]) && !(next[k] as unknown[]).length)) delete next[k];
    onChange(next as SurfaceSpec);
  };
  return (
    <div className="session-options" data-testid="surface-editor">
      <Row label="Symbol">
        <Segmented label="Symbol" value={value.symbol ?? "removal"} options={SURFACE_SYMBOLS.map((s) => [s, s === "basic" ? "Basic" : s === "removal" ? "Machined" : "No removal", s === "removal" ? "Material removal required" : s === "noRemoval" ? "Material removal not allowed" : "Any process"] as const)} onChange={(s) => set({ symbol: s })} testId="surface-symbol" />
      </Row>
      <Row label="Roughness">
        <select value={value.values?.[0] ?? ""} onChange={(e) => set({ values: e.target.value ? [e.target.value, ...(value.values?.slice(1) ?? [])] : value.values?.slice(1) })} data-testid="surface-ra">
          <option value="">none</option>
          {RA.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
          {value.values?.[0] && !RA.includes(value.values[0]) && <option value={value.values[0]}>{value.values[0]}</option>}
        </select>
      </Row>
      <Row label="Second line">
        <Commit value={value.values?.[1] ?? ""} placeholder="Rz 6.3 max" onCommit={(s) => set({ values: [value.values?.[0] ?? "", ...(s ? [s] : [])].filter(Boolean) })} testId="surface-ra2" />
      </Row>
      <Row label="Process">
        <Commit value={value.process ?? ""} placeholder="ground" onCommit={(s) => set({ process: s || undefined })} testId="surface-process" />
      </Row>
      <div className="tol-fields">
        <Row label="Lay">
          <select value={value.lay ?? ""} onChange={(e) => set({ lay: (e.target.value || undefined) as SurfaceSpec["lay"] })} data-testid="surface-lay">
            <option value="">—</option>
            {LAY_SYMBOLS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Allowance">
          <Commit value={value.allowance !== undefined ? String(value.allowance) : ""} numeric width={56} onCommit={(s) => set({ allowance: numberOf(s) })} testId="surface-allowance" />
        </Row>
        <label className="check">
          <input type="checkbox" checked={!!value.allAround} onChange={(e) => set({ allAround: e.target.checked || undefined })} data-testid="surface-all-around" /> All around
        </label>
      </div>
      <PrimThumb prims={surfacePrims(value, draftStyle(standard, template)).prims} testId="surface-preview" height={56} />
      {general && (
        <button type="button" onClick={general} data-testid="surface-general">
          Make it the general requirement (by the title block)
        </button>
      )}
    </div>
  );
}

class SurfaceSession extends ToolSession {
  spec: SurfaceSpec = { symbol: "removal", values: ["Ra 3.2"] };
  target: SnapTarget | null = null;
  constructor(get: () => DrawingToolCtx) {
    super("annotation.surface", get);
  }
  name() {
    return "Surface finish";
  }
  busy() {
    return !!this.target;
  }
  reset() {
    this.target = null;
  }
  prompt() {
    return this.target ? "Click where the symbol goes (it stands on the surface or on a leader)" : "Click the surface (an edge seen edge on)";
  }
  snaps() {
    return this.target ? { kinds: [] as SnapKind[] } : { kinds: ["edge", "arc", "circle"] as SnapKind[] };
  }
  make(t: SnapTarget, at?: Vec2) {
    const sheet = this.ctx().sheet;
    if (!sheet) return "The sheet is still being drawn";
    return surfaceFromPick(sheet, t.ref, this.spec, at);
  }
  click(p: SheetPointer) {
    const c = this.ctx();
    if (!this.target) {
      if (!p.snap) return c.notice(this.prompt(), "error");
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
      <SurfaceEditor
        value={this.spec}
        standard={c.drawing.standard ?? "ISO"}
        template={c.sheet?.template ?? "iso"}
        onChange={(v) => {
          this.spec = v;
          c.refresh();
        }}
        general={() => {
          if (c.sheetDoc.annotations.some((a) => a.type === "surface" && a.general)) return c.notice("The sheet has a general surface requirement already: edit it", "error");
          this.add({ type: "surface", general: true, ...this.spec });
        }}
      />
    );
  }
}

registerDrawingTool({
  id: "annotation.surface",
  tab: "annotation",
  group: "symbols",
  label: "Surface Finish",
  icon: "check",
  title: "A surface texture symbol (ISO 1302 / ISO 21920): machined or not, Ra/Rz, process, lay; click the surface, then where it goes",
  testId: "tool-annotation-surface",
  disabled: noViews,
  run: (get) => new SurfaceSession(get),
});

registerAnnotationKind({
  ...annotationKind("surface")!,
  panel: ({ a, write, ctx, env }) => {
    const s = a as unknown as SurfaceAnnotation;
    const spec: SurfaceSpec = { symbol: s.symbol, values: s.values, process: s.process, lay: s.lay, allowance: s.allowance, allAround: s.allAround };
    return (
      <SurfaceEditor
        value={spec}
        standard={env.drawing.standard ?? "ISO"}
        template={ctx().sheet?.template ?? "iso"}
        onChange={(v) => {
          const patch: Record<string, unknown> = {};
          for (const k of ["symbol", "values", "process", "lay", "allowance", "allAround"] as const) patch[k] = v[k] ?? null;
          write(patch);
        }}
      />
    );
  },
});

// ------------------------------------------------------------ the weld symbol builder

export interface WeldSpec {
  weld?: string;
  arrowSide?: WeldSymbolSide;
  otherSide?: WeldSymbolSide;
  staggered?: boolean;
  allAround?: boolean;
  field?: boolean;
  process?: string;
  reference?: string;
}

const SYMBOL_WORDS: Record<string, string> = { fillet: "Fillet", square: "Square butt", v: "V butt", bevel: "Bevel", u: "U butt", j: "J butt", flareV: "Flare V", flareBevel: "Flare bevel", plug: "Plug", slot: "Slot", spot: "Spot", seam: "Seam", edge: "Edge", backWeld: "Back weld", backing: "Backing", surfacing: "Surfacing", stud: "Stud" };

/** The spec a weld of the weld table makes, as the builder edits it. */
export function weldSpecFrom(w: Weld, standard: "ISO" | "ASME"): WeldSpec {
  const sides = sidesOfWeld(w, standard);
  return { weld: w.id, ...sides, ...(w.allRound ? { allAround: true } : {}), ...(w.process ? { process: w.process } : {}) };
}

function SideEditor({ side, value, onChange }: { side: "arrow" | "other"; value: WeldSymbolSide | undefined; onChange(v: WeldSymbolSide | undefined): void }) {
  const t = `weld-${side}`;
  const set = (p: Partial<WeldSymbolSide>) => {
    const next = { ...(value ?? { symbol: "fillet" }), ...p } as Record<string, unknown>;
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === "") delete next[k];
    onChange(next as unknown as WeldSymbolSide);
  };
  return (
    <fieldset className="weld-side" data-testid={t}>
      <legend>
        <label className="check">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked ? { symbol: "fillet" } : undefined)} data-testid={`${t}-on`} /> {side === "arrow" ? "Arrow side" : "Other side"}
        </label>
      </legend>
      {value && (
        <>
          <Row label="Weld">
            <select value={value.symbol} onChange={(e) => set({ symbol: e.target.value as WeldSymbolSide["symbol"] })} data-testid={`${t}-symbol`}>
              {WELD_SYMBOLS.map((s) => (
                <option key={s} value={s}>
                  {SYMBOL_WORDS[s] ?? s}
                </option>
              ))}
            </select>
          </Row>
          <div className="tol-fields">
            <Row label="Size" hint='"a5" throat, "z7" leg, "s6" penetration, or mm'>
              <Commit value={value.size !== undefined ? String(value.size) : ""} width={56} onCommit={(s) => set({ size: s.trim() ? (Number.isFinite(Number(s)) ? Number(s) : s.trim()) : undefined })} testId={`${t}-size`} />
            </Row>
            <Row label="Length">
              <Commit value={value.length !== undefined ? String(value.length) : ""} numeric width={56} onCommit={(s) => set({ length: numberOf(s) })} testId={`${t}-length`} />
            </Row>
            <Row label="n">
              <Commit value={value.count !== undefined ? String(value.count) : ""} numeric width={40} onCommit={(s) => set({ count: numberOf(s) })} testId={`${t}-count`} />
            </Row>
            <Row label="Pitch">
              <Commit value={value.pitch !== undefined ? String(value.pitch) : ""} numeric width={56} onCommit={(s) => set({ pitch: numberOf(s) })} testId={`${t}-pitch`} />
            </Row>
          </div>
          <div className="tol-fields">
            <Row label="Contour">
              <select value={value.contour ?? ""} onChange={(e) => set({ contour: (e.target.value || undefined) as WeldSymbolSide["contour"] })} data-testid={`${t}-contour`}>
                <option value="">—</option>
                {WELD_CONTOURS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Finish" hint="C chip, G grind, M machine, R roll, H hammer, P peen">
              <select value={value.finish ?? ""} onChange={(e) => set({ finish: e.target.value || undefined })} data-testid={`${t}-finish`}>
                <option value="">—</option>
                {["C", "G", "M", "R", "H", "P"].map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </Row>
            {["v", "bevel", "u", "j"].includes(value.symbol) && (
              <Row label="Angle °">
                <Commit value={value.angle !== undefined ? String(value.angle) : ""} numeric width={50} onCommit={(s) => set({ angle: numberOf(s) })} testId={`${t}-angle`} />
              </Row>
            )}
          </div>
        </>
      )}
    </fieldset>
  );
}

export function WeldEditor({ value, welds, onChange, preview }: { value: WeldSpec; welds: Weld[]; onChange(v: WeldSpec): void; preview?: ReactNode }) {
  const set = (p: Partial<WeldSpec>) => {
    const next = { ...value, ...p } as Record<string, unknown>;
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === false || next[k] === "") delete next[k];
    onChange(next as WeldSpec);
  };
  return (
    <div className="session-options weld-editor" data-testid="weld-editor">
      <Row label="From the weld table">
        <select value={value.weld ?? ""} onChange={(e) => set({ weld: e.target.value || undefined })} data-testid="weld-from">
          <option value="">— (drawn by hand)</option>
          {welds.map((w) => (
            <option key={w.id} value={w.id}>
              {w.id}: {w.type} {w.size} mm, {w.between.join(" + ")}
            </option>
          ))}
        </select>
      </Row>
      <SideEditor side="arrow" value={value.arrowSide} onChange={(s) => set({ arrowSide: s })} />
      <SideEditor side="other" value={value.otherSide} onChange={(s) => set({ otherSide: s })} />
      <div className="dim-flags">
        <label className="check">
          <input type="checkbox" checked={!!value.allAround} onChange={(e) => set({ allAround: e.target.checked })} data-testid="weld-all-around" /> All around
        </label>
        <label className="check">
          <input type="checkbox" checked={!!value.field} onChange={(e) => set({ field: e.target.checked })} data-testid="weld-field" /> Field weld
        </label>
        <label className="check">
          <input type="checkbox" checked={!!value.staggered} onChange={(e) => set({ staggered: e.target.checked })} data-testid="weld-staggered" /> Staggered
        </label>
      </div>
      <div className="tol-fields">
        <Row label="Process">
          <Commit value={value.process ?? ""} placeholder="135" onCommit={(s) => set({ process: s.trim() || undefined })} testId="weld-process" />
        </Row>
        <Row label="Reference">
          <Commit value={value.reference ?? ""} placeholder="WPS-01" onCommit={(s) => set({ reference: s.trim() || undefined })} testId="weld-reference" />
        </Row>
      </div>
      {preview}
    </div>
  );
}

class WeldSession extends ToolSession {
  spec: WeldSpec = { arrowSide: { symbol: "fillet", size: "a4" } };
  target: SnapTarget | null = null;
  standard: "ISO" | "ASME";
  constructor(get: () => DrawingToolCtx) {
    super("annotation.weld", get);
    this.standard = get().drawing.standard ?? "ISO";
  }
  name() {
    return "Weld symbol";
  }
  busy() {
    return !!this.target;
  }
  reset() {
    this.target = null;
  }
  welds() {
    return validateDocument(this.ctx().doc).welds;
  }
  prompt() {
    return this.target ? "Click where the reference line goes" : "Click the joint (an edge of a welded body fills the symbol from its weld), or choose a weld in the panel";
  }
  snaps() {
    return this.target ? { kinds: [] as SnapKind[] } : { kinds: ["edge", "vertex", "midpoint", "arc", "circle"] as SnapKind[] };
  }
  make(t: SnapTarget, at?: Vec2): Record<string, unknown> & { type: string } {
    const spec: Record<string, unknown> = { ...this.spec };
    // A weld of the table drawn as the table has it keeps up with the table: its sides aren't copied.
    const w = this.spec.weld ? this.welds().find((x) => x.id === this.spec.weld) : undefined;
    if (w) {
      const table = weldSpecFrom(w, this.ctx().drawing.standard ?? "ISO");
      for (const k of ["arrowSide", "otherSide", "allAround", "process"] as const) if (JSON.stringify(table[k]) === JSON.stringify(spec[k])) delete spec[k];
    }
    return { type: "weld", view: t.view, on: t.ref, ...spec, ...(at ? { at: this.rel(t.view, at) } : {}) } as Record<string, unknown> & { type: string };
  }
  click(p: SheetPointer) {
    const c = this.ctx();
    if (!this.target) {
      if (!p.snap) return c.notice(this.prompt(), "error");
      // A welded body: the symbol takes its weld (the first not yet shown in this view, else the first).
      const body = p.snap.body ?? p.snap.feature;
      if (!this.spec.weld && body) {
        const shown = new Set(c.sheetDoc.annotations.flatMap((a) => (a.type === "weld" && a.view === p.snap!.view && a.weld ? [a.weld] : [])));
        const mine = this.welds().filter((x) => x.between.includes(body));
        const w = mine.find((x) => !shown.has(x.id)) ?? mine[0];
        if (w) this.spec = weldSpecFrom(w, this.standard === "ASME" ? "ASME" : "ISO");
      }
      this.target = p.snap;
      return c.refresh();
    }
    if (this.add(this.make(this.target, p.raw))) this.target = null;
    c.refresh();
  }
  overlay(): OverlayShape[] {
    const h = this.hover;
    if (!h || !this.target) return h?.snap ? this.highlight(h.snap, "preview") : [];
    return [...this.highlight(this.target), ...this.preview(this.make(this.target, h.raw), h.raw)];
  }
  panel(): ReactNode {
    const c = this.ctx();
    const sheet = c.sheet;
    const t = this.target;
    const shown = t ? previewAnnotation(sheet, { ...this.make(t), id: "__weld" } as unknown as Annotation, { standard: this.standard })?.prims : undefined;
    return (
      <WeldEditor
        value={this.spec}
        welds={this.welds()}
        onChange={(v) => {
          if (v.weld && v.weld !== this.spec.weld) {
            const w = this.welds().find((x) => x.id === v.weld);
            if (w) v = { ...weldSpecFrom(w, this.standard), ...(v.reference ? { reference: v.reference } : {}), ...(v.field ? { field: true } : {}) };
          }
          this.spec = v;
          c.refresh();
        }}
        preview={
          <>
            <Row label="Preview">
              <Segmented label="Standard" value={this.standard} options={[["ISO", "ISO 2553"], ["ASME", "AWS A2.4"]]} onChange={(s) => {
                this.standard = s;
                c.refresh();
              }} testId="weld-standard" />
            </Row>
            {shown ? <PrimThumb prims={shown} testId="weld-preview" height={72} /> : <p className="muted small">Pick the joint to see the symbol.</p>}
          </>
        }
      />
    );
  }
}

registerDrawingTool({
  id: "annotation.weld",
  tab: "annotation",
  group: "symbols",
  label: "Weld Symbol",
  icon: "joint",
  title: "A weld symbol (ISO 2553 / AWS A2.4): arrow and other side, sizes, length-pitch, contour, all around, field weld, tail; click a welded body to fill it from its weld",
  testId: "tool-annotation-weld",
  disabled: noViews,
  run: (get) => new WeldSession(get),
});

registerAnnotationKind({
  ...annotationKind("weld")!,
  panel: ({ a, write, ctx }) => {
    const w = a as unknown as WeldAnnotation;
    const spec: WeldSpec = { weld: w.weld, arrowSide: w.arrowSide, otherSide: w.otherSide, staggered: w.staggered, allAround: w.allAround, field: w.field, process: w.process, reference: w.reference };
    return (
      <WeldEditor
        value={spec}
        welds={validateDocument(ctx().doc).welds}
        onChange={(v) => {
          const patch: Record<string, unknown> = {};
          for (const k of ["weld", "arrowSide", "otherSide", "staggered", "allAround", "field", "process", "reference"] as const) patch[k] = v[k] ?? null;
          if (!v.weld && !w.on) return void ctx().notice("A symbol drawn by hand points at the joint: keep its weld, or delete it and draw it with the tool", "error");
          write(patch);
        }}
      />
    );
  },
});

export type { DatumAnnotation };
