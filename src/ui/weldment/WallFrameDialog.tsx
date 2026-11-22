// Weldments → Wall frame…: a timber wall frame from its length, height and
// openings. The counts and what doesn't fit show as it is set up; Add puts
// the frame (on a sketch along the wall's base line, so its joints are made
// and it follows the sketch) and its linings in the part.

import { useMemo, useState } from "react";
import { wallNumbers, type WallFrameSpec, type WallOpening } from "../../weldment/wallFrame";
import { Icon } from "../icons";

const STUDS = ["70x35 MGP10", "70x45 MGP10", "90x35 MGP10", "90x45 MGP10", "140x45 MGP10"];
const LINTELS = ["130x45 LVL", "150x45 LVL", "170x45 LVL", "200x45 LVL", "240x45 LVL", "300x45 LVL", "360x45 LVL"];

interface Row {
  kind: "door" | "window";
  at: number;
  width: number;
  sill: number;
  head: number;
}

export function WallFrameDialog({ onAdd, onClose }: { onAdd(spec: WallFrameSpec): boolean; onClose(): void }) {
  const [s, setS] = useState({ length: 6000, height: 2700, spacing: 600, stud: "90x45 MGP10", lintel: "240x45 LVL", loadBearing: true, lining: "auto", x: 0, y: 0, z: 0, direction: 0 });
  const [rows, setRows] = useState<Row[]>([{ kind: "window", at: 900, width: 2400, sill: 900, head: 2370 }, { kind: "door", at: 4500, width: 820, sill: 0, head: 2370 }]);
  const openings: WallOpening[] = rows.map((r, i) => ({ x0: r.at, x1: r.at + r.width, head: r.head, ...(r.kind === "window" ? { sill: r.sill } : {}), name: `${r.kind === "door" ? "d" : "w"}${i + 1}` }));
  const spec: WallFrameSpec = {
    origin: [s.x, s.y, s.z], direction: s.direction, length: s.length, height: s.height, spacing: s.spacing, stud: s.stud, lintel: s.lintel, loadBearing: s.loadBearing, openings,
    ...(s.lining !== "auto" ? { lining: s.lining as WallFrameSpec["lining"] } : {}),
  };
  const n = useMemo(() => wallNumbers(spec), [JSON.stringify(spec)]); // eslint-disable-line react-hooks/exhaustive-deps
  const num = (key: keyof typeof s, label: string, unit = "mm", step = 10, min = -1e6) => (
    <label className="layout-field" key={key}>
      <span>{label}</span>
      <span className="layout-input">
        <input type="number" step={step} min={min} value={s[key] as number} onChange={(e) => setS({ ...s, [key]: Number(e.target.value) })} data-testid={`wall-${key}`} />
        {unit && <span className="unit">{unit}</span>}
      </span>
    </label>
  );
  const setRow = (i: number, patch: Partial<Row>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="modal frame-layout stair-dialog wall-dialog" role="dialog" aria-label="Wall frame" data-testid="wall-dialog">
        <header>
          <Icon name="member" size={16} />
          <h2>Wall frame</h2>
          <button type="button" className="icon" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>
        <div className="layout-fields">
          {num("length", "Length", "mm", 10, 300)}
          {num("height", "Height", "mm", 10, 600)}
          {num("spacing", "Studs at", "mm", 50, 300)}
          <label className="layout-field">
            <span>Studs</span>
            <select value={s.stud} onChange={(e) => setS({ ...s, stud: e.target.value })} data-testid="wall-stud">
              {STUDS.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label className="layout-field">
            <span>Lintels (×2)</span>
            <select value={s.lintel} onChange={(e) => setS({ ...s, lintel: e.target.value })} disabled={!s.loadBearing} data-testid="wall-lintel">
              {LINTELS.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label className="layout-field">
            <span>Carries load</span>
            <span className="layout-input">
              <input type="checkbox" checked={s.loadBearing} onChange={(e) => setS({ ...s, loadBearing: e.target.checked })} data-testid="wall-bearing" /> external or bearing
            </span>
          </label>
          <label className="layout-field">
            <span>Lining</span>
            <select value={s.lining} onChange={(e) => setS({ ...s, lining: e.target.value })} data-testid="wall-lining">
              <option value="auto">{s.loadBearing ? "Inside (auto)" : "Both sides (auto)"}</option>
              <option value="inside">Inside</option>
              <option value="both">Both sides</option>
              <option value="none">None</option>
            </select>
          </label>
          {num("x", "Start X")}
          {num("y", "Start Y")}
          {num("z", "Base Z")}
          {num("direction", "Runs at", "°", 90, -360)}
        </div>
        <div className="wall-openings" data-testid="wall-openings">
          <div className="wall-openings-head">
            <strong>Openings</strong>
            <span className="muted small">rough sizes; along from the wall&apos;s start</span>
          </div>
          {rows.map((r, i) => (
            <div className="wall-opening" key={i} data-testid={`wall-opening-${i}`}>
              <select value={r.kind} onChange={(e) => setRow(i, { kind: e.target.value === "door" ? "door" : "window" })} aria-label="Kind" data-testid={`wall-opening-${i}-kind`}>
                <option value="window">Window</option>
                <option value="door">Door</option>
              </select>
              <input type="number" value={r.at} step={10} onChange={(e) => setRow(i, { at: Number(e.target.value) })} aria-label="From" title="From the wall's start" data-testid={`wall-opening-${i}-at`} />
              <input type="number" value={r.width} step={10} onChange={(e) => setRow(i, { width: Number(e.target.value) })} aria-label="Width" title="Width" data-testid={`wall-opening-${i}-width`} />
              <input type="number" value={r.sill} step={10} disabled={r.kind === "door"} onChange={(e) => setRow(i, { sill: Number(e.target.value) })} aria-label="Sill" title="Sill height" data-testid={`wall-opening-${i}-sill`} />
              <input type="number" value={r.head} step={10} onChange={(e) => setRow(i, { head: Number(e.target.value) })} aria-label="Head" title="Head height" data-testid={`wall-opening-${i}-head`} />
              <button type="button" className="icon" aria-label="Take it out" onClick={() => setRows(rows.filter((_, k) => k !== i))} data-testid={`wall-opening-${i}-remove`}>
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
          <div className="wall-opening-labels muted small">
            <span>kind</span>
            <span>from</span>
            <span>width</span>
            <span>sill</span>
            <span>head</span>
          </div>
          <button type="button" className="link-button small" onClick={() => setRows([...rows, { kind: "window", at: Math.min(s.length - 1500, (rows.at(-1)?.at ?? 0) + (rows.at(-1)?.width ?? 0) + 600), width: 1200, sill: 900, head: 2370 }])} data-testid="wall-opening-add">
            <Icon name="plus" size={12} /> Add an opening
          </button>
        </div>
        <p className="stair-summary" data-testid="wall-summary">
          <strong>{n.members} members</strong> · {n.studs} studs · {n.noggings} noggings{n.lintels ? ` · ${n.lintels} lintels` : ""} · {Object.entries(n.metres).map(([k, m]) => `${m} m of ${k}`).join(", ")}
        </p>
        {n.warnings.length > 0 && (
          <ul className="stair-warnings" data-testid="wall-warnings">
            {n.warnings.map((w) => (
              <li key={w}>
                <Icon name="warning" size={12} /> {w}
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">The start is the wall&apos;s centreline at the underside of the bottom plate; the outside is on the right of the way it runs. The frame goes on a sketch along it, so its joints are made and editing the sketch moves it.</p>
        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => onAdd(spec) && onClose()} data-testid="wall-add">
            <Icon name="plus" size={13} /> Add the wall frame
          </button>
        </footer>
      </div>
    </div>
  );
}
