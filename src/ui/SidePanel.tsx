// The right-hand panel's frame (properties, the sketch's panel, the drawing's
// panel): docked (the usual column), minimised to a strip along the right
// edge (it slides out over the view while the pointer is on it, or while a
// feature is open, and the pin docks it again), or popped out as a window that
// is dragged by its title and resized from its corner (the pin docks it
// again). One setting for every mode, remembered in this browser.

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Icon } from "./icons";

export type DockMode = "docked" | "hidden" | "floating";

export interface DockState {
  mode: DockMode;
  /** The popped-out window, in window pixels. */
  float: { x: number; y: number; w: number; h: number };
}

const KEY = "cocaide.rightPanel";
const DEFAULT: DockState = { mode: "docked", float: { x: -1, y: 120, w: 420, h: 620 } };

function load(): DockState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<DockState> | null;
    if (raw && (raw.mode === "docked" || raw.mode === "hidden" || raw.mode === "floating")) {
      const f = raw.float ?? DEFAULT.float;
      const ok = [f.x, f.y, f.w, f.h].every((v) => typeof v === "number" && Number.isFinite(v));
      return { mode: raw.mode, float: ok ? f : DEFAULT.float };
    }
  } catch {
    // Private windows may refuse storage: the default holds.
  }
  return DEFAULT;
}

let state: DockState = load();
const listeners = new Set<() => void>();

export function setDock(next: Partial<DockState>): void {
  state = { ...state, ...next, float: { ...state.float, ...next.float } };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Not remembered: it still holds for this visit.
  }
  for (const l of listeners) l();
}

/** The right panel's dock state, shared by every mode's panel and the workspace grid. */
export function useDock(): DockState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** The workspace's class for the right column: its width follows the panel's mode. */
export function dockClass(d: DockState): string {
  return d.mode === "hidden" ? " right-hidden" : d.mode === "floating" ? " right-floating" : "";
}

/** The popped-out window kept on screen (at least its title bar), in window pixels. */
function onScreen(f: DockState["float"]): DockState["float"] {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const w = Math.max(260, Math.min(f.w, W - 16));
  const h = Math.max(200, Math.min(f.h, H - 16));
  const x = f.x < 0 ? W - w - 24 : Math.max(8 - w + 80, Math.min(f.x, W - 80));
  const y = Math.max(8, Math.min(f.y, H - 40));
  return { x, y, w, h };
}

export function SidePanel({ className = "", title, hold = false, testId, children }: { className?: string; title: string; hold?: boolean; testId?: string; children: ReactNode }) {
  const dock = useDock();
  const [peek, setPeek] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<number | null>(null);
  const hidden = dock.mode === "hidden";
  const floating = dock.mode === "floating";
  const open = hidden && (peek || hold);

  // Out of minimised, nothing is peeking.
  useEffect(() => {
    if (!hidden) setPeek(false);
  }, [hidden]);

  const cancelLeave = () => {
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  };
  // The pointer gone from the strip and the panel: it slides back, unless something in it is being typed in.
  const leave = () => {
    cancelLeave();
    leaveTimer.current = window.setTimeout(() => {
      const a = document.activeElement;
      if (a && body.current?.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
      setPeek(false);
    }, 350);
  };
  useEffect(() => cancelLeave, []);

  // Dragging the popped-out window by its title bar.
  const drag = (e: React.PointerEvent) => {
    if (!floating || e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, f: onScreen(dock.float) };
    const move = (m: PointerEvent) => setDock({ float: onScreen({ ...start.f, x: start.f.x + m.clientX - start.x, y: start.f.y + m.clientY - start.y }) });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Resizing from the corner (the browser's own resize handle): its size is remembered.
  useEffect(() => {
    const el = body.current;
    if (!floating || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const f = state.float;
      if (Math.abs(r.width - f.w) > 2 || Math.abs(r.height - f.h) > 2) setDock({ float: { ...f, w: Math.round(r.width), h: Math.round(r.height) } });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [floating]);

  const f = floating ? onScreen(dock.float) : null;
  return (
    <aside className={`side right ${className} dock-${dock.mode}${open ? " dock-open" : ""}`} data-testid={testId}>
      {hidden && (
        <div
          className="dock-strip"
          onMouseEnter={() => {
            cancelLeave();
            setPeek(true);
          }}
          onMouseLeave={leave}
          onClick={() => setPeek((p) => !p)}
          title={`${title}: point here to slide it out; the pin keeps it open`}
          data-testid="dock-strip"
        >
          <button
            type="button"
            className="icon-only"
            aria-label={`Pin ${title} open`}
            title="Pin it open (dock it again)"
            onClick={(e) => {
              e.stopPropagation();
              setDock({ mode: "docked" });
            }}
            data-testid="dock-pin"
          >
            <Icon name="pin" size={14} />
          </button>
          <span className="dock-strip-label">{title}</span>
        </div>
      )}
      <div
        ref={body}
        className="dock-body"
        style={f ? { left: f.x, top: f.y, width: f.w, height: f.h } : undefined}
        onMouseEnter={hidden ? cancelLeave : undefined}
        onMouseLeave={hidden ? leave : undefined}
        data-testid="dock-body"
      >
        <div className={`dock-chrome${floating ? " movable" : ""}`} onPointerDown={drag} data-testid="dock-chrome">
          <span className="dock-title">{title}</span>
          {dock.mode !== "docked" ? (
            <button type="button" className="icon-only" aria-label="Pin to the side" title="Pin it back to the side of the window" onClick={() => setDock({ mode: "docked" })} data-testid="dock-pin-back">
              <Icon name="pin" size={14} />
            </button>
          ) : (
            <button type="button" className="icon-only" aria-label="Minimise to the side" title="Minimise to a strip at the side: point at it to slide the panel out" onClick={() => setDock({ mode: "hidden" })} data-testid="dock-minimise">
              <Icon name="chevronRight" size={14} />
            </button>
          )}
          {!floating && (
            <button type="button" className="icon-only" aria-label="Pop out" title="Pop it out as a window you can move and resize" onClick={() => setDock({ mode: "floating" })} data-testid="dock-popout">
              <Icon name="popOut" size={14} />
            </button>
          )}
        </div>
        {children}
      </div>
    </aside>
  );
}
