// Toolbar buttons and menus: an icon over a short label, so a tool reads at a
// glance and still says its name. A menu opens under its button and closes on
// a choice, a click elsewhere or Escape.

import { useEffect, useRef, useState, type ReactNode } from "react";
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
    <button className="tool" onClick={onClick} disabled={disabled} title={title} aria-pressed={pressed} data-testid={testId}>
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
      <button className="tool" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" title={title} disabled={disabled} data-testid={testId}>
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

/** One choice in a menu: an icon, its name, and a hint of what it needs. */
export function MenuItem({ icon, label, hint, onClick, disabled, testId }: { icon?: IconName; label: string; hint?: string; onClick(): void; disabled?: boolean; testId?: string }) {
  return (
    <button role="menuitem" onClick={onClick} disabled={disabled} data-testid={testId} title={hint}>
      {icon ? <Icon name={icon} /> : <span className="icon-space" />}
      <span>{label}</span>
    </button>
  );
}
