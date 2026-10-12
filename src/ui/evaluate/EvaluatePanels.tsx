// The Evaluate panels over the 3D view: Measure (stays open while you pick),
// Mass Properties, Section view; and the small box that edits a value in
// place (a dimension shown on the model, a handle's value). Thin: the numbers
// come from measure.ts, the kernel and inertia.ts.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Vec3 } from "../../doc/types";
import { principal, tensorOf, type MassBody } from "../../geom/inertia";
import type { MassProperties } from "../../kernel/evaluate";
import { NumberInput, type NumberValue } from "../fields";
import { Icon } from "../icons";
import { fmt } from "../model/selection";
import { rowText, type MeasureResult, type MeasureRow } from "./measure";
import { extentAlong, type SectionState } from "./section";

/** Copies text to the clipboard; says so for a moment. */
function CopyButton({ text, testId, label = "Copy" }: { text: string; testId?: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      className="copy"
      title={done ? "Copied" : `${label}: ${text}`}
      aria-label={`${label} ${text}`}
      data-testid={testId}
      data-copied={done || undefined}
      onClick={() => {
        void navigator.clipboard?.writeText(text).catch(() => undefined);
        setDone(true);
      }}
    >
      <Icon name={done ? "check" : "copy"} size={13} />
    </button>
  );
}

function Panel({ title, icon, testId, onClose, children, actions }: { title: string; icon: Parameters<typeof Icon>[0]["name"]; testId: string; onClose(): void; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="eval-panel" data-testid={testId} aria-label={title}>
      <header>
        <Icon name={icon} />
        <h3>{title}</h3>
        {actions}
        <button className="close" aria-label={`Close ${title}`} title="Close" onClick={onClose} data-testid={`${testId}-close`}>
          <Icon name="x" size={14} />
        </button>
      </header>
      {children}
    </section>
  );
}

const xyz = (v: Vec3) => `X ${fmt(v[0])}  Y ${fmt(v[1])}  Z ${fmt(v[2])}`;

function Row({ r }: { r: MeasureRow }) {
  const text = rowText(r);
  return (
    <tr data-testid={`measure-row-${r.key}`}>
      <th>{r.label}</th>
      <td className="value" data-testid={`measure-value-${r.key}`}>
        {r.xyz ? xyz(r.xyz) : r.value !== undefined ? `${fmt(r.value)}${r.unit === "°" ? "°" : r.unit ? ` ${r.unit}` : ""}` : r.text}
      </td>
      <td>{(r.xyz || r.value !== undefined) && <CopyButton text={text} testId={`measure-copy-${r.key}`} />}</td>
    </tr>
  );
}

/** Measure: what is picked, and the numbers between. Picks add up to two; a third starts again. */
export function MeasurePanel({ result, busy, error, onClose, onClear }: { result: MeasureResult; busy: boolean; error: string | null; onClose(): void; onClear(): void }) {
  return (
    <Panel
      title="Measure"
      icon="measure"
      testId="measure-panel"
      onClose={onClose}
      actions={
        <button className="link" onClick={onClear} title="Pick again from nothing" data-testid="measure-clear">
          Clear
        </button>
      }
    >
      {result.rows.length === 0 ? (
        <p className="muted small">Click faces, edges, vertices or planes: one for its size, two for the distance and angle between them. No Ctrl needed; a third pick starts again.</p>
      ) : (
        <>
          <p className="eval-title" data-testid="measure-title">
            {result.title}
          </p>
          <table className="eval-rows">
            <tbody>
              {result.rows.map((r) => (
                <Row key={r.key} r={r} />
              ))}
            </tbody>
          </table>
        </>
      )}
      {busy && <p className="muted small">Measuring…</p>}
      {error && (
        <p className="eval-error" data-testid="measure-error">
          {error}
        </p>
      )}
    </Panel>
  );
}

/** "48,000" with grouping, to `digits` decimals. */
function num(x: number, digits = 3): string {
  return x.toLocaleString("en-GB", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** The lines Mass Properties shows for one body (or all of them), as text: what Copy puts on the clipboard. */
export function massLines(b: MassBody): [label: string, value: string, key: string][] {
  const t = tensorOf(b.inertia);
  const p = principal(t);
  const i = b.inertia;
  return [
    ["Material", `${b.material} (${num(b.densityKgPerM3, 1)} kg/m³)`, "material"],
    ["Mass", `${num(b.mass, 6)} kg`, "mass"],
    ["Volume", `${num(b.volume)} mm³`, "volume"],
    ["Surface area", `${num(b.area)} mm²`, "area"],
    ["Centre of mass", xyz(b.centre), "com"],
    ["Ixx", `${num(i.ixx, 3)} kg·mm²`, "ixx"],
    ["Iyy", `${num(i.iyy, 3)} kg·mm²`, "iyy"],
    ["Izz", `${num(i.izz, 3)} kg·mm²`, "izz"],
    ["Pxy, Pxz, Pyz", `${num(i.pxy, 3)}, ${num(i.pxz, 3)}, ${num(i.pyz, 3)} kg·mm²`, "products"],
    ["Principal moments", `${p.moments.map((m) => num(m, 3)).join(", ")} kg·mm²`, "principal"],
  ];
}

function MassTable({ b, prefix }: { b: MassBody; prefix: string }) {
  return (
    <table className="eval-rows">
      <tbody>
        {massLines(b).map(([label, value, key]) => (
          <tr key={key}>
            <th>{label}</th>
            <td className="value" data-testid={`${prefix}${key}`}>
              {value}
            </td>
            <td>
              <CopyButton text={value} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Mass Properties: the whole part, then each body when there are several. Moments are about the centre of mass, along X, Y and Z. */
export function MassPanel({ mass, error, busy, onClose }: { mass: MassProperties | null; error: string | null; busy: boolean; onClose(): void }) {
  const all = mass?.total;
  const text = mass
    ? [all, ...(mass.bodies.length > 1 ? mass.bodies : [])]
        .filter((b): b is MassBody => !!b)
        .map((b) => [`${b.name === "total" ? "Whole part" : b.name}`, ...massLines(b).map(([l, v]) => `  ${l}: ${v}`)].join("\n"))
        .join("\n")
    : "";
  return (
    <Panel title="Mass properties" icon="massProperties" testId="mass-panel" onClose={onClose} actions={mass ? <CopyButton text={text} label="Copy all" testId="mass-copy-all" /> : null}>
      {busy && !mass && <p className="muted small">Measuring…</p>}
      {error && (
        <p className="eval-error" data-testid="mass-error">
          {error}
        </p>
      )}
      {mass && !all && <p className="muted small">There is no solid to weigh yet.</p>}
      {all && (
        <>
          <p className="eval-title">{mass!.bodies.length > 1 ? `Whole part (${mass!.bodies.length} bodies)` : "Whole part"}</p>
          <MassTable b={all} prefix="mass-" />
          <p className="muted small">Moments of inertia about the centre of mass (marked in the view), along X, Y and Z; principal moments about its principal axes.</p>
          {mass!.bodies.length > 1 &&
            mass!.bodies.map((b) => (
              <details key={b.name} data-testid={`mass-body-${b.name}`}>
                <summary>{b.name}</summary>
                <MassTable b={b} prefix={`mass-${b.name}-`} />
              </details>
            ))}
        </>
      )}
    </Panel>
  );
}

/** Section view: which plane, how far along it, which side is cut away. */
export function SectionPanel({
  section,
  choices,
  faceOk,
  box,
  onPlane,
  onChange,
  onClose,
}: {
  section: SectionState;
  choices: { id: string; label: string }[];
  /** A flat face is selected: "Selected face" can be chosen. */
  faceOk: boolean;
  box: { min: Vec3; max: Vec3 } | null;
  onPlane(on: string): void;
  onChange(next: SectionState): void;
  onClose(): void;
}) {
  const ext = extentAlong(section.normal, section.origin, box);
  const lo = Math.floor(Math.min(ext.min, section.offset));
  const hi = Math.ceil(Math.max(ext.max, section.offset));
  const step = hi - lo > 200 ? 1 : hi - lo > 20 ? 0.5 : 0.1;
  return (
    <Panel title="Section view" icon="section" testId="section-panel" onClose={onClose}>
      <label className="eval-field">
        <span>Plane</span>
        <select value={section.on} onChange={(e) => onPlane(e.target.value)} data-testid="section-plane">
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
          <option value="face" disabled={!faceOk && section.on !== "face"}>
            {section.on === "face" ? "Selected face" : faceOk ? "Selected face" : "Selected face (click a flat face first)"}
          </option>
        </select>
      </label>
      <label className="eval-field">
        <span>Offset</span>
        <input
          type="range"
          min={lo}
          max={hi}
          step={step}
          value={section.offset}
          onChange={(e) => onChange({ ...section, offset: Number(e.target.value) })}
          aria-label="Section offset"
          data-testid="section-offset-range"
        />
        <NumberInput value={Math.round(section.offset * 1000) / 1000} onCommit={(v: NumberValue) => typeof v === "number" && onChange({ ...section, offset: v })} testId="section-offset" ariaLabel="Section offset, mm" />
        <span className="unit">mm</span>
      </label>
      <label className="eval-check">
        <input type="checkbox" checked={section.flip} onChange={(e) => onChange({ ...section, flip: e.target.checked })} data-testid="section-flip" />
        Flip: cut away the other side
      </label>
      <p className="muted small">The cut faces show hatched. Picking skips what is cut away. Close to see the whole part again.</p>
    </Panel>
  );
}

/** A value edited where it is shown (a dimension on the model, a handle's depth): Enter applies, Escape closes. */
export function ValueBox({ x, y, title, value, onCommit, onClose, testId }: { x: number; y: number; title: string; value: NumberValue; onCommit(v: NumberValue): void; onClose(): void; testId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const input = ref.current?.querySelector("input");
    input?.focus();
    input?.select();
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="value-box" style={{ left: Math.min(x, window.innerWidth - 240), top: Math.min(y, window.innerHeight - 90) }} data-testid={testId} role="dialog" aria-label={title}>
      <div className="value-box-title">{title}</div>
      <NumberInput
        value={value}
        onCommit={(v) => {
          onCommit(v);
          onClose();
        }}
        testId={`${testId}-value`}
        ariaLabel={title}
      />
    </div>
  );
}
