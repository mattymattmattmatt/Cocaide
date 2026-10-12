// What the Modify box (and the inline box while drawing) reads from what is
// typed, as SOLIDWORKS's does: a number; a calculation with functions and
// units, worked out once ("sqrt(2)*10", "1in", "25.4mm + 3", "30deg"); or an
// "=expression" that stays linked to the parameters and dimensions it reads.
// The spin buttons step the value by the increment set in Settings. Pure.

import { evaluate, isExpression, type Parameters } from "../../doc/parameters";

export type ReadValue = { ok: true; value: number; expr?: string } | { ok: false; error: string };

/** The value typed: `expr` is set when it is an "=expression" to keep. */
export function readValue(text: string, params: Parameters): ReadValue {
  const t = text.trim();
  if (t === "") return { ok: false, error: "type a value: a number, a calculation such as sqrt(2)*10 or 1in, or =expression" };
  if (isExpression(t)) {
    const r = evaluate(t, params);
    return r.ok ? { ok: true, value: r.value, expr: t } : { ok: false, error: r.error };
  }
  const n = Number(t);
  if (Number.isFinite(n)) return { ok: true, value: n };
  // Worked out once: units and functions, names read as they are now.
  const r = evaluate(`=${t}`, params);
  return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error.replace(/ in "=/, ' in "') };
}

/** The value one step up (+1) or down (−1), as text, kept to a billionth. An expression's link is let go: spinning sets a number. */
export function spinValue(text: string, dir: 1 | -1, step: number, params: Parameters, min?: number): string | null {
  const r = readValue(text, params);
  if (!r.ok) return null;
  let v = Math.round((r.value + dir * step) * 1e9) / 1e9;
  if (min !== undefined && v < min) v = min;
  return String(v);
}

/** What the box shows beside an expression or a calculation: the number it comes to. Null for a plain number. */
export function shownValue(text: string, params: Parameters, unit: string): string | null {
  const t = text.trim();
  if (t === "" || Number.isFinite(Number(t))) return null;
  const r = readValue(t, params);
  return r.ok ? `= ${Math.round(r.value * 1e6) / 1e6}${unit === "°" ? "°" : ` ${unit}`}` : null;
}

// ------------------------------------------------------------ spin steps

/** The spin buttons' steps (Settings → Units), kept in this browser. */
export interface SpinSteps {
  length: number;
  angle: number;
}

const SPIN_KEY = "cocaide.spin.v1";
export const DEFAULT_SPIN: SpinSteps = { length: 1, angle: 1 };

export function loadSpin(): SpinSteps {
  try {
    const raw = JSON.parse(localStorage.getItem(SPIN_KEY) ?? "null") as Partial<SpinSteps> | null;
    const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
    return { length: ok(raw?.length) ? raw!.length! : DEFAULT_SPIN.length, angle: ok(raw?.angle) ? raw!.angle! : DEFAULT_SPIN.angle };
  } catch {
    return { ...DEFAULT_SPIN };
  }
}

export function saveSpin(steps: SpinSteps): void {
  try {
    localStorage.setItem(SPIN_KEY, JSON.stringify(steps));
  } catch {
    // no storage: the defaults stay
  }
}
