// Sketch → Frame layout…: a starter layout sketch for a frame, its sizes as
// parameters (frame_w, frame_h, ...). On Add the Member command opens with
// its lines picked, so the next step is a size and OK.

import { useState } from "react";
import type { FrameTemplate, TemplateSpec } from "../../weldment/frameTemplates";
import { Icon } from "../icons";

const KINDS: { kind: FrameTemplate; label: string; about: string }[] = [
  { kind: "wall", label: "Wall or panel", about: "A rectangle with posts evenly between its sides: a dimensioned 2D sketch on Front." },
  { kind: "box", label: "Box", about: "A table or a stand: a 3D sketch, width × depth × height." },
  { kind: "portal", label: "Pitched portal", about: "Posts to the eaves and a ridge above, in bays joined at the eaves and the ridge." },
];

export function FrameLayoutDialog({ onAdd, onClose }: { onAdd(spec: TemplateSpec): boolean; onClose(): void }) {
  const [kind, setKind] = useState<FrameTemplate>("wall");
  const [n, setN] = useState({ width: 2000, height: 1200, depth: 600, posts: 1, rise: 400, bays: 2, bay: 1500 });
  const field = (key: keyof typeof n, label: string, unit = "mm", step = 10) => (
    <label className="layout-field" key={key}>
      <span>{label}</span>
      <span className="layout-input">
        <input type="number" min={key === "posts" ? 0 : 1} step={step} value={n[key]} onChange={(e) => setN({ ...n, [key]: Number(e.target.value) })} data-testid={`layout-${key}`} />
        {unit && <span className="unit">{unit}</span>}
      </span>
    </label>
  );
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="modal frame-layout" role="dialog" aria-label="Frame layout" data-testid="frame-layout">
        <header>
          <Icon name="sketch3d" size={16} />
          <h2>Frame layout</h2>
          <button type="button" className="icon" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>
        <div className="layout-kinds" role="radiogroup" aria-label="Layout">
          {KINDS.map((k) => (
            <button type="button" key={k.kind} role="radio" aria-checked={kind === k.kind} className={kind === k.kind ? "on" : ""} onClick={() => setKind(k.kind)} data-testid={`layout-kind-${k.kind}`}>
              <strong>{k.label}</strong>
              <span className="muted">{k.about}</span>
            </button>
          ))}
        </div>
        <div className="layout-fields">
          {field("width", "Width")}
          {field("height", kind === "portal" ? "Height to eaves" : "Height")}
          {kind === "box" && field("depth", "Depth")}
          {kind === "wall" && field("posts", "Posts between", "", 1)}
          {kind === "portal" && field("rise", "Ridge rise")}
          {kind === "portal" && field("bays", "Bays", "", 1)}
          {kind === "portal" && field("bay", "Bay length")}
        </div>
        <p className="muted small">The sizes go in Parameters (frame_w, frame_h …): change one and the frame follows.</p>
        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => onAdd({ kind, ...n }) && onClose()} data-testid="layout-add">
            <Icon name="plus" size={13} /> Add layout and members…
          </button>
        </footer>
      </div>
    </div>
  );
}
