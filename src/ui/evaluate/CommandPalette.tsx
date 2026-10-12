// The command palette (Ctrl+K): type part of a name, arrows to choose, Enter
// to run. Every model tool, view command, display style, selection filter
// and rollback move is here, with its key.

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import { searchPalette, type PaletteEntry } from "./palette";

export function CommandPalette({ entries, onClose }: { entries: PaletteEntry[]; onClose(): void }) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const found = useMemo(() => searchPalette(entries, query), [entries, query]);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => setAt(0), [query]);
  useEffect(() => {
    (list.current?.children[at] as HTMLElement | undefined)?.scrollIntoView?.({ block: "nearest" });
  }, [at]);
  const run = (e: PaletteEntry | undefined) => {
    if (!e || e.disabled) return;
    onClose();
    // After the palette has closed, so the tool's own popups and focus land in the app.
    setTimeout(() => e.run(), 0);
  };
  return (
    <div className="palette-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Command search" data-testid="palette">
        <div className="palette-input">
          <Icon name="palette" />
          <input
            ref={input}
            value={query}
            placeholder="Search commands and tools…"
            aria-label="Search commands"
            data-testid="palette-input"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setAt((i) => Math.min(found.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setAt((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(found[at]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
        </div>
        <ul ref={list} className="palette-list" role="listbox">
          {found.map((e, i) => (
            <li key={e.id} role="option" aria-selected={i === at} aria-disabled={!!e.disabled}>
              <button onMouseEnter={() => setAt(i)} onClick={() => run(e)} disabled={!!e.disabled} title={e.disabled} data-testid={`palette-item-${e.id}`}>
                <span className="palette-label">{e.label}</span>
                <span className="palette-group">{e.disabled ?? e.group}</span>
                {e.key && <kbd className="menu-key">{e.key}</kbd>}
              </button>
            </li>
          ))}
          {found.length === 0 && <li className="muted small palette-none">Nothing called that. Try another word.</li>}
        </ul>
      </div>
    </div>
  );
}
