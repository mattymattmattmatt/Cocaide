// A sketch editing session: the draft lives here until Finish turns it into
// one document command (one undo step in the model). Inside the session
// there is a draft-level undo stack too.

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Constraint, DatumPlane, SketchEntity, SketchFeature, Vec2 } from "../../doc/types";
import { buildProfile } from "../../geom/profile";
import { sketchDof, solveSketch, wouldOverDefine } from "../../geom/solver";
import { evaluate } from "../../doc/parameters";
import { NumberInput, ParametersContext } from "../fields";
import { planeName } from "../PropertyPanel";
import { describeConstraint, removeEntities, suggestions, type SketchItem } from "./draft";
import { SketchCanvas, type Tool } from "./SketchCanvas";

export interface SketchSession {
  /** Existing feature id, or the id the new sketch will get. */
  id: string;
  isNew: boolean;
  plane: DatumPlane;
  entities: SketchEntity[];
  constraints: Constraint[];
  suppressed?: boolean;
}

interface Props {
  session: SketchSession;
  /** Model edges projected onto the plane (2D segment pairs). */
  reference: Float32Array;
  onFinish(feature: SketchFeature): void;
  onCancel(): void;
  /** Right-click on an entity or a constraint: ask about it, with the draft as it is now. */
  onAsk?(target: { kind: "entity"; entity: string } | { kind: "constraint"; index: number }, draft: SketchFeature, x: number, y: number): void;
  /** Set by the sketcher: replaces the draft with an accepted proposal's sketch (one sketch undo step). */
  applyRef?: { current: ((feature: SketchFeature) => void) | null };
}

interface DraftState {
  entities: SketchEntity[];
  constraints: Constraint[];
}

const TOOLS: [Tool, string, string][] = [
  ["select", "Select", "V"],
  ["line", "Line", "L"],
  ["rect", "Rectangle", "R"],
  ["circle", "Circle", "C"],
  ["arc", "Arc", "A"],
  ["slot", "Slot", "S"],
];

export function SketchMode({ session, reference, onFinish, onCancel, onAsk, applyRef }: Props) {
  const [past, setPast] = useState<DraftState[]>([]);
  const [future, setFuture] = useState<DraftState[]>([]);
  const [draft, setDraft] = useState<DraftState>({ entities: session.entities, constraints: session.constraints });
  /** Geometry during a drag, before it becomes a draft state. */
  const [live, setLive] = useState<SketchEntity[] | null>(null);
  const dragBase = useRef<SketchEntity[] | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [construction, setConstruction] = useState(false);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [selection, setSelection] = useState<SketchItem[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const params = useContext(ParametersContext);

  const entities = live ?? draft.entities;
  const commit = useCallback(
    (next: DraftState) => {
      setPast((p) => [...p, draft].slice(-200));
      setFuture([]);
      setDraft(next);
    },
    [draft],
  );
  const asFeature = (): SketchFeature => ({
    id: session.id,
    op: "sketch",
    plane: session.plane,
    entities: draft.entities,
    ...(draft.constraints.length ? { constraints: draft.constraints } : {}),
    ...(session.suppressed ? { suppressed: true } : {}),
  });
  if (applyRef) {
    applyRef.current = (f) => {
      commit({ entities: f.entities, constraints: f.constraints ?? [] });
      setSelection([]);
      setMessage(null);
    };
  }
  const undo = () => {
    if (!past.length) return;
    setFuture((f) => [draft, ...f]);
    setDraft(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
    setSelection([]);
  };
  const redo = () => {
    if (!future.length) return;
    setPast((p) => [...p, draft]);
    setDraft(future[0]);
    setFuture((f) => f.slice(1));
  };

  /** Re-solve with a new constraint set; refuse if it cannot be met. */
  const setConstraints = (constraints: Constraint[], entitiesIn = draft.entities): boolean => {
    const r = solveSketch(entitiesIn, constraints);
    if (!r.ok) {
      setMessage(r.error);
      return false;
    }
    setMessage(null);
    commit({ entities: r.entities, constraints });
    return true;
  };

  const addConstraint = (k: Constraint) => {
    if (wouldOverDefine(draft.entities, draft.constraints, k)) {
      setMessage("that would over-define the sketch: other constraints already fix it");
      return;
    }
    setConstraints([...draft.constraints, k]);
  };

  const onCreate = (entity: SketchEntity, coincident: [string, string][]) => {
    const constraints: Constraint[] = [...draft.constraints, ...coincident.map(([a, b]): Constraint => ({ type: "coincident", points: [a, b] }))];
    const r = solveSketch([...draft.entities, entity], constraints);
    if (!r.ok) {
      setMessage(r.error);
      return;
    }
    setMessage(null);
    commit({ entities: r.entities, constraints });
  };

  const onDrag = (phase: "move" | "end", handle: string, from: Vec2, to: Vec2) => {
    if (!dragBase.current) dragBase.current = draft.entities;
    const r = solveSketch(dragBase.current, draft.constraints, { drag: [{ handle, from, to }] });
    if (phase === "move") {
      if (r.ok) {
        setLive(r.entities);
        setMessage(null);
      } else {
        setMessage(r.error);
      }
      return;
    }
    const final = r.ok ? r.entities : live;
    dragBase.current = null;
    setLive(null);
    if (final) commit({ entities: final, constraints: draft.constraints });
  };

  const deleteSelection = () => {
    const ids = selection.flatMap((s) => (s.kind === "entity" ? [s.id] : []));
    if (!ids.length) return;
    commit(removeEntities(draft.entities, draft.constraints, ids));
    setSelection([]);
  };

  const toggleConstruction = () => {
    const ids = new Set(selection.flatMap((s) => (s.kind === "entity" ? [s.id] : [])));
    if (!ids.size) return setConstruction((c) => !c);
    commit({
      ...draft,
      entities: draft.entities.map((e) => {
        if (!ids.has(e.id)) return e;
        const { construction: was, ...rest } = e;
        return (was ? rest : { ...rest, construction: true }) as SketchEntity;
      }),
    });
  };

  const finish = () => {
    const f: SketchFeature = { id: session.id, op: "sketch", plane: session.plane, entities: draft.entities };
    if (draft.constraints.length) f.constraints = draft.constraints;
    if (session.suppressed) f.suppressed = true;
    onFinish(f);
  };

  // Keyboard: tools, delete, undo inside the sketch, Esc steps back out.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        e.stopPropagation();
        redo();
        return;
      }
      if (mod) return;
      if (e.key === "Escape") {
        if (tool !== "select") setTool("select");
        else setSelection([]);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelection();
        return;
      }
      const t = TOOLS.find(([, , key]) => key.toLowerCase() === e.key.toLowerCase());
      if (t) setTool(t[0]);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const dof = useMemo(() => {
    try {
      return sketchDof(draft.entities, draft.constraints);
    } catch {
      return null;
    }
  }, [draft]);
  const profile = useMemo(() => buildProfile(draft.entities), [draft.entities]);
  // Offer only constraints the sketch does not already have.
  const offers = useMemo(() => {
    const have = new Set(draft.constraints.map((k) => constraintKey(k)));
    return suggestions(draft.entities, selection).filter((o) => !have.has(constraintKey(o.make(o.value ?? 0))));
  }, [draft, selection]);

  return (
    <>
      <section className="center sketch-center">
        <div className="sketch-toolbar" role="toolbar" aria-label="Sketch tools">
          {TOOLS.map(([t, label, key]) => (
            <button key={t} aria-pressed={tool === t} onClick={() => setTool(t)} title={`${label} (${key})`} data-testid={`tool-${t}`}>
              {label}
            </button>
          ))}
          <span className="sep" />
          <button aria-pressed={construction} onClick={toggleConstruction} title="Construction geometry (toggle for new or selected entities)">
            Construction
          </button>
          <button aria-pressed={snapToGrid} onClick={() => setSnapToGrid((v) => !v)} title="Snap new points to the grid">
            Grid snap
          </button>
          <span className="sep" />
          <button onClick={undo} disabled={!past.length} title="Undo in sketch (Ctrl+Z)">
            Undo
          </button>
          <button onClick={redo} disabled={!future.length} title="Redo in sketch (Ctrl+Shift+Z)">
            Redo
          </button>
        </div>
        <SketchCanvas
          entities={entities}
          constraints={draft.constraints}
          reference={reference}
          tool={tool}
          construction={construction}
          snapToGrid={snapToGrid}
          selection={selection}
          onSelect={setSelection}
          onCreate={onCreate}
          onDrag={onDrag}
          onContext={(entity, x, y) => {
            if (!entity || !onAsk) return;
            setSelection([{ kind: "entity", id: entity }]);
            onAsk({ kind: "entity", entity }, asFeature(), x, y);
          }}
        />
        <div className="sketch-plane-label">{planeName(session.plane.normal, session.plane.origin)}</div>
      </section>
      <aside className="side right sketch-panel" data-testid="sketch-panel">
        <section className="panel">
          <h2>
            Sketch <span className="muted">{session.id}</span>
          </h2>
          <div className={`dof ${dof === 0 ? "full" : ""}`} data-testid="sketch-dof">
            {dof === null ? "—" : dof === 0 ? "Fully defined" : `${dof} degree${dof === 1 ? "" : "s"} of freedom`}
          </div>
          <div className={`profile-status ${profile.ok ? "" : "bad"}`} data-testid="profile-status">
            {draft.entities.filter((e) => !e.construction).length === 0
              ? "No profile yet"
              : profile.ok
                ? `Profile: ${profile.regions.length} region${profile.regions.length === 1 ? "" : "s"}, area ${round(profile.area)} mm²`
                : `Profile: ${profile.error}`}
          </div>
          {message && (
            <div className="command-error" role="alert" data-testid="sketch-message">
              {message}
            </div>
          )}
        </section>
        <section className="panel">
          <h2>Add constraint</h2>
          {offers.length === 0 ? (
            <p className="muted small">Select an entity, two entities, or points to see constraints.</p>
          ) : (
            <div className="offers">
              {offers.map((o) => (
                <Offer key={o.testId} offer={o} onAdd={(v) => addConstraint(o.make(v))} />
              ))}
            </div>
          )}
          {selection.some((s) => s.kind === "entity") && (
            <div className="row-buttons">
              <button onClick={deleteSelection}>Delete selected</button>
              <button onClick={toggleConstruction}>Toggle construction</button>
            </div>
          )}
        </section>
        <section className="panel constraints-panel">
          <h2>Constraints</h2>
          {draft.constraints.length === 0 && <p className="muted small">None yet.</p>}
          <ol className="constraint-list" data-testid="constraint-list">
            {draft.constraints.map((k, i) => (
              <li
                key={i}
                data-testid={`constraint-row-${i}`}
                onContextMenu={(e) => {
                  if (!onAsk) return;
                  e.preventDefault();
                  onAsk({ kind: "constraint", index: i }, asFeature(), e.clientX, e.clientY);
                }}
              >
                <span className="constraint-label">{describeConstraint(k)}</span>
                {"value" in k && (
                  <NumberInput
                    value={k.value}
                    min={0}
                    testId={`constraint-value-${i}`}
                    onCommit={(v) => {
                      // The sketcher solves numbers; an expression is evaluated here (Finish keeps unchanged ones).
                      const value = typeof v === "number" ? v : evaluate(v, params);
                      if (typeof value !== "number" && !value.ok) return setMessage(value.error);
                      const n = typeof value === "number" ? value : value.value;
                      setConstraints(draft.constraints.map((c, j) => (j === i ? ({ ...c, value: n } as Constraint) : c)));
                    }}
                  />
                )}
                <button
                  aria-label="Remove constraint"
                  onClick={() => setConstraints(draft.constraints.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
        </section>
        <section className="panel sketch-actions">
          <button className="primary" onClick={finish} data-testid="finish-sketch">
            Finish sketch
          </button>
          <button onClick={onCancel} data-testid="cancel-sketch">
            Cancel
          </button>
        </section>
      </aside>
    </>
  );
}

function Offer({ offer, onAdd }: { offer: ReturnType<typeof suggestions>[number]; onAdd(v: number): void }) {
  const [value, setValue] = useState(offer.value ?? 0);
  useEffect(() => setValue(offer.value ?? 0), [offer.value]);
  if (offer.value === undefined) {
    return (
      <button className="offer" onClick={() => onAdd(0)} data-testid={offer.testId}>
        {offer.label}
      </button>
    );
  }
  return (
    <div className="offer valued">
      <span>{offer.label}</span>
      <input
        type="number"
        step="any"
        value={value}
        data-testid={`${offer.testId}-value`}
        onChange={(e) => setValue(Number(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter") onAdd(value);
        }}
      />
      <button onClick={() => onAdd(value)} data-testid={offer.testId}>
        Add
      </button>
    </div>
  );
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Identity of a constraint, ignoring its value; coincident and equal pairs in either order. */
function constraintKey(k: Constraint): string {
  const { value: _ignored, ...rest } = k as Constraint & { value?: number };
  if (k.type === "coincident") return `coincident:${[...k.points].sort().join("|")}`;
  if (k.type === "equal") return `equal:${[...k.entities].sort().join("|")}`;
  return JSON.stringify(rest);
}
