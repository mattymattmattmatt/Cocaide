// The pinned photo's scale (spec 5.3, Phase G): the one dimension every size
// on the photo is measured from. The user sets it here, by typing the real
// length or picking two points on the photo, and confirms it. Until then the
// part is not exported.

import { useEffect, useState } from "react";
import type { Command } from "../doc/commands";
import { photoGuesses } from "../doc/photo";
import type { PhotoUnderlay } from "../doc/types";

interface Props {
  photo: PhotoUnderlay;
  /** Whether this browser has the photo's pixels. */
  stored: "loading" | "shown" | "missing";
  /** Picking the scale's points on the photo: which one is next. */
  picking: "from" | "to" | null;
  opacity: number;
  onOpacity(v: number): void;
  onPick(): void;
  onCancelPick(): void;
  dispatch(cmd: Command): string | null;
  onError(text: string): void;
}

const SOURCE = { typed: "typed", reference: "read off the photo", guess: "a guess" };

export function PhotoBar({ photo, stored, picking, opacity, onOpacity, onPick, onCancelPick, dispatch, onError }: Props) {
  const { scale } = photo;
  const guess = scale.source === "guess";
  const [draft, setDraft] = useState(guess ? "" : String(scale.length));
  useEffect(() => setDraft(guess ? "" : String(scale.length)), [scale.length, guess]);
  const typed = Number(draft);
  const valid = draft.trim() !== "" && Number.isFinite(typed) && typed > 0;
  const guesses = photoGuesses(photo);

  const run = (cmd: Command) => {
    const problem = dispatch(cmd);
    if (problem) onError(problem);
  };
  const commitLength = () => {
    if (valid && typed !== scale.length) run({ type: "setPhotoScale", length: typed });
  };
  const confirm = () => run({ type: "setPhotoScale", confirm: true, ...(valid && (guess || typed !== scale.length) ? { length: typed } : {}) });

  return (
    <div className={`photo-bar${scale.confirmed ? " confirmed" : ""}`} data-testid="photo-bar">
      <div className="photo-row">
        <strong>Photo</strong>
        <span className="photo-name">{photo.image}</span>
        <span className={`photo-status ${scale.confirmed ? "ok" : "warn"}`} data-testid="photo-status">
          {scale.confirmed ? "Scale confirmed" : "Scale not confirmed: export is off"}
        </span>
      </div>
      <div className="photo-row">
        <label htmlFor="photo-length">Scale: {scale.what} =</label>
        <input
          id="photo-length"
          inputMode="decimal"
          value={draft}
          placeholder={guess ? `≈ ${scale.length}` : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitLength}
          onKeyDown={(e) => e.key === "Enter" && commitLength()}
          data-testid="photo-length"
        />
        <span>mm</span>
        <span className="muted">({scale.confirmed ? "confirmed" : SOURCE[scale.source]})</span>
      </div>
      <div className="photo-row">
        {picking ? (
          <button onClick={onCancelPick} data-testid="photo-pick">
            {picking === "from" ? "Click the first point on the photo…" : "Click the second point…"} (Esc)
          </button>
        ) : (
          <button onClick={onPick} disabled={stored !== "shown"} title="Click two points on the photo whose distance you know" data-testid="photo-pick">
            Pick on photo
          </button>
        )}
        <button className="primary" disabled={scale.confirmed || (guess && !valid)} onClick={confirm} data-testid="photo-confirm">
          Confirm scale
        </button>
        <label className="photo-opacity">
          <span className="muted">Photo</span>
          <input type="range" min={0} max={1} step={0.05} value={opacity} onChange={(e) => onOpacity(Number(e.target.value))} aria-label="Photo opacity" />
        </label>
      </div>
      {guess && !scale.confirmed && <div className="photo-row why">The length is a guess: type the real one to confirm it.</div>}
      {guesses.length > 0 && (
        <div className="photo-row why" data-testid="photo-guesses">
          {guesses.join(", ")} {guesses.length === 1 ? "is a guess" : "are guesses"}: the photo doesn't show {guesses.length === 1 ? "it" : "them"}. Set {guesses.length === 1 ? "it" : "them"} in
          Parameters.
        </div>
      )}
      {stored === "missing" && (
        <div className="photo-row muted" data-testid="photo-missing">
          This browser doesn't have the photo. Drop {photo.image} on the window to pin it again.
        </div>
      )}
      <div className="photo-row muted small">Every size is estimated from the photo: check them against the part before making it.</div>
    </div>
  );
}
