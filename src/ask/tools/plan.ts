// The plan a whole-part build starts with: the feature tree the agent means
// to build, and the checks the result must pass. The checks are numbers the
// request gives (a volume worked out by hand, the overall size, the number of
// holes); when the agent stops, the loop measures them on the result and
// sends back the ones that fail (the self-check).

import type { Measurements } from "../../kernel";
import { isObject } from "../../doc/validate";
import { r6, type Outcome } from "./common";

export const MEASURES = ["volume", "sizeX", "sizeY", "sizeZ", "holes", "bodies", "surfaceArea", "massKg"] as const;
export type Measure = (typeof MEASURES)[number];

export interface PlanCheck {
  label: string;
  measure: Measure;
  expected: number;
  /** Fraction of expected (default 0.01); whole counts are exact. */
  tolerance: number;
}

export interface Plan {
  features: string[];
  checks: PlanCheck[];
}

/** Reads the plan tool's input. */
export function readPlan(input: unknown): Plan | string {
  const a = isObject(input) ? input : {};
  if (!Array.isArray(a.features) || !a.features.length || !a.features.every((x) => typeof x === "string")) return 'plan: "features" must list the features you will build, one line each, in order';
  const checks: PlanCheck[] = [];
  for (const [i, c] of (Array.isArray(a.checks) ? a.checks : []).entries()) {
    if (!isObject(c) || !MEASURES.includes(c.measure as Measure) || typeof c.expected !== "number") {
      return `plan: checks[${i}] must be { "label", "measure": ${MEASURES.map((m) => `"${m}"`).join(" | ")}, "expected": number, "tolerance"?: fraction }`;
    }
    checks.push({ label: typeof c.label === "string" ? c.label : String(c.measure), measure: c.measure as Measure, expected: c.expected, tolerance: typeof c.tolerance === "number" && c.tolerance >= 0 ? c.tolerance : 0.01 });
  }
  return { features: a.features as string[], checks };
}

export function measured(m: Measurements | null, what: Measure): number | null {
  if (!m) return null;
  switch (what) {
    case "volume":
      return m.volume;
    case "surfaceArea":
      return m.surfaceArea;
    case "sizeX":
    case "sizeY":
    case "sizeZ":
      return m.boundingBox ? m.boundingBox.size["XYZ".indexOf(what[4])] : null;
    case "holes":
      return m.holeCount;
    case "bodies":
      return m.bodies.length;
    case "massKg":
      return m.mass.kg;
  }
}

export interface CheckOutcome {
  label: string;
  ok: boolean;
  expected: number;
  actual: number | null;
}

/** Each check on the measured part. */
export function runChecks(checks: PlanCheck[], m: Measurements | null): CheckOutcome[] {
  return checks.map((c) => {
    const actual = measured(m, c.measure);
    const whole = c.measure === "holes" || c.measure === "bodies";
    const ok = actual !== null && (whole ? actual === c.expected : Math.abs(actual - c.expected) <= Math.max(1e-6, Math.abs(c.expected) * c.tolerance));
    return { label: c.label, ok, expected: c.expected, actual: actual === null ? null : r6(actual) };
  });
}

/** What the plan tool answers: the plan as kept, and how the checks stand now. */
export function planReply(p: Plan, m: Measurements | null): Outcome {
  return {
    ok: true,
    kept: { features: p.features.length, checks: p.checks.length },
    ...(p.checks.length ? { checksNow: runChecks(p.checks, m) } : {}),
    next: "Build it, a few features per batch call; then verify with partSummary, measureBetween and a screenshot, and fix what disagrees.",
  };
}
