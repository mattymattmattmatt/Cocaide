// The right-click ask, as the UI holds it: menu -> running -> result, then
// accept or discard. Proposals are accept-gated unless "apply immediately"
// was ticked for that prompt. A user edit to a feature an open proposal
// touches drops the proposal and keeps the prompt (spec 6.4).

import { useCallback, useEffect, useRef, useState } from "react";
import { applyProposal, conflictsWith, hashDoc, runAsk, type AskEvent, type AskReach } from "../../ask/agent";
import type { KernelPort } from "../../ask/kernel";
import type { AskTarget, PacketKind } from "../../ask/packet";
import type { Drawing, PartAskResult, Photo } from "../../ask/part";
import type { RawDocument } from "../../doc/commands";
import type { SketchFeature } from "../../doc/types";
import type { LibraryEntry } from "../../weldment/library";
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
  | { phase: "menu"; ctx: AskContext; draft: string }
  | { phase: "running"; ctx: AskContext; prompt: string; applyNow: boolean; steps: string[] }
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

  const open = useCallback((ctx: AskContext, draft = "") => {
    abort.current?.abort();
    setState({ phase: "menu", ctx, draft });
  }, []);

  const close = useCallback(() => {
    abort.current?.abort();
    setState((s) => {
      if (s?.phase === "done" && s.result.proposal && !s.accepted) updateAsk(s.recordId, { discarded: { at: new Date().toISOString(), reason: "closed" } });
      return null;
    });
  }, []);

  const accept = useCallback(
    async (s: Extract<AskState, { phase: "done" }>) => {
      const p = s.result.proposal;
      if (!p) return;
      if (s.ctx.sketch) {
        const f = p.doc.features.find((x) => x.id === s.ctx.sketch!.id) as unknown as SketchFeature | undefined;
        if (f) s.ctx.sketch.apply(f);
        updateAsk(s.recordId, { accepted: { at: new Date().toISOString(), hash: await hashDoc(p.doc) } });
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
      setState({ ...s, accepted: true, preview: false });
    },
    [replaceDoc],
  );

  const submit = useCallback(
    async (ctx: AskContext, prompt: string, applyNow: boolean, reach: AskReach = settings.reach) => {
      const text = prompt.trim();
      if (!text) return;
      if (!canAsk(settings)) {
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
      const model = await modelFor(settings);
      // The part-level prompt (intent schema, planner) loads on first use.
      const result: PartAskResult =
        ctx.target.kind === "part"
          ? await (await import("../../ask/part")).runPartAsk({ doc: ctx.doc, text, drawing: ctx.drawing, photo: ctx.photo, model, kernel, library, signal: controller.signal, onEvent: (e) => e.type !== "intent" && onEvent(e) })
          : await runAsk({ doc: ctx.doc, target: ctx.target, text, model, kernel, reach, signal: controller.signal, onEvent });
      if (controller.signal.aborted) return;
      const recordId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
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
      const done: Extract<AskState, { phase: "done" }> = { phase: "done", ctx, prompt: text, applyNow, result, recordId, preview: true, accepted: false };
      setState(done);
      // From empty space a change is always a proposal (spec 6.2): never applied immediately.
      if (applyNow && result.proposal && ctx.target.kind !== "part") await accept(done);
    },
    [settings, kernel, accept, library],
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
      setState({ ...s, result, preview: true, accepted: false, dropped: undefined, error: undefined });
    },
    [settings, kernel, library],
  );

  const discard = useCallback(() => {
    setState((s) => {
      if (s?.phase === "done") updateAsk(s.recordId, { discarded: { at: new Date().toISOString() } });
      return null;
    });
  }, []);

  const togglePreview = useCallback(() => setState((s) => (s?.phase === "done" ? { ...s, preview: !s.preview } : s)), []);

  // Spec 6.4: the user's edit wins. A proposal on a feature the user has since changed is dropped.
  useEffect(() => {
    if (!doc || state?.phase !== "done" || state.accepted || !state.result.proposal || state.ctx.sketch) return;
    const hit = conflictsWith(state.result.proposal, doc);
    if (!hit.length) return;
    updateAsk(state.recordId, { discarded: { at: new Date().toISOString(), reason: `user edited ${hit.join(", ")}` } });
    setState({
      ...state,
      result: { ...state.result, proposal: null },
      preview: false,
      dropped: `You changed ${hit.join(", ")}, so the proposal was dropped. Your prompt is kept: run it again.`,
    });
  }, [doc, state]);

  /** The document to show while a proposal is open and previewed. */
  const previewDoc = state?.phase === "done" && state.preview && !state.accepted && !state.ctx.sketch ? (state.result.proposal?.doc ?? null) : null;

  return { state, open, close, submit, answer, accept, discard, togglePreview, previewDoc, settings, setSettings, settingsOpen, setSettingsOpen };
}
