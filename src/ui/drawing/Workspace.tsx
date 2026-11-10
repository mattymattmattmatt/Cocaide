// The drawing workspace (Phase Q wave Q2B): the drawing's toolbar (View
// Layout, Annotation, Sketch, Tables, Sheet Format), the drawing tree on the
// left, the sheet in the middle with its tabs and status bar below, and the
// property panel on the right (an open tool's options with OK and Cancel,
// else what is selected, else the sheet). Selection is shared by the tree,
// the sheet and the panel; every edit is a command through the document, so
// undo, the assistant's scope and validation work as in the model.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AskTarget } from "../../ask/packet";
import type { DrawingGeometry, KernelPort } from "../../ask/kernel";
import type { Command, RawDocument } from "../../doc/commands";
import { nextSheetId } from "../../doc/drawing";
import type { Annotation, Drawing, DrawingSheet, Vec2, Vec3 } from "../../doc/types";
import type { ComposedSheet } from "../../drafting/compose";
import type { ViewSpec } from "../../kernel/drawingViews";
import type { Measurements } from "../../kernel/measure";
import type { Check } from "../../intent/critic";
import { ContextMenu, type ContextMenuState, type MenuEntry } from "../ContextMenu";
import { loadView } from "../evaluate/display";
import { Icon, type IconName } from "../icons";
import type { DocumentState } from "../useDocument";
import { ToolButton } from "../tools";
import { alignmentOf, attachSide } from "./align";
import { DrawingTree } from "./DrawingTree";
import { ExportDialog, FormatDialog, PropertiesDialog, TableDialog, TitleBlockDialog, type ExportOptions } from "./Dialogs";
import { DrawingPanel } from "./Panels";
import { SheetCanvas, type SheetStatus } from "./SheetCanvas";
import { SheetTabs } from "./SheetTabs";
import { snapIndex, type SnapIndex } from "./snap";
import { DRAWING_EDITS, fitViews, keepScale } from "../../drafting/fit";
import "./tools";
import { runAutoDimension } from "./tools/annotationTools";
import { annotationKey, annotationMenu } from "./tools/editing";
import { annotationKind } from "./tools/kinds";
import { drawingTool, menuEntriesFor, onToolsChanged, toolForKey, toolGroups } from "./tools/registry";
import { DRAWING_TABS, type DrawingDialog, type DrawingSession, type DrawingTab, type DrawingToolCtx, type SheetHit } from "./tools/types";
import { viewBody } from "./tools/session";

export interface WorkspaceProps {
  doc: RawDocument | null;
  /** The drawing as stored. */
  drawing: Drawing | null;
  /** Every sheet as composed (an open proposal's, while it is previewed). */
  sheets: ComposedSheet[];
  /** The sheet shown. */
  sheet: ComposedSheet | null;
  activeSheet: string | null;
  setActiveSheet(id: string | null): void;
  checks: Check[];
  measurements: Measurements | null;
  d: DocumentState;
  batch(cmds: Command[]): string | null;
  notice(text: string, kind?: "info" | "error"): void;
  ready: boolean;
  previewing: boolean;
  project(specs: ViewSpec[]): Promise<DrawingGeometry | null>;
  newDrawing(): void;
  balloonAll(): void;
  /** Opens the assistant on what was right-clicked. */
  openAsk(target: AskTarget, x: number, y: number, prompt?: { text: string; submit: boolean }): void;
  /** The kernel, for tools that compose the drawing themselves (Auto-detail, wave Q3B). */
  kernel?: KernelPort;
  /** The drawing's views as projected (Fit views composes the sheet afresh with them). */
  geometry?: DrawingGeometry | null;
  /** Writes an export: what the Export dialog asked for. */
  exportDrawing(kind: "pdf" | "svg" | "dxf" | "png", opts?: ExportOptions): void;
  /** The document's name, for the 3D view's orientation it left. */
  docName: string | null;
  /** The part's bodies (a view shows some of them). */
  bodies: string[];
  /** The workspace is on screen (Drawing mode, no sketch open): its keys work only then. */
  active: boolean;
}

export type Workspace = ReturnType<typeof useDrawingWorkspace>;

const TAB_KEY = "cocaide.drawingTab.v1";

/** The commands that edit the drawing (the first of them on a sheet stored without a scale stores the one it shows). */

export function useDrawingWorkspace(p: WorkspaceProps) {
  const [selection, setSelection] = useState<string[]>([]);
  const [session, setSession] = useState<DrawingSession | null>(null);
  const [tick, setTick] = useState(0);
  const [dialog, setDialog] = useState<{ name: DrawingDialog; arg?: string } | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [status, setStatus] = useState<SheetStatus>({ at: null, snap: null, zoom: 100 });
  const [fitToken, setFitToken] = useState(0);
  const [zoomAreaToken, setZoomAreaToken] = useState(0);
  const [grid, setGrid] = useState(false);
  const [tab, setTabState] = useState<DrawingTab>(() => {
    try {
      const t = localStorage.getItem(TAB_KEY);
      return (DRAWING_TABS.find((x) => x.id === t)?.id ?? "layout") as DrawingTab;
    } catch {
      return "layout";
    }
  });
  const setTab = (t: DrawingTab) => {
    setTabState(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      // Private windows may refuse: the tab still holds for this visit.
    }
  };
  const [, setToolsVersion] = useState(0);
  useEffect(() => onToolsChanged(() => setToolsVersion((n) => n + 1)), []);
  const clipboard = useRef<Record<string, unknown>[]>([]);
  const scaleRef = useRef(1);

  const sheetDoc: DrawingSheet | null = p.drawing ? (p.drawing.sheets.find((s) => s.id === p.sheet?.id) ?? p.drawing.sheets.find((s) => s.id === p.activeSheet) ?? p.drawing.sheets[0]) : null;
  const snap = useMemo<SnapIndex | null>(() => (p.sheet ? snapIndex(p.sheet) : null), [p.sheet]);

  // What is selected and is gone (undo, delete) is let go.
  useEffect(() => {
    if (!p.drawing) return setSelection((s) => (s.length ? [] : s));
    const ids = new Set(p.drawing.sheets.flatMap((s) => [...s.views.map((v) => v.id), ...s.annotations.map((a) => a.id), ...(s.tables ?? []).map((t) => t.id)]));
    setSelection((s) => (s.every((id) => ids.has(id)) ? s : s.filter((id) => ids.has(id))));
  }, [p.drawing]);

  /**
   * A sheet stored without a scale (made before Phase Q wave Q4) keeps the one
   * it shows: the first edit of it stores that scale with it (one undo step),
   * so that from then on moving views can never change it.
   */
  const scaleToKeep = (cmds: Command[] | null): Command[] => {
    const { p, sheetDoc } = live.current;
    if (!sheetDoc || !p.sheet || p.previewing) return [];
    if (cmds && !cmds.some((c) => DRAWING_EDITS.has(c.type))) return [];
    if (cmds?.some((c) => c.type === "setDrawing" || (c.type === "setSheet" && "scale" in c.patch) || (c.type === "deleteSheet" && c.id === sheetDoc.id))) return [];
    return keepScale(sheetDoc, p.sheet);
  };
  const keepingScale = (cmds: Command[]): Command[] => [...scaleToKeep(cmds), ...cmds];
  const run = useCallback(
    (cmd: Command): string | null => {
      const all = keepingScale([cmd]);
      const problem = all.length > 1 ? p.batch(all) : p.d.dispatch(cmd);
      if (problem) p.notice(problem, "error");
      return problem;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p],
  );
  const batch = (cmds: Command[]): string | null => {
    if (!cmds.length) return null;
    if (cmds.length === 1) return run(cmds[0]);
    const problem = p.batch(keepingScale(cmds));
    if (problem) p.notice(problem, "error");
    return problem;
  };

  const nextId = (prefix: string, taken: Set<string> = new Set()): string => {
    const d = p.drawing;
    const used = new Set([...taken, ...(d?.sheets ?? []).flatMap((s) => [...s.views.map((v) => v.id), ...s.annotations.map((a) => a.id), ...(s.tables ?? []).map((t) => t.id)])]);
    let n = 1;
    for (const id of used) {
      const m = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)$`).exec(id);
      if (m) n = Math.max(n, Number(m[1]) + 1);
    }
    while (used.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  };

  // A session ends with its transaction (an undo past its start, a new document).
  const opened = useRef(false);
  useEffect(() => {
    if (p.d.transaction) opened.current = true;
    else if (session && opened.current) {
      opened.current = false;
      setSession(null);
    }
  }, [p.d.transaction, session]);

  const nextIdRef = useRef(nextId);
  nextIdRef.current = nextId;
  const batchRef = useRef(batch);
  batchRef.current = batch;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const live = useRef({ p, selection, snap, sheetDoc });
  live.current = { p, selection, snap, sheetDoc };
  const ctx = useCallback(
    (): DrawingToolCtx => {
      const { p, selection, snap, sheetDoc } = live.current;
      return {
        doc: p.doc!,
        drawing: p.drawing!,
        sheetDoc: sheetDoc!,
        sheet: p.sheet,
        measurements: p.measurements,
        snap,
        selection,
        run,
        // The latest batch (it reads the document as it is now, not as it was when the context was made).
        batch: (cmds) => batchRef.current(cmds),
        begin: (label) => {
          const keep = scaleToKeep(null);
          const problem = p.d.begin(label);
          if (!problem) {
            opened.current = true;
            // The session's edits are on a sheet that keeps the scale it showed (inside its transaction: Cancel takes it back too).
            for (const cmd of keep) p.d.dispatch(cmd);
          }
          return problem;
        },
        live: (cmd) => p.d.dispatch(cmd),
        commit: (label) => {
          opened.current = false;
          p.d.commit(label);
        },
        rollback: () => {
          opened.current = false;
          p.d.rollback();
        },
        inTransaction: () => !!live.current.p.d.transaction,
        nextId: (prefix) => nextIdRef.current(prefix),
        select: (ids) => setSelection(ids),
        notice: (text, kind = "info") => p.notice(text, kind),
        refresh: () => setTick((n) => n + 1),
        project: p.project,
        camera: () => {
          const cam = p.docName ? loadView(p.docName).camera : undefined;
          if (!cam) return null;
          const e: Vec3 = [cam.position[0] - cam.target[0], cam.position[1] - cam.target[1], cam.position[2] - cam.target[2]];
          const l = Math.hypot(...e);
          if (l < 1e-9) return null;
          const eye = e.map((x) => Math.round((x / l) * 1e6) / 1e6) as Vec3;
          // Up, square to the eye.
          const u = cam.up;
          const dot = u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2];
          const up0: Vec3 = [u[0] - dot * eye[0], u[1] - dot * eye[1], u[2] - dot * eye[2]];
          const ul = Math.hypot(...up0);
          const up = (ul < 1e-6 ? [0, 1, 0] : up0.map((x) => Math.round((x / ul) * 1e6) / 1e6)) as Vec3;
          return { eye, up };
        },
        mmPerPx: () => scaleRef.current,
        end: () => {
          setSession(null);
          setTick((n) => n + 1);
        },
        startSession: (s) => {
          const cur = sessionRef.current;
          if (cur && cur !== s) cur.cancel();
          setSession(s);
          setMenu(null);
        },
        dialog: (name, arg) => setDialog({ name, arg }),
        actions: { newDrawing: p.newDrawing, balloonAll: p.balloonAll, fitViews: () => fitViewsRef.current(), ask: (target, text, submit) => p.openAsk(target, 0, 0, { text, submit }), ...(p.kernel ? { kernel: p.kernel } : {}) },
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const startTool = (id: string) => {
    const t = drawingTool(id);
    if (!t || !p.drawing || !sheetDoc) return;
    const why = t.disabled?.(ctx());
    if (why) return p.notice(why, "error");
    if (session) session.cancel();
    const s = t.run(ctx);
    setSession(s ?? null);
    setMenu(null);
  };
  const ok = () => {
    if (!session) return;
    const why = session.ok();
    if (why) p.notice(why, "error");
  };
  const cancel = () => session?.cancel();

  const select = (ids: string[], add = false) => {
    setSelection((cur) => (add ? [...cur.filter((x) => !ids.includes(x)), ...ids.filter((x) => !cur.includes(x))] : ids));
    // An item on another sheet: that sheet is shown.
    if (ids.length && p.drawing) {
      const holder = p.drawing.sheets.find((s) => s.views.some((v) => v.id === ids[0]) || s.annotations.some((a) => a.id === ids[0]) || (s.tables ?? []).some((t) => t.id === ids[0]));
      if (holder && holder.id !== p.sheet?.id) p.setActiveSheet(holder.id);
    }
  };

  // ------------------------------------------------------------ edits of the selection

  const deleteIds = (ids: string[]) => {
    if (!p.drawing || !ids.length) return;
    const views = new Set(ids.filter((id) => p.drawing!.sheets.some((s) => s.views.some((v) => v.id === id))));
    const tables = new Set(ids.filter((id) => p.drawing!.sheets.some((s) => (s.tables ?? []).some((t) => t.id === id))));
    const anns = ids.filter((id) => !views.has(id) && !tables.has(id));
    const goneWithViews = new Set(p.drawing.sheets.flatMap((s) => s.annotations.filter((a) => "view" in a && !!a.view && views.has(a.view)).map((a) => a.id)));
    const cmds: Command[] = [
      ...anns.filter((id) => !goneWithViews.has(id)).map((id): Command => ({ type: "setAnnotation", id, annotation: null })),
      ...[...tables].map((id): Command => ({ type: "setTable", id, table: null })),
      // Children first, then parents (a parent's delete takes its children: their own would fail).
      ...[...views].filter((id) => !p.drawing!.sheets.some((s) => s.views.some((v) => v.id === id && v.parent && views.has(v.parent)))).map((id): Command => ({ type: "setView", id, view: null })),
    ];
    if (!batch(cmds)) {
      setSelection([]);
      p.notice(`Deleted ${ids.length === 1 ? ids[0] : `${ids.length} items`}. Ctrl+Z brings ${ids.length === 1 ? "it" : "them"} back.`);
    }
  };

  const copy = () => {
    if (!sheetDoc) return;
    const anns = sheetDoc.annotations.filter((a) => selection.includes(a.id));
    if (!anns.length) return p.notice("Select annotations to copy (views and tables are copied as new views or tables).");
    clipboard.current = anns.map((a) => structuredClone(a) as unknown as Record<string, unknown>);
    p.notice(`Copied ${anns.length} annotation${anns.length === 1 ? "" : "s"}: Ctrl+V pastes ${anns.length === 1 ? "it" : "them"} beside.`);
  };
  const paste = () => {
    if (!sheetDoc || !p.sheet || !clipboard.current.length) return;
    const taken = new Set<string>();
    const cmds: Command[] = [];
    const ids: string[] = [];
    for (const a of clipboard.current) {
      const k = annotationKind(String(a.type));
      if (typeof a.view === "string" && !sheetDoc.views.some((v) => v.id === a.view)) continue;
      const id = nextId(k?.prefix ?? "a", taken);
      taken.add(id);
      ids.push(id);
      const said = p.sheet.annotations.find((x) => x.id === a.id);
      let next: Record<string, unknown> = { ...a };
      if (k?.paste) next = k.paste(a, [10, -10], { sheet: p.sheet, said });
      else if (Array.isArray(a.at) && typeof a.at[0] === "number") next.at = [(a.at as Vec2)[0] + 10, (a.at as Vec2)[1] - 10];
      delete next.id;
      cmds.push({ type: "setAnnotation", id, annotation: next, sheet: sheetDoc.id });
    }
    if (!cmds.length) return p.notice("What was copied belongs to views not on this sheet.", "error");
    if (!batch(cmds)) setSelection(ids);
  };

  // ------------------------------------------------------------ the keyboard on the sheet

  useEffect(() => {
    if (!p.active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]") || document.querySelector(".modal-backdrop, .context-menu, .drawing-dialog")) return;
      if (session?.key?.(e)) return e.preventDefault();
      if (!session && annotationKey(e, ctx())) return e.preventDefault();
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") {
        if (session) {
          e.preventDefault();
          return cancel();
        }
        return setSelection([]);
      }
      if (e.key === "Enter" && session && !t.closest("button")) {
        e.preventDefault();
        return ok();
      }
      if ((e.key === "Delete" || e.key === "Backspace") && !session && selection.length) {
        e.preventDefault();
        return deleteIds(selection);
      }
      if (mod && e.key.toLowerCase() === "c" && !session) {
        e.preventDefault();
        return copy();
      }
      if (mod && e.key.toLowerCase() === "v" && !session) {
        e.preventDefault();
        return paste();
      }
      if (mod || e.altKey) return;
      if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        return setFitToken((n) => n + 1);
      }
      const tool = e.key.length === 1 ? toolForKey(e.key) : undefined;
      if (tool && !session) {
        e.preventDefault();
        startTool(tool.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ------------------------------------------------------------ right-click menus

  const ask = (target: AskTarget, x: number, y: number) => {
    if (session) return p.notice("Finish the tool first: OK or Cancel.", "error");
    const extra = selection.length > 1 || (selection.length === 1 && !("id" in target && target.id === selection[0])) ? { selection } : {};
    p.openAsk({ ...target, ...extra } as AskTarget, x, y);
  };
  const askEntry = (target: AskTarget, x: number, y: number): MenuEntry => ({ label: "Ask AI…", icon: "ask", hint: "Ask the assistant about this, or to change it", onClick: () => ask(target, x, y), testId: "ctx-ask" });

  const menuFor = (hit: SheetHit | null, x: number, y: number, from: "sheet" | "tree" = "sheet", at?: Vec2) => {
    if (!p.drawing || !sheetDoc) return;
    if (hit && hit.kind !== "titleBlock" && !selection.includes(hit.id)) setSelection([hit.id]);
    let title = "Drawing";
    let items: MenuEntry[] = [];
    if (hit?.kind === "view") {
      const v = p.drawing.sheets.flatMap((s) => s.views).find((x) => x.id === hit.id);
      if (!v) return;
      title = `View ${v.id}`;
      const al = alignmentOf(v, sheetDoc.views, sheetDoc.projection);
      const alignable = (v.kind === "projected" || v.kind === "section") && v.parent;
      const free = (v as { free?: boolean }).free;
      const locked = (v as { locked?: boolean }).locked;
      const set = (patch: Record<string, unknown>) => run({ type: "setView", id: v.id, view: viewBody(v, patch as never) });
      items = [
        { label: "Projected view from it", icon: "viewFront", onClick: () => startTool("view.projected"), testId: "ctx-view-projected" },
        { label: "Section view of it", icon: "section", onClick: () => startTool("view.section"), testId: "ctx-view-section" },
        { label: "Detail view of it", icon: "zoomArea", onClick: () => startTool("view.detail"), testId: "ctx-view-detail" },
        "sep",
        { label: "Auto-dimension view", icon: "fullyDefine", onClick: () => runAutoDimension(ctx(), v.id), testId: "ctx-view-autodim" },
        ...(alignable ? [free ? { label: "Restore alignment", icon: "link", onClick: () => set({ free: undefined, at: undefined }), testId: "ctx-view-align" } : { label: "Break alignment", icon: "moveEntities", hint: al.axis === null ? undefined : "Place it freely, not lined up with its parent", onClick: () => set({ free: true }), testId: "ctx-view-unalign" }] as MenuEntry[] : []),
        { label: locked ? "Unlock position" : "Lock position", icon: "pin", onClick: () => set({ locked: locked ? undefined : true }), testId: "ctx-view-lock" },
        ...(v.at && !locked ? [{ label: "Place with the others", icon: "examples", onClick: () => run({ type: "moveView", id: v.id, at: null }), testId: "ctx-view-auto" } as MenuEntry] : []),
        "sep",
        { label: "Delete view", icon: "trash", shortcut: "Del", onClick: () => deleteIds([v.id]), testId: "ctx-delete-view" },
      ];
      items.push("sep", ...menuEntriesFor(hit, ctx(), at), askEntry({ kind: "view", id: v.id }, x, y));
    } else if (hit?.kind === "annotation") {
      const a = p.drawing.sheets.flatMap((s) => s.annotations).find((x) => x.id === hit.id);
      if (!a) return;
      title = `${annotationKind(a.type)?.label ?? a.type} ${a.id}`;
      const said = p.sheet?.annotations.find((x) => x.id === a.id);
      items = [
        ...(annotationKind(a.type)?.menu?.(a as unknown as Record<string, unknown>, ctx(), said) ?? []),
        ...annotationMenu(a, ctx, said),
        "sep",
        { label: "Copy", icon: "copy", shortcut: "Ctrl+C", onClick: copy, testId: "ctx-copy-annotation" },
        ...(clipboard.current.length ? [{ label: "Paste", icon: "paste", shortcut: "Ctrl+V", onClick: paste } as MenuEntry] : []),
        ...("at" in a && a.at && a.type !== "note" ? [{ label: "Place automatically", icon: "examples", onClick: () => run({ type: "setAnnotation", id: a.id, annotation: withoutAt(a) }) } as MenuEntry] : []),
        "sep",
        { label: "Delete", icon: "trash", shortcut: "Del", onClick: () => deleteIds([a.id]), testId: "ctx-delete-annotation" },
        "sep",
        ...menuEntriesFor(hit, ctx(), at),
        askEntry({ kind: "annotation", id: a.id }, x, y),
      ];
    } else if (hit?.kind === "table") {
      title = `Table ${hit.id}`;
      items = [{ label: "Delete table", icon: "trash", shortcut: "Del", onClick: () => deleteIds([hit.id]), testId: "ctx-delete-table" }, "sep", askEntry({ kind: "table", id: hit.id } as AskTarget, x, y)];
    } else if (hit?.kind === "titleBlock") {
      title = "Title block";
      items = [
        { label: "Edit the title block…", icon: "properties", onClick: () => setDialog({ name: "titleBlock" }), testId: "ctx-title-block" },
        { label: "Sheet format…", icon: "drawing", onClick: () => setDialog({ name: "format" }) },
        { label: "Drawing properties…", icon: "settings", onClick: () => setDialog({ name: "properties" }) },
        "sep",
        askEntry({ kind: "sheet", id: sheetDoc.id } as AskTarget, x, y),
      ];
    } else {
      title = from === "tree" ? `Sheet ${p.sheet?.name ?? sheetDoc.id}` : "Drawing";
      items = [
        { label: "Model view…", icon: "view", onClick: () => startTool("view.model"), testId: "ctx-model-view" },
        { label: "Standard 3 view", icon: "examples", onClick: () => startTool("view.standard3") },
        ...(clipboard.current.length ? [{ label: "Paste", icon: "paste", shortcut: "Ctrl+V", onClick: paste } as MenuEntry] : []),
        "sep",
        { label: "Balloon every item", icon: "balloon", disabled: !p.sheet?.cutList.length, onClick: p.balloonAll },
        { label: "Sheet format…", icon: "drawing", onClick: () => setDialog({ name: "format" }) },
        { label: "Drawing properties…", icon: "settings", onClick: () => setDialog({ name: "properties" }) },
        { label: "Zoom to fit", icon: "fit", shortcut: "F", onClick: () => setFitToken((n) => n + 1) },
        { label: "Print preview and export…", icon: "export", onClick: () => setDialog({ name: "export" }) },
        "sep",
        askEntry(from === "tree" ? ({ kind: "sheet", id: sheetDoc.id } as AskTarget) : { kind: "drawing" }, x, y),
      ];
    }
    setMenu({ x, y, title, items });
  };

  /** Fit views to sheet: the views laid out afresh at the largest standard scale that fits, stored (Phase Q wave Q4). */
  const fitViewsNow = (): string | null => {
    const { p, sheetDoc } = live.current;
    if (!p.doc || !sheetDoc) return null;
    const r = fitViews(p.doc, { measurements: p.measurements, geometry: p.geometry ?? null }, sheetDoc);
    if ("error" in r) {
      p.notice(r.error, "error");
      return r.error;
    }
    const problem = batchRef.current(r.commands);
    if (!problem) p.notice(`Fit views: the views laid out afresh at ${r.scale}, the sheet's scale from now on.`);
    return problem;
  };
  const fitViewsRef = useRef(fitViewsNow);
  fitViewsRef.current = fitViewsNow;

  /** The sheet tab's menu: rename, move, delete, ask. */
  const sheetMenu = (id: string, x: number, y: number, rename: () => void) => {
    if (!p.drawing) return;
    const i = p.drawing.sheets.findIndex((s) => s.id === id);
    const n = p.drawing.sheets.length;
    setMenu({
      x,
      y,
      title: p.sheets.find((s) => s.id === id)?.name ?? id,
      items: [
        { label: "Rename", icon: "sketchText", onClick: rename, testId: "ctx-sheet-rename" },
        { label: "Move left", icon: "chevron", disabled: i <= 0, onClick: () => run({ type: "moveSheet", id, index: i - 1 }), testId: "ctx-sheet-left" },
        { label: "Move right", icon: "chevronRight", disabled: i >= n - 1, onClick: () => run({ type: "moveSheet", id, index: i + 1 }), testId: "ctx-sheet-right" },
        { label: "Add a sheet", icon: "plus", onClick: addSheet },
        { label: "Delete sheet", icon: "trash", disabled: n < 2, onClick: () => run({ type: "deleteSheet", id }) || p.setActiveSheet(null), testId: "ctx-sheet-delete" },
        "sep",
        { label: "Fit views to sheet", icon: "fit", disabled: id !== sheetDoc?.id, onClick: () => void fitViewsNow(), testId: "ctx-sheet-fit" },
        "sep",
        askEntry({ kind: "sheet", id } as AskTarget, x, y),
      ],
    });
  };
  const addSheet = () => {
    if (!p.drawing) return;
    const id = nextSheetId(p.drawing);
    if (run({ type: "addSheet", id }) === null) {
      p.setActiveSheet(id);
      setSelection([]);
    }
  };

  return {
    p,
    selection,
    select,
    setSelection,
    session,
    tick,
    startTool,
    /** Opens a session made outside the toolbar (a pick into a field). */
    setSessionDirect: (s: DrawingSession | null) => {
      session?.cancel();
      setSession(s);
    },
    ok,
    cancel,
    ctx,
    snap,
    sheetDoc,
    dialog,
    setDialog,
    menu,
    setMenu,
    menuFor,
    sheetMenu,
    fitViews: fitViewsNow,
    addSheet,
    status,
    setStatus,
    fitToken,
    fit: () => setFitToken((n) => n + 1),
    zoomAreaToken,
    zoomArea: () => setZoomAreaToken((n) => n + 1),
    grid,
    setGrid,
    tab,
    setTab,
    run,
    batch,
    deleteIds,
    copy,
    paste,
    scaleRef,
    ask,
  };
}

function withoutAt(a: Annotation): Record<string, unknown> {
  const { id: _id, ...rest } = a as unknown as Record<string, unknown>;
  void _id;
  delete rest.at;
  return rest;
}

// ------------------------------------------------------------ the toolbar

export function DrawingCommandBar({ ws, undoLabel, redoLabel }: { ws: Workspace; undoLabel?: string; redoLabel?: string }) {
  const { p } = ws;
  const has = !!p.drawing && !!ws.sheetDoc;
  const c = has ? ws.ctx() : null;
  const groups = toolGroups(ws.tab);
  const entry = (e: (typeof groups)[number][number]) => {
    if (e.kind === "coming") {
      return <ToolButton key={e.slot.id} icon={e.slot.icon} label={e.slot.label} disabled title={`${e.slot.title} — coming`} testId={`tool-${e.slot.id.replace(".", "-")}`} />;
    }
    const t = e.tool;
    const why = !has ? "Make a drawing first: New drawing" : t.disabled?.(c!);
    const active = ws.session?.tool === t.id;
    return <ToolButton key={t.id} icon={t.icon} label={t.label} onClick={() => (active ? ws.cancel() : ws.startTool(t.id))} disabled={!!why} pressed={active} title={why ?? `${t.title}${t.key ? ` (${t.key})` : ""}`} testId={t.testId ?? `tool-${t.id.replace(".", "-")}`} />;
  };
  return (
    <div className="toolbar command-manager drawing-bar" role="toolbar" aria-label="Drawing">
      <div className="cm-pinned">
        <ToolButton icon="undo" label="Undo" onClick={p.d.undo} disabled={!p.d.canUndo} title={`Undo${undoLabel && p.d.canUndo ? `: ${undoLabel}` : ""} (Ctrl+Z)`} testId="undo" />
        <ToolButton icon="redo" label="Redo" onClick={p.d.redo} disabled={!p.d.canRedo} title={`Redo${redoLabel && p.d.canRedo ? `: ${redoLabel}` : ""} (Ctrl+Y)`} testId="redo" />
        <span className="sep" />
        <ToolButton icon="drawing" label="New drawing" onClick={p.newDrawing} disabled={!p.ready} title="Plan the sheet from the part: views, overall size, holes, balloons, tables (Ctrl+Z puts the old one back)" testId="drawing-new" />
      </div>
      <span className="sep cm-sep" />
      <div className="cm-body">
        <div className="cm-tools" role="tabpanel" id="dm-panel" aria-labelledby={`dm-tab-${ws.tab}`}>
          {groups.map((g, i) => (
            <span className="cm-group" key={i}>
              {i > 0 && <span className="sep" />}
              {g.map(entry)}
            </span>
          ))}
        </div>
        <div className="cm-tabs" role="tablist" aria-label="Drawing tool tabs">
          {DRAWING_TABS.map((t) => (
            <button key={t.id} role="tab" id={`dm-tab-${t.id}`} className="cm-tab" aria-selected={t.id === ws.tab} aria-controls="dm-panel" onMouseDown={(e) => e.preventDefault()} onClick={() => ws.setTab(t.id)} data-testid={`dtab-${t.id}`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <span className="sep cm-sep" />
      <div className="cm-pinned">
        <ToolButton icon="export" label="Export PDF" onClick={() => p.exportDrawing("pdf")} disabled={!p.sheet} title="Download every sheet as a vector PDF, a page each, the font embedded" testId="drawing-export-pdf" />
        <ToolButton icon="drawing" label="Print / Export" onClick={() => ws.setDialog({ name: "export" })} disabled={!p.sheet} title="Print preview of every sheet, and export to PDF, SVG, DXF or PNG with options" testId="drawing-export" />
      </div>
    </div>
  );
}

// ------------------------------------------------------------ the workspace

export function DrawingMain({ ws, empty, help }: { ws: Workspace; empty: ReactNode; help: ReactNode }) {
  const { p } = ws;
  const sheet = p.sheet;
  const failed = useMemo(() => (sheet ? sheet.annotations.filter((a) => a.problem).map((a) => a.id) : []), [sheet]);
  return (
    <>
      <aside className="side left drawing-left">
        {p.doc && p.drawing ? (
          <DrawingTree ws={ws} />
        ) : (
          <section className="panel muted">
            <p>This part has no drawing yet.</p>
          </section>
        )}
      </aside>
      <section className="center sheet-center">
        {sheet && p.drawing && ws.sheetDoc ? (
          <>
            <SheetCanvas
              sheet={sheet}
              sheetDoc={ws.sheetDoc}
              drawing={p.drawing}
              selection={ws.selection}
              failed={failed}
              snap={ws.snap}
              session={ws.session}
              tick={ws.tick}
              showGrid={ws.grid}
              fitToken={ws.fitToken}
              zoomAreaToken={ws.zoomAreaToken}
              onSelect={(ids, add) => ws.select(ids, add)}
              onContext={(hit, x, y, at) => ws.menuFor(hit, x, y, "sheet", at)}
              onCommands={(cmds) => ws.batch(cmds)}
              onNotice={(t, k) => p.notice(t, k)}
              onStatus={ws.setStatus}
              onDouble={(hit, at) => {
                if (hit?.kind === "titleBlock") ws.setDialog({ name: "titleBlock", arg: fieldNear(sheet, at) });
                else if (hit?.kind === "table") ws.setDialog({ name: "table", arg: `edit:${hit.id}` });
                else if (hit) ws.select([hit.id]);
              }}
              scaleRef={ws.scaleRef}
            />
            <ViewBar ws={ws} />
          </>
        ) : (
          empty
        )}
        {p.previewing && (
          <div className="preview-banner" data-testid="preview-banner">
            Previewing the proposal
          </div>
        )}
        {p.sheets.length > 0 && p.drawing && sheet && (
          <div className="sheet-foot">
            <SheetTabs ws={ws} />
            <StatusBar ws={ws} />
          </div>
        )}
      </section>
      <aside className="side right drawing-right">{p.doc && p.drawing ? <DrawingPanel ws={ws} /> : <section className="panel">{help}</section>}</aside>
      {ws.menu && <ContextMenu menu={ws.menu} onClose={() => ws.setMenu(null)} />}
      {ws.dialog && p.drawing && ws.sheetDoc && <WorkspaceDialog ws={ws} />}
    </>
  );
}

function WorkspaceDialog({ ws }: { ws: Workspace }) {
  const d = ws.dialog!;
  const close = () => ws.setDialog(null);
  if (d.name === "table") return <TableDialog ws={ws} arg={d.arg} onClose={close} />;
  if (d.name === "format") return <FormatDialog ws={ws} focus={d.arg} onClose={close} />;
  if (d.name === "titleBlock") return <TitleBlockDialog ws={ws} focus={d.arg} onClose={close} />;
  if (d.name === "properties") return <PropertiesDialog ws={ws} focus={d.arg} onClose={close} />;
  return <ExportDialog ws={ws} onClose={close} />;
}

/** The title-block field whose text is nearest a point (a double-click on it opens the editor there). */
function fieldNear(sheet: ComposedSheet, at: Vec2): string | undefined {
  let best: { text: string; d: number } | null = null;
  for (const p of sheet.prims) {
    if (p.k !== "text" || p.owner !== "titleBlock") continue;
    const d = Math.hypot(p.at[0] - at[0], p.at[1] - at[1]);
    if (!best || d < best.d) best = { text: p.text, d };
  }
  if (!best) return undefined;
  const f = sheet.format as unknown as Record<string, unknown>;
  return Object.keys(f).find((k) => typeof f[k] === "string" && f[k] === best!.text) ?? `text:${best.text}`;
}

const VIEW_BUTTONS: [IconName, string, string, (ws: Workspace) => void][] = [
  ["fit", "Zoom to fit (F)", "sheet-fit", (ws) => ws.fit()],
  ["zoomArea", "Zoom to area: drag a box", "sheet-zoom-area", (ws) => ws.zoomArea()],
];

/** Fit, zoom to area and the grid, over the sheet's corner. */
function ViewBar({ ws }: { ws: Workspace }) {
  return (
    <div className="sheet-viewbar" role="toolbar" aria-label="Sheet view">
      {VIEW_BUTTONS.map(([icon, title, id, f]) => (
        <button key={id} onClick={() => f(ws)} title={title} aria-label={title} data-testid={id}>
          <Icon name={icon} size={16} />
        </button>
      ))}
      <button onClick={() => ws.setGrid(!ws.grid)} aria-pressed={ws.grid} title="Show a 10 mm grid over the sheet" aria-label="Grid" data-testid="sheet-grid">
        <Icon name="grid" size={16} />
      </button>
    </div>
  );
}

function StatusBar({ ws }: { ws: Workspace }) {
  const s = ws.status;
  const sheet = ws.p.sheet;
  const f = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
  return (
    <div className="sheet-status" data-testid="sheet-status" aria-live="off">
      <span className="status-at" data-testid="sheet-status-at">
        {s.at ? `X ${f(s.at[0])}  Y ${f(s.at[1])} mm` : "—"}
      </span>
      <span className="status-snap" data-testid="sheet-status-snap">
        {s.snap ?? ""}
      </span>
      <span className="muted">{sheet ? `${sheet.size} ${sheet.format.orientation ?? "landscape"} · ${sheet.scaleText} · ${sheet.projection === "first" ? "first" : "third"} angle` : ""}</span>
      <span className="muted">{s.zoom} %</span>
      {ws.selection.length > 0 && <span className="muted">{ws.selection.length} selected</span>}
    </div>
  );
}

export { attachSide };
