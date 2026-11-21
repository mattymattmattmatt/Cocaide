// A 3D sketch's properties: Draw (clicks in the view place points on a work
// plane, Tab turns it), its points (each at coordinates or measured from an
// earlier point: the offsets are its dimensions, =expressions allowed) and
// its lines. Members go on its lines from Members from sketch.

import { useEffect } from "react";
import { resolveExpressions } from "../../doc/parameters";
import { sketch3dPositions } from "../../geom/sketch3d";
import { linkText, resolveNodeLink } from "../../weldment/sketchNodes";
import type { Vec3 } from "../../doc/types";
import { Icon } from "../../ui/icons";
import { NumberInput, type NumberValue } from "../../ui/fields";
import { getDraw, setDraw, useDraw } from "../../ui/sketch3d/drawState";
import { WORK_PLANES } from "../../ui/sketch3d/place";
import type { EditorProps, UiOp } from "../uiDefs";

type Raw = Record<string, unknown>;
type Link = { sketch: string; point: string; t?: number };
type Point = { id: string; at?: NumberValue[] | Link; from?: string; by?: NumberValue[] };
const isLink = (v: unknown): v is Link => typeof v === "object" && v !== null && !Array.isArray(v);
type Line = { id: string; start: string; end: string; construction?: boolean };

const r2 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;

function Editor({ f, doc, update }: EditorProps) {
  const id = String(f.id);
  const draw = useDraw();
  const drawing = draw.feature === id;
  const points = (Array.isArray(f.points) ? f.points : []) as Point[];
  const lines = (Array.isArray(f.lines) ? f.lines : []) as Line[];
  // Where each point is now (expressions evaluated), for switching a point between "at" and "from".
  const params = Object.fromEntries(Object.entries((doc.parameters ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === "number")) as Record<string, number>;
  const placedR = sketch3dPositions(resolveExpressions(points, params, []) as unknown[], (l) => resolveNodeLink(doc.features, l, params));
  const placed = placedR.ok ? placedR.at : new Map<string, Vec3>();
  // A new, empty 3D sketch starts drawing; leaving its properties stops.
  useEffect(() => {
    if (points.length === 0) setDraw({ feature: id, anchor: null });
    return () => {
      if (getFeature() === id) setDraw({ feature: null, anchor: null });
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const setPoints = (next: Point[], nextLines: Line[] = lines) => update({ points: next, lines: nextLines });
  const setPoint = (i: number, p: Point) => setPoints(points.map((q, k) => (k === i ? p : q)));
  const removePoint = (i: number) => {
    const gone = points[i].id;
    // Points measured from it keep where they are; lines on it go.
    const next = points.filter((_, k) => k !== i).map((q) => (q.from === gone ? { id: q.id, at: [...(placed.get(q.id) ?? [0, 0, 0])].map(r2) } : q));
    setPoints(next, lines.filter((l) => l.start !== gone && l.end !== gone));
    if (draw.anchor === gone) setDraw({ anchor: null });
  };
  const switchBase = (i: number, from: string) => {
    const p = points[i];
    const here = placed.get(p.id) ?? [0, 0, 0];
    if (!from) return setPoint(i, { id: p.id, at: here.map(r2) });
    const base = placed.get(from) ?? [0, 0, 0];
    setPoint(i, { id: p.id, from, by: here.map((x, k) => r2(x - base[k])) });
  };

  return (
    <div className="sketch3d-editor" data-testid="sketch3d-editor">
      <div className="sketch3d-tools">
        <button type="button" className={drawing ? "on" : ""} aria-pressed={drawing} onClick={() => setDraw(drawing ? { feature: null, anchor: null } : { feature: id, anchor: null })} data-testid="sketch3d-draw">
          <Icon name={drawing ? "check" : "line"} size={13} />
          {drawing ? "Drawing…" : "Draw"}
        </button>
        <span className="sketch3d-planes" role="radiogroup" aria-label="Work plane">
          {WORK_PLANES.map((p) => (
            <button key={p} type="button" role="radio" aria-checked={draw.plane === p} className={draw.plane === p ? "on" : ""} onClick={() => setDraw({ plane: p })} data-testid={`sketch3d-plane-${p}`} title={`Draw on the ${p} plane (Tab turns it)`}>
              {p}
            </button>
          ))}
        </span>
      </div>
      <p className="muted small">
        {drawing
          ? "Click in the view to place points; each click draws a line from the last. Tab turns the work plane, Esc or a double-click ends the line, a click on a point joins it."
          : "Draw places points with the mouse; type exact offsets below. A point measured from another moves with it."}
      </p>
      <h3>Points</h3>
      {points.length === 0 && <p className="muted small">None yet.</p>}
      <ul className="sketch3d-list">
        {points.map((p, i) => {
          const earlier = points.slice(0, i).map((q) => q.id);
          if (isLink(p.at)) {
            const link = p.at;
            const here = placed.get(p.id);
            return (
              <li key={p.id} data-testid={`sketch3d-point-${p.id}`} className={`follows${draw.anchor === p.id && drawing ? " anchor" : ""}`}>
                <span className="sketch3d-id">{p.id}</span>
                <span className="sketch3d-follows" title={here ? `Now at ${here.map((x) => Math.round(x * 100) / 100).join(", ")}: it moves with ${link.sketch}` : `${link.sketch} can't be found`} data-testid={`sketch3d-follows-${p.id}`}>
                  <Icon name="link" size={12} /> {linkText(link)}
                </span>
                <button type="button" className="link-button small" disabled={!here} onClick={() => here && setPoint(i, { id: p.id, at: here.map(r2) })} title="Keep it where it is, as numbers" data-testid={`sketch3d-unlink-${p.id}`}>
                  Unlink
                </button>
                <button type="button" className="icon" aria-label={`Delete ${p.id}`} onClick={() => removePoint(i)} data-testid={`sketch3d-delete-${p.id}`}>
                  <Icon name="trash" size={13} />
                </button>
              </li>
            );
          }
          const vec = ((p.from ? p.by : p.at) as NumberValue[] | undefined) ?? [0, 0, 0];
          return (
            <li key={p.id} data-testid={`sketch3d-point-${p.id}`} className={draw.anchor === p.id && drawing ? "anchor" : ""}>
              <span className="sketch3d-id">{p.id}</span>
              <select value={p.from ?? ""} onChange={(e) => switchBase(i, e.target.value)} aria-label={`${p.id} measured from`} data-testid={`sketch3d-from-${p.id}`}>
                <option value="">at</option>
                {earlier.map((q) => (
                  <option key={q} value={q}>
                    from {q}
                  </option>
                ))}
              </select>
              <span className="vec">
                {[0, 1, 2].map((k) => (
                  <NumberInput
                    key={k}
                    value={vec[k] ?? 0}
                    ariaLabel={`${p.id} ${p.from ? "d" : ""}${"xyz"[k]}`}
                    testId={`sketch3d-${p.id}-${"xyz"[k]}`}
                    onCommit={(v) => setPoint(i, p.from ? { ...p, by: vec.map((c, n) => (n === k ? v : c)) } : { ...p, at: vec.map((c, n) => (n === k ? v : c)) })}
                  />
                ))}
              </span>
              <button type="button" className="icon" aria-label={`Delete ${p.id}`} title="Delete the point (and its lines)" onClick={() => removePoint(i)} data-testid={`sketch3d-delete-${p.id}`}>
                <Icon name="trash" size={13} />
              </button>
            </li>
          );
        })}
      </ul>
      <h3>Lines</h3>
      {lines.length === 0 && <p className="muted small">None yet.</p>}
      <ul className="sketch3d-list lines">
        {lines.map((l, i) => {
          const a = placed.get(l.start);
          const b = placed.get(l.end);
          const len = a && b ? Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) : null;
          return (
            <li key={l.id} data-testid={`sketch3d-line-${l.id}`}>
              <span className="sketch3d-id">{l.id}</span>
              <span>
                {l.start} → {l.end}
                {len !== null && <span className="muted"> · {Math.round(len * 100) / 100} mm</span>}
              </span>
              <label className="check" title="Construction: kept for the layout, never a member's line">
                <input type="checkbox" checked={l.construction === true} onChange={(e) => update({ lines: lines.map((x, k) => (k === i ? (e.target.checked ? { ...x, construction: true } : { id: x.id, start: x.start, end: x.end }) : x)) })} data-testid={`sketch3d-construction-${l.id}`} />
                constr.
              </label>
              <button type="button" className="icon" aria-label={`Delete ${l.id}`} onClick={() => update({ lines: lines.filter((_, k) => k !== i) })} data-testid={`sketch3d-delete-${l.id}`}>
                <Icon name="trash" size={13} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const getFeature = () => getDraw().feature;

export const ui: UiOp = {
  op: "sketch3d",
  label: "3D Sketch",
  icon: "sketch3d",
  Editor,
  summary(f: Raw) {
    const n = Array.isArray(f.lines) ? f.lines.length : 0;
    return `${n} line${n === 1 ? "" : "s"}`;
  },
};
