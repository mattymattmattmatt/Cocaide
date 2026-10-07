import type { Measurements } from "../kernel";

const n = (x: number, digits = 3) =>
  x.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });

export function MeasurementsPanel({ measurements: m }: { measurements: Measurements | null }) {
  return (
    <section className="panel measurements" aria-label="Measurements">
      <h2>Measurements</h2>
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
          <dd title={`${m.mass.material}, ${m.mass.densityKgPerM3} kg/m³`}>
            {n(m.mass.kg * 1000, 1)} g <span className="muted">({m.mass.material})</span>
          </dd>
          <dt>Holes</dt>
          <dd data-testid="holes">
            {m.holeCount === 0
              ? "none"
              : `${m.holeCount} · Ø ${m.holes.map((h) => h.diameters.map((d) => n(d)).join("/")).join(", ")}`}
          </dd>
          <dt>Topology</dt>
          <dd>
            {m.solids} solid{m.solids === 1 ? "" : "s"} · {m.faces} faces
          </dd>
        </dl>
      )}
    </section>
  );
}
