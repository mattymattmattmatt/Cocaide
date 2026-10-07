// The cut list and the weld table (Phase J), as a tab beside Properties. The
// cut list is read from the trimmed bodies on every rebuild; the weld table is
// notes in the document, edited here.

import type { Command, RawDocument } from "../doc/commands";
import { WELD_TYPES, type Weld } from "../doc/types";
import type { Measurements } from "../kernel";
import { anglesText, cutList, cutListCSV, weldTableCSV } from "../weldment/cutlist";
import { NumberInput } from "./fields";

interface Props {
  doc: RawDocument | null;
  measurements: Measurements | null;
  dispatch(cmd: Command): string | null;
  onError(text: string): void;
  onSelect(id: string): void;
  onDownload(filename: string, text: string): void;
  fileBase: string;
}

const n = (x: number, digits = 1) => x.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });

export function CutListPanel({ doc, measurements, dispatch, onError, onSelect, onDownload, fileBase }: Props) {
  const items = cutList(measurements?.members ?? []);
  const welds = (Array.isArray(doc?.welds) ? doc.welds : []) as unknown as Weld[];
  const total = items.reduce((t, i) => t + i.kgTotal, 0);
  const setWeld = (w: Weld, patch: Partial<Weld>) => {
    const next: Record<string, unknown> = { ...w, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === "") delete next[k];
    const problem = dispatch({ type: "setWeld", id: w.id, weld: next });
    if (problem) onError(problem);
  };
  return (
    <section className="panel cut-list" aria-label="Cut list" data-testid="cut-list">
      <div className="cut-list-head">
        <h2>Cut list</h2>
        <button onClick={() => onDownload(`${fileBase}-cut-list.csv`, cutListCSV(items))} disabled={!items.length} data-testid="cut-list-csv">
          Export CSV
        </button>
      </div>
      {items.length === 0 ? (
        <p className="muted small">No members yet. Members are measured on their trimmed bodies, so this list always matches the model.</p>
      ) : (
        <table className="cut-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Size</th>
              <th className="num">Length</th>
              <th>Ends</th>
              <th className="num">Qty</th>
              <th className="num">kg</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.item} data-testid="cut-row" title={i.members.join(", ")} onClick={() => onSelect(i.members[0])}>
                <td>{i.item}</td>
                <td>{i.designation}</td>
                <td className="num">{n(i.length)}</td>
                <td>{anglesText(i.angles)}</td>
                <td className="num">{i.quantity}</td>
                <td className="num" title={`${n(i.kgEach, 3)} kg each`}>
                  {n(i.kgTotal, 2)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4}>Total</td>
              <td className="num" data-testid="cut-total-qty">
                {items.reduce((t, i) => t + i.quantity, 0)}
              </td>
              <td className="num" data-testid="cut-total-kg">
                {n(total, 2)}
              </td>
            </tr>
          </tfoot>
        </table>
      )}

      <div className="cut-list-head">
        <h2>Welds</h2>
        <button onClick={() => onDownload(`${fileBase}-welds.csv`, weldTableCSV(welds))} disabled={!welds.length} data-testid="welds-csv">
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
                  ×
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
    </section>
  );
}
