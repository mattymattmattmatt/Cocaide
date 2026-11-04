// The cut list workspace (Phase Q): a drawer along the bottom of the window,
// so the part stays in view above it. Items (sortable, filtered, every
// column of the catalogue, the text typed in place and kept in the document),
// Stock & nesting (bar lengths, kerf and trim; the buy list and each bar's
// cutting plan, printable), and Plates. A row picked here is picked in the
// 3D view.

import { useMemo, useState } from "react";
import { DEFAULT_STOCK } from "../../doc/cutListSettings";
import { cellText, CUT_COLUMNS, cutColumn, DEFAULT_CUT_COLUMNS } from "../../weldment/columns";
import { barSvg, cuttingPlanHtml, cutListCsvV2, cutListXlsx } from "../../weldment/exports";
import { itemTextPatch, keptNumbering, renumberPatch, type CutItem, type CutItemKind, type CutListResult } from "../../weldment/items";
import { nestOptions, type NestResult } from "../../weldment/nesting";
import { XLSX_TYPE } from "../../weldment/xlsx";
import type { Weld } from "../../doc/types";
import { Icon } from "../icons";
import { EditCell } from "./EditCell";

export interface CutListDrawerProps {
  list: CutListResult;
  nesting: NestResult[];
  welds: Weld[];
  /** The part's stock_length parameter, when it has one. */
  stockLength?: number;
  /** Header rows for the exports (part, number, description, revision). */
  header: string[][];
  title: string;
  fileBase: string;
  /** Sends a setCutList patch; the problem when it is refused. */
  setCutList(patch: Record<string, unknown>): string | null;
  onError(text: string): void;
  onSelectBodies(bodies: string[]): void;
  onDownload(filename: string, data: string | Uint8Array, type: string): void;
  onExportPlates?(): void;
  onClose(): void;
  /** Which tab opens first. */
  tab?: Tab;
}

type Tab = "items" | "nesting" | "plates";
const EDITABLE = new Set(["description", "finish", "notes", "weldPrep", "group"]);
const COLUMNS_KEY = "cocaide.cutList.columns";

function savedColumns(): string[] | null {
  try {
    const raw = localStorage.getItem(COLUMNS_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;
  } catch {
    return null;
  }
}

const fmt = (x: number, digits = 1) => x.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });

export function CutListDrawer(p: CutListDrawerProps) {
  const [tab, setTab] = useState<Tab>(p.tab ?? "items");
  return (
    <section className="cut-drawer" role="dialog" aria-label="Cut list workspace" data-testid="cut-workspace">
      <header className="cut-drawer-head">
        <h2>Cut list</h2>
        <div className="cut-tabs" role="tablist">
          {(
            [
              ["items", "Items"],
              ["nesting", "Stock & nesting"],
              ["plates", "Plates"],
            ] as const
          ).map(([t, label]) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} data-testid={`cut-ws-tab-${t}`}>
              {label}
            </button>
          ))}
        </div>
        <Summary list={p.list} nesting={p.nesting} />
        <button className="cut-tool" onClick={() => p.onDownload(`${p.fileBase}-cut-list.xlsx`, cutListXlsx(p.list, p.nesting, p.welds, savedColumns() ?? DEFAULT_CUT_COLUMNS, { header: p.header, title: `${p.title} cut list` }), XLSX_TYPE)} data-testid="cut-ws-xlsx" title="The cut list, stock buy list, cutting plan, plates and welds as a spreadsheet">
          <Icon name="export" size={14} /> XLSX
        </button>
        <button className="icon cut-close" aria-label="Close the cut list workspace" onClick={p.onClose} data-testid="cut-ws-close">
          <Icon name="x" size={16} />
        </button>
      </header>
      <div className="cut-drawer-body">
        {tab === "items" ? <ItemsTab {...p} /> : tab === "nesting" ? <NestingTab {...p} /> : <PlatesTab {...p} />}
      </div>
    </section>
  );
}

function Summary({ list, nesting }: { list: CutListResult; nesting: NestResult[] }) {
  const bars = nesting.reduce((n, r) => n + r.bars.length, 0);
  return (
    <dl className="cut-summary" data-testid="cut-summary">
      <div>
        <dt>Items</dt>
        <dd>{list.items.length}</dd>
      </div>
      <div>
        <dt>Pieces</dt>
        <dd data-testid="cut-total-pieces">{list.totals.quantity}</dd>
      </div>
      <div>
        <dt>Mass</dt>
        <dd>{fmt(list.totals.massKg, 2)} kg</dd>
      </div>
      <div>
        <dt>Paint</dt>
        <dd>{fmt(list.totals.paintArea, 2)} m²</dd>
      </div>
      {bars > 0 && (
        <div>
          <dt>Bars</dt>
          <dd>{bars}</dd>
        </div>
      )}
    </dl>
  );
}

// ------------------------------------------------------------------ items

function ItemsTab(p: CutListDrawerProps) {
  const { list } = p;
  const [columns, setColumnsState] = useState<string[]>(() => {
    const saved = savedColumns() ?? DEFAULT_CUT_COLUMNS;
    return [...saved, ...list.propertyNames.map((n) => `prop:${n}`).filter((k) => !saved.includes(k))];
  });
  const setColumns = (c: string[]) => {
    setColumnsState(c);
    try {
      localStorage.setItem(COLUMNS_KEY, JSON.stringify(c));
    } catch {
      // A private window: the choice lasts while the drawer is open.
    }
  };
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: "item", desc: false });
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState<"all" | CutItemKind>("all");
  const [selected, setSelected] = useState<number | null>(null);
  const [newProp, setNewProp] = useState("");
  const cols = columns.map(cutColumn).filter((c): c is NonNullable<typeof c> => !!c);
  const rows = useMemo(() => {
    const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const c = cutColumn(sort.key) ?? cutColumn("item")!;
    return list.items
      .filter((i) => kind === "all" || i.kind === kind)
      .filter((i) => {
        if (!words.length) return true;
        const hay = [i.item, i.description, i.designation, i.material, i.grade, i.finish, i.notes, i.group, i.weldPrep, i.endsText, ...i.members, ...Object.values(i.properties)].join(" ").toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => {
        const x = c.value(a);
        const y = c.value(b);
        const d = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
        return (sort.desc ? -d : d) || a.item - b.item;
      });
  }, [list, filter, kind, sort]);
  const commit = (i: CutItem, key: string, value: string) => {
    const text = key.startsWith("prop:") ? { properties: { [key.slice(5)]: value } } : { [key]: value };
    const patch = itemTextPatch(list, i.item, text);
    if (!patch) return;
    const problem = p.setCutList(patch);
    if (problem) p.onError(problem);
  };
  const pick = (i: CutItem) => {
    setSelected(i.item);
    p.onSelectBodies(i.bodies);
  };
  const shownTotal = (key: string) => {
    if (key === "quantity") return String(rows.reduce((n, i) => n + i.quantity, 0));
    if (key === "massTotal") return fmt(rows.reduce((n, i) => n + i.massTotal, 0), 2);
    if (key === "areaTotal") return fmt(rows.reduce((n, i) => n + i.areaTotal, 0) / 1e6, 3);
    return "";
  };
  const addProperty = () => {
    const name = newProp.trim();
    if (!name) return;
    if (name.length > 60) return p.onError("A property name is 1 to 60 characters");
    const key = `prop:${name}`;
    if (!columns.includes(key)) setColumns([...columns, key]);
    setNewProp("");
  };
  const numbered = (list.settings.items ?? []).length > 0;
  return (
    <div className="cut-items">
      <div className="cut-toolbar">
        <input className="cut-filter" type="search" placeholder="Filter: size, material, note, member..." value={filter} onChange={(e) => setFilter(e.target.value)} data-testid="cut-filter" aria-label="Filter the cut list" />
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} data-testid="cut-kind" aria-label="Show">
          <option value="all">Everything</option>
          <option value="member">Members</option>
          <option value="plate">Plates</option>
          <option value="body">Other bodies</option>
        </select>
        <details className="cut-columns">
          <summary data-testid="cut-columns">Columns</summary>
          <div className="cut-columns-menu">
            {[...CUT_COLUMNS.map((c) => c.key), ...columns.filter((k) => k.startsWith("prop:"))].map((k) => {
              const c = cutColumn(k)!;
              return (
                <label key={k} title={c.help}>
                  <input type="checkbox" checked={columns.includes(k)} onChange={(e) => setColumns(e.target.checked ? [...columns, k] : columns.filter((x) => x !== k))} data-testid={`cut-col-${k}`} />
                  {c.label}
                </label>
              );
            })}
          </div>
        </details>
        <span className="cut-add-prop">
          <input placeholder="New property, e.g. Supplier" value={newProp} onChange={(e) => setNewProp(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addProperty()} data-testid="cut-new-prop" aria-label="New custom property" />
          <button onClick={addProperty} disabled={!newProp.trim()} data-testid="cut-add-prop" title="Add a column for a property of your own; type its value on each item">
            <Icon name="plus" size={13} /> Property
          </button>
        </span>
        <span className="sep" />
        <button
          className="cut-tool"
          onClick={() => {
            const problem = p.setCutList({ items: keptNumbering(list) });
            if (problem) p.onError(problem);
          }}
          data-testid="cut-keep-numbering"
          title="Keep these item numbers as the part changes (they are kept anyway once you type on an item)"
        >
          <Icon name="pin" size={13} /> {numbered ? "Numbers kept" : "Keep numbers"}
        </button>
        <button
          className="cut-tool"
          onClick={() => {
            const problem = p.setCutList(renumberPatch(list));
            if (problem) p.onError(problem);
          }}
          data-testid="cut-renumber"
          title="Number the items afresh: members by size and length, then plates, then other bodies. Typed text stays with its item."
        >
          Renumber
        </button>
        <button className="cut-tool" onClick={() => p.onDownload(`${p.fileBase}-cut-list.csv`, cutListCsvV2(list, columns, { header: p.header }), "text/csv")} data-testid="cut-ws-csv" title="The columns shown, as CSV">
          <Icon name="export" size={14} /> CSV
        </button>
      </div>
      <div className="cut-grid-wrap">
        <table className="cut-grid" data-testid="cut-grid">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.key} className={c.numeric ? "num" : ""} title={c.help} aria-sort={sort.key === c.key ? (sort.desc ? "descending" : "ascending") : "none"}>
                  <button onClick={() => setSort({ key: c.key, desc: sort.key === c.key ? !sort.desc : false })} data-testid={`cut-sort-${c.key}`}>
                    {c.label}
                    {sort.key === c.key && <span className="sort-mark">{sort.desc ? "▼" : "▲"}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.item} className={selected === i.item ? "selected" : ""} onClick={() => pick(i)} data-testid="cut-ws-row" data-item={i.item} title={`${i.members.join(", ")}`}>
                {cols.map((c) => {
                  const editable = EDITABLE.has(c.key) || c.key.startsWith("prop:");
                  if (editable) {
                    const value = c.key.startsWith("prop:") ? (i.properties[c.key.slice(5)] ?? "") : c.key === "description" ? (i.description === i.autoDescription ? "" : i.description) : String(c.value(i));
                    return (
                      <td key={c.key} className="edit">
                        <EditCell value={value} placeholder={c.key === "description" ? i.autoDescription : ""} label={`${c.label} of item ${i.item}`} onCommit={(v) => commit(i, c.key, v)} testId={`cut-edit-${i.item}-${c.key}`} />
                      </td>
                    );
                  }
                  const v = c.value(i);
                  return (
                    <td key={c.key} className={c.numeric ? "num" : c.key === "item" ? "item" : ""}>
                      {c.key === "item" ? <span className={`kind-dot ${i.kind}`} title={i.kind === "member" ? "member" : i.kind === "plate" ? "plate" : "body"} /> : null}
                      {typeof v === "number" ? cellText(c, v) : v}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              {cols.map((c, k) => (
                <td key={c.key} className={c.numeric ? "num" : ""} data-testid={`cut-ws-total-${c.key}`}>
                  {shownTotal(c.key) || (k === 0 ? "Total" : "")}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      <ProfileTotals list={list} />
    </div>
  );
}

function ProfileTotals({ list }: { list: CutListResult }) {
  if (!list.totals.byProfile.length && !list.totals.plates.length) return null;
  return (
    <div className="cut-totals" data-testid="cut-profile-totals">
      {list.totals.byProfile.map((t) => (
        <span key={t.designation} className="chip">
          <b>{t.designation}</b> {t.pieces} pcs · {fmt(t.length / 1000, 3)} m · {fmt(t.massKg, 1)} kg
        </span>
      ))}
      {list.totals.plates.map((t) => (
        <span key={`${t.thickness}|${t.material}`} className="chip">
          <b>PL {t.thickness}</b> {t.pieces} pcs · {fmt(t.area / 1e6, 4)} m² · {fmt(t.massKg, 2)} kg
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- nesting

function lengthsText(xs: number[] | undefined): string {
  return xs?.join(", ") ?? "";
}

function parseLengths(text: string): number[] | null | "bad" {
  const t = text.trim();
  if (!t) return null;
  const xs = t.split(/[\s,;/]+/).filter(Boolean).map(Number);
  return xs.length && xs.every((x) => Number.isFinite(x) && x > 0) ? xs : "bad";
}

function NestingTab(p: CutListDrawerProps) {
  const st = p.list.settings.stock ?? {};
  const set = (stock: Record<string, unknown>) => {
    const problem = p.setCutList({ stock });
    if (problem) p.onError(problem);
  };
  const number = (key: "kerf" | "trim" | "minOffcut", text: string) => {
    const t = text.trim();
    if (!t) return set({ [key]: null });
    const x = Number(t);
    if (!Number.isFinite(x)) return p.onError(`${key}: type a number of mm`);
    set({ [key]: x });
  };
  const defaultLengths = p.stockLength && p.stockLength > 0 ? [p.stockLength] : [DEFAULT_STOCK.length];
  const designations = p.nesting.map((r) => r.designation);
  if (!designations.length) return <p className="muted small">No members to nest. Members are cut from stock bars; plates are listed under Plates.</p>;
  return (
    <div className="cut-nesting">
      <div className="nest-settings">
        <label>
          Stock bars (mm)
          <EditCell value={lengthsText(st.lengths)} placeholder={lengthsText(defaultLengths)} label="Stock bar lengths" testId="nest-stock" onCommit={(v) => {
            const xs = parseLengths(v);
            if (xs === "bad") return p.onError("Stock bars: type lengths in mm, like 6000, 6100");
            set({ lengths: xs });
          }} />
        </label>
        <label>
          Kerf (mm)
          <EditCell value={st.kerf !== undefined ? String(st.kerf) : ""} placeholder={String(DEFAULT_STOCK.kerf)} label="Saw kerf" testId="nest-kerf" onCommit={(v) => number("kerf", v)} />
        </label>
        <label>
          End trim (mm)
          <EditCell value={st.trim !== undefined ? String(st.trim) : ""} placeholder={String(DEFAULT_STOCK.trim)} label="End trim" testId="nest-trim" onCommit={(v) => number("trim", v)} />
        </label>
        <label>
          Keep offcuts from (mm)
          <EditCell value={st.minOffcut !== undefined ? String(st.minOffcut) : ""} placeholder={String(DEFAULT_STOCK.minOffcut)} label="Shortest offcut kept" testId="nest-min-offcut" onCommit={(v) => number("minOffcut", v)} />
        </label>
        <span className="sep" />
        <button
          className="cut-tool"
          onClick={() => {
            const w = window.open("", "_blank");
            if (!w) return p.onError("The browser blocked the cutting plan's window: allow pop-ups for this page");
            w.document.write(cuttingPlanHtml(p.list, p.nesting, { header: p.header, title: `${p.title}: cutting plan` }));
            w.document.close();
          }}
          data-testid="nest-print"
          title="The buy list and every bar's cuts, on a page to print"
        >
          Print cutting plan
        </button>
      </div>
      <table className="cut-grid nest-buy" data-testid="nest-buy">
        <thead>
          <tr>
            <th>Size</th>
            <th>Bars (mm)</th>
            <th className="num">Buy</th>
            <th className="num">Pieces</th>
            <th className="num">Bought (m)</th>
            <th className="num">Used (m)</th>
            <th className="num">Offcuts kept (m)</th>
            <th className="num">Waste</th>
            <th>Own bar lengths</th>
          </tr>
        </thead>
        <tbody>
          {p.nesting.map((r) => (
            <tr key={r.designation} data-testid="nest-buy-row" data-size={r.designation}>
              <td>{r.designation}</td>
              <td>{r.options.stock.join(", ")}</td>
              <td className="num" data-testid="nest-buy-count">
                {r.buy.map((b) => `${b.count} × ${b.stock}`).join(" + ")}
              </td>
              <td className="num">{r.pieces}</td>
              <td className="num">{fmt(r.bought / 1000, 3)}</td>
              <td className="num">{fmt(r.used / 1000, 3)}</td>
              <td className="num">{fmt(r.offcuts / 1000, 3)}</td>
              <td className="num" data-testid="nest-waste">
                {r.wastePct.toFixed(1)}%
              </td>
              <td className="edit">
                <EditCell
                  value={lengthsText(st.profiles?.[r.designation]?.lengths)}
                  placeholder="as above"
                  label={`Bar lengths for ${r.designation}`}
                  testId={`nest-own-${r.designation}`}
                  onCommit={(v) => {
                    const xs = parseLengths(v);
                    if (xs === "bad") return p.onError("Bar lengths: type lengths in mm, like 8000");
                    const profiles = { ...(st.profiles ?? {}) };
                    if (xs) profiles[r.designation] = { ...(profiles[r.designation] ?? {}), lengths: xs };
                    else if (profiles[r.designation]) {
                      const { lengths: _l, ...rest } = profiles[r.designation];
                      if (Object.keys(rest).length) profiles[r.designation] = rest;
                      else delete profiles[r.designation];
                    }
                    set({ profiles: Object.keys(profiles).length ? profiles : null });
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {p.nesting.map((r) => (
        <div key={r.designation} className="nest-size">
          <h3>
            {r.designation} <span className="muted small">kerf {nestOptions(p.list.settings, r.designation, p.stockLength).kerf} mm · {r.bars.length} bar{r.bars.length === 1 ? "" : "s"}</span>
          </h3>
          {r.tooLong.length > 0 && (
            <p className="bad small" data-testid="nest-too-long">
              Longer than any bar: {r.tooLong.map((x) => `item ${x.item} (${fmt(x.length)} mm)`).join(", ")}. Add a longer bar length or splice it.
            </p>
          )}
          {r.bars.map((b, k) => (
            <div key={k} className="nest-bar" data-testid="nest-bar">
              <div className="nest-bar-head">
                <b>Bar {k + 1}</b>
                <span>{b.stock} mm</span>
                <span>{b.pieces.map((x) => `#${x.item} ${fmt(x.length)}`).join(" · ")}</span>
                <span className="sep" />
                <span className="muted">
                  offcut {fmt(b.offcut)} mm{b.kept ? " (keep)" : ""} · waste {b.wastePct.toFixed(1)}%
                </span>
              </div>
              <div className="nest-bar-svg" dangerouslySetInnerHTML={{ __html: barSvg(b.stock, b.pieces, r.options.kerf, r.options.trim, b.offcut, b.kept, 1000, true) }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------- plates

function PlatesTab(p: CutListDrawerProps) {
  const plates = p.list.items.filter((i) => i.kind === "plate");
  if (!plates.length) return <p className="muted small">No flat plates. End caps, gussets and base plates are listed here with their size and area.</p>;
  return (
    <div className="cut-plates">
      <div className="cut-toolbar">
        <span className="muted small">Each plate laid flat: thickness × width × length, its area and mass.</span>
        <span className="sep" />
        {p.onExportPlates && (
          <button className="cut-tool" onClick={p.onExportPlates} data-testid="cut-ws-plates-dxf" title="Every flat plate as a DXF for cutting">
            <Icon name="plates" size={14} /> Plates (DXF)
          </button>
        )}
      </div>
      <table className="cut-grid" data-testid="cut-plates">
        <thead>
          <tr>
            <th>Item</th>
            <th>Description</th>
            <th className="num">Qty</th>
            <th className="num">Thickness</th>
            <th className="num">Width</th>
            <th className="num">Length</th>
            <th className="num">Area each (m²)</th>
            <th className="num">kg total</th>
            <th>Material</th>
          </tr>
        </thead>
        <tbody>
          {plates.map((i) => (
            <tr key={i.item} onClick={() => p.onSelectBodies(i.bodies)}>
              <td className="item">{i.item}</td>
              <td>{i.description}</td>
              <td className="num">{i.quantity}</td>
              <td className="num">{fmt(i.thickness ?? 0)}</td>
              <td className="num">{fmt(i.width ?? 0)}</td>
              <td className="num">{fmt(i.length)}</td>
              <td className="num">{fmt((i.plateArea ?? 0) / 1e6, 4)}</td>
              <td className="num">{fmt(i.massTotal, 2)}</td>
              <td>{i.material}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ProfileTotals list={{ ...p.list, totals: { ...p.list.totals, byProfile: [] } }} />
    </div>
  );
}
