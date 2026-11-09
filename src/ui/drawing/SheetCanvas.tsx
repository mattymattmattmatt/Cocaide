// The sheet in the drawing workspace (Phase Q wave Q2B): the same SVG that
// Export SVG writes, on a desk with the paper's shadow, crisp at any zoom (a
// view box, never a bitmap). The wheel zooms to the cursor, the middle
// button or Space+drag pans, F fits, a drag on empty paper selects what lies
// inside it. The pointer finds the views' geometry the way the 3D view does:
// edges, vertices, circle centres, quadrants and midpoints light up with a
// snap glyph and a tooltip naming what they are. Views drag along the line
// they share with their parent (the views made from them follow), snap to
// the others and keep off the title block and tables (Alt: exactly where
// dropped); annotations drag and their grips move one thing. A tool's
// session takes the pointer instead, and draws its rubber band over the sheet.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Command } from "../../doc/commands";
import type { Drawing, DrawingSheet, Vec2 } from "../../doc/types";
import type { ComposedSheet } from "../../drafting/compose";
import type { Box, Prim } from "../../drafting/sheet";
import { SHEET_FONT, sheetSVG } from "../../drafting/svg";
import { wheelZoom } from "../input";
import { alignmentOf, constrain, followers, keepOff, pulledOff, snapToViews, tenth, type Guide } from "./align";
import { snapAt, type SnapIndex, type SnapKind, type SnapTarget } from "./snap";
import { annotationKind, type Grip } from "./tools/kinds";
import { alignedCoordinate } from "./tools/geometry";
import type { DrawingSession, OverlayShape, SheetHit, SheetPointer, Tone } from "./tools/types";
import { areaBox, blendBox, fitBox, mmPerPixel, panBy, reshape, toUser, zoomAt, zoomPercent, type ViewBox } from "./zoom";

export interface SheetStatus {
  at: Vec2 | null;
  snap: string | null;
  zoom: number;
}

export interface SheetCanvasProps {
  sheet: ComposedSheet;
  sheetDoc: DrawingSheet;
  drawing: Drawing;
  selection: string[];
  failed: string[];
  snap: SnapIndex | null;
  session: DrawingSession | null;
  /** Bumped when the session changed (its overlay redraws). */
  tick: number;
  showGrid: boolean;
  /** Bumped to fit the sheet, or to zoom to an area by the next drag. */
  fitToken: number;
  zoomAreaToken: number;
  onSelect(ids: string[], add: boolean): void;
  onContext(hit: SheetHit | null, x: number, y: number, at?: Vec2): void;
  /** Several commands as one undo step; the error when refused. */
  onCommands(cmds: Command[]): string | null;
  onNotice(text: string, kind?: "info" | "error"): void;
  onStatus(s: SheetStatus): void;
  onDouble(hit: SheetHit | null, at: Vec2): void;
  /** Sheet mm per pixel now, for the tools. */
  scaleRef: { current: number };
}

/** The sheet's prims grouped by owner are drawn as `g[data-id]`: what a move preview translates. */
const groupSel = (id: string) => `g[data-id="${CSS.escape(id)}"]`;

const TONE: Record<Tone, string> = { accent: "var(--sheet-accent)", preview: "var(--sheet-preview)", warn: "var(--bad)", muted: "var(--muted)" };

/** Pixels: how near the pointer finds an edge, a point, a grip. */
const SNAP_PX = 7;
const GRIP_PX = 7;

interface Drag {
  kind: "pan" | "box" | "area" | "item" | "grip" | "click";
  start: Vec2;
  client: Vec2;
  moved: boolean;
  hit?: SheetHit | null;
  /** What the drag moves: the hit, or the view of an annotation that follows its geometry (a centre mark). */
  target?: SheetHit | null;
  grip?: Grip;
  /** The ids moving with the item, for the preview. */
  moving?: string[];
  delta?: Vec2;
  guides?: Guide[];
  refused?: boolean;
  additive?: boolean;
}

export function SheetCanvas(props: SheetCanvasProps) {
  const { sheet, sheetDoc, selection, failed, snap, session, showGrid } = props;
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<[number, number]>([0, 0]);
  const [box, setBox] = useState<ViewBox>([0, 0, sheet.width, sheet.height]);
  const boxRef = useRef(box);
  boxRef.current = box;
  const [hover, setHover] = useState<SheetPointer | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const space = useRef(false);
  const areaArmed = useRef(false);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const H = sheet.height;
  const automated = typeof location !== "undefined" && new URLSearchParams(location.search).has("e2e");

  const svg = useMemo(() => sheetSVG(sheet, { fit: true, selected: selection, failed }).replace('<rect width="', '<rect class="paper" width="'), [sheet, selection, failed]);

  // The host's size: the view box keeps its shape.
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize([el.clientWidth, el.clientHeight]));
    ro.observe(el);
    setSize([el.clientWidth, el.clientHeight]);
    return () => ro.disconnect();
  }, []);
  const fitted = useRef<string>("");
  const glide = useRef<number | null>(null);
  const goTo = useCallback(
    (next: ViewBox, smooth: boolean) => {
      if (glide.current) cancelAnimationFrame(glide.current);
      if (!smooth || automated || matchMedia("(prefers-reduced-motion: reduce)").matches) return setBox(next);
      const from = boxRef.current;
      const t0 = performance.now();
      const step = (t: number) => {
        const k = Math.min(1, (t - t0) / 220);
        setBox(blendBox(from, next, k));
        glide.current = k < 1 ? requestAnimationFrame(step) : null;
      };
      glide.current = requestAnimationFrame(step);
    },
    [automated],
  );
  // Fit the sheet when it is first shown at this size, and on F.
  useLayoutEffect(() => {
    if (!size[0] || !size[1]) return;
    const key = `${sheet.id}:${sheet.width}x${sheet.height}`;
    if (fitted.current === key) setBox((b) => reshape(b, size[0], size[1]));
    else {
      fitted.current = key;
      setBox(fitBox(sheet.width, sheet.height, size[0], size[1]));
    }
  }, [size, sheet.id, sheet.width, sheet.height]);
  useEffect(() => {
    if (props.fitToken && size[0]) goTo(fitBox(sheet.width, sheet.height, size[0], size[1]), true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitToken]);
  useEffect(() => {
    if (props.zoomAreaToken) areaArmed.current = true;
  }, [props.zoomAreaToken]);
  props.scaleRef.current = mmPerPixel(box, size[0] || 1);

  // The view box on the sheet's SVG (set by hand: React leaves the SVG string alone).
  useLayoutEffect(() => {
    const el = host.current?.querySelector("svg.sheet-svg, .sheet-paper svg");
    if (el) el.setAttribute("viewBox", box.map((v) => String(Math.round(v * 1000) / 1000)).join(" "));
  }, [box, svg]);

  /** A client point on the sheet, mm, y up. */
  const toSheet = (clientX: number, clientY: number): Vec2 | null => {
    const el = host.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const [ux, uy] = toUser(boxRef.current, el.clientWidth, clientX - r.left, clientY - r.top);
    return [ux, H - uy];
  };
  /** A sheet point as client pixels. */
  const toClient = (p: Vec2): [number, number] => {
    const el = host.current!;
    const r = el.getBoundingClientRect();
    const k = el.clientWidth / boxRef.current[2];
    return [r.left + (p[0] - boxRef.current[0]) * k, r.top + (H - p[1] - boxRef.current[1]) * k];
  };

  // The automation hook: sheet mm to page pixels, and what the pointer would find there.
  useEffect(() => {
    if (!automated) return;
    (window as unknown as { __cocaideSheet?: unknown }).__cocaideSheet = {
      toScreen: (x: number, y: number) => toClient([x, y]),
      box: () => boxRef.current,
      view: (id: string) => {
        const v = sheet.views.find((x) => x.id === id);
        return v ? { centre: v.centre, box: v.box, scale: v.scale, origin: v.origin } : null;
      },
      snap: (x: number, y: number) => (snap ? snapAt(snap, [x, y], 2) : null),
      targets: (view: string, kind?: string) => (snap?.targets ?? []).filter((t) => t.view === view && (!kind || t.kind === kind)).map((t) => ({ ref: t.ref, kind: t.kind, at: t.at, feature: t.feature, label: t.label, visible: t.visible, circle: t.circle, pts: t.pts, body: t.body })),
      table: (id: string) => sheet.blocks.find((b) => b.id === id)?.box ?? null,
      titleBlock: () => sheet.titleBlock,
    };
  });

  // ------------------------------------------------------------ what is under the pointer

  const within = (b: Box | null | undefined, p: Vec2, pad: number) => !!b && p[0] >= b.min[0] - pad && p[0] <= b.max[0] + pad && p[1] >= b.min[1] - pad && p[1] <= b.max[1] + pad;
  const area = (b: Box) => (b.max[0] - b.min[0] + 2) * (b.max[1] - b.min[1] + 2);
  const tableIds = useMemo(() => new Set((sheetDoc.tables ?? []).map((t) => t.id)), [sheetDoc]);

  const hitAt = (p: Vec2): SheetHit | null => {
    const pad = 3 * props.scaleRef.current;
    const anns = sheet.annotations.filter((a) => a.box && within(a.box, p, pad)).sort((a, b) => area(a.box!) - area(b.box!));
    if (anns.length) return { kind: tableIds.has(anns[0].id) ? "table" : "annotation", id: anns[0].id };
    const block = sheet.blocks.find((b) => within(b.box, p, 0));
    if (block) return { kind: tableIds.has(block.id) ? "table" : "annotation", id: block.id };
    const views = sheet.views.filter((v) => within(v.box, p, 2)).sort((a, b) => area(a.box!) - area(b.box!));
    if (views.length) return { kind: "view", id: views[0].id };
    if (within(sheet.titleBlock, p, 0)) return { kind: "titleBlock", id: "titleBlock" };
    return null;
  };
  const viewAt = (p: Vec2): string | null => sheet.views.filter((v) => within(v.box, p, 2)).sort((a, b) => area(a.box!) - area(b.box!))[0]?.id ?? null;

  const hiddenShown = (view: string) => {
    const d = sheetDoc.views.find((v) => v.id === view)?.display;
    return d === "hidden" || d === "visible";
  };
  const IDLE_SNAPS: SnapKind[] = ["vertex", "centre", "quadrant", "midpoint", "edge", "circle", "arc"];

  const pointer = (e: { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): SheetPointer | null => {
    const raw = toSheet(e.clientX, e.clientY);
    if (!raw) return null;
    const want = session ? (session.snaps?.() ?? null) : { kinds: IDLE_SNAPS };
    let s: SnapTarget | null = null;
    if (want && snap && want.kinds.length) s = snapAt(snap, raw, SNAP_PX * props.scaleRef.current, { kinds: want.kinds, view: want.view ?? undefined, hidden: hiddenShown });
    return { raw, at: s ? s.at : raw, snap: s, view: viewAt(raw), hit: hitAt(raw), shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
  };

  // ------------------------------------------------------------ grips of the one selected annotation

  const grips = useMemo((): { id: string; grip: Grip }[] => {
    if (selection.length !== 1 || session) return [];
    const a = sheetDoc.annotations.find((x) => x.id === selection[0]) as Record<string, unknown> | undefined;
    const k = a && annotationKind(String(a.type));
    if (!a || !k?.grips) return [];
    const said = sheet.annotations.find((x) => x.id === a.id);
    return k.grips(a, { sheet, said }).map((grip) => ({ id: String(a.id), grip }));
  }, [selection, sheetDoc, sheet, session]);

  // ------------------------------------------------------------ dragging views and annotations

  /** What moves with a view: the views lined up with it, and every annotation of each. */
  const movingWith = (id: string): string[] => {
    const views = [id, ...followers(id, sheetDoc.views, sheetDoc.projection)];
    const anns = sheetDoc.annotations.filter((a) => "view" in a && !!a.view && views.includes(a.view)).map((a) => a.id);
    return [...views, ...anns];
  };

  /** The move a view's drag makes, with alignment, snapping and keeping clear. */
  const viewMove = (id: string, raw: Vec2, alt: boolean): { delta: Vec2; guides: Guide[]; refused: boolean } => {
    const cv = sheet.views.find((v) => v.id === id);
    const view = sheetDoc.views.find((v) => v.id === id);
    if (!cv?.box || !view) return { delta: raw, guides: [], refused: false };
    const al = alignmentOf(view, sheetDoc.views, sheetDoc.projection);
    const refused = pulledOff(raw, al, 3 * props.scaleRef.current);
    let delta = constrain(raw, al);
    // Lined up exactly, whatever it was before: across, the parent's line.
    const pcv = al.parent ? sheet.views.find((v) => v.id === al.parent) : undefined;
    if (al.side && pcv) {
      const across = alignedCoordinate(cv, pcv, al.side);
      if (across) delta[across.axis] = across.value - cv.centre[across.axis];
    }
    if (alt) return { delta, guides: [], refused };
    const moving = new Set(movingWith(id));
    const others = sheet.views.filter((v) => !moving.has(v.id) && v.box).map((v) => ({ id: v.id, box: v.box! }));
    const snapped = snapToViews(cv.box, delta, others, 4 * props.scaleRef.current, al.axis);
    delta = snapped.delta;
    const blocked = [sheet.titleBlock, ...(sheet.revisionBlock ? [sheet.revisionBlock] : []), ...sheet.blocks.map((b) => b.box)];
    delta = keepOff(cv.box, delta, blocked, sheet.frame, 2, al.axis);
    return { delta, guides: snapped.guides, refused };
  };

  const dropView = (id: string, delta: Vec2) => {
    if (Math.hypot(delta[0], delta[1]) < 1e-6) return;
    const cmds: Command[] = [];
    for (const v of [id, ...followers(id, sheetDoc.views, sheetDoc.projection)]) {
      const cv = sheet.views.find((x) => x.id === v);
      if (!cv) continue;
      cmds.push({ type: "moveView", id: v, at: [tenth(cv.centre[0] + delta[0]), tenth(cv.centre[1] + delta[1])] });
    }
    props.onCommands(cmds);
  };

  const dropAnnotation = (id: string, delta: Vec2, grip?: Grip) => {
    const a = sheetDoc.annotations.find((x) => x.id === id) as Record<string, unknown> | undefined;
    const k = a && annotationKind(String(a.type));
    if (!a || !k) return;
    const said = sheet.annotations.find((x) => x.id === id);
    const patch = grip ? k.dragGrip?.(a, grip, delta, { sheet, said }) : k.move?.(a, delta, { sheet, said });
    if (!patch) return props.onNotice(`${id} follows what it is attached to: it doesn't move on its own.`);
    const next: Record<string, unknown> = { ...a, ...patch };
    for (const [key, v] of Object.entries(next)) if (v === null || v === undefined) delete next[key];
    delete next.id;
    props.onCommands([{ type: "setAnnotation", id, annotation: next }]);
  };

  const dropTable = (id: string, delta: Vec2) => {
    const t = (sheetDoc.tables ?? []).find((x) => x.id === id);
    const b = sheet.blocks.find((x) => x.id === id)?.box;
    if (!t || !b) return;
    const { id: _id, ...rest } = t;
    void _id;
    props.onCommands([{ type: "setTable", id, table: { ...rest, anchor: { at: [tenth(b.min[0] + delta[0]), tenth(b.max[1] + delta[1])] } } }]);
  };

  // ------------------------------------------------------------ pointer

  const onPointerDown = (e: React.PointerEvent) => {
    host.current?.focus({ preventScroll: true });
    const p = toSheet(e.clientX, e.clientY);
    if (!p) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const base = { start: p, client: [e.clientX, e.clientY] as Vec2, moved: false };
    if (e.button === 1 || (e.button === 0 && space.current)) {
      e.preventDefault();
      return set({ ...base, kind: "pan" });
    }
    if (e.button !== 0) return;
    if (areaArmed.current) return set({ ...base, kind: "area" });
    if (session) return set({ ...base, kind: "click" });
    const pad = GRIP_PX * props.scaleRef.current;
    const g = grips.find((x) => Math.hypot(x.grip.at[0] - p[0], x.grip.at[1] - p[1]) <= pad);
    if (g) return set({ ...base, kind: "grip", hit: { kind: "annotation", id: g.id }, grip: g.grip, moving: [g.id] });
    const hit = hitAt(p);
    if (!hit || hit.kind === "titleBlock") return set({ ...base, kind: "box", hit, additive: e.shiftKey || e.ctrlKey || e.metaKey });
    // An annotation that follows its geometry (a centre mark, a centre line) drags its view.
    let target: SheetHit = hit;
    if (hit.kind === "annotation") {
      const a = sheetDoc.annotations.find((x) => x.id === hit.id) as { type: string; view?: string } | undefined;
      if (a?.view && !annotationKind(a.type)?.move) target = { kind: "view", id: a.view };
    }
    const moving = target.kind === "view" ? movingWith(target.id) : [target.id];
    set({ ...base, kind: "item", hit, target, moving, additive: e.shiftKey || e.ctrlKey || e.metaKey });
  };
  const set = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (d?.kind === "pan") {
      const el = host.current!;
      setBox((b) => panBy(b, e.clientX - d.client[0], e.clientY - d.client[1], el.clientWidth));
      d.client = [e.clientX, e.clientY];
      d.moved = true;
      return;
    }
    const pt = pointer(e);
    if (!pt) return;
    setHover(pt);
    const r = host.current!.getBoundingClientRect();
    setTip(pt.snap && !d?.moved ? { x: e.clientX - r.left, y: e.clientY - r.top, text: pt.snap.label } : null);
    props.onStatus({ at: pt.at, snap: pt.snap?.label ?? null, zoom: zoomPercent(boxRef.current, size[0] || 1) });
    if (session && (!d || d.kind === "click")) session.move?.(pt);
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.client[0], e.clientY - d.client[1]) < 4) return;
    d.moved = true;
    const raw: Vec2 = [pt.raw[0] - d.start[0], pt.raw[1] - d.start[1]];
    if (d.kind === "item" && d.target?.kind === "view") {
      if ((sheetDoc.views.find((v) => v.id === d.target!.id) as { locked?: boolean } | undefined)?.locked) {
        d.delta = [0, 0];
        d.refused = true;
        return setDrag({ ...d });
      }
      const m = viewMove(d.target.id, raw, e.altKey);
      d.delta = m.delta;
      d.guides = m.guides;
      d.refused = m.refused;
    } else if (d.kind === "grip" && d.grip?.along) {
      const a = d.grip.along;
      const t = raw[0] * a[0] + raw[1] * a[1];
      d.delta = [a[0] * t, a[1] * t];
    } else d.delta = raw;
    setDrag({ ...d });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    set(null);
    if (!d) return;
    const pt = pointer(e);
    if (d.kind === "pan") return;
    if (d.kind === "area") {
      areaArmed.current = false;
      if (!pt || !d.moved) return;
      const nb = areaBox([d.start[0], H - d.start[1]], [pt.raw[0], H - pt.raw[1]], size[0], size[1]);
      if (nb) goTo(nb, true);
      return;
    }
    if (d.kind === "click") {
      if (pt && session && !d.moved) session.click?.(pt);
      return;
    }
    // A grip that acts on a click (an arrowhead: the arrows flip).
    if (d.kind === "grip" && !d.moved && d.grip?.click && d.hit) return dropAnnotation(d.hit.id, [0, 0], d.grip);
    if (!d.moved) {
      if (d.kind === "box" && !d.hit) return props.onSelect([], d.additive ?? false);
      if (d.hit) props.onSelect(d.hit.kind === "titleBlock" ? [] : [d.hit.id], d.additive ?? false);
      return;
    }
    if (d.kind === "box" && pt) {
      // Everything wholly inside the box.
      const lo: Vec2 = [Math.min(d.start[0], pt.raw[0]), Math.min(d.start[1], pt.raw[1])];
      const hi: Vec2 = [Math.max(d.start[0], pt.raw[0]), Math.max(d.start[1], pt.raw[1])];
      const inside = (b: Box | null) => !!b && b.min[0] >= lo[0] && b.min[1] >= lo[1] && b.max[0] <= hi[0] && b.max[1] <= hi[1];
      const ids = [...sheet.views.filter((v) => inside(v.box)).map((v) => v.id), ...sheet.annotations.filter((a) => inside(a.box)).map((a) => a.id), ...sheet.blocks.filter((b) => inside(b.box) && !sheet.annotations.some((a) => a.id === b.id)).map((b) => b.id)];
      return props.onSelect(ids, d.additive ?? false);
    }
    const delta = d.delta ?? [0, 0];
    const t = d.target ?? d.hit;
    if (!t) return;
    if (t.kind === "view") {
      const v = sheetDoc.views.find((x) => x.id === t.id);
      if ((v as { locked?: boolean } | undefined)?.locked) return props.onNotice(`${t.id} is locked in place: unlock it in its menu to move it.`);
      if (d.refused && Math.hypot(delta[0], delta[1]) < 1e-6) {
        return props.onNotice(`${t.id} stays lined up with ${v?.parent ?? "its parent"}: it slides ${alignmentOf(v!, sheetDoc.views, sheetDoc.projection).axis === 0 ? "left and right" : "up and down"} only. Break alignment in its menu to place it freely.`);
      }
      return dropView(t.id, delta);
    }
    if (t.kind === "table") return dropTable(t.id, delta);
    return dropAnnotation(t.id, delta, d.kind === "grip" ? d.grip : undefined);
  };

  const onWheel = (e: React.WheelEvent) => {
    const p = toSheet(e.clientX, e.clientY);
    if (!p) return;
    const k = wheelZoom(e);
    setBox((b) => zoomAt(b, [p[0], H - p[1]], k, sheet.width));
  };

  // Space held: the next drag pans.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target as HTMLElement).closest("input, textarea, select")) space.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") space.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // ------------------------------------------------------------ previews of a move: the groups translated

  const moved = useMemo((): Map<string, Vec2> => {
    const m = new Map<string, Vec2>();
    if (drag?.moved && drag.delta && drag.moving && drag.kind !== "box") for (const id of drag.moving) m.set(id, drag.delta);
    for (const s of session?.overlay() ?? []) if (s.k === "move") m.set(s.id, s.delta);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, session, props.tick, hover]);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    for (const g of el.querySelectorAll<SVGGElement>("g[data-moved]")) {
      if (!moved.has(g.dataset.id ?? "")) {
        g.removeAttribute("transform");
        g.removeAttribute("data-moved");
      }
    }
    for (const [id, d] of moved) {
      for (const g of el.querySelectorAll<SVGGElement>(groupSel(id))) {
        g.setAttribute("transform", `translate(${d[0]} ${-d[1]})`);
        g.setAttribute("data-moved", "1");
      }
    }
  }, [moved, svg]);

  // ------------------------------------------------------------ the overlay

  const k = props.scaleRef.current;
  const pt = (p: Vec2) => `${p[0]},${H - p[1]}`;
  const shapes: ReactNode[] = [];
  const tone = (t?: Tone) => TONE[t ?? "accent"];
  const draw = (s: OverlayShape, i: number | string) => {
    if (s.k === "move") return;
    if (s.k === "prims") return shapes.push(<PrimsPreview key={i} prims={s.prims} colour={tone(s.tone ?? "preview")} H={H} />);
    if (s.k === "line") {
      const props2 = { points: s.pts.map(pt).join(" "), fill: "none", stroke: tone(s.tone), strokeWidth: (s.w ?? 1.5) * k, strokeDasharray: s.dash ? `${6 * k} ${4 * k}` : undefined };
      shapes.push(s.closed ? <polygon key={i} {...props2} /> : <polyline key={i} {...props2} />);
    } else if (s.k === "circle") shapes.push(<circle key={i} cx={s.c[0]} cy={H - s.c[1]} r={s.r} fill="none" stroke={tone(s.tone)} strokeWidth={(s.w ?? 1.5) * k} strokeDasharray={s.dash ? `${6 * k} ${4 * k}` : undefined} />);
    else if (s.k === "rect") shapes.push(<rect key={i} x={s.box.min[0]} y={H - s.box.max[1]} width={s.box.max[0] - s.box.min[0]} height={s.box.max[1] - s.box.min[1]} fill={s.fill ? "color-mix(in srgb, var(--sheet-accent) 10%, transparent)" : "none"} stroke={tone(s.tone)} strokeWidth={1.2 * k} strokeDasharray={s.dash ? `${5 * k} ${4 * k}` : undefined} />);
    else if (s.k === "dot") shapes.push(<circle key={i} cx={s.at[0]} cy={H - s.at[1]} r={3.5 * k} fill={tone(s.tone)} stroke="#fff" strokeWidth={1 * k} />);
    else if (s.k === "label")
      shapes.push(
        <text key={i} x={s.at[0]} y={H - s.at[1]} fontSize={12 * k} textAnchor="middle" fill={tone(s.tone)} className="overlay-label" strokeWidth={3 * k}>
          {s.text}
        </text>,
      );
  };
  // Hovered geometry, with its snap glyph.
  const snapNow = drag?.moved ? null : hover?.snap;
  if (snapNow) {
    if (snapNow.circle) draw({ k: "circle", c: snapNow.circle.c, r: snapNow.circle.r, tone: "accent", w: 2.5 }, "hc");
    else if (snapNow.pts && (snapNow.kind === "edge" || snapNow.kind === "arc")) snapNow.pts.forEach((l, i) => draw({ k: "line", pts: l, tone: "accent", w: 2.5 }, `he${i}`));
    shapes.push(<SnapGlyph key="glyph" kind={snapNow.kind} at={[snapNow.at[0], H - snapNow.at[1]]} k={k} />);
  }
  // A hovered view (or annotation), outlined; the views a session lets you pick.
  const picks = session?.picksViews?.();
  const hv = !drag && hover?.hit && !snapNow ? hover.hit : null;
  const outline = (b: Box | null | undefined, key: string, strong = false) => b && shapes.push(<rect key={key} x={b.min[0] - 1.5} y={H - b.max[1] - 1.5} width={b.max[0] - b.min[0] + 3} height={b.max[1] - b.min[1] + 3} rx={1.5} fill={strong ? "color-mix(in srgb, var(--sheet-accent) 6%, transparent)" : "none"} stroke="var(--sheet-accent)" strokeOpacity={strong ? 0.9 : 0.45} strokeWidth={1.2 * k} strokeDasharray={`${4 * k} ${3 * k}`} />);
  if (picks) {
    const id = hover?.view;
    if (id && (picks === true || picks.includes(id))) outline(sheet.views.find((v) => v.id === id)?.box, "pick", true);
  } else if (hv && !session) {
    const b = hv.kind === "view" ? sheet.views.find((v) => v.id === hv.id)?.box : hv.kind === "titleBlock" ? sheet.titleBlock : (sheet.annotations.find((a) => a.id === hv.id)?.box ?? sheet.blocks.find((x) => x.id === hv.id)?.box);
    outline(b, "hover");
  }
  // The selection's views and tables, framed (annotations are drawn in the accent by the SVG).
  for (const id of selection) {
    const v = sheet.views.find((x) => x.id === id);
    const b = v?.box ?? (tableIds.has(id) ? sheet.blocks.find((x) => x.id === id)?.box : undefined);
    if (b) {
      const d = moved.get(id) ?? [0, 0];
      shapes.push(<rect key={`sel-${id}`} x={b.min[0] - 2 + d[0]} y={H - b.max[1] - 2 - d[1]} width={b.max[0] - b.min[0] + 4} height={b.max[1] - b.min[1] + 4} rx={2} fill="none" stroke="var(--sheet-accent)" strokeWidth={1.6 * k} />);
    }
  }
  for (const { grip } of grips) {
    const d = drag?.kind === "grip" && drag.delta ? drag.delta : [0, 0];
    shapes.push(<rect key={`grip-${grip.id}`} x={grip.at[0] + d[0] - 4 * k} y={H - grip.at[1] - d[1] - 4 * k} width={8 * k} height={8 * k} fill="#fff" stroke="var(--sheet-accent)" strokeWidth={1.5 * k} className="grip" />);
  }
  // Snap guides while a view drags; the box of a box selection or zoom to area.
  for (const g of drag?.guides ?? []) {
    shapes.push(g.axis === 0 ? <line key={`g${g.axis}${g.at}`} x1={g.at} x2={g.at} y1={0} y2={H} stroke="var(--sheet-preview)" strokeWidth={k} strokeDasharray={`${3 * k} ${3 * k}`} /> : <line key={`g${g.axis}${g.at}`} y1={H - g.at} y2={H - g.at} x1={0} x2={sheet.width} stroke="var(--sheet-preview)" strokeWidth={k} strokeDasharray={`${3 * k} ${3 * k}`} />);
  }
  if (drag?.moved && (drag.kind === "box" || drag.kind === "area") && hover) {
    const a = drag.start;
    const b = hover.raw;
    shapes.push(<rect key="band" x={Math.min(a[0], b[0])} y={H - Math.max(a[1], b[1])} width={Math.abs(b[0] - a[0])} height={Math.abs(b[1] - a[1])} fill="color-mix(in srgb, var(--sheet-accent) 8%, transparent)" stroke="var(--sheet-accent)" strokeWidth={k} strokeDasharray={drag.kind === "area" ? `${4 * k} ${3 * k}` : undefined} data-testid="sheet-band" />);
  }
  (session?.overlay() ?? []).forEach((s, i) => draw(s, `s${i}`));

  const gridLines = useMemo(() => {
    if (!showGrid) return null;
    const out: ReactNode[] = [];
    for (let x = 0; x <= sheet.width; x += 10) out.push(<line key={`x${x}`} x1={x} x2={x} y1={0} y2={H} className={x % 50 === 0 ? "major" : ""} />);
    for (let y = 0; y <= H; y += 10) out.push(<line key={`y${y}`} y1={H - y} y2={H - y} x1={0} x2={sheet.width} className={y % 50 === 0 ? "major" : ""} />);
    return out;
  }, [showGrid, sheet.width, H]);

  const viewBox = box.map((v) => String(Math.round(v * 1000) / 1000)).join(" ");
  const cursor = drag?.kind === "pan" ? "grabbing" : session ? "crosshair" : drag?.kind === "item" && drag.moved ? "move" : hover?.hit && !hover.snap ? "pointer" : "default";

  return (
    <div
      ref={host}
      className={`sheet-canvas${session ? " in-session" : ""}`}
      data-testid="sheet"
      data-zoom={zoomPercent(box, size[0] || 1)}
      tabIndex={0}
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        setHover(null);
        setTip(null);
        props.onStatus({ at: null, snap: null, zoom: zoomPercent(boxRef.current, size[0] || 1) });
      }}
      onWheel={onWheel}
      onAuxClick={(e) => e.preventDefault()}
      onDoubleClick={(e) => {
        const p = pointer(e);
        if (!p) return;
        if (session) return session.doubleClick?.(p);
        if (!p.hit) return goTo(fitBox(sheet.width, sheet.height, size[0], size[1]), true);
        props.onDouble(p.hit, p.raw);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const p = toSheet(e.clientX, e.clientY);
        props.onContext(p ? hitAt(p) : null, e.clientX, e.clientY, p ?? undefined);
      }}
    >
      {showGrid && (
        <svg className="sheet-grid" viewBox={viewBox} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          <g strokeWidth={k}>{gridLines}</g>
        </svg>
      )}
      <div className="sheet-paper" dangerouslySetInnerHTML={{ __html: svg }} />
      <svg className="sheet-overlay" viewBox={viewBox} preserveAspectRatio="xMidYMid meet" aria-hidden="true" data-testid="sheet-overlay">
        {shapes}
      </svg>
      {tip && (
        <div className="sheet-tip" style={{ left: tip.x + 14, top: tip.y + 16 }} data-testid="sheet-tip" role="tooltip">
          {tip.text}
        </div>
      )}
      {session && (
        <div className="session-prompt sheet-prompt" data-testid="sheet-prompt" role="status">
          <span>{session.prompt()}</span>
          <span className="session-keys">Enter OK · Esc cancel</span>
        </div>
      )}
      {drag?.refused && drag.moved && hover && <div className="sheet-tip refused" style={{ left: toClient(hover.raw)[0] - host.current!.getBoundingClientRect().left + 14, top: toClient(hover.raw)[1] - host.current!.getBoundingClientRect().top + 16 }}>Stays lined up with its parent</div>}
    </div>
  );
}

/** A tool's annotation as the engine lays it out, drawn in the preview colour at its true line weights and text. */
function PrimsPreview({ prims, colour, H }: { prims: Prim[]; colour: string; H: number }) {
  const y = (v: number) => H - v;
  return (
    <g className="prims-preview" color={colour} stroke="currentColor" fill="none" strokeLinecap="round" strokeLinejoin="round" data-testid="sheet-preview">
      {prims.map((p, i) => {
        if (p.k === "line") {
          const pts = p.pts.map((q) => `${q[0]},${y(q[1])}`).join(" ");
          const common = { strokeWidth: Math.max(p.w, 0.18), strokeDasharray: p.dash?.join(" "), fill: p.fill ? "currentColor" : "none" };
          return p.closed || p.fill ? <polygon key={i} points={pts} {...common} /> : <polyline key={i} points={pts} {...common} />;
        }
        if (p.k === "circle") return <circle key={i} cx={p.c[0]} cy={y(p.c[1])} r={p.r} strokeWidth={Math.max(p.w, 0.18)} fill={p.fill ? "currentColor" : "none"} />;
        if (p.k === "area") return null;
        return (
          <text key={i} x={p.at[0]} y={y(p.at[1])} fontSize={p.size} textAnchor={p.anchor} fontWeight={p.bold ? "bold" : undefined} fontStyle={p.italic ? "italic" : undefined} transform={p.angle ? `rotate(${-p.angle} ${p.at[0]} ${y(p.at[1])})` : undefined} fill="currentColor" stroke="none" fontFamily={SHEET_FONT}>
            {p.text}
          </text>
        );
      })}
    </g>
  );
}

/** The glyph of what the pointer snaps to: a square on a vertex, a cross in a centre, a diamond on a quadrant, a triangle on a midpoint, a ring on an edge. Pixels, at any zoom. */
function SnapGlyph({ kind, at, k }: { kind: SnapKind; at: Vec2; k: number }) {
  const s = 5 * k;
  const common = { fill: "#fff", stroke: "var(--sheet-accent)", strokeWidth: 1.6 * k };
  const [x, y] = at;
  if (kind === "vertex") return <rect x={x - s} y={y - s} width={2 * s} height={2 * s} {...common} data-snap="vertex" />;
  if (kind === "centre")
    return (
      <g data-snap="centre">
        <circle cx={x} cy={y} r={s} {...common} />
        <path d={`M${x - s * 1.6} ${y}H${x + s * 1.6}M${x} ${y - s * 1.6}V${y + s * 1.6}`} stroke="var(--sheet-accent)" strokeWidth={1.4 * k} />
      </g>
    );
  if (kind === "quadrant") return <path d={`M${x} ${y - s * 1.3}L${x + s * 1.3} ${y}L${x} ${y + s * 1.3}L${x - s * 1.3} ${y}Z`} {...common} data-snap="quadrant" />;
  if (kind === "midpoint") return <path d={`M${x} ${y - s * 1.2}L${x + s * 1.2} ${y + s * 0.9}L${x - s * 1.2} ${y + s * 0.9}Z`} {...common} data-snap="midpoint" />;
  return <circle cx={x} cy={y} r={s * 0.7} {...common} data-snap="edge" />;
}
