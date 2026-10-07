// The critic: one look at the rebuilt part's measurements against what the
// request asked for (spec 5.1: emit, rebuild, read, stop; one correction
// pass if a measurement disagrees). It trusts the kernel, not the plan.

import type { Measurements } from "../kernel/measure";
import type { Expectation } from "./plan";

export interface Check {
  label: string;
  ok: boolean;
  expected: string;
  actual: string;
}

export interface Critique {
  ok: boolean;
  checks: Check[];
  /** The failed checks, as sentences for the agent's correction pass. */
  findings: string[];
}

const TOL = 1e-6;
const f = (x: number) => String(Math.round(x * 1e6) / 1e6);

export function critique(expect: Expectation, m: Measurements | null, rebuildErrors: string[] = []): Critique {
  const checks: Check[] = [];
  const add = (label: string, ok: boolean, expected: string, actual: string) => checks.push({ label, ok, expected, actual });

  add("Rebuilds without errors", rebuildErrors.length === 0, "no errors", rebuildErrors.length ? rebuildErrors.join("; ") : "no errors");
  if (!m || !m.boundingBox) {
    add("One solid", false, "1 solid", "no solid");
    return finish(checks);
  }
  add("One solid", m.solids === 1, "1", String(m.solids));
  const size = m.boundingBox.size;
  add(
    "Size",
    expect.size.every((v, i) => Math.abs(v - size[i]) <= TOL * Math.max(1, v)),
    expect.size.map(f).join(" × "),
    size.map(f).join(" × "),
  );
  add("Hole count", m.holeCount === expect.holes.length, String(expect.holes.length), String(m.holeCount));

  const wantD = expect.holes.map((h) => h.diameter).sort((a, b) => a - b);
  const gotD = [...m.holeDiameters].sort((a, b) => a - b);
  add("Hole diameters", wantD.length === gotD.length && wantD.every((d, i) => Math.abs(d - gotD[i]) <= TOL), list(wantD), list(gotD));

  // Each expected hole must be found where it was asked for, along Z, at the asked depth.
  const vertical = m.holes.filter((h) => Math.abs(Math.abs(h.axis[2]) - 1) < 1e-6);
  const unmatched = [...vertical];
  const misplaced: string[] = [];
  for (const want of expect.holes) {
    const i = unmatched.findIndex(
      (h) => Math.hypot(h.axisPoint[0] - want.center[0], h.axisPoint[1] - want.center[1]) <= 1e-5 && Math.abs(h.diameter - want.diameter) <= TOL,
    );
    if (i < 0) misplaced.push(`Ø${f(want.diameter)} at [${want.center.map(f).join(", ")}]`);
    else {
      const got = unmatched.splice(i, 1)[0];
      if (Math.abs(got.length - want.depth) > 1e-5) misplaced.push(`Ø${f(want.diameter)} at [${want.center.map(f).join(", ")}] is ${f(got.length)} deep, not ${f(want.depth)}`);
    }
  }
  add(
    "Hole positions",
    misplaced.length === 0,
    expect.holes.length ? `${expect.holes.length} at the asked centres` : "none",
    misplaced.length ? `missing or wrong: ${misplaced.join("; ")}` : "all found",
  );
  return finish(checks);
}

function finish(checks: Check[]): Critique {
  const failed = checks.filter((c) => !c.ok);
  return { ok: failed.length === 0, checks, findings: failed.map((c) => `${c.label}: expected ${c.expected}, measured ${c.actual}`) };
}

function list(xs: number[]): string {
  return xs.length ? xs.map(f).join(", ") : "none";
}
