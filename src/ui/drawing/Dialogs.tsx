// The drawing workspace's dialogs (Phase Q wave Q2B): insert a table (its
// kind, its columns from the catalogue and custom property columns, where it
// goes) and edit a general table's cells; the sheet's format; the title
// block, each field with the property links it holds and what it reads; the
// drawing's properties (standard, units, general tolerance, custom
// properties, the revisions the revision table lists); and print preview
// with export (PDF, SVG, DXF, PNG; colour or black and white).

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Command } from "../../doc/commands";
import { safeFileName } from "../../doc/properties";
import { SHEET_SIZES, SHEET_TEMPLATES, TITLE_FIELDS, type Revision, type TitleField } from "../../doc/types";
import { validateDocument } from "../../doc/validate";
import { fmt, type ComposedSheet } from "../../drafting/compose";
import { sheetDXF } from "../../drafting/dxf";
import { drawingPDF } from "../../drafting/pdf";
import { propLinks, resolveProps, type PropContext } from "../../drafting/props";
import { sheetSVG } from "../../drafting/svg";
import { DEFAULT_COLUMNS, DEFAULT_CORNERS, TABLE_COLUMNS, TABLE_CORNERS, type DrawingTable, type TableKind } from "../../drafting/tables";
import { Icon } from "../icons";
import { ScaleSelect } from "./Panels";
import { pdfFonts, sheetPNG } from "./SheetView";
import type { Workspace } from "./Workspace";

function Dialog({ title, onClose, children, wide, testId }: { title: string; onClose(): void; children: ReactNode; wide?: boolean; testId: string }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal drawing-dialog${wide ? " wide" : ""}`} role="dialog" aria-label={title} data-testid={testId}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button className="icon-only" aria-label="Close" onClick={onClose} data-testid={`${testId}-close`}>
            <Icon name="x" size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<TableKind, string> = { cutList: "Cut list", bom: "Bill of materials", holes: "Hole table", welds: "Weld table", revisions: "Revision table", general: "General table", stock: "Cutting plan" };
const CORNER_LABEL: Record<(typeof TABLE_CORNERS)[number], string> = { topLeft: "top left", topRight: "top right", bottomLeft: "bottom left", bottomRight: "bottom right", aboveTitleBlock: "above the title block", leftOfTitleBlock: "left of the title block" };

// ------------------------------------------------------------ tables

export function TableDialog({ ws, arg, onClose }: { ws: Workspace; arg?: string; onClose(): void }) {
  if (arg?.startsWith("edit:")) return <TableCells ws={ws} id={arg.slice(5)} onClose={onClose} />;
  return <InsertTable ws={ws} kind={(arg as TableKind) ?? "general"} onClose={onClose} />;
}

function InsertTable({ ws, kind: first, onClose }: { ws: Workspace; kind: TableKind; onClose(): void }) {
  const sheetDoc = ws.sheetDoc!;
  const [kind, setKind] = useState<TableKind>(first);
  const [columns, setColumns] = useState<string[]>(DEFAULT_COLUMNS[first] ?? []);
  const [props, setProps] = useState("");
  const [corner, setCorner] = useState<string>("");
  const selectedView = ws.selection.find((id) => sheetDoc.views.some((v) => v.id === id));
  const [view, setView] = useState(selectedView ?? sheetDoc.views.find((v) => v.look === "top" || v.look === "front")?.id ?? sheetDoc.views[0]?.id ?? "");
  const [origin, setOrigin] = useState("@lowerLeft");
  const [size, setSize] = useState<[number, number]>([3, 3]);
  const pick = (k: TableKind) => {
    setKind(k);
    setColumns(DEFAULT_COLUMNS[k] ?? []);
  };
  const insert = () => {
    const id = ws.ctx().nextId(kind === "holes" ? "holes_" : kind === "general" ? "table_" : `${kind}_`);
    const custom = props
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((n) => `prop:${n}`);
    const table: Record<string, unknown> = { kind };
    const cols = [...columns, ...custom];
    if (kind !== "general" && JSON.stringify(cols) !== JSON.stringify(DEFAULT_COLUMNS[kind])) table.columns = cols;
    if (corner) table.anchor = { corner };
    if (kind === "holes") {
      table.view = view;
      if (origin !== "@lowerLeft") table.origin = origin;
    }
    if (kind === "general") {
      table.header = Array.from({ length: size[0] }, (_, i) => String.fromCharCode(65 + i));
      table.rows = Array.from({ length: size[1] }, () => Array.from({ length: size[0] }, () => ""));
    }
    const cmd: Command = { type: "setTable", id, table, sheet: sheetDoc.id };
    if (!ws.run(cmd)) {
      ws.setSelection([id]);
      onClose();
      if (kind === "general") ws.setDialog({ name: "table", arg: `edit:${id}` });
    }
  };
  const catalogue = TABLE_COLUMNS[kind] ?? [];
  return (
    <Dialog title="Insert a table" onClose={onClose} testId="table-dialog">
      <div className="segmented wrap" role="radiogroup" aria-label="Kind of table">
        {(["cutList", "bom", "holes", "welds", "revisions", "general"] as TableKind[]).map((k) => (
          <button key={k} role="radio" aria-checked={k === kind} className={k === kind ? "on" : ""} onClick={() => pick(k)} data-testid={`table-kind-${k}`}>
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      {kind === "holes" && (
        <>
          <label className="field">
            <span className="field-label">View</span>
            <select value={view} onChange={(e) => setView(e.target.value)} data-testid="table-view">
              {sheetDoc.views.map((v) => (
                <option key={v.id}>{v.id}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">X and Y from</span>
            <select value={origin} onChange={(e) => setOrigin(e.target.value)} data-testid="table-origin">
              {["@lowerLeft", "@upperLeft", "@lowerRight", "@upperRight"].map((o) => (
                <option key={o} value={o}>
                  the outline's {o.slice(1).replace(/([A-Z])/g, " $1").toLowerCase()} corner
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {kind === "general" ? (
        <label className="field">
          <span className="field-label">Columns × rows</span>
          <span className="pair">
            <input type="number" min={1} max={12} value={size[0]} onChange={(e) => setSize([Math.max(1, Math.min(12, Number(e.target.value) || 1)), size[1]])} data-testid="table-cols" />
            <input type="number" min={1} max={60} value={size[1]} onChange={(e) => setSize([size[0], Math.max(1, Math.min(60, Number(e.target.value) || 1))])} data-testid="table-rows" />
          </span>
        </label>
      ) : (
        <fieldset className="prop-group">
          <legend>Columns</legend>
          <div className="column-grid">
            {catalogue.map((c) => (
              <label key={c.key} title={c.help}>
                <input type="checkbox" checked={columns.includes(c.key)} onChange={(e) => setColumns(e.target.checked ? [...columns, c.key] : columns.filter((x) => x !== c.key))} data-testid={`table-col-${c.key}`} />
                {c.header}
              </label>
            ))}
          </div>
          {(kind === "cutList" || kind === "bom") && (
            <label className="field">
              <span className="field-label">Custom properties</span>
              <input value={props} onChange={(e) => setProps(e.target.value)} placeholder="Coating, Supplier" data-testid="table-props" />
            </label>
          )}
        </fieldset>
      )}
      <label className="field">
        <span className="field-label">Place</span>
        <select value={corner} onChange={(e) => setCorner(e.target.value)} data-testid="table-corner">
          <option value="">{CORNER_LABEL[DEFAULT_CORNERS[kind]]} (usual)</option>
          {TABLE_CORNERS.map((c) => (
            <option key={c} value={c}>
              {CORNER_LABEL[c]}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">Drag the table on the sheet to place it anywhere; its panel changes columns, sort, groups and splits.</p>
      <div className="modal-buttons">
        <span className="sep" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={insert} disabled={kind === "holes" && !view} data-testid="table-insert">
          Insert
        </button>
      </div>
    </Dialog>
  );
}

/** A general table's cells, typed in place: Tab and Enter move on; rows and columns added and taken away. */
function TableCells({ ws, id, onClose }: { ws: Workspace; id: string; onClose(): void }) {
  const t = ws.p.drawing!.sheets.flatMap((s) => s.tables ?? []).find((x) => x.id === id) as DrawingTable | undefined;
  const [header, setHeader] = useState<string[]>(t?.header ?? ["A"]);
  const [rows, setRows] = useState<string[][]>(t?.rows ?? [[""]]);
  if (!t) return null;
  if (t.kind !== "general") {
    return (
      <Dialog title={`Table ${id}`} onClose={onClose} testId="table-cells">
        <p>The {KIND_LABEL[t.kind].toLowerCase()} is read from the part: change what it lists in the part (or its columns in the table's panel).</p>
        <div className="modal-buttons">
          <span className="sep" />
          <button className="primary" onClick={onClose}>
            OK
          </button>
        </div>
      </Dialog>
    );
  }
  const n = header.length;
  const save = () => {
    const { id: _id, ...rest } = t;
    void _id;
    if (!ws.run({ type: "setTable", id, table: { ...rest, header, rows } })) onClose();
  };
  const cell = (r: number, c: number, v: string) => setRows(rows.map((row, i) => (i === r ? row.map((x, j) => (j === c ? v : x)) : row)));
  return (
    <Dialog title={`Table ${id}`} onClose={onClose} wide testId="table-cells">
      <div className="cells-scroll">
        <table className="cells">
          <thead>
            <tr>
              {header.map((h, c) => (
                <th key={c}>
                  <input value={h} onChange={(e) => setHeader(header.map((x, j) => (j === c ? e.target.value : x)))} aria-label={`Heading ${c + 1}`} data-testid={`cell-h-${c}`} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {Array.from({ length: n }, (_, c) => (
                  <td key={c}>
                    <input value={row[c] ?? ""} onChange={(e) => cell(r, c, e.target.value)} aria-label={`Row ${r + 1}, column ${c + 1}`} data-testid={`cell-${r}-${c}`} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="modal-buttons">
        <button onClick={() => setRows([...rows, Array.from({ length: n }, () => "")])} data-testid="cells-add-row">
          + Row
        </button>
        <button disabled={rows.length < 2} onClick={() => setRows(rows.slice(0, -1))}>
          − Row
        </button>
        <button
          onClick={() => {
            setHeader([...header, String.fromCharCode(65 + n)]);
            setRows(rows.map((r) => [...r, ""]));
          }}
          data-testid="cells-add-col"
        >
          + Column
        </button>
        <button
          disabled={n < 2}
          onClick={() => {
            setHeader(header.slice(0, -1));
            setRows(rows.map((r) => r.slice(0, -1)));
          }}
        >
          − Column
        </button>
        <span className="sep" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={save} data-testid="cells-save">
          OK
        </button>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------ sheet format

export function FormatDialog({ ws, focus, onClose }: { ws: Workspace; focus?: string; onClose(): void }) {
  const here = ws.sheetDoc!;
  const f = here.format;
  const drawing = ws.p.drawing!;
  const set = (patch: Record<string, unknown>) => ws.run({ type: "setSheet", patch, sheet: here.id });
  return (
    <Dialog title={`Sheet format: ${ws.p.sheet?.name ?? here.id}`} onClose={onClose} testId="format-dialog">
      <div className="template-grid" role="radiogroup" aria-label="Template">
        {SHEET_TEMPLATES.map((t) => {
          const on = (f.template ?? (drawing.standard === "ASME" ? "ansi" : "iso")) === t;
          return (
            <button key={t} role="radio" aria-checked={on} className={`template${on ? " on" : ""}`} onClick={() => set({ template: t })} data-testid={`format-template-${t}`}>
              <TemplatePicture t={t} />
              <span>{t === "iso" ? "ISO 7200" : t === "ansi" ? "ANSI / ASME" : t === "minimal" ? "Minimal" : "Classic"}</span>
            </button>
          );
        })}
      </div>
      <label className="field">
        <span className="field-label">Size</span>
        <select value={f.size} onChange={(e) => set({ size: e.target.value })} data-testid="format-size">
          {Object.entries(SHEET_SIZES).map(([k, [w, h]]) => (
            <option key={k} value={k}>
              {k} ({w} × {h} mm)
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Orientation</span>
        <select value={f.orientation ?? "landscape"} onChange={(e) => set({ orientation: e.target.value === "landscape" ? null : e.target.value })} data-testid="format-orientation">
          <option value="landscape">landscape</option>
          <option value="portrait">portrait</option>
        </select>
      </label>
      <label className="field">
        <span className="field-label">Sheet scale</span>
        <ScaleSelect value={here.scale} auto={`what fits (${ws.p.sheet?.scaleText ?? "…"})`} onChange={(scale) => set({ scale: scale ?? null })} testId="format-scale" />
      </label>
      {focus === "scale" && <p className="muted small">Every view takes the sheet's scale unless it has its own (a detail is twice its parent's).</p>}
      <label className="field">
        <span className="field-label">Projection</span>
        <select value={here.projection} onChange={(e) => set({ projection: e.target.value })} data-testid="format-projection">
          <option value="third">third angle (ASME)</option>
          <option value="first">first angle (ISO)</option>
        </select>
      </label>
      <div className="modal-buttons">
        <button onClick={() => ws.setDialog({ name: "titleBlock" })}>Title block…</button>
        <span className="sep" />
        <button className="primary" onClick={onClose} data-testid="format-done">
          Done
        </button>
      </div>
    </Dialog>
  );
}

function TemplatePicture({ t }: { t: string }) {
  return (
    <svg viewBox="0 0 42 30" className="template-pic" aria-hidden="true">
      <rect x="0.5" y="0.5" width="41" height="29" fill="#fff" stroke="currentColor" strokeWidth="0.6" />
      <rect x={t === "classic" ? 3 : 2.5} y="2.5" width={t === "classic" ? 37.5 : 37} height="25" fill="none" stroke="currentColor" strokeWidth="0.9" />
      {t === "iso" || t === "ansi" ? <path d="M2.5 9.5h-1.5M2.5 16h-1.5M2.5 22.5h-1.5M12 2.5v-1.5M22 2.5v-1.5M32 2.5v-1.5" stroke="currentColor" strokeWidth="0.4" /> : null}
      {t === "minimal" ? <rect x="20" y="24" width="19.5" height="3.5" fill="none" stroke="currentColor" strokeWidth="0.5" /> : <rect x={t === "ansi" ? 19 : 21} y={t === "ansi" ? 19.5 : 21} width={t === "ansi" ? 20.5 : 18.5} height={t === "ansi" ? 8 : 6.5} fill="none" stroke="currentColor" strokeWidth="0.5" />}
      {t === "ansi" && <rect x="27" y="2.5" width="12.5" height="5" fill="none" stroke="currentColor" strokeWidth="0.4" />}
    </svg>
  );
}

// ------------------------------------------------------------ title block

const FIELD_LABEL: Record<TitleField, string> = {
  title: "Title",
  subtitle: "Subtitle",
  number: "Drawing no.",
  revision: "Revision",
  drawnBy: "Drawn by",
  date: "Date",
  checkedBy: "Checked by",
  checkedDate: "Checked on",
  approvedBy: "Approved by",
  approvedDate: "Approved on",
  company: "Company",
  material: "Material",
  finish: "Finish",
  mass: "Mass",
};

/** What a sheet's links read: the same context the composer uses. */
export function propContext(ws: Workspace): PropContext {
  const doc = ws.p.doc!;
  const v = validateDocument(doc);
  const m = ws.p.measurements;
  const part: Record<string, string> = {};
  for (const [k, val] of Object.entries(v.properties as Record<string, unknown>)) {
    if (typeof val === "string") part[k] = val;
    else if (k === "custom" && val && typeof val === "object") for (const [ck, cv] of Object.entries(val as Record<string, unknown>)) if (typeof cv === "string") part[ck] = cv;
  }
  const s = ws.p.sheet;
  return {
    drawing: ws.p.drawing?.properties ?? {},
    part,
    model: { name: v.name, material: m?.mass.material ?? v.material?.name ?? "steel", ...(m ? { mass: `${m.mass.kg.toFixed(2)} kg`, volume: `${fmt(m.volume / 1000)} cm³` } : {}) },
    sheet: { sheet: String(s?.number ?? 1), sheets: String(s?.count ?? 1), size: s?.size ?? "", name: s?.name ?? "", scale: s?.scaleText ?? "" },
  };
}

const LINK_CHOICES = ['$PRP:"partNumber"', '$PRP:"description"', '$PRP:"revision"', '$PRP:"author"', '$PRP:"finish"', '$PRPMODEL:"material"', '$PRPMODEL:"mass"', '$PRPMODEL:"name"', '$PRPSHEET:"scale"', '$PRPSHEET:"sheet"'];

export function TitleBlockDialog({ ws, focus, onClose }: { ws: Workspace; focus?: string; onClose(): void }) {
  const here = ws.sheetDoc!;
  const f = here.format as Record<string, string | undefined>;
  const ctx = useMemo(() => propContext(ws), [ws]);
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(TITLE_FIELDS.map((k) => [k, f[k] ?? ""])));
  // The field double-clicked, by its text when it is a template default.
  const focused = focus && (TITLE_FIELDS as readonly string[]).includes(focus) ? focus : focus?.startsWith("text:") ? TITLE_FIELDS.find((k) => shownText(ws, k, ctx) === focus.slice(5)) : undefined;
  const save = () => {
    const patch: Record<string, unknown> = {};
    for (const k of TITLE_FIELDS) if ((draft[k] ?? "") !== (f[k] ?? "")) patch[k] = draft[k].trim() === "" ? null : draft[k];
    if (Object.keys(patch).length && ws.run({ type: "setSheet", patch, sheet: here.id })) return;
    onClose();
  };
  return (
    <Dialog title="Title block" onClose={onClose} wide testId="title-block-dialog">
      <p className="muted small">A field may hold links: {'$PRP:"name"'} a drawing or part property, {'$PRPMODEL:"mass"'} measured on the part, {'$PRPSHEET:"scale"'} the sheet's. Empty fields show the template's default.</p>
      <datalist id="prop-links">
        {LINK_CHOICES.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
      <div className="title-fields">
        {TITLE_FIELDS.map((k) => {
          const raw = draft[k] ?? "";
          const links = propLinks(raw);
          const reads = raw ? resolveProps(raw, ctx) : shownText(ws, k, ctx);
          return (
            <div key={k} className={`title-field${focused === k ? " focus" : ""}`}>
              <label htmlFor={`tb-${k}`}>{FIELD_LABEL[k]}</label>
              <input id={`tb-${k}`} value={raw} list="prop-links" autoFocus={focused === k} placeholder={shownText(ws, k, ctx) ? `default: ${shownText(ws, k, ctx)}` : "empty"} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} onKeyDown={(e) => e.key === "Enter" && save()} data-testid={`tb-${k}`} />
              <span className="reads" data-testid={`tb-${k}-reads`}>
                {links.length > 0 && <Icon name="link" size={12} />}
                {reads || "—"}
              </span>
            </div>
          );
        })}
      </div>
      <div className="modal-buttons">
        <button onClick={() => ws.setDialog({ name: "properties" })}>Drawing properties…</button>
        <span className="sep" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={save} data-testid="tb-save">
          OK
        </button>
      </div>
    </Dialog>
  );
}

/** What a field shows on the sheet now (the template's default when the sheet sets none). */
function shownText(ws: Workspace, k: TitleField, ctx: PropContext): string {
  const set = (ws.sheetDoc!.format as Record<string, string | undefined>)[k];
  if (set !== undefined) return resolveProps(set, ctx);
  const p = ctx;
  const latest = ws.p.drawing?.revisions?.at(-1)?.rev;
  const d: Partial<Record<TitleField, string>> = {
    title: p.part.description || p.model.name || "",
    number: p.drawing.number ?? p.part.partNumber ?? "",
    revision: latest ?? p.part.revision ?? "",
    drawnBy: p.part.author ?? "",
    material: p.model.material ?? "",
    mass: p.model.mass ?? "",
    finish: p.part.finish ?? "",
    company: p.drawing.company ?? p.part.company ?? "",
  };
  return d[k] ?? "";
}

// ------------------------------------------------------------ drawing properties

const TOLERANCES = ["ISO 2768-fH", "ISO 2768-mK", "ISO 2768-cL", "ISO 2768-vL", "ISO 13920-BF", "X.X ±0.5, X.XX ±0.1, ANG ±0.5°"];

export function PropertiesDialog({ ws, focus, onClose }: { ws: Workspace; focus?: string; onClose(): void }) {
  const d = ws.p.drawing!;
  const [standard, setStandard] = useState(d.standard ?? "ISO");
  const [units, setUnits] = useState(d.units ?? "mm");
  const [tol, setTol] = useState(d.generalTolerance ?? "");
  const [props, setProps] = useState<[string, string][]>(Object.entries(d.properties ?? {}));
  const [revs, setRevs] = useState<Revision[]>(d.revisions ?? []);
  const save = () => {
    const cleanProps = Object.fromEntries(props.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]));
    const cleanRevs = revs.filter((r) => r.rev.trim()).map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => typeof v === "string" && v.trim() !== "")) as unknown as Revision);
    const patch: Record<string, unknown> = {
      standard,
      units: units === "mm" ? null : units,
      generalTolerance: tol.trim() || null,
      properties: Object.keys(cleanProps).length ? cleanProps : null,
      revisions: cleanRevs.length ? cleanRevs : null,
    };
    if (!ws.run({ type: "setDrawingOptions", patch })) onClose();
  };
  const today = new Date().toISOString().slice(0, 10);
  const nextRev = () => {
    const last = revs.at(-1)?.rev;
    if (!last) return "A";
    if (/^\d+$/.test(last)) return String(Number(last) + 1).padStart(last.length, "0");
    return String.fromCharCode(last.charCodeAt(last.length - 1) + 1);
  };
  return (
    <Dialog title="Drawing properties" onClose={onClose} wide testId="properties-dialog">
      <div className="props-grid">
        <label className="field">
          <span className="field-label">Standard</span>
          <select value={standard} autoFocus={focus === "standard"} onChange={(e) => setStandard(e.target.value as "ISO" | "ASME")} data-testid="dp-standard">
            <option value="ISO">ISO (filled arrows, ISO 3098 text, first angle by default)</option>
            <option value="ASME">ASME Y14.5 (third angle by default)</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Units</span>
          <select value={units} onChange={(e) => setUnits(e.target.value as "mm" | "in")} data-testid="dp-units">
            <option value="mm">millimetres</option>
            <option value="in">inches</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">General tolerance</span>
          <input value={tol} list="dp-tols" onChange={(e) => setTol(e.target.value)} placeholder="ISO 2768-mK" data-testid="dp-tolerance" />
          <datalist id="dp-tols">
            {TOLERANCES.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
      </div>
      <h3 className="modal-section">Custom properties</h3>
      <p className="muted small">Title-block fields and notes read them as {'$PRP:"name"'}.</p>
      <div className="kv-list">
        {props.map(([k, v], i) => (
          <div key={i} className="kv-row">
            <input value={k} placeholder="name" onChange={(e) => setProps(props.map((p, j) => (j === i ? [e.target.value, p[1]] : p)))} data-testid={`dp-prop-name-${i}`} />
            <input value={v} placeholder="value" onChange={(e) => setProps(props.map((p, j) => (j === i ? [p[0], e.target.value] : p)))} data-testid={`dp-prop-value-${i}`} />
            <button className="icon-only" aria-label={`Remove ${k || "property"}`} onClick={() => setProps(props.filter((_, j) => j !== i))}>
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
        <button onClick={() => setProps([...props, ["", ""]])} data-testid="dp-prop-add">
          + Property
        </button>
      </div>
      <h3 className="modal-section">Revisions</h3>
      <p className="muted small">Newest last: the title block's revision and the revision table read them.</p>
      <table className="cells revs">
        <thead>
          <tr>
            <th>Rev</th>
            <th>Description</th>
            <th>Zone</th>
            <th>Date</th>
            <th>By</th>
            <th>Approved</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {revs.map((r, i) => (
            <tr key={i}>
              {(["rev", "description", "zone", "date", "by", "approved"] as const).map((k) => (
                <td key={k}>
                  <input value={r[k] ?? ""} onChange={(e) => setRevs(revs.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))} aria-label={`${k} of revision ${i + 1}`} data-testid={`dp-rev-${i}-${k}`} />
                </td>
              ))}
              <td>
                <button className="icon-only" aria-label={`Remove revision ${r.rev}`} onClick={() => setRevs(revs.filter((_, j) => j !== i))}>
                  <Icon name="trash" size={14} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={() => setRevs([...revs, { rev: nextRev(), description: revs.length ? "" : "First issue", date: today }])} data-testid="dp-rev-add">
        + Revision
      </button>
      <div className="modal-buttons">
        <span className="sep" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={save} data-testid="dp-save">
          OK
        </button>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------ print preview and export

export interface ExportOptions {
  /** PDF: every sheet (default) or the one shown. */
  sheets?: "all" | "current";
  /** PNG: dots per inch (default 200). */
  dpi?: number;
  dxfVersion?: "R2000" | "R12";
  /** Black lines and text only: warnings and colours drawn black. */
  mono?: boolean;
}

/** The sheet in black and white: every colour dropped (shaded faces kept grey). */
export function monoSheet(s: ComposedSheet): ComposedSheet {
  return { ...s, prims: s.prims.map((p) => (p.k === "area" ? p : "color" in p && p.color ? { ...p, color: undefined } : p)) };
}

/** Writes the export asked for and downloads it; the file's name, or the error. */
export async function exportSheets(kind: "pdf" | "svg" | "dxf" | "png", all: ComposedSheet[], current: ComposedSheet, opts: ExportOptions, meta: { base: string; title: string }, download: (name: string, data: string | Uint8Array, type: string) => void): Promise<string> {
  const look = (s: ComposedSheet) => (opts.mono ? monoSheet(s) : s);
  const pages = kind === "pdf" && opts.sheets !== "current" ? all : [current];
  const many = all.length > 1 && (kind !== "pdf" || opts.sheets === "current");
  const name = `${meta.base}-drawing${many ? `-${safeFileName(current.name)}` : ""}.${kind}`;
  if (kind === "pdf") download(name, drawingPDF(pages.map(look), { title: meta.title, ...(await pdfFonts().then((f) => (f ? { fonts: f } : {}))) }), "application/pdf");
  else if (kind === "svg") download(name, sheetSVG(look(current)), "image/svg+xml");
  else if (kind === "dxf") download(name, sheetDXF(look(current), { version: opts.dxfVersion ?? "R2000" }), "application/dxf");
  else download(name, await sheetPNG(look(current), opts.dpi ?? 200), "image/png");
  return name;
}

export function ExportDialog({ ws, onClose }: { ws: Workspace; onClose(): void }) {
  const sheets = ws.p.sheets;
  const [kind, setKind] = useState<"pdf" | "svg" | "dxf" | "png">("pdf");
  const [mono, setMono] = useState(false);
  const [scope, setScope] = useState<"all" | "current">("all");
  const [dpi, setDpi] = useState(200);
  const [dxf, setDxf] = useState<"R2000" | "R12">("R2000");
  const [page, setPage] = useState(ws.p.sheet?.id ?? sheets[0]?.id);
  const [weights, setWeights] = useState(false);
  const shown = sheets.find((s) => s.id === page) ?? sheets[0];
  const preview = useMemo(() => (shown ? sheetSVG(mono ? monoSheet(shown) : shown, { fit: true }) : ""), [shown, mono]);
  const go = () => {
    ws.p.exportDrawing(kind, { sheets: scope, dpi, dxfVersion: dxf, mono });
    onClose();
  };
  return (
    <Dialog title="Print preview and export" onClose={onClose} wide testId="export-dialog">
      <div className="export-body">
        <div className="export-preview">
          <div className={`export-page${weights ? " weights" : ""}`} style={{ aspectRatio: shown ? `${shown.width} / ${shown.height}` : undefined }} dangerouslySetInnerHTML={{ __html: preview }} data-testid="export-preview" />
          <div className="export-pages" role="listbox" aria-label="Pages">
            {sheets.map((s) => (
              <button key={s.id} role="option" aria-selected={s.id === shown?.id} className={s.id === shown?.id ? "on" : ""} onClick={() => setPage(s.id)} data-testid={`export-page-${s.id}`}>
                <span className="page-no">{s.number}</span> {s.name} · {s.size}
              </button>
            ))}
          </div>
        </div>
        <div className="export-options">
          <div className="segmented" role="radiogroup" aria-label="Format">
            {(["pdf", "svg", "dxf", "png"] as const).map((k) => (
              <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? "on" : ""} onClick={() => setKind(k)} data-testid={`export-format-${k}`}>
                {k.toUpperCase()}
              </button>
            ))}
          </div>
          <p className="muted small">
            {kind === "pdf" ? "Vector PDF, a page per sheet at its paper size, the font embedded." : kind === "svg" ? "The sheet shown as SVG, in millimetres." : kind === "dxf" ? "The sheet shown as DXF, a layer per kind of line (visible, hidden, centre, hatch, dimension…)." : "The sheet shown as a picture."}
          </p>
          {kind === "pdf" && sheets.length > 1 && (
            <label className="field">
              <span className="field-label">Sheets</span>
              <select value={scope} onChange={(e) => setScope(e.target.value as "all" | "current")} data-testid="export-scope">
                <option value="all">all {sheets.length}</option>
                <option value="current">the one shown</option>
              </select>
            </label>
          )}
          {kind === "png" && (
            <label className="field">
              <span className="field-label">Resolution</span>
              <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))} data-testid="export-dpi">
                {[100, 200, 300, 600].map((d) => (
                  <option key={d} value={d}>
                    {d} dpi
                  </option>
                ))}
              </select>
            </label>
          )}
          {kind === "dxf" && (
            <label className="field">
              <span className="field-label">Version</span>
              <select value={dxf} onChange={(e) => setDxf(e.target.value as "R2000" | "R12")} data-testid="export-dxf-version">
                <option value="R2000">R2000 (AC1015)</option>
                <option value="R12">R12 (oldest readers)</option>
              </select>
            </label>
          )}
          <label className="field">
            <span className="field-label">Colour</span>
            <select value={mono ? "mono" : "colour"} onChange={(e) => setMono(e.target.value === "mono")} data-testid="export-colour">
              <option value="colour">colour (warnings in red)</option>
              <option value="mono">black and white</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Line weights</span>
            <input type="checkbox" checked={weights} onChange={(e) => setWeights(e.target.checked)} data-testid="export-weights" />
          </label>
          <div className="weights-legend" aria-label="Line weights">
            {[
              ["0.5", "visible edges"],
              ["0.35", "section, borders"],
              ["0.25", "hidden, text"],
              ["0.18", "dimensions, hatch, centre"],
            ].map(([w, what]) => (
              <span key={w}>
                <svg width="38" height="8" aria-hidden="true">
                  <line x1="2" x2="36" y1="4" y2="4" stroke="currentColor" strokeWidth={Number(w) * 4} />
                </svg>
                {w} mm {what}
              </span>
            ))}
          </div>
          <div className="modal-buttons">
            <button onClick={() => window.print()} title="Print what the browser shows (export a PDF for the true paper size)">
              Print…
            </button>
            <span className="sep" />
            <button onClick={onClose}>Cancel</button>
            <button className="primary" onClick={go} data-testid="export-go">
              <Icon name="export" size={14} />
              Export {kind.toUpperCase()}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
