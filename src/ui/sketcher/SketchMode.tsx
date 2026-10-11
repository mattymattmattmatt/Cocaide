// A sketch editing session: the draft lives here until Finish turns it into
// one document command (one undo step in the model). Inside the session
// there is a draft-level undo stack too.

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Constraint, DatumPlane, SketchEntity, SketchFeature, Vec2 } from "../../doc/types";
import { isConstruction } from "../../doc/sketch";
import { constraintTargets, withAxes } from "../../geom/axes";
import { measureConstraint } from "../../geom/constraints";
import { buildProfile } from "../../geom/profile";
import { sketchStatus, solveSketch, wouldOverDefine } from "../../geom/solver";
import { evaluate } from "../../doc/parameters";
import { NumberInput, ParametersContext } from "../fields";
import { planeName } from "../PropertyPanel";
import { constraintEntities, constraintSentence, describeConstraint, itemEntities, removeEntities, smartDimension, suggestions, type SketchItem, type Suggestion } from "./draft";
import { convertEdges, isModelId, materialize, modelEdge, modelEntities, modelIdsOf, renamed, type ModelView } from "./model";
import { namer, referenceName, shapeWords } from "./names";
import { dimensionText, RELATION } from "./annotate";
import { SketchCanvas, type CanvasEdit, type CanvasTarget, type DefinedState, type DrawProgress, type Tool } from "./SketchCanvas";
import { keyFor, keyHint, pointer, useCommands, useInputPrefs } from "../input";
import { Popup, ToolButton } from "../tools";
import { Icon, type IconName } from "../icons";
import { askEntry, ContextMenu, type ContextMenuState, type MenuEntry } from "../ContextMenu";
import { Flyout, IconTool, OptionControls, ToolStack, ToolStrip } from "./DrawTools";
import { flyoutChoice, loadMemory, remember, saveMemory, type ToolMemory } from "./tools/memory";
import { optionValues, SKETCH_TOOLS, toolbarEntries, toolByName, type Placement } from "./tools/run";
import type { SketchToolDef } from "./tools/types";
import { EDIT_TOOLS, editByName } from "./edit";
import { NO_PICKS, type EditInput, type EditPicks, type EditToolDef } from "./edit/types";
import type { Edit } from "../../geom/sketchEdit/relations";
import { explodable, explodeAll } from "../../geom/sketchEdit/explode";
import { checkSketch, fixAll, fixProblem, problemSummary, type SketchProblem } from "../../geom/sketchEdit/check";

export interface SketchSession {
  /** Existing feature id, or the id the new sketch will get. */
  id: string;
  isNew: boolean;
  plane: DatumPlane;
  entities: SketchEntity[];
  constraints: Constraint[];
  suppressed?: boolean;
  /** The sketch is a weldment profile (Phase I). */
  profile?: SketchFeature["profile"];
}

/** A dimension typed as "=b": solved with its value, written back as the expression. */
type Dimension = Constraint & { expr?: string };

interface Props {
  session: SketchSession;
  /**
   * The model as this sketch sees it: the part before the sketch (when it is
   * edited; as it is now for a new one), its edges projected into the plane.
   * They are drawn, snapped to, and related or dimensioned to (which adds a
   * reference entity), and Convert Entities copies them in.
   */
  model: ModelView;
  /** `weldment`: the weldment profile box is ticked; the profile card opens next. */
  onFinish(feature: SketchFeature, weldment: boolean): void;
  onCancel(): void;
  /** "Ask AI…" on an entity, a relation or dimension, or the sketch: ask about it, with the draft as it is now. */
  onAsk?(target: { kind: "entity"; entity: string } | { kind: "constraint"; index: number } | { kind: "sketch" }, draft: SketchFeature, x: number, y: number): void;
  /** Set by the sketcher: replaces the draft with an accepted proposal's sketch (one sketch undo step). */
  applyRef?: { current: ((feature: SketchFeature) => void) | null };
}

interface DraftState {
  entities: SketchEntity[];
  constraints: Constraint[];
}

/**
 * Select, Smart Dimension and Convert Entities, and the commands their keys
 * run (Settings → Keyboard). The drawing tools are the registry's (tools/).
 */
const MODES: [Tool, string, string, IconName][] = [
  ["select", "Select", "sketch.select", "select"],
  ["dimension", "Dimension", "sketch.dimension", "smartDimension"],
  ["convert", "Convert", "sketch.convert", "convertEntities"],
];

export function SketchMode({ session, model, onFinish, onCancel, onAsk, applyRef }: Props) {
  const [past, setPast] = useState<DraftState[]>([]);
  const [future, setFuture] = useState<DraftState[]>([]);
  const [draft, setDraft] = useState<DraftState>({ entities: session.entities, constraints: session.constraints });
  /** Geometry during a drag, before it becomes a draft state. */
  const [live, setLive] = useState<SketchEntity[] | null>(null);
  const dragBase = useRef<SketchEntity[] | null>(null);
  const [tool, setToolState] = useState<Tool>("select");
  /** Which tool each flyout shows, and each tool's options: remembered in this browser. */
  const [memory, setMemory] = useState<ToolMemory>(loadMemory);
  const [progress, setProgress] = useState<DrawProgress>({ placed: 0, arcNext: false });
  const keep = (next: ToolMemory) => {
    setMemory(next);
    saveMemory(next);
  };
  /** Picks a tool; a drawing tool becomes what its flyout shows. What the last tool said (a click it refused) goes. */
  const setTool = (t: Tool) => {
    const def = toolByName(t) ?? editByName(t);
    if (def) keep(remember(memory, def));
    if (t !== tool) setMessage(null);
    // An edit tool starts with what was selected before it (the entities to offset, the corners to round).
    const edit = editByName(t);
    setEditPicks(edit?.start?.(selection, draft) ?? NO_PICKS);
    if (edit) setPicked(null);
    // Convert Entities with model edges or faces picked converts them at once; with none, it picks them first.
    if (t === "convert" && tool !== "convert" && convertible(selection)) {
      convert(selection, false);
      return;
    }
    setToolState(t);
  };
  const drawing = toolByName(tool);
  /** The edit stack's order, two high: Trim ▾ over Convert, then the rest of the edit tools. */
  const editToolbar = useMemo(() => {
    const [first, ...rest] = toolbarEntries(EDIT_TOOLS);
    return [first, "convert" as const, ...rest];
  }, []);
  /** The edit tool in use (trim, fillet, offset ...), and what it has picked. */
  const editTool: EditToolDef | undefined = editByName(tool);
  const [editPicks, setEditPicks] = useState<EditPicks>(NO_PICKS);
  const optionsOf = drawing ?? editTool;
  const toolOptions = useMemo(() => (optionsOf ? optionValues(optionsOf, memory.options[optionsOf.name]) : {}), [optionsOf, memory]);
  const setOption = (key: string, value: number | string) => {
    if (optionsOf) keep({ ...memory, options: { ...memory.options, [optionsOf.name]: { ...toolOptions, [key]: value } } });
  };
  const [construction, setConstruction] = useState(false);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [selection, setSelection] = useState<SketchItem[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [weldment, setWeldment] = useState(!!session.profile);
  const [showRelations, setShowRelations] = useState(true);
  /** The relation or dimension selected on the canvas or in the list. */
  const [picked, setPicked] = useState<number | null>(null);
  /** SOLIDWORKS's Modify box: a new Smart Dimension, or an existing dimension being edited, where it was clicked. */
  const [modify, setModify] = useState<{ x: number; y: number; options: Suggestion[]; choice: number } | { x: number; y: number; index: number } | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
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
    ...(draft.constraints.length ? { constraints: draft.constraints.map(numeric) } : {}),
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

  /** The model edges, model vertices and sketch axes the sketch can relate to: the stand-ins and the axes beside its own entities. */
  const modelEnts = useMemo(() => modelEntities(model), [model]);
  const pool = useMemo(() => withAxes([...draft.entities, ...modelEnts]), [draft.entities, modelEnts]);
  const names = useMemo(() => namer(draft.entities, model), [draft.entities, model]);

  /**
   * The constraints with every model edge they name made a reference entity
   * of the sketch (a construction entity whose ref finds the edge again when
   * the part rebuilds; one the sketch has already is reused). A string says why not.
   */
  const lift = (ks: Constraint[], entities = draft.entities): { entities: SketchEntity[]; constraints: Constraint[] } | string => {
    const ids = ks.flatMap(modelIdsOf);
    if (!ids.length) return { entities, constraints: ks };
    const made = materialize(ids, model, entities);
    if (typeof made === "string") return made;
    return { entities: made.entities, constraints: ks.map((k) => renamed(k, made.ids)) };
  };

  const addConstraint = (raw: Constraint): boolean => {
    const lifted = lift([raw]);
    if (typeof lifted === "string") {
      setMessage(lifted);
      return false;
    }
    const k = lifted.constraints[0];
    if (wouldOverDefine(lifted.entities, draft.constraints, k)) {
      setMessage("that would over-define the sketch: other relations or dimensions already fix it");
      return false;
    }
    return setConstraints([...draft.constraints, k], lifted.entities);
  };

  /** Sets dimension `i` to a number or an "=expression" (kept beside its value, written back on Finish). */
  const setDimension = (i: number, v: number | string): boolean => {
    const value = typeof v === "number" ? v : evaluate(v, params);
    if (typeof value !== "number" && !value.ok) {
      setMessage(value.error);
      return false;
    }
    const n = typeof value === "number" ? value : value.value;
    return setConstraints(draft.constraints.map((c, j) => (j === i ? ({ ...numeric(c), value: n, ...(typeof v === "string" ? { expr: v } : {}) } as Constraint) : c)));
  };

  const removeConstraint = (i: number) => {
    setConstraints(draft.constraints.filter((_, j) => j !== i));
    setPicked(null);
  };

  /**
   * A drawn shape: its entities and the relations that hold its shape, with
   * the relations its clicks inferred: kept when the sketch can meet them, and
   * each only if it adds something. If they can't all be met, the snaps alone;
   * then none.
   */
  const onCreate = ({ entities: made, relations, inferred }: Placement) => {
    // A click that snapped to the model ties the new geometry to it: the edge becomes a reference, if the relation stays.
    const lifted = lift([...relations, ...inferred], [...draft.entities, ...made]);
    const own = typeof lifted === "string" ? null : lifted;
    if (typeof lifted === "string") setMessage(lifted);
    const shape = own ? own.constraints.slice(0, relations.length) : relations;
    const inferredLifted = own ? own.constraints.slice(relations.length) : inferred.filter((k) => !modelIdsOf(k).length);
    const all = own ? own.entities : [...draft.entities, ...made];
    const tries = [inferredLifted, inferredLifted.filter((k) => k.type === "coincident"), []];
    let error = "";
    for (const ks of tries) {
      const constraints = [...draft.constraints, ...shape];
      for (const k of ks) if (!wouldOverDefine(all, constraints, k)) constraints.push(k);
      // A reference made for a relation that was dropped is dropped with it.
      const used = new Set(constraints.flatMap(constraintTargets));
      const entities = all.filter((e) => draft.entities.includes(e) || made.includes(e) || used.has(e.id));
      const r = solveSketch(entities, constraints);
      if (r.ok) {
        if (typeof lifted !== "string") setMessage(null);
        commit({ entities: r.entities, constraints });
        return;
      }
      error = r.error;
    }
    setMessage(error);
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

  /** The entities the items stand for: entities, and sketch points picked by their dots. */
  const entityIds = (items: SketchItem[]) => itemEntities(items, draft.entities);
  /** Those that can be construction geometry: a sketch point never is profile anyway. */
  const lineworkIds = (items: SketchItem[]) => entityIds(items).filter((id) => draft.entities.find((e) => e.id === id)?.type !== "point");

  /** Deletes the selected relation, or the selected (or given) entities and their relations. */
  const deleteSelection = (items = selection) => {
    if (picked !== null && items === selection) return removeConstraint(picked);
    const ids = entityIds(items);
    if (!ids.length) return;
    commit(removeEntities(draft.entities, draft.constraints, ids));
    setSelection([]);
  };

  /**
   * Turns the selected (or given) entities to construction geometry and back
   * (Q), as one: all construction when any is not, else all back to profile
   * geometry. A point picked on a line, arc or circle stands for it. With
   * nothing selected, it turns construction on or off for the next ones drawn.
   * A reference is construction unless it says otherwise, so turning it to
   * profile geometry writes construction: false.
   */
  const toggleConstruction = (items = selection) => {
    const owners = items.flatMap((i) => (i.kind === "point" ? [i.ref.split(".")[0]] : [])).filter((id) => {
      const e = draft.entities.find((x) => x.id === id);
      return !!e && e.type !== "point";
    });
    const ids = new Set([...lineworkIds(items), ...owners]);
    if (!ids.size) {
      if (items.length) return setMessage("construction is for the sketch's own lines, arcs, circles and slots: a model edge or an axis is already a reference");
      return setConstruction((c) => !c);
    }
    const next = !draft.entities.filter((e) => ids.has(e.id)).every(isConstruction);
    commit({
      ...draft,
      entities: draft.entities.map((e) => {
        if (!ids.has(e.id)) return e;
        const { construction: _was, ...rest } = e;
        // Whichever way, write only what differs from the entity's default.
        return (next === !!e.ref ? rest : { ...rest, construction: next }) as SketchEntity;
      }),
    });
  };

  /** Model edges or faces among the items: what Convert Entities takes. */
  const convertible = (items: SketchItem[]) => items.some((i) => i.kind === "face" || (i.kind === "entity" && isModelId(i.id)));

  /**
   * Convert Entities: the picked model edges, and each picked face's
   * outline, into the sketch as references (profile geometry unless
   * `construction`) joined where they meet. They follow the model.
   */
  const convert = (items: SketchItem[], construction: boolean) => {
    const edges = items.flatMap((i) => (i.kind === "entity" && isModelId(i.id) ? [i.id] : []));
    const faces = items.flatMap((i) => (i.kind === "face" ? [i.index] : []));
    const r = convertEdges(edges, faces, model, draft.entities, draft.constraints, construction);
    if (typeof r === "string") return setMessage(r);
    if (setConstraints(r.constraints, r.entities)) {
      setSelection([]);
      setToolState("select");
      setMessage(null);
    }
  };

  /**
   * An edit tool's result into the sketch, as one undo step: its relations,
   * then each relation it would like (where a trimmed end landed) that adds
   * something without over-defining, solved. If the sketch can't be solved
   * with those, without them; else nothing changes and the reason shows.
   */
  const applyEdit = (r: Edit | string | null | undefined): boolean => {
    if (!r) return false;
    if (typeof r === "string") {
      setMessage(r);
      return false;
    }
    const withSoft = [...r.constraints];
    for (const k of r.soft ?? []) {
      try {
        if (!wouldOverDefine(r.entities, withSoft, k)) withSoft.push(k);
      } catch {
        // A relation the solver can't read here is one it doesn't need.
      }
    }
    let error = "";
    for (const constraints of withSoft.length === r.constraints.length ? [withSoft] : [withSoft, r.constraints]) {
      const solved = solveSketch(r.entities, constraints);
      if (solved.ok) {
        commit({ entities: solved.entities, constraints });
        setSelection([]);
        setPicked(null);
        setMessage(r.note ?? null);
        return true;
      }
      error = solved.error;
    }
    setMessage(error);
    return false;
  };

  /** An edit tool started on the given items (from the right-click menu), whatever was selected before. */
  const startEdit = (name: string, items: SketchItem[]) => {
    const def = editByName(name);
    if (!def) return;
    keep(remember(memory, def));
    setMessage(null);
    setEditPicks(def.start?.(items, draft) ?? NO_PICKS);
    setToolState(name);
  };

  /** The edit tool's picks after an edit: what it would start with on an empty selection. */
  const restartEdit = () => setEditPicks(editTool?.start?.([], draft) ?? NO_PICKS);

  const onEditClick = (input: EditInput) => {
    if (!editTool) return;
    const step = editTool.click(draft, editPicks, input, toolOptions);
    if ("picks" in step) {
      setEditPicks(step.picks);
      setMessage(null);
    } else if ("message" in step) setMessage(step.message);
    else if (applyEdit(step.edit)) restartEdit();
  };

  const onEditStroke = (path: Vec2[]) => {
    const r = editTool?.drag?.(draft, path, toolOptions);
    if (r === null || r === undefined) return setMessage("the stroke crossed nothing to trim: drag across the pieces to trim");
    applyEdit(r);
  };

  /** Apply (Enter): a collecting tool makes its edit; a move still picking its entities goes on to its base point. */
  const applyCollect = () => {
    if (editTool?.kind !== "collect") return;
    if (editPicks.picking === true && editPicks.entities.length) return setEditPicks({ ...editPicks, picking: false });
    const r = editTool.apply?.(draft, editPicks, toolOptions);
    if (r === null || r === undefined) return setMessage(`${editTool.label}: ${editTool.prompt(editPicks, toolOptions).replace(/^./, (c) => c.toLowerCase())} first`);
    if (applyEdit(r)) restartEdit();
  };

  /** What the edit tool would make now (null: not enough picked; a string: why it can't). */
  const pending = useMemo(
    () => (editTool?.kind === "collect" ? (editTool.apply?.(draft, editPicks, toolOptions) ?? null) : null),
    [editTool, draft, editPicks, toolOptions],
  );

  /** The canvas's side of the edit tool: its picks as selected items, its preview, its clicks. */
  const canvasEdit = useMemo((): CanvasEdit | undefined => {
    if (!editTool) return undefined;
    const chosen = [
      ...editPicks.entities.map((id) => ({ kind: "entity" as const, id })),
      ...editPicks.points.map((ref) => ({ kind: "point" as const, ref })),
      ...(editPicks.about ? [{ kind: "entity" as const, id: editPicks.about }] : []),
    ];
    const places = editTool.places?.(editPicks, toolOptions) ?? false;
    return {
      tool: editTool,
      picks: editPicks,
      chosen,
      places,
      follows: editTool.kind === "click" || places,
      preview: (hover) => {
        try {
          return editTool.preview?.(draft, editPicks, toolOptions, hover) ?? {};
        } catch {
          return {};
        }
      },
      onClick: onEditClick,
      onStroke: onEditStroke,
    };
  }, [editTool, editPicks, toolOptions, draft]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Explode: the picked rectangle and slot entities become lines and arcs, held in shape (so they trim and fillet). */
  const explodeItems = (items = selection) => {
    const ids = entityIds(items).filter((id) => explodable(draft.entities.find((e) => e.id === id)));
    if (!ids.length) return setMessage("select a rectangle or slot entity to explode (lines and arcs already are)");
    const r = explodeAll(draft, ids);
    applyEdit({ ...r.state, made: r.ids });
  };

  /** Check sketch for feature: what keeps the profile from being clean, for the status line, the marks and the check panel. */
  const check = useMemo(() => checkSketch(entities), [entities]);
  const [showCheck, setShowCheck] = useState(false);
  const fix = (p: SketchProblem | "all") => applyEdit(p === "all" ? fixAll(draft) : fixProblem(draft, p));

  const finish = () => {
    const f: SketchFeature = { id: session.id, op: "sketch", plane: session.plane, entities: draft.entities };
    // A dimension typed as an expression goes into the document as one, so a parameter keeps driving it.
    if (draft.constraints.length) f.constraints = draft.constraints.map((c: Dimension) => (c.expr ? ({ ...numeric(c), value: c.expr } as unknown as Constraint) : numeric(c)));
    if (session.suppressed) f.suppressed = true;
    if (weldment && session.profile) f.profile = session.profile;
    onFinish(f, weldment);
  };

  // Keyboard: the sketch's commands (tools, undo inside the sketch, delete, finish, the shortcut bar) are
  // bound in Settings; Esc steps back out, Backspace deletes too, and Ctrl+Shift+Z redoes as well.
  const prefs = useInputPrefs();
  const [bar, setBar] = useState<{ x: number; y: number } | null>(null);
  useCommands({
    undo,
    redo,
    delete: () => deleteSelection(),
    repeat: () => (tool === "convert" ? convert(selection, false) : applyCollect()),
    shortcutBar: () => setBar({ x: pointer.x, y: pointer.y }),
    // Q: the selection, or while an edit tool is in use, what it has picked.
    "sketch.construction": () => toggleConstruction(editTool && editPicks.entities.length ? editPicks.entities.map((id) => ({ kind: "entity" as const, id })) : selection),
    "sketch.explode": () => explodeItems(),
    "sketch.check": () => setShowCheck((v) => !v),
    "sketch.finish": finish,
    ...Object.fromEntries(MODES.map(([t, , id]) => [id, () => setTool(t)])),
    ...Object.fromEntries(SKETCH_TOOLS.map((t) => [t.id, () => setTool(t.name)])),
    ...Object.fromEntries(EDIT_TOOLS.map((t) => [t.id, () => setTool(t.name)])),
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.defaultPrevented || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        redo();
      } else if (e.key === "Escape") {
        if (modify || menu) return;
        // An edit tool drops what it picked first, then itself.
        if (editTool && (editPicks.entities.length || editPicks.points.length || editPicks.places.length || editPicks.about)) restartEdit();
        else if (tool !== "select") setTool("select");
        else {
          setSelection([]);
          setPicked(null);
        }
      } else if (e.key === "Backspace" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        deleteSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // How defined the sketch is, entity by entity: SOLIDWORKS's blue, black and red.
  const status = useMemo(() => {
    try {
      const st = sketchStatus(draft.entities, draft.constraints);
      const conflicts = new Set<string>();
      draft.constraints.forEach((k) => {
        const m = measureConstraint(draft.entities, k);
        if (!(Math.abs(m.actual - m.expected) <= 1e-6)) constraintEntities(k).forEach((id) => conflicts.add(id));
      });
      return { ...st, conflicts } as DefinedState & { dof: number };
    } catch {
      return null;
    }
  }, [draft]);
  const dof = status?.dof ?? null;
  const profile = useMemo(() => buildProfile(draft.entities), [draft.entities]);
  /** It ties something of the sketch's own: a relation between references and axes alone holds by the model, and adds nothing. */
  const touchesSketch = (k: Constraint) => constraintTargets(k).some((id) => draft.entities.some((e) => e.id === id && !e.ref));
  // Offer only relations and dimensions the sketch does not already have, between the sketch and itself, the model or its axes.
  const offers = useMemo(() => {
    const have = new Set(draft.constraints.map((k) => constraintKey(k)));
    return suggestions(pool, selection).filter((o) => {
      const k = o.make(o.value ?? 0);
      return touchesSketch(k) && !have.has(constraintKey(k));
    });
  }, [draft, selection, pool]); // eslint-disable-line react-hooks/exhaustive-deps
  const relations = offers.filter((o) => o.value === undefined);
  const dimensions = offers.filter((o) => o.value !== undefined);

  /** Smart Dimension placed: the Modify box opens with what it measures now. */
  const onDimension = (picks: SketchItem[], at: Vec2, x: number, y: number) => {
    const have = new Set(draft.constraints.map((k) => constraintKey(k)));
    const options = smartDimension(pool, picks, at).filter((o) => touchesSketch(o.make(o.value ?? 0)) && !have.has(constraintKey(o.make(o.value ?? 0))));
    if (!options.length)
      return setMessage(
        picks.every((p) => p.kind !== "face" && !draft.entities.some((e) => !e.ref && e.id === (p.kind === "entity" ? p.id : p.ref.split(".")[0])))
          ? "dimension the sketch's own geometry: pick one of its points, lines or circles with the model edge or axis"
          : "those can't be dimensioned together; pick a line, circle, arc, or two points, lines or circles",
      );
    setMessage(null);
    setModify({ x, y, options, choice: 0 });
  };

  /** A picked item as the selection list reads it: a reference says what it follows. */
  const describeItem = (i: SketchItem): string => {
    if (i.kind === "face") return `Model face: its outline converts (${model.faces.find((f) => f.index === i.index)?.edges.length ?? 0} edges)`;
    if (i.kind === "point") return `Point: ${names.point(i.ref)}`;
    if (i.id === "X" || i.id === "Y") return `${i.id} axis of the sketch`;
    if (isModelId(i.id)) {
      const m = modelEdge(model, i.id);
      return m?.entity ? `Model edge: ${shapeWords(m.entity)}` : `Model edge: ${m?.problem ?? "can't be referenced"}`;
    }
    const e = draft.entities.find((x) => x.id === i.id);
    if (!e) return i.id;
    if (e.ref) return `Reference: ${referenceName(e)} (${e.id}${isConstruction(e) ? ", construction" : ", converted"}): it follows the model`;
    return `${RELATION_NOUN[e.type]} ${e.id}${e.construction ? " (construction)" : ""}`;
  };

  /** The right-click menu for whatever is under the pointer, as SOLIDWORKS's sketch menus have it. */
  const openMenu = (target: CanvasTarget | null, x: number, y: number) => {
    const ask = (t: Parameters<NonNullable<Props["onAsk"]>>[0]) => (onAsk ? [askEntry(() => onAsk(t, asFeature(), x, y))] : []);
    // Select, Smart Dimension, then each toolbar button's tool: a flyout's, the one it shows.
    const tools: MenuEntry[] = [
      ...MODES.map(([t, label, id, icon]): MenuEntry => ({ label: t === "dimension" ? "Smart Dimension" : label, icon, shortcut: keyFor(id, prefs) ?? undefined, onClick: () => setTool(t), testId: `ctx-tool-${t}` })),
      ...toolbarEntries().map((entry): MenuEntry => {
        const t = entry.kind === "flyout" ? flyoutChoice(memory, entry.flyout.id, SKETCH_TOOLS) : entry.tool;
        return { label: t.label, icon: t.icon, shortcut: keyFor(t.id, prefs) ?? undefined, onClick: () => setTool(t.name), testId: `ctx-tool-${t.name}` };
      }),
      "sep",
      // The edit tools, each flyout's as it shows.
      ...toolbarEntries(EDIT_TOOLS).map((entry): MenuEntry => {
        const t = entry.kind === "flyout" ? flyoutChoice(memory, entry.flyout.id, EDIT_TOOLS) : entry.tool;
        return { label: t.label, icon: t.icon, shortcut: keyFor(t.id, prefs) ?? undefined, onClick: () => setTool(t.name), testId: `ctx-tool-${t.name}` };
      }),
      { label: "Check sketch", icon: "checkSketch", onClick: () => setShowCheck(true), testId: "ctx-check" },
    ];
    if (!target) {
      setPicked(null);
      return setMenu({
        x,
        y,
        title: `Sketch ${session.id}`,
        items: [
          ...tools,
          "sep",
          { label: showRelations ? "Hide relations" : "Show relations", icon: showRelations ? "eyeOff" : "eye", onClick: () => setShowRelations((v) => !v), testId: "ctx-relations" },
          { label: "Undo", icon: "undo", disabled: !past.length, onClick: undo },
          "sep",
          { label: "Exit sketch", icon: "check", shortcut: keyFor("sketch.finish", prefs) ?? undefined, onClick: finish, testId: "ctx-finish" },
          { label: "Cancel sketch", icon: "x", onClick: onCancel },
          "sep",
          ...ask({ kind: "sketch" }),
        ],
      });
    }
    if (target.kind === "constraint") {
      const k = draft.constraints[target.index];
      if (!k) return;
      setPicked(target.index);
      const isDim = "value" in k;
      return setMenu({
        x,
        y,
        title: `${RELATION[k.type].label}${isDim ? ` ${dimensionText(k)}` : ""}`,
        items: [
          ...(isDim ? [{ label: "Edit value…", icon: "smartDimension", onClick: () => setModify({ x, y, index: target.index }), testId: "ctx-edit-dimension" } as MenuEntry] : []),
          { label: isDim ? "Delete dimension" : "Delete relation", icon: "trash", shortcut: "Delete", onClick: () => removeConstraint(target.index), testId: "ctx-delete-constraint" },
          "sep",
          ...ask({ kind: "constraint", index: target.index }),
        ],
      });
    }
    // An entity or point: right-clicking something outside the selection selects it alone, as SOLIDWORKS does.
    const item: SketchItem = target.kind === "entity" ? { kind: "entity", id: target.id } : { kind: "point", ref: target.ref };
    const inSelection = selection.some((s) => (s.kind === "entity" && item.kind === "entity" ? s.id === item.id : s.kind === "point" && item.kind === "point" && s.ref === item.ref));
    const items = inSelection ? selection : [item];
    if (!inSelection) setSelection(items);
    setPicked(null);
    const have = new Set(draft.constraints.map((k) => constraintKey(k)));
    const offered = suggestions(pool, items).filter((o) => touchesSketch(o.make(o.value ?? 0)) && !have.has(constraintKey(o.make(o.value ?? 0))));
    const ids = entityIds(items);
    const linework = lineworkIds(items);
    const owner = target.kind === "entity" ? target.id : target.ref.split(".")[0];
    const e = draft.entities.find((x) => x.id === owner);
    const name = (id: string) => {
      const own = draft.entities.find((x) => x.id === id);
      if (!own) return names.entity(id).replace(/^model edge/, "Model edge").replace(/^([XY]) axis$/, "$1 axis");
      return own.ref ? `Reference ${id}: ${referenceName(own)}` : `${RELATION_NOUN[own.type]} ${id}`;
    };
    const fromModel = convertible(items);
    setMenu({
      x,
      y,
      title: items.length > 1 ? `${items.length} items` : target.kind === "point" ? (e?.type === "point" ? name(e.id) : `Point: ${names.point(target.ref)}`) : name(target.id),
      items: [
        // A model edge: copy it into the sketch, as profile geometry or as construction.
        ...(fromModel
          ? [
              { label: "Convert entities", icon: "convertEntities", onClick: () => convert(items, false), testId: "ctx-convert" } as MenuEntry,
              { label: "Convert as construction", icon: "construction", onClick: () => convert(items, true), testId: "ctx-convert-construction" } as MenuEntry,
              "sep" as const,
            ]
          : []),
        ...(offered.some((o) => o.value === undefined) ? [{ heading: "Add relation" } as MenuEntry] : []),
        ...offered
          .filter((o) => o.value === undefined)
          .map((o): MenuEntry => ({ label: o.label, icon: o.icon, onClick: () => addConstraint(o.make(0)), testId: `ctx-${o.testId}` })),
        ...(offered.some((o) => o.value !== undefined)
          ? [
              {
                label: "Smart Dimension",
                icon: "smartDimension",
                onClick: () => {
                  const options = smartDimension(pool, items).filter((o) => touchesSketch(o.make(o.value ?? 0)) && !have.has(constraintKey(o.make(o.value ?? 0))));
                  if (options.length) setModify({ x, y, options, choice: 0 });
                  else setTool("dimension");
                },
                testId: "ctx-dimension",
              } as MenuEntry,
            ]
          : []),
        "sep",
        // These act on what the menu is for, not on the selection as it was before this right-click.
        ...(linework.length
          ? [
              {
                label: linework.every((id) => draft.entities.find((x) => x.id === id)?.construction) ? "Make normal geometry" : "Construction geometry",
                icon: "construction",
                onClick: () => toggleConstruction(items),
                testId: "ctx-construction",
              } as MenuEntry,
            ]
          : []),
        ...(ids.length
          ? [{ label: ids.length > 1 ? `Delete ${ids.length} entities` : "Delete", icon: "trash", shortcut: "Delete", onClick: () => deleteSelection(items), testId: "ctx-delete" } as MenuEntry]
          : []),
        // The edit tools on what the menu is for: a corner rounds; entities explode, offset, mirror, pattern, move.
        ...(() => {
          const own = ids.filter((id) => !draft.entities.find((x) => x.id === id)?.ref);
          const corner = target.kind === "point" && draft.entities.filter((x) => (x.type === "line" || x.type === "arc") && !x.ref).filter((x) => {
            const p = draft.entities.find((y) => y.id === owner);
            const at = p ? (p as unknown as Record<string, Vec2>)[target.ref.split(".")[1]] : undefined;
            return !!at && ["start", "end"].some((n) => {
              const q = (x as unknown as Record<string, Vec2>)[n];
              return Math.hypot(q[0] - at[0], q[1] - at[1]) < 1e-6;
            });
          }).length === 2;
          const entries: MenuEntry[] = [];
          if (corner) {
            entries.push({ label: "Fillet corner…", icon: "sketchFillet", onClick: () => startEdit("fillet", [item]), testId: "ctx-fillet" });
            entries.push({ label: "Chamfer corner…", icon: "sketchChamfer", onClick: () => startEdit("chamfer", [item]), testId: "ctx-chamfer" });
          }
          if (own.some((id) => explodable(draft.entities.find((x) => x.id === id)))) entries.push({ label: "Explode into lines and arcs", icon: "explodeEntity", onClick: () => explodeItems(items), testId: "ctx-explode" });
          if (own.length && !corner) {
            const on = own.map((id) => ({ kind: "entity" as const, id }));
            entries.push(
              { label: "Offset entities…", icon: "offset", onClick: () => startEdit("offset", on), testId: "ctx-offset" },
              { label: "Mirror entities…", icon: "mirrorEntities", onClick: () => startEdit("mirror", on), testId: "ctx-mirror" },
              { label: "Linear pattern…", icon: "linearSketchPattern", onClick: () => startEdit("linear-pattern", on), testId: "ctx-linear-pattern" },
              { label: "Circular pattern…", icon: "circularSketchPattern", onClick: () => startEdit("circular-pattern", on), testId: "ctx-circular-pattern" },
              { label: "Move entities…", icon: "moveEntities", onClick: () => startEdit("move", on), testId: "ctx-move" },
              { label: "Rotate entities…", icon: "rotateEntities", onClick: () => startEdit("rotate", on), testId: "ctx-rotate" },
            );
          }
          return entries.length ? (["sep", ...entries] as MenuEntry[]) : [];
        })(),
        "sep",
        ...(e ? ask({ kind: "entity", entity: e.id }) : []),
      ],
    });
  };

  return (
    <>
      <section className="center sketch-center">
        <div className="sketch-toolbar" role="toolbar" aria-label="Sketch tools">
          {MODES.filter(([t]) => t !== "convert").map(([t, label, id, icon]) => (
            <ToolButton key={t} icon={icon} label={label} pressed={tool === t} onClick={() => setTool(t)} title={`${TOOL_TITLE[t] ?? label}${keyHint(id, prefs)}`} testId={`tool-${t}`} />
          ))}
          <span className="sep" />
          {toolbarEntries().map((entry) =>
            entry.kind === "flyout" ? (
              <Flyout
                key={entry.flyout.id}
                flyout={entry.flyout}
                tools={entry.tools}
                shown={flyoutChoice(memory, entry.flyout.id, SKETCH_TOOLS)}
                active={tool}
                onPick={(t: SketchToolDef) => setTool(t.name)}
              />
            ) : (
              <ToolButton
                key={entry.tool.name}
                icon={entry.tool.icon}
                label={entry.tool.label}
                pressed={tool === entry.tool.name}
                onClick={() => setTool(entry.tool.name)}
                title={`${entry.tool.title}${keyHint(entry.tool.id, prefs)}`}
                testId={`tool-${entry.tool.name}`}
              />
            ),
          )}
          <span className="sep" />
          {/* The edit tools and Convert, small and two high: Trim ▾ over Convert, Offset over Fillet ▾, Mirror over Pattern ▾, Move ▾. */}
          <ToolStack label="Edit tools">
            {editToolbar.map((entry) =>
              entry === "convert" ? (
                <IconTool
                  key="convert"
                  small
                  icon="convertEntities"
                  label="Convert"
                  pressed={tool === "convert"}
                  onClick={() => setTool("convert")}
                  title={`${TOOL_TITLE.convert}${keyHint("sketch.convert", prefs)}`}
                  testId="tool-convert"
                />
              ) : entry.kind === "flyout" ? (
                <Flyout
                  key={entry.flyout.id}
                  small
                  flyout={entry.flyout}
                  tools={entry.tools}
                  shown={flyoutChoice(memory, entry.flyout.id, EDIT_TOOLS)}
                  active={tool}
                  onPick={(t: EditToolDef) => setTool(t.name)}
                />
              ) : (
                <IconTool
                  key={entry.tool.name}
                  small
                  icon={entry.tool.icon}
                  label={entry.tool.label}
                  pressed={tool === entry.tool.name}
                  onClick={() => setTool(entry.tool.name)}
                  title={`${entry.tool.title}${keyHint(entry.tool.id, prefs)}`}
                  testId={`tool-${entry.tool.name}`}
                />
              ),
            )}
          </ToolStack>
          <span className="sep" />
          <ToolStack label="Display and history">
            <IconTool
              small
              icon="construction"
              label="Construction"
              pressed={construction}
              onClick={() => toggleConstruction()}
              title={`Construction geometry: guides that are not part of the profile (toggles new or selected entities)${keyHint("sketch.construction", prefs)}`}
              testId="tool-construction"
            />
            <IconTool small icon="grid" label="Grid" pressed={snapToGrid} onClick={() => setSnapToGrid((v) => !v)} title="Grid: snap new points to it" testId="tool-grid" />
            <IconTool
              small
              icon={showRelations ? "eye" : "eyeOff"}
              label="Relations"
              pressed={showRelations}
              onClick={() => setShowRelations((v) => !v)}
              title="Relations: show or hide the glyphs beside the geometry"
              testId="tool-relations"
            />
            <IconTool
              small
              icon="checkSketch"
              label="Check sketch"
              pressed={showCheck}
              onClick={() => setShowCheck((v) => !v)}
              title={`Check sketch for feature: open ends, gaps, crossings, overlaps, duplicates, with one-click fixes${keyHint("sketch.check", prefs)}`}
              testId="tool-check"
            />
            <IconTool small icon="undo" label="Undo" onClick={undo} disabled={!past.length} title={`Undo in sketch${keyHint("undo", prefs)}`} testId="sketch-undo" />
            <IconTool small icon="redo" label="Redo" onClick={redo} disabled={!future.length} title={`Redo in sketch${keyHint("redo", prefs)}`} testId="sketch-redo" />
          </ToolStack>
          {bar && (
            <Popup x={bar.x} y={bar.y} bar onClose={() => setBar(null)} label="Shortcut bar" testId="shortcut-bar">
              {(close) => (
                <>
                  {MODES.map(([t, label, , icon]) => (
                    <ToolButton
                      key={t}
                      icon={icon}
                      label={label}
                      pressed={tool === t}
                      testId={`bar-${t}`}
                      onClick={() => {
                        close();
                        setTool(t);
                      }}
                    />
                  ))}
                  {[...SKETCH_TOOLS, ...EDIT_TOOLS].map((t) => (
                    <ToolButton
                      key={t.name}
                      icon={t.icon}
                      label={t.label}
                      pressed={tool === t.name}
                      testId={`bar-${t.name}`}
                      onClick={() => {
                        close();
                        setTool(t.name);
                      }}
                    />
                  ))}
                  <ToolButton
                    icon="construction"
                    label="Construction"
                    pressed={construction}
                    onClick={() => {
                      close();
                      toggleConstruction();
                    }}
                  />
                </>
              )}
            </Popup>
          )}
        </div>
        <SketchCanvas
          entities={entities}
          constraints={draft.constraints}
          model={model}
          tool={tool}
          options={toolOptions}
          construction={construction}
          snapToGrid={snapToGrid}
          selection={selection}
          onSelect={(items) => {
            setSelection(items);
            setPicked(null);
          }}
          onCreate={onCreate}
          onMessage={setMessage}
          onProgress={setProgress}
          onDrag={onDrag}
          onContext={openMenu}
          defined={status ?? undefined}
          showRelations={showRelations}
          selectedConstraint={picked}
          onSelectConstraint={(i) => {
            setPicked(i);
            setSelection([]);
          }}
          onEditDimension={(index, x, y) => setModify({ x, y, index })}
          onDimension={onDimension}
          edit={canvasEdit}
          regions={check.loops}
          problems={check.problems}
        />
        {drawing && <ToolStrip tool={drawing} placed={progress.placed} arcNext={progress.arcNext} options={toolOptions} onOption={setOption} />}
        {editTool && (
          <div className="sketch-tool-strip edit-strip" data-testid="tool-strip">
            <span className="strip-name">
              <Icon name={editTool.icon} size={14} />
              {editTool.label}
            </span>
            <span className="strip-prompt" title={editTool.prompt(editPicks, toolOptions)} data-testid="tool-prompt">
              {editTool.prompt(editPicks, toolOptions)}
            </span>
            <OptionControls options={editTool.options ?? []} values={toolOptions} onOption={setOption} />
            {editTool.kind === "collect" && (
              <span className="strip-option strip-actions">
                {editTool.name === "mirror" && (
                  <button
                    type="button"
                    aria-pressed={editPicks.picking === false}
                    onClick={() => setEditPicks({ ...editPicks, picking: false })}
                    title="The next line clicked is the line to mirror about"
                    data-testid="tool-mirror-about"
                  >
                    {editPicks.about ? `About ${names.entity(editPicks.about)}` : "Mirror about…"}
                  </button>
                )}
                {typeof pending === "string" && (
                  <span className="strip-problem" title={pending} data-testid="tool-problem">
                    {pending}
                  </span>
                )}
                <button type="button" className="primary" disabled={pending === null && editPicks.picking !== true} onClick={applyCollect} title="Apply (Enter)" data-testid="tool-apply">
                  {editPicks.picking === true ? "Next" : "Apply"}
                </button>
                <button type="button" onClick={restartEdit} title="Drop what is picked (Esc)" data-testid="tool-clear">
                  Clear
                </button>
              </span>
            )}
          </div>
        )}
        {tool === "convert" && (
          <div className="sketch-tool-strip convert-strip" data-testid="convert-strip">
            <span className="strip-name">
              <Icon name="convertEntities" size={14} />
              Convert Entities
            </span>
            <span className="strip-prompt" data-testid="tool-prompt">
              {(() => {
                const n = selection.filter((i) => i.kind === "face" || (i.kind === "entity" && isModelId(i.id))).length;
                return n ? `${n} picked: Convert copies ${n === 1 ? "it" : "them"} in, linked to the model` : "Click model edges, or a face for its outline";
              })()}
            </span>
            <span className="strip-option">
              <button disabled={!convertible(selection)} onClick={() => convert(selection, false)} data-testid="convert-ok" title="Into profile geometry: it extrudes (Enter)">
                Convert
              </button>
              <button disabled={!convertible(selection)} onClick={() => convert(selection, true)} data-testid="convert-construction" title="As construction geometry: for relations and dimensions only">
                As construction
              </button>
            </span>
          </div>
        )}
        {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
        {modify && (
          <ModifyBox
            key={"index" in modify ? `k${modify.index}` : `new${modify.x},${modify.y}`}
            state={modify}
            constraints={draft.constraints}
            onChoose={(choice) => setModify((m) => (m && "options" in m ? { ...m, choice } : m))}
            onClose={() => setModify(null)}
            onApply={(value, expr) => {
              if ("index" in modify) return setDimension(modify.index, expr ?? value);
              const k = modify.options[modify.choice].make(value);
              return addConstraint(expr ? ({ ...k, expr } as unknown as Constraint) : k);
            }}
          />
        )}
        <div className={`sketch-status ${status?.conflicts.size ? "over" : dof === 0 ? "full" : "under"}`} data-testid="sketch-status">
          {status?.conflicts.size ? "Over defined" : dof === 0 ? "Fully defined" : "Under defined"}
        </div>
        {check.problems.length > 0 && (
          <button className="sketch-problems" onClick={() => setShowCheck(true)} title="Check sketch for feature: what is wrong, and fixes" data-testid="sketch-problems">
            <Icon name="alert" size={13} />
            {problemSummary(check)}
          </button>
        )}
        <div className="sketch-plane-label">{planeName(session.plane.normal, session.plane.origin)}</div>
      </section>
      <aside className="side right sketch-panel" data-testid="sketch-panel">
        <section className="panel">
          <h2>
            Sketch <span className="muted">{session.id}</span>
          </h2>
          <div className={`dof ${status?.conflicts.size ? "over" : dof === 0 ? "full" : ""}`} data-testid="sketch-dof" title="Blue geometry can still move; black is fully defined; red is in a relation that doesn't hold">
            {dof === null ? "—" : status?.conflicts.size ? "Over defined: a relation doesn't hold" : dof === 0 ? "Fully defined" : `Under defined: ${dof} degree${dof === 1 ? "" : "s"} of freedom`}
          </div>
          <label className="check weldment-check" title="A section for structural members: finishing opens the profile card, and it goes into the section library">
            <input type="checkbox" checked={weldment} onChange={(e) => setWeldment(e.target.checked)} data-testid="sketch-weldment" />
            Weldment profile
          </label>
          <div className={`profile-status ${profile.ok ? "" : "bad"}`} data-testid="profile-status">
            {draft.entities.filter((e) => !isConstruction(e) && e.type !== "point").length === 0
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
        {showCheck && (
          <section className="panel sketch-check" data-testid="sketch-check">
            <h2>
              Check sketch
              <button className="icon" aria-label="Close" title="Close" onClick={() => setShowCheck(false)}>
                <Icon name="x" size={14} />
              </button>
            </h2>
            {check.problems.length === 0 ? (
              <p className="muted small" data-testid="check-clean">
                {check.loops.length ? `Ready for a feature: ${check.loops.length} closed contour${check.loops.length === 1 ? "" : "s"}, nothing open, crossing or doubled.` : "No profile geometry yet."}
              </p>
            ) : (
              <>
                <ol className="check-list">
                  {check.problems.map((p, i) => (
                    <li key={i} data-testid={`check-problem-${i}`} data-kind={p.kind}>
                      <Icon name="alert" size={14} />
                      <span>{p.text}</span>
                      {p.fix && (
                        <button onClick={() => fix(p)} data-testid={`check-fix-${i}`}>
                          {p.fix}
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
                {check.problems.some((p) => p.fix) && (
                  <div className="row-buttons">
                    <button onClick={() => fix("all")} data-testid="check-fix-all">
                      Fix all that can be fixed
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        )}
        <section className="panel">
          <h2>Add relations</h2>
          {offers.length === 0 ? (
            <p className="muted small">
              Select an entity, two entities, or points (Ctrl-click adds) to relate or dimension them. Smart Dimension{keyHint("sketch.dimension", prefs)} dimensions what you click.
            </p>
          ) : (
            <>
              {relations.length > 0 && (
                <div className="relation-buttons" data-testid="relation-buttons">
                  {relations.map((o) => (
                    <button key={o.testId} className="relation-button" onClick={() => addConstraint(o.make(0))} data-testid={o.testId} title={o.label}>
                      <Icon name={o.icon} size={18} />
                      <span>{o.label}</span>
                    </button>
                  ))}
                </div>
              )}
              {dimensions.length > 0 && (
                <div className="offers">
                  {dimensions.map((o) => (
                    <Offer key={o.testId} offer={o} onAdd={(v, expr) => addConstraint(expr ? ({ ...o.make(v), expr } as unknown as Constraint) : o.make(v))} />
                  ))}
                </div>
              )}
            </>
          )}
          {selection.length > 0 && (
            <p className="muted small" data-testid="sketch-selection">
              {selection.length} selected · Delete removes, Esc clears
            </p>
          )}
          {selection.length > 0 && (
            <ul className="selection-detail" data-testid="sketch-selection-detail">
              {selection.map((i, n) => (
                <li key={n}>{describeItem(i)}</li>
              ))}
            </ul>
          )}
          {entityIds(selection).length > 0 && (
            <div className="row-buttons">
              <button onClick={() => deleteSelection()}>Delete selected</button>
              <button onClick={() => toggleConstruction()}>Toggle construction</button>
            </div>
          )}
        </section>
        <section className="panel constraints-panel">
          <h2>Relations and dimensions</h2>
          {draft.constraints.length === 0 && <p className="muted small">None yet.</p>}
          <ol className="constraint-list" data-testid="constraint-list">
            {draft.constraints.map((k, i) => (
              <li
                key={i}
                data-testid={`constraint-row-${i}`}
                className={picked === i ? "selected" : undefined}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("input, button")) return;
                  setPicked(picked === i ? null : i);
                  setSelection([]);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openMenu({ kind: "constraint", index: i }, e.clientX, e.clientY);
                }}
              >
                <span className="constraint-label" title={constraintSentence(k, RELATION[k.type].label, names)}>
                  <Icon name={RELATION[k.type].icon} size={14} />
                  {describeConstraint(k, names)}
                </span>
                {"value" in k && (
                  <NumberInput
                    value={(k as Dimension).expr ?? k.value}
                    min={0}
                    testId={`constraint-value-${i}`}
                    onCommit={(v) => {
                      // The sketcher solves numbers; an expression is kept beside its value and written back on Finish.
                      setDimension(i, v);
                    }}
                  />
                )}
                {"value" in k && <span className="unit">{k.type === "angle" ? "°" : "mm"}</span>}
                <button className="icon" aria-label="Remove" title="Remove" onClick={() => removeConstraint(i)}>
                  <Icon name="x" size={14} />
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

/** A suggested dimension: a number, or an expression ("=b - 2 * t") that a parameter keeps driving. */
function Offer({ offer, onAdd }: { offer: Suggestion; onAdd(v: number, expr?: string): void }) {
  const params = useContext(ParametersContext);
  const [text, setText] = useState(String(offer.value ?? 0));
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setText(String(offer.value ?? 0)), [offer.value]);
  const add = () => {
    const t = text.trim();
    if (t.startsWith("=")) {
      const r = evaluate(t, params);
      if (!r.ok) return setProblem(r.error);
      setProblem(null);
      return onAdd(r.value, t);
    }
    const v = Number(t);
    if (t === "" || !Number.isFinite(v)) return setProblem("a number, or =expression");
    setProblem(null);
    onAdd(v);
  };
  if (offer.value === undefined) {
    return (
      <button className="offer" onClick={() => onAdd(0)} data-testid={offer.testId}>
        {offer.label}
      </button>
    );
  }
  return (
    <div className="offer valued">
      <span>
        <Icon name={offer.icon} size={14} />
        {offer.label}
        {offer.unit === "°" ? " (°)" : ""}
      </span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        className={text.trim().startsWith("=") ? "expr" : undefined}
        aria-invalid={problem ? true : undefined}
        title={problem ?? "A number, or =expression over the parameters"}
        data-testid={`${offer.testId}-value`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") add();
        }}
      />
      <button onClick={add} data-testid={offer.testId}>
        Add
      </button>
      {problem && <span className="expr-error">{problem}</span>}
    </div>
  );
}

/**
 * SOLIDWORKS's Modify box: the dimension's value where it was placed, a
 * number or "=expression"; Enter (or the tick) applies, Escape cancels. Two
 * points can be dimensioned aligned, level or plumb.
 */
function ModifyBox({
  state,
  constraints,
  onChoose,
  onApply,
  onClose,
}: {
  state: { x: number; y: number; options: Suggestion[]; choice: number } | { x: number; y: number; index: number };
  constraints: Constraint[];
  onChoose(choice: number): void;
  onApply(value: number, expr?: string): boolean;
  onClose(): void;
}) {
  const params = useContext(ParametersContext);
  const existing = "index" in state ? (constraints[state.index] as Dimension | undefined) : undefined;
  const option = "options" in state ? state.options[state.choice] : undefined;
  const start = existing && "value" in existing ? String(existing.expr ?? existing.value) : String(option?.value ?? 0);
  const [text, setText] = useState(start);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  /** Aligned, level or plumb: the value follows at once, and the field keeps the keyboard. */
  const choose = (i: number) => {
    if (!("options" in state)) return;
    onChoose(i);
    setText(String(state.options[i].value ?? 0));
    setProblem(null);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
  };
  const apply = () => {
    const t = text.trim();
    if (t.startsWith("=")) {
      const r = evaluate(t, params);
      if (!r.ok) return setProblem(r.error);
      if (onApply(r.value, t)) onClose();
      return;
    }
    const v = Number(t);
    if (t === "" || !Number.isFinite(v)) return setProblem("a number, or =expression");
    if (onApply(v)) onClose();
  };
  const label = existing ? RELATION[existing.type].label : option?.label;
  return (
    <Popup x={state.x + 12} y={state.y + 12} onClose={onClose} label="Modify" testId="modify-box">
      {() => (
        <div className="modify-box" onContextMenu={(e) => e.preventDefault()}>
          <div className="modify-title">
            <Icon name={existing ? RELATION[existing.type].icon : (option?.icon ?? "smartDimension")} size={14} />
            {label}
          </div>
          {"options" in state && state.options.length > 1 && (
            <div className="modify-options" role="radiogroup" aria-label="Measure">
              {state.options.map((o, i) => (
                <button key={o.testId} type="button" role="radio" aria-checked={i === state.choice} onClick={() => choose(i)} data-testid={`modify-${o.testId}`}>
                  {o.label.replace(/ distance$/, "")}
                </button>
              ))}
            </div>
          )}
          <div className="modify-row">
            <input
              ref={input}
              type="text"
              inputMode="decimal"
              value={text}
              className={text.trim().startsWith("=") ? "expr" : undefined}
              aria-invalid={problem ? true : undefined}
              aria-label="Value"
              data-testid="modify-value"
              onChange={(e) => {
                setText(e.target.value);
                setProblem(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  apply();
                }
              }}
            />
            <span className="unit">{(existing?.type ?? option?.make(0).type) === "angle" ? "°" : "mm"}</span>
            <button type="button" className="icon" onClick={apply} aria-label="Apply" title="Apply (Enter)" data-testid="modify-ok">
              <Icon name="check" size={14} />
            </button>
            <button type="button" className="icon" onClick={onClose} aria-label="Cancel" title="Cancel (Esc)">
              <Icon name="x" size={14} />
            </button>
          </div>
          {problem && <div className="expr-error">{problem}</div>}
        </div>
      )}
    </Popup>
  );
}

/** Longer names for the tooltips. */
const TOOL_TITLE: Partial<Record<Tool, string>> = {
  dimension: "Smart Dimension: click a line, circle or arc, or two points, lines or circles (the model's edges and the sketch's axes too), then where the dimension goes",
  convert: "Convert Entities: copy model edges (or a face's outline) into the sketch, linked so they follow the model",
};

/** What each entity type is called in a menu title. */
const RELATION_NOUN: Record<SketchEntity["type"], string> = { line: "Line", circle: "Circle", arc: "Arc", rect: "Rectangle", slot: "Slot", point: "Point" };

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Identity of a constraint, ignoring its value; pairs in either order. */
function constraintKey(k: Constraint): string {
  const { value: _ignored, expr: _expr, ...rest } = k as Dimension & { value?: number };
  if (k.type === "coincident" || (k.type === "horizontal" || k.type === "vertical") && k.points) return `${k.type}:${[...k.points!].sort().join("|")}`;
  if ("entities" in k && k.entities && k.type !== "angle" && k.type !== "offset") return `${k.type}:${[...k.entities].sort().join("|")}${k.type === "symmetric" ? `@${k.line}` : ""}`;
  return JSON.stringify(rest);
}

/** A constraint as the solver and the document see it: its number, without the expression beside it. */
function numeric(c: Dimension): Constraint {
  const { expr: _expr, ...rest } = c;
  return rest as Constraint;
}
