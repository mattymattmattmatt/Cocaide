// Fabrication checks (Phase K): what a workshop would ask of a weldment
// before cutting it. Read from the validated document and the rebuild's
// measurements, never from a plan, so they hold for any part with members.

import type { MemberFeature, Vec3 } from "../doc/types";
import { validateDocument } from "../doc/validate";
import type { Measurements } from "../kernel/measure";
import { cutList } from "./cutlist";

export interface FabricationCheck {
  label: string;
  ok: boolean;
  expected: string;
  actual: string;
}

/** Stock bar, mm, unless the part's stock_length parameter says otherwise. */
export const STOCK_LENGTH = 6000;
/** How close a member's end must be to another member's line to count as joined to it, mm. */
const TOUCH = 0.01;

/** The checks; none for a part without members. */
export function fabricationChecks(doc: unknown, m: Measurements | null): FabricationCheck[] {
  const v = validateDocument(doc);
  const members = v.features.flatMap((x) => (x.feature?.op === "member" && !x.feature.suppressed ? [x.feature] : []));
  if (!members.length) return [];
  const checks: FabricationCheck[] = [];
  const add = (label: string, ok: boolean, expected: string, actual: string) => checks.push({ label, ok, expected, actual });

  const groups = connectedGroups(members);
  add(
    "Every member connected",
    groups.length === 1,
    "one frame",
    groups.length === 1 ? `${members.length} member${members.length === 1 ? "" : "s"}, all joined` : `${groups.length} separate groups: ${groups.map((g) => g.join(", ")).join(" | ")}`,
  );

  const clashes = m?.interference ?? [];
  add("No clashes after trimming", clashes.length === 0, "none", clashes.length ? clashes.map((c) => `${c.bodies[0]} and ${c.bodies[1]} overlap by ${round(c.volume)} mm³`).join("; ") : "none");

  const stock = v.parameters.stock_length > 0 ? v.parameters.stock_length : STOCK_LENGTH;
  const long = (m?.members ?? []).filter((x) => x.length > stock + 1e-6);
  add(
    "No member longer than stock bar",
    long.length === 0,
    `at most ${stock} mm`,
    long.length ? long.map((x) => `${x.id} is ${round(x.length)} mm`).join("; ") : `longest ${round(Math.max(0, ...(m?.members ?? []).map((x) => x.length)))} mm`,
  );

  // Alike members cut alike: two lines of the same size and ends that differ by under a millimetre are one part cut twice.
  const lines = cutList(m?.members ?? []);
  const near: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const [a, b] = [lines[i], lines[j]];
      const sameEnds = a.angles.every((x, k) => Math.abs(x - b.angles[k]) < 0.5);
      if (a.designation === b.designation && sameEnds && Math.abs(a.length - b.length) < 1) near.push(`${a.members.join(", ")} at ${a.length} and ${b.members.join(", ")} at ${b.length}`);
    }
  }
  add(
    "Identical members grouped",
    near.length === 0,
    "alike members cut alike",
    near.length ? `cut differently: ${near.join("; ")}` : `${lines.length} cut list line${lines.length === 1 ? "" : "s"} for ${members.length} member${members.length === 1 ? "" : "s"}`,
  );
  return checks;
}

/** Members joined end to line, as groups of ids. */
export function connectedGroups(members: MemberFeature[]): string[][] {
  const parent = members.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (i: number, j: number) => (parent[find(i)] = find(j));
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const [a, b] = [members[i], members[j]];
      const sharedNode = [a.fromNode, a.toNode].some((n) => n && (n === b.fromNode || n === b.toNode));
      if (sharedNode || [a.from, a.to].some((p) => onSegment(p, b)) || [b.from, b.to].some((p) => onSegment(p, a))) join(i, j);
    }
  }
  const groups = new Map<number, string[]>();
  members.forEach((m, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), m.id]));
  return [...groups.values()];
}

function onSegment(p: Vec3, m: MemberFeature): boolean {
  const d = [m.to[0] - m.from[0], m.to[1] - m.from[1], m.to[2] - m.from[2]];
  const l2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
  const t = Math.max(0, Math.min(1, ((p[0] - m.from[0]) * d[0] + (p[1] - m.from[1]) * d[1] + (p[2] - m.from[2]) * d[2]) / l2));
  return Math.hypot(m.from[0] + t * d[0] - p[0], m.from[1] + t * d[1] - p[1], m.from[2] + t * d[2] - p[2]) <= TOUCH;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
