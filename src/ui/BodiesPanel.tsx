// The part's bodies (Phase H): each with its colour, volume and mass, and the
// pairs that overlap. Hide a body to see past it; click it to select its
// faces; right-click it to ask about that body alone. Below them, the
// members (Phase I): alike ones grouped as the cut list groups them.

import type { Measurements } from "../kernel";
import { cutList } from "../weldment/cutlist";
import type { BodyRange } from "../kernel/bodies";
import { BODY_COLORS } from "./Viewport";

interface Props {
  measurements: Measurements | null;
  bodies: BodyRange[];
  hidden: ReadonlySet<string>;
  onToggle(name: string): void;
  onSelect(body: BodyRange): void;
  onAsk?(name: string, x: number, y: number): void;
  onSelectMember?(id: string): void;
}

const n = (x: number, digits = 3) => x.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });

export function BodiesPanel({ measurements: m, bodies, hidden, onToggle, onSelect, onAsk, onSelectMember }: Props) {
  if (!m || (bodies.length < 2 && !m.members.length)) return null;
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
      {m.members.length > 0 && (
        <>
          <h2>Members</h2>
          <table className="members" data-testid="members">
            <thead>
              <tr>
                <th>Size</th>
                <th className="num">Length</th>
                <th className="num">Qty</th>
                <th className="num">kg</th>
              </tr>
            </thead>
            <tbody>
              {cutList(m.members).map((g) => (
                <tr key={g.item} data-testid="member-row" title={g.members.join(", ")} onClick={() => onSelectMember?.(g.members[0])}>
                  <td>{g.designation}</td>
                  <td className="num">{n(g.length, 1)}</td>
                  <td className="num">{g.quantity}</td>
                  <td className="num">{n(g.kgTotal, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
