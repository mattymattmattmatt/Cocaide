// A thin bar along the top edge of the window while the model loads: it fills as an assembly's parts come in, or moves
// along when how far can't be told, and fades out once everything is in. It only shows for a load that takes a moment,
// so a quick rebuild doesn't flicker it.

import { useEffect, useState } from "react";
import type { LoadProgress } from "./loadProgress";

/** How long a load runs before the bar shows (ms). */
const SHOW_AFTER = 250;
/** How long the full bar stays before it fades (ms). */
const HOLD = 350;

export function LoadBar({ progress }: { progress: LoadProgress }) {
  const [phase, setPhase] = useState<"hidden" | "showing" | "finishing">("hidden");
  const { active } = progress;
  useEffect(() => {
    if (active) {
      if (phase === "showing") return;
      const t = setTimeout(() => setPhase("showing"), phase === "finishing" ? 0 : SHOW_AFTER);
      return () => clearTimeout(t);
    }
    if (phase === "showing") {
      setPhase("finishing");
      return;
    }
    if (phase === "finishing") {
      const t = setTimeout(() => setPhase("hidden"), HOLD + 300);
      return () => clearTimeout(t);
    }
  }, [active, phase]);
  if (phase === "hidden") return null;
  const finishing = phase === "finishing";
  const fraction = finishing ? 1 : progress.fraction;
  return (
    <div
      className={`load-bar${finishing ? " done" : ""}${fraction === null ? " indeterminate" : ""}`}
      role="progressbar"
      aria-label={finishing ? "Loaded" : progress.label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(fraction !== null ? { "aria-valuenow": Math.round(fraction * 100) } : {})}
      title={finishing ? "Loaded" : progress.label}
      data-testid="load-bar"
    >
      <div className="load-bar-fill" style={fraction !== null ? { width: `${fraction * 100}%` } : undefined} />
    </div>
  );
}
