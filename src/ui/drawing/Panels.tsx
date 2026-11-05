// The drawing's property panel (Phase Q wave Q2B), on the right: the
// drawing checks; an open tool's session (OK, Cancel, what to do, its
// options); else what is selected — a view (orientation, scale, display,
// tangent edges, threads, label, hatch, bodies, alignment, lock, Auto
// dimension), an annotation (its kind's schema), a table (columns, sort,
// group, split, place) — else the sheet (format and title block).

import { useState, type ReactNode } from "react";
import type { Command } from "../../doc/commands";
import { STANDARD_SCALES, viewKind } from "../../doc/drawing";
import { DISPLAY_MODES, HATCH_PATTERNS, PROJECT_DIRECTIONS, SHEET_SIZES, SHEET_TEMPLATES, TANGENT_MODES, VIEW_LOOKS, type DrawingView, type ProjectDirection, type ViewLook } from "../../doc/types";
import { DEFAULT_COLUMNS, TABLE_COLUMNS, TABLE_CORNERS, type DrawingTable } from "../../drafting/tables";
import { Icon } from "../icons";
import { alignmentOf } from "./align";
import { viewIcon, viewWords } from "./DrawingTree";
import { runAutoDimension } from "./tools/annotationTools";
import { annotationKind } from "./tools/kinds";
import { SchemaForm } from "./tools/SchemaForm";
import { applyPatch, type PropField, type SchemaEnv } from "./tools/schema";
import { viewBody } from "./tools/session";
import type { DrawingSession, DrawingToolCtx, OverlayShape, SheetPointer } from "./tools/types";
import type { Workspace } from "./Workspace";

const DISPLAY_LABEL: Record<(typeof DISPLAY_MODES)[number], string> = { removed: "hidden lines removed", hidden: "hidden lines dashed", visible: "every edge (wireframe)", shaded: "shaded", shadedEdges: "shaded with edges" };
const CORNER_LABEL: Record<(typeof TABLE_CORNERS)[number], string> = { topLeft: "top left", topRight: "top right", bottomLeft: "bottom left", bottomRight: "bottom right", aboveTitleBlock: "above the title block", leftOfTitleBlock: "left of the title block" };

export function DrawingPanel({ ws }: { ws: Workspace }) {
  const { p } = ws;
  const [checksOpen, setChecksOpen] = useState(true);
  const failing = p.checks.filter((c) => !c.ok).length;
  return (
    <div className="panel drawing-side" data-testid="drawing-side">
      <div className="checks-head">
        <button className="fold" onClick={() => setChecksOpen((o) => !o)} aria-expanded={checksOpen} data-testid="drawing-checks-fold">
          <Icon name="chevronRight" size={11} className={checksOpen ? "open" : ""} />
          <h2>Checks</h2>
          <span className={failing ? "check-badge bad" : "check-badge ok"}>{failing ? `${failing} to fix` : "all pass"}</span>
        </button>
      </div>
      <ul className="checks" data-testid="drawing-checks" hidden={!checksOpen}>
        {p.checks.map((c) => (
          <li key={c.label} className={c.ok ? "ok" : "bad"} title={`Expected: ${c.expected}`}>
            <span className="check-mark">{c.ok ? "✓" : "✗"}</span> {c.label}
            <span className="muted">: {c.actual}</span>
          </li>
        ))}
      </ul>
      {ws.session ? <SessionCard ws={ws} session={ws.session} /> : <Selected ws={ws} />}
    </div>
  );
}

function SessionCard({ ws, session }: { ws: Workspace; session: DrawingSession }) {
  const blocked = session.blocked();
  void ws.tick;
  return (
    <div className="properties in-session drawing-session" data-testid="drawing-session">
      <div className="session-bar" data-testid="session-bar">
        <span className="session-title" data-testid="session-title">
          {session.title()}
        </span>
        <span className="session-actions">
          <button type="button" className="session-cancel" title="Cancel: leave the drawing as it was (Esc)" onClick={ws.cancel} data-testid="session-cancel">
            <Icon name="x" size={15} />
            Cancel
          </button>
          <button type="button" className="session-ok" title={blocked ?? `OK: keep it, one undo step (Enter)`} onClick={ws.ok} disabled={!!blocked} data-testid="session-ok">
            <Icon name="check" size={15} />
            OK
          </button>
        </span>
      </div>
      <p className="session-pending" role="status" data-testid="session-prompt-text">
        {session.prompt()}
      </p>
      {session.panel?.()}
    </div>
  );
}

function Selected({ ws }: { ws: Workspace }) {
  const { p } = ws;
  const sel = ws.selection;
  const all = p.drawing!.sheets;
  if (sel.length > 1) {
    return (
      <div data-testid="drawing-props">
        <h2>{sel.length} selected</h2>
        <p className="muted small">{sel.join(", ")}</p>
        <div className="drawing-buttons">
          <button className="danger" onClick={() => ws.deleteIds(sel)} data-testid="prop-multi-delete">
            Delete {sel.length}
          </button>
        </div>
      </div>
    );
  }
  const id = sel[0];
  const view = id ? all.flatMap((s) => s.views).find((v) => v.id === id) : undefined;
  if (view) return <ViewPanel ws={ws} view={view} />;
  const ann = id ? all.flatMap((s) => s.annotations).find((a) => a.id === id) : undefined;
  if (ann) return <AnnotationPanel ws={ws} a={ann as unknown as Record<string, unknown>} />;
  const table = id ? all.flatMap((s) => s.tables ?? []).find((t) => t.id === id) : undefined;
  if (table) return <TablePanel ws={ws} table={table} />;
  return <SheetPanel ws={ws} />;
}

// ------------------------------------------------------------ a view

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field" title={hint}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

function TextField({ value, placeholder, onCommit, testId }: { value: string; placeholder?: string; onCommit(v: string): void; testId: string }) {
  return (
    <input
      type="text"
      defaultValue={value}
      key={value}
      placeholder={placeholder}
      onBlur={(e) => e.target.value.trim() !== value && onCommit(e.target.value.trim())}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      data-testid={testId}
    />
  );
}

export function ScaleSelect({ value, auto, onChange, testId }: { value: string | undefined; auto: string; onChange(v: string | undefined): void; testId: string }) {
  const custom = value !== undefined && !STANDARD_SCALES.includes(value);
  const [typing, setTyping] = useState(custom);
  return (
    <span className="scale-select">
      <select
        value={typing ? "custom" : (value ?? "")}
        onChange={(e) => {
          if (e.target.value === "custom") return setTyping(true);
          setTyping(false);
          onChange(e.target.value || undefined);
        }}
        data-testid={testId}
      >
        <option value="">{auto}</option>
        {STANDARD_SCALES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
        <option value="custom">custom…</option>
      </select>
      {typing && <TextField value={value ?? ""} placeholder="3:4" onCommit={(v) => onChange(v || undefined)} testId={`${testId}-custom`} />}
    </span>
  );
}

function ViewPanel({ ws, view }: { ws: Workspace; view: DrawingView }) {
  const { p } = ws;
  const sheetDoc = ws.sheetDoc!;
  const cv = p.sheet?.views.find((v) => v.id === view.id);
  const kind = viewKind(view);
  const set = (patch: Record<string, unknown>) => ws.run({ type: "setView", id: view.id, view: viewBody(view, patch as Partial<DrawingView>) });
  const al = alignmentOf(view, sheetDoc.views, sheetDoc.projection);
  const free = (view as { free?: boolean }).free;
  const locked = (view as { locked?: boolean }).locked;
  const hatch = view.hatch ?? {};
  return (
    <div data-testid="drawing-props" className="view-props">
      <div className="prop-header">
        <span className="prop-icon" aria-hidden="true">
          <Icon name={viewIcon(view)} size={18} />
        </span>
        <h3>View</h3>
        <span className="muted mono">{view.id}</span>
      </div>
      <p className="muted small" data-testid="prop-view-kind">
        {viewWords(view)}
        {cv ? ` · ${cv.scaleText}` : ""}
      </p>
      {kind === "model" && !view.orientation && (
        <Field label="Orientation">
          <select value={view.look ?? "front"} onChange={(e) => set({ look: e.target.value as ViewLook })} data-testid="prop-view-look">
            {VIEW_LOOKS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      )}
      {kind === "projected" && (
        <Field label="Side">
          <select value={view.direction ?? "right"} onChange={(e) => set({ direction: e.target.value as ProjectDirection })} data-testid="prop-view-direction">
            {PROJECT_DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Scale">
        <ScaleSelect value={view.scale} auto={`${kind === "detail" ? "twice its parent's" : "the sheet's"} (${cv?.scaleText ?? "…"})`} onChange={(scale) => set({ scale })} testId="prop-view-scale" />
      </Field>
      <Field label="Display">
        <select value={view.display ?? ""} onChange={(e) => set({ display: e.target.value || undefined })} data-testid="prop-view-display">
          <option value="">{DISPLAY_LABEL.removed}</option>
          {DISPLAY_MODES.filter((m) => m !== "removed").map((m) => (
            <option key={m} value={m}>
              {DISPLAY_LABEL[m]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Tangent edges">
        <select value={view.tangent ?? "removed"} onChange={(e) => set({ tangent: e.target.value === "removed" ? undefined : e.target.value })} data-testid="prop-view-tangent">
          {TANGENT_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Cosmetic threads">
        <input type="checkbox" checked={view.threads !== false} onChange={(e) => set({ threads: e.target.checked ? undefined : false })} data-testid="prop-view-threads" />
      </Field>
      {(kind === "section" || kind === "detail" || kind === "auxiliary") && (
        <Field label="Label">
          <TextField value={view.label ?? ""} onCommit={(v) => set({ label: v || undefined })} testId="prop-view-label" />
        </Field>
      )}
      <Field label="Show label">
        <select value={view.showLabel === undefined ? "" : String(view.showLabel)} onChange={(e) => set({ showLabel: e.target.value === "" ? undefined : e.target.value === "true" })} data-testid="prop-view-show-label">
          <option value="">automatic</option>
          <option value="true">yes</option>
          <option value="false">no</option>
        </select>
      </Field>
      <Field label="Scale in label">
        <select value={view.showScale === undefined ? "" : String(view.showScale)} onChange={(e) => set({ showScale: e.target.value === "" ? undefined : e.target.value === "true" })} data-testid="prop-view-show-scale">
          <option value="">when not the sheet's</option>
          <option value="true">yes</option>
          <option value="false">no</option>
        </select>
      </Field>
      {kind === "section" && (
        <>
          <Field label="Look the other way">
            <input type="checkbox" checked={!!view.flip} onChange={(e) => set({ flip: e.target.checked || undefined })} data-testid="prop-view-flip" />
          </Field>
          <Field label="Half section">
            <input type="checkbox" checked={!!view.half} onChange={(e) => set({ half: e.target.checked || undefined })} data-testid="prop-view-half" />
          </Field>
          <Field label="Show behind the cut">
            <input type="checkbox" checked={view.showBehind !== false} onChange={(e) => set({ showBehind: e.target.checked ? undefined : false })} data-testid="prop-view-behind" />
          </Field>
        </>
      )}
      {(kind === "section" || (view.brokenOut?.length ?? 0) > 0) && (
        <fieldset className="prop-group">
          <legend>Hatch</legend>
          <Field label="Pattern">
            <select value={hatch.pattern ?? ""} onChange={(e) => set({ hatch: tidy({ ...hatch, pattern: e.target.value || undefined }) })} data-testid="prop-view-hatch-pattern">
              <option value="">by each body's material</option>
              {HATCH_PATTERNS.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Angle">
            <TextField value={hatch.angle === undefined ? "" : String(hatch.angle)} placeholder="45° (each body its own)" onCommit={(v) => set({ hatch: tidy({ ...hatch, angle: v === "" ? undefined : Number(v) }) })} testId="prop-view-hatch-angle" />
          </Field>
          <Field label="Spacing">
            <TextField value={hatch.spacing === undefined ? "" : String(hatch.spacing)} placeholder="by the view's size" onCommit={(v) => set({ hatch: tidy({ ...hatch, spacing: v === "" ? undefined : Number(v) }) })} testId="prop-view-hatch-spacing" />
          </Field>
        </fieldset>
      )}
      {p.bodies.length > 1 && (
        <fieldset className="prop-group">
          <legend>Bodies shown</legend>
          {p.bodies.map((b) => {
            const shown = !view.bodies || view.bodies.includes(b);
            return (
              <label key={b} className="check-row">
                <input
                  type="checkbox"
                  checked={shown}
                  onChange={(e) => {
                    const cur = view.bodies ?? p.bodies;
                    const next = e.target.checked ? [...cur, b] : cur.filter((x) => x !== b);
                    set({ bodies: next.length === p.bodies.length ? undefined : next });
                  }}
                  data-testid={`prop-view-body-${b}`}
                />
                {b}
              </label>
            );
          })}
        </fieldset>
      )}
      <div className="drawing-buttons wrap">
        <button onClick={() => runAutoDimension(ws.ctx(), view.id)} disabled={!cv?.square} title={cv?.square ? "Dimension it: overall size, holes, centre marks" : "Dimensions go in front, top and side views"} data-testid="prop-view-autodim">
          <Icon name="fullyDefine" size={14} />
          Auto-dimension view
        </button>
        {(al.axis !== null || free) && (
          <button onClick={() => set(free ? { free: undefined, at: undefined } : { free: true })} data-testid="prop-view-align" title={free ? "Line it up with its parent again" : "Place it freely, not lined up with its parent"}>
            <Icon name={free ? "link" : "moveEntities"} size={14} />
            {free ? "Restore alignment" : "Break alignment"}
          </button>
        )}
        <button onClick={() => set({ locked: locked ? undefined : true })} aria-pressed={!!locked} data-testid="prop-view-lock">
          <Icon name="pin" size={14} />
          {locked ? "Unlock position" : "Lock position"}
        </button>
        {view.at && (
          <button onClick={() => ws.run({ type: "moveView", id: view.id, at: null })} data-testid="prop-view-auto">
            Place with the others
          </button>
        )}
        <button className="danger" onClick={() => ws.deleteIds([view.id])} data-testid="prop-view-delete">
          Delete view
        </button>
      </div>
    </div>
  );
}

function tidy<T extends Record<string, unknown>>(o: T): T | undefined {
  const out = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(typeof v === "number" && !Number.isFinite(v)))) as T;
  return Object.keys(out).length ? out : undefined;
}

// ------------------------------------------------------------ an annotation

/** A pick on the sheet into one reference field of an annotation: the next click on matching geometry fills it. */
class FieldPick implements DrawingSession {
  readonly tool = "pick.field";
  private hover: SheetPointer | null = null;
  constructor(
    private readonly ctx: () => DrawingToolCtx,
    private readonly a: Record<string, unknown>,
    private readonly field: PropField,
    private readonly write: (patch: Record<string, unknown>) => string | null,
  ) {}
  title() {
    return `${this.field.label} of ${String(this.a.id)}`;
  }
  prompt() {
    return `Click the ${this.field.label.toLowerCase()} on the sheet${typeof this.a.view === "string" ? ` in ${this.a.view}` : ""}`;
  }
  snaps() {
    return { kinds: this.field.picks ?? ["vertex", "centre"], view: typeof this.a.view === "string" ? this.a.view : null };
  }
  move(p: SheetPointer) {
    this.hover = p;
    this.ctx().refresh();
  }
  click(p: SheetPointer) {
    if (!p.snap) return this.ctx().notice(this.prompt(), "error");
    const path = this.field.key.split(".");
    const patch = path.length === 1 ? { [path[0]]: p.snap.ref } : { [path[0]]: Object.assign([...((this.a[path[0]] as unknown[]) ?? [])], { [Number(path[1])]: p.snap.ref }) };
    if (!this.write(patch)) this.ctx().end();
  }
  overlay(): OverlayShape[] {
    return this.hover?.snap ? [{ k: "dot", at: this.hover.snap.at, tone: "accent" }] : [];
  }
  blocked() {
    return this.prompt();
  }
  ok() {
    this.ctx().end();
    return null;
  }
  cancel() {
    this.ctx().end();
  }
}

function AnnotationPanel({ ws, a }: { ws: Workspace; a: Record<string, unknown> }) {
  const { p } = ws;
  const k = annotationKind(String(a.type));
  const said = p.sheet?.annotations.find((x) => x.id === a.id);
  const env: SchemaEnv = { doc: p.doc!, drawing: p.drawing!, sheetDoc: ws.sheetDoc!, sheet: p.sheet, measurements: p.measurements };
  const write = (patch: Record<string, unknown>) => {
    const next = applyPatch(a, patch);
    delete next.id;
    return ws.run({ type: "setAnnotation", id: String(a.id), annotation: next });
  };
  return (
    <div data-testid="drawing-props" className="annotation-props">
      <div className="prop-header">
        <span className="prop-icon" aria-hidden="true">
          <Icon name={k?.icon ?? "note"} size={18} />
        </span>
        <h3>{k?.label ?? String(a.type)}</h3>
        <span className="muted mono">{String(a.id)}</span>
      </div>
      <p className={said?.problem ? "bad" : "muted"} data-testid="prop-annotation-says">
        {said?.problem ? `⚠ ${said.problem}` : said?.text ? `Reads: ${said.text}` : ""}
      </p>
      {k?.panel?.({ a, said, env, write, ctx: ws.ctx })}
      {k ? (
        <KindForm folded={!!k.panel}>
          <SchemaForm
            schema={k.schema}
            value={a}
            env={env}
            prefix={`prop-${String(a.type)}`}
            onPatch={write}
            armed={ws.session?.tool === "pick.field" ? "" : null}
            onArm={(f) => {
              if (!f) return;
              const s = new FieldPick(ws.ctx, a, f, write);
              ws.setSessionDirect(s);
            }}
          />
        </KindForm>
      ) : (
        <p className="muted small">This kind of annotation has no panel yet: edit it in the document or ask the assistant.</p>
      )}
      <div className="drawing-buttons">
        {"at" in a && a.at !== undefined && a.type !== "note" && (
          <button onClick={() => write({ at: null })} data-testid="prop-annotation-auto">
            Place automatically
          </button>
        )}
        <button className="danger" onClick={() => ws.deleteIds([String(a.id)])} data-testid="prop-annotation-delete">
          Delete
        </button>
      </div>
    </div>
  );
}

/** The schema's fields: as they are, or folded under "All properties" below a kind's own panel. */
function KindForm({ folded, children }: { folded: boolean; children: ReactNode }) {
  if (!folded) return <>{children}</>;
  return (
    <details className="all-props" data-testid="prop-all">
      <summary>All properties</summary>
      {children}
    </details>
  );
}

// ------------------------------------------------------------ a table

export function TablePanel({ ws, table }: { ws: Workspace; table: DrawingTable }) {
  const { p } = ws;
  const set = (patch: Partial<DrawingTable> | Record<string, unknown>) => {
    const next = applyPatch(table as unknown as Record<string, unknown>, patch as Record<string, unknown>);
    delete next.id;
    return ws.run({ type: "setTable", id: table.id, table: next } as Command);
  };
  const catalogue = TABLE_COLUMNS[table.kind] ?? [];
  const shown = table.columns ?? defaultColumns(table);
  const [newProp, setNewProp] = useState("");
  const anchor = table.anchor && "corner" in table.anchor ? table.anchor.corner : table.anchor ? "free" : "";
  return (
    <div data-testid="drawing-props" className="table-props">
      <div className="prop-header">
        <span className="prop-icon" aria-hidden="true">
          <Icon name="grid" size={18} />
        </span>
        <h3>Table</h3>
        <span className="muted mono">{table.id}</span>
      </div>
      <p className="muted small">{table.kind}</p>
      <Field label="Title">
        <TextField value={table.title === null ? "" : (table.title ?? "")} placeholder="the kind's name" onCommit={(v) => set({ title: v || null })} testId="prop-table-title" />
      </Field>
      {table.kind !== "general" && (
        <fieldset className="prop-group">
          <legend>Columns</legend>
          <div className="column-chooser" data-testid="prop-table-columns">
            {[...catalogue.map((c) => c.key), ...shown.filter((k) => k.startsWith("prop:"))].map((key) => {
              const def = catalogue.find((c) => c.key === key);
              const on = shown.includes(key);
              const i = shown.indexOf(key);
              return (
                <div key={key} className={`column-row${on ? " on" : ""}`}>
                  <label title={def?.help}>
                    <input type="checkbox" checked={on} onChange={(e) => set({ columns: e.target.checked ? [...shown, key] : shown.filter((x) => x !== key) })} data-testid={`prop-table-col-${key}`} />
                    {def?.header ?? key.replace("prop:", "")}
                  </label>
                  {on && (
                    <span className="column-move">
                      <button disabled={i === 0} aria-label={`Move ${key} left`} onClick={() => set({ columns: swap(shown, i, i - 1) })}>
                        <Icon name="up" size={12} />
                      </button>
                      <button disabled={i === shown.length - 1} aria-label={`Move ${key} right`} onClick={() => set({ columns: swap(shown, i, i + 1) })}>
                        <Icon name="down" size={12} />
                      </button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {(table.kind === "cutList" || table.kind === "bom") && (
            <span className="add-prop">
              <input value={newProp} onChange={(e) => setNewProp(e.target.value)} placeholder="custom property" aria-label="Custom property column" data-testid="prop-table-new-prop" />
              <button
                disabled={!newProp.trim()}
                onClick={() => {
                  if (!set({ columns: [...shown, `prop:${newProp.trim()}`] })) setNewProp("");
                }}
                data-testid="prop-table-add-prop"
              >
                Add column
              </button>
            </span>
          )}
        </fieldset>
      )}
      {table.kind !== "general" && (
        <>
          <Field label="Sort by">
            <select value={table.sort?.[0]?.column ?? ""} onChange={(e) => set({ sort: e.target.value ? [{ column: e.target.value, ...(table.sort?.[0]?.descending ? { descending: true } : {}) }] : null })} data-testid="prop-table-sort">
              <option value="">the usual order</option>
              {shown.map((k) => (
                <option key={k} value={k}>
                  {catalogue.find((c) => c.key === k)?.header ?? k}
                </option>
              ))}
            </select>
          </Field>
          {table.sort?.length ? (
            <Field label="Descending">
              <input type="checkbox" checked={!!table.sort[0].descending} onChange={(e) => set({ sort: [{ column: table.sort![0].column, ...(e.target.checked ? { descending: true } : {}) }] })} data-testid="prop-table-desc" />
            </Field>
          ) : null}
          <Field label="Group by">
            <select value={table.group ?? ""} onChange={(e) => set({ group: e.target.value || null })} data-testid="prop-table-group">
              <option value="">no groups</option>
              {shown.map((k) => (
                <option key={k} value={k}>
                  {catalogue.find((c) => c.key === k)?.header ?? k}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
      <Field label="Rows per block" hint="More rows continue in a block beside it, with the header again">
        <TextField value={table.maxRows ? String(table.maxRows) : ""} placeholder="all in one" onCommit={(v) => set({ maxRows: v ? Math.max(1, Math.round(Number(v))) || null : null })} testId="prop-table-max-rows" />
      </Field>
      {table.maxRows ? (
        <Field label="Split to the">
          <select value={table.split ?? ""} onChange={(e) => set({ split: e.target.value || null })} data-testid="prop-table-split">
            <option value="">automatic</option>
            <option value="left">left</option>
            <option value="right">right</option>
          </select>
        </Field>
      ) : null}
      <Field label="Headings">
        <select value={table.headerAt ?? "top"} onChange={(e) => set({ headerAt: e.target.value === "top" ? null : e.target.value })} data-testid="prop-table-header-at">
          <option value="top">at the top</option>
          <option value="bottom">at the bottom (rows grow up)</option>
        </select>
      </Field>
      {(table.kind === "cutList" || table.kind === "bom") && (
        <Field label="Totals row">
          <input type="checkbox" checked={table.totals !== false} onChange={(e) => set({ totals: e.target.checked ? null : false })} data-testid="prop-table-totals" />
        </Field>
      )}
      <Field label="Footer">
        <TextField value={table.footer ?? ""} placeholder="ALL LENGTHS IN mm" onCommit={(v) => set({ footer: v || null })} testId="prop-table-footer" />
      </Field>
      <Field label="Place">
        <select value={anchor} onChange={(e) => set({ anchor: e.target.value === "" ? null : e.target.value === "free" ? table.anchor : { corner: e.target.value } })} data-testid="prop-table-anchor">
          <option value="">its usual corner</option>
          {TABLE_CORNERS.map((c) => (
            <option key={c} value={c}>
              {CORNER_LABEL[c]}
            </option>
          ))}
          {anchor === "free" && <option value="free">where it was dragged</option>}
        </select>
      </Field>
      {table.kind === "holes" && (
        <>
          <Field label="View">
            <select value={table.view ?? ""} onChange={(e) => set({ view: e.target.value || null })} data-testid="prop-table-view">
              {ws.sheetDoc!.views.map((v) => (
                <option key={v.id}>{v.id}</option>
              ))}
            </select>
          </Field>
          <Field label="Origin">
            <select value={table.origin ?? "@lowerLeft"} onChange={(e) => set({ origin: e.target.value === "@lowerLeft" ? null : e.target.value })} data-testid="prop-table-origin">
              {["@lowerLeft", "@upperLeft", "@lowerRight", "@upperRight"].map((o) => (
                <option key={o} value={o}>
                  {o.slice(1).replace(/([A-Z])/g, " $1").toLowerCase()} corner
                </option>
              ))}
              {table.origin && !table.origin.startsWith("@") && <option value={table.origin}>{table.origin}</option>}
            </select>
          </Field>
        </>
      )}
      <div className="drawing-buttons">
        {table.kind === "general" && (
          <button onClick={() => ws.setDialog({ name: "table", arg: `edit:${table.id}` })} data-testid="prop-table-edit">
            Edit cells…
          </button>
        )}
        <button className="danger" onClick={() => ws.deleteIds([table.id])} data-testid="prop-table-delete">
          Delete table
        </button>
      </div>
      {p.sheet?.problems.some((x) => x.startsWith(`${table.id}:`)) && <p className="bad small">{p.sheet.problems.filter((x) => x.startsWith(`${table.id}:`)).join("; ")}</p>}
    </div>
  );
}

/** The columns a table shows when it names none: its kind's standard ones (the catalogue's). */
export function defaultColumns(t: Pick<DrawingTable, "kind">): string[] {
  return [...(DEFAULT_COLUMNS[t.kind] ?? [])];
}

function swap<T>(list: T[], i: number, j: number): T[] {
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

// ------------------------------------------------------------ the sheet

function SheetPanel({ ws }: { ws: Workspace }) {
  const { p } = ws;
  const here = ws.sheetDoc!;
  const drawing = p.drawing!;
  const f = here.format;
  const set = (patch: Record<string, unknown>) => ws.run({ type: "setSheet", patch, sheet: here.id });
  const text = (key: "title" | "subtitle" | "number" | "revision" | "drawnBy" | "date" | "checkedBy" | "approvedBy" | "company" | "material" | "finish", label: string) => (
    <Field label={label} key={key}>
      <TextField value={f[key] ?? ""} onCommit={(v) => set({ [key]: v || null })} testId={`sheet-${key}`} />
    </Field>
  );
  return (
    <div data-testid="sheet-props">
      <div className="prop-header">
        <span className="prop-icon" aria-hidden="true">
          <Icon name="drawing" size={18} />
        </span>
        <h3>Sheet</h3>
        <span className="muted">{p.sheet?.name ?? here.id}</span>
      </div>
      <Field label="Size">
        <select value={f.size} onChange={(e) => set({ size: e.target.value })} data-testid="sheet-size">
          {Object.keys(SHEET_SIZES).map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Orientation">
        <select value={f.orientation ?? "landscape"} onChange={(e) => set({ orientation: e.target.value === "landscape" ? null : e.target.value })} data-testid="sheet-orientation">
          <option value="landscape">landscape</option>
          <option value="portrait">portrait</option>
        </select>
      </Field>
      <Field label="Template">
        <select value={f.template ?? (drawing.standard === "ASME" ? "ansi" : "iso")} onChange={(e) => set({ template: e.target.value })} data-testid="sheet-template">
          {SHEET_TEMPLATES.map((t) => (
            <option key={t} value={t}>
              {t === "iso" ? "ISO (zones, ISO 7200 block)" : t === "ansi" ? "ANSI (zones, tolerance block)" : t === "minimal" ? "minimal" : "classic (Phase L)"}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Scale">
        <ScaleSelect value={here.scale} auto={`what fits (${p.sheet?.scaleText ?? "…"})`} onChange={(scale) => set({ scale: scale ?? null })} testId="sheet-scale" />
      </Field>
      <Field label="Projection">
        <select value={here.projection} onChange={(e) => set({ projection: e.target.value })} data-testid="sheet-projection">
          <option value="third">third angle</option>
          <option value="first">first angle</option>
        </select>
      </Field>
      <h4 className="prop-sub">Title block</h4>
      {text("title", "Title")}
      {text("subtitle", "Subtitle")}
      {text("number", "Drawing no.")}
      {text("revision", "Revision")}
      {text("drawnBy", "Drawn by")}
      {text("date", "Date")}
      {text("checkedBy", "Checked by")}
      {text("approvedBy", "Approved by")}
      {text("company", "Company")}
      {text("finish", "Finish")}
      <Field label="General tolerance">
        <TextField value={drawing.generalTolerance ?? ""} placeholder="ISO 2768-mK" onCommit={(v) => ws.run({ type: "setDrawingOptions", patch: { generalTolerance: v || null } })} testId="drawing-tolerance" />
      </Field>
      <Field label="Standard">
        <select value={drawing.standard ?? "ISO"} onChange={(e) => ws.run({ type: "setDrawingOptions", patch: { standard: e.target.value } })} data-testid="drawing-standard">
          <option value="ISO">ISO</option>
          <option value="ASME">ASME</option>
        </select>
      </Field>
      <div className="drawing-buttons wrap">
        <button onClick={() => ws.setDialog({ name: "titleBlock" })} data-testid="sheet-title-block">
          Title block…
        </button>
        <button onClick={() => ws.setDialog({ name: "properties" })} data-testid="sheet-drawing-props">
          Drawing properties…
        </button>
        {drawing.sheets.length > 1 && (
          <button
            className="danger"
            onClick={() => {
              if (!ws.run({ type: "deleteSheet", id: here.id })) p.setActiveSheet(null);
            }}
            data-testid="sheet-delete"
          >
            Delete sheet
          </button>
        )}
      </div>
    </div>
  );
}
