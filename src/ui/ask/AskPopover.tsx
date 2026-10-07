// The right-click ask on screen: a menu labelled with the target, a prompt
// box, the scoped actions, then progress and the result. A proposal shows
// what it changes and waits for Accept or Discard.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Change } from "../../ask/agent";
import { MODELS } from "../../ask/models";
import { describeScope, scopeFor } from "../../ask/packet";
import { scopedActions } from "../../ask/prompt";
import { IntentCard } from "./IntentCard";
import type { useAsk } from "./useAsk";
import { canAsk } from "./settings";

type Ask = ReturnType<typeof useAsk>;

export function AskPopover({ ask }: { ask: Ask }) {
  const s = ask.state;
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [applyNow, setApplyNow] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const key = s ? `${JSON.stringify(s.ctx.target)}@${s.ctx.x},${s.ctx.y}` : "";

  useEffect(() => {
    if (s?.phase === "menu") {
      setDraft(s.draft);
      setApplyNow(false);
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the popover inside the window.
  useLayoutEffect(() => {
    if (!s || !box.current) return;
    const r = box.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(s.ctx.x, window.innerWidth - r.width - 8));
    const top = Math.max(8, Math.min(s.ctx.y, window.innerHeight - r.height - 8));
    if (!pos || pos.left !== left || pos.top !== top) setPos({ left, top });
  });

  useEffect(() => {
    if (!s) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") ask.close();
    };
    // Clicking elsewhere closes the menu, but never an open result: a proposal is not lost by accident.
    const onDown = (e: PointerEvent) => {
      if (s.phase === "menu" && box.current && !box.current.contains(e.target as Node)) ask.close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [s, ask]);

  if (!s) return null;
  const { ctx } = s;
  const ready = canAsk(ask.settings);
  const scope = scopeFor(ctx.doc, ctx.target);
  const model = MODELS.find((m) => m.id === ask.settings.model)?.label ?? ask.settings.model;
  const part = ctx.target.kind === "part";
  const submit = (text: string) => ask.submit(ctx, text || (ctx.drawing ? "Read the part from this drawing." : ""), applyNow && !part);

  return (
    <div
      ref={box}
      className={`ask ask-${s.phase}`}
      role="dialog"
      aria-label={`Ask about ${ctx.label}`}
      data-testid="ask"
      style={pos ? { left: pos.left, top: pos.top } : { left: ctx.x, top: ctx.y, visibility: "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <header className="ask-head">
        <span>
          Ask about <strong data-testid="ask-target">{ctx.label}</strong>
        </span>
        <button className="icon" aria-label="Close" onClick={ask.close}>
          ×
        </button>
      </header>

      {s.phase === "menu" && (
        <>
          {ctx.drawing && (
            <div className="ask-drawing" data-testid="ask-drawing">
              Drawing: <strong>{ctx.drawing.name}</strong>
            </div>
          )}
          <form
            className="ask-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit(draft);
            }}
          >
            <textarea
              ref={input}
              autoFocus
              rows={2}
              value={draft}
              placeholder={
                part
                  ? ctx.drawing
                    ? "Anything to add? (optional)"
                    : ctx.doc.features.length
                      ? "Describe a new part, or ask about this one…"
                      : "Describe the part: “80 x 40 x 6 plate, four 6.6 holes 8 mm from corners”"
                  : "Ask about it, or say what to change…"
              }
              data-testid="ask-input"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit(draft);
                }
              }}
            />
            <button type="submit" className="primary" disabled={!draft.trim() && !ctx.drawing} data-testid="ask-submit">
              Ask
            </button>
          </form>
          <div className="ask-actions">
            {scopedActions(ctx.kind).map((a) => (
              <button
                key={a.label}
                data-testid={`ask-action-${a.label.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, "")}`}
                onClick={() => {
                  if (a.submit) return submit(a.prompt);
                  setDraft(a.prompt);
                  requestAnimationFrame(() => {
                    input.current?.focus();
                    input.current?.setSelectionRange(a.prompt.length, a.prompt.length);
                  });
                }}
              >
                {a.label}
                {!a.submit && "…"}
              </button>
            ))}
          </div>
          <footer className="ask-foot">
            {part ? (
              <span title="The whole part is the weakest scope: a change from here is always a proposal you accept.">Always a proposal</span>
            ) : (
              <label className="check" title="Off: you see the proposal and accept it. On: it is applied as soon as it checks out (undo still works).">
                <input type="checkbox" checked={applyNow} onChange={(e) => setApplyNow(e.target.checked)} data-testid="ask-apply-now" />
                Apply immediately
              </label>
            )}
            <span className="ask-scope" title={`What this ask may change (${scope.join(", ")}). The program enforces it.`} data-testid="ask-scope">
              may change: {describeScope(scope)}
            </span>
          </footer>
          <div className="ask-model">
            {ready ? (
              <button className="link" onClick={() => ask.setSettingsOpen(true)}>
                {model}
              </button>
            ) : (
              <button className="link" onClick={() => ask.setSettingsOpen(true)} data-testid="ask-setup">
                Set up the model to ask…
              </button>
            )}
          </div>
        </>
      )}

      {s.phase === "running" && (
        <div className="ask-body">
          <blockquote className="ask-prompt">{s.prompt}</blockquote>
          <ol className="ask-steps" data-testid="ask-steps">
            {s.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
          <div className="ask-buttons">
            <span className="spinner" aria-hidden />
            <button onClick={ask.close}>Cancel</button>
          </div>
        </div>
      )}

      {s.phase === "done" && (
        <div className="ask-body">
          <blockquote className="ask-prompt">{s.prompt}</blockquote>
          <div className={`ask-outcome ${s.result.outcome}`} data-testid="ask-outcome">
            {s.accepted ? "Applied" : OUTCOME[s.result.outcome]}
          </div>
          {s.result.text && (
            <div className="ask-text" data-testid="ask-text">
              {s.result.text}
            </div>
          )}
          {s.result.outcome === "questions" && s.result.review && <IntentCard review={s.result.review} onBuild={(answers) => ask.answer(s, answers)} />}
          {s.result.proposal?.checks && (
            <ul className="ask-checks" data-testid="ask-checks">
              {s.result.proposal.checks.map((c) => (
                <li key={c.label} className={c.ok ? "ok" : "bad"} title={c.ok ? undefined : `expected ${c.expected}`}>
                  {c.ok ? "✓" : "✗"} {c.label}: {c.actual}
                </li>
              ))}
            </ul>
          )}
          {s.result.proposal?.notes?.map((n) => (
            <div key={n} className="ask-note">
              {n}
            </div>
          ))}
          {s.result.proposal && !s.result.proposal.replace && (
            <div className="ask-proposal" data-testid="ask-proposal">
              <ul className="ask-changes">
                {s.result.proposal.changes.flatMap((c) => changeLines(c)).map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
              {s.result.proposal.volumeBefore !== null && s.result.proposal.volumeAfter !== null && (
                <div className="ask-volume">
                  Volume {fmt(s.result.proposal.volumeBefore)} → {fmt(s.result.proposal.volumeAfter)} mm³
                </div>
              )}
            </div>
          )}
          {s.dropped && (
            <div className="command-error" role="alert" data-testid="ask-dropped">
              {s.dropped}
            </div>
          )}
          {s.error && (
            <div className="command-error" role="alert">
              {s.error}
            </div>
          )}
          <div className="ask-buttons">
            {s.result.proposal && !s.accepted ? (
              <>
                <button className="primary" onClick={() => ask.accept(s)} data-testid="ask-accept">
                  {s.result.proposal.replace && s.result.proposal.base.features.length ? "Accept: replace the part" : "Accept"}
                </button>
                <button onClick={ask.discard} data-testid="ask-discard">
                  Discard
                </button>
                {!ctx.sketch && (
                  <label className="check">
                    <input type="checkbox" checked={s.preview} onChange={ask.togglePreview} data-testid="ask-preview" />
                    Preview
                  </label>
                )}
              </>
            ) : (
              <>
                <button onClick={() => ask.open(ctx, s.prompt)} data-testid="ask-again">
                  Ask again
                </button>
                <button onClick={ask.close} data-testid="ask-close">
                  Close
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const OUTCOME: Record<string, string> = {
  questions: "Needs your numbers",
  answer: "Answer",
  proposal: "Proposed change",
  refused: "Out of scope",
  failed: "Could not finish",
};

function changeLines(c: Change): string[] {
  if (c.kind === "added") return [`+ ${c.id}`];
  if (c.kind === "removed") return [`− ${c.id}`];
  return (c.fields ?? []).map((f) => `${c.id}${c.id === "parameters" ? ":" : ""} ${f.path}: ${short(f.before)} → ${short(f.after)}`);
}

function short(v: unknown): string {
  if (v === undefined) return "—";
  const s = JSON.stringify(v);
  return s.length > 48 ? `${s.slice(0, 45)}…` : s;
}

function fmt(x: number): string {
  return x.toLocaleString("en-US", { maximumFractionDigits: 3 });
}
