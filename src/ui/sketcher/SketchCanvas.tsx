// The sketch editor's canvas: an SVG laid over the 3D view (Phase P wave 2A).
// Its geometry is in sketch-plane millimetres inside a world group that the
// plane's map to the screen transforms (src/ui/sketcher/planeView.ts), so the
// sketch lies on its plane however the view is turned; dots, handles, text
// and glyphs are drawn upright in screen pixels at their mapped places. The
// view's camera moves with the middle and right buttons and the wheel (the
// view's own controls listen on the stage this canvas lies in); the left
// button is the sketch tools'. Facing the plane, the model's edges are drawn
// flat on it as before; turned, only those lying in it are, and the rest are
// hovered and picked where the 3D view shows them (src/ui/sketcher/scenePick.ts).

import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isConstruction } from "../../doc/sketch";
import type { Constraint, SketchEntity, Vec2 } from "../../doc/types";
import { entityPolylines } from "../../geom/profile";
import { dist2 } from "../../geom/vec";
import { Icon, type IconName } from "../icons";
import { inputPrefs, keyFor, keyOf } from "../input";
import type { PickTarget } from "../model/selection";
import { dimensionShapes, RELATION, relationGlyphs } from "./annotate";
import { constraintTargets, isDriven } from "../../geom/axes";
import { distanceTo, handlesOf, hitEntity, hitHandle, type SketchItem, type SmartOptions } from "./draft";
import { faceAt, isModelId, isSketchStandIn, modelEdge, modelEntities, type ModelEdge, type ModelFace, type ModelView } from "./model";
import { shapeWords } from "./names";
import { boxOf, flatMap, mapPoint, mapVector, planeBounds, planeMap, sketchWorldPoints, svgMatrix, toScreen, unmapPoint, useCameraFeed, visibleBounds, type CameraFeed, type PlaneMap } from "./planeView";
import { boxPick, nearer, otherSketchAt, otherSketchMiss, PICK_PX, standInFor, type SceneHit, type SceneMiss } from "./scenePick";
import { tangentStart } from "./tools/arcs";
import { place, placeTyped, previewOf, snapClick, toolByName, typedClick, type Placement } from "./tools/run";
import { readValue } from "./modify";
import { ParametersContext } from "../fields";
import type { Click, SketchToolDef, ToolContext, ToolOptions, TypedField } from "./tools/types";
import type { EditInput, EditPicks, EditPreview, EditToolDef } from "./edit/types";

export { boxPick } from "./scenePick";

/** "select", "dimension", "convert" (picking model edges and faces to convert), or a drawing tool's name in the registry (src/ui/sketcher/tools). */
export type Tool = string;

/**
 * What a right-click lands on: an entity, one of its points, a relation's
 * glyph or a dimension, or empty space (null). An entity may be a model
 * edge's stand-in ("@e12"), another sketch's entity's ("@s:sketch_1:l2") or a
 * sketch axis ("X"); a point a model vertex ("@e12.start").
 */
export type CanvasTarget = { kind: "entity"; id: string } | { kind: "point"; ref: string } | { kind: "constraint"; index: number };

/** How defined the sketch is, in the standard CAD colours. */
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
/** How an edit tool's placed point snaps (a move's base point): as the Point tool's click does. */
const PLACE = toolByName("point")!;

/** An edit tool in use (src/ui/sketcher/edit): the canvas feeds it clicks and drags, and draws what it would do. */
export interface CanvasEdit {
  tool: EditToolDef;
  picks: EditPicks;
  /** What it has picked, drawn as selected. */
  chosen: SketchItem[];
  /** The next click places a point (snapped), rather than picking. */
  places: boolean;
  /** Its preview follows the pointer (a trim's piece, a move's rubber band). */
  follows: boolean;
  preview(hover: EditInput | null): EditPreview;
  onClick(input: EditInput): void;
  /** A drag across the sketch (power trim). */
  onStroke(path: Vec2[]): void;
}

/** The 3D view the canvas lies over: its camera as it moves, what is under the pointer in it, and Fit. */
export interface CanvasView3D {
  feed: CameraFeed;
  /** The part under these client pixels (an edge, a vertex, a face), as the view picks it. */
  pick(clientX: number, clientY: number): PickTarget | null;
  /** Frames the part and the sketch. */
  fit(): void;
  /** The trackpad scheme's left drag on empty space: turns the view (with Shift: pans it). */
  drag?(phase: "start" | "move" | "end", dx: number, dy: number, pan: boolean): void;
  /** The sketch's entities changed: the view draws its plane round them again (the grid here follows them too). */
  extentChanged?(): void;
}

interface Props {
  /** Changed (counted up) by the sketcher to fit the view to the sketch again: a DXF just came in. */
  fitToken?: number;
  entities: SketchEntity[];
  constraints: Constraint[];
  /** The model's edges (and the faces along the sketch) and the other sketches' entities, projected into the sketch plane: drawn, hit, snapped to, related to. */
  model: ModelView;
  /** The 3D view the canvas lies over (without it: a flat page fitted to the sketch). */
  view3d?: CanvasView3D;
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
  /** Smart Dimension: the picks are made (two, or one and a click in space); `at` is where it was placed; `opts.arcs`, the circles Shift-clicked (min or max) and where. */
  onDimension?(picks: SketchItem[], at: Vec2, clientX: number, clientY: number, opts?: SmartOptions): void;
  /**
   * Two picks whose dimension depends on where it is dropped (two points: aligned, horizontal or vertical; two
   * lines: the angle or its supplement; a point and a centreline: distance or diameter): the dimension follows
   * the pointer, shown by `dimensionAt`, until a click places it. Without these, two picks place it at once.
   */
  dropMatters?(picks: SketchItem[]): boolean;
  dimensionAt?(picks: SketchItem[], at: Vec2, opts?: SmartOptions): { constraint: Constraint; label: string; value: number; unit?: string } | null;
  /** Dimensions Fully Define would add, drawn faded until applied. */
  proposed?: Constraint[];
  /** Constraint indices of the smallest set that over-defines the sketch: drawn red. */
  overDefining?: number[];
  /** Reference entities whose model geometry is gone: drawn brown. */
  dangling?: ReadonlySet<string>;
  /** The edit tool in use, if one is. */
  edit?: CanvasEdit;
  /** The closed contours of the profile, shaded lightly: what will extrude. */
  regions?: Vec2[][];
  /** What keeps the sketch from making a clean profile, marked where it is. */
  problems?: { at: Vec2; text: string }[];
}

const SNAP_PX = 10;
/** Stable empty defaults, so memoised annotations don't redo their work every render. */
const NONE: Constraint[] = [];
const NO_INDICES: number[] = [];

/** What the canvas says while the plane is seen edge-on and drawing pauses. */
export function edgeOnHint(): string {
  return `The sketch plane is edge-on — turn the view or press ${keyFor("view.normal") ?? "Ctrl+8"}`;
}

export function SketchCanvas(props: Props) {
  const { entities, constraints, model, tool, construction, snapToGrid, selection, view3d } = props;
  /** The model edges and other sketches' entities as stand-in entities ("@e12", "@s:sketch_1:l2"): hit, snapped to and related to like the sketch's own. */
  const modelEnts = useMemo(() => modelEntities(model), [model]);
  const svg = useRef<SVGSVGElement>(null);
  const world = useRef<SVGGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const cam = useCameraFeed(view3d?.feed);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const [clicks, setClicks] = useState<Snap[]>([]);
  /** A line chain's next piece is a tangent arc (A toggles it). */
  const [arcNext, setArcNext] = useState(false);
  /** Where the pointer went since the last click: an arc bends the way it was drawn. */
  const trail = useRef<Vec2[]>([]);
  /** A power-trim stroke being dragged. */
  const [stroke, setStroke] = useState<Vec2[] | null>(null);
  /** Smart Dimension's picks so far. */
  const [picks, setPicks] = useState<SketchItem[]>([]);
  /** Two picks made, the dimension following the pointer until a click drops it (where it goes says which). */
  const [placing, setPlacing] = useState<{ picks: SketchItem[]; opts?: SmartOptions } | null>(null);
  /** Circles and arcs Shift-clicked among them, and where: measured to their near or far side. */
  const shiftArcs = useRef<Record<string, Vec2>>({});
  /** On-screen numeric input: the values typed for the last click (a line's length and angle), and the field in use. */
  const [typed, setTyped] = useState<{ values: string[]; field: number } | null>(null);
  /** Where the pointer is on the screen: the typed box opens there. */
  const client = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  /** The pointer's last place over the canvas (null: off it): the hover follows the camera when the view moves under a still pointer. */
  const lastClient = useRef<{ x: number; y: number } | null>(null);
  const params = useContext(ParametersContext);
  /** A selection box being dragged, in the canvas's pixels: left to right selects what is inside it, right to left what it touches. */
  const [box, setBox] = useState<{ a: Vec2; b: Vec2 } | null>(null);
  /** Where the chain being drawn started, so clicking there again closes the loop. */
  const chainStart = useRef<Vec2 | null>(null);
  /** What the pointer is on in the 3D view (a turned view): a model edge or vertex, another sketch's entity; or a model edge a sketch can't reference. */
  const scene = useRef<SceneHit | SceneMiss | null>(null);
  const gesture = useRef<
    | { kind: "context"; startClient: Vec2 }
    | { kind: "box"; start: Vec2; additive: boolean }
    | { kind: "drag"; handle: string; from: Vec2; moved: boolean; item: SketchItem; additive: boolean }
    | { kind: "click"; at: Vec2; item: SketchItem | null; additive: boolean; startClient: Vec2; startLocal: Vec2 }
    | { kind: "edit"; path: Vec2[]; startClient: Vec2; stroke: boolean; additive: boolean }
    | { kind: "view"; last: Vec2; pan: boolean }
    | null
  >(null);

  // Track the element size.
  useLayoutEffect(() => {
    const el = svg.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 800, h: el.clientHeight || 600 }));
    ro.observe(el);
    setSize({ w: el.clientWidth || 800, h: el.clientHeight || 600 });
    return () => ro.disconnect();
  }, []);
  // A DXF came in: the view fits it.
  useEffect(() => {
    if (props.fitToken) view3d?.fit();
  }, [props.fitToken]); // eslint-disable-line react-hooks/exhaustive-deps
  // Drawn, moved or deleted: the plane the 3D view draws grows (or shrinks) with the sketch, as the grid does.
  useEffect(() => {
    view3d?.extentChanged?.();
  }, [entities]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving a tool or switching tools drops a half-placed entity, or half-picked dimension.
  useEffect(() => {
    setClicks([]);
    setPicks([]);
    setPlacing(null);
    shiftArcs.current = {};
    setArcNext(false);
    setTyped(null);
    trail.current = [];
  }, [tool]);
  useEffect(() => props.onProgress?.({ placed: clicks.length, arcNext }), [clicks.length, arcNext]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The plane on the screen: through the 3D view's camera, or (before it has reported) a flat page fitted to the sketch. */
  const map: PlaneMap = cam ? planeMap(cam, model.frame) : fitFlat(entities, model, size);
  /** The view is turned off square to the plane: the model's edges are hit in 3D, not flat on the plane. */
  const turned = !!cam && !map.facing;
  const edgeOn = map.edgeOn;
  const unit = 1 / (map.scale || 1); // world size of one pixel
  const step = gridStep(map.scale || 1);
  /** The other sketches are shown (the view's Sketches toggle): they can be hit. */
  const othersShown = !cam || cam.sketches;
  const P = (p: Vec2): Vec2 => mapPoint(map, p);

  const chosen = props.edit ? props.edit.chosen : tool === "dimension" ? (placing?.picks ?? picks) : selection;
  /** The stand-ins picked (or with a point picked): drawn and hit on the plane even in a turned view. */
  const chosenKey = chosen.flatMap((i) => (i.kind === "entity" ? [i.id] : i.kind === "point" ? [i.ref.split(".")[0]] : [])).filter(isModelId).join("|");
  /**
   * The stand-ins hit and snapped to on the plane: facing it, every one (as
   * the flat sketcher always had them; other sketches' while shown); turned,
   * those lying in the plane and those picked. The rest are hit in 3D.
   */
  const planeEnts = useMemo(() => {
    const picked = new Set(chosenKey.split("|"));
    // A round face's axis is hit in 3D (on its face), and on the plane once picked.
    const axes = model.axes.filter((m) => m.entity && picked.has(m.id)).map((m) => m.entity!);
    if (!turned) return [...modelEnts.filter((e) => othersShown || !isSketchStandIn(e.id)), ...axes];
    const keep = (m: ModelEdge) => !!m.entity && (m.inPlane || picked.has(m.id));
    return [...model.edges.filter(keep), ...(othersShown ? model.others.filter(keep) : [])].map((m) => m.entity!).concat(axes);
  }, [modelEnts, model, turned, othersShown, chosenKey]);

  /** The canvas's own pixels of a client point. */
  const localOf = (clientX: number, clientY: number): Vec2 => {
    const r = svg.current?.getBoundingClientRect();
    return r ? [clientX - r.left, clientY - r.top] : [clientX, clientY];
  };
  /** The sketch point (mm) under a client point: the world group's own screen transform undone, exactly what draws it. */
  const toWorld = (clientX: number, clientY: number): Vec2 => {
    const g = world.current;
    const m = g?.getScreenCTM();
    if (g && m && Math.abs(m.a * m.d - m.b * m.c) > 1e-12) {
      // Undone as a 2D affine map (not the 4 × 4 inverse, whose rounding puts a point clicked on the x axis 1e-14 off it).
      const det = m.a * m.d - m.b * m.c;
      const [dx, dy] = [clientX - m.e, clientY - m.f];
      return [(m.d * dx - m.c * dy) / det, (-m.b * dx + m.a * dy) / det];
    }
    const [x, y] = localOf(clientX, clientY);
    return unmapPoint(map, x, y) ?? [0, 0];
  };

  /** What the pointer is on in the 3D view, when the view is turned (facing the plane, everything is hit flat on it). */
  const updateScene = (clientX: number, clientY: number) => {
    if (!turned || !cam || edgeOn || !view3d) {
      scene.current = null;
      return;
    }
    const local = localOf(clientX, clientY);
    // Picking (not drawing), a round face stands for its axis.
    const hit = standInFor(view3d.pick(clientX, clientY), model, cam, local, { faces: tool === "convert", axes: tool !== "convert" && !toolByName(tool) });
    const other = othersShown ? otherSketchAt(model, cam, local, (o) => o.inPlane) : null;
    scene.current = hit && "problem" in hit ? (other ?? hit) : nearer(hit, other);
    // Nothing to use there, but another sketch's entity it can't take: say why.
    if (!scene.current && othersShown) scene.current = otherSketchMiss(model, cam, local);
  };
  const sceneHit = (): SceneHit | null => (scene.current && "item" in scene.current ? scene.current : null);

  /** The drawing tool, if one is active: a line chain's next piece may be a tangent arc. */
  const active: SketchToolDef | undefined = toolByName(tool);
  const def: SketchToolDef | undefined = active && arcNext ? TANGENT_ARC : active;
  const options = props.options ?? {};
  const toolContext = (): ToolContext => ({ entities, trail: trail.current, px: unit });

  /**
   * Where a placed point lands, as the usual CAD inferencing has it: on an end, centre,
   * midpoint, sketch point or the origin, on a line, circle or arc; the tool's
   * own inference; level with or plumb above the click before; else the grid.
   * Over a model edge or vertex (or another sketch's entity) in a turned view,
   * on what that is carried square onto the plane.
   */
  const snap = (p: Vec2): Snap => {
    if (!def) return { p, ref: null };
    const s = sceneHit();
    const on = s?.standIn ? s : null;
    return snapClick(def, clicks.map((c) => c.p), on ? on.at : p, { entities, tol: SNAP_PX * unit, grid: snapToGrid ? step : null, options, model: on ? [on.standIn!, ...planeEnts] : planeEnts });
  };

  /**
   * What is under p: the sketch's points and entities first, then the model's
   * vertices and edges on the plane, then (turned) what the pointer is on in
   * the 3D view, then the sketch axes. Converting, only the model: its edges,
   * else the face under the pointer.
   */
  const itemAt = (p: Vec2): SketchItem | null => {
    if (edgeOn) return null;
    const tol = PICK_PX * unit;
    if (tool !== "convert") {
      const h = hitHandle(entities, p, tol);
      if (h) return h.constraint ? { kind: "point", ref: h.ref } : { kind: "entity", id: h.ref.split(".")[0] };
      const e = hitEntity(entities, p, tol);
      if (e) return { kind: "entity", id: e.id };
      const mh = hitHandle(planeEnts, p, tol, { constraintOnly: true });
      if (mh && mh.ref !== "origin") return { kind: "point", ref: mh.ref };
    }
    // In-plane edges first (they come first in the stand-ins): an edge behind one projects onto the same line.
    const me = firstHit(planeEnts, p, tol);
    if (me) return { kind: "entity", id: me.id };
    const s = sceneHit();
    if (s) return s.item;
    if (tool === "convert") {
      if (turned) return null;
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
    const line = [...entities, ...modelEnts, ...planeEnts].find((e) => e.id === first.id);
    if (line?.type !== "line") return false;
    const d = [line.end[0] - line.start[0], line.end[1] - line.start[1]];
    const along = hit.id === "X" ? Math.abs(d[1]) : Math.abs(d[0]);
    return along > 1e-9 * Math.hypot(d[0], d[1]);
  };
  /** A reference follows the model: picked, never dragged. */
  const fixedId = (id: string) => !!entities.find((e) => e.id === id)?.ref;

  /** What an edit tool gets at p: what is under it, and the point placed there (snapped) when it places one. */
  const editInput = (p: Vec2, additive = false): EditInput => {
    const tol = PICK_PX * unit;
    if (props.edit?.places) {
      const s = sceneHit();
      const on = s?.standIn ? s : null;
      const sn = snapClick(PLACE, [], on ? on.at : p, { entities, tol: SNAP_PX * unit, grid: snapToGrid ? step : null, options: {}, model: on ? [on.standIn!, ...planeEnts] : planeEnts });
      return { p: sn.p, item: itemAt(p), ref: sn.ref, tol, additive };
    }
    return { p, item: itemAt(p), ref: null, tol, additive };
  };

  /** The tool's last click is in: build the shape, with what its clicks inferred, and hand it over. */
  const finishPlacement = (pts: Snap[]): Placement | null => {
    if (!def) return null;
    const made = place(def, pts, options, toolContext(), construction);
    if (made) props.onCreate(made);
    return made;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    lastClient.current = { x: e.clientX, y: e.clientY };
    // The middle button and the wheel are the view's: it turns, pans and zooms (its controls listen on the stage).
    if (e.button === 1) return;
    // The right button pans the view too; pressed and released in place it is a right-click.
    if (e.button === 2) {
      gesture.current = { kind: "context", startClient: [e.clientX, e.clientY] };
      return;
    }
    if (e.button !== 0) return;
    if (edgeOn) {
      props.onMessage?.(edgeOnHint());
      return;
    }
    (e.target as Element).setPointerCapture?.(e.pointerId);
    updateScene(e.clientX, e.clientY);
    const p = toWorld(e.clientX, e.clientY);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (props.edit) {
      gesture.current = { kind: "edit", path: [p], startClient: [e.clientX, e.clientY], stroke: false, additive };
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
    gesture.current = { kind: "click", at: p, item: itemAt(p), additive, startClient: [e.clientX, e.clientY], startLocal: localOf(e.clientX, e.clientY) };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    lastClient.current = { x: e.clientX, y: e.clientY };
    client.current = { x: e.clientX, y: e.clientY };
    const g = gesture.current;
    if (g?.kind === "view") {
      view3d?.drag?.("move", e.clientX - g.last[0], e.clientY - g.last[1], g.pan);
      g.last = [e.clientX, e.clientY];
      return;
    }
    // The view is being moved (the middle or right button held): nothing here follows the pointer.
    if ((e.buttons & 6) !== 0 && g?.kind !== "drag" && g?.kind !== "box" && g?.kind !== "edit") return;
    const p = toWorld(e.clientX, e.clientY);
    updateScene(e.clientX, e.clientY);
    lastCursor.current = p;
    if (def && clicks.length) {
      trail.current.push(p);
      // A long sweep keeps its shape at half the samples.
      if (trail.current.length > 600) trail.current = trail.current.filter((_, i) => i % 2 === 0);
    }
    setCursor(p);
    if (!g) return;
    if (g.kind === "box") {
      setBox({ a: g.start, b: localOf(e.clientX, e.clientY) });
      return;
    }
    if (g.kind === "edit") {
      // A drag (not a click) with a tool that takes one: the power trim stroke.
      if (!g.stroke && props.edit?.tool.drag && Math.hypot(e.clientX - g.startClient[0], e.clientY - g.startClient[1]) >= 4) g.stroke = true;
      if (g.stroke) {
        g.path.push(p);
        setStroke([...g.path]);
      }
      return;
    }
    if (g.kind === "click") {
      const dx = e.clientX - g.startClient[0];
      const dy = e.clientY - g.startClient[1];
      if (Math.hypot(dx, dy) < 4) return;
      // The trackpad scheme: dragging empty space turns the view (Shift: pans it), as on the view itself.
      if (inputPrefs().mouse === "trackpad" && view3d?.drag) {
        gesture.current = { kind: "view", last: [e.clientX, e.clientY], pan: e.shiftKey };
        if (!e.shiftKey) view3d.drag("start", 0, 0, false);
        view3d.drag("move", dx, dy, e.shiftKey);
        return;
      }
      // Dragging empty space draws a selection box.
      gesture.current = { kind: "box", start: g.startLocal, additive: g.additive };
      setBox({ a: g.startLocal, b: localOf(e.clientX, e.clientY) });
      return;
    }
    if (g.kind === "drag") {
      if (!g.moved && dist2(p, g.from) < 3 * unit) return;
      g.moved = true;
      props.onDrag("move", g.handle, g.from, p);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    const p = toWorld(e.clientX, e.clientY);
    if (g?.kind === "context") {
      if (e.button === 2 && Math.hypot(e.clientX - g.startClient[0], e.clientY - g.startClient[1]) < 4) {
        updateScene(e.clientX, e.clientY);
        const item = itemAt(p);
        props.onContext?.(item?.kind === "entity" ? item : item?.kind === "point" ? { kind: "point", ref: item.ref } : null, e.clientX, e.clientY);
      }
      return;
    }
    if (e.button !== 0) return;
    if (g?.kind === "view") {
      if (!g.pan) view3d?.drag?.("end", 0, 0, false);
      return;
    }
    if (g?.kind === "edit") {
      setStroke(null);
      if (g.stroke) props.edit?.onStroke([...g.path, p]);
      else props.edit?.onClick(editInput(p, g.additive));
      return;
    }
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
      const picked = boxPick(entities, g.start, localOf(e.clientX, e.clientY), P);
      props.onSelect(g.additive ? [...selection, ...picked.filter((x) => !selection.some((s) => sameItem(s, x)))] : picked);
      return;
    }
    if (edgeOn || tool === "select") return;
    if (tool === "convert") {
      // Converting: each click picks or drops a model edge, or a face for its outline.
      return select(itemAt(p), true);
    }
    if (tool === "dimension") {
      // Smart Dimension: pick one or two things; a second pick, or a click in space after one, places it.
      if (placing) {
        // The dimension was following the pointer: this click drops it, and where says which it is.
        setPlacing(null);
        return props.onDimension?.(placing.picks, p, e.clientX, e.clientY, placing.opts);
      }
      const hit = itemAt(p);
      // A click on a sketch axis after a line across it places that line's dimension (the axes run through
      // where dimensions go); after a point, a circle or a line along the axis, it dimensions to the axis.
      const item = hit && picks.length === 1 && placesOn(hit, picks[0]) ? null : hit;
      // Shift-clicking a circle or arc measures to its near or far side, by the side clicked (min and max).
      if (item?.kind === "entity" && e.shiftKey) {
        const round = [...entities, ...modelEnts, ...planeEnts].find((x) => x.id === item.id);
        if (round?.type === "circle" || round?.type === "arc") shiftArcs.current = { ...shiftArcs.current, [item.id]: p };
      }
      const arcs = () => {
        const out = shiftArcs.current;
        shiftArcs.current = {};
        return Object.keys(out).length ? { arcs: out } : undefined;
      };
      if (item && !picks.some((x) => sameItem(x, item))) {
        const next = [...picks, item];
        if (next.length < 2) return setPicks(next);
        setPicks([]);
        if (props.dropMatters?.(next)) return setPlacing({ picks: next, opts: arcs() });
        return props.onDimension?.(next, p, e.clientX, e.clientY, arcs());
      }
      if (!item && picks.length === 1) {
        setPicks([]);
        props.onDimension?.(picks, p, e.clientX, e.clientY, arcs());
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
    if (def.open) {
      // As many points as given: the last one clicked again (a double-click) finishes, the first one closes.
      const again = clicks.length > 0 && dist2(s.p, clicks[clicks.length - 1].p) <= 3 * unit;
      const closes = clicks.length >= 3 && dist2(s.p, clicks[0].p) < 1e-9;
      if (again && clicks.length >= def.clicks) return afterPlacement(finishPlacement(clicks), s);
      if (closes) return afterPlacement(finishPlacement(next), s);
      if (!again) setClicks(next);
      return;
    }
    if (next.length < def.clicks) {
      setClicks(next);
      return;
    }
    afterPlacement(finishPlacement(next), s);
  };

  /** What follows a shape placed by its last click `s` (or by typed values): a chain carries on from its end; else the tool starts over. */
  const afterPlacement = (made: Placement | null, s: Snap) => {
    setTyped(null);
    if (!def) return;
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

  /** The typed values as numbers: an empty field is undefined (the pointer gives it); a bad one says why. */
  const typedValues = (): (number | undefined)[] | string => {
    if (!typed) return [];
    const out: (number | undefined)[] = [];
    for (const [i, text] of typed.values.entries()) {
      if (text.trim() === "") {
        out.push(undefined);
        continue;
      }
      const r = readValue(text, params, def?.typed?.fields[i]?.unit === "°" ? "angle" : "length");
      if (!r.ok) return `${def?.typed?.fields[i]?.label ?? "Value"}: ${r.error}`;
      out.push(r.value);
    }
    return out;
  };
  /** Where the pointer was last over the sketch, in sketch mm: the typed values take the rest from it. */
  const lastCursor = useRef<Vec2>([0, 0]);

  /** Enter in the typed box: the shape with its last click where the values put it, each value a driving dimension. */
  const commitTyped = () => {
    if (!def?.typed || !typed) return;
    const values = typedValues();
    if (typeof values === "string") return props.onMessage?.(values);
    const made = placeTyped(def, clicks, values, cursor ?? lastCursor.current, options, toolContext(), construction);
    if (!made) return props.onMessage?.("those values make nothing: type a length above 0");
    props.onCreate(made);
    const last = typedClick(def, clicks, values, cursor ?? lastCursor.current)!;
    trail.current = [];
    afterPlacement(made, last);
  };

  const select = (item: SketchItem | null, additive: boolean) => {
    if (!item) return props.onSelect(additive ? selection : []);
    const has = selection.some((s) => sameItem(s, item));
    if (additive) props.onSelect(has ? selection.filter((s) => !sameItem(s, item)) : [...selection, item]);
    else props.onSelect([item]);
  };

  // The view moved under a still pointer (the wheel, the keys, a glide): what is under it follows.
  const mapKey = `${map.a},${map.b},${map.c},${map.d},${map.e},${map.f}`;
  useEffect(() => {
    const c = lastClient.current;
    if (!c || gesture.current) return;
    updateScene(c.x, c.y);
    setCursor(toWorld(c.x, c.y));
  }, [mapKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Typing in a field (the polygon's sides), Esc and A are the field's.
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      // On-screen numeric input: a number typed while the last click is being placed opens the box at the pointer.
      if (!typing && !typed && def?.typed && clicks.length > 0 && clicks.length === def.clicks - 1 && !e.ctrlKey && !e.metaKey && !e.altKey && /^[0-9.]$/.test(e.key)) {
        setTyped({ values: def.typed.fields.map((_, i) => (i === 0 ? e.key : "")), field: 0 });
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // An open tool (a spline) finishes on Enter with the points placed so far.
      if (e.key === "Enter" && !typing && def?.open && clicks.length >= def.clicks) {
        afterPlacement(finishPlacement(clicks), clicks[clicks.length - 1]);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === "Escape" && !typing && (clicks.length || picks.length || placing)) {
        setClicks([]);
        setPicks([]);
        setPlacing(null);
        setArcNext(false);
        e.stopPropagation();
        return;
      }
      // Drawing lines, the Arc key turns the next piece into a tangent arc from the end, and back.
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
    if (!def || clicks.length === 0) return [];
    // Values being typed place the last click; the pointer gives what is not typed yet.
    if (typed && def.typed) {
      const values = typedValues();
      const last = typeof values === "string" ? null : typedClick(def, clicks, values, cursor ?? lastCursor.current);
      return last ? previewOf(def, [...clicks, last], options, toolContext(), construction) : [];
    }
    if (!cursor || edgeOn) return [];
    return previewOf(def, [...clicks, snap(cursor)], options, toolContext(), construction);
  }, [def, cursor, clicks, construction, options, entities, typed, edgeOn, planeEnts]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The dimension being placed, as it would be dropped where the pointer is. */
  const dropping = useMemo(() => (placing && cursor ? (props.dimensionAt?.(placing.picks, cursor, placing.opts) ?? null) : null), [placing, cursor]); // eslint-disable-line react-hooks/exhaustive-deps
  const proposed = useMemo(() => (dropping ? [...(props.proposed ?? NONE), dropping.constraint] : (props.proposed ?? NONE)), [dropping?.constraint, props.proposed]); // eslint-disable-line react-hooks/exhaustive-deps
  const selectedIds = new Set(chosen.flatMap((s) => (s.kind === "entity" ? [s.id] : [])));
  const selectedPoints = new Set(chosen.flatMap((s) => (s.kind === "point" ? [s.ref] : [])));
  const hoverItem = cursor && (tool === "select" || tool === "dimension" || tool === "convert" || (props.edit?.tool.kind === "collect" && !props.edit.places)) && !gesture.current ? itemAt(cursor) : null;
  // What the edit tool would do: with the pointer where it is, for the tools whose preview follows it.
  const editHover = props.edit?.follows && !stroke ? cursor : null;
  const editPreview = useMemo(
    () => (props.edit ? props.edit.preview(editHover ? editInput(editHover) : null) : {}),
    [props.edit, editHover?.[0], editHover?.[1], entities], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const selectedFaces = new Set(chosen.flatMap((s) => (s.kind === "face" ? [s.index] : [])));
  const hoverOwner = hoverItem?.kind === "entity" ? hoverItem.id : hoverItem?.kind === "point" ? hoverItem.ref.split(".")[0] : null;
  const isHover = (id: string) => hoverItem?.kind === "entity" && hoverItem.id === id;
  const snapMark =
    cursor && def && !edgeOn
      ? snap(cursor)
      : cursor && props.edit?.places && !edgeOn
        ? (() => {
            const s = sceneHit();
            const on = s?.standIn ? s : null;
            return snapClick(PLACE, [], on ? on.at : cursor, { entities, tol: SNAP_PX * unit, grid: snapToGrid ? step : null, options: {}, model: on ? [on.standIn!, ...planeEnts] : planeEnts });
          })()
        : null;
  const inferIcon: IconName | null = !snapMark ? null : snapMark.ref ? "coincident" : snapMark.on ? RELATION[snapMark.on.type].icon : snapMark.orient ?? null;
  // A selected relation outlines what it holds.
  const selectedK = props.selectedConstraint !== null && props.selectedConstraint !== undefined ? constraints[props.selectedConstraint] : undefined;
  const related = new Set(selectedK ? constraintTargets(selectedK) : []);
  const state = (id: string) => (props.defined?.conflicts.has(id) ? "conflict" : !props.defined ? "" : props.defined.free.has(id) ? "free" : "defined");
  const pointState = (ref: string) => (!props.defined ? "" : props.defined.freePoints.has(ref) ? "free" : "defined");

  /** The model edges drawn flat on the plane: facing it, all of them (as ever); turned, those lying in it, and those hovered or picked. */
  const drawnEdges = turned ? model.edges.filter((m) => m.inPlane || isHover(m.id) || hoverOwner === m.id || selectedIds.has(m.id) || chosenKey.split("|").includes(m.id)) : model.edges;
  /** Other sketches' entities drawn on the plane (the 3D view draws them where they are): those hovered or picked, projected. */
  const drawnOthers = othersShown ? model.others.filter((o) => o.entity && (hoverOwner === o.id || chosenKey.split("|").includes(o.id))) : [];
  /** Round faces' axes drawn on the plane: those hovered or picked, projected. */
  const drawnAxes = model.axes.filter((a) => a.entity && (hoverOwner === a.id || chosenKey.split("|").includes(a.id)));
  /** The hit in the 3D view under the pointer (turned), and the picked stand-ins off the plane: lit up where the view shows them. */
  const scenePointer = cam && turned && cursor && !gesture.current ? scene.current : null;
  const litOutlines: { key: string; poly: Vec2[]; className: string }[] = [];
  if (cam && turned) {
    for (const id of chosenKey.split("|").filter(Boolean)) {
      const m = modelEdge(model, id);
      if (m && !m.inPlane) litOutlines.push({ key: `sel:${id}`, poly: m.poly3.map((p) => toScreen(cam, p)), className: "scene-outline selected" });
    }
    if (scenePointer?.poly3.length) litOutlines.push({ key: "hover", poly: scenePointer.poly3.map((p) => toScreen(cam, p)), className: `scene-outline ${"problem" in scenePointer ? "unusable" : "hover"}` });
    (scenePointer?.outline3 ?? []).forEach((l, k) => litOutlines.push({ key: `hover-side${k}`, poly: l.map((p) => toScreen(cam, p)), className: "scene-outline side" }));
  }
  const sceneTitle = scenePointer && "problem" in scenePointer ? (scenePointer.title ?? `${scenePointer.outline3 ? "Round face" : "Model edge"}: ${scenePointer.problem}`) : null;
  /** Where the grid and the axes are drawn: the plane round the sketch and the model, within the view. */
  const gridArea = useMemo(() => planeArea(entities, model, map, size), [entities, model, mapKey, size.w, size.h]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <svg
        ref={svg}
        className={`sketch-canvas tool-${tool}${cam ? " in-3d" : ""}${turned ? " turned" : ""}${edgeOn ? " edge-on" : ""}`}
        data-defined={props.defined ? (props.defined.conflicts.size ? "over" : props.defined.free.size ? "under" : "full") : undefined}
        data-facing={map.facing ? "true" : "false"}
        data-testid="sketch-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onLostPointerCapture={() => {
          if (gesture.current?.kind === "context") gesture.current = null;
        }}
        onPointerLeave={() => {
          lastClient.current = null;
          scene.current = null;
          setCursor(null);
        }}
        onContextMenu={(e) => e.preventDefault()}
        onDoubleClick={() => {
          if (def?.chain) {
            setClicks([]);
            setArcNext(false);
          }
        }}
      >
        <g ref={world} transform={svgMatrix(map)}>
          {gridArea && <Grid area={gridArea} step={step} />}
          {/* The sketch's axes: lines any relation or dimension may use ("X", "Y"). */}
          {/* Drawn across the view only: a line a million mm long would have too many dashes, and draws solid. */}
          {gridArea &&
            (["X", "Y"] as const).map((a) => (
              <line
                key={a}
                x1={a === "X" ? gridArea.min[0] : 0}
                y1={a === "X" ? 0 : gridArea.min[1]}
                x2={a === "X" ? gridArea.max[0] : 0}
                y2={a === "X" ? 0 : gridArea.max[1]}
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
            {drawnEdges.map((m) => (
              <path
                key={m.id}
                d={m.poly.map((q, i) => `${i ? "L" : "M"}${q[0]} ${q[1]}`).join("")}
                className={[
                  "model-edge",
                  m.entity ? "" : "other",
                  m.inPlane ? "in-plane" : turned ? "projected" : "",
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
          <g className="sketch-refs" data-testid="sketch-refs">
            {drawnOthers.map((o) => (
              <EntityShape key={o.id} e={o.entity!} className={`entity other-sketch${isHover(o.id) ? " hover" : ""}${selectedIds.has(o.id) ? " selected" : ""}`} standIn />
            ))}
            {drawnAxes.map((a) => (
              <EntityShape key={a.id} e={a.entity!} className={`entity face-axis${isHover(a.id) ? " hover" : ""}${selectedIds.has(a.id) ? " selected" : ""}${related.has(a.id) ? " related" : ""}`} standIn />
            ))}
          </g>
          {props.regions && props.regions.length > 0 && (
            <path
              d={props.regions.map((loop) => loop.map((q, i) => `${i ? "L" : "M"}${q[0]} ${q[1]}`).join("") + "Z").join("")}
              className="sketch-region"
              fillRule="evenodd"
              data-testid="sketch-regions"
              data-count={props.regions.length}
            />
          )}
          {entities.map((e) =>
            e.type === "point" ? null : (
              <EntityShape
                key={e.id}
                e={e}
                className={[
                  "entity",
                  state(e.id),
                  isConstruction(e) ? "construction" : "",
                  e.ref ? "reference" : "",
                  related.has(e.id) ? "related" : "",
                  props.dangling?.has(e.id) ? "dangling" : "",
                  selectedIds.has(e.id) ? "selected" : "",
                  hoverItem?.kind === "entity" && hoverItem.id === e.id ? "hover" : "",
                ].join(" ")}
              />
            ),
          )}
          {preview.map((e, i) => (e.type === "point" ? null : <EntityShape key={`preview:${i}`} e={e} className={`entity preview${e.construction ? " construction" : ""}`} />))}
          {(editPreview.remove ?? []).map((e, i) => (
            <EntityShape key={`goes:${i}`} e={e} className="entity preview goes" />
          ))}
          {(editPreview.add ?? []).map((e, i) => (e.type === "point" ? null : <EntityShape key={`edit:${i}`} e={e} className={`entity preview edit${e.construction ? " construction" : ""}`} />))}
          {stroke && <path d={stroke.map((q, i) => `${i ? "L" : "M"}${q[0]} ${q[1]}`).join("")} className="trim-stroke" vectorEffect="non-scaling-stroke" data-testid="trim-stroke" />}
        </g>
        {/* Screen space: what keeps its size and stays upright however the plane is turned, at the places the map puts it. */}
        <g className="sketch-overlay">
          {litOutlines.map((o) => (
            <polyline key={o.key} points={o.poly.map((q) => `${q[0]},${q[1]}`).join(" ")} className={o.className} data-testid={o.key === "hover" ? "scene-hover" : undefined} />
          ))}
          {sceneTitle && cursor && (
            <g className="scene-tip" data-testid="scene-tip" pointerEvents="none">
              <text x={P(cursor)[0] + 14} y={P(cursor)[1] + 26}>
                {sceneTitle}
              </text>
            </g>
          )}
          {/* A model point off the plane snapped to: where it lands on the plane, shown by a dashed drop. */}
          {scenePointer && "item" in scenePointer && scenePointer.point3 && snapMark && cam && (
            <line
              x1={toScreen(cam, scenePointer.point3)[0]}
              y1={toScreen(cam, scenePointer.point3)[1]}
              x2={P(snapMark.p)[0]}
              y2={P(snapMark.p)[1]}
              className="scene-drop"
            />
          )}
          {entities.map((e) =>
            e.type === "point" ? (
              <PointDot
                key={e.id}
                at={P(e.at)}
                id={e.id}
                className={[
                  "entity",
                  state(e.id),
                  e.ref ? "reference" : "",
                  related.has(e.id) ? "related" : "",
                  props.dangling?.has(e.id) ? "dangling" : "",
                  selectedIds.has(e.id) || selectedPoints.has(`${e.id}.at`) ? "selected" : "",
                  (hoverItem?.kind === "entity" && hoverItem.id === e.id) || (hoverItem?.kind === "point" && hoverItem.ref === `${e.id}.at`) ? "hover" : "",
                ].join(" ")}
              />
            ) : null,
          )}
          {drawnOthers.filter((o) => o.entity!.type === "point").map((o) => (
            <PointDot key={`other:${o.id}`} at={P((o.entity as { at: Vec2 }).at)} className={`entity other-sketch${hoverOwner === o.id ? " hover" : ""}`} />
          ))}
          {preview.map((e, i) => (e.type === "point" ? <PointDot key={`preview:${i}`} at={P(e.at)} className="entity preview" /> : null))}
          {(editPreview.add ?? []).map((e, i) => (e.type === "point" ? <PointDot key={`edit:${i}`} at={P(e.at)} className="entity preview" /> : null))}
          {(editPreview.marks ?? []).map((m, i) => {
            const [x, y] = P(m.at);
            return (
              <g key={`mark:${i}`} className={`edit-mark${m.off ? " off" : ""}`} data-testid="edit-mark" data-off={m.off ? "true" : undefined}>
                <circle cx={x} cy={y} r={5} />
                {m.off && <path d={`M${x - 4} ${y - 4}L${x + 4} ${y + 4}M${x - 4} ${y + 4}L${x + 4} ${y - 4}`} />}
              </g>
            );
          })}
          {(props.edit?.picks.places ?? []).map((pl, i) => {
            const [x, y] = P(pl.p);
            return <circle key={`place:${i}`} cx={x} cy={y} r={3.5} className="placed" />;
          })}
          {[...entities, ...modelHandles(modelEnts, hoverItem, chosen)].flatMap((e) =>
            // A sketch point is its own handle: its dot. A model edge shows its points only when the pointer is on it, or one is picked.
            (e.type === "point" ? [] : handlesOf(e)).map((h) => {
              const [x, y] = P(h.point);
              return (
                <circle
                  key={h.ref}
                  cx={x}
                  cy={y}
                  r={h.constraint ? 3.5 : 2.5}
                  className={[
                    "handle",
                    isModelId(h.ref) || e.ref ? "reference" : h.constraint ? pointState(h.ref) : "corner",
                    selectedPoints.has(h.ref) ? "selected" : "",
                    hoverItem?.kind === "point" && hoverItem.ref === h.ref ? "hover" : "",
                  ].join(" ")}
                />
              );
            }),
          )}
          {(() => {
            const [x, y] = P([0, 0]);
            return <circle cx={x} cy={y} r={4} className={`origin ${selectedPoints.has("origin") ? "selected" : ""}`} />;
          })()}
          {clicks.map((c, i) => {
            const [x, y] = P(c.p);
            return <circle key={i} cx={x} cy={y} r={3} className="placed" />;
          })}
          {(snapMark?.ref || snapMark?.on) && <circle cx={P(snapMark.p)[0]} cy={P(snapMark.p)[1]} r={7} className="snap" />}
          {box && (
            <rect
              x={Math.min(box.a[0], box.b[0])}
              y={Math.min(box.a[1], box.b[1])}
              width={Math.abs(box.b[0] - box.a[0])}
              height={Math.abs(box.b[1] - box.a[1])}
              className={box.b[0] >= box.a[0] ? "select-box window" : "select-box crossing"}
              data-testid="select-box"
            />
          )}
        </g>
        <Annotations
          entities={entities}
          constraints={constraints}
          unit={unit}
          map={map}
          showRelations={props.showRelations ?? true}
          selected={props.selectedConstraint ?? null}
          onSelect={(i) => props.onSelectConstraint?.(i)}
          onEdit={(i, x, y) => props.onEditDimension?.(i, x, y)}
          onContext={(i, x, y) => props.onContext?.({ kind: "constraint", index: i }, x, y)}
          interactive={(tool === "select" || tool === "dimension") && !edgeOn}
          proposed={proposed}
          overDefining={props.overDefining ?? NO_INDICES}
        />
        {(props.problems ?? []).map((w, i) => {
          const [x, y] = P(w.at);
          return (
            <g key={`warn:${i}`} className="sketch-warning" data-testid="sketch-warning" pointerEvents="visiblePainted">
              <title>{w.text}</title>
              <Icon name="alert" size={14} x={x - 7} y={y - 20} />
            </g>
          );
        })}
        {cursor && dropping && (
          <g className="infer dropping" data-testid="dimension-placing" pointerEvents="none">
            <text x={P(cursor)[0] + 14} y={P(cursor)[1] + 22} fontSize={12}>
              {`${dropping.label} ${Math.round(dropping.value * 1000) / 1000}${dropping.unit === "°" ? "°" : ""}`}
            </text>
          </g>
        )}
        {cursor && inferIcon && (
          <g className="infer" data-testid={`infer-${inferIcon}`} pointerEvents="none">
            <rect x={P(cursor)[0] + 10} y={P(cursor)[1] + 8} width={18} height={18} rx={3} />
            <Icon name={inferIcon} size={14} x={P(cursor)[0] + 12} y={P(cursor)[1] + 10} />
          </g>
        )}
      </svg>
      {edgeOn && (
        <div className="sketch-edge-on" role="status" data-testid="sketch-edge-on">
          {edgeOnHint()}
        </div>
      )}
      {typed && def?.typed && (
        <TypedBox
          fields={def.typed.fields}
          state={typed}
          at={client.current}
          problem={typeof typedValues() === "string" ? (typedValues() as string) : null}
          onChange={setTyped}
          onCommit={commitTyped}
          onCancel={() => setTyped(null)}
        />
      )}
    </>
  );
}

/** An entity's outline. A preview's carries no data-entity (the rubber band is not the sketch), nor does a stand-in's. */
function EntityShape({ e, className, standIn }: { e: SketchEntity; className: string; standIn?: boolean }) {
  const d = entityPolylines(e, Math.PI / 64)
    .map((pts) => pts.map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join(""))
    .join("");
  const preview = className.includes("preview") || standIn;
  return <path d={d} className={className} vectorEffect="non-scaling-stroke" data-entity={preview ? undefined : e.id} data-stand-in={standIn ? e.id : undefined} />;
}

/** A sketch point: a dot, the same size at any zoom, at its place on the screen. */
function PointDot({ at, id, className }: { at: Vec2; id?: string; className: string }) {
  return <circle cx={at[0]} cy={at[1]} r={3.5} className={`${className} point`} data-entity={id} />;
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

/** The grid: lines `step` apart over the area (sketch mm), every fifth stronger; never more than a few hundred. */
function Grid({ area, step }: { area: { min: Vec2; max: Vec2 }; step: number }) {
  let s = step;
  // So far edge-on that the area is vast: a coarser grid (it is faded there anyway).
  while ((area.max[0] - area.min[0]) / s + (area.max[1] - area.min[1]) / s > 600) s *= 5;
  const x0 = Math.floor(area.min[0] / s) * s;
  const y0 = Math.floor(area.min[1] / s) * s;
  const minor: string[] = [];
  const major: string[] = [];
  for (let x = x0; x <= area.max[0]; x += s) (Math.round(x / s) % 5 === 0 ? major : minor).push(`M${x} ${area.min[1]}L${x} ${area.max[1]}`);
  for (let y = y0; y <= area.max[1]; y += s) (Math.round(y / s) % 5 === 0 ? major : minor).push(`M${area.min[0]} ${y}L${area.max[0]} ${y}`);
  return (
    <>
      <path d={minor.join("")} className="grid-minor" vectorEffect="non-scaling-stroke" />
      <path d={major.join("")} className="grid-major" vectorEffect="non-scaling-stroke" />
    </>
  );
}

/**
 * Where the grid and the axes are drawn (sketch mm): the view's part of the
 * plane; in the 3D view, only round the sketch and the model's edges in the
 * plane (an eighth of their size beyond, at least 20 mm), so the grid sits on
 * the plane like a sheet rather than over the whole part. Null edge-on.
 */
function planeArea(entities: SketchEntity[], model: ModelView, map: PlaneMap, size: { w: number; h: number }): { min: Vec2; max: Vec2 } | null {
  const seen = visibleBounds(map, size.w, size.h);
  if (!seen || map.edgeOn) return null;
  if (map.facing) return seen;
  // Turned: the plane the 3D view draws (round the part's box and the sketch), within the view.
  const own = planeBounds(model.frame, [...boxOf(model.edges.flatMap((m) => m.poly3)), ...sketchWorldPoints(entities, model.frame)]);
  const min: Vec2 = [Math.max(own.min[0], seen.min[0]), Math.max(own.min[1], seen.min[1])];
  const max: Vec2 = [Math.min(own.max[0], seen.max[0]), Math.min(own.max[1], seen.max[1])];
  return min[0] < max[0] && min[1] < max[1] ? { min, max } : null;
}

/** A quarter-step rounding of mm per pixel (about 2%), so the annotations are laid out again only when the zoom changes that much. */
function steppedUnit(unit: number): number {
  const k = Math.round(Math.log(unit) / Math.log(1.02));
  return Math.pow(1.02, k);
}

/**
 * Dimensions and relation glyphs over the sketch, in screen pixels: each
 * dimension's lines and arcs mapped onto the plane, its arrowheads and text
 * upright at their places; each glyph a small box at its anchor. A click
 * selects one, a double-click edits a dimension's value, a right-click opens
 * its menu.
 */
function Annotations({
  entities,
  constraints,
  unit,
  map,
  showRelations,
  selected,
  onSelect,
  onEdit,
  onContext,
  interactive,
  proposed,
  overDefining,
}: {
  /** Clicks reach the dimensions and glyphs (Select, Smart Dimension); with a drawing or edit tool they go through to the sketch. */
  interactive: boolean;
  entities: SketchEntity[];
  constraints: Constraint[];
  unit: number;
  map: PlaneMap;
  showRelations: boolean;
  selected: number | null;
  onSelect(i: number): void;
  onEdit(i: number, clientX: number, clientY: number): void;
  onContext(i: number, clientX: number, clientY: number): void;
  /** Dimensions Fully Define would add: drawn faded after the sketch's own, not clickable. */
  proposed: Constraint[];
  /** The constraints that over-define the sketch: red. */
  overDefining: number[];
}) {
  const all = useMemo(() => (proposed.length ? [...constraints, ...proposed] : constraints), [constraints, proposed]);
  const layoutUnit = steppedUnit(unit);
  const dims = useMemo(() => dimensionShapes(entities, all, layoutUnit), [entities, all, layoutUnit]);
  const dimClass = (i: number) => {
    const k = all[i];
    return [i >= constraints.length ? " proposed" : "", k && isDriven(k) ? " driven" : "", overDefining.includes(i) ? " conflict" : ""].join("");
  };
  const glyphs = useMemo(() => (showRelations ? relationGlyphs(entities, constraints, layoutUnit) : []), [entities, constraints, layoutUnit, showRelations]);
  const P = (p: Vec2) => mapPoint(map, p);
  const f = (p: Vec2) => {
    const [x, y] = P(p);
    return `${x} ${y}`;
  };
  /** An arrowhead at `tip` (sketch mm) pointing along `dir` (a sketch direction), 9 px long, upright on the screen. */
  const arrow = (tip: Vec2, dir: Vec2) => {
    const v = mapVector(map, dir);
    const l = Math.hypot(v[0], v[1]) || 1;
    const u: Vec2 = [v[0] / l, v[1] / l];
    const n: Vec2 = [-u[1], u[0]];
    const [x, y] = P(tip);
    const b: Vec2 = [x - u[0] * 9, y - u[1] * 9];
    return `M${x} ${y}L${b[0] + n[0] * 3} ${b[1] + n[1] * 3}L${b[0] - n[0] * 3} ${b[1] - n[1] * 3}Z`;
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
      <g className="dimensions" pointerEvents={interactive ? undefined : "none"}>
        {dims.map((d, n) => {
          let arcPath = "";
          if (d.arc) {
            // The angle's arc on the plane: a fine polyline through the map (an arc turned with the plane is an ellipse on the screen).
            const steps = Math.max(8, Math.ceil(Math.abs(d.arc.sweep) / (Math.PI / 48)));
            const pts: string[] = [];
            for (let k = 0; k <= steps; k++) {
              const t = d.arc.from + (d.arc.sweep * k) / steps;
              pts.push(`${k ? "L" : "M"}${f([d.arc.center[0] + d.arc.r * Math.cos(t), d.arc.center[1] + d.arc.r * Math.sin(t)])}`);
            }
            arcPath = pts.join("");
          }
          const [tx, ty] = P(d.at);
          return (
            <g
              key={n}
              className={`dim${selected === d.index ? " selected" : ""}${dimClass(d.index)}`}
              data-testid={d.index < constraints.length ? `dim-${d.index}` : `dim-proposed-${d.index - constraints.length}`}
              {...(d.index < constraints.length ? handlers(d.index, true) : { pointerEvents: "none" })}
            >
              <path d={d.lines.map(([a, b]) => `M${f(a)}L${f(b)}`).join("") + arcPath} className="dim-line" />
              <path d={d.arrows.map((a) => arrow(a.at, a.dir)).join("")} className="dim-arrow" />
              <text x={tx} y={ty} fontSize={12} textAnchor="middle" dominantBaseline="middle">
                {d.text}
              </text>
            </g>
          );
        })}
      </g>
      <g className="relations" pointerEvents={interactive ? undefined : "none"}>
        {glyphs.map((g, n) => {
          const [x, y] = P(g.at);
          return (
            <g
              key={n}
              className={`glyph${selected !== null && (g.indices ?? [g.index]).includes(selected) ? " selected" : ""}`}
              data-testid={`glyph-${g.index}`}
              data-relation={constraints[g.index]?.type}
              data-count={g.indices?.length}
              {...handlers(g.index, false)}
            >
              <title>{`${RELATION[constraints[g.index].type].label}${g.indices ? ` ×${g.indices.length}` : ""}`}</title>
              <rect x={x - 8} y={y - 8} width={g.indices ? 28 : 16} height={16} rx={3} />
              <Icon name={g.icon} size={12} x={x - 6} y={y - 6} />
              {g.indices && (
                <text x={x + 13} y={y} fontSize={9} textAnchor="middle" dominantBaseline="central" className="glyph-count">
                  {g.indices.length}
                </text>
              )}
            </g>
          );
        })}
      </g>
    </>
  );
}

/**
 * The on-screen numeric input box, at the pointer: one field per value
 * (Tab and Shift+Tab move between them), Enter places the shape with them,
 * Esc goes back to the pointer. A value may be a calculation or carry units.
 */
function TypedBox({
  fields,
  state,
  at,
  problem,
  onChange,
  onCommit,
  onCancel,
}: {
  fields: TypedField[];
  state: { values: string[]; field: number };
  at: { x: number; y: number };
  problem: string | null;
  onChange(s: { values: string[]; field: number }): void;
  onCommit(): void;
  onCancel(): void;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  useLayoutEffect(() => {
    const el = refs.current[state.field];
    if (el && document.activeElement !== el) {
      el.focus();
      // The first key typed is in the field already: carry on after it.
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [state.field]);
  return (
    <div className="typed-box" style={{ left: at.x + 16, top: at.y + 16 }} data-testid="typed-box" onPointerDown={(e) => e.stopPropagation()}>
      {fields.map((f, i) => (
        <label key={f.key} className={i === state.field ? "active" : undefined}>
          <span>{f.label}</span>
          <input
            ref={(el) => {
              refs.current[i] = el;
            }}
            value={state.values[i] ?? ""}
            inputMode="decimal"
            aria-label={f.label}
            data-testid={`typed-${f.key}`}
            onFocus={() => i !== state.field && onChange({ ...state, field: i })}
            onChange={(e) => onChange({ ...state, values: state.values.map((v, j) => (j === i ? e.target.value : v)) })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                onCommit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              } else if (e.key === "Tab") {
                e.preventDefault();
                onChange({ ...state, field: (state.field + (e.shiftKey ? fields.length - 1 : 1)) % fields.length });
              }
            }}
          />
          <span className="unit">{f.unit}</span>
        </label>
      ))}
      {problem && <div className="expr-error">{problem}</div>}
    </div>
  );
}

function sameItem(a: SketchItem, b: SketchItem): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "entity") return a.id === (b as { id: string }).id;
  if (a.kind === "face") return a.index === (b as { index: number }).index;
  return a.ref === (b as { ref: string }).ref;
}

/** Grid spacing of 1, 2 or 5 x 10^n mm, at least ~12 px apart (scale: pixels per mm). */
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

/** The flat page fitted to the sketch and the model's edges: what the canvas shows before the 3D view has reported its camera. */
function fitFlat(entities: SketchEntity[], model: ModelView, size: { w: number; h: number }): PlaneMap {
  const xs: number[] = [0];
  const ys: number[] = [0];
  // A reference to an axis is drawn long enough to cross the whole part: it would zoom the view right out.
  for (const e of entities) if (!(e.ref && ("datum" in e.ref || "face" in e.ref) && e.type === "line")) for (const pl of spanOf(e)) for (const p of pl) xs.push(p[0]), ys.push(p[1]);
  for (const m of model.edges) for (const p of m.poly) xs.push(p[0]), ys.push(p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const w = Math.max(maxX - minX, 20);
  const h = Math.max(maxY - minY, 20);
  const empty = xs.length <= 1;
  const scale = empty ? Math.min(size.w, size.h) / 120 : Math.min(size.w / (w * 1.4), size.h / (h * 1.4));
  return flatMap(empty ? 0 : (minX + maxX) / 2, empty ? 0 : (minY + maxY) / 2, scale, size.w, size.h);
}
