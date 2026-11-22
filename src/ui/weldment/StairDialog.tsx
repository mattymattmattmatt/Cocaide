// Weldments → Stair…: a straight, L or U stair from floor-to-floor height and
// a going, laid out by the riser and going rules. The numbers (risers, 2R + G,
// pitch, headroom) and what breaks the rules show as the fields change; Add
// puts the stringers, housed treads, risers and landing in the part.

import { useMemo, useState } from "react";
import { stairNumbers, type StairSpec, type StairType } from "../../weldment/stairs";
import { Icon } from "../icons";

const TYPES: { type: StairType; label: string; about: string }[] = [
  { type: "straight", label: "Straight", about: "One flight" },
  { type: "L", label: "L", about: "Two flights round a quarter landing" },
  { type: "U", label: "U", about: "Two flights round a half landing, side by side" },
];
const STRINGERS = ["240x45 LVL", "300x45 LVL", "360x45 LVL", "300x63 LVL"];

export function StairDialog({ onAdd, onClose }: { onAdd(spec: StairSpec): boolean; onClose(): void }) {
  const [s, setS] = useState({
    type: "straight" as StairType, turn: "right" as "left" | "right", rise: 3000, width: 1000, going: 260, maxRiser: 190,
    x: 0, y: 0, z: 0, direction: 0, tread: 40, housing: 12, stringer: "300x45 LVL", risers: false, checkHead: true, depth: 380, opening: 3800,
  });
  const spec: StairSpec = {
    type: s.type, origin: [s.x, s.y, s.z], direction: s.direction, rise: s.rise, width: s.width, going: s.going, maxRiser: s.maxRiser,
    turn: s.turn, tread: s.tread, housing: s.housing, stringer: s.stringer, risers: s.risers, ...(s.checkHead ? { above: { depth: s.depth, opening: s.opening } } : {}),
  };
  const n = useMemo(() => stairNumbers(spec), [JSON.stringify(spec)]); // eslint-disable-line react-hooks/exhaustive-deps
  // Headroom on the last flight's nosings under the floor above (as planStair works it out).
  const headroom = useMemo(() => {
    if (!s.checkHead) return null;
    const last = s.type === "straight" ? n.risers : n.risers - Math.floor(n.risers / 2);
    const z0 = s.type === "straight" ? 0 : Math.floor(n.risers / 2) * n.riser;
    const run = (last - 1) * n.going;
    let least = Infinity;
    for (let t = 1; t < last; t++) if ((t - 1) * n.going < run - s.opening) least = Math.min(least, s.rise - s.depth - (z0 + t * n.riser));
    return Number.isFinite(least) ? Math.round(least) : null;
  }, [n, s]);
  const warnings = [...n.warnings, ...(headroom !== null && headroom < 2000 ? [`headroom is ${headroom} over a nosing: at least 2000 (make the opening longer)`] : [])];
  const num = (key: keyof typeof s, label: string, unit = "mm", step = 10, min = 0) => (
    <label className="layout-field" key={key}>
      <span>{label}</span>
      <span className="layout-input">
        <input type="number" step={step} min={min} value={s[key] as number} onChange={(e) => setS({ ...s, [key]: Number(e.target.value) })} data-testid={`stair-${key}`} />
        {unit && <span className="unit">{unit}</span>}
      </span>
    </label>
  );
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="modal frame-layout stair-dialog" role="dialog" aria-label="Stair" data-testid="stair-dialog">
        <header>
          <Icon name="member" size={16} />
          <h2>Stair</h2>
          <button type="button" className="icon" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>
        <div className="layout-kinds" role="radiogroup" aria-label="Stair type">
          {TYPES.map((t) => (
            <button type="button" key={t.type} role="radio" aria-checked={s.type === t.type} className={s.type === t.type ? "on" : ""} onClick={() => setS({ ...s, type: t.type })} data-testid={`stair-type-${t.type}`}>
              <strong>{t.label}</strong>
              <span className="muted">{t.about}</span>
            </button>
          ))}
        </div>
        <div className="layout-fields">
          {num("rise", "Floor to floor")}
          {num("going", "Going")}
          {num("width", "Width")}
          {num("maxRiser", "Riser at most", "mm", 1)}
          {s.type !== "straight" && (
            <label className="layout-field">
              <span>Turns</span>
              <select value={s.turn} onChange={(e) => setS({ ...s, turn: e.target.value === "left" ? "left" : "right" })} data-testid="stair-turn">
                <option value="right">Right</option>
                <option value="left">Left</option>
              </select>
            </label>
          )}
          <label className="layout-field">
            <span>Stringers</span>
            <select value={s.stringer} onChange={(e) => setS({ ...s, stringer: e.target.value })} data-testid="stair-stringer">
              {STRINGERS.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          {num("tread", "Treads", "mm", 1)}
          {num("housing", "Housed", "mm", 1)}
          {num("x", "Foot X", "mm", 10, -1e6)}
          {num("y", "Foot Y", "mm", 10, -1e6)}
          {num("z", "Floor Z", "mm", 10, -1e6)}
          {num("direction", "Way up", "°", 90, -360)}
          <label className="layout-field">
            <span>Risers</span>
            <span className="layout-input">
              <input type="checkbox" checked={s.risers} onChange={(e) => setS({ ...s, risers: e.target.checked })} data-testid="stair-risers" /> closed
            </span>
          </label>
          <label className="layout-field">
            <span>Headroom</span>
            <span className="layout-input">
              <input type="checkbox" checked={s.checkHead} onChange={(e) => setS({ ...s, checkHead: e.target.checked })} data-testid="stair-check-head" /> check
            </span>
          </label>
          {s.checkHead && num("depth", "Floor above, deep")}
          {s.checkHead && num("opening", "Opening, from the top")}
        </div>
        <p className="stair-summary" data-testid="stair-summary">
          <strong>{n.risers} risers</strong> of {n.riser.toFixed(1)} · {n.treads} treads of {n.going} · 2R + G {n.stride.toFixed(0)} · pitch {n.pitch.toFixed(1)}°
          {headroom !== null && <> · headroom {headroom}</>}
        </p>
        {warnings.length > 0 && (
          <ul className="stair-warnings" data-testid="stair-warnings">
            {warnings.map((w) => (
              <li key={w}>
                <Icon name="warning" size={12} /> {w}
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">The foot is the first riser&apos;s line at the middle of the stair, on the floor. The stringers are cut level on the floor and plumb at the top; the treads are let into them.</p>
        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => onAdd(spec) && onClose()} data-testid="stair-add">
            <Icon name="plus" size={13} /> Add the stair
          </button>
        </footer>
      </div>
    </div>
  );
}
