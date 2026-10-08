// Toolbar buttons and menus: an icon over a short label, so a tool reads at a
// glance and still says its name. A menu opens under its button and closes on
// a choice, a click elsewhere or Escape.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";

interface ToolProps {
  icon: IconName;
  label: string;
  title?: string;
  onClick?(): void;
  disabled?: boolean;
  pressed?: boolean;
  testId?: string;
}

/** A toolbar button: icon over label. */
export function ToolButton({ icon, label, title, onClick, disabled, pressed, testId }: ToolProps) {
  return (
    // A click doesn't take the keyboard: Space and Enter stay the view menu and Repeat, not this button again.
    <button className="tool" onMouseDown={(e) => e.preventDefault()} onClick={onClick} disabled={disabled} title={title} aria-pressed={pressed} data-testid={testId}>
      <Icon name={icon} size={18} />
      <span className="tool-label">{label}</span>
    </button>
  );
}

/** A toolbar button that opens a menu of choices. */
export function ToolMenu({ icon, label, title, testId, children, disabled }: Omit<ToolProps, "onClick" | "pressed"> & { children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className="tool" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" title={title} disabled={disabled} data-testid={testId}>
        <Icon name={icon} size={18} />
        <span className="tool-label">
          {label}
          <Icon name="down" size={10} className="caret" />
        </span>
      </button>
      {open && (
        <div className="menu-items" role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** One choice in a menu: an icon, its name, its key, and a hint of what it needs. */
export function MenuItem({ icon, label, hint, shortcut, onClick, disabled, testId }: { icon?: IconName; label: string; hint?: string; shortcut?: string; onClick(): void; disabled?: boolean; testId?: string }) {
  return (
    <button role="menuitem" onClick={onClick} disabled={disabled} data-testid={testId} title={hint}>
      {icon ? <Icon name={icon} /> : <span className="icon-space" />}
      <span>{label}</span>
      {shortcut && <kbd className="menu-key">{shortcut}</kbd>}
    </button>
  );
}

/**
 * A menu or a bar of tools that opens where the pointer is (Space's view
 * menu, S's shortcut bar), or above an anchor. It stays on the screen, and
 * closes on a choice, a click elsewhere or Escape.
 */
export function Popup({ x, y, above, onClose, label, testId, bar, children }: { x: number; y: number; above?: boolean; onClose(): void; label: string; testId?: string; bar?: boolean; children: (close: () => void) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  // Placed before the first paint, so it never flashes at the wrong place and what it holds can take focus at once.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(bar ? x - w / 2 : x, window.innerWidth - w - 8));
    const top = Math.max(8, Math.min(above ? y - h - 6 : bar ? y - h - 12 : y, window.innerHeight - h - 8));
    setAt({ left, top });
  }, [x, y, above, bar]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className={`popup ${bar ? "popup-bar" : "menu-items"}`}
      role={bar ? "toolbar" : "menu"}
      aria-label={label}
      data-testid={testId}
      style={{ left: at?.left ?? x, top: at?.top ?? y, opacity: at ? 1 : 0 }}
    >
      {children(onClose)}
    </div>
  );
}
