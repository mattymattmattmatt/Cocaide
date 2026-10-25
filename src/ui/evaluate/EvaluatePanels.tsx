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
import { extentAlong, MAX_SECTION_PLANES, MAX_TILT, removePlane, setPlane, tiltLabels, type SectionState, type SectionView } from "./section";

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
export function num(x: number, digits = 3): string {
  // Rounded first and + 0, so round-off below the shown digits never reads "-0".
  const f = 10 ** digits;
  return (Math.round(x * f) / f + 0).toLocaleString("en-GB", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
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

/**
 * Section view: up to three planes (Section 1/2/3), each with its plane, its
 * offset (or drag its arrow in the view), its tilt about its own two axes,
 * flip and on/off; then what all share: the planes drawn, the cap colour,
 * which bodies are cut. Folds to its title; closing it turns the section off
 * (the view bar's Section button brings it back as it was).
 */
export function SectionPanel({
  section,
  choices,
  faceOk,
  box,
  bodies,
  onPlane,
  onChange,
  onAdd,
  onClose,
}: {
  section: SectionView;
  choices: { id: string; label: string }[];
  /** A flat face is selected: "Selected face" can be chosen. */
  faceOk: boolean;
  box: { min: Vec3; max: Vec3 } | null;
  /** The part's bodies (a choice of which to cut when there are several). */
  bodies: string[];
  /** Plane i onto a default plane, a plane feature or the selected face. */
  onPlane(i: number, on: string): void;
  onChange(next: SectionView): void;
  onAdd(): void;
  onClose(): void;
}) {
  const i = Math.min(section.active, section.planes.length - 1);
  const plane = section.planes[i];
  const update = (next: SectionState) => onChange(setPlane(section, i, next));
  const ext = extentAlong(plane.normal, plane.origin, box);
  const lo = Math.floor(Math.min(ext.min, plane.offset));
  const hi = Math.ceil(Math.max(ext.max, plane.offset));
  const step = hi - lo > 200 ? 1 : hi - lo > 20 ? 0.5 : 0.1;
  const [tiltA, tiltB] = plane.tilt ?? [0, 0];
  const [labelA, labelB] = tiltLabels(plane);
  const setTilt = (k: 0 | 1, v: number) => {
    const t: [number, number] = [tiltA, tiltB];
    t[k] = Math.max(-MAX_TILT, Math.min(MAX_TILT, v));
    const { tilt: _old, ...rest } = plane;
    void _old;
    update(t[0] || t[1] ? { ...rest, tilt: t } : rest);
  };
  const cut = section.bodies;
  // The body list opens by itself when some bodies are left whole; after that it is the user's (ticking the last box back must not fold it away).
  const [bodiesOpen, setBodiesOpen] = useState(!!cut);
  const summary = section.planes.map((p, k) => `${section.planes.length > 1 ? `${k + 1}: ` : ""}${p.label}${p.enabled === false ? " (off)" : ""}`).join(" · ");
  return (
    <Panel
      title="Section view"
      icon="section"
      testId="section-panel"
      onClose={onClose}
      actions={
        <button
          className="link"
          onClick={() => onChange({ ...section, collapsed: !section.collapsed })}
          title={section.collapsed ? "Show the section's settings" : "Fold the panel to its title: the section stays on"}
          aria-expanded={!section.collapsed}
          data-testid="section-collapse"
        >
          <Icon name={section.collapsed ? "down" : "up"} size={13} />
        </button>
      }
    >
      {section.collapsed ? (
        <p className="muted small section-summary" data-testid="section-summary">
          {summary}
        </p>
      ) : (
        <>
          <div className="section-tabs" role="tablist" aria-label="Section planes">
            {section.planes.map((p, k) => (
              <button
                key={k}
                role="tab"
                aria-selected={k === i}
                className={p.enabled === false ? "off" : undefined}
                onClick={() => onChange({ ...section, active: k })}
                title={`${p.label}${p.enabled === false ? " (off)" : ""}`}
                data-testid={`section-tab-${k}`}
              >
                Section {k + 1}
              </button>
            ))}
            {section.planes.length < MAX_SECTION_PLANES && (
              <button className="section-add" onClick={onAdd} title="Another plane: the part is cut where it is on the cut side of every plane (a corner cut)" data-testid="section-add">
                <Icon name="plus" size={12} />
                Add
              </button>
            )}
          </div>
          <label className="eval-field">
            <span>Plane</span>
            <select value={plane.on} onChange={(e) => onPlane(i, e.target.value)} data-testid="section-plane">
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
              <option value="face" disabled={!faceOk && plane.on !== "face"}>
                {plane.on === "face" ? "Selected face" : faceOk ? "Selected face" : "Selected face (click a flat face first)"}
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
              value={plane.offset}
              onChange={(e) => update({ ...plane, offset: Number(e.target.value) })}
              aria-label="Section offset"
              data-testid="section-offset-range"
            />
            <NumberInput value={Math.round(plane.offset * 1000) / 1000} onCommit={(v: NumberValue) => typeof v === "number" && update({ ...plane, offset: v })} testId="section-offset" ariaLabel="Section offset, mm" />
            <span className="unit">mm</span>
          </label>
          <div className="eval-field section-tilt">
            <span title="Turn the plane about its own axes, about the point the offset puts it at">Tilt</span>
            <label title={`${labelA}, degrees`}>
              <span className="tilt-axis">{labelA.replace("Tilt about ", "")}</span>
              <NumberInput value={tiltA} onCommit={(v: NumberValue) => typeof v === "number" && setTilt(0, v)} testId="section-tilt-a" ariaLabel={`${labelA}, degrees`} />
            </label>
            <label title={`${labelB}, degrees`}>
              <span className="tilt-axis">{labelB.replace("Tilt about ", "")}</span>
              <NumberInput value={tiltB} onCommit={(v: NumberValue) => typeof v === "number" && setTilt(1, v)} testId="section-tilt-b" ariaLabel={`${labelB}, degrees`} />
            </label>
            <span className="unit">°</span>
          </div>
          <label className="eval-check">
            <input type="checkbox" checked={plane.flip} onChange={(e) => update({ ...plane, flip: e.target.checked })} data-testid="section-flip" />
            Flip: cut away the other side
          </label>
          {section.planes.length > 1 && (
            <div className="section-plane-checks">
                <label className="eval-check" title="Off: this plane cuts nothing (its settings are kept)">
                  <input
                    type="checkbox"
                    checked={plane.enabled !== false}
                    onChange={(e) => {
                      const { enabled: _was, ...rest } = plane;
                      void _was;
                      update(e.target.checked ? rest : { ...rest, enabled: false });
                    }}
                    data-testid="section-enabled"
                  />
                  Section {i + 1} cuts
                </label>
                <button className="link" onClick={() => onChange(removePlane(section, i))} title={`Remove Section ${i + 1}`} data-testid="section-remove">
                  Remove this plane
                </button>
            </div>
          )}
          <div className="section-shared">
            <label className="eval-check">
              <input type="checkbox" checked={section.showPlane} onChange={(e) => onChange({ ...section, showPlane: e.target.checked })} data-testid="section-show-plane" />
              Show plane (drag its arrow to move it)
            </label>
            <label className="eval-field">
              <span>Cap</span>
              <select value={section.capColour} onChange={(e) => onChange({ ...section, capColour: e.target.value === "bodies" ? "bodies" : "single" })} data-testid="section-cap-colour">
                <option value="single">One colour, hatched</option>
                <option value="bodies" disabled={bodies.length < 2}>
                  Each body&apos;s colour{bodies.length < 2 ? " (one body)" : ""}
                </option>
              </select>
            </label>
            {bodies.length > 1 && (
              <details className="section-bodies" open={bodiesOpen} onToggle={(e) => setBodiesOpen(e.currentTarget.open)} data-testid="section-bodies">
                <summary>Section bodies: {cut ? `${cut.length} of ${bodies.length}` : "all"}</summary>
                <div className="section-body-list">
                  {bodies.map((b) => (
                    <label key={b} className="eval-check">
                      <input
                        type="checkbox"
                        checked={!cut || cut.includes(b)}
                        onChange={(e) => {
                          const now = cut ?? bodies;
                          const next = e.target.checked ? [...now.filter((x) => x !== b), b] : now.filter((x) => x !== b);
                          // Every body ticked: back to "all" (a body added later is cut too).
                          onChange({ ...section, bodies: bodies.every((x) => next.includes(x)) ? null : bodies.filter((x) => next.includes(x)) });
                        }}
                        data-testid={`section-body-${b}`}
                      />
                      {b}
                    </label>
                  ))}
                </div>
              </details>
            )}
          </div>
          <p className="muted small">
            {section.planes.length > 1 ? "Cut away where every plane that is on cuts: a corner cut. " : ""}The cut faces show hatched; picking and measuring skip what is cut away. Close (×) turns the section off; the view bar&apos;s Section button brings it back.
          </p>
        </>
      )}
    </Panel>
  );
}

/** A value edited where it is shown (a dimension on the model, a handle's depth): Enter applies, Escape closes. */
export function ValueBox({ x, y, title, value, onCommit, onClose, testId }: { x: number; y: number; title: string; value: NumberValue; onCommit(v: NumberValue): void; onClose(): void; testId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // The newest onClose, so the box is focused once (not again each time the app re-renders while you type).
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const input = ref.current?.querySelector("input");
    input?.focus();
    input?.select();
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key);
    };
  }, []);
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
