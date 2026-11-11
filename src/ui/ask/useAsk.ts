// The right-click ask, as the UI holds it: menu -> running -> result, then
// accept or discard. Proposals are accept-gated unless "apply immediately"
// was ticked for that prompt. A user edit to a feature an open proposal
// touches drops the proposal and keeps the prompt (spec 6.4).

import { recordAskIssues } from "./toolIssues";
import { useCallback, useEffect, useRef, useState } from "react";
import { applyProposal, conflictsWith, hashDoc, runAsk, type AskEvent, type AskReach } from "../../ask/agent";
import type { DetailPlan } from "../../ask/detail/plan";
import { isDetailRequest } from "../../ask/prompt";
import type { KernelPort } from "../../ask/kernel";
import type { AskTarget, PacketKind } from "../../ask/packet";
import type { Drawing, PartAskResult, Photo } from "../../ask/part";
import type { RawDocument } from "../../doc/commands";
import type { SketchFeature } from "../../doc/types";
import type { LibraryEntry } from "../../weldment/library";
import type { Attachment } from "../../ask/attachments";
import type { LiveState } from "../../ask/bridge/run";
import { formatDocument } from "../../doc/format";
import { addHistory, clearHistory, docKey, earlierOf, entryOf, historyOf, loadDraft, saveDraft, threadOf, updateHistory, type HistoryEntry } from "./history";
import { logAsk, updateAsk } from "./log";
import { canAsk, loadSettings, modelFor, saveSettings, type AskSettings } from "./settings";

export interface AskContext {
  target: AskTarget;
  /** What the menu calls it: "hole_1", "this flat face". */
  label: string;
  /** Which scoped actions to offer. */
  kind: PacketKind;
  /** The document the ask runs on. In the sketcher it holds the draft sketch. */
  doc: RawDocument;
  /** In the sketcher, accepting updates the draft instead of the document. */
  sketch?: { id: string; apply(feature: SketchFeature): void };
  /** A dropped drawing, for a part-level ask. */
  drawing?: Drawing;
  /** A dropped image, prepared as a photo too: the user picks which it is. */
  photo?: Photo;
  /** What a dropped image is read as. A PDF is always a drawing. */
  readAs?: "drawing" | "photo";
  x: number;
  y: number;
}

export type AskState =
  | { phase: "menu"; ctx: AskContext; draft: string; /** The history entry this request follows up. */ followUp?: string }
  | {
      phase: "running";
      ctx: AskContext;
      prompt: string;
      applyNow: boolean;
      steps: string[];
      /** Claude Code through the bridge: its live steps, words and working copy of the part. */
      live?: LiveState;
    }
  | {
      phase: "done";
      ctx: AskContext;
      prompt: string;
      applyNow: boolean;
      result: PartAskResult;
      recordId: string;
      preview: boolean;
      accepted: boolean;
      /** Why an open proposal was dropped (the user edited what it touched). */
      dropped?: string;
      error?: string;
      /** The names of the files sent with it. */
      attachments?: string[];
    };

interface Options {
  kernel: KernelPort;
  /** The user's document as it is now. */
  doc: RawDocument | null;
  replaceDoc(doc: RawDocument): void;
  /** The section library in this browser: what a frame is built from (Phase K). */
  library?: LibraryEntry[];
}

export function useAsk({ kernel, doc, replaceDoc, library }: Options) {
  const [state, setState] = useState<AskState | null>(null);
  const [settings, setSettingsState] = useState<AskSettings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;

  const setSettings = useCallback((s: AskSettings) => {
    saveSettings(s);
    setSettingsState(s);
  }, []);

  /** Bumped when the history changes, so the panel reads it again. */
  const [historyVersion, setHistoryVersion] = useState(0);
  const touchHistory = useCallback(() => setHistoryVersion((v) => v + 1), []);
  const setStatus = useCallback(
    (s: { ctx: AskContext; recordId: string }, status: HistoryEntry["status"]) => {
      updateHistory(docKey(s.ctx.doc), s.recordId, { status });
      touchHistory();
    },
    [touchHistory],
  );

  /** Opens the ask; with no text given, the unsent draft for this target comes back. */
  const open = useCallback((ctx: AskContext, draft = "", followUp?: string) => {
    abort.current?.abort();
    setState({ phase: "menu", ctx, draft: draft || loadDraft(docKey(ctx.doc), ctx.target), ...(followUp ? { followUp } : {}) });
  }, []);

  const close = useCallback(() => {
    abort.current?.abort();
    setState((s) => {
      if (s?.phase === "done" && s.result.proposal && !s.accepted) {
        updateAsk(s.recordId, { discarded: { at: new Date().toISOString(), reason: "closed" } });
        updateHistory(docKey(s.ctx.doc), s.recordId, { status: "discarded" });
      }
      return null;
    });
    touchHistory();
  }, [touchHistory]);

  const accept = useCallback(
    async (s: Extract<AskState, { phase: "done" }>) => {
      const p = s.result.proposal;
      if (!p) return;
      if (s.ctx.sketch) {
        const f = p.doc.features.find((x) => x.id === s.ctx.sketch!.id) as unknown as SketchFeature | undefined;
        if (f) s.ctx.sketch.apply(f);
        updateAsk(s.recordId, { accepted: { at: new Date().toISOString(), hash: await hashDoc(p.doc) } });
        setStatus(s, "accepted");
        setState({ ...s, accepted: true, preview: false });
        return;
      }
      const current = docRef.current;
      if (!current) return;
      const r = applyProposal(current, p);
      if (!r.ok) {
        setState({ ...s, error: `Could not apply the proposal to the document as it is now: ${r.error}` });
        return;
      }
      replaceDoc(r.doc);
      updateAsk(s.recordId, { accepted: { at: new Date().toISOString(), hash: await hashDoc(r.doc) } });
      setStatus(s, "accepted");
      setState({ ...s, accepted: true, preview: false });
    },
    [replaceDoc, setStatus],
  );

  const submit = useCallback(
    async (ctx: AskContext, prompt: string, applyNow: boolean, reach: AskReach = settings.reach, extra: { attachments?: Attachment[]; followUp?: string } = {}) => {
      const text = prompt.trim();
      if (!text) return;
      const dk = docKey(ctx.doc);
      const attachments = extra.attachments ?? [];
      // A follow-up carries its thread: what was asked, said and changed before.
      const earlier = extra.followUp ? earlierOf(threadOf(historyOf(dk), extra.followUp)) : [];
      // "Fully detail this drawing" (wave Q3B): first the plan by rules, as a card. It needs no model.
      const planning = (ctx.target.kind === "drawing" || ctx.target.kind === "sheet" || ctx.target.kind === "view") && isDetailRequest(text) && !extra.followUp;
      if (!planning && !canAsk(settings)) {
        setSettingsOpen(true);
        return;
      }
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      const steps: string[] = [];
      const show = () => setState({ phase: "running", ctx, prompt: text, applyNow, steps: [...steps] });
      show();
      const onEvent = (e: AskEvent) => {
        if (e.type === "packet") steps.push(e.mode === "explain" ? "Question: answering, no edits" : "Request: may propose an edit");
        else if (e.type === "thinking") steps.push(e.turn === 1 ? "Asking the model…" : "Model is checking the result…");
        else steps.push(`${e.name} ${e.ok ? "✓" : `✗ ${e.error ?? ""}`}`);
        if (!controller.signal.aborted) show();
      };
      // The text is sent: it is no longer a draft.
      saveDraft(dk, ctx.target, "");
      const more = { ...(attachments.length ? { attachments } : {}), ...(earlier.length ? { earlier } : {}) };
      let result: PartAskResult;
      let bridgeSession: string | undefined;
      if (planning) {
        steps.push("Planning the detailing from the part…");
        show();
        const { planDetailAsk } = await import("../../ask/detail/run");
        result = await planDetailAsk(ctx.doc, ctx.target as Parameters<typeof planDetailAsk>[1], kernel, settings.provider === "claude-code" ? (settings.bridge.engine === "grok" ? "Grok Build" : "Claude Code") : settings.provider === "ollama" ? "Ollama" : "Claude");
      } else if (settings.provider === "claude-code") {
        // Claude Code runs the whole ask through the bridge; a follow-up continues its session.
        const thread = extra.followUp ? threadOf(historyOf(dk), extra.followUp) : [];
        const resume = [...thread].reverse().find((e) => e.bridgeSession)?.bridgeSession;
        const { runBridgeAsk } = await import("../../ask/bridge/run");
        // A dropped drawing or photo goes as files Claude Code reads: each rendered page (and the text layer), or the photo.
        const dropped: Attachment[] = [
          ...(ctx.drawing && !ctx.photo
            ? [
                ...ctx.drawing.pages.map((pg, i): Attachment => ({ id: `drawing-${i}`, name: `${ctx.drawing!.name}-page${i + 1}.png`, kind: "image", mediaType: "image/png", size: pg.png.length, data: pg.png })),
                ...(ctx.drawing.text ? [{ id: "drawing-text", name: `${ctx.drawing.name} (text layer)`, kind: "text" as const, mediaType: "text/plain", size: ctx.drawing.text.length, text: ctx.drawing.text }] : []),
              ]
            : []),
          ...(ctx.photo ? [{ id: "photo", name: ctx.photo.name.replace(/\.\w+$/, "") + ".jpg", kind: "image" as const, mediaType: ctx.photo.mediaType, size: ctx.photo.data.length, data: ctx.photo.data }] : []),
        ];
        const r = await runBridgeAsk({
          doc: ctx.doc,
          target: ctx.target,
          text,
          reach,
          kernel,
          bridge: settings.bridge,
          signal: controller.signal,
          ...more,
          ...(dropped.length ? { attachments: [...attachments, ...dropped] } : {}),
          ...(resume ? { resume } : {}),
          onLive: (live) => !controller.signal.aborted && setState({ phase: "running", ctx, prompt: text, applyNow, steps: [], live }),
        });
        bridgeSession = r.sessionId;
        result = r;
      } else {
        const model = await modelFor(settings);
        // The part-level prompt (intent schema, planner) loads on first use.
        result =
          ctx.target.kind === "part"
            ? await (await import("../../ask/part")).runPartAsk({ doc: ctx.doc, text, drawing: ctx.drawing, photo: ctx.photo, model, kernel, library, signal: controller.signal, onEvent: (e) => e.type !== "intent" && onEvent(e), ...more })
            : await runAsk({ doc: ctx.doc, target: ctx.target, text, model, kernel, reach, signal: controller.signal, onEvent, ...more });
      }
      if (controller.signal.aborted) return;
      const recordId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const names = [...attachments.map((a) => a.name), ...(ctx.drawing && !ctx.photo ? [ctx.drawing.name] : []), ...(ctx.photo ? [ctx.photo.name] : [])];
      addHistory(dk, { ...entryOf(result, { id: recordId, at: new Date().toISOString(), label: ctx.label, target: ctx.target, prompt: text, attachments: names, ...(extra.followUp ? { followUpOf: extra.followUp } : {}) }), ...(bridgeSession ? { bridgeSession } : {}) });
      touchHistory();
      // Problems with the tools (failed calls, the AI's own reports, the bridge's notices) go to the tool-issue log.
      recordAskIssues({ askId: recordId, at: new Date().toISOString(), model: result.model, prompt: text, target: ctx.label, part: partName(ctx.doc), calls: result.calls, ...((result as { notices?: string[] }).notices ? { notices: (result as { notices?: string[] }).notices } : {}) });
      logAsk({
        id: recordId,
        at: new Date().toISOString(),
        target: ctx.target,
        label: ctx.label,
        prompt: text,
        model: result.model,
        mode: result.mode,
        outcome: result.outcome,
        text: result.text,
        baseHash: await hashDoc(ctx.doc),
        calls: result.calls,
        ...(ctx.drawing
          ? {
              drawing: {
                name: ctx.drawing.name,
                pages: ctx.drawing.pageCount,
                dpi: ctx.drawing.dpi,
                textLayer: ctx.drawing.text.length > 0,
                legibility: Math.round(ctx.drawing.legibility.score * 1000) / 1000,
              },
            }
          : {}),
        ...(ctx.photo ? { photo: { name: ctx.photo.name, sha256: ctx.photo.sha256, width: ctx.photo.width, height: ctx.photo.height } } : {}),
      });
      const done: Extract<AskState, { phase: "done" }> = { phase: "done", ctx, prompt: text, applyNow, result, recordId, preview: true, accepted: false, ...(names.length ? { attachments: names } : {}) };
      setState(done);
      // From empty space a change is always a proposal (spec 6.2): never applied immediately.
      if (applyNow && result.proposal && ctx.target.kind !== "part") await accept(done);
    },
    [settings, kernel, accept, library, touchHistory],
  );

  /** The user filled the confirmation card: build with their numbers. */
  const answer = useCallback(
    async (s: Extract<AskState, { phase: "done" }>, answers: Record<string, number | string | { x: number; y: number }[]>) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      const steps = ["Building with your numbers…"];
      setState({ phase: "running", ctx: s.ctx, prompt: s.prompt, applyNow: false, steps });
      const model = await modelFor(settings);
      const { continuePartAsk } = await import("../../ask/part");
      const result = await continuePartAsk({ doc: s.ctx.doc, text: s.prompt, drawing: s.ctx.drawing, model, kernel, library, signal: controller.signal }, s.result, answers);
      if (controller.signal.aborted) return;
      updateAsk(s.recordId, { outcome: result.outcome, text: result.text, calls: [...s.result.calls, ...result.calls], answers });
      recordAskIssues({ askId: s.recordId, at: new Date().toISOString(), model: result.model, prompt: s.prompt, target: s.ctx.label, part: partName(s.ctx.doc), calls: [...s.result.calls, ...result.calls] });
      const e = entryOf(result, { id: s.recordId, at: new Date().toISOString(), label: s.ctx.label, target: s.ctx.target, prompt: s.prompt, attachments: s.attachments ?? [] });
      updateHistory(docKey(s.ctx.doc), s.recordId, { outcome: e.outcome, reply: e.reply, calls: e.calls, changes: e.changes, status: e.status });
      touchHistory();
      setState({ ...s, result, preview: true, accepted: false, dropped: undefined, error: undefined });
    },
    [settings, kernel, library, touchHistory],
  );

  /** The user left the detailing plan as they want it: carried out by the model (it refines and checks), or by rules only. */
  const detail = useCallback(
    async (s: Extract<AskState, { phase: "done" }>, plan: DetailPlan, how: "ai" | "rules") => {
      if (how === "ai" && !canAsk(settings)) {
        setSettingsOpen(true);
        return;
      }
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      const steps = [how === "rules" ? "Detailing by rules…" : "Detailing: the plan first, then the model refines it…"];
      const show = () => setState({ phase: "running", ctx: s.ctx, prompt: s.prompt, applyNow: false, steps: [...steps] });
      show();
      const target = s.ctx.target as Parameters<typeof rulesDetailAsk>[1];
      const { rulesDetailAsk, detailInstructions } = await import("../../ask/detail/run");
      let result: PartAskResult;
      if (how === "rules") result = await rulesDetailAsk(s.ctx.doc, target, kernel, plan);
      else if (settings.provider === "claude-code") {
        // Claude Code drives the MCP tools: the plan as the user left it goes in the prompt (applyDetailPlan's skip and options).
        const { runBridgeAsk } = await import("../../ask/bridge/run");
        result = await runBridgeAsk({
          doc: s.ctx.doc,
          target: s.ctx.target,
          text: `${s.prompt}\n\n${detailInstructions(plan)}`,
          kernel,
          bridge: settings.bridge,
          signal: controller.signal,
          onLive: (live) => !controller.signal.aborted && setState({ phase: "running", ctx: s.ctx, prompt: s.prompt, applyNow: false, steps: [], live }),
        });
      } else {
        const model = await modelFor(settings);
        const onEvent = (e: AskEvent) => {
          if (e.type === "thinking") steps.push(e.turn === 1 ? "Asking the model…" : "Model is checking the result…");
          else if (e.type === "tool") steps.push(`${e.name} ${e.ok ? "✓" : `✗ ${e.error ?? ""}`}`);
          if (!controller.signal.aborted) show();
        };
        result = await runAsk({ doc: s.ctx.doc, target: s.ctx.target, text: s.prompt, model, kernel, detail: { plan }, signal: controller.signal, onEvent });
      }
      if (controller.signal.aborted) return;
      updateAsk(s.recordId, { outcome: result.outcome, text: result.text, calls: [...s.result.calls, ...result.calls] });
      recordAskIssues({ askId: s.recordId, at: new Date().toISOString(), model: result.model, prompt: s.prompt, target: s.ctx.label, part: partName(s.ctx.doc), calls: [...s.result.calls, ...result.calls] });
      const e = entryOf(result, { id: s.recordId, at: new Date().toISOString(), label: s.ctx.label, target: s.ctx.target, prompt: s.prompt, attachments: s.attachments ?? [] });
      updateHistory(docKey(s.ctx.doc), s.recordId, { outcome: e.outcome, reply: e.reply, calls: e.calls, changes: e.changes, status: e.status });
      touchHistory();
      setState({ ...s, result, preview: true, accepted: false, dropped: undefined, error: undefined });
    },
    [settings, kernel, touchHistory],
  );

  const discard = useCallback(() => {
    setState((s) => {
      if (s?.phase === "done") {
        updateAsk(s.recordId, { discarded: { at: new Date().toISOString() } });
        updateHistory(docKey(s.ctx.doc), s.recordId, { status: "discarded" });
      }
      return null;
    });
    touchHistory();
  }, [touchHistory]);

  const togglePreview = useCallback(() => setState((s) => (s?.phase === "done" ? { ...s, preview: !s.preview } : s)), []);

  // Spec 6.4: the user's edit wins. A proposal on a feature the user has since changed is dropped.
  useEffect(() => {
    if (!doc || state?.phase !== "done" || state.accepted || !state.result.proposal || state.ctx.sketch) return;
    const hit = conflictsWith(state.result.proposal, doc);
    if (!hit.length) return;
    updateAsk(state.recordId, { discarded: { at: new Date().toISOString(), reason: `user edited ${hit.join(", ")}` } });
    updateHistory(docKey(state.ctx.doc), state.recordId, { status: "discarded" });
    setState({
      ...state,
      result: { ...state.result, proposal: null },
      preview: false,
      dropped: `You changed ${hit.join(", ")}, so the proposal was dropped. Your prompt is kept: run it again.`,
    });
  }, [doc, state]);

  // While Claude Code works the user's edits wait (the app locks them); one that gets through anyway stops the ask.
  useEffect(() => {
    if (!doc || state?.phase !== "running" || !state.live || state.ctx.sketch || doc === state.ctx.doc) return;
    if (formatDocument(doc) === formatDocument(state.ctx.doc)) return;
    abort.current?.abort();
    setState({
      phase: "done",
      ctx: state.ctx,
      prompt: state.prompt,
      applyNow: false,
      result: { outcome: "failed", text: "", mode: "edit", visual: false, packet: null, proposal: null, calls: [], model: "Claude Code", turns: 0 },
      recordId: "",
      preview: false,
      accepted: false,
      error: "You changed the part while Claude Code was working, so the ask was stopped and its changes were not kept. Your prompt is kept: use Ask again.",
    });
  }, [doc, state]);

  /** Claude Code's working copy while it works (shown live), or an open proposal while it is previewed. */
  const liveDoc = state?.phase === "running" && !state.ctx.sketch ? (state.live?.doc ?? null) : null;
  /** The document to show while a proposal is open and previewed, or while Claude Code works on it. */
  const previewDoc = liveDoc ?? (state?.phase === "done" && state.preview && !state.accepted && !state.ctx.sketch ? (state.result.proposal?.doc ?? null) : null);
  /** Claude Code is working through the bridge: the user's edits wait. */
  const busy = state?.phase === "running" && !!state.live;

  /** The AI history of a document, and clearing it. */
  const history = useCallback((doc: RawDocument) => (void historyVersion, historyOf(docKey(doc))), [historyVersion]);
  const clear = useCallback(
    (doc: RawDocument) => {
      clearHistory(docKey(doc));
      touchHistory();
    },
    [touchHistory],
  );
  /** Keeps the unsent text of the open ask. */
  const keepDraft = useCallback((ctx: AskContext, text: string) => saveDraft(docKey(ctx.doc), ctx.target, text), []);

  return { busy, liveDoc, state, open, close, submit, answer, detail, accept, discard, togglePreview, previewDoc, settings, setSettings, settingsOpen, setSettingsOpen, history, clearHistory: clear, keepDraft };
}

/** The part's name, for the tool-issue log. */
function partName(doc: unknown): string {
  const n = (doc as { name?: unknown } | null)?.name;
  return typeof n === "string" && n.trim() ? n.trim() : "part";
}
