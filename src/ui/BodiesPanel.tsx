// The part's bodies (Phase H): each with its colour, volume and mass, and the
// pairs that overlap. Hide a body to see past it; click it to select its
// faces; right-click it to ask about that body alone.

import type { Measurements } from "../kernel";
import type { BodyRange } from "../kernel/bodies";
import { BODY_COLORS } from "./Viewport";

interface Props {
  measurements: Measurements | null;
  bodies: BodyRange[];
  hidden: ReadonlySet<string>;
  onToggle(name: string): void;
  onSelect(body: BodyRange): void;
  onAsk?(name: string, x: number, y: number): void;
}

const n = (x: number, digits = 3) => x.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });

export function BodiesPanel({ measurements: m, bodies, hidden, onToggle, onSelect, onAsk }: Props) {
  if (!m || bodies.length < 2) return null;
  return (
    <section className="panel bodies" aria-label="Bodies" data-testid="bodies">
      <h2>Bodies</h2>
      <ul>
        {bodies.map((b, i) => {
          const mb = m.bodies.find((x) => x.name === b.name);
          return (
            <li
              key={b.name}
              data-testid={`body-${b.name}`}
              className={hidden.has(b.name) ? "hidden" : undefined}
              onContextMenu={(e) => {
                if (!onAsk) return;
                e.preventDefault();
                onAsk(b.name, e.clientX, e.clientY);
              }}
            >
              <span className="swatch" style={{ background: BODY_COLORS[i % BODY_COLORS.length] }} />
              <button className="body-name" onClick={() => onSelect(b)} title="Select its faces; right-click to ask about it">
                {b.name}
              </button>
              <span className="body-volume" title={mb ? `${n(mb.massKg * 1000, 1)} g` : undefined}>
                {mb ? `${n(mb.volume)} mm³` : ""}
              </span>
              <button className="icon" aria-pressed={!hidden.has(b.name)} aria-label={`${hidden.has(b.name) ? "Show" : "Hide"} ${b.name}`} onClick={() => onToggle(b.name)} data-testid={`body-toggle-${b.name}`}>
                {hidden.has(b.name) ? "◌" : "●"}
              </button>
            </li>
          );
        })}
      </ul>
      {m.interference.map((c) => (
        <div key={c.bodies.join("|")} className="interference" role="alert" data-testid="interference">
          {c.bodies[0]} and {c.bodies[1]} overlap by {n(c.volume)} mm³
        </div>
      ))}
    </section>
  );
}
