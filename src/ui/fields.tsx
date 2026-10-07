// Form fields that commit on Enter or blur, not on every keystroke: each
// commit is one document command and one undo step.

import { useEffect, useState, type ReactNode } from "react";
import type { Vec3 } from "../doc/types";

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-input">{children}</span>
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function NumberInput({
  value,
  onCommit,
  min,
  step = "any",
  testId,
  ariaLabel,
}: {
  value: number;
  onCommit(v: number): void;
  min?: number;
  step?: number | "any";
  testId?: string;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const v = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(v) || (min !== undefined && v < min)) {
      setDraft(String(value));
      return;
    }
    if (v !== value) onCommit(v);
  };
  return (
    <input
      type="number"
      inputMode="decimal"
      step={step}
      value={draft}
      aria-label={ariaLabel}
      data-testid={testId}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") setDraft(String(value));
      }}
    />
  );
}

export function TextInput({ value, onCommit, testId }: { value: string; onCommit(v: string): void; testId?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() && draft !== value) onCommit(draft.trim());
    else setDraft(value);
  };
  return (
    <input
      value={draft}
      data-testid={testId}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(value);
      }}
    />
  );
}

export function Vec3Input({ value, onCommit, testId }: { value: Vec3; onCommit(v: Vec3): void; testId?: string }) {
  return (
    <span className="vec">
      {value.map((c, i) => (
        <NumberInput
          key={i}
          value={c}
          ariaLabel={"xyz"[i]}
          testId={testId ? `${testId}-${"xyz"[i]}` : undefined}
          onCommit={(v) => onCommit(value.map((old, k) => (k === i ? v : old)) as Vec3)}
        />
      ))}
    </span>
  );
}

const AXES: [string, Vec3][] = [
  ["+X", [1, 0, 0]],
  ["−X", [-1, 0, 0]],
  ["+Y", [0, 1, 0]],
  ["−Y", [0, -1, 0]],
  ["+Z", [0, 0, 1]],
  ["−Z", [0, 0, -1]],
];

/** An axis direction from a list, or custom components. */
export function DirectionInput({ value, onCommit, testId }: { value: Vec3; onCommit(v: Vec3): void; testId?: string }) {
  const len = Math.hypot(...value) || 1;
  const match = AXES.find(([, d]) => d.every((c, i) => Math.abs(c - value[i] / len) < 1e-9));
  const [custom, setCustom] = useState(!match);
  return (
    <span className="direction">
      <select
        value={custom ? "custom" : match?.[0]}
        data-testid={testId}
        onChange={(e) => {
          if (e.target.value === "custom") return setCustom(true);
          setCustom(false);
          onCommit(AXES.find(([n]) => n === e.target.value)![1]);
        }}
      >
        {AXES.map(([n]) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
        <option value="custom">custom…</option>
      </select>
      {custom && <Vec3Input value={value} onCommit={onCommit} />}
    </span>
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  testId,
}: {
  value: T;
  options: [T, string][];
  onChange(v: T): void;
  testId?: string;
}) {
  return (
    <select value={value} data-testid={testId} onChange={(e) => onChange(e.target.value as T)}>
      {options.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );
}
