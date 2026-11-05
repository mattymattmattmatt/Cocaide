// Small pieces of the annotation tools' panels (Phase Q wave Q3A): a row of
// choices, a labelled field, a number box that commits on Enter or blur, a
// symbol palette, and a sheet primitives thumbnail (a frame or weld symbol
// drawn as it will be on the sheet).

import { useState, type ReactNode } from "react";
import type { Prim } from "../../../drafting/sheet";
import { SHEET_FONT } from "../../../drafting/svg";

export function Segmented<T extends string>({ value, options, onChange, testId, label }: { value: T | undefined; options: readonly (readonly [T, string, string?])[]; onChange(v: T): void; testId: string; label: string }) {
  return (
    <div className="segmented wrap" role="radiogroup" aria-label={label}>
      {options.map(([v, text, title]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? "on" : ""} title={title} onClick={() => onChange(v)} data-testid={`${testId}-${v}`}>
          {text}
        </button>
      ))}
    </div>
  );
}

export function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field" title={hint}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

/** A text or number box that commits on Enter or when it loses focus. */
export function Commit({ value, onCommit, testId, placeholder, width, numeric }: { value: string; onCommit(v: string): void; testId: string; placeholder?: string; width?: number; numeric?: boolean }) {
  return (
    <input
      type="text"
      inputMode={numeric ? "decimal" : undefined}
      defaultValue={value}
      key={value}
      placeholder={placeholder}
      spellCheck={false}
      style={width ? { width } : undefined}
      onBlur={(e) => e.target.value !== value && onCommit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          (e.target as HTMLInputElement).value = value;
          (e.target as HTMLInputElement).blur();
        }
        e.stopPropagation();
      }}
      data-testid={testId}
    />
  );
}

/** A number read from a box: undefined for empty, NaN when it isn't one. */
export function numberOf(s: string): number | undefined {
  const t = s.trim().replace(",", ".");
  if (!t) return undefined;
  return Number(t);
}

/** The drafting symbols a note or a dimension's text takes, as buttons that insert them. */
export const SYMBOLS: [string, string][] = [
  ["Ø", "Diameter"],
  ["±", "Plus or minus"],
  ["°", "Degrees"],
  ["⌴", "Counterbore"],
  ["⌵", "Countersink"],
  ["↧", "Depth"],
  ["□", "Square"],
  ["×", "Times"],
  ["℄", "Centreline"],
  ["⌒", "Arc length"],
  ["Ⓜ", "Maximum material"],
  ["Ⓛ", "Least material"],
  ["Ⓟ", "Projected zone"],
  ["Ⓔ", "Envelope"],
  ["⏥", "Flatness"],
  ["⊥", "Perpendicularity"],
  ["∥", "Parallelism"],
  ["⌖", "Position"],
];

export function SymbolPalette({ onPick, testId }: { onPick(ch: string): void; testId: string }) {
  return (
    <div className="symbol-palette" role="toolbar" aria-label="Symbols" data-testid={testId}>
      {SYMBOLS.map(([ch, title]) => (
        <button key={ch} type="button" title={title} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(ch)} data-testid={`${testId}-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
          {ch}
        </button>
      ))}
    </div>
  );
}

/** Sheet primitives drawn small, fitted to their box: a frame, a weld symbol, a surface symbol as the sheet will have it. */
export function PrimThumb({ prims, testId, height = 64 }: { prims: Prim[]; testId: string; height?: number }) {
  const pts: [number, number][] = [];
  for (const p of prims) {
    if (p.k === "line") pts.push(...p.pts);
    else if (p.k === "circle") pts.push([p.c[0] - p.r, p.c[1] - p.r], [p.c[0] + p.r, p.c[1] + p.r]);
    else if (p.k === "text") pts.push([p.at[0] - (p.anchor === "start" ? 0 : p.size * p.text.length * 0.6), p.at[1] - p.size * 0.3], [p.at[0] + p.size * p.text.length * 0.6, p.at[1] + p.size]);
  }
  if (!pts.length) return <div className="prim-thumb empty" data-testid={testId} />;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const pad = 1.5;
  const x0 = Math.min(...xs) - pad;
  const x1 = Math.max(...xs) + pad;
  const y0 = Math.min(...ys) - pad;
  const y1 = Math.max(...ys) + pad;
  const y = (v: number) => -v;
  return (
    <svg className="prim-thumb" viewBox={`${x0} ${-y1} ${x1 - x0} ${y1 - y0}`} style={{ height }} preserveAspectRatio="xMidYMid meet" stroke="currentColor" fill="none" strokeLinecap="round" strokeLinejoin="round" data-testid={testId} role="img" aria-label="Preview">
      {prims.map((p, i) => {
        if (p.k === "line") {
          const s = p.pts.map((q) => `${q[0]},${y(q[1])}`).join(" ");
          return p.closed || p.fill ? <polygon key={i} points={s} strokeWidth={p.w} fill={p.fill ? "currentColor" : "none"} strokeDasharray={p.dash?.join(" ")} /> : <polyline key={i} points={s} strokeWidth={p.w} strokeDasharray={p.dash?.join(" ")} />;
        }
        if (p.k === "circle") return <circle key={i} cx={p.c[0]} cy={y(p.c[1])} r={p.r} strokeWidth={p.w} fill={p.fill ? "currentColor" : "none"} />;
        if (p.k === "area") return null;
        return (
          <text key={i} x={p.at[0]} y={y(p.at[1])} fontSize={p.size} textAnchor={p.anchor} fontWeight={p.bold ? "bold" : undefined} fontStyle={p.italic ? "italic" : undefined} transform={p.angle ? `rotate(${-p.angle} ${p.at[0]} ${y(p.at[1])})` : undefined} fill="currentColor" stroke="none" fontFamily={SHEET_FONT}>
            {p.text}
          </text>
        );
      })}
    </svg>
  );
}

/** A disclosure with its open state kept while the panel redraws. */
export function Fold({ title, children, open: start = false, testId }: { title: string; children: ReactNode; open?: boolean; testId?: string }) {
  const [open, setOpen] = useState(start);
  return (
    <div className={`fold-section${open ? " open" : ""}`}>
      <button type="button" className="fold-head" aria-expanded={open} onClick={() => setOpen(!open)} data-testid={testId}>
        <span className="fold-caret">{open ? "▾" : "▸"}</span> {title}
      </button>
      {open && <div className="fold-body">{children}</div>}
    </div>
  );
}
