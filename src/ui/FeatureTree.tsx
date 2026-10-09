// The feature tree: select, reorder (drag or arrows), suppress, delete.
// Every change is a document command; rejected moves say why. As in
// SOLIDWORKS, the default planes and the origin head it: a click selects one
// (and shows it while selected), the eye shows or hides it for good, a
// right-click offers Sketch on this plane, an offset plane, Ask AI. Plane,
// axis and point features carry an eye too. Showing is view state, never
// the document.

import { useState } from "react";
import type { AskTarget } from "../ask/packet";
import type { Command, RawDocument } from "../doc/commands";
import { DATUM_OPS } from "../features/datum";
import { UI_OPS } from "../features/uiDefs";
import type { RebuildView } from "../worker/protocol";
import { Icon, type IconName } from "./icons";
import { eyeOpen, TREE_DATUMS, type DatumView } from "./model/datumDisplay";
import { DEFAULT_DATUM_LABEL } from "./model/selection";
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
}

/** The icon of a default plane or the origin. */
const DATUM_ICON: Record<string, IconName> = { Front: "plane", Top: "plane", Right: "plane", Origin: "datumPoint" };

export function FeatureTree({ doc, view, selectedId, onSelect, onEditSketch, dispatch, onError, onAsk, pickedDatums = [], datumView, onPickDatum, onToggleEye, onDatumMenu }: Props) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const features = (doc?.features ?? []) as Record<string, unknown>[];
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
      <ol className="feature-list" onDragLeave={() => setDropAt(null)}>
        {features.map((f, i) => {
          const id = String(f.id);
          const s = status.get(id);
          const suppressed = f.suppressed === true;
          const failed = s && !s.ok;
          const isDatum = Object.hasOwn(DATUM_OPS, String(f.op));
          return (
            <li
              key={`${id}-${i}`}
              className={[
                failed ? "failed" : "ok",
                suppressed ? "suppressed" : "",
                selectedId === id || pickedDatums.includes(id) ? "selected" : "",
                dropAt === i ? "drop-target" : "",
                isDatum && datumView && !eyeOpen(id, datumView) ? "hidden-datum" : "",
              ].join(" ")}
              data-testid={`feature-${id}`}
              draggable
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
                if (!dragging) return;
                e.preventDefault();
                setDropAt(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging && dragging !== id) run({ type: "reorderFeature", id: dragging, index: i });
                setDragging(null);
                setDropAt(null);
              }}
            >
              <div className="feature-row-wrap">
                <button
                  className="feature-row"
                  onClick={() => onSelect(selectedId === id ? null : id)}
                  onDoubleClick={() => f.op === "sketch" && onEditSketch(id)}
                  onContextMenu={(e) => {
                    if (!onAsk) return;
                    e.preventDefault();
                    onAsk({ kind: "feature", id }, e.clientX, e.clientY);
                  }}
                  title={f.op === "sketch" ? "Double-click to edit the sketch" : undefined}
                >
                  {/* What it is; a failed or suppressed one says so instead. */}
                  <span
                    className={`feature-icon ${suppressed ? "off" : failed ? "failed" : "ok"}`}
                    aria-label={suppressed ? "suppressed" : failed ? "failed" : "rebuilt"}
                    title={suppressed ? "Suppressed: left out of the rebuild" : failed ? "Failed: see the error below" : undefined}
                  >
                    <Icon name={suppressed ? "suppress" : failed ? "alert" : (OP_ICON[String(f.op)] ?? "sketch")} />
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
              {s?.error && !suppressed && (
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
        })}
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
