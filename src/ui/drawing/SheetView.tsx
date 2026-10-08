// The drawing's sheet in the app (Phase L): the same SVG that export writes,
// with pan (drag empty paper, or the middle button), zoom (wheel) and picking.
// A click is matched against the composed boxes, not the thin lines, so a
// view or a dimension is easy to hit. Views, balloons, callouts, weld
// symbols, tables and notes can be dragged to a place of their own.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Vec2 } from "../../doc/types";
import type { ComposedSheet } from "../../drafting/compose";
import type { Box } from "../../drafting/sheet";
import { sheetSVG } from "../../drafting/svg";
import { wheelZoom } from "../input";

export type SheetTarget = { kind: "view"; id: string } | { kind: "annotation"; id: string };

export interface SheetViewProps {
  sheet: ComposedSheet;
  selected: string | null;
  failed: string[];
  onSelect(target: SheetTarget | null): void;
  onContext(target: SheetTarget | null, x: number, y: number): void;
  /** A view dragged to `at` (its centre, sheet mm). */
  onMoveView(id: string, at: Vec2): void;
  /** An annotation dragged by `delta` (sheet mm). */
  onMoveAnnotation(id: string, delta: Vec2): void;
}

const DRAGGABLE = new Set(["balloon", "hole", "weld", "table", "note"]);

export function SheetView({ sheet, selected, failed, onSelect, onContext, onMoveView, onMoveAnnotation }: SheetViewProps) {
  const host = useRef<HTMLDivElement>(null);
  /** The part of the sheet shown: x, y (SVG, y down), width, height. */
  const box = useRef<[number, number, number, number]>([0, 0, sheet.width, sheet.height]);
  const [, redraw] = useState(0);
  const svg = useMemo(() => sheetSVG(sheet, { fit: true, selected: selected ? [selected] : [], failed }), [sheet, selected, failed]);

  const apply = () => {
    const el = host.current?.querySelector("svg");
    if (el) el.setAttribute("viewBox", box.current.map((v) => String(Math.round(v * 1000) / 1000)).join(" "));
  };
  useLayoutEffect(apply, [svg]);
  // A new paper size fits the whole sheet again.
  useEffect(() => {
    box.current = [0, 0, sheet.width, sheet.height];
    apply();
  }, [sheet.width, sheet.height]);

  /** A client point on the sheet, mm, y up. */
  const toSheet = (clientX: number, clientY: number): Vec2 | null => {
    const el = host.current?.querySelector("svg");
    const m = el?.getScreenCTM();
    if (!el || !m) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return [p.x, sheet.height - p.y];
  };

  /** What is under a point: the smallest annotation box that holds it, else the view whose lines it is among. */
  const hit = (p: Vec2): SheetTarget | null => {
    const within = (b: Box | null, pad: number) => !!b && p[0] >= b.min[0] - pad && p[0] <= b.max[0] + pad && p[1] >= b.min[1] - pad && p[1] <= b.max[1] + pad;
    const area = (b: Box) => (b.max[0] - b.min[0] + 2) * (b.max[1] - b.min[1] + 2);
    const annotations = sheet.annotations.filter((a) => within(a.box, 1)).sort((a, b) => area(a.box!) - area(b.box!));
    if (annotations.length) return { kind: "annotation", id: annotations[0].id };
    const view = sheet.views.find((v) => within(v.box, 2));
    return view ? { kind: "view", id: view.id } : null;
  };

  const drag = useRef<{ start: Vec2; client: Vec2; target: SheetTarget | null; pan: boolean; moved: boolean } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    const p = toSheet(e.clientX, e.clientY);
    if (!p) return;
    const t = e.button === 0 ? hit(p) : null;
    const movable = t && (t.kind === "view" || DRAGGABLE.has(sheet.annotations.find((a) => a.id === t.id)?.type ?? ""));
    drag.current = { start: p, client: [e.clientX, e.clientY], target: t, pan: !movable, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.client[0];
    const dy = e.clientY - d.client[1];
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    if (d.pan) {
      const el = host.current!;
      const k = box.current[2] / el.clientWidth;
      box.current = [box.current[0] - dx * k, box.current[1] - dy * k, box.current[2], box.current[3]];
      d.client = [e.clientX, e.clientY];
      apply();
      return;
    }
    const p = toSheet(e.clientX, e.clientY);
    const g = host.current?.querySelectorAll(`g[data-id="${CSS.escape(d.target!.id)}"]`);
    if (!p || !g) return;
    for (const el of g) el.setAttribute("transform", `translate(${p[0] - d.start[0]} ${-(p[1] - d.start[1])})`);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      if (e.button === 0) onSelect(d.target);
      return;
    }
    if (d.pan || !d.target) return;
    const p = toSheet(e.clientX, e.clientY);
    if (!p) return;
    const delta: Vec2 = [round1(p[0] - d.start[0]), round1(p[1] - d.start[1])];
    if (d.target.kind === "view") {
      const v = sheet.views.find((x) => x.id === d.target!.id);
      if (v) onMoveView(v.id, [round1(v.centre[0] + delta[0]), round1(v.centre[1] + delta[1])]);
    } else onMoveAnnotation(d.target.id, delta);
  };

  const onWheel = (e: React.WheelEvent) => {
    const p = toSheet(e.clientX, e.clientY);
    if (!p) return;
    // The box shrinks to zoom in: the wheel's zoom, turned round.
    const k = 1 / wheelZoom(e);
    const [x, y, w, h] = box.current;
    const nw = Math.min(Math.max(w * k, 20), sheet.width * 4);
    const s = nw / w;
    const sy = sheet.height - p[1];
    box.current = [p[0] - (p[0] - x) * s, sy - (sy - y) * s, nw, h * s];
    apply();
    redraw((n) => n + 1);
  };

  return (
    <div
      ref={host}
      className="sheet-view"
      data-testid="sheet"
      dangerouslySetInnerHTML={{ __html: svg }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      onDoubleClick={() => {
        box.current = [0, 0, sheet.width, sheet.height];
        apply();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const p = toSheet(e.clientX, e.clientY);
        onContext(p ? hit(p) : null, e.clientX, e.clientY);
      }}
    />
  );
}

function round1(x: number): number {
  return Math.round(x * 10) / 10 + 0;
}
