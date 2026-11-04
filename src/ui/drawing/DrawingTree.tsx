// The drawing tree (Phase Q wave Q2B): every sheet, and in each its format,
// its views nested under the views they are made from (a section under the
// view it cuts), each view's annotations under it, the tables, and the
// annotations of the sheet itself. A click selects on the sheet too (the
// sheet it is on is shown); Shift or Ctrl adds to the selection; right-click
// for the item's menu, Ask AI… among it.

import { useState } from "react";
import { viewKind } from "../../doc/drawing";
import type { Annotation, DrawingSheet, DrawingView, ViewLook } from "../../doc/types";
import type { ComposedSheet } from "../../drafting/compose";
import { Icon, type IconName } from "../icons";
import { annotationKind } from "./tools/kinds";
import type { SheetHit } from "./tools/types";
import type { Workspace } from "./Workspace";

const lookName = (l: ViewLook) => (l === "iso" || l === "dimetric" || l === "trimetric" ? l : `from the ${l}`);

/** What a view is, in a few words ("section A-A of top"). */
export function viewWords(v: DrawingView): string {
  const kind = viewKind(v);
  if (kind === "model") return v.orientation ? "custom orientation" : lookName(v.look ?? "front");
  if (kind === "projected") return `projected ${v.direction ?? ""} from ${v.parent}`;
  if (kind === "section") return `section ${v.label ?? ""}-${v.label ?? ""} of ${v.parent}`;
  if (kind === "detail") return `detail ${v.label ?? ""} of ${v.parent}`;
  return `auxiliary ${v.label ?? ""} of ${v.parent}`;
}

export function viewIcon(v: DrawingView): IconName {
  const kind = viewKind(v);
  return kind === "section" ? "section" : kind === "detail" ? "zoomArea" : kind === "projected" ? "viewFront" : kind === "auxiliary" ? "viewIso" : v.look === "iso" || v.look === "dimetric" || v.look === "trimetric" ? "iso" : "view";
}

const TABLE_WORDS: Record<string, string> = { cutList: "cut list", bom: "bill of materials", holes: "hole table", welds: "weld table", revisions: "revision table", general: "general table", stock: "cutting plan" };

export function DrawingTree({ ws }: { ws: Workspace }) {
  const { p } = ws;
  const drawing = p.drawing!;
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setFolded((f) => (f.has(id) ? new Set([...f].filter((x) => x !== id)) : new Set([...f, id])));
  const composedOf = (id: string) => p.sheets.find((s) => s.id === id) ?? null;

  const row = (hit: SheetHit, icon: IconName, label: string, detail: string, depth: number, opts: { problem?: string; fold?: string; title?: string } = {}) => {
    const selected = ws.selection.includes(hit.id);
    return (
      <li
        key={hit.id}
        className={`drawing-row${selected ? " selected" : ""}${opts.problem ? " failed" : ""}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={(e) => ws.select([hit.id], e.shiftKey || e.ctrlKey || e.metaKey)}
        onContextMenu={(e) => {
          e.preventDefault();
          ws.menuFor(hit, e.clientX, e.clientY, "tree");
        }}
        role="treeitem"
        aria-selected={selected}
        data-testid={`drawing-item-${hit.id}`}
        title={opts.problem ?? opts.title}
      >
        {opts.fold !== undefined ? (
          <button
            className={`tree-fold${folded.has(opts.fold) ? "" : " open"}`}
            aria-label={folded.has(opts.fold) ? "Show what is in it" : "Hide what is in it"}
            onClick={(e) => {
              e.stopPropagation();
              toggle(opts.fold!);
            }}
          >
            <Icon name="chevronRight" size={11} />
          </button>
        ) : (
          <span className="tree-fold-space" />
        )}
        <Icon name={opts.problem ? "alert" : icon} size={14} className="drawing-icon" />
        <span className="drawing-id">{label}</span>
        <span className="muted">{opts.problem ?? detail}</span>
      </li>
    );
  };

  const annotationRow = (a: Annotation, cs: ComposedSheet | null, depth: number) => {
    const said = cs?.annotations.find((x) => x.id === a.id);
    const k = annotationKind(a.type);
    return row({ kind: "annotation", id: a.id }, (k?.icon ?? "note") as IconName, a.id, k?.describe?.(a as unknown as Record<string, unknown>, said) ?? `${a.type} ${said?.text ?? ""}`, depth, { problem: said?.problem });
  };

  const sheetRows = (s: DrawingSheet) => {
    const cs = composedOf(s.id);
    const out: React.ReactNode[] = [];
    const views = s.views;
    const ids = new Set(views.map((v) => v.id));
    const roots = views.filter((v) => !v.parent || !ids.has(v.parent));
    const walk = (v: DrawingView, depth: number) => {
      const cv = cs?.views.find((x) => x.id === v.id);
      const mine = s.annotations.filter((a) => "view" in a && a.view === v.id);
      const kids = views.filter((x) => x.parent === v.id);
      const hasInside = mine.length + kids.length > 0;
      const extra = [(v as { free?: boolean }).free ? "free" : "", (v as { locked?: boolean }).locked ? "locked" : ""].filter(Boolean).join(", ");
      out.push(row({ kind: "view", id: v.id }, viewIcon(v), v.id, `${viewWords(v)}${cv ? `, ${cv.scaleText}` : ""}${v.at ? ", placed" : ""}${extra ? `, ${extra}` : ""}`, depth, { fold: hasInside ? v.id : undefined }));
      if (folded.has(v.id)) return;
      for (const k of kids) walk(k, depth + 1);
      for (const a of mine) out.push(annotationRow(a, cs, depth + 1));
    };
    for (const v of roots) walk(v, 1);
    for (const t of s.tables ?? []) out.push(row({ kind: "table", id: t.id }, t.kind === "holes" ? "hole" : t.kind === "welds" ? "joint" : t.kind === "revisions" ? "history" : "grid", t.id, `${TABLE_WORDS[t.kind] ?? t.kind}${t.view ? ` of ${t.view}` : ""}`, 1));
    for (const a of s.annotations.filter((x) => !("view" in x))) out.push(annotationRow(a, cs, 1));
    return out;
  };

  return (
    <section className="panel drawing-tree" data-testid="drawing-tree">
      <h2>Drawing</h2>
      <ul className="drawing-list" role="tree" aria-label="Drawing">
        {drawing.sheets.map((s) => {
          const cs = composedOf(s.id);
          const shown = s.id === p.sheet?.id;
          const key = `sheet:${s.id}`;
          return [
            <li
              key={key}
              className={`drawing-row sheet-row${shown ? " shown" : ""}`}
              onClick={() => {
                p.setActiveSheet(s.id);
                ws.setSelection([]);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                ws.sheetMenu(s.id, e.clientX, e.clientY, () => ws.setDialog({ name: "format" }));
              }}
              role="treeitem"
              aria-expanded={!folded.has(key)}
              data-testid={`drawing-sheet-${s.id}`}
            >
              <button
                className={`tree-fold${folded.has(key) ? "" : " open"}`}
                aria-label="Fold the sheet"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(key);
                }}
              >
                <Icon name="chevronRight" size={11} />
              </button>
              <Icon name="drawing" size={14} className="drawing-icon" />
              <span className="drawing-id">{cs?.name ?? s.name ?? s.id}</span>
              <span className="muted">
                {s.format.size}
                {cs ? `, ${cs.scaleText}` : ""}
              </span>
            </li>,
            ...(folded.has(key)
              ? []
              : [
                  <li
                    key={`${key}:format`}
                    className="drawing-row format-row"
                    style={{ paddingLeft: 20 }}
                    onClick={() => {
                      p.setActiveSheet(s.id);
                      ws.setDialog({ name: "format" });
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      p.setActiveSheet(s.id);
                      ws.menuFor({ kind: "titleBlock", id: "titleBlock" }, e.clientX, e.clientY, "tree");
                    }}
                    data-testid={`drawing-format-${s.id}`}
                  >
                    <span className="tree-fold-space" />
                    <Icon name="properties" size={14} className="drawing-icon" />
                    <span className="drawing-id">Sheet format</span>
                    <span className="muted">
                      {s.format.template ?? (drawing.standard === "ASME" ? "ansi" : "iso")} {s.format.orientation ?? "landscape"}
                    </span>
                  </li>,
                  ...sheetRows(s),
                ]),
          ];
        })}
      </ul>
      {!drawing.sheets.some((s) => s.views.length) && <p className="muted small">No views yet: View Layout, Standard 3 View or Model View.</p>}
    </section>
  );
}
