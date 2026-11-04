// The drawing's sheets as tabs under the sheet (Phase Q wave Q2B): click to
// show one, double-click to rename it, drag a tab to reorder, right-click
// for its menu (rename, move, delete, ask the assistant), + adds a sheet.

import { useState } from "react";
import type { Workspace } from "./Workspace";

export function SheetTabs({ ws }: { ws: Workspace }) {
  const { p } = ws;
  const [editing, setEditing] = useState<string | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const active = p.sheet?.id;
  return (
    <div className="sheet-tabs" role="tablist" aria-label="Sheets" data-testid="sheet-tabs">
      {p.sheets.map((s, i) =>
        editing === s.id ? (
          <input
            key={s.id}
            className="sheet-tab-edit"
            defaultValue={s.name}
            autoFocus
            aria-label="Sheet name"
            data-testid={`sheet-tab-name-${s.id}`}
            onBlur={(e) => {
              setEditing(null);
              const name = e.target.value.trim();
              if (name && name !== s.name) ws.run({ type: "renameSheet", id: s.id, name });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditing(null);
            }}
          />
        ) : (
          <button
            key={s.id}
            role="tab"
            aria-selected={s.id === active}
            className={`sheet-tab${s.id === active ? " active" : ""}${dragged && dragged !== s.id ? " drop" : ""}`}
            draggable
            onDragStart={(e) => {
              setDragged(s.id);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/x-sheet", s.id);
            }}
            onDragEnd={() => setDragged(null)}
            onDragOver={(e) => {
              if (dragged) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (dragged && dragged !== s.id) ws.run({ type: "moveSheet", id: dragged, index: i });
              setDragged(null);
            }}
            onClick={() => {
              p.setActiveSheet(s.id);
              ws.setSelection([]);
            }}
            onDoubleClick={() => setEditing(s.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              ws.sheetMenu(s.id, e.clientX, e.clientY, () => setEditing(s.id));
            }}
            title={`${s.name}: ${s.size}, ${s.scaleText}, ${s.views.length} view${s.views.length === 1 ? "" : "s"} (double-click to rename, drag to reorder, right-click for more)`}
            data-testid={`sheet-tab-${s.id}`}
          >
            {s.name}
          </button>
        ),
      )}
      <button className="sheet-tab add" onClick={ws.addSheet} title="Add a sheet" aria-label="Add a sheet" data-testid="sheet-add">
        +
      </button>
    </div>
  );
}
