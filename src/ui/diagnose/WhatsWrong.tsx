// What's wrong: every error and warning of the rebuild in one list (the top
// bar's badge opens it). A row says which feature, what is wrong and what it
// refers to; a click shows the feature in the tree and, for a broken
// reference, a red ring where it was last seen; the buttons fix it in one
// click (the rules are in diagnose.ts).

import { useEffect, useRef } from "react";
import { Icon, type IconName } from "../icons";
import { OP_ICON } from "../FeatureTree";
import { FIX_TEXT, problemCounts, type FixKind, type Problem } from "./diagnose";

interface Props {
  problems: Problem[];
  /** The row shown now (its feature lit in the tree, its ghost in the view). */
  shown: string | null;
  onShow(p: Problem): void;
  onFix(p: Problem, fix: FixKind): void;
  onClose(): void;
}

const SEVERITY_ICON: Record<Problem["severity"], IconName> = { error: "alert", warning: "warning", fragile: "robust" };
const SEVERITY_WORD: Record<Problem["severity"], string> = { error: "Error", warning: "Warning", fragile: "Fragile reference" };

export function WhatsWrong({ problems, shown, onShow, onFix, onClose }: Props) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const n = problemCounts(problems);
  return (
    <section className="whats-wrong" ref={panel} role="dialog" aria-label="What's wrong" data-testid="whats-wrong">
      <header>
        <h2>
          <Icon name="diagnose" /> What's wrong
        </h2>
        <span className="muted small">
          {n.errors} error{n.errors === 1 ? "" : "s"} · {n.warnings} warning{n.warnings === 1 ? "" : "s"}
          {n.fragile ? ` · ${n.fragile} fragile` : ""}
        </span>
        <button className="icon-only" aria-label="Close" onClick={onClose} data-testid="whats-wrong-close">
          <Icon name="x" />
        </button>
      </header>
      {problems.length === 0 ? (
        <p className="muted whats-wrong-clean" data-testid="whats-wrong-clean">
          Nothing is wrong: every feature rebuilt, and every reference to a face or edge is found by what made it.
        </p>
      ) : (
        <ol className="problem-list">
          {problems.map((p, i) => (
            <li key={p.key} className={`problem ${p.severity}${shown === p.key ? " shown" : ""}`} data-testid={`problem-${i}`} data-severity={p.severity} data-feature={p.feature ?? ""}>
              <button className="problem-main" onClick={() => onShow(p)} title={p.feature ? `Show ${p.feature} in the tree${p.ghost ? " and where its reference was" : ""}` : undefined}>
                <span className={`problem-icon ${p.severity}`} aria-label={SEVERITY_WORD[p.severity]} title={SEVERITY_WORD[p.severity]}>
                  <Icon name={SEVERITY_ICON[p.severity]} />
                </span>
                {p.feature && (
                  <span className="problem-feature">
                    <Icon name={OP_ICON[p.op ?? ""] ?? "sketch"} size={14} />
                    {p.feature}
                  </span>
                )}
                <span className="problem-message" data-testid={`problem-message-${i}`}>
                  {p.message}
                </span>
                {p.ref && (
                  <span className="problem-ref muted small" title="The reference it is about, in the feature">
                    {p.ref.kind === "edge" ? "edge" : "face"} · {p.ref.path}
                  </span>
                )}
              </button>
              {p.fixes.length > 0 && (
                <span className="problem-fixes">
                  {p.fixes.map((fix) => (
                    <button key={fix} className={fix === "accept" || fix === "repick" || fix === "robust" ? "primary-ish" : undefined} title={FIX_TEXT[fix].title} onClick={() => onFix(p, fix)} data-testid={`fix-${fix}-${i}`}>
                      {FIX_TEXT[fix].label}
                    </button>
                  ))}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** The top bar's badge: the count of errors and warnings; a click opens What's wrong. */
export function ProblemBadge({ problems, open, onClick }: { problems: Problem[]; open: boolean; onClick(): void }) {
  const n = problemCounts(problems);
  const state = n.errors ? "errors" : n.warnings ? "warnings" : n.fragile ? "fragile" : "clean";
  const text = n.errors || n.warnings ? `${n.errors ? `${n.errors} error${n.errors === 1 ? "" : "s"}` : ""}${n.errors && n.warnings ? " · " : ""}${n.warnings ? `${n.warnings} warning${n.warnings === 1 ? "" : "s"}` : ""}` : n.fragile ? `${n.fragile} fragile` : "All good";
  return (
    <button className={`problem-badge ${state}`} aria-pressed={open} onClick={onClick} title="What's wrong: every error and warning of the rebuild, with one-click fixes" data-testid="whats-wrong-badge" data-errors={n.errors} data-warnings={n.warnings}>
      <Icon name={n.errors ? "alert" : n.warnings ? "warning" : "check"} size={15} />
      <span>{text}</span>
    </button>
  );
}
