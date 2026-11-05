// The annotation kinds' panels and handles of wave Q3A: the Dimension panel
// (its value, driven by the model, overridden with a warning; text before,
// after and below; n× and TYP; decimals; the tolerance with its fields and
// the ISO 286 fit editor showing the limits live; dual units; arrows; basic,
// reference, inspection; favourites), the hole callout's bore tolerance, and
// the grips every kind gets from the engine's layout (its text, its knee, a
// leader's bends, a cloud's corners) plus a dimension's arrowheads, which flip
// the arrows when clicked.

import { useState } from "react";
import type { Annotation, DimensionAnnotation, Vec2 } from "../../../doc/types";
import { dragGrip as engineDrag, type Grip as EngineGrip } from "../../../drafting/annotate";
import type { ComposedSheet } from "../../../drafting/compose";
import { TOLERANCE_KINDS, type Tolerance, type ToleranceKind } from "../../../drafting/tolerance";
import { parseFit } from "../../../drafting/fits";
import { annotationKind, annotationKinds, registerAnnotationKind, type Grip, type KindCtx, type KindPanelProps } from "./kinds";
import { applyFavourite, classChoices, COMMON_FITS, favouriteFrom, fitSummary, loadFavourites, storeFavourites, BUILT_IN_FAVOURITES } from "./styles";
import { Commit, numberOf, Row, Segmented, SymbolPalette } from "./ui";

// ------------------------------------------------------------ grips from the engine's layout

const gripId = (g: EngineGrip) => `${g.name}:${g.field}:${g.index ?? ""}`;
const GRIP_WORDS: Record<string, string> = { text: "Drag the text", line: "Drag the dimension line nearer or further", knee: "Drag the text and its leader's knee", symbol: "Drag the symbol", frame: "Drag the frame", end: "Drag the end", vertex: "Drag the corner" };

/** The annotation's grips as laid out: what the engine says can be dragged. */
function engineGrips(a: Record<string, unknown>, ctx: KindCtx): Grip[] {
  return (ctx.said?.grips ?? []).map((g) => ({ id: gripId(g), at: g.at, label: GRIP_WORDS[g.name] ?? "Drag it" }));
}

/** The patch a dragged engine grip makes: the annotation as the engine moves it (keys it drops come back as null). */
function engineDragPatch(a: Record<string, unknown>, grip: Grip, delta: Vec2, ctx: KindCtx): Record<string, unknown> | null {
  const g = (ctx.said?.grips ?? []).find((x) => gripId(x) === grip.id);
  if (!g) return null;
  const next = engineDrag(a as unknown as Annotation, g, [g.at[0] + delta[0], g.at[1] + delta[1]], ctx.sheet) as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = { ...next };
  for (const k of Object.keys(a)) if (!(k in next)) patch[k] = null;
  delete patch.id;
  return patch;
}

/** A linear dimension's arrowheads (the two ends of its line): a click flips the arrows inside or outside. */
function arrowGrips(a: Record<string, unknown>, ctx: KindCtx): Grip[] {
  const place = ctx.said?.place;
  const cv = ctx.sheet.views.find((v) => v.id === a.view);
  if (!place || place.pts.length !== 4 || !cv) return [];
  return [2, 3].map((i) => ({ id: `arrow:${i}`, at: [cv.centre[0] + place.pts[i][0], cv.centre[1] + place.pts[i][1]] as Vec2, label: "Click: arrows inside or outside", click: true }));
}

const dimension = annotationKind("dimension")!;
const oldGrips = dimension.grips;
const oldDrag = dimension.dragGrip;

registerAnnotationKind({
  ...dimension,
  grips: (a, ctx) => {
    const text = engineGrips(a, ctx).filter((g) => !g.id.startsWith("line:"));
    const line = (oldGrips?.(a, ctx) ?? []).map((g) => ({ ...g, id: "offset" }));
    return [...line, ...text, ...arrowGrips(a, ctx)];
  },
  dragGrip: (a, grip, delta, ctx) => {
    if (grip.id.startsWith("arrow:")) {
      const now = (a.arrows as string | undefined) ?? "auto";
      return { arrows: now === "outside" ? "inside" : "outside" };
    }
    if (grip.id === "offset") return oldDrag?.(a, grip, delta, ctx) ?? null;
    return engineDragPatch(a, grip, delta, ctx);
  },
  panel: (p) => <DimensionPanel {...p} />,
});

// Every other kind: the engine's grips, unless it has its own.
for (const k of annotationKinds()) {
  if (k.type === "dimension" || k.type === "table" || k.type === "centerMark" || k.type === "centerline") continue;
  const own = k.grips;
  registerAnnotationKind({
    ...k,
    grips: (a, ctx) => {
      const g = engineGrips(a, ctx);
      const extra = k.type === "note" ? leaderGrips(a, ctx) : [];
      return g.length ? [...g, ...extra] : [...(own?.(a, ctx) ?? []), ...extra];
    },
    dragGrip: (a, grip, delta, ctx) => {
      if (grip.id.startsWith("leader:")) return dragLeader(a, grip, delta);
      if (grip.id.includes(":")) return engineDragPatch(a, grip, delta, ctx);
      return k.dragGrip?.(a, grip, delta, ctx) ?? null;
    },
  });
}

// ------------------------------------------------------------ a note's leaders

type LeaderData = { to: string | Vec2; via?: Vec2[]; arrow?: string; spline?: boolean };

/** A note's leaders' bends and free ends (sheet points; in a view, from its centre). */
function leaderGrips(a: Record<string, unknown>, ctx: KindCtx): Grip[] {
  const leaders = (a.leaders as LeaderData[] | undefined) ?? [];
  const cv = typeof a.view === "string" ? ctx.sheet.views.find((v) => v.id === a.view) : undefined;
  const o: Vec2 = cv ? cv.centre : [0, 0];
  const out: Grip[] = [];
  leaders.forEach((l, i) => {
    (l.via ?? []).forEach((p, j) => out.push({ id: `leader:${i}:via:${j}`, at: [o[0] + p[0], o[1] + p[1]], label: "Drag the leader's bend" }));
    if (Array.isArray(l.to)) out.push({ id: `leader:${i}:to`, at: [o[0] + l.to[0], o[1] + l.to[1]], label: "Drag the leader's end" });
  });
  return out;
}

function dragLeader(a: Record<string, unknown>, grip: Grip, delta: Vec2): Record<string, unknown> | null {
  const [, i, what, j] = grip.id.split(":");
  const leaders = [...((a.leaders as LeaderData[] | undefined) ?? [])].map((l) => ({ ...l }));
  const l = leaders[Number(i)];
  if (!l) return null;
  const mv = (p: Vec2): Vec2 => [Math.round((p[0] + delta[0]) * 10) / 10, Math.round((p[1] + delta[1]) * 10) / 10];
  if (what === "via" && l.via) l.via = l.via.map((p, k) => (k === Number(j) ? mv(p) : p));
  else if (what === "to" && Array.isArray(l.to)) l.to = mv(l.to);
  return { leaders };
}

// ------------------------------------------------------------ the tolerance editor

const KIND_WORDS: Record<ToleranceKind, string> = {
  symmetric: "± symmetric",
  bilateral: "+/− deviations",
  limit: "Limits (max over min)",
  fit: "Fit (class only)",
  fitWithTol: "Fit with deviations",
  fitLimits: "Fit with limits",
  basic: "Basic (boxed)",
  reference: "Reference (in brackets)",
  min: "MIN",
  max: "MAX",
};

/** A tolerance: its kind, its numbers or its ISO 286 class with the limits it gives at this size. */
export function ToleranceEditor({ value, size, symbol, onChange, prefix, angle }: { value: Tolerance | undefined; size: number | undefined; symbol: string; onChange(t: Tolerance | null): string | null; prefix: string; angle?: boolean }) {
  const [error, setError] = useState("");
  const set = (t: Tolerance | null) => setError(onChange(t) ?? "");
  const kind = value?.kind;
  const fit = value?.fit ? parseFit(value.fit) : null;
  const holeClass = fit?.hole ? `${fit.hole.letter}${fit.hole.grade}` : "";
  const shaftClass = fit?.shaft ? `${fit.shaft.letter}${fit.shaft.grade}` : "";
  const isFit = kind === "fit" || kind === "fitWithTol" || kind === "fitLimits";
  const setFit = (hole: string, shaft: string) => {
    const code = hole && shaft ? `${hole}/${shaft}` : hole || shaft;
    if (!code) return set(null);
    set({ kind: isFit ? kind! : "fitWithTol", fit: code, ...(value?.precision !== undefined ? { precision: value.precision } : {}) });
  };
  const num = (k: "plus" | "minus", s: string) => {
    const n = numberOf(s);
    if (n !== undefined && !Number.isFinite(n)) return setError(`${k === "plus" ? "Plus" : "Minus"} must be a number (got "${s}")`);
    set({ ...(value ?? { kind: "symmetric" }), [k]: n } as Tolerance);
  };
  const summary = size && value?.fit && isFit ? fitSummary(size, value.fit, symbol) : null;
  const kinds = TOLERANCE_KINDS.filter((k) => !angle || !k.startsWith("fit"));
  return (
    <div className="tolerance-editor" data-testid={`${prefix}-tolerance`}>
      <Row label="Tolerance">
        <select
          value={kind ?? ""}
          onChange={(e) => {
            const k = e.target.value as ToleranceKind | "";
            if (!k) return set(null);
            if (k === "symmetric") return set({ kind: k, plus: value?.plus && value.plus > 0 ? value.plus : 0.1 });
            if (k === "bilateral" || k === "limit") return set({ kind: k, plus: value?.plus ?? 0.1, minus: value?.minus ?? 0 });
            if (k === "fit" || k === "fitWithTol" || k === "fitLimits") return set({ kind: k, fit: value?.fit ?? (symbol === "Ø" ? "H7" : "H7") });
            set({ kind: k });
          }}
          data-testid={`${prefix}-tol-kind`}
        >
          <option value="">none (the general tolerance)</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {KIND_WORDS[k]}
            </option>
          ))}
        </select>
      </Row>
      {(kind === "symmetric" || kind === "bilateral" || kind === "limit") && (
        <div className="tol-fields">
          <Row label={kind === "symmetric" ? "±" : "Plus"}>
            <Commit value={value?.plus !== undefined ? String(value.plus) : ""} onCommit={(s) => num("plus", s)} testId={`${prefix}-tol-plus`} numeric width={80} />
          </Row>
          {kind !== "symmetric" && (
            <Row label="Minus" hint="How far under the size it may be (0: none under)">
              <Commit value={value?.minus !== undefined ? String(value.minus) : ""} onCommit={(s) => num("minus", s)} testId={`${prefix}-tol-minus`} numeric width={80} />
            </Row>
          )}
        </div>
      )}
      {isFit && (
        <>
          <div className="tol-fields">
            <Row label="Hole" hint="ISO 286 hole class: its deviations at this size">
              <select value={holeClass} onChange={(e) => setFit(e.target.value, shaftClass)} data-testid={`${prefix}-fit-hole`}>
                <option value="">—</option>
                {(size ? classChoices(size, "hole") : []).map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
                {holeClass && size && !classChoices(size, "hole").some((c) => c.value === holeClass) && <option value={holeClass}>{holeClass}</option>}
              </select>
            </Row>
            <Row label="Shaft" hint="ISO 286 shaft class: its deviations at this size">
              <select value={shaftClass} onChange={(e) => setFit(holeClass, e.target.value)} data-testid={`${prefix}-fit-shaft`}>
                <option value="">—</option>
                {(size ? classChoices(size, "shaft") : []).map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
                {shaftClass && size && !classChoices(size, "shaft").some((c) => c.value === shaftClass) && <option value={shaftClass}>{shaftClass}</option>}
              </select>
            </Row>
          </div>
          <div className="fit-chips" role="group" aria-label="Common fits">
            {COMMON_FITS.map((f) => (
              <button key={f} type="button" className={`chip${value?.fit === f ? " on" : ""}`} onClick={() => set({ kind: kind!, fit: f })} data-testid={`${prefix}-fit-${f.replace("/", "-")}`}>
                {f}
              </button>
            ))}
          </div>
          {summary && (
            <div className={`fit-summary ${summary.type ?? ""}`} data-testid={`${prefix}-fit-summary`}>
              {summary.lines.map((l) => (
                <div key={l}>{l}</div>
              ))}
            </div>
          )}
        </>
      )}
      {kind && kind !== "basic" && kind !== "reference" && kind !== "min" && kind !== "max" && kind !== "fit" && (
        <Row label="Deviation decimals">
          <select
            value={value?.precision ?? ""}
            onChange={(e) => {
              const p = e.target.value === "" ? undefined : Number(e.target.value);
              const next = { ...value! } as Tolerance;
              if (p === undefined) delete next.precision;
              else next.precision = p;
              set(next);
            }}
            data-testid={`${prefix}-tol-precision`}
          >
            <option value="">as needed</option>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Row>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------ the Dimension panel

function DimensionPanel({ a, said, write, env }: KindPanelProps) {
  const d = a as unknown as DimensionAnnotation;
  const [favName, setFavName] = useState("");
  const [msg, setMsg] = useState("");
  const kind = d.kind ?? "linear";
  const angle = kind === "angular";
  const radial = kind === "diameter" || kind === "radius";
  const symbol = kind === "diameter" ? "Ø" : kind === "radius" ? "R" : "";
  const value = said?.value;
  const places = d.precision ?? env.drawing.precision;
  const shown = value === undefined ? "—" : `${symbol}${angle ? `${Math.round(value * 100) / 100}°` : value.toFixed(places ?? (Number.isInteger(Math.round(value * 1000) / 1000) ? 0 : 2))}`;
  const favs = [...BUILT_IN_FAVOURITES, ...loadFavourites()];
  const put = (patch: Record<string, unknown>) => setMsg(write(patch) ?? "");
  const tolKind = d.tolerance?.kind;
  return (
    <div className="dim-panel" data-testid="dim-panel">
      <div className="dim-value">
        <span className="dim-value-label">Value</span>
        <span className="dim-value-number mono" data-testid="dim-value">
          {shown}
        </span>
        <span className={`badge${d.override ? " warn" : ""}`}>{d.override ? "overridden" : "driven by the model"}</span>
      </div>
      <Row label="Override" hint="Text written instead of the measured value: it no longer follows the model">
        <Commit value={d.override ?? ""} placeholder="the measured value" onCommit={(s) => put({ override: s.trim() || null })} testId="dim-override" />
      </Row>
      {d.override && (
        <p className="warn-line" role="alert" data-testid="dim-override-warning">
          ⚠ The model measures {shown}; this dimension shows “{d.override}” and won't follow changes. Clear the override to drive it again.
        </p>
      )}
      <Row label="Favourite">
        <span className="fav-row">
          <select
            value=""
            onChange={(e) => {
              const f = favs.find((x) => x.name === e.target.value);
              if (!f) return;
              const p = applyFavourite(d, f);
              if (typeof p === "string") return setMsg(p);
              put(p);
            }}
            data-testid="dim-fav"
          >
            <option value="">apply…</option>
            {favs.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
          <input value={favName} placeholder="name" onChange={(e) => setFavName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} style={{ width: 80 }} data-testid="dim-fav-name" />
          <button
            type="button"
            onClick={() => {
              const f = favouriteFrom(favName, d);
              if (typeof f === "string") return setMsg(f);
              storeFavourites([...loadFavourites().filter((x) => x.name !== f.name), f]);
              setFavName("");
              setMsg(`Saved “${f.name}”: it is in the list of favourites and in Smart Dimension's styles.`);
            }}
            data-testid="dim-fav-save"
          >
            Save
          </button>
        </span>
      </Row>
      <ToleranceEditor value={d.tolerance} size={value} symbol={symbol} angle={angle} prefix="dim" onChange={(t) => write({ tolerance: t })} />
      <div className="dim-text">
        <Row label="Before">
          <Commit value={d.prefix ?? ""} placeholder="Ø, SR, 4×" onCommit={(s) => put({ prefix: s || null })} testId="dim-prefix" />
        </Row>
        <SymbolPalette testId="dim-symbols" onPick={(ch) => put({ prefix: `${d.prefix ?? ""}${ch}` })} />
        <Row label="After">
          <Commit value={d.suffix ?? ""} placeholder="THRU" onCommit={(s) => put({ suffix: s || null })} testId="dim-suffix" />
        </Row>
        <Row label="Below">
          <Commit value={d.below ?? ""} placeholder="2 PLACES" onCommit={(s) => put({ below: s || null })} testId="dim-below" />
        </Row>
        <div className="tol-fields">
          <Row label="Count n×">
            <Commit value={d.count ? String(d.count) : ""} placeholder="1" numeric width={56} onCommit={(s) => {
              const n = numberOf(s);
              if (n !== undefined && (!Number.isInteger(n) || n < 1)) return setMsg(`Count is how many alike features, a whole number (got "${s}")`);
              put({ count: n && n > 1 ? n : null });
            }} testId="dim-count" />
          </Row>
          <label className="check">
            <input type="checkbox" checked={!!d.typ} onChange={(e) => put({ typ: e.target.checked || null })} data-testid="dim-typ" /> TYP
          </label>
        </div>
      </div>
      <div className="tol-fields">
        <Row label="Decimals">
          <select value={d.precision ?? ""} onChange={(e) => put({ precision: e.target.value === "" ? null : Number(e.target.value) })} data-testid="dim-precision">
            <option value="">drawing's ({env.drawing.precision ?? "as needed"})</option>
            {[0, 1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "12" : `12.${"0".repeat(n)}`}
              </option>
            ))}
          </select>
        </Row>
        <label className="check" title="The other unit too, in brackets">
          <input type="checkbox" checked={d.dual ?? env.drawing.dualUnits ?? false} onChange={(e) => put({ dual: e.target.checked })} data-testid="dim-dual" /> Dual units
        </label>
      </div>
      {radial && d.refs?.length === 1 && (
        <Row label="Display as">
          <Segmented label="Display as" value={kind as "diameter" | "radius"} options={[["diameter", "Ø diameter"], ["radius", "R radius"]]} onChange={(k) => put({ kind: k })} testId="dim-as" />
        </Row>
      )}
      <Row label="Arrows" hint="Click an arrowhead on the sheet to flip them">
        <Segmented label="Arrows" value={d.arrows ?? "auto"} options={[["auto", "Auto"], ["inside", "Inside"], ["outside", "Outside"]]} onChange={(v) => put({ arrows: v === "auto" ? null : v })} testId="dim-arrows" />
      </Row>
      <div className="dim-flags">
        <label className="check">
          <input type="checkbox" checked={!!d.flip} onChange={(e) => put({ flip: e.target.checked || null })} data-testid="dim-flip" /> Flip
        </label>
        <label className="check" title="The theoretically exact size, boxed (GD&T)">
          <input type="checkbox" checked={tolKind === "basic"} onChange={(e) => put({ tolerance: e.target.checked ? { kind: "basic" } : null })} data-testid="dim-basic" /> Basic
        </label>
        <label className="check" title="For information, in brackets">
          <input type="checkbox" checked={tolKind === "reference"} onChange={(e) => put({ tolerance: e.target.checked ? { kind: "reference" } : null })} data-testid="dim-reference" /> Reference
        </label>
        <label className="check" title="Checked at inspection: in an oval">
          <input type="checkbox" checked={!!d.inspection} onChange={(e) => put({ inspection: e.target.checked || null })} data-testid="dim-inspection" /> Inspection
        </label>
      </div>
      {msg && (
        <p className={msg.startsWith("Saved") ? "muted small" : "field-error"} role="status">
          {msg}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------ the hole callout's bore tolerance

const hole = annotationKind("hole")!;
registerAnnotationKind({
  ...annotationKind("hole")!,
  panel: ({ a, write, env }) => {
    const sheet = env.sheet as ComposedSheet | null;
    const rec = sheet?.points.holes.get(String(a.hole));
    return <ToleranceEditor value={a.tolerance as Tolerance | undefined} size={rec?.diameter} symbol="Ø" prefix="hole" onChange={(t) => write({ tolerance: t })} />;
  },
});
void hole;
