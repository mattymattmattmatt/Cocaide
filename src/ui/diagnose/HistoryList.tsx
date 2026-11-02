// The undo history as a list (Phase P): every step by name, the oldest at the
// top, the redo steps greyed below "now". A click goes back (or forward) to
// just after that step, in one go; undo and redo still step one at a time.

import { useEffect } from "react";
import { Icon } from "../icons";

interface Props {
  /** The undo steps' names, oldest first. */
  past: string[];
  /** The redo steps' names, next first. */
  future: string[];
  /** A feature session is open: the history waits for it (OK or Cancel). */
  busy: boolean;
  /** Back (negative) or forward (positive) this many steps. */
  onGo(steps: number): void;
  onClose(): void;
}

export function HistoryList({ past, future, busy, onGo, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const name = (s: string) => s || "Edit (typed in the document)";
  return (
    <section className="history-list" role="dialog" aria-label="Undo history" data-testid="history-list">
      <header>
        <h2>
          <Icon name="history" /> History
        </h2>
        <button className="icon-only" aria-label="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>
      {busy && <p className="muted small">Finish the feature that is open (OK or Cancel) to go back in the history.</p>}
      <ol>
        <li>
          <button disabled={busy || past.length === 0} onClick={() => onGo(-past.length)} data-testid="history-step-start" title="Back to how the part was when it was opened">
            <span className="muted">Opened</span>
          </button>
        </li>
        {past.map((s, i) => (
          <li key={`p${i}`} className={i === past.length - 1 ? "current" : undefined}>
            <button disabled={busy || i === past.length - 1} onClick={() => onGo(i - (past.length - 1))} data-testid={`history-step-${i}`} title={i === past.length - 1 ? "Where the part is now" : `Go back to just after “${name(s)}”`}>
              {name(s)}
              {i === past.length - 1 && <span className="history-now">now</span>}
            </button>
          </li>
        ))}
        {future.map((s, i) => (
          <li key={`f${i}`} className="undone">
            <button disabled={busy} onClick={() => onGo(i + 1)} data-testid={`history-redo-${i}`} title={`Redo up to “${name(s)}”`}>
              {name(s)}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
