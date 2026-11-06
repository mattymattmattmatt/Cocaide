// The feature tree: select, reorder (drag or arrows), suppress, delete.
// Every change is a document command; rejected moves say why. The
// default planes and the origin head it: a click selects one
// (and shows it while selected), the eye shows or hides it for good, a
// right-click offers Sketch on this plane, an offset plane, Ask AI. Plane,
// axis and point features carry an eye too. Showing is view state, never
// the document; but for sketches, whose eye (hidden once a feature uses one,
// unless shown) is kept in the document, so it saves.
//
// The rollback bar sits in the list: drag it up (or press the arrow keys on
// it) and the features below it are greyed and not built; new features go in
// at the bar. Hovering a feature lights up what it is built on (its parents)
// and what is built on it (its children), and its faces in the view. Double-click
// a feature to edit it (a sketch opens the sketcher, as before).
//
// Phase P (a smarter tree): dragging a feature checks what it uses as it
// goes: where it cannot land (above a sketch it uses, a feature whose faces it
// picks) the insertion line turns red with the reason, and the drop is
// refused. Folders group features next to each other (drop on a folder to put
// a feature in it, on a feature outside to take it out; collapse, rename,
// suppress the lot). A filter box finds features by name, type ("type:hole")
// or state ("error", "warning", "suppressed", "rolled"). Each row shows its
// state (error, warning, suppressed, rolled back); its tooltip, its key values
// and its note. F2, or a slow second click on the name, renames it in place.
// Ctrl+C / Ctrl+V copy and paste features (onto a face selected in the view).

import { Fragment, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { AskTarget } from "../ask/packet";
import { references, type Command, type RawDocument } from "../doc/commands";
import { foldersOf, moveProblem, type Folder } from "../doc/tree";
import { DATUM_OPS } from "../features/datum";
import { UI_OPS } from "../features/uiDefs";
import type { RebuildView } from "../worker/protocol";
import { Icon, type IconName } from "./icons";
import { eyeOpen, TREE_DATUMS, type DatumView } from "./model/datumDisplay";
import { DEFAULT_DATUM_LABEL } from "./model/selection";
import { childrenOf, parentsOf } from "./evaluate/relations";
import { OP_LABEL } from "./PropertyPanel";
import { dropIndex, featureState, keyValues, matchesFilter, treeRows, type FeatureState } from "./treeModel";

/** The picture of each kind of feature: the same one its tool has. */
export const OP_ICON: Record<string, IconName> = {
  sketch: "sketch",
  extrude: "extrude",
  cut: "cut",
  hole: "hole",
  fillet: "fillet",
  chamfer: "chamfer",
  linearPattern: "linearPattern",
  circularPattern: "circularPattern",
  mirror: "mirror",
  combine: "combine",
  split: "split",
  move: "move",
  deleteBody: "deleteBody",
  member: "member",
  joint: "joint",
  endCap: "endCap",
  gusset: "gusset",
  // Ops with a UI of their own (src/features/<op>/ui.tsx) bring their icon.
  ...Object.fromEntries(Object.values(UI_OPS).map((u) => [u.op, u.icon])),
};

/** A request from outside to the tree: rename a feature or a folder in place, write a note, show a feature (scrolled to and flashed). */
export interface TreeRequest {
  kind: "rename" | "note" | "reveal" | "renameFolder";
  id: string;
  /** A fresh number each time, so the same request twice is seen twice. */
  n: number;
}

interface Props {
  doc: RawDocument | null;
  view: RebuildView | null;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onEditSketch(id: string): void;
  dispatch(cmd: Command): string | null;
  onError(message: string): void;
  /** Right-click: the menu for a feature, or for its failed rebuild (its last entry asks the AI about it). */
  onAsk?(target: AskTarget, x: number, y: number): void;
  /** The reference geometry selected in the view (default planes, plane features...): their rows are marked. */
  pickedDatums?: readonly string[];
  /** What is shown of the reference geometry (each one's eye). */
  datumView?: DatumView;
  /** A click on a default plane or the origin: select it (Ctrl or Shift: add it). */
  onPickDatum?(id: string, additive: boolean): void;
  /** The eye of a default plane, the origin, or a plane, axis or point feature. */
  onToggleEye?(id: string): void;
  /** Is the sketch's eye open (drawn in the view)? */
  sketchShown?(id: string): boolean;
  /** The eye of a sketch: shows or hides it. */
  onToggleSketch?(id: string): void;
  /** Right-click on a default plane or the origin: its menu. */
  onDatumMenu?(id: string, x: number, y: number): void;
  /** Where the rollback bar is: the index of the first feature below it (the feature count: at the end). */
  rollback?: number;
  /** Moves the rollback bar to just above the feature at this index (the feature count: to the end). */
  onRollback?(index: number): void;
  /** Right-click on the rollback bar. */
  onRollbackMenu?(x: number, y: number): void;
  /** Double-click on a feature other than a sketch (the app opens it to edit, with OK and Cancel). */
  onShowDimensions?(id: string): void;
  /** The pointer is over a feature (null: over none): the app lights up its faces in the view. */
  onHover?(id: string | null): void;
  /** The features picked in the tree (the selected one first, then those Ctrl- or Shift-clicked): New folder takes them. */
  onPicked?(ids: string[]): void;
  /** Ctrl+C on the tree: copy these features. */
  onCopy?(ids: string[]): void;
  /** Ctrl+V on the tree: paste what was copied. */
  onPaste?(): void;
  /** Right-click on a folder's head. */
  onFolderMenu?(id: string, x: number, y: number): void;
  request?: TreeRequest | null;
}

/** The drag of the rollback bar, told apart from a feature's by its own type. */
const BAR_TYPE = "application/x-cocaide-rollback";

/** The icon of a default plane or the origin. */
const DATUM_ICON: Record<string, IconName> = { Front: "plane", Top: "plane", Right: "plane", Origin: "datumPoint" };

/** How long a second click on a selected feature's name waits to be sure it is not a double-click, before renaming. */
const SLOW_CLICK_MS = 380;

const STATE_ICON: Partial<Record<FeatureState, IconName>> = { error: "alert", warning: "warning", suppressed: "suppress" };
const STATE_WORD: Record<FeatureState, string> = { ok: "rebuilt", error: "failed", warning: "rebuilt with a warning", suppressed: "suppressed", rolled: "rolled back" };

/** Collapsed folders, per document, in this browser. */
const COLLAPSE_KEY = "cocaide.treeFolders.v1";
function loadCollapsed(doc: string): Set<string> {
  try {
    const all = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}") as Record<string, string[]>;
    return new Set(all[doc] ?? []);
  } catch {
    return new Set();
  }
}
function saveCollapsed(doc: string, ids: Set<string>) {
  try {
    const all = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}") as Record<string, string[]>;
    all[doc] = [...ids];
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(all));
  } catch {
    // The view state is a convenience: without storage it simply is not remembered.
  }
}

/** Where a dragged feature would go, and why it can't, when it can't. */
interface DropAt {
  /** The row it is over: a feature's index, or a folder's id. */
  row: number | string;
  after: boolean;
  index: number;
  folder: string | null;
  problem: string | null;
}

export function FeatureTree({
  doc,
  view,
  selectedId,
  onSelect,
  onEditSketch,
  dispatch,
  onError,
  onAsk,
  pickedDatums = [],
  datumView,
  sketchShown,
  onToggleSketch,
  onPickDatum,
  onToggleEye,
  onDatumMenu,
  rollback,
  onRollback,
  onRollbackMenu,
  onShowDimensions,
  onHover,
  onPicked,
  onCopy,
  onPaste,
  onFolderMenu,
  request,
}: Props) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<DropAt | null>(null);
  /** The rollback bar is being dragged; where it would land (an index: above that feature). */
  const [barDrag, setBarDrag] = useState(false);
  const [barAt, setBarAt] = useState<number | null>(null);
  /** The feature under the pointer, for its parents and children. */
  const [hoverId, setHoverId] = useState<string | null>(null);
  /** The bar was moved from the keyboard: it keeps the focus where it lands (it is a new element there), so the next arrow moves it again. */
  const barKeyed = useRef(false);
  const listRef = useRef<HTMLOListElement>(null);
  const [filter, setFilter] = useState("");
  /** Features Ctrl- or Shift-clicked besides the selected one. */
  const [extra, setExtra] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [noting, setNoting] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const slowClick = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const lastClick = useRef<{ id: string; at: number } | null>(null);
  const docName = typeof doc?.name === "string" ? doc.name : "";
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(docName));
  useEffect(() => setCollapsed(loadCollapsed(docName)), [docName]);
  const features = (doc?.features ?? []) as Record<string, unknown>[];
  const folders = useMemo(() => foldersOf(doc), [doc]);
  const bar = rollback === undefined ? features.length : Math.min(rollback, features.length);
  const status = new Map(view?.features.map((s) => [s.id, s]) ?? []);
  const uses = useMemo(() => new Map(Object.entries(view?.uses ?? {})), [view]);
  const parents = new Set(hoverId ? parentsOf(features, hoverId, uses) : []);
  const children = new Set(hoverId ? childrenOf(features, hoverId, uses) : []);
  useEffect(() => {
    if (!barKeyed.current) return;
    barKeyed.current = false;
    listRef.current?.querySelector<HTMLElement>("[data-testid=rollback-bar]")?.focus();
  }, [bar]);
  const headerErrors = view?.errors.filter((e) => e.startsWith("document:")) ?? [];
  const picked = useMemo(() => (selectedId ? [selectedId, ...extra.filter((x) => x !== selectedId)] : extra), [selectedId, extra]);
  useEffect(() => {
    onPicked?.(picked);
  }, [picked.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  // A feature that is gone is not picked any more.
  useEffect(() => setExtra((x) => x.filter((id) => features.some((f) => f.id === id))), [features.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Requests from the app: rename in place, a note, show a feature.
  useEffect(() => {
    if (!request) return;
    if (request.kind === "rename") setRenaming(request.id);
    if (request.kind === "renameFolder") setRenamingFolder(request.id);
    if (request.kind === "note") setNoting(request.id);
    if (request.kind === "reveal" || request.kind === "rename" || request.kind === "note") {
      // Its folder opens, so it can be seen.
      const f = folders.find((x) => x.features.includes(request.id));
      if (f && collapsed.has(f.id)) toggleFolder(f.id);
      setFlash(request.id);
      setFilter("");
      requestAnimationFrame(() => listRef.current?.querySelector(`[data-testid="feature-${request.id}"]`)?.scrollIntoView({ block: "nearest" }));
      const t = setTimeout(() => setFlash(null), 1600);
      return () => clearTimeout(t);
    }
  }, [request?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = (cmd: Command) => {
    const problem = dispatch(cmd);
    if (problem) onError(problem);
    return problem;
  };

  const toggleFolder = (id: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveCollapsed(docName, next);
      return next;
    });

  /** The eye of a reference: open (shown) or closed, with its button. */
  const eye = (id: string, name: string) => {
    if (!datumView || !onToggleEye) return null;
    const open = eyeOpen(id, datumView);
    return (
      <button
        className={`eye${open ? "" : " closed"}`}
        title={open ? `Hide ${name}` : `Show ${name}`}
        aria-label={`${open ? "Hide" : "Show"} ${name}`}
        aria-pressed={open}
        onClick={() => onToggleEye(id)}
        data-testid={`datum-eye-${id}`}
      >
        <Icon name={open ? "eye" : "eyeOff"} />
      </button>
    );
  };

  /** The eye of a sketch: open (drawn in the view) or closed (hidden: a feature used it, or it was hidden). */
  const sketchEye = (id: string) => {
    if (!sketchShown || !onToggleSketch) return null;
    const open = sketchShown(id);
    return (
      <button
        className={`eye${open ? "" : " closed"}`}
        title={open ? `Hide ${id}` : `Show ${id}`}
        aria-label={`${open ? "Hide" : "Show"} ${id}`}
        aria-pressed={open}
        onClick={() => onToggleSketch(id)}
        data-testid={`sketch-eye-${id}`}
      >
        <Icon name={open ? "eye" : "eyeOff"} />
      </button>
    );
  };

  /** Where a feature dragged over this row would go, checked. */
  const dropFor = (row: number | string, after: boolean): DropAt | null => {
    if (!dragging) return null;
    const from = features.findIndex((f) => f.id === dragging);
    if (from < 0) return null;
    let index: number;
    let folder: string | null;
    if (typeof row === "string") {
      // On a folder's head: into it, at its end.
      const f = folders.find((x) => x.id === row);
      if (!f) return null;
      const last = Math.max(...f.features.map((x) => features.findIndex((g) => g.id === x)));
      index = dropIndex(from, last, true);
      folder = f.id;
    } else {
      index = dropIndex(from, row, after);
      folder = folders.find((x) => x.features.includes(String(features[row].id)))?.id ?? null;
    }
    const problem = index === from && (folders.find((x) => x.features.includes(dragging))?.id ?? null) === folder ? null : moveProblem(features, dragging, index, (f) => references(f));
    return { row, after, index, folder, problem };
  };

  const onRowDragOver = (e: DragEvent, row: number | string) => {
    if (barDrag) {
      if (typeof row !== "number") return;
      e.preventDefault();
      setBarAt(row);
      return;
    }
    if (!dragging) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const at = dropFor(row, e.clientY > r.top + r.height / 2);
    if (!at) return;
    // Where it may not go, the drop is refused (the line is red and says why).
    if (!at.problem) e.preventDefault();
    e.dataTransfer.dropEffect = at.problem ? "none" : "move";
    if (!dropAt || dropAt.row !== at.row || dropAt.after !== at.after) setDropAt(at);
  };

  const onRowDrop = (e: DragEvent, row: number | string) => {
    e.preventDefault();
    if (barDrag) {
      if (typeof row === "number") onRollback?.(row);
      setBarDrag(false);
      setBarAt(null);
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const at = dragging ? dropFor(row, e.clientY > r.top + r.height / 2) : null;
    if (dragging && at) {
      if (at.problem) onError(`Can't move ${dragging} there: ${at.problem}.`);
      else {
        const from = features.findIndex((f) => f.id === dragging);
        const was = folders.find((x) => x.features.includes(dragging))?.id ?? null;
        if (at.index !== from || was !== at.folder) run({ type: "reorderFeature", id: dragging, index: at.index, folder: at.folder });
      }
    }
    setDragging(null);
    setDropAt(null);
  };

  /** Click on a feature: select it; Ctrl adds it to the picked ones, Shift picks the run from the selected one; a slow second click on its name renames it. */
  const clickFeature = (e: React.MouseEvent, id: string, onName: boolean) => {
    const now = Date.now();
    const last = lastClick.current;
    lastClick.current = { id, at: now };
    if (e.ctrlKey || e.metaKey) {
      setExtra((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
      if (!selectedId) onSelect(id);
      return;
    }
    if (e.shiftKey && selectedId) {
      const a = features.findIndex((f) => f.id === selectedId);
      const b = features.findIndex((f) => f.id === id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setExtra(features.slice(lo, hi + 1).map((f) => String(f.id)).filter((x) => x !== selectedId));
      return;
    }
    setExtra([]);
    if (onName && selectedId === id && last?.id === id && now - last.at > 500) {
      // A slow second click on the name: rename, unless it turns out to be a double-click.
      if (slowClick.current) clearTimeout(slowClick.current.timer);
      slowClick.current = { id, timer: setTimeout(() => setRenaming(id), SLOW_CLICK_MS) };
      return;
    }
    onSelect(selectedId === id ? null : id);
  };

  const cancelSlowClick = () => {
    if (slowClick.current) clearTimeout(slowClick.current.timer);
    slowClick.current = null;
  };

  /** Keys on the tree: F2 renames, Ctrl+C copies, Ctrl+V pastes. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    if (e.key === "F2" && selectedId) {
      e.preventDefault();
      setRenaming(selectedId);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && picked.length && onCopy) {
      e.preventDefault();
      onCopy(picked);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && onPaste) {
      e.preventDefault();
      onPaste();
    }
  };

  /** The bar: drag it, move it with the arrow keys, right-click it. */
  const rollbackBar = onRollback ? (
    <li
      key="rollback-bar"
      className={`rollback-bar${bar < features.length ? " rolled" : ""}`}
      data-testid="rollback-bar"
      draggable
      tabIndex={0}
      role="separator"
      aria-label={bar < features.length ? `Rollback bar: ${features.length - bar} feature${features.length - bar === 1 ? "" : "s"} below it are not built` : "Rollback bar, at the end"}
      title="Rollback bar: drag it up to see the part as it was and add features there; the arrow keys, Home and End move it; right-click for more"
      onDragStart={(e) => {
        setBarDrag(true);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(BAR_TYPE, "bar");
      }}
      onDragEnd={() => {
        setBarDrag(false);
        setBarAt(null);
      }}
      onKeyDown={(e) => {
        // Up and Down move it a feature at a time, Home to the top, End to the end.
        const to = e.key === "ArrowUp" ? bar - 1 : e.key === "ArrowDown" ? bar + 1 : e.key === "Home" ? 0 : e.key === "End" ? features.length : null;
        if (to === null) return;
        e.preventDefault();
        e.stopPropagation();
        if (to < 0 || to > features.length || to === bar) return;
        barKeyed.current = true;
        onRollback(to);
      }}
      onContextMenu={(e) => {
        if (!onRollbackMenu) return;
        e.preventDefault();
        onRollbackMenu(e.clientX, e.clientY);
      }}
    >
      <span className="rollback-grip" aria-hidden />
    </li>
  ) : null;

  const filtering = filter.trim() !== "";
  const rows = treeRows(
    features,
    folders,
    collapsed,
    filtering ? (i) => matchesFilter(features[i], OP_LABEL[String(features[i].op)] ?? String(features[i].op), featureState(features[i], status.get(String(features[i].id)), i >= bar), filter) : undefined,
  );
  const shownFeatures = rows.filter((r) => r.kind === "feature").length;
  /** The bar goes above the row of the first feature below it, as long as that row is shown (not while filtering). */
  const barRow = filtering ? -1 : rows.findIndex((r) => r.kind === "feature" && r.index >= bar) ;

  const featureRow = (i: number, folder: Folder | undefined) => {
    const f = features[i];
    const id = String(f.id);
    const s = status.get(id);
    const suppressed = f.suppressed === true;
    const failed = s && !s.ok;
    const isDatum = Object.hasOwn(DATUM_OPS, String(f.op));
    const rolled = i >= bar;
    const state = featureState(f, s, rolled);
    const relation = parents.has(id) ? "parent" : children.has(id) ? "child" : undefined;
    const line = dropAt && dropAt.row === i ? (dropAt.after ? "after" : "before") : null;
    const values = keyValues(f);
    const tip = [
      `${OP_LABEL[String(f.op)] ?? String(f.op)} ${id} — ${STATE_WORD[state]}`,
      ...values,
      ...(typeof f.note === "string" && f.note ? [`Note: ${f.note}`] : []),
      ...(s?.warnings ?? []).map((w) => `⚠ ${w.replace(`${id}: `, "")}`),
      rolled
        ? "Below the rollback bar, not built. Drag the bar below it, or right-click: Roll to end"
        : f.op === "sketch"
          ? "Double-click to edit the sketch · F2 renames"
          : "Double-click to edit it · F2 renames · drag to move",
    ].join("\n");
    return (
      <li
        key={`${id}-${i}`}
        className={[
          failed && !rolled ? "failed" : "ok",
          suppressed ? "suppressed" : "",
          rolled ? "rolled-back" : "",
          state === "warning" ? "warned" : "",
          selectedId === id || pickedDatums.includes(id) ? "selected" : "",
          extra.includes(id) && selectedId !== id ? "picked" : "",
          flash === id ? "flash" : "",
          folder ? "in-folder" : "",
          line ? `drop-${line}${dropAt?.problem ? " drop-refused" : ""}` : "",
          barAt === i ? "bar-target" : "",
          relation ? `${relation}-of-hover` : "",
          isDatum && datumView && !eyeOpen(id, datumView) ? "hidden-datum" : "",
          f.op === "sketch" && sketchShown && !sketchShown(id) ? "hidden-sketch" : "",
        ].join(" ")}
        data-testid={`feature-${id}`}
        data-relation={relation}
        data-state={state}
        data-folder={folder?.id}
        draggable={!filtering && renaming !== id}
        onMouseEnter={() => {
          setHoverId(id);
          onHover?.(id);
        }}
        onDragStart={(e) => {
          setDragging(id);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", id);
        }}
        onDragEnd={() => {
          setDragging(null);
          setDropAt(null);
        }}
        onDragOver={(e) => onRowDragOver(e, i)}
        onDrop={(e) => onRowDrop(e, i)}
      >
        <div className="feature-row-wrap">
          {renaming === id ? (
            <span className="feature-row renaming">
              <span className={`feature-icon ${state}`} aria-hidden>
                <Icon name={OP_ICON[String(f.op)] ?? "sketch"} />
              </span>
              <InlineInput
                value={id}
                testId={`rename-${id}`}
                label={`Rename ${id}`}
                onDone={(to) => {
                  setRenaming(null);
                  if (to && to !== id && !run({ type: "updateFeature", id, patch: { id: to } }) && selectedId === id) onSelect(to);
                }}
              />
            </span>
          ) : (
            <button
              className="feature-row"
              onClick={(e) => clickFeature(e, id, (e.target as HTMLElement).closest(".feature-id, .feature-op") !== null)}
              onDoubleClick={() => {
                cancelSlowClick();
                if (f.op === "sketch") onEditSketch(id);
                else onShowDimensions?.(id);
              }}
              onContextMenu={(e) => {
                if (!onAsk) return;
                e.preventDefault();
                onAsk({ kind: "feature", id }, e.clientX, e.clientY);
              }}
              title={tip}
            >
              {/* What it is; a failed, warned or suppressed one says so instead. */}
              <span className={`feature-icon ${state === "warning" ? "warned" : suppressed ? "off" : rolled ? "rolled" : failed ? "failed" : "ok"}`} aria-label={STATE_WORD[state]} data-testid={`feature-state-${id}`}>
                <Icon name={STATE_ICON[state] ?? OP_ICON[String(f.op)] ?? "sketch"} />
              </span>
              <span className="feature-op">{OP_LABEL[String(f.op)] ?? String(f.op)}</span>
              <span className="feature-id">{id}</span>
              {typeof f.note === "string" && f.note && (
                <span className="feature-note-mark" aria-label="Has a note" data-testid={`feature-note-${id}`}>
                  <Icon name="note" size={12} />
                </span>
              )}
              {/* Which body it makes or adds to, in a part that names bodies. */}
              {typeof (f.newBody ?? f.body) === "string" && f.op !== "split" && f.op !== "mirror" && f.op !== "move" && (
                <span className="feature-body" title={f.newBody ? "starts this body" : "adds to this body"}>
                  {f.newBody ? "new " : "→ "}
                  {String(f.newBody ?? f.body)}
                </span>
              )}
              {f.op === "member" && typeof f.size === "string" && <span className="feature-body">{f.size}</span>}
              {f.op === "joint" && (
                <span className="feature-body">
                  {String(f.type)} at {String(f.node)}
                </span>
              )}
              {f.op === "endCap" && <span className="feature-body">on {String(f.member)}</span>}
              {f.op === "gusset" && <span className="feature-body">at {String(f.node)}</span>}
              {f.op === "mirror" && <span className="feature-body">{Array.isArray(f.bodies) ? (f.bodies as string[]).join(", ") : String(f.feature)}{f.merge ? ", merged" : ""}</span>}
              {f.op === "split" && <span className="feature-body">{String(f.body)}{f.newBody ? ` → ${String(f.newBody)}` : ""}</span>}
              {f.op === "move" && <span className="feature-body">{f.copy ? "copy " : ""}{Array.isArray(f.bodies) ? (f.bodies as string[]).join(", ") : ""}</span>}
              {f.op === "deleteBody" && <span className="feature-body">{Array.isArray(f.keep) ? `keep ${(f.keep as string[]).join(", ")}` : Array.isArray(f.bodies) ? (f.bodies as string[]).join(", ") : ""}</span>}
              {/* An op with a UI of its own says what matters about it ("360°", "2 faces"). */}
              {UI_OPS[String(f.op)]?.summary && <OpSummary f={f} />}
              {f.op === "sketch" && typeof (f.profile as { name?: unknown } | undefined)?.name === "string" && (
                <span className="feature-body weldment-tag" title="A weldment profile: it is in the section library">
                  {String((f.profile as { name: string }).name)}
                </span>
              )}
            </button>
          )}
          <span className="row-actions">
            {isDatum && eye(id, id)}
            {f.op === "sketch" && sketchEye(id)}
            <button title={suppressed ? "Unsuppress" : "Suppress"} aria-label={`${suppressed ? "Unsuppress" : "Suppress"} ${id}`} onClick={() => run({ type: "suppressFeature", id, suppressed: !suppressed })}>
              <Icon name={suppressed ? "eye" : "suppress"} />
            </button>
            <button title="Move up" aria-label={`Move ${id} up`} disabled={i === 0} onClick={() => run({ type: "reorderFeature", id, index: i - 1 })}>
              <Icon name="up" />
            </button>
            <button title="Move down" aria-label={`Move ${id} down`} disabled={i === features.length - 1} onClick={() => run({ type: "reorderFeature", id, index: i + 1 })}>
              <Icon name="down" />
            </button>
            <button
              title="Delete"
              aria-label={`Delete ${id}`}
              className="danger-hover"
              onClick={() => {
                if (!run({ type: "deleteFeature", id }) && selectedId === id) onSelect(null);
              }}
            >
              <Icon name="trash" />
            </button>
          </span>
        </div>
        {line && dropAt?.problem && (
          <div className="drop-reason" data-testid="drop-reason" role="status">
            {dropAt.problem}
          </div>
        )}
        {noting === id && (
          <div className="feature-note-edit">
            <InlineInput
              value={typeof f.note === "string" ? f.note : ""}
              testId={`note-${id}`}
              label={`Note for ${id}`}
              placeholder="A short note: why it is there, what to watch"
              multiline
              onDone={(text) => {
                setNoting(null);
                if (text === null) return;
                const note = text.trim();
                if (note !== (f.note ?? "")) run({ type: "updateFeature", id, patch: { note: note || null } });
              }}
            />
          </div>
        )}
        {s?.error && !suppressed && !rolled && (
          <div
            className="feature-error"
            data-testid={`feature-error-${id}`}
            title="Right-click to fix it or ask the AI about it"
            onContextMenu={(e) => {
              if (!onAsk) return;
              e.preventDefault();
              onAsk({ kind: "failed", id }, e.clientX, e.clientY);
            }}
          >
            {s.error.split("\n").map((line) => (
              <div key={line}>{line.replace(`${id}: `, "")}</div>
            ))}
          </div>
        )}
      </li>
    );
  };

  const folderRow = (folder: Folder, count: number, isCollapsed: boolean) => {
    const members = folder.features.map((x) => features.find((g) => g.id === x)).filter((x): x is Record<string, unknown> => !!x);
    const allOff = members.length > 0 && members.every((m) => m.suppressed === true);
    const failing = members.filter((m) => status.get(String(m.id))?.ok === false).length;
    const line = dropAt && dropAt.row === folder.id;
    return (
      <li
        key={`folder-${folder.id}`}
        className={`folder-row${allOff ? " suppressed" : ""}${line ? ` drop-into${dropAt?.problem ? " drop-refused" : ""}` : ""}`}
        data-testid={`folder-${folder.id}`}
        data-collapsed={isCollapsed}
        onDragOver={(e) => onRowDragOver(e, folder.id)}
        onDrop={(e) => onRowDrop(e, folder.id)}
        onMouseEnter={() => {
          setHoverId(null);
          onHover?.(null);
        }}
      >
        <div className="feature-row-wrap">
          <button className="folder-caret" aria-label={`${isCollapsed ? "Open" : "Collapse"} folder ${folder.name}`} aria-expanded={!isCollapsed} onClick={() => toggleFolder(folder.id)} data-testid={`folder-toggle-${folder.id}`}>
            <Icon name={isCollapsed ? "chevronRight" : "down"} size={12} />
          </button>
          {renamingFolder === folder.id ? (
            <span className="feature-row renaming">
              <InlineInput
                value={folder.name}
                testId={`folder-rename-${folder.id}`}
                label={`Rename folder ${folder.name}`}
                onDone={(to) => {
                  setRenamingFolder(null);
                  if (to && to !== folder.name) run({ type: "setFolder", id: folder.id, folder: { name: to } });
                }}
              />
            </span>
          ) : (
            <button
              className="feature-row"
              onClick={() => toggleFolder(folder.id)}
              onDoubleClick={() => setRenamingFolder(folder.id)}
              onContextMenu={(e) => {
                if (!onFolderMenu) return;
                e.preventDefault();
                onFolderMenu(folder.id, e.clientX, e.clientY);
              }}
              title={`Folder: ${members.map((m) => String(m.id)).join(", ")}\nClick to open or collapse, double-click to rename, drop a feature here to put it in; right-click for more`}
            >
              <span className={`feature-icon ${failing ? "failed" : allOff ? "off" : "ok"} folder-icon`} aria-hidden>
                <Icon name={failing ? "alert" : "folder"} />
              </span>
              <span className="feature-op folder-name">{folder.name}</span>
              <span className="feature-body">{count}</span>
            </button>
          )}
          <span className="row-actions">
            <button title={allOff ? "Unsuppress the folder" : "Suppress the folder"} aria-label={`${allOff ? "Unsuppress" : "Suppress"} folder ${folder.name}`} onClick={() => run({ type: "suppressFolder", id: folder.id, suppressed: !allOff })} data-testid={`folder-suppress-${folder.id}`}>
              <Icon name={allOff ? "eye" : "suppress"} />
            </button>
          </span>
        </div>
        {line && dropAt?.problem && (
          <div className="drop-reason" data-testid="drop-reason" role="status">
            {dropAt.problem}
          </div>
        )}
      </li>
    );
  };

  return (
    <section className="panel features" aria-label="Feature tree" onKeyDown={onKeyDown}>
      <h2>Features</h2>
      <ol className="feature-list datum-list" aria-label="Default planes and the origin">
        {TREE_DATUMS.map((id) => {
          const name = DEFAULT_DATUM_LABEL[id];
          const pickedDatum = pickedDatums.includes(id);
          return (
            <li key={id} className={`datum-row${pickedDatum ? " selected" : ""}${datumView && !eyeOpen(id, datumView) ? " hidden-datum" : ""}`} data-testid={`datum-${id}`}>
              <div className="feature-row-wrap">
                <button
                  className="feature-row"
                  onClick={(e) => onPickDatum?.(id, e.shiftKey || e.ctrlKey || e.metaKey)}
                  onContextMenu={(e) => {
                    if (!onDatumMenu) return;
                    e.preventDefault();
                    onDatumMenu(id, e.clientX, e.clientY);
                  }}
                  title={id === "Origin" ? "The origin: right-click for more" : `${name}: click to show and select it, right-click to sketch on it`}
                >
                  <span className="feature-icon ok datum-icon" aria-hidden>
                    <Icon name={DATUM_ICON[id]} />
                  </span>
                  <span className="feature-op">{name}</span>
                </button>
                <span className="row-actions">{eye(id, name)}</span>
              </div>
            </li>
          );
        })}
      </ol>
      {features.length > 0 && (
        <div className="tree-filter">
          <Icon name="select" size={14} />
          <input
            type="search"
            placeholder="Filter: name, type:hole, error, warning, suppressed"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setFilter("");
              }
            }}
            aria-label="Filter the features"
            title='Shows the features whose name, type or note has these words; "error", "warning", "suppressed" or "rolled" show those; "type:fillet" a kind only'
            data-testid="tree-filter"
          />
          {filtering && (
            <span className="muted small" data-testid="tree-filter-count">
              {shownFeatures} of {features.length}
            </span>
          )}
        </div>
      )}
      {features.length === 0 && <p className="muted empty-hint">Empty part. Start with <strong>Sketch</strong> in the toolbar, or right-click the view to describe a part.</p>}
      <ol
        ref={listRef}
        className={`feature-list${barDrag ? " bar-dragging" : ""}${dragging ? " feature-dragging" : ""}`}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDropAt(null);
          setBarAt(null);
        }}
        onMouseLeave={() => {
          setHoverId(null);
          onHover?.(null);
        }}
      >
        {rows.map((r, k) => (
          <Fragment key={r.kind === "folder" ? `f:${r.folder.id}` : `x:${r.index}`}>
            {k === barRow && rollbackBar}
            {r.kind === "folder" ? folderRow(r.folder, r.count, r.collapsed) : featureRow(r.index, r.folder)}
          </Fragment>
        ))}
        {!filtering && barRow < 0 && features.length > 0 && rollbackBar}
        {barDrag && bar < features.length && (
          <li
            className={`rollback-end${barAt === features.length ? " bar-target" : ""}`}
            data-testid="rollback-end"
            onDragOver={(e) => {
              e.preventDefault();
              setBarAt(features.length);
            }}
            onDrop={(e) => {
              e.preventDefault();
              onRollback?.(features.length);
              setBarDrag(false);
              setBarAt(null);
            }}
          >
            Roll to end
          </li>
        )}
        {filtering && shownFeatures === 0 && <li className="muted empty-hint">No feature matches “{filter}”.</li>}
      </ol>
      {headerErrors.map((e) =>
        e.startsWith("document: no solid") ? null : (
          <div key={e} className="feature-error standalone">
            {e}
          </div>
        ),
      )}
    </section>
  );
}

/** A registered op's chip in the tree; nothing when it has nothing to say. */
function OpSummary({ f }: { f: Record<string, unknown> }) {
  const text = UI_OPS[String(f.op)]?.summary?.(f);
  return text ? (
    <span className="feature-body" data-testid={`feature-summary-${String(f.id)}`}>
      {text}
    </span>
  ) : null;
}

/** Text edited in place: focused and selected; Enter or leaving it keeps it (Ctrl+Enter in a note), Esc keeps the old. */
export function InlineInput({ value, testId, label, onDone, placeholder, multiline }: { value: string; testId: string; label: string; onDone(to: string | null): void; placeholder?: string; multiline?: boolean }) {
  const [text, setText] = useState(value);
  const done = useRef(false);
  const finish = (to: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(to === null ? null : multiline ? to : to.trim() || null);
  };
  const common = {
    value: text,
    autoFocus: true,
    "aria-label": label,
    spellCheck: multiline ?? false,
    placeholder,
    "data-testid": testId,
    onBlur: () => finish(text),
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  };
  return multiline ? (
    <textarea
      {...common}
      rows={2}
      maxLength={500}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          finish(text);
        }
        if (e.key === "Escape") finish(null);
      }}
    />
  ) : (
    <input
      {...common}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(text);
        if (e.key === "Escape") finish(null);
      }}
    />
  );
}
