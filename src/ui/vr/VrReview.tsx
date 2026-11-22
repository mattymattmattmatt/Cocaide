// The VR notes on the desktop: what someone pinned and moved in VR, to go
// through at a desk. A pin's note can be written or changed, or the pin taken
// away; a moved piece of furniture (drawn as a ghost where it was put) is
// accepted (it becomes a Move feature of its part: the model changes, one undo
// step) or rejected. Collapsed it is a chip at the top of the view.

import { useState } from "react";
import { niceName, PIN_COLORS, PIN_WORDS, type VrMove, type VrPin } from "../../doc/vr";
import { Icon } from "../icons";

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
const mm = (v: number) => Math.round(v).toLocaleString("en-AU");

export interface VrReviewProps {
  pins: VrPin[];
  moves: VrMove[];
  hidden: boolean;
  onHidden(h: boolean): void;
  onAccept(id: string): void;
  onReject(id: string): void;
  onPinText(id: string, text: string): void;
  onPinDelete(id: string): void;
}

export function VrReview(p: VrReviewProps) {
  const [open, setOpen] = useState(false);
  const n = p.pins.length + p.moves.length;
  if (!n) return null;
  const summary = [p.moves.length ? `${p.moves.length} move${p.moves.length === 1 ? "" : "s"}` : "", p.pins.length ? `${p.pins.length} pin${p.pins.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
  return (
    <div className={`vr-review${open ? " open" : ""}`} data-testid="vr-review">
      <button className="vr-review-chip" onClick={() => setOpen(!open)} title="What was pinned and moved in VR: notes to read, moves to accept or reject" data-testid="vr-review-chip">
        <Icon name="perspective" size={13} />
        VR notes: {summary}
        <Icon name="chevronRight" size={11} className={open ? "open" : ""} />
      </button>
      {open && (
        <div className="vr-review-body">
          <div className="vr-review-bar">
            <label className="small">
              <input type="checkbox" checked={!p.hidden} onChange={(e) => p.onHidden(!e.target.checked)} data-testid="vr-review-show" /> show in the view
            </label>
            {p.moves.length > 1 && (
              <span>
                <button className="link" onClick={() => p.moves.forEach((m) => p.onAccept(m.id))} data-testid="vr-accept-all">
                  Accept all moves
                </button>{" "}
                <button className="link" onClick={() => p.moves.forEach((m) => p.onReject(m.id))} data-testid="vr-reject-all">
                  Reject all
                </button>
              </span>
            )}
          </div>
          {p.moves.length > 0 && <h3>Moved in VR (the orange ghosts)</h3>}
          <ul>
            {p.moves.map((m) => (
              <li key={m.id} className="vr-review-move" data-testid={`vr-move-${m.id}`}>
                <div>
                  <strong title={m.body}>{niceName(m.body)}</strong>
                  {m.component && <span className="muted"> in {m.component}</span>}
                  <div className="muted small">
                    {mm(Math.hypot(m.move[0], m.move[1]))} mm{m.move[2] ? ` (${mm(m.move[2])} up)` : ""}
                    {m.turn ? `, turned ${Math.round(m.turn)}°` : ""}
                    {m.made ? ` · ${m.made.replace("T", " ")}` : ""}
                  </div>
                </div>
                <span className="vr-review-actions">
                  <button className="primary small" onClick={() => p.onAccept(m.id)} title="Move it in the model: a Move feature on its part" data-testid={`vr-accept-${m.id}`}>
                    Accept
                  </button>
                  <button className="small" onClick={() => p.onReject(m.id)} title="Leave it where it was" data-testid={`vr-reject-${m.id}`}>
                    Reject
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {p.pins.length > 0 && <h3>Pins</h3>}
          <ul>
            {p.pins.map((pin) => (
              <li key={pin.id} className="vr-review-pin" data-testid={`vr-pin-${pin.id}`}>
                <span className="vr-pin-dot" style={{ background: hex(PIN_COLORS[pin.tag]) }} />
                <div className="vr-pin-body">
                  <strong>{PIN_WORDS[pin.tag]}</strong>
                  <span className="muted small"> at {mm(pin.at[0])}, {mm(pin.at[1])}</span>
                  <input
                    type="text"
                    defaultValue={pin.text ?? ""}
                    placeholder="Add a note…"
                    onBlur={(e) => e.target.value !== (pin.text ?? "") && p.onPinText(pin.id, e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    data-testid={`vr-pin-text-${pin.id}`}
                  />
                </div>
                <button className="icon" aria-label="Take the pin away" onClick={() => p.onPinDelete(pin.id)} data-testid={`vr-pin-delete-${pin.id}`}>
                  <Icon name="x" size={12} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
