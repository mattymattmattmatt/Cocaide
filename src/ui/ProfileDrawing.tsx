// A weldment profile, drawn: its sketch at one size, fitted to a small box.

import type { SketchEntity } from "../doc/types";
import { entityPolylines } from "../geom/profile";

export function ProfileDrawing({ entities, size = 72, testId }: { entities: SketchEntity[]; size?: number; testId?: string }) {
  const lines = entities.filter((e) => !e.construction).flatMap((e) => entityPolylines(e));
  const pts = lines.flat();
  if (!pts.length) return <svg width={size} height={size} className="profile-drawing" data-testid={testId} />;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const span = Math.max(x1 - x0, y1 - y0) || 1;
  const pad = span * 0.08;
  // y up, as in the sketch.
  const view = `${x0 - pad} ${-y1 - pad} ${span + 2 * pad} ${span + 2 * pad}`;
  return (
    <svg width={size} height={size} viewBox={view} className="profile-drawing" data-testid={testId} aria-hidden="true">
      {lines.map((l, i) => (
        <polyline key={i} points={l.map((p) => `${p[0]},${-p[1]}`).join(" ")} fill="none" vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}
