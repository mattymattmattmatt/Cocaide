// The 2D sketch editor: an SVG in sketch-plane millimetres, y up.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Constraint, SketchEntity, Vec2 } from "../../doc/types";
import { entityPolylines } from "../../geom/profile";
import { dist2 } from "../../geom/vec";
import { inputPrefs, useCommands, wheelZoom } from "../input";
import { CLICKS, entityFromClicks, handlesOf, hitEntity, hitHandle, ID_PREFIX, nextEntityId, type SketchItem } from "./draft";

export type Tool = "select" | SketchEntity["type"];

interface Props {
  entities: SketchEntity[];
  constraints: Constraint[];
  /** Model edges projected onto the sketch plane, as 2D segment pairs. */
  reference: Float32Array;
  tool: Tool;
  construction: boolean;
  snapToGrid: boolean;
  selection: SketchItem[];
  onSelect(items: SketchItem[]): void;
  /** A new entity, plus coincidences between its points and the points it snapped to. */
  onCreate(entity: SketchEntity, coincident: [string, string][]): void;
  onDrag(phase: "move" | "end", handle: string, from: Vec2, to: Vec2): void;
  /** A right-click in place (not a right-drag pan): the entity under the cursor, if any. */
  onContext?(entityId: string | null, clientX: number, clientY: number): void;
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
  const { entities, constraints, reference, tool, construction, snapToGrid, selection } = props;
  const svg = useRef<SVGSVGElement>(null);
  const world = useRef<SVGGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState<ViewState | null>(null);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const [clicks, setClicks] = useState<{ p: Vec2; ref: string | null }[]>([]);
  /** A selection box being dragged: left to right selects what is inside it, right to left what it touches. */
  const [box, setBox] = useState<{ a: Vec2; b: Vec2 } | null>(null);
  const lastMiddle = useRef(0);
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
    setView(fitView(entities, reference, size));
    // fit once, on first layout
  }, [size]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving a tool or switching tools drops a half-placed entity.
  useEffect(() => setClicks([]), [tool]);

  const v = view ?? fitView(entities, reference, size);
  const unit = 1 / v.scale; // world size of one pixel
  const viewBox = `${v.cx - size.w / 2 / v.scale} ${-v.cy - size.h / 2 / v.scale} ${size.w / v.scale} ${size.h / v.scale}`;
  const step = gridStep(v.scale);

  const toWorld = (clientX: number, clientY: number): Vec2 => {
    const g = world.current!;
    const pt = svg.current!.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const w = pt.matrixTransform(g.getScreenCTM()!.inverse());
    return [w.x, w.y];
  };

  /** Snap to a point (with its ref) or else to the grid. */
  const snap = (p: Vec2, exclude?: string): { p: Vec2; ref: string | null } => {
    const h = hitHandle(entities, p, SNAP_PX * unit, { constraintOnly: true, exclude });
    if (h) return { p: h.point, ref: h.ref };
    if (snapToGrid) return { p: [roundTo(p[0], step), roundTo(p[1], step)], ref: null };
    return { p, ref: null };
  };

  const itemAt = (p: Vec2): SketchItem | null => {
    const h = hitHandle(entities, p, PICK_PX * unit);
    if (h) return h.constraint ? { kind: "point", ref: h.ref } : { kind: "entity", id: h.ref.split(".")[0] };
    const e = hitEntity(entities, p, PICK_PX * unit);
    return e ? { kind: "entity", id: e.id } : null;
  };

  const finishPlacement = (pts: { p: Vec2; ref: string | null }[]) => {
    if (tool === "select") return;
    const id = nextEntityId(entities, ID_PREFIX[tool]);
    const entity = entityFromClicks(tool, id, pts.map((c) => c.p), construction);
    if (!entity) return null;
    // Which clicked point became which point of the entity.
    const names: Record<SketchEntity["type"], (string | null)[]> = {
      line: ["start", "end"],
      rect: [null, null],
      circle: ["center", null],
      arc: ["center", "start", "end"],
      slot: ["center1", "center2", null],
    };
    const coincident: [string, string][] = [];
    pts.forEach((c, i) => {
      const name = names[tool][i];
      if (!c.ref || !name) return;
      const own = (entity as unknown as Record<string, Vec2>)[name];
      if (own && dist2(own, c.p) < 1e-9) coincident.push([`${id}.${name}`, c.ref]);
    });
    props.onCreate(entity, coincident);
    return entity;
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
        setView(fitView(entities, reference, size));
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
    if (handle && handle.ref !== "origin") {
      const item: SketchItem = handle.constraint ? { kind: "point", ref: handle.ref } : { kind: "entity", id: handle.ref.split(".")[0] };
      gesture.current = { kind: "drag", handle: handle.ref, from: handle.point, moved: false, item, additive };
      return;
    }
    const ent = hitEntity(entities, p, PICK_PX * unit);
    if (ent) {
      gesture.current = { kind: "drag", handle: `${ent.id}.body`, from: p, moved: false, item: { kind: "entity", id: ent.id }, additive };
      return;
    }
    gesture.current = { kind: "click", at: p, item: itemAt(p), additive, startClient: [e.clientX, e.clientY], startView: v };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toWorld(e.clientX, e.clientY);
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
      const handle = hitHandle(entities, p, PICK_PX * unit);
      const ent = handle && handle.ref !== "origin" ? handle.ref.split(".")[0] : (hitEntity(entities, p, PICK_PX * unit)?.id ?? null);
      props.onContext?.(ent, e.clientX, e.clientY);
      return;
    }
    if (g?.kind === "pan" || e.button !== 0 || tool === "select") return;
    // Drawing: one click per point.
    const s = snap(p);
    const next = [...clicks, s];
    if (next.length < CLICKS[tool]) {
      if (tool === "line" && next.length === 1) chainStart.current = s.ref;
      setClicks(next);
      return;
    }
    const made = finishPlacement(next);
    if (tool === "line" && made?.type === "line") {
      // Clicking the point the chain started from closes it; otherwise keep drawing from the end.
      const closes = s.ref !== null && s.ref === chainStart.current;
      if (!chainStart.current) chainStart.current = `${made.id}.start`;
      setClicks(closes ? [] : [{ p: made.end, ref: `${made.id}.end` }]);
      if (closes) chainStart.current = null;
      return;
    }
    setClicks([]);
  };
  /** First point of the line chain being drawn, so clicking it again closes the loop. */
  const chainStart = useRef<string | null>(null);

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
    "view.fit": () => setView(fitView(entities, reference, size)),
    "view.zoomIn": () => zoomBy(1.25),
    "view.zoomOut": () => zoomBy(0.8),
    "view.panLeft": () => panBy(-60, 0),
    "view.panRight": () => panBy(60, 0),
    "view.panUp": () => panBy(0, -60),
    "view.panDown": () => panBy(0, 60),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && clicks.length) {
        setClicks([]);
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [clicks.length]);

  const preview = useMemo(() => {
    if (tool === "select" || !cursor || clicks.length === 0) return null;
    const pts = [...clicks.map((c) => c.p), snap(cursor).p];
    if (pts.length < CLICKS[tool]) {
      if (tool === "arc" || tool === "slot") {
        // Show the first span while the third point is pending.
        return pts.length === 2 ? { kind: "line" as const, a: pts[0], b: pts[1] } : null;
      }
      return null;
    }
    const e = entityFromClicks(tool, "preview", pts, construction);
    return e ? { kind: "entity" as const, e } : null;
  }, [tool, cursor, clicks, construction]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedIds = new Set(selection.flatMap((s) => (s.kind === "entity" ? [s.id] : [])));
  const selectedPoints = new Set(selection.flatMap((s) => (s.kind === "point" ? [s.ref] : [])));
  const hoverItem = cursor && tool === "select" && !gesture.current ? itemAt(cursor) : null;
  const snapMark = cursor && tool !== "select" ? snap(cursor) : null;

  return (
    <svg
      ref={svg}
      className={`sketch-canvas tool-${tool}`}
      data-testid="sketch-canvas"
      viewBox={viewBox}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setCursor(null)}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
      onDoubleClick={() => {
        if (tool === "line") setClicks([]);
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
        <line x1={-1e6} y1={0} x2={1e6} y2={0} className="axis-x" vectorEffect="non-scaling-stroke" />
        <line x1={0} y1={-1e6} x2={0} y2={1e6} className="axis-y" vectorEffect="non-scaling-stroke" />
        <ReferenceLines segments={reference} />
        {entities.map((e) => (
          <EntityShape
            key={e.id}
            e={e}
            className={[
              "entity",
              e.construction ? "construction" : "",
              selectedIds.has(e.id) ? "selected" : "",
              hoverItem?.kind === "entity" && hoverItem.id === e.id ? "hover" : "",
            ].join(" ")}
          />
        ))}
        {preview?.kind === "entity" && <EntityShape e={preview.e} className="entity preview" />}
        {preview?.kind === "line" && (
          <line x1={preview.a[0]} y1={preview.a[1]} x2={preview.b[0]} y2={preview.b[1]} className="entity preview" vectorEffect="non-scaling-stroke" />
        )}
        {entities.flatMap((e) =>
          handlesOf(e).map((h) => (
            <circle
              key={h.ref}
              cx={h.point[0]}
              cy={h.point[1]}
              r={(h.constraint ? 3.5 : 2.5) * unit}
              className={[
                "handle",
                h.constraint ? "" : "corner",
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
        {snapMark?.ref && <circle cx={snapMark.p[0]} cy={snapMark.p[1]} r={7 * unit} className="snap" />}
      </g>
      <DimensionLabels entities={entities} constraints={constraints} unit={unit} />
    </svg>
  );
}

function EntityShape({ e, className }: { e: SketchEntity; className: string }) {
  const d = entityPolylines(e, Math.PI / 64)
    .map((pts) => pts.map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join(""))
    .join("");
  return <path d={d} className={className} vectorEffect="non-scaling-stroke" data-entity={e.id} />;
}

function ReferenceLines({ segments }: { segments: Float32Array }) {
  const d = useMemo(() => {
    const parts: string[] = [];
    for (let i = 0; i + 3 < segments.length; i += 4) parts.push(`M${segments[i]} ${segments[i + 1]}L${segments[i + 2]} ${segments[i + 3]}`);
    return parts.join("");
  }, [segments]);
  return <path d={d} className="reference" vectorEffect="non-scaling-stroke" />;
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

/** Values of dimensional constraints, drawn next to what they measure. Labels are not flipped. */
function DimensionLabels({ entities, constraints, unit }: { entities: SketchEntity[]; constraints: Constraint[]; unit: number }) {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const at = (ref: string): Vec2 | null => {
    if (ref === "origin") return [0, 0];
    const [id, name] = ref.split(".");
    const e = byId.get(id) as unknown as Record<string, Vec2> | undefined;
    return e?.[name] ?? null;
  };
  const labels: { p: Vec2; text: string }[] = [];
  for (const k of constraints) {
    if (!("value" in k)) continue;
    let p: Vec2 | null = null;
    const e = "entity" in k && k.entity ? byId.get(k.entity) : undefined;
    if (e?.type === "rect") {
      p = k.type === "distanceX" ? [e.center[0], e.center[1] + e.h / 2 + 12 * unit] : [e.center[0] + e.w / 2 + 14 * unit, e.center[1]];
    } else if (e?.type === "line") {
      p = [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2 + 10 * unit];
    } else if (e?.type === "slot") {
      p = [(e.center1[0] + e.center2[0]) / 2, (e.center1[1] + e.center2[1]) / 2 + e.width / 2 + 10 * unit];
    } else if (e?.type === "circle") {
      p = [e.center[0] + e.radius * 0.71 + 8 * unit, e.center[1] + e.radius * 0.71 + 8 * unit];
    } else if (e?.type === "arc") {
      p = [e.center[0], e.center[1]];
    } else if ("points" in k && k.points) {
      const a = at(k.points[0]);
      const b = at(k.points[1]);
      if (a && b) p = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 8 * unit];
    }
    if (p) labels.push({ p, text: `${k.type === "radius" ? "R" : ""}${Math.round(k.value * 1000) / 1000}` });
  }
  return (
    <g className="dimensions">
      {labels.map((l, i) => (
        <text key={i} x={l.p[0]} y={-l.p[1]} fontSize={12 * unit} textAnchor="middle" dominantBaseline="middle">
          {l.text}
        </text>
      ))}
    </g>
  );
}

function sameItem(a: SketchItem, b: SketchItem): boolean {
  return a.kind === b.kind && (a.kind === "entity" ? a.id === (b as { id: string }).id : a.ref === (b as { ref: string }).ref);
}

/** Grid spacing of 1, 2 or 5 x 10^n mm, at least ~12 px apart. */
export function gridStep(scale: number): number {
  const minWorld = 12 / scale;
  const pow = Math.pow(10, Math.floor(Math.log10(minWorld)));
  for (const m of [1, 2, 5, 10]) if (m * pow >= minWorld) return m * pow;
  return 10 * pow;
}

function roundTo(x: number, step: number): number {
  const r = Math.round(x / step) * step;
  return Math.round(r * 1e9) / 1e9;
}

function fitView(entities: SketchEntity[], reference: Float32Array, size: { w: number; h: number }): ViewState {
  const xs: number[] = [0];
  const ys: number[] = [0];
  for (const e of entities) for (const pl of entityPolylines(e)) for (const p of pl) xs.push(p[0]), ys.push(p[1]);
  for (let i = 0; i + 1 < reference.length; i += 2) xs.push(reference[i]), ys.push(reference[i + 1]);
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
      const lines = entityPolylines(e);
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
