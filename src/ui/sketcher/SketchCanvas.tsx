// The 2D sketch editor: an SVG in sketch-plane millimetres, y up.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isConstruction } from "../../doc/sketch";
import type { Constraint, SketchEntity, Vec2 } from "../../doc/types";
import { entityPolylines } from "../../geom/profile";
import { dist2 } from "../../geom/vec";
import { Icon, type IconName } from "../icons";
import { inputPrefs, keyFor, keyOf, useCommands, wheelZoom } from "../input";
import { dimensionShapes, RELATION, relationGlyphs } from "./annotate";
import { constraintTargets } from "../../geom/axes";
import { distanceTo, handlesOf, hitEntity, hitHandle, type SketchItem } from "./draft";
import { faceAt, isModelId, modelEntities, type ModelFace, type ModelView } from "./model";
import { shapeWords } from "./names";
import { tangentStart } from "./tools/arcs";
import { place, previewOf, snapClick, toolByName, type Placement } from "./tools/run";
import type { Click, SketchToolDef, ToolContext, ToolOptions } from "./tools/types";

/** "select", "dimension", "convert" (picking model edges and faces to convert), or a drawing tool's name in the registry (src/ui/sketcher/tools). */
export type Tool = string;

/**
 * What a right-click lands on: an entity, one of its points, a relation's
 * glyph or a dimension, or empty space (null). An entity may be a model
 * edge's stand-in ("@e12") or a sketch axis ("X"); a point a model vertex
 * ("@e12.start").
 */
export type CanvasTarget = { kind: "entity"; id: string } | { kind: "point"; ref: string } | { kind: "constraint"; index: number };

/** How defined the sketch is, as SOLIDWORKS colours it. */
export interface DefinedState {
  /** Entities that can still move: drawn blue. The rest are fully defined: black. */
  free: Set<string>;
  freePoints: Set<string>;
  /** Entities in a relation that doesn't hold: drawn red. */
  conflicts: Set<string>;
}

/** A point being placed, and what it inferred: what it lands on, and for a line's end, level or plumb. */
type Snap = Click;

/** How far along the active drawing tool is: clicks placed, and whether a line chain's next piece is a tangent arc. */
export interface DrawProgress {
  placed: number;
  arcNext: boolean;
}

/** The tool a line chain's A turns its next piece into. */
const TANGENT_ARC = toolByName("tangent-arc")!;

interface Props {
  entities: SketchEntity[];
  constraints: Constraint[];
  /** The model's edges (and the faces along the sketch) projected into the sketch plane: drawn, hit, snapped to, related to. */
  model: ModelView;
  tool: Tool;
  /** The drawing tool's options (a polygon's sides). */
  options?: ToolOptions;
  construction: boolean;
  snapToGrid: boolean;
  selection: SketchItem[];
  onSelect(items: SketchItem[]): void;
  /** A drawn shape: its entities, the relations that hold its shape, and those its clicks inferred (coincident with what they snapped to, level, on a line). */
  onCreate(made: Placement): void;
  /** Why a click was not taken (a tangent arc must start at an end). */
  onMessage?(text: string): void;
  /** How far the drawing tool has got, for its prompt. */
  onProgress?(progress: DrawProgress): void;
  onDrag(phase: "move" | "end", handle: string, from: Vec2, to: Vec2): void;
  /** A right-click in place (not a right-drag pan): what is under the cursor, if anything. */
  onContext?(target: CanvasTarget | null, clientX: number, clientY: number): void;
  /** Blue, black and red, by how defined each entity is. */
  defined?: DefinedState;
  /** Relation glyphs shown beside the geometry. */
  showRelations?: boolean;
  /** The relation or dimension selected (its glyph, its dimension or its row). */
  selectedConstraint?: number | null;
  onSelectConstraint?(index: number | null): void;
  /** A dimension double-clicked: edit its value where it is. */
  onEditDimension?(index: number, clientX: number, clientY: number): void;
  /** Smart Dimension: the picks are made (two, or one and a click in space); `at` is where it was placed. */
  onDimension?(picks: SketchItem[], at: Vec2, clientX: number, clientY: number): void;
}

interface ViewState {
  cx: number;
  cy: number;
  /** Pixels per millimetre. */
  scale: number;
}

const SNAP_PX = 10;
const PICK_PX = 7;

export function SketchCanvas(props: Props) {
  const { entities, constraints, model, tool, construction, snapToGrid, selection } = props;
  /** The model edges as stand-in entities ("@e12"): hit, snapped to and related to like the sketch's own. */
  const modelEnts = useMemo(() => modelEntities(model), [model]);
  const svg = useRef<SVGSVGElement>(null);
  const world = useRef<SVGGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState<ViewState | null>(null);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const [clicks, setClicks] = useState<Snap[]>([]);
  /** A line chain's next piece is a tangent arc (A toggles it, as in SOLIDWORKS). */
  const [arcNext, setArcNext] = useState(false);
  /** Where the pointer went since the last click: an arc bends the way it was drawn. */
  const trail = useRef<Vec2[]>([]);
  /** Smart Dimension's picks so far. */
  const [picks, setPicks] = useState<SketchItem[]>([]);
  /** A selection box being dragged: left to right selects what is inside it, right to left what it touches. */
  const [box, setBox] = useState<{ a: Vec2; b: Vec2 } | null>(null);
  const lastMiddle = useRef(0);
  /** Where the chain being drawn started, so clicking there again closes the loop. */
  const chainStart = useRef<Vec2 | null>(null);
  const gesture = useRef<
    | { kind: "pan"; startClient: Vec2; startView: ViewState }
    | { kind: "zoom"; startClient: Vec2; startView: ViewState }
    | { kind: "box"; start: Vec2; additive: boolean }
    | { kind: "drag"; handle: string; from: Vec2; moved: boolean; item: SketchItem; additive: boolean }
    | { kind: "click"; at: Vec2; item: SketchItem | null; additive: boolean; startClient: Vec2; startView: ViewState }
    | null
  >(null);

  // Track the element size; fit the view once we know it.
  useLayoutEffect(() => {
    const el = svg.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 800, h: el.clientHeight || 600 }));
    ro.observe(el);
    setSize({ w: el.clientWidth || 800, h: el.clientHeight || 600 });
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (view) return;
    setView(fitView(entities, model, size));
    // fit once, on first layout
  }, [size]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving a tool or switching tools drops a half-placed entity, or half-picked dimension.
  useEffect(() => {
    setClicks([]);
    setPicks([]);
    setArcNext(false);
    trail.current = [];
  }, [tool]);
  useEffect(() => props.onProgress?.({ placed: clicks.length, arcNext }), [clicks.length, arcNext]); // eslint-disable-line react-hooks/exhaustive-deps

  const v = view ?? fitView(entities, model, size);
  const unit = 1 / v.scale; // world size of one pixel
  const viewBox = `${v.cx - size.w / 2 / v.scale} ${-v.cy - size.h / 2 / v.scale} ${size.w / v.scale} ${size.h / v.scale}`;
  const step = gridStep(v.scale);
  /** Half the view's larger side and a margin, in mm: how far the sketch axes are drawn each way from the view's centre. */
  const reach = Math.max(size.w, size.h) / v.scale;

  const toWorld = (clientX: number, clientY: number): Vec2 => {
    const g = world.current!;
    const pt = svg.current!.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const w = pt.matrixTransform(g.getScreenCTM()!.inverse());
    return [w.x, w.y];
  };

  /** The drawing tool, if one is active: a line chain's next piece may be a tangent arc. */
  const active: SketchToolDef | undefined = toolByName(tool);
  const def: SketchToolDef | undefined = active && arcNext ? TANGENT_ARC : active;
  const options = props.options ?? {};
  const toolContext = (): ToolContext => ({ entities, trail: trail.current, px: unit });

  /**
   * Where a placed point lands, as SOLIDWORKS infers it: on an end, centre,
   * midpoint, sketch point or the origin, on a line, circle or arc; the tool's
   * own inference; level with or plumb above the click before; else the grid.
   */
  const snap = (p: Vec2): Snap =>
    def ? snapClick(def, clicks.map((c) => c.p), p, { entities, tol: SNAP_PX * unit, grid: snapToGrid ? step : null, options, model: modelEnts }) : { p, ref: null };

  /**
   * What is under p: the sketch's points and entities first, then the model's
   * vertices and edges, then the sketch axes. Converting, only the model:
   * its edges, else the face under the pointer.
   */
  const itemAt = (p: Vec2): SketchItem | null => {
    const tol = PICK_PX * unit;
    if (tool !== "convert") {
      const h = hitHandle(entities, p, tol);
      if (h) return h.constraint ? { kind: "point", ref: h.ref } : { kind: "entity", id: h.ref.split(".")[0] };
      const e = hitEntity(entities, p, tol);
      if (e) return { kind: "entity", id: e.id };
      const mh = hitHandle(modelEnts, p, tol, { constraintOnly: true });
      if (mh && mh.ref !== "origin") return { kind: "point", ref: mh.ref };
    }
    // In-plane edges first (they come first in modelEnts): an edge behind one projects onto the same line.
    const me = firstHit(modelEnts, p, tol);
    if (me) return { kind: "entity", id: me.id };
    if (tool === "convert") {
      const f = faceAt(model, p);
      return f ? { kind: "face", index: f.index } : null;
    }
    if (Math.abs(p[1]) <= tol) return { kind: "entity", id: "X" };
    if (Math.abs(p[0]) <= tol) return { kind: "entity", id: "Y" };
    return null;
  };
  /** The click on `hit`, a sketch axis, places the dimension of `first` rather than picking the axis: `first` is a line across it. */
  const placesOn = (hit: SketchItem, first: SketchItem): boolean => {
    if (hit.kind !== "entity" || (hit.id !== "X" && hit.id !== "Y") || first.kind !== "entity") return false;
    if (first.id === "X" || first.id === "Y") return true;
    const line = [...entities, ...modelEnts].find((e) => e.id === first.id);
    if (line?.type !== "line") return false;
    const d = [line.end[0] - line.start[0], line.end[1] - line.start[1]];
    const along = hit.id === "X" ? Math.abs(d[1]) : Math.abs(d[0]);
    return along > 1e-9 * Math.hypot(d[0], d[1]);
  };
  /** A reference follows the model: picked, never dragged. */
  const fixedId = (id: string) => !!entities.find((e) => e.id === id)?.ref;

  /** The tool's last click is in: build the shape, with what its clicks inferred, and hand it over. */
  const finishPlacement = (pts: Snap[]): Placement | null => {
    if (!def) return null;
    const made = place(def, pts, options, toolContext(), construction);
    if (made) props.onCreate(made);
    return made;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = toWorld(e.clientX, e.clientY);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    // The middle button pans (Shift: zooms); twice quickly fits the sketch. The right button pans too.
    if (e.button === 1) {
      e.preventDefault();
      const now = performance.now();
      if (now - lastMiddle.current < 350) {
        lastMiddle.current = 0;
        setView(fitView(entities, model, size));
        return;
      }
      lastMiddle.current = now;
    }
    if (e.button === 1 && e.shiftKey) {
      gesture.current = { kind: "zoom", startClient: [e.clientX, e.clientY], startView: v };
      return;
    }
    if (e.button === 1 || e.button === 2) {
      gesture.current = { kind: "pan", startClient: [e.clientX, e.clientY], startView: v };
      return;
    }
    if (tool !== "select") return;
    const handle = hitHandle(entities, p, PICK_PX * unit);
    if (handle && handle.ref !== "origin" && !fixedId(handle.ref.split(".")[0])) {
      const item: SketchItem = handle.constraint ? { kind: "point", ref: handle.ref } : { kind: "entity", id: handle.ref.split(".")[0] };
      gesture.current = { kind: "drag", handle: handle.ref, from: handle.point, moved: false, item, additive };
      return;
    }
    const ent = hitEntity(entities, p, PICK_PX * unit);
    if (ent && !ent.ref && !(handle && handle.ref !== "origin")) {
      gesture.current = { kind: "drag", handle: `${ent.id}.body`, from: p, moved: false, item: { kind: "entity", id: ent.id }, additive };
      return;
    }
    gesture.current = { kind: "click", at: p, item: itemAt(p), additive, startClient: [e.clientX, e.clientY], startView: v };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toWorld(e.clientX, e.clientY);
    if (def && clicks.length) {
      trail.current.push(p);
      // A long sweep keeps its shape at half the samples.
      if (trail.current.length > 600) trail.current = trail.current.filter((_, i) => i % 2 === 0);
    }
    setCursor(p);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "box") {
      setBox({ a: g.start, b: p });
      return;
    }
    if (g.kind === "zoom") {
      const scale = Math.min(1e4, Math.max(1e-3, g.startView.scale * Math.exp(-(e.clientY - g.startClient[1]) * 0.01)));
      setView({ ...g.startView, scale });
      return;
    }
    if (g.kind === "pan" || g.kind === "click") {
      const dx = e.clientX - g.startClient[0];
      const dy = e.clientY - g.startClient[1];
      if (g.kind === "click" && Math.hypot(dx, dy) < 4) return;
      // Dragging empty space: SOLIDWORKS draws a selection box; the trackpad scheme pans.
      if (g.kind === "click" && inputPrefs().mouse === "solidworks") {
        gesture.current = { kind: "box", start: g.at, additive: g.additive };
        setBox({ a: g.at, b: p });
        return;
      }
      gesture.current = { kind: "pan", startClient: g.startClient, startView: g.startView };
      setView({ ...g.startView, cx: g.startView.cx - dx / g.startView.scale, cy: g.startView.cy + dy / g.startView.scale });
    } else if (g.kind === "drag") {
      if (!g.moved && dist2(p, g.from) < 3 * unit) return;
      g.moved = true;
      props.onDrag("move", g.handle, g.from, p);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    const p = toWorld(e.clientX, e.clientY);
    if (g?.kind === "drag") {
      if (g.moved) props.onDrag("end", g.handle, g.from, p);
      else select(g.item, g.additive);
      return;
    }
    if (g?.kind === "click") {
      select(g.item, g.additive);
      return;
    }
    if (g?.kind === "box") {
      setBox(null);
      const picked = boxPick(entities, g.start, p);
      props.onSelect(g.additive ? [...selection, ...picked.filter((x) => !selection.some((s) => sameItem(s, x)))] : picked);
      return;
    }
    if (g?.kind === "zoom") return;
    if (g?.kind === "pan" && e.button === 2 && Math.hypot(e.clientX - g.startClient[0], e.clientY - g.startClient[1]) < 4) {
      const item = itemAt(p);
      props.onContext?.(item?.kind === "entity" ? item : item?.kind === "point" ? { kind: "point", ref: item.ref } : null, e.clientX, e.clientY);
      return;
    }
    if (g?.kind === "pan" || e.button !== 0 || tool === "select") return;
    if (tool === "convert") {
      // Converting: each click picks or drops a model edge, or a face for its outline.
      return select(itemAt(p), true);
    }
    if (tool === "dimension") {
      // Smart Dimension: pick one or two things; a second pick, or a click in space after one, places it.
      const hit = itemAt(p);
      // A click on a sketch axis after a line across it places that line's dimension (the axes run through
      // where dimensions go); after a point, a circle or a line along the axis, it dimensions to the axis.
      const item = hit && picks.length === 1 && placesOn(hit, picks[0]) ? null : hit;
      if (item && !picks.some((x) => sameItem(x, item))) {
        const next = [...picks, item];
        if (next.length < 2) return setPicks(next);
        setPicks([]);
        return props.onDimension?.(next, p, e.clientX, e.clientY);
      }
      if (!item && picks.length === 1) {
        setPicks([]);
        props.onDimension?.(picks, p, e.clientX, e.clientY);
      }
      return;
    }
    if (!def) return;
    // Drawing: one click per point.
    const s = snap(p);
    const refused = def.accept?.(s, clicks.length, toolContext());
    if (refused) return props.onMessage?.(refused);
    trail.current = [];
    const next = [...clicks, s];
    // A chain's first click: where clicking again closes it.
    if (def.chain && clicks.length === 0) chainStart.current = s.p;
    if (next.length < def.clicks) {
      setClicks(next);
      return;
    }
    const made = finishPlacement(next);
    if (def.chain && made?.next) {
      // Clicking the point the chain started from (it snaps there) closes it; otherwise keep drawing from the end.
      const start = chainStart.current;
      const closes = !!start && (s.ref !== null || s.on !== undefined) && dist2(s.p, start) < 1e-9;
      setClicks(closes ? [] : [made.next]);
      setArcNext(false);
      if (closes) chainStart.current = null;
      return;
    }
    setClicks([]);
    setArcNext(false);
  };

  const select = (item: SketchItem | null, additive: boolean) => {
    if (!item) return props.onSelect(additive ? selection : []);
    const has = selection.some((s) => sameItem(s, item));
    if (additive) props.onSelect(has ? selection.filter((s) => !sameItem(s, item)) : [...selection, item]);
    else props.onSelect([item]);
  };

  const onWheel = (e: React.WheelEvent) => {
    const p = toWorld(e.clientX, e.clientY);
    const k = wheelZoom(e);
    const scale = Math.min(1e4, Math.max(1e-3, v.scale * k));
    setView({ scale, cx: p[0] - (p[0] - v.cx) * (v.scale / scale), cy: p[1] - (p[1] - v.cy) * (v.scale / scale) });
  };

  // The view keys, in two dimensions: fit, zoom and pan.
  const zoomBy = (k: number) => setView({ ...v, scale: Math.min(1e4, Math.max(1e-3, v.scale * k)) });
  const panBy = (dx: number, dy: number) => setView({ ...v, cx: v.cx - dx / v.scale, cy: v.cy + dy / v.scale });
  useCommands({
    "view.fit": () => setView(fitView(entities, model, size)),
    "view.zoomIn": () => zoomBy(1.25),
    "view.zoomOut": () => zoomBy(0.8),
    "view.panLeft": () => panBy(-60, 0),
    "view.panRight": () => panBy(60, 0),
    "view.panUp": () => panBy(0, -60),
    "view.panDown": () => panBy(0, 60),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Typing in a field (the polygon's sides), Esc and A are the field's.
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.key === "Escape" && !typing && (clicks.length || picks.length)) {
        setClicks([]);
        setPicks([]);
        setArcNext(false);
        e.stopPropagation();
        return;
      }
      // Drawing lines, the Arc key turns the next piece into a tangent arc from the end, and back (SOLIDWORKS's A).
      if (!typing && !e.repeat && active?.chain && active !== TANGENT_ARC && clicks.length === 1 && keyOf(e) === keyFor("sketch.arc") && tangentStart(clicks[0], entities)) {
        setArcNext((a) => !a);
        trail.current = [];
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const preview = useMemo(() => {
    if (!def || !cursor || clicks.length === 0) return [];
    return previewOf(def, [...clicks, snap(cursor)], options, toolContext(), construction);
  }, [def, cursor, clicks, construction, options, entities]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = tool === "dimension" ? picks : selection;
  const selectedIds = new Set(chosen.flatMap((s) => (s.kind === "entity" ? [s.id] : [])));
  const selectedPoints = new Set(chosen.flatMap((s) => (s.kind === "point" ? [s.ref] : [])));
  const hoverItem = cursor && (tool === "select" || tool === "dimension" || tool === "convert") && !gesture.current ? itemAt(cursor) : null;
  const selectedFaces = new Set(chosen.flatMap((s) => (s.kind === "face" ? [s.index] : [])));
  const isHover = (id: string) => hoverItem?.kind === "entity" && hoverItem.id === id;
  const snapMark = cursor && def ? snap(cursor) : null;
  const inferIcon: IconName | null = !snapMark ? null : snapMark.ref ? "coincident" : snapMark.on ? RELATION[snapMark.on.type].icon : snapMark.orient ?? null;
  // A selected relation outlines what it holds.
  const selectedK = props.selectedConstraint !== null && props.selectedConstraint !== undefined ? constraints[props.selectedConstraint] : undefined;
  const related = new Set(selectedK ? constraintTargets(selectedK) : []);
  const state = (id: string) => (props.defined?.conflicts.has(id) ? "conflict" : !props.defined ? "" : props.defined.free.has(id) ? "free" : "defined");
  const pointState = (ref: string) => (!props.defined ? "" : props.defined.freePoints.has(ref) ? "free" : "defined");

  return (
    <svg
      ref={svg}
      className={`sketch-canvas tool-${tool}`}
      data-defined={props.defined ? (props.defined.conflicts.size ? "over" : props.defined.free.size ? "under" : "full") : undefined}
      data-testid="sketch-canvas"
      viewBox={viewBox}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setCursor(null)}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
      onDoubleClick={() => {
        if (def?.chain) {
          setClicks([]);
          setArcNext(false);
        }
      }}
    >
      <g ref={world} transform="scale(1,-1)">
        <Grid view={v} size={size} step={step} />
        {box && (
          <rect
            x={Math.min(box.a[0], box.b[0])}
            y={Math.min(box.a[1], box.b[1])}
            width={Math.abs(box.b[0] - box.a[0])}
            height={Math.abs(box.b[1] - box.a[1])}
            className={box.b[0] >= box.a[0] ? "select-box window" : "select-box crossing"}
            vectorEffect="non-scaling-stroke"
            data-testid="select-box"
          />
        )}
        {/* The sketch's axes: lines any relation or dimension may use ("X", "Y"). */}
        {/* Drawn across the view only: a line a million mm long would have too many dashes, and draws solid. */}
        {(["X", "Y"] as const).map((a) => (
          <line
            key={a}
            x1={a === "X" ? v.cx - reach : 0}
            y1={a === "X" ? 0 : v.cy - reach}
            x2={a === "X" ? v.cx + reach : 0}
            y2={a === "X" ? 0 : v.cy + reach}
            className={`sketch-axis axis-${a.toLowerCase()}${isHover(a) ? " hover" : ""}${selectedIds.has(a) ? " selected" : ""}${related.has(a) ? " related" : ""}`}
            vectorEffect="non-scaling-stroke"
            data-axis={a}
          />
        ))}
        {model.faces.map((f) =>
          selectedFaces.has(f.index) || (hoverItem?.kind === "face" && hoverItem.index === f.index) ? (
            <FaceTint key={`face:${f.index}`} face={f} className={`model-face${selectedFaces.has(f.index) ? " selected" : " hover"}`} />
          ) : null,
        )}
        <g className="model" data-testid="model-edges">
          {model.edges.map((m) => (
            <path
              key={m.id}
              d={m.poly.map((q, i) => `${i ? "L" : "M"}${q[0]} ${q[1]}`).join("")}
              className={[
                "model-edge",
                m.entity ? "" : "other",
                m.inPlane ? "in-plane" : "",
                isHover(m.id) ? "hover" : "",
                selectedIds.has(m.id) ? "selected" : "",
                related.has(m.id) ? "related" : "",
              ].join(" ")}
              vectorEffect="non-scaling-stroke"
              data-model-edge={m.index}
            >
              <title>{m.entity ? `Model edge: ${shapeWords(m.entity)}. Dimension or relate to it, or Convert it` : `Model edge: ${m.problem ?? "can't be referenced"}`}</title>
            </path>
          ))}
        </g>
        {entities.map((e) => {
          const className = [
            "entity",
            state(e.id),
            isConstruction(e) ? "construction" : "",
            e.ref ? "reference" : "",
            related.has(e.id) ? "related" : "",
            selectedIds.has(e.id) || (e.type === "point" && selectedPoints.has(`${e.id}.at`)) ? "selected" : "",
            (hoverItem?.kind === "entity" && hoverItem.id === e.id) || (e.type === "point" && hoverItem?.kind === "point" && hoverItem.ref === `${e.id}.at`) ? "hover" : "",
          ].join(" ");
          return e.type === "point" ? <PointDot key={e.id} at={e.at} r={3.5 * unit} id={e.id} className={className} /> : <EntityShape key={e.id} e={e} className={className} />;
        })}
        {preview.map((e, i) =>
          e.type === "point" ? (
            <PointDot key={`preview:${i}`} at={e.at} r={3.5 * unit} className="entity preview" />
          ) : (
            <EntityShape key={`preview:${i}`} e={e} className={`entity preview${e.construction ? " construction" : ""}`} />
          ),
        )}
        {[...entities, ...modelHandles(modelEnts, hoverItem, chosen)].flatMap((e) =>
          // A sketch point is its own handle: its dot. A model edge shows its points only when the pointer is on it, or one is picked.
          (e.type === "point" ? [] : handlesOf(e)).map((h) => (
            <circle
              key={h.ref}
              cx={h.point[0]}
              cy={h.point[1]}
              r={(h.constraint ? 3.5 : 2.5) * unit}
              className={[
                "handle",
                isModelId(h.ref) || e.ref ? "reference" : h.constraint ? pointState(h.ref) : "corner",
                selectedPoints.has(h.ref) ? "selected" : "",
                hoverItem?.kind === "point" && hoverItem.ref === h.ref ? "hover" : "",
              ].join(" ")}
            />
          )),
        )}
        <circle cx={0} cy={0} r={4 * unit} className={`origin ${selectedPoints.has("origin") ? "selected" : ""}`} />
        {clicks.map((c, i) => (
          <circle key={i} cx={c.p[0]} cy={c.p[1]} r={3 * unit} className="placed" />
        ))}
        {(snapMark?.ref || snapMark?.on) && <circle cx={snapMark.p[0]} cy={snapMark.p[1]} r={7 * unit} className="snap" />}
      </g>
      <Annotations
        entities={entities}
        constraints={constraints}
        unit={unit}
        showRelations={props.showRelations ?? true}
        selected={props.selectedConstraint ?? null}
        onSelect={(i) => props.onSelectConstraint?.(i)}
        onEdit={(i, x, y) => props.onEditDimension?.(i, x, y)}
        onContext={(i, x, y) => props.onContext?.({ kind: "constraint", index: i }, x, y)}
      />
      {cursor && inferIcon && (
        <g className="infer" data-testid={`infer-${inferIcon}`} pointerEvents="none">
          <rect x={cursor[0] + 10 * unit} y={-cursor[1] + 8 * unit} width={18 * unit} height={18 * unit} rx={3 * unit} />
          <Icon name={inferIcon} size={14 * unit} x={cursor[0] + 12 * unit} y={-cursor[1] + 10 * unit} />
        </g>
      )}
    </svg>
  );
}

/** An entity's outline. A preview's carries no data-entity: the rubber band is not the sketch. */
function EntityShape({ e, className }: { e: SketchEntity; className: string }) {
  const d = entityPolylines(e, Math.PI / 64)
    .map((pts) => pts.map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join(""))
    .join("");
  const preview = className.includes("preview");
  return <path d={d} className={className} vectorEffect="non-scaling-stroke" data-entity={preview ? undefined : e.id} />;
}

/** A sketch point: a dot, the same size at any zoom. */
function PointDot({ at, r, id, className }: { at: Vec2; r: number; id?: string; className: string }) {
  return <circle cx={at[0]} cy={at[1]} r={r} className={`${className} point`} vectorEffect="non-scaling-stroke" data-entity={id} />;
}

/** The first entity (in list order) within tol of p, nearest among those as near as it. */
function firstHit(list: SketchEntity[], p: Vec2, tol: number): SketchEntity | null {
  let best: SketchEntity | null = null;
  let bestD = tol;
  for (const e of list) {
    const d = distanceTo(e, p);
    if (d < bestD - 1e-9 || (!best && d <= bestD)) {
      best = e;
      bestD = d;
    }
  }
  return best;
}

/** A model face tinted: hovered or picked for Convert Entities. */
function FaceTint({ face, className }: { face: ModelFace; className: string }) {
  const d = face.triangles.map(([a, b, c]) => `M${a[0]} ${a[1]}L${b[0]} ${b[1]}L${c[0]} ${c[1]}Z`).join("");
  return <path d={d} className={className} data-model-face={face.index} />;
}

/** The model edges whose points are shown: the one under the pointer, and those picked or with a point picked. */
function modelHandles(model: SketchEntity[], hover: SketchItem | null, chosen: SketchItem[]): SketchEntity[] {
  const owner = (i: SketchItem | null) => (i?.kind === "entity" ? i.id : i?.kind === "point" ? i.ref.split(".")[0] : null);
  const ids = new Set([owner(hover), ...chosen.map(owner)].filter((x): x is string => !!x && isModelId(x)));
  return model.filter((e) => ids.has(e.id));
}

function Grid({ view, size, step }: { view: ViewState; size: { w: number; h: number }; step: number }) {
  const w = size.w / view.scale;
  const h = size.h / view.scale;
  const x0 = Math.floor((view.cx - w / 2) / step) * step;
  const y0 = Math.floor((view.cy - h / 2) / step) * step;
  const minor: string[] = [];
  const major: string[] = [];
  for (let x = x0; x <= view.cx + w / 2; x += step) {
    (Math.round(x / step) % 5 === 0 ? major : minor).push(`M${x} ${view.cy - h}L${x} ${view.cy + h}`);
  }
  for (let y = y0; y <= view.cy + h / 2; y += step) {
    (Math.round(y / step) % 5 === 0 ? major : minor).push(`M${view.cx - w} ${y}L${view.cx + w} ${y}`);
  }
  return (
    <>
      <path d={minor.join("")} className="grid-minor" vectorEffect="non-scaling-stroke" />
      <path d={major.join("")} className="grid-major" vectorEffect="non-scaling-stroke" />
    </>
  );
}

/**
 * Dimensions and relation glyphs over the sketch. Drawn outside the flipped
 * world group (y negated by hand) so text reads the right way up. A click
 * selects one, a double-click edits a dimension's value, a right-click opens
 * its menu.
 */
function Annotations({
  entities,
  constraints,
  unit,
  showRelations,
  selected,
  onSelect,
  onEdit,
  onContext,
}: {
  entities: SketchEntity[];
  constraints: Constraint[];
  unit: number;
  showRelations: boolean;
  selected: number | null;
  onSelect(i: number): void;
  onEdit(i: number, clientX: number, clientY: number): void;
  onContext(i: number, clientX: number, clientY: number): void;
}) {
  const dims = useMemo(() => dimensionShapes(entities, constraints, unit), [entities, constraints, unit]);
  const glyphs = useMemo(() => (showRelations ? relationGlyphs(entities, constraints, unit) : []), [entities, constraints, unit, showRelations]);
  const f = (p: Vec2) => `${p[0]} ${-p[1]}`;
  const arrow = (tip: Vec2, dir: Vec2) => {
    const l = 9 * unit;
    const w = 3 * unit;
    const n: Vec2 = [-dir[1], dir[0]];
    const b: Vec2 = [tip[0] - dir[0] * l, tip[1] - dir[1] * l];
    return `M${f(tip)}L${f([b[0] + n[0] * w, b[1] + n[1] * w])}L${f([b[0] - n[0] * w, b[1] - n[1] * w])}Z`;
  };
  // Clicks here are the annotation's, not the canvas's: no drag, pan or box starts under them.
  const handlers = (i: number, dimension: boolean) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button === 1) return;
      e.stopPropagation();
      if (e.button === 0) onSelect(i);
    },
    onDoubleClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      if (dimension) onEdit(i, e.clientX, e.clientY);
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onSelect(i);
      onContext(i, e.clientX, e.clientY);
    },
  });
  return (
    <>
      <g className="dimensions">
        {dims.map((d, n) => {
          const sweep = d.arc?.sweep ?? 0;
          const a1 = (d.arc?.from ?? 0) + sweep;
          const arcPath = d.arc
            ? `M${f([d.arc.center[0] + d.arc.r * Math.cos(d.arc.from), d.arc.center[1] + d.arc.r * Math.sin(d.arc.from)])}A${d.arc.r} ${d.arc.r} 0 ${Math.abs(sweep) > Math.PI ? 1 : 0} ${sweep > 0 ? 0 : 1} ${f([d.arc.center[0] + d.arc.r * Math.cos(a1), d.arc.center[1] + d.arc.r * Math.sin(a1)])}`
            : "";
          return (
            <g key={n} className={`dim${selected === d.index ? " selected" : ""}`} data-testid={`dim-${d.index}`} {...handlers(d.index, true)}>
              <path d={d.lines.map(([a, b]) => `M${f(a)}L${f(b)}`).join("") + arcPath} className="dim-line" vectorEffect="non-scaling-stroke" />
              <path d={d.arrows.map((a) => arrow(a.at, a.dir)).join("")} className="dim-arrow" />
              <text x={d.at[0]} y={-d.at[1]} fontSize={12 * unit} textAnchor="middle" dominantBaseline="middle">
                {d.text}
              </text>
            </g>
          );
        })}
      </g>
      <g className="relations">
        {glyphs.map((g, n) => (
          <g
            key={n}
            className={`glyph${selected !== null && (g.indices ?? [g.index]).includes(selected) ? " selected" : ""}`}
            data-testid={`glyph-${g.index}`}
            data-relation={constraints[g.index]?.type}
            data-count={g.indices?.length}
            {...handlers(g.index, false)}
          >
            <title>{`${RELATION[constraints[g.index].type].label}${g.indices ? ` ×${g.indices.length}` : ""}`}</title>
            <rect x={g.at[0] - 8 * unit} y={-g.at[1] - 8 * unit} width={(g.indices ? 28 : 16) * unit} height={16 * unit} rx={3 * unit} />
            <Icon name={g.icon} size={12 * unit} x={g.at[0] - 6 * unit} y={-g.at[1] - 6 * unit} />
            {g.indices && (
              <text x={g.at[0] + 13 * unit} y={-g.at[1]} fontSize={9 * unit} textAnchor="middle" dominantBaseline="central" className="glyph-count">
                {g.indices.length}
              </text>
            )}
          </g>
        ))}
      </g>
    </>
  );
}

function sameItem(a: SketchItem, b: SketchItem): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "entity") return a.id === (b as { id: string }).id;
  if (a.kind === "face") return a.index === (b as { index: number }).index;
  return a.ref === (b as { ref: string }).ref;
}

/** Grid spacing of 1, 2 or 5 x 10^n mm, at least ~12 px apart. */
export function gridStep(scale: number): number {
  const minWorld = 12 / scale;
  const pow = Math.pow(10, Math.floor(Math.log10(minWorld)));
  for (const m of [1, 2, 5, 10]) if (m * pow >= minWorld) return m * pow;
  return 10 * pow;
}

/** What an entity spans: its outline, or a sketch point's dot. */
function spanOf(e: SketchEntity): Vec2[][] {
  return e.type === "point" ? [[e.at]] : entityPolylines(e);
}

function fitView(entities: SketchEntity[], model: ModelView, size: { w: number; h: number }): ViewState {
  const xs: number[] = [0];
  const ys: number[] = [0];
  for (const e of entities) for (const pl of spanOf(e)) for (const p of pl) xs.push(p[0]), ys.push(p[1]);
  for (const m of model.edges) for (const p of m.poly) xs.push(p[0]), ys.push(p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const w = Math.max(maxX - minX, 20);
  const h = Math.max(maxY - minY, 20);
  const scale = Math.min(size.w / (w * 1.4), size.h / (h * 1.4));
  const empty = xs.length <= 1;
  return { cx: empty ? 0 : (minX + maxX) / 2, cy: empty ? 0 : (minY + maxY) / 2, scale: empty ? Math.min(size.w, size.h) / 120 : scale };
}

/**
 * What a selection box picks, as SOLIDWORKS does: dragged left to right (a
 * window), the entities wholly inside it; right to left (crossing), every
 * entity inside it or crossing its edge.
 */
export function boxPick(entities: SketchEntity[], a: Vec2, b: Vec2): SketchItem[] {
  const min: Vec2 = [Math.min(a[0], b[0]), Math.min(a[1], b[1])];
  const max: Vec2 = [Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  const inside = (p: Vec2) => p[0] >= min[0] && p[0] <= max[0] && p[1] >= min[1] && p[1] <= max[1];
  const windowed = b[0] >= a[0];
  return entities
    .filter((e) => {
      const lines = spanOf(e);
      const pts = lines.flat();
      if (!pts.length) return false;
      if (windowed) return pts.every(inside);
      if (pts.some(inside)) return true;
      return lines.some((l) => l.some((p, i) => i > 0 && segmentMeetsBox(l[i - 1], p, min, max)));
    })
    .map((e) => ({ kind: "entity" as const, id: e.id }));
}

/** Does the segment cross the box (Liang–Barsky)? */
function segmentMeetsBox(p: Vec2, q: Vec2, min: Vec2, max: Vec2): boolean {
  let t0 = 0;
  let t1 = 1;
  const d: Vec2 = [q[0] - p[0], q[1] - p[1]];
  for (const [pk, qk] of [
    [-d[0], p[0] - min[0]],
    [d[0], max[0] - p[0]],
    [-d[1], p[1] - min[1]],
    [d[1], max[1] - p[1]],
  ]) {
    if (pk === 0) {
      if (qk < 0) return false;
      continue;
    }
    const t = qk / pk;
    if (pk < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}
