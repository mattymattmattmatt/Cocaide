import type { Measurements } from "../kernel";
import { Section } from "./Section";

const n = (x: number, digits = 3) =>
  x.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });

export function MeasurementsPanel({ measurements: m }: { measurements: Measurements | null }) {
  return (
    <Section title="Measurements" className="measurements">
      {!m ? (
        <p className="muted">No solid.</p>
      ) : (
        <dl data-testid="measurements">
          <dt>Bounding box</dt>
          <dd>{m.boundingBox ? m.boundingBox.size.map((s) => n(s)).join(" × ") + " mm" : "—"}</dd>
          <dt>Volume</dt>
          <dd data-testid="volume">{n(m.volume)} mm³</dd>
          <dt>Surface area</dt>
          <dd>{n(m.surfaceArea)} mm²</dd>
          <dt>Mass</dt>
          <dd title={new Set(m.bodies.map((b) => b.material)).size > 1 ? `${m.mass.material}: each body in its own (see Bodies)` : `${m.mass.material}, ${m.mass.densityKgPerM3} kg/m³`} data-testid="mass">
            {m.mass.kg < 1 ? `${n(m.mass.kg * 1000, 1)} g` : `${n(m.mass.kg, 2)} kg`} <span className="muted">· {m.mass.material}</span>
          </dd>
          <dt>Holes</dt>
          <dd data-testid="holes">
            {m.holeCount === 0 ? "none" : groupHoles(m.holes.map((h) => h.diameters.map((d) => n(d)).join("/")))}
          </dd>
          <dt>Topology</dt>
          <dd>
            {m.solids} solid{m.solids === 1 ? "" : "s"} · {m.faces} faces
          </dd>
        </dl>
      )}
    </Section>
  );
}

/** "6.6, 6.6, 9/14" -> "2 × Ø6.6, 1 × Ø9/14": how many of each size. */
function groupHoles(sizes: string[]): string {
  const counts = new Map<string, number>();
  for (const sz of sizes) counts.set(sz, (counts.get(sz) ?? 0) + 1);
  return [...counts].map(([sz, k]) => `${k} × Ø${sz}`).join(", ");
}
