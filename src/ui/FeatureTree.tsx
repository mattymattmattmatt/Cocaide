// The feature tree: select, reorder (drag or arrows), suppress, delete.
// Every change is a document command; rejected moves say why.

import { useState } from "react";
import type { AskTarget } from "../ask/packet";
import type { Command, RawDocument } from "../doc/commands";
import type { RebuildView } from "../worker/protocol";
import { OP_LABEL } from "./PropertyPanel";

interface Props {
  doc: RawDocument | null;
  view: RebuildView | null;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onEditSketch(id: string): void;
  dispatch(cmd: Command): string | null;
  onError(message: string): void;
  /** Right-click: ask about a feature, or about its failed rebuild. */
  onAsk?(target: AskTarget, x: number, y: number): void;
}

export function FeatureTree({ doc, view, selectedId, onSelect, onEditSketch, dispatch, onError, onAsk }: Props) {
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

  return (
    <section className="panel features" aria-label="Feature tree">
      <h2>Features</h2>
      {features.length === 0 && <p className="muted">Empty part. Start with a sketch.</p>}
      <ol className="feature-list" onDragLeave={() => setDropAt(null)}>
        {features.map((f, i) => {
          const id = String(f.id);
          const s = status.get(id);
          const suppressed = f.suppressed === true;
          const failed = s && !s.ok;
          return (
            <li
              key={`${id}-${i}`}
              className={[failed ? "failed" : "ok", suppressed ? "suppressed" : "", selectedId === id ? "selected" : "", dropAt === i ? "drop-target" : ""].join(" ")}
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
                  <span
                    className={`badge ${suppressed ? "off" : failed ? "failed" : "ok"}`}
                    aria-label={suppressed ? "suppressed" : failed ? "failed" : "rebuilt"}
                  >
                    {suppressed ? "–" : failed ? "!" : "✓"}
                  </span>
                  <span className="feature-op">{OP_LABEL[String(f.op)] ?? String(f.op)}</span>
                  <span className="feature-id">{id}</span>
                </button>
                <span className="row-actions">
                  <button
                    title={suppressed ? "Unsuppress" : "Suppress"}
                    aria-label={`${suppressed ? "Unsuppress" : "Suppress"} ${id}`}
                    onClick={() => run({ type: "suppressFeature", id, suppressed: !suppressed })}
                  >
                    {suppressed ? "◌" : "◉"}
                  </button>
                  <button
                    title="Move up"
                    aria-label={`Move ${id} up`}
                    disabled={i === 0}
                    onClick={() => run({ type: "reorderFeature", id, index: i - 1 })}
                  >
                    ↑
                  </button>
                  <button
                    title="Move down"
                    aria-label={`Move ${id} down`}
                    disabled={i === features.length - 1}
                    onClick={() => run({ type: "reorderFeature", id, index: i + 1 })}
                  >
                    ↓
                  </button>
                  <button
                    title="Delete"
                    aria-label={`Delete ${id}`}
                    onClick={() => {
                      if (!run({ type: "deleteFeature", id }) && selectedId === id) onSelect(null);
                    }}
                  >
                    ×
                  </button>
                </span>
              </div>
              {s?.error && !suppressed && (
                <div
                  className="feature-error"
                  data-testid={`feature-error-${id}`}
                  title="Right-click to ask about this error"
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
