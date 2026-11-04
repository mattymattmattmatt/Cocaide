// The cut list and the weld table (Phase J, overhauled in Phase Q), as a tab
// beside Properties. The cut list is read from the trimmed bodies on every
// rebuild (src/weldment/items.ts): members grouped with their end cuts,
// plates and other bodies, item numbers kept; the text typed on it lives in
// the document (doc.cutList). The full workspace opens as a drawer along the
// bottom (src/ui/cutlist/CutListDrawer.tsx). The weld table is notes in the
// document, edited here.

import { useMemo, useState } from "react";
import type { Command, RawDocument } from "../doc/commands";
import { csvHeaderRows } from "../doc/properties";
import { WELD_SIDES, WELD_TYPES, type Weld } from "../doc/types";
import type { Measurements } from "../kernel";
import { weldTableCSV } from "../weldment/cutlist";
import { DEFAULT_CUT_COLUMNS } from "../weldment/columns";
import { cutListCsvV2, cutListXlsx } from "../weldment/exports";
import { cutListOf } from "../weldment/items";
import { nestCutList } from "../weldment/nesting";
import { XLSX_TYPE } from "../weldment/xlsx";
import { CutListDrawer } from "./cutlist/CutListDrawer";
import { NumberInput } from "./fields";
import { Icon } from "./icons";

interface Props {
  doc: RawDocument | null;
  measurements: Measurements | null;
  dispatch(cmd: Command): string | null;
  onError(text: string): void;
  onSelect(id: string): void;
  /** Picks these bodies in the 3D view (a cut list row's members). */
  onSelectBodies?(bodies: string[]): void;
  onDownload(filename: string, data: string | Uint8Array, type: string): void;
  fileBase: string;
  /** Export plates (DXF): the part's flat plates for cutting (the Bodies tab's tool). */
  onExportPlates?(): void;
}

const n = (x: number, digits = 1) => x.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });

export function CutListPanel({ doc, measurements, dispatch, onError, onSelect, onSelectBodies, onDownload, fileBase, onExportPlates }: Props) {
  const list = useMemo(() => cutListOf(doc, measurements), [doc, measurements]);
  const stockLength = typeof doc?.parameters === "object" && doc.parameters && typeof (doc.parameters as Record<string, unknown>).stock_length === "number" ? ((doc.parameters as Record<string, number>).stock_length as number) : undefined;
  const nesting = useMemo(() => nestCutList(list, stockLength), [list, stockLength]);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const welds = (Array.isArray(doc?.welds) ? doc.welds : []) as unknown as Weld[];
  const hasMembers = list.items.some((i) => i.kind === "member");
  const items = hasMembers || list.items.length > 1 ? list.items : [];
  const name = typeof doc?.name === "string" ? doc.name : "part";
  const header = csvHeaderRows(doc, name);
  const setCutList = (patch: Record<string, unknown>) => dispatch({ type: "setCutList", patch });
  const setWeld = (w: Weld, patch: Partial<Weld>) => {
    const next: Record<string, unknown> = { ...w, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === "") delete next[k];
    const problem = dispatch({ type: "setWeld", id: w.id, weld: next });
    if (problem) onError(problem);
  };
  // A member's row opens the member (as it always has) and picks its bodies in the view; a plate's row picks its bodies.
  const select = (bodies: string[], first: string, member: boolean) => {
    onSelectBodies?.(bodies);
    if (member || !onSelectBodies) onSelect(first);
  };
  return (
    <section className="panel cut-list" aria-label="Cut list" data-testid="cut-list">
      <div className="cut-list-head">
        <h2>Cut list</h2>
        <button onClick={() => setOpen(true)} disabled={!items.length} data-testid="cut-list-open" title="The whole cut list: every column, text you type in, stock and nesting, plates">
          Open
        </button>
        <button onClick={() => onDownload(`${fileBase}-cut-list.csv`, cutListCsvV2(list, DEFAULT_CUT_COLUMNS, { header }), "text/csv")} disabled={!items.length} data-testid="cut-list-csv">
          CSV
        </button>
        <button onClick={() => onDownload(`${fileBase}-cut-list.xlsx`, cutListXlsx(list, nesting, welds, DEFAULT_CUT_COLUMNS, { header, title: `${name} cut list` }), XLSX_TYPE)} disabled={!items.length} data-testid="cut-list-xlsx" title="Cut list, stock buy list, cutting plan, plates and welds as a spreadsheet">
          XLSX
        </button>
        {onExportPlates && (
          <button onClick={onExportPlates} title="Every flat plate (end caps, gussets, base plates, flat bars) as a DXF for cutting, with an overview and a cutting list" data-testid="cut-list-plates">
            Plates (DXF)
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="muted small">No members yet. Members are measured on their trimmed bodies, so this list always matches the model.</p>
      ) : (
        <>
          <table className="cut-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Item</th>
                <th className="num">Length</th>
                <th>Ends</th>
                <th className="num">Qty</th>
                <th className="num">kg</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr
                  key={i.item}
                  data-testid="cut-row"
                  data-item={i.item}
                  className={picked === i.item ? "selected" : ""}
                  title={`${i.members.join(", ")}${i.notes ? `\n${i.notes}` : ""}`}
                  onClick={() => {
                    setPicked(i.item);
                    select(i.bodies, i.members[0], i.kind === "member");
                  }}
                >
                  <td>{i.item}</td>
                  <td className="cut-desc">
                    {i.description}
                    {i.kind === "member" && i.description !== i.designation && <span className="muted"> {i.designation}</span>}
                  </td>
                  <td className="num">{n(i.length)}</td>
                  <td className="cut-ends">{i.kind === "member" ? shortEnds(i.endsText) : i.kind === "plate" ? `PL ${n(i.thickness ?? 0)}` : ""}</td>
                  <td className="num">{i.quantity}</td>
                  <td className="num" title={`${n(i.massEach, 3)} kg each`}>
                    {n(i.massTotal, 2)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}>Total</td>
                <td className="num" data-testid="cut-total-qty">
                  {list.totals.quantity}
                </td>
                <td className="num" data-testid="cut-total-kg">
                  {n(list.totals.massKg, 2)}
                </td>
              </tr>
            </tfoot>
          </table>
          <p className="muted small cut-foot" data-testid="cut-total-paint">
            Paint {n(list.totals.paintArea, 2)} m²{nesting.length ? ` · buy ${nesting.flatMap((r) => r.buy.map((b) => `${b.count} × ${r.designation} @ ${b.stock}`)).join(", ")}` : ""}
          </p>
        </>
      )}

      <div className="cut-list-head">
        <h2>Welds</h2>
        <button onClick={() => onDownload(`${fileBase}-welds.csv`, weldTableCSV(welds), "text/csv")} disabled={!welds.length} data-testid="welds-csv">
          Export CSV
        </button>
      </div>
      {welds.length === 0 ? (
        <p className="muted small">Welds are notes, not geometry. Select a joint and press Add a weld: it starts with the length round the joint.</p>
      ) : (
        <ul className="weld-list" data-testid="welds">
          {welds.map((w) => (
            <li key={w.id} data-testid={`weld-${w.id}`}>
              <div className="weld-top">
                <strong>{w.id}</strong>
                <span className="muted small">{w.between.join(" + ")}</span>
                <button
                  className="icon"
                  aria-label={`Delete weld ${w.id}`}
                  onClick={() => {
                    const problem = dispatch({ type: "setWeld", id: w.id, weld: null });
                    if (problem) onError(problem);
                  }}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
              <div className="weld-fields">
                <select value={w.type} onChange={(e) => setWeld(w, { type: e.target.value as Weld["type"] })} aria-label="Weld type" data-testid={`weld-${w.id}-type`}>
                  {WELD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <label>
                  size <NumberInput value={w.size} min={0} onCommit={(v) => setWeld(w, { size: Number(v) })} testId={`weld-${w.id}-size`} />
                </label>
                <label>
                  length <NumberInput value={w.length} min={0} onCommit={(v) => setWeld(w, { length: Number(v) })} testId={`weld-${w.id}-length`} />
                </label>
                <label className="check">
                  <input type="checkbox" checked={!!w.allRound} onChange={(e) => setWeld(w, { allRound: e.target.checked || undefined })} />
                  all round
                </label>
              </div>
              <div className="weld-fields weld-more">
                <select value={w.side ?? ""} onChange={(e) => setWeld(w, { side: (e.target.value || undefined) as Weld["side"] })} aria-label="Weld side" data-testid={`weld-${w.id}-side`}>
                  <option value="">side</option>
                  {WELD_SIDES.map((t) => (
                    <option key={t} value={t}>
                      {t === "arrow" ? "arrow side" : t === "other" ? "other side" : "both sides"}
                    </option>
                  ))}
                </select>
                <label>
                  count <NumberInput value={w.count ?? 1} min={1} onCommit={(v) => setWeld(w, { count: Number(v) > 1 ? Math.round(Number(v)) : undefined })} testId={`weld-${w.id}-count`} />
                </label>
                <label className="wide">
                  process
                  <input
                    key={w.process ?? ""}
                    defaultValue={w.process ?? ""}
                    placeholder="135 MAG"
                    aria-label="Weld process"
                    data-testid={`weld-${w.id}-process`}
                    onBlur={(e) => e.target.value !== (w.process ?? "") && setWeld(w, { process: e.target.value.trim() || undefined })}
                    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  />
                </label>
              </div>
              <input
                key={w.note ?? ""}
                className="weld-note"
                defaultValue={w.note ?? ""}
                placeholder="note"
                aria-label="Weld note"
                onBlur={(e) => e.target.value !== (w.note ?? "") && setWeld(w, { note: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
            </li>
          ))}
        </ul>
      )}
      {open && items.length > 0 && (
        <CutListDrawer
          list={list}
          nesting={nesting}
          welds={welds}
          stockLength={stockLength}
          header={header}
          title={name}
          fileBase={fileBase}
          setCutList={setCutList}
          onError={onError}
          onSelectBodies={(b) => onSelectBodies?.(b)}
          onDownload={onDownload}
          onExportPlates={onExportPlates}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  );
}

/** "45° / 45°, same plane (trapezoid)" → "45° / 45°" for the narrow panel; the drawer says the rest. */
function shortEnds(text: string): string {
  return text.split(",")[0];
}
