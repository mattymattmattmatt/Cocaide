// The part's bodies (Phase H): each with its colour, volume and mass, and the
// pairs that overlap. Hide a body to see past it; click it to select its
// faces; right-click it to ask about that body alone. Below them, the
// members (Phase I): alike ones grouped as the cut list groups them.

import { useState } from "react";
import type { Material } from "../doc/types";
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
  /** Each body's own material, where it has one (Phase M). */
  materials?: Record<string, Material>;
  onMaterial?(body: string, material: Material | null): void;
  /** Adds a feature that deletes the body. */
  onDelete?(body: string): void;
  /** Saves the body as a part of its own. */
  onSave?(body: string): void;
}

/** Materials to pick from; anything else is typed as a density. */
export const MATERIALS: Material[] = [
  { name: "steel", densityKgPerM3: 7850 },
  { name: "stainless steel", densityKgPerM3: 8000 },
  { name: "aluminium 6061", densityKgPerM3: 2700 },
  { name: "brass", densityKgPerM3: 8500 },
  { name: "copper", densityKgPerM3: 8960 },
  { name: "titanium", densityKgPerM3: 4430 },
  { name: "nylon", densityKgPerM3: 1150 },
];

const n = (x: number, digits = 3) => x.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });

export function BodiesPanel({ measurements: m, bodies, hidden, onToggle, onSelect, onAsk, onSelectMember, materials = {}, onMaterial, onDelete, onSave }: Props) {
  const [open, setOpen] = useState<string | null>(null);
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
              {(onMaterial || onDelete || onSave) && (
                <button className="icon" aria-expanded={open === b.name} aria-label={`More for ${b.name}`} onClick={() => setOpen(open === b.name ? null : b.name)} data-testid={`body-more-${b.name}`}>
                  ⋯
                </button>
              )}
              {open === b.name && (
                <BodyDetails
                  name={b.name}
                  mass={mb ? `${n(mb.massKg, 3)} kg, ${mb.material}` : ""}
                  own={materials[b.name]}
                  onMaterial={onMaterial}
                  onDelete={onDelete && bodies.length > 1 ? () => onDelete(b.name) : undefined}
                  onSave={onSave && (() => onSave(b.name))}
                />
              )}
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

/** A body's material, and what can be done with it: delete it, or save it as a part. */
function BodyDetails({ name, mass, own, onMaterial, onDelete, onSave }: { name: string; mass: string; own?: Material; onMaterial?(body: string, m: Material | null): void; onDelete?(): void; onSave?(): void }) {
  const preset = own ? MATERIALS.findIndex((x) => x.name === own.name && x.densityKgPerM3 === own.densityKgPerM3) : -1;
  // "other…" on a preset opens its name and density to edit, starting from the preset's.
  const [editing, setEditing] = useState(false);
  const value = !own ? "part" : preset >= 0 && !editing ? String(preset) : "custom";
  return (
    <div className="body-details" data-testid={`body-details-${name}`}>
      <div className="body-mass muted">{mass}</div>
      {onMaterial && (
        <label className="field">
          <span className="field-label">Material</span>
          <select
            value={value}
            onChange={(e) => {
              const v = e.target.value;
              setEditing(v === "custom");
              if (v === "part") onMaterial(name, null);
              else if (v === "custom") {
                if (!own) onMaterial(name, { name: "custom", densityKgPerM3: 7850 });
              } else onMaterial(name, MATERIALS[Number(v)]);
            }}
            data-testid={`body-material-${name}`}
          >
            <option value="part">the part's</option>
            {MATERIALS.map((x, i) => (
              <option key={x.name} value={i}>
                {x.name} ({x.densityKgPerM3} kg/m³)
              </option>
            ))}
            <option value="custom">other…</option>
          </select>
        </label>
      )}
      {onMaterial && value === "custom" && own && (
        <div className="body-custom">
          <input defaultValue={own.name ?? ""} key={`n${own.name}`} aria-label="Material name" onBlur={(e) => e.target.value.trim() && e.target.value !== own.name && onMaterial(name, { ...own, name: e.target.value.trim() })} data-testid={`body-material-name-${name}`} />
          <input
            defaultValue={own.densityKgPerM3}
            key={`d${own.densityKgPerM3}`}
            aria-label="Density, kg/m³"
            onBlur={(e) => {
              const d = Number(e.target.value);
              if (Number.isFinite(d) && d > 0 && d !== own.densityKgPerM3) onMaterial(name, { ...own, densityKgPerM3: d });
            }}
            data-testid={`body-density-${name}`}
          />
          <span className="muted small">kg/m³</span>
        </div>
      )}
      <div className="body-actions">
        {onSave && (
          <button onClick={onSave} title="A part of its own: this part, keeping only this body" data-testid={`body-save-${name}`}>
            Save as part
          </button>
        )}
        {onDelete && (
          <button className="danger" onClick={onDelete} title="Adds a Delete body feature (Ctrl+Z undoes it)" data-testid={`body-delete-${name}`}>
            Delete body
          </button>
        )}
      </div>
    </div>
  );
}
