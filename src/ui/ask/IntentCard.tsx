// The confirmation card (spec 5.1, 5.2): what was read from the request or
// drawing, where each number came from, and blanks for what is missing or
// unsure. Nothing is built until every blank is filled. A drawing's card is
// shown beside the drawing, and building it is the user's confirmation.

import { useState } from "react";
import type { PreparedDrawing } from "../../drawing/rasterize";
import type { Review, Row } from "../../intent/review";
import { PLACEMENTS } from "../../intent/constants";

type Answer = number | string | { x: number; y: number }[];

interface Props {
  review: Review;
  onBuild(answers: Record<string, Answer>): void;
  /** The drawing the rows were read from: shown beside them. */
  drawing?: PreparedDrawing;
  views?: string[];
}

const PLACEMENT_LABEL: Record<string, string> = {
  corners: "one near each corner",
  center: "in the centre",
  grid: "in a grid",
  points: "at given points",
  circle: "on a circle",
};

export function IntentCard({ review, onBuild, drawing, views }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [zoom, setZoom] = useState(false);
  const editable = review.rows.filter((r) => r.source !== "placement");
  const parsed = (r: Row): Answer | undefined => parse(r, values[r.path]);
  const missing = review.blanks.filter((r) => parsed(r) === undefined);

  const build = () => {
    const answers: Record<string, Answer> = {};
    for (const r of editable) {
      const v = parsed(r);
      if (v !== undefined && (r.blank || JSON.stringify(v) !== JSON.stringify(r.value))) answers[r.path] = v;
    }
    onBuild(answers);
  };

  const page = drawing?.pages[0];
  const src = page ? `data:image/png;base64,${page.png}` : null;
  return (
    <div className="intent-card" data-testid="intent-card">
      {drawing && src && (
        <div className="intent-drawing">
          <button className="drawing-thumb" onClick={() => setZoom(true)} title="Open the drawing to check the numbers" data-testid="drawing-thumb">
            <img src={src} alt={`${drawing.name}, page 1`} />
          </button>
          <div className="muted small">
            {drawing.name}
            {drawing.dpi ? ` · ${drawing.pageCount} page${drawing.pageCount === 1 ? "" : "s"} at ${drawing.dpi} dpi` : " · scan"}
            {drawing.text ? " · text layer" : ""}
            {drawing.legibility.blurry && <span className="why"> · too blurry to read</span>}
            {views?.length ? <div>Views: {views.join(", ")}</div> : null}
          </div>
        </div>
      )}
      {zoom && src && (
        <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setZoom(false)} data-testid="drawing-zoom">
          <img className="drawing-full" src={src} alt={drawing!.name} onClick={() => setZoom(false)} />
        </div>
      )}
      {review.problems.map((p) => (
        <div key={p} className="command-error" role="alert">
          {p}
        </div>
      ))}
      <table className="intent-rows">
        <tbody>
          {editable.map((r) => (
            <tr key={r.path} className={r.blank ? "blank" : ""} data-testid={`intent-row-${r.path}`}>
              <th>
                {r.label}
                {r.askFirst && (
                  <span className="ask-first" title="Ask-first: never guessed">
                    *
                  </span>
                )}
              </th>
              <td>{input(r, values[r.path], (v) => setValues({ ...values, [r.path]: v }))}</td>
              <td className="intent-source">{source(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ask-buttons">
        <button className="primary" disabled={missing.length > 0 || review.problems.length > 0} onClick={build} data-testid="intent-build">
          {drawing ? "Confirm and build" : "Build"}
        </button>
        <span className="muted small">{missing.length ? `${missing.length} to fill` : drawing ? "Check each value against the drawing" : "Ready to build"}</span>
      </div>
    </div>
  );
}

function input(r: Row, draft: string | undefined, set: (v: string) => void) {
  const shown = draft ?? (r.value === null ? "" : r.kind === "points" ? formatPoints(r.value as { x: number; y: number }[]) : String(r.value));
  const id = `intent-input-${r.path}`;
  if (r.kind === "choice") {
    return (
      <select value={shown} onChange={(e) => set(e.target.value)} data-testid={id} aria-label={r.label}>
        <option value="">choose…</option>
        {(r.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (r.kind === "placement") {
    return (
      <select value={shown} onChange={(e) => set(e.target.value)} data-testid={id} aria-label={r.label}>
        <option value="">where?</option>
        {PLACEMENTS.filter((p) => p !== "unspecified").map((p) => (
          <option key={p} value={p}>
            {PLACEMENT_LABEL[p]}
          </option>
        ))}
      </select>
    );
  }
  return (
    <span className="intent-input">
      <input
        value={shown}
        inputMode={r.kind === "number" ? "decimal" : "text"}
        placeholder={r.kind === "points" ? "x,y; x,y" : r.kind === "question" ? "your answer" : r.blank ? "?" : r.kind === "text" ? "—" : ""}
        onChange={(e) => set(e.target.value)}
        data-testid={id}
        aria-label={r.label}
      />
      {r.unit && <span className="unit">{r.unit}</span>}
    </span>
  );
}

function source(r: Row) {
  if (r.blank) return <span className="why">{r.note ?? "missing"}</span>;
  if (r.source === "entered") return <span>you entered it</span>;
  if (r.source === "placement") return <span>from the placement</span>;
  if (r.note) return <span className="muted">{r.note}</span>;
  const conf = r.confidence < 1 ? ` (${Math.round(r.confidence * 100)}%)` : "";
  if (r.source === "standard") return <span>standard: “{r.evidence}”</span>;
  return <span>{r.evidence ? `“${r.evidence}”` : r.source}{conf}</span>;
}

function parse(r: Row, draft: string | undefined): Answer | undefined {
  const text = (draft ?? (r.value === null ? "" : r.kind === "points" ? formatPoints(r.value as { x: number; y: number }[]) : String(r.value))).trim();
  if (!text) return undefined;
  switch (r.kind) {
    case "number": {
      const n = Number(text);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    }
    case "placement":
    case "choice":
    case "text":
    case "question":
      return text;
    case "points": {
      const pts = text.split(/[;\n]/).map((p) => p.trim()).filter(Boolean).map((p) => p.replace(/[()]/g, "").split(/[ ,]+/).map(Number));
      return pts.length && pts.every((p) => p.length === 2 && p.every(Number.isFinite)) ? pts.map(([x, y]) => ({ x, y })) : undefined;
    }
  }
}

function formatPoints(pts: { x: number; y: number }[]): string {
  return pts.map((p) => `${p.x},${p.y}`).join("; ");
}
