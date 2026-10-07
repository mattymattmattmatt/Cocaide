// Form fields that commit on Enter or blur, not on every keystroke: each
// commit is one document command and one undo step.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { evaluate, isExpression, type Parameters } from "../doc/parameters";
import type { Vec3 } from "../doc/types";

/** The document's parameters, for number fields that hold "=expressions". */
export const ParametersContext = createContext<Parameters>({});

/** A number field's value: a number, or an expression over parameters ("=plate_t * 2"). */
export type NumberValue = number | string;

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-input">{children}</span>
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/**
 * A number, or "=expression" over the document parameters. The resolved value
 * of an expression shows beside it; a bad expression is not committed.
 */
export function NumberInput({
  value,
  onCommit,
  min,
  testId,
  ariaLabel,
}: {
  value: NumberValue;
  onCommit(v: NumberValue): void;
  min?: number;
  step?: number | "any";
  testId?: string;
  ariaLabel?: string;
}) {
  const params = useContext(ParametersContext);
  const [draft, setDraft] = useState(String(value));
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setDraft(String(value));
    setProblem(null);
  }, [value]);
  const commit = () => {
    const text = draft.trim();
    if (text.startsWith("=")) {
      const r = evaluate(text, params);
      if (!r.ok) return setProblem(r.error);
      setProblem(null);
      if (text !== value) onCommit(text);
      return;
    }
    const v = Number(text);
    if (text === "" || !Number.isFinite(v) || (min !== undefined && v < min)) {
      setDraft(String(value));
      setProblem(null);
      return;
    }
    if (v !== value) onCommit(v);
  };
  const resolved = isExpression(value) && !problem ? evaluate(value, params) : null;
  return (
    <span className={`number${isExpression(draft) ? " expr" : ""}`}>
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        aria-label={ariaLabel}
        aria-invalid={problem ? true : undefined}
        title={problem ?? (isExpression(value) ? "An expression over the document parameters" : undefined)}
        data-testid={testId}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") {
            setDraft(String(value));
            setProblem(null);
          }
        }}
      />
      {resolved?.ok && <span className="expr-value">= {Math.round(resolved.value * 1e6) / 1e6}</span>}
      {problem && <span className="expr-error">{problem}</span>}
    </span>
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

export function Vec3Input({ value, onCommit, testId }: { value: NumberValue[]; onCommit(v: NumberValue[]): void; testId?: string }) {
  return (
    <span className="vec">
      {value.map((c, i) => (
        <NumberInput
          key={i}
          value={c}
          ariaLabel={"xyz"[i]}
          testId={testId ? `${testId}-${"xyz"[i]}` : undefined}
          onCommit={(v) => onCommit(value.map((old, k) => (k === i ? v : old)))}
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
export function DirectionInput({ value, onCommit, testId }: { value: NumberValue[]; onCommit(v: NumberValue[]): void; testId?: string }) {
  const nums = value.map(Number); // an expression component never matches an axis
  const len = Math.hypot(...nums) || 1;
  const match = AXES.find(([, d]) => d.every((c, i) => Math.abs(c - nums[i] / len) < 1e-9));
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
