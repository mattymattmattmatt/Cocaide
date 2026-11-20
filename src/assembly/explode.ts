// The exploded view: each component moved away from the one it is mated to,
// along the mate (out of its hole along the axis, off the face it sits on
// along the face's normal), far enough to clear it, and carried along with
// that one's own move (a bolt in a block comes off with the block, then out of
// it). One step per component, its whole move: the steps a person can then
// edit. Pure.

import { explodeOffsets } from "../doc/assembly";
import type { Assembly, AssemblyComponent, ExplodeStep, Vec3 } from "../doc/types";
import { partBox } from "./model";
import { mateGeometry, type PartTopology } from "./resolve";
import { apply, placementOf, pointTo } from "./transform";

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const r3 = (x: number) => Math.round(x * 1000) / 1000 + 0;

/** A component's box corners in the assembly (none: its part has no edges yet). */
function corners(k: AssemblyComponent, part: PartTopology | undefined): Vec3[] {
  const b = part ? partBox(part) : null;
  if (!b) return [];
  const P = placementOf(k);
  const out: Vec3[] = [];
  for (let i = 0; i < 8; i++) out.push(pointTo(P, [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]]));
  return out;
}
const centre = (pts: Vec3[]): Vec3 => (pts.length ? ([0, 1, 2].map((i) => pts.reduce((s, p) => s + p[i], 0) / pts.length) as Vec3) : [0, 0, 0]);
const extent = (pts: Vec3[], d: Vec3) => (pts.length ? Math.max(...pts.map((p) => dot(p, d))) - Math.min(...pts.map((p) => dot(p, d))) : 0);

/**
 * The explode steps worked out from the mates. `scale` stretches every
 * distance (1: each part clears what it comes off, with a third of its size
 * to spare).
 */
export function autoExplode(asm: Assembly, partOf: (componentId: string) => PartTopology | undefined, scale = 1): ExplodeStep[] {
  const order = new Map(asm.components.map((k, i) => [k.id, i]));
  const byId = new Map(asm.components.map((k) => [k.id, k]));
  const offsets = new Map<string, Vec3>();
  const steps: ExplodeStep[] = [];
  const held = new Set(asm.components.filter((k) => k.fixed).map((k) => k.id));
  if (!held.size && asm.components.length) held.add(asm.components[0].id);
  for (const k of asm.components) {
    if (held.has(k.id)) continue;
    const mates = (asm.mates ?? []).filter((m) => !m.suppressed && (m.a.component === k.id || m.b.component === k.id));
    // What it comes off: a component put in before it that it is mated to (a concentric first: the axis it slides out along).
    const ranked = mates
      .map((m) => ({ m, mine: m.a.component === k.id ? m.a : m.b, other: m.a.component === k.id ? m.b : m.a }))
      .filter((x) => (order.get(x.other.component) ?? Infinity) < order.get(k.id)!)
      .sort((x, y) => (x.m.type === "concentric" ? 0 : 1) - (y.m.type === "concentric" ? 0 : 1));
    const base = ranked[0];
    if (!base) continue;
    const p = byId.get(base.other.component)!;
    const g = mateGeometry(base.other, partOf(p.id));
    if (typeof g === "string" || g.kind === "point") continue;
    const P = placementOf(p);
    let dir = apply(P.R, g.kind === "plane" ? g.n : g.d);
    const mine = corners(k, partOf(k.id));
    const theirs = corners(p, partOf(p.id));
    const away = sub(centre(mine), centre(theirs));
    // Out along the axis the way it went in: the side the face it is seated on looks (a bolt's head on a counterbore's
    // floor comes out upward, though most of the bolt is below); with no seat, toward where it sits. On a face, off it.
    if (g.kind === "axis") {
      const seat = ranked.find((x) => x.m.type === "coincident" && x.other.component === p.id);
      const sg = seat ? mateGeometry(seat.other, partOf(p.id)) : null;
      const n = sg && typeof sg !== "string" && sg.kind === "plane" ? apply(P.R, sg.n) : null;
      const along = n && Math.abs(dot(n, dir)) > 0.5 ? dot(n, dir) : dot(away, dir);
      if (along < 0) dir = dir.map((x) => -x) as Vec3;
    } else if (dot(away, dir) < -1e-6) dir = dir.map((x) => -x) as Vec3;
    const own = extent(mine, dir);
    const distance = Math.max(10, own * (4 / 3)) * scale;
    const parent = offsets.get(p.id) ?? [0, 0, 0];
    const total: Vec3 = [0, 1, 2].map((i) => r3(parent[i] + dir[i] * distance)) as Vec3;
    offsets.set(k.id, total);
    if (total.some((x) => x !== 0)) steps.push({ components: [k.id], move: total });
  }
  return steps;
}

/** The steps with one component's whole offset set to `offset` (the others kept as they are). */
export function withOffset(asm: Assembly, id: string, offset: Vec3): ExplodeStep[] {
  const now = explodeOffsets(asm).get(id) ?? [0, 0, 0];
  const delta: Vec3 = [offset[0] - now[0], offset[1] - now[1], offset[2] - now[2]];
  if (delta.every((x) => Math.abs(x) < 1e-9)) return asm.explode ?? [];
  const steps = [...(asm.explode ?? [])];
  // Its own step (one moving it alone) takes the change; else a new step.
  const i = steps.findIndex((s) => s.components.length === 1 && s.components[0] === id);
  if (i >= 0) steps[i] = { components: [id], move: steps[i].move.map((x, j) => r3(x + delta[j])) as Vec3 };
  else steps.push({ components: [id], move: delta.map(r3) as Vec3 });
  return steps.filter((s) => s.move.some((x) => x !== 0));
}

/** The steps without a component (deleted): steps left with none drop out. */
export function explodeWithout(steps: ExplodeStep[] | undefined, id: string): ExplodeStep[] {
  return (steps ?? []).map((s) => ({ ...s, components: s.components.filter((c) => c !== id) })).filter((s) => s.components.length);
}
