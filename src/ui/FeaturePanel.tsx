import type { RebuildView } from "../worker/protocol";

const OP_LABEL: Record<string, string> = {
  sketch: "Sketch",
  extrude: "Extrude",
  cut: "Cut",
  hole: "Hole",
};

export function FeaturePanel({ view, onSelect }: { view: RebuildView | null; onSelect: (id: string) => void }) {
  const headerErrors = view?.errors.filter((e) => e.startsWith("document:")) ?? [];
  return (
    <section className="panel features" aria-label="Feature tree">
      <h2>Features</h2>
      {!view && <p className="muted">No rebuild yet.</p>}
      <ol className="feature-list">
        {view?.features.map((f) => (
          <li key={f.id} className={f.ok ? "ok" : "failed"} data-testid={`feature-${f.id}`}>
            <button className="feature-row" onClick={() => onSelect(f.id)} title="Show in the document">
              <span className={`badge ${f.ok ? "ok" : "failed"}`} aria-label={f.ok ? "rebuilt" : "failed"}>
                {f.ok ? "✓" : "!"}
              </span>
              <span className="feature-op">{OP_LABEL[f.op] ?? f.op}</span>
              <span className="feature-id">{f.id}</span>
            </button>
            {f.error && (
              <div className="feature-error">
                {f.error.split("\n").map((line) => (
                  <div key={line}>{line.replace(`${f.id}: `, "")}</div>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
      {headerErrors.map((e) => (
        <div key={e} className="feature-error standalone">
          {e}
        </div>
      ))}
    </section>
  );
}
