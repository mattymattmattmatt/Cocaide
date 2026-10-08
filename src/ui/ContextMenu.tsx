// The right-click menu, as SOLIDWORKS has one on everything: what you can do
// to the thing under the pointer, the usual edits, and "Ask AI…", which opens
// the ask panel scoped to it. It opens at the pointer and closes on a choice,
// a click elsewhere or Escape.

import type { IconName } from "./icons";
import { MenuItem, Popup } from "./tools";

export type MenuEntry =
  | { label: string; icon?: IconName; shortcut?: string; hint?: string; onClick(): void; disabled?: boolean; testId?: string }
  | { heading: string }
  | "sep";

export interface ContextMenuState {
  x: number;
  y: number;
  /** What was right-clicked, in words: the menu's first line. */
  title?: string;
  items: MenuEntry[];
}

/** The "Ask AI…" entry every menu carries. */
export function askEntry(onClick: () => void): MenuEntry {
  return { label: "Ask AI…", icon: "ask", hint: "Ask the assistant about this, or to change it", onClick, testId: "ctx-ask" };
}

export function ContextMenu({ menu, onClose }: { menu: ContextMenuState; onClose(): void }) {
  // Separators never lead, trail or double up when entries are left out.
  const items = menu.items.filter((e, i, all) => e !== "sep" || (i > 0 && i < all.length - 1 && all[i - 1] !== "sep"));
  return (
    <Popup x={menu.x} y={menu.y} onClose={onClose} label={menu.title ?? "Context menu"} testId="context-menu">
      {(close) => (
        <div className="context-menu" onContextMenu={(e) => e.preventDefault()}>
          {menu.title && <div className="context-title">{menu.title}</div>}
          {items.map((e, i) =>
            e === "sep" ? (
              <div key={i} className="menu-sep" role="separator" />
            ) : "heading" in e ? (
              <div key={i} className="context-heading">
                {e.heading}
              </div>
            ) : (
              <MenuItem
                key={i}
                icon={e.icon}
                label={e.label}
                hint={e.hint}
                shortcut={e.shortcut}
                disabled={e.disabled}
                testId={e.testId}
                onClick={() => {
                  close();
                  e.onClick();
                }}
              />
            ),
          )}
        </div>
      )}
    </Popup>
  );
}
