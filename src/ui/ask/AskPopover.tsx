// The right-click ask on screen: a menu labelled with the target, a prompt
// box with attachments, the scoped actions, then progress and the result. A
// proposal shows what it changes and waits for Accept or Discard. The History
// tab lists this document's earlier requests; any can be read again or
// followed up. The window closes only with its Close button (or Escape when
// nothing is typed): clicking the model or the view leaves it open, and
// unsent text is kept as a draft.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AskReach } from "../../ask/agent";
import { ACCEPT, canAdd, sizeText, type Attachment } from "../../ask/attachments";
import { MODELS } from "../../ask/models";
import { describeScope, scopeFor } from "../../ask/packet";
import { scopedActions } from "../../ask/prompt";
import { IntentCard } from "./IntentCard";
import { DetailPlanCard } from "./DetailPlanCard";
import type { useAsk } from "./useAsk";
import { canAsk } from "./settings";
import { Icon } from "../icons";
import { changeLines, threadOf, type HistoryEntry } from "./history";
import type { LiveState } from "../../ask/bridge/run";
import { BRIDGE_MODELS } from "../../bridge/protocol";
import { clearIssues, groupIssues, issuesOf, issuesReport, readIssues } from "./toolIssues";

type Ask = ReturnType<typeof useAsk>;

export function AskPopover({ ask }: { ask: Ask }) {
  const s = ask.state;
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [applyNow, setApplyNow] = useState(false);
  /** What this ask may change: the whole part (the default in Settings), or just what was right-clicked. */
  const [reach, setReach] = useState<AskReach>(ask.settings.reach);
  /** A dropped image: read as a drawing or as a photo. */
  const [readAs, setReadAs] = useState<"drawing" | "photo">("drawing");
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [tab, setTab] = useState<"ask" | "history" | "issues">("ask");
  /** Bumped when the tool-issue log is cleared, so it is read again. */
  const [issuesVersion, setIssuesVersion] = useState(0);
  /** The history entry being read again. */
  const [reading, setReading] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const key = s ? `${JSON.stringify(s.ctx.target)}@${s.ctx.x},${s.ctx.y}|${s.phase === "menu" ? (s.followUp ?? "") : ""}` : "";

  useEffect(() => {
    if (s?.phase === "menu") {
      setDraft(s.draft);
      setApplyNow(false);
      setReach(ask.settings.reach);
      setReadAs(s.ctx.readAs ?? "drawing");
      setAttachments([]);
      setAttachError(null);
      setTab("ask");
      setReading(null);
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeDraft = (text: string) => {
    setDraft(text);
    if (s) ask.keepDraft(s.ctx, text);
  };

  /** Files dropped, pasted or picked: read, checked against the limits, shown as chips. */
  const attach = async (files: File[]) => {
    setAttachError(null);
    const { prepareAttachment } = await import("./attach");
    let list = attachments;
    for (const f of files) {
      const a = await prepareAttachment(f);
      if (typeof a === "string") {
        setAttachError(a);
        continue;
      }
      const problem = canAdd(list, a);
      if (problem) {
        setAttachError(`${a.name}: ${problem}`);
        continue;
      }
      list = [...list, a];
    }
    setAttachments(list);
  };

  // Keep the popover inside the window, also when it grows on its own (a drawing's thumbnail loading).
  const place = useCallback(() => {
    if (!s || !box.current) return;
    const r = box.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(s.ctx.x, window.innerWidth - r.width - 8));
    const top = Math.max(8, Math.min(s.ctx.y, window.innerHeight - r.height - 8));
    setPos((pos) => (pos && pos.left === left && pos.top === top ? pos : { left, top }));
  }, [s]);
  useLayoutEffect(place);
  useEffect(() => {
    if (!box.current) return;
    const observer = new ResizeObserver(place);
    observer.observe(box.current);
    return () => observer.disconnect();
  }, [place]);

  useEffect(() => {
    if (!s) return;
    // Escape closes it only when nothing would be lost: no typed text, no attachments, no ask running.
    // Clicking elsewhere (the model, the view) never closes it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || s.phase === "running") return;
      if (s.phase === "menu" && (draft.trim() || attachments.length)) return;
      ask.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s, ask, draft, attachments]);

  if (!s) return null;
  const { ctx } = s;
  const ready = canAsk(ask.settings);
  const scope = scopeFor(ctx.doc, ctx.target);
  const model =
    ask.settings.provider === "ollama"
      ? `${ask.settings.ollama.model} (local, Ollama)`
      : ask.settings.provider === "claude-code"
        ? ask.settings.bridge.engine === "grok"
          ? `Grok subscription via Grok Build (${ask.settings.bridge.grokModel === "default" ? "its default model" : ask.settings.bridge.grokModel})`
          : ask.settings.bridge.engine === "auto"
            ? "Your subscription via the local bridge (Claude Code or Grok Build, whichever is installed)"
            : `Claude subscription via Claude Code (${BRIDGE_MODELS.find((m) => m.id === ask.settings.bridge.model)?.label ?? ask.settings.bridge.model})`
        : (MODELS.find((m) => m.id === ask.settings.model)?.label ?? ask.settings.model);
  const part = ctx.target.kind === "part";
  const asPhoto = !!ctx.photo && readAs === "photo";
  const dropped = !!ctx.drawing || !!ctx.photo;
  const submit = (text: string) => {
    // Only what the user chose goes with the ask: the drawing, or the photo.
    const sent: typeof ctx = !dropped ? ctx : asPhoto ? { ...ctx, drawing: undefined, readAs } : { ...ctx, photo: undefined, readAs };
    const fallback = asPhoto ? "Read the part from this photo." : ctx.drawing ? "Read the part from this drawing." : "";
    ask.submit(sent, text || fallback, applyNow && !part, reach, { attachments, ...(s.phase === "menu" && s.followUp ? { followUp: s.followUp } : {}) });
  };
  const history = ask.history(ctx.doc);
  const followed = s.phase === "menu" && s.followUp ? history.find((h) => h.id === s.followUp) : undefined;
  const wide = reach === "part" && !part;

  return (
    <div
      ref={box}
      className={`ask ask-${s.phase}`}
      role="dialog"
      aria-label={`Ask about ${ctx.label}`}
      data-testid="ask"
      style={pos ? { left: pos.left, top: pos.top } : { left: ctx.x, top: ctx.y, visibility: "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
      onDragOver={(e) => {
        if (s.phase !== "menu" || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={(e) => {
        // Dropped on the AI window: an attachment of this request, not a drawing for a new part.
        if (s.phase !== "menu" || !e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        void attach([...e.dataTransfer.files]);
      }}
    >
      <header className="ask-head">
        <span>
          Ask about <strong data-testid="ask-target">{ctx.label}</strong>
        </span>
        <button className="icon" aria-label="Close" onClick={ask.close}>
          <Icon name="x" size={15} />
        </button>
      </header>

      {s.phase === "menu" && (
        <div className="tabs ask-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "ask"} onClick={() => setTab("ask")} data-testid="ask-tab-ask">
            Ask
          </button>
          <button type="button" role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")} data-testid="ask-tab-history">
            History{history.length ? ` (${history.length})` : ""}
          </button>
          <button type="button" role="tab" aria-selected={tab === "issues"} onClick={() => setTab("issues")} data-testid="ask-tab-issues" title="Problems the AI ran into with Cocaide's tools, kept to send to Cocaide's developers">
            Tool issues{(void issuesVersion, readIssues().length) ? ` (${readIssues().length})` : ""}
          </button>
        </div>
      )}

      {s.phase === "menu" && tab === "issues" && (
        <ToolIssuesView
          version={issuesVersion}
          onClear={() => {
            clearIssues();
            setIssuesVersion((n) => n + 1);
          }}
        />
      )}

      {s.phase === "menu" && tab === "history" && (
        <HistoryView
          entries={history}
          reading={reading}
          onRead={setReading}
          onFollowUp={(id) => ask.open(ctx, "", id)}
          onClear={() => {
            ask.clearHistory(ctx.doc);
            setReading(null);
          }}
        />
      )}

      {s.phase === "menu" && tab === "ask" && (
        <>
          {followed && (
            <div className="ask-follow" data-testid="ask-follow">
              Following up: <em>{followed.prompt}</em>
              <button type="button" className="link" onClick={() => ask.open(ctx, draft)} title="Ask without the earlier conversation">
                (new conversation)
              </button>
            </div>
          )}
          {ctx.photo && (
            <div className="ask-read-as" role="radiogroup" aria-label="Read the image as" data-testid="ask-read-as">
              <span className="muted">Read it as</span>
              {(["drawing", "photo"] as const).map((k) => (
                <button key={k} role="radio" aria-checked={readAs === k} className={readAs === k ? "on" : ""} onClick={() => setReadAs(k)} data-testid={`ask-read-as-${k}`}>
                  {k === "drawing" ? "a drawing" : "a photo"}
                </button>
              ))}
            </div>
          )}
          {asPhoto && ctx.photo ? (
            <div className="ask-drawing" data-testid="ask-drawing">
              Photo: <strong>{ctx.photo.name}</strong> · {ctx.photo.width} × {ctx.photo.height} px · sizes are estimated from one you know
            </div>
          ) : (
            ctx.drawing && (
              <div className="ask-drawing" data-testid="ask-drawing">
                Drawing: <strong>{ctx.drawing.name}</strong>
                {ctx.drawing.dpi
                  ? ` · ${ctx.drawing.pageCount} page${ctx.drawing.pageCount === 1 ? "" : "s"} at ${ctx.drawing.dpi} dpi`
                  : " · scan"}
                {ctx.drawing.legibility.blurry && <span className="why"> · looks too blurry to read</span>}
              </div>
            )
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
                  ? asPhoto
                    ? "One size you know: “the long edge is 80 mm” (optional)"
                    : ctx.drawing
                      ? "Anything to add? (optional)"
                      : ctx.doc.features.length
                        ? "Describe a new part, or ask about this one…"
                        : "Describe the part: “80 x 40 x 6 plate, four 6.6 holes 8 mm from corners”"
                  : "Ask about it, or say what to change…"
              }
              data-testid="ask-input"
              onChange={(e) => changeDraft(e.target.value)}
              onPaste={(e) => {
                // A pasted image (a screenshot) is an attachment; pasted text is just text.
                const files = [...e.clipboardData.files];
                if (!files.length) return;
                e.preventDefault();
                void attach(files);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit(draft);
                }
              }}
            />
            <button
              type="button"
              className="icon ask-attach"
              onClick={() => fileInput.current?.click()}
              title="Attach reference files: images (or paste a screenshot, or drop files here), PDFs, text, DXF or STEP"
              aria-label="Attach files"
              data-testid="ask-attach"
            >
              +
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={ACCEPT}
              hidden
              data-testid="ask-attach-input"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                void attach(files);
              }}
            />
            <button type="submit" className="primary" disabled={!draft.trim() && !dropped} data-testid="ask-submit">
              Ask
            </button>
          </form>
          {(attachments.length > 0 || attachError) && (
            <div className="ask-attachments" data-testid="ask-attachments">
              {attachments.map((a, i) => (
                <span key={a.id} className="ask-chip" data-testid={`ask-attachment-${i}`} title={`${a.name}: ${a.kind}, ${sizeText(a.size)}${a.truncated ? ", cut to fit" : ""}`}>
                  {a.name} <span className="muted">{sizeText(a.size)}</span>
                  <button type="button" className="icon" aria-label={`Remove ${a.name}`} onClick={() => setAttachments(attachments.filter((x) => x.id !== a.id))} data-testid={`ask-attachment-remove-${i}`}>
                    ×
                  </button>
                </span>
              ))}
              {attachError && (
                <span className="why" role="alert" data-testid="ask-attach-error">
                  {attachError}
                </span>
              )}
            </div>
          )}
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
            <span
              className="ask-scope"
              title={wide ? "This ask may change anything in the part; what you right-clicked shows it where. You still accept or discard the result." : `What this ask may change (${scope.join(", ")}). The program enforces it.`}
              data-testid="ask-scope"
            >
              may change: {wide ? "anything in the part" : describeScope(scope)}
            </span>
          </footer>
          {!part && (
            <div className="ask-reach" role="radiogroup" aria-label="What the AI may change" data-testid="ask-reach">
              <span className="muted">May change</span>
              {(
                [
                  ["part", "The whole part"],
                  ["target", "Just this"],
                ] as const
              ).map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={reach === k} className={reach === k ? "on" : ""} onClick={() => setReach(k)} data-testid={`ask-reach-${k}`}>
                  {label}
                </button>
              ))}
            </div>
          )}
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
          {s.live ? (
            <LiveSteps live={s.live} />
          ) : (
            <ol className="ask-steps" data-testid="ask-steps">
              {s.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          )}
          <div className="ask-buttons">
            <span className="spinner" aria-hidden />
            <button onClick={ask.close} data-testid="ask-cancel">
              {s.live ? "Stop" : "Cancel"}
            </button>
          </div>
        </div>
      )}

      {s.phase === "done" && (
        <div className="ask-body">
          <blockquote className="ask-prompt">{s.prompt}</blockquote>
          {s.attachments?.length ? <div className="muted small" data-testid="ask-sent-attachments">Attached: {s.attachments.join(", ")}</div> : null}
          <div className={`ask-outcome ${s.result.outcome}`} data-testid="ask-outcome">
            {s.accepted ? "Applied" : s.result.detailPlan && !s.result.proposal ? "The detailing plan" : s.result.outcome === "questions" && s.result.review?.ready ? "Check the reading" : OUTCOME[s.result.outcome]}
          </div>
          {s.result.text && (
            <div className="ask-text" data-testid="ask-text">
              {s.result.text}
            </div>
          )}
          {(() => {
            const found = issuesOf({ askId: "", at: "", model: "", prompt: "", target: "", part: "", calls: s.result.calls, notices: (s.result as { notices?: string[] }).notices ?? [] });
            if (!found.length) return null;
            const reports = found.filter((i) => i.kind === "report").length;
            return (
              <div className="muted small ask-issues-note" data-testid="ask-issues-note">
                {found.length} tool issue{found.length === 1 ? "" : "s"} logged{reports ? ` (${reports} reported by the AI)` : ""}: see Tool issues in this window to copy them into a report.
              </div>
            );
          })()}
          {s.result.outcome === "questions" && s.result.review && (
            <IntentCard review={s.result.review} drawing={ctx.drawing} views={s.result.views} onBuild={(answers) => ask.answer(s, answers)} />
          )}
          {s.result.detailPlan && !s.result.proposal && !s.accepted && (
            <DetailPlanCard plan={s.result.detailPlan} aiReady={ready} aiLabel={ask.settings.provider === "claude-code" ? (ask.settings.bridge.engine === "grok" ? "Detail with Grok Build" : ask.settings.bridge.engine === "claude" ? "Detail with Claude Code" : "Detail with AI (bridge)") : "Detail with AI"} onRun={(plan, how) => ask.detail(s, plan, how)} />
          )}
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
          {s.result.proposal && (!s.result.proposal.replace || s.result.proposal.bridge) && (
            <div className="ask-proposal" data-testid="ask-proposal">
              <ul className="ask-changes">
                {s.result.proposal.changes.flatMap((c) => changeLines(c)).map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
              {s.result.proposal.volumeBefore !== null && s.result.proposal.volumeAfter !== null && s.result.proposal.changes.some((c) => !c.what) && (
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
                  {s.result.proposal.replace && !s.result.proposal.bridge && s.result.proposal.base.features.length ? "Accept: replace the part" : "Accept"}
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
                <button onClick={() => ask.open(ctx, "", s.recordId)} data-testid="ask-follow-up" title="Ask more about this, with this conversation">
                  Follow up
                </button>
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

const STEP_ICON: Record<LiveState["steps"][number]["status"], string> = { running: "…", ok: "✓", error: "✗" };

/** Claude Code at work: each tool call with its state, what it is saying now, and how many versions of the part came back. */
function LiveSteps({ live }: { live: LiveState }) {
  const end = useRef<HTMLLIElement>(null);
  useEffect(() => {
    // Braces: newer browsers return a promise from scrollIntoView, and an effect must return nothing or a cleanup function.
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [live.steps.length]);
  return (
    <div className="ask-live" data-testid="ask-live">
      <div className="muted small" data-testid="ask-live-status">
        {live.phase === "connecting" ? "Connecting to the bridge…" : `Claude Code is working${live.model ? ` (${live.model})` : ""}`}
        {live.updates > 0 ? ` · the view shows its work (${live.updates} update${live.updates === 1 ? "" : "s"}); your edits wait until it finishes` : ""}
      </div>
      <ol className="ask-live-steps" data-testid="ask-live-steps">
        {live.steps.map((st) => (
          <li key={st.id} className={`ask-live-step ${st.status}`} title={st.error ?? st.args} data-testid="ask-live-step">
            <span className="ask-live-icon" aria-label={st.status}>
              {STEP_ICON[st.status]}
            </span>{" "}
            <span className="ask-live-name">{st.name}</span>
            {st.args && <span className="ask-live-args"> {st.args}</span>}
            {st.error && <div className="ask-live-error">{st.error}</div>}
          </li>
        ))}
        <li ref={end} className="ask-live-end" aria-hidden />
      </ol>
      {live.text.trim() && (
        <div className="ask-text ask-live-text" data-testid="ask-live-text">
          {live.text}
        </div>
      )}
      {live.notices.map((n, i) => (
        <div key={i} className="ask-note">
          {n}
        </div>
      ))}
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

const STATUS: Record<HistoryEntry["status"], string> = { open: "not decided", accepted: "accepted", discarded: "discarded", none: "" };

/** This document's earlier requests: newest first; one opened to read again, with Follow up. */
function HistoryView({ entries, reading, onRead, onFollowUp, onClear }: { entries: HistoryEntry[]; reading: string | null; onRead(id: string | null): void; onFollowUp(id: string): void; onClear(): void }) {
  if (!entries.length) return <p className="muted small ask-body" data-testid="ask-history-empty">No requests yet on this part. Each one you make is kept here, in this browser.</p>;
  const open = reading ? entries.find((e) => e.id === reading) : undefined;
  if (open) {
    const thread = threadOf(entries, open.id);
    return (
      <div className="ask-body ask-history-entry" data-testid="ask-history-entry">
        {thread.map((e) => (
          <div key={e.id} className="ask-history-turn">
            <div className="muted small">
              {new Date(e.at).toLocaleString()} · {e.label} · {e.model}
            </div>
            <blockquote className="ask-prompt">{e.prompt}</blockquote>
            {e.attachments.length > 0 && <div className="muted small">Attached: {e.attachments.join(", ")}</div>}
            {e.reply && <div className="ask-text">{e.reply}</div>}
            {e.calls.length > 0 && (
              <details className="small">
                <summary>{e.calls.length} tool call{e.calls.length === 1 ? "" : "s"}</summary>
                <ul className="ask-calls">
                  {e.calls.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </details>
            )}
            {e.changes.length > 0 && (
              <ul className="ask-changes">
                {e.changes.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            )}
            <div className={`ask-outcome ${e.outcome}`}>
              {OUTCOME[e.outcome]}
              {STATUS[e.status] ? ` · ${STATUS[e.status]}` : ""}
            </div>
          </div>
        ))}
        <div className="ask-buttons">
          <button className="primary" onClick={() => onFollowUp(open.id)} data-testid="ask-history-follow">
            Follow up
          </button>
          <button onClick={() => onRead(null)} data-testid="ask-history-back">
            Back to the list
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="ask-body">
      <ol className="ask-history" data-testid="ask-history-list">
        {[...entries].reverse().map((e, i) => (
          <li key={e.id}>
            <button className="link" onClick={() => onRead(e.id)} data-testid={`ask-history-${i}`} title={new Date(e.at).toLocaleString()}>
              <span className="ask-history-prompt">{e.prompt}</span>
              <span className="muted small">
                {" "}
                · {e.label} · {OUTCOME[e.outcome]}
                {STATUS[e.status] ? `, ${STATUS[e.status]}` : ""}
                {e.attachments.length ? ` · ${e.attachments.length} attached` : ""}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <div className="ask-buttons">
        <button
          onClick={() => {
            const url = URL.createObjectURL(new Blob([JSON.stringify(entries, null, 1)], { type: "application/json" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = "cocaide-ai-history.json";
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
          data-testid="ask-history-download"
          title="The history as a JSON file to keep beside the part (it is not saved in the part file)"
        >
          Download
        </button>
        <button onClick={onClear} data-testid="ask-history-clear">
          Clear history
        </button>
      </div>
    </div>
  );
}

function fmt(x: number): string {
  return x.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

/** The tool-issue log: alike problems grouped, newest groups' examples, and the report to copy or download. */
function ToolIssuesView({ version, onClear }: { version: number; onClear(): void }) {
  const [copied, setCopied] = useState(false);
  void version;
  const list = readIssues();
  if (!list.length)
    return (
      <p className="muted small ask-body" data-testid="ask-issues-empty">
        No tool issues yet. When the AI hits a problem with Cocaide's tools (a call that fails, or something it reports as a bug or a missing tool), it is kept here
        across parts, so you can copy them all into one report for Cocaide's developers.
      </p>
    );
  const groups = groupIssues(list);
  const report = () => issuesReport(list, { app: location.origin + location.pathname, when: new Date().toISOString().slice(0, 16).replace("T", " ") });
  const download = (name: string, text: string, type: string) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="ask-body ask-issues" data-testid="ask-issues">
      <p className="muted small">
        {list.length} issue{list.length === 1 ? "" : "s"} in {groups.length} group{groups.length === 1 ? "" : "s"}, kept in this browser. Copy the report and paste it
        to whoever works on Cocaide (a coding assistant reads it as it is).
      </p>
      <ol className="ask-issue-groups" data-testid="ask-issue-groups">
        {groups.slice(0, 40).map((g) => {
          const e = g.examples[0];
          return (
            <li key={g.key} className={`ask-issue ${g.kind}`} data-testid="ask-issue" title={e.input ? `Input: ${e.input}` : undefined}>
              <span className="ask-issue-tool">{g.kind === "report" ? "AI report" : g.kind === "notice" ? "bridge" : "failed"} · {g.tool ?? "—"}</span>
              {g.count > 1 && <span className="ask-issue-count"> ×{g.count}</span>}
              <div className="ask-issue-problem">{e.problem}</div>
              {e.suggestion && <div className="muted small">Suggestion: {e.suggestion}</div>}
              <div className="muted small">
                {new Date(g.last).toLocaleString()} · {e.part} · “{e.prompt.slice(0, 80)}”
              </div>
            </li>
          );
        })}
      </ol>
      <div className="ask-buttons">
        <button
          className="primary"
          onClick={() => {
            void navigator.clipboard?.writeText(report()).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
          data-testid="ask-issues-copy"
          title="The whole log as one Markdown report, grouped, with examples"
        >
          {copied ? "Copied" : "Copy report"}
        </button>
        <button onClick={() => download("cocaide-tool-issues.md", report(), "text/markdown")} data-testid="ask-issues-download">
          Download report
        </button>
        <button onClick={() => download("cocaide-tool-issues.json", JSON.stringify(list, null, 1), "application/json")} data-testid="ask-issues-json" title="Every issue as JSON">
          JSON
        </button>
        <button onClick={onClear} data-testid="ask-issues-clear">
          Clear
        </button>
      </div>
    </div>
  );
}
