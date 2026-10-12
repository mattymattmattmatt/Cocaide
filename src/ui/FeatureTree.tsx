// The feature tree: select, reorder (drag or arrows), suppress, delete.
// Every change is a document command; rejected moves say why. The
// default planes and the origin head it: a click selects one
// (and shows it while selected), the eye shows or hides it for good, a
// right-click offers Sketch on this plane, an offset plane, Ask AI. Plane,
// axis and point features carry an eye too. Showing is view state, never
// the document.
//
// The rollback bar sits in the list: drag it up (or press the arrow keys on
// it) and the features below it are greyed and not built; new features go in
// at the bar. Hovering a feature lights up what it is built on (its parents)
// and what is built on it (its children). Double-click a feature to show its
// dimensions on the model (a sketch opens the sketcher, as before).

import { Fragment, useEffect, useRef, useState } from "react";
import type { AskTarget } from "../ask/packet";
import type { Command, RawDocument } from "../doc/commands";
import { DATUM_OPS } from "../features/datum";
import { UI_OPS } from "../features/uiDefs";
import type { RebuildView } from "../worker/protocol";
import { Icon, type IconName } from "./icons";
import { eyeOpen, TREE_DATUMS, type DatumView } from "./model/datumDisplay";
import { DEFAULT_DATUM_LABEL } from "./model/selection";
import { childrenOf, parentsOf } from "./evaluate/relations";
import { OP_LABEL } from "./PropertyPanel";

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
  /** Right-click on a default plane or the origin: its menu. */
  onDatumMenu?(id: string, x: number, y: number): void;
  /** Where the rollback bar is: the index of the first feature below it (the feature count: at the end). */
  rollback?: number;
  /** Moves the rollback bar to just above the feature at this index (the feature count: to the end). */
  onRollback?(index: number): void;
  /** Right-click on the rollback bar. */
  onRollbackMenu?(x: number, y: number): void;
  /** Double-click on a feature other than a sketch: show its dimensions on the model. */
  onShowDimensions?(id: string): void;
}

/** The drag of the rollback bar, told apart from a feature's by its own type. */
const BAR_TYPE = "application/x-cocaide-rollback";

/** The icon of a default plane or the origin. */
const DATUM_ICON: Record<string, IconName> = { Front: "plane", Top: "plane", Right: "plane", Origin: "datumPoint" };

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
  onPickDatum,
  onToggleEye,
  onDatumMenu,
  rollback,
  onRollback,
  onRollbackMenu,
  onShowDimensions,
}: Props) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  /** The rollback bar is being dragged; where it would land (an index: above that feature). */
  const [barDrag, setBarDrag] = useState(false);
  const [barAt, setBarAt] = useState<number | null>(null);
  /** The feature under the pointer, for its parents and children. */
  const [hoverId, setHoverId] = useState<string | null>(null);
  /** The bar was moved from the keyboard: it keeps the focus where it lands (it is a new element there), so the next arrow moves it again. */
  const barKeyed = useRef(false);
  const listRef = useRef<HTMLOListElement>(null);
  const features = (doc?.features ?? []) as Record<string, unknown>[];
  const bar = rollback === undefined ? features.length : Math.min(rollback, features.length);
  const parents = new Set(hoverId ? parentsOf(features, hoverId) : []);
  const children = new Set(hoverId ? childrenOf(features, hoverId) : []);
  useEffect(() => {
    if (!barKeyed.current) return;
    barKeyed.current = false;
    listRef.current?.querySelector<HTMLElement>("[data-testid=rollback-bar]")?.focus();
  }, [bar]);
  const status = new Map(view?.features.map((s) => [s.id, s]) ?? []);
  const headerErrors = view?.errors.filter((e) => e.startsWith("document:")) ?? [];

  const run = (cmd: Command) => {
    const problem = dispatch(cmd);
    if (problem) onError(problem);
    return problem;
  };

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

  return (
    <section className="panel features" aria-label="Feature tree">
      <h2>Features</h2>
      <ol className="feature-list datum-list" aria-label="Default planes and the origin">
        {TREE_DATUMS.map((id) => {
          const name = DEFAULT_DATUM_LABEL[id];
          const picked = pickedDatums.includes(id);
          return (
            <li key={id} className={`datum-row${picked ? " selected" : ""}${datumView && !eyeOpen(id, datumView) ? " hidden-datum" : ""}`} data-testid={`datum-${id}`}>
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
      {features.length === 0 && <p className="muted empty-hint">Empty part. Start with <strong>Sketch</strong> in the toolbar, or right-click the view to describe a part.</p>}
      <ol
        ref={listRef}
        className={`feature-list${barDrag ? " bar-dragging" : ""}`}
        onDragLeave={() => {
          setDropAt(null);
          setBarAt(null);
        }}
        onMouseLeave={() => setHoverId(null)}
      >
        {features.map((f, i) => {
          const id = String(f.id);
          const s = status.get(id);
          const suppressed = f.suppressed === true;
          const failed = s && !s.ok;
          const isDatum = Object.hasOwn(DATUM_OPS, String(f.op));
          const rolled = i >= bar;
          const relation = parents.has(id) ? "parent" : children.has(id) ? "child" : undefined;
          return (
            <Fragment key={`${id}-${i}`}>
            {i === bar && rollbackBar}
            <li
              className={[
                failed && !rolled ? "failed" : "ok",
                suppressed ? "suppressed" : "",
                rolled ? "rolled-back" : "",
                selectedId === id || pickedDatums.includes(id) ? "selected" : "",
                dropAt === i ? "drop-target" : "",
                barAt === i ? "bar-target" : "",
                relation ? `${relation}-of-hover` : "",
                isDatum && datumView && !eyeOpen(id, datumView) ? "hidden-datum" : "",
              ].join(" ")}
              data-testid={`feature-${id}`}
              data-relation={relation}
              draggable
              onMouseEnter={() => setHoverId(id)}
              onDragStart={(e) => {
                setDragging(id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", id);
              }}
              onDragEnd={() => {
                setDragging(null);
                setDropAt(null);
              }}
              onDragOver={(e) => {
                if (barDrag) {
                  e.preventDefault();
                  setBarAt(i);
                  return;
                }
                if (!dragging) return;
                e.preventDefault();
                setDropAt(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (barDrag) {
                  onRollback?.(i);
                  setBarDrag(false);
                  setBarAt(null);
                  return;
                }
                if (dragging && dragging !== id) run({ type: "reorderFeature", id: dragging, index: i });
                setDragging(null);
                setDropAt(null);
              }}
            >
              <div className="feature-row-wrap">
                <button
                  className="feature-row"
                  onClick={() => onSelect(selectedId === id ? null : id)}
                  onDoubleClick={() => (f.op === "sketch" ? onEditSketch(id) : onShowDimensions?.(id))}
                  onContextMenu={(e) => {
                    if (!onAsk) return;
                    e.preventDefault();
                    onAsk({ kind: "feature", id }, e.clientX, e.clientY);
                  }}
                  title={
                    rolled
                      ? "Rolled back: below the rollback bar, not built. Drag the bar below it, or right-click: Roll to end"
                      : f.op === "sketch"
                        ? "Double-click to edit the sketch"
                        : onShowDimensions
                          ? "Double-click to show its dimensions on the model"
                          : undefined
                  }
                >
                  {/* What it is; a failed or suppressed one says so instead. */}
                  <span
                    className={`feature-icon ${suppressed ? "off" : rolled ? "rolled" : failed ? "failed" : "ok"}`}
                    aria-label={suppressed ? "suppressed" : rolled ? "rolled back" : failed ? "failed" : "rebuilt"}
                    title={suppressed ? "Suppressed: left out of the rebuild" : rolled ? "Rolled back: not built" : failed ? "Failed: see the error below" : undefined}
                  >
                    <Icon name={suppressed ? "suppress" : failed && !rolled ? "alert" : (OP_ICON[String(f.op)] ?? "sketch")} />
                  </span>
                  <span className="feature-op">{OP_LABEL[String(f.op)] ?? String(f.op)}</span>
                  <span className="feature-id">{id}</span>
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
                <span className="row-actions">
                  {isDatum && eye(id, id)}
                  <button
                    title={suppressed ? "Unsuppress" : "Suppress"}
                    aria-label={`${suppressed ? "Unsuppress" : "Suppress"} ${id}`}
                    onClick={() => run({ type: "suppressFeature", id, suppressed: !suppressed })}
                  >
                    <Icon name={suppressed ? "eye" : "suppress"} />
                  </button>
                  <button
                    title="Move up"
                    aria-label={`Move ${id} up`}
                    disabled={i === 0}
                    onClick={() => run({ type: "reorderFeature", id, index: i - 1 })}
                  >
                    <Icon name="up" />
                  </button>
                  <button
                    title="Move down"
                    aria-label={`Move ${id} down`}
                    disabled={i === features.length - 1}
                    onClick={() => run({ type: "reorderFeature", id, index: i + 1 })}
                  >
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
            </Fragment>
          );
        })}
        {bar >= features.length && features.length > 0 && rollbackBar}
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
