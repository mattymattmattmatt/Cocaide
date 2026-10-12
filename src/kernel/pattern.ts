// Where a pattern's copies go: one transform per instance, numbered the way
// the document numbers them (1 is the original, which is never copied), less
// the instances the pattern skips. A linear pattern's direction and a
// circular pattern's axis may be references to the model (an edge, an axis,
// a face), resolved on the part as it stands at the pattern.

import type { CircularPatternFeature, DatumRef, LinearPatternFeature, Vec3 } from "../doc/types";
import { formatDirection, normalize3, roundTo, scale3, add3 } from "../geom/vec";
import { resolveDatum, nameOf, type DatumContext } from "./datum";
import { type OC, type Scope } from "./oc";
import { dir, identity, OpError, pnt, vec, type Trsf } from "./ops";

/** One copy of a pattern: its instance number, a label for messages, and its transform. */
export interface PatternInstance {
  n: number;
  label: string;
  trsf: Trsf;
}

/** A linear pattern's direction as a unit vector: written out, or an edge's or axis's direction, a face's or plane's normal; reversed with `reverse`. */
export function lineDirection(ctx: DatumContext, written: Vec3 | undefined, ref: DatumRef | undefined, reverse: boolean | undefined, path: string): Vec3 {
  let d: Vec3;
  if (ref) {
    const got = resolveDatum(ctx, ref, "any", path);
    if (got.kind === "point") throw new OpError(`${path}: ${nameOf(ref)} is a point; a direction needs a straight edge, an axis or a flat face (its normal)`);
    d = got.kind === "axis" ? got.direction : got.normal;
  } else d = written!;
  d = normalize3(d);
  return reverse ? scale3(d, -1) : d;
}

/** A circular pattern's axis: written out, or an edge, an axis feature or a cylindrical face. */
export function patternAxis(ctx: DatumContext, f: CircularPatternFeature): { origin: Vec3; direction: Vec3 } {
  if ("ref" in f.axis) {
    const a = resolveDatum(ctx, f.axis.ref, "axis", "axis.ref");
    return { origin: a.origin, direction: normalize3(a.direction) };
  }
  return { origin: f.axis.origin, direction: normalize3(f.axis.direction) };
}

/**
 * The copies a linear or circular pattern makes, in instance order. Linear:
 * instance 1 + i + j * count is i steps along the first direction and j
 * along the second. Circular: instance k is k - 1 steps round the axis.
 */
export function patternInstances(oc: OC, s: Scope, ctx: DatumContext, f: LinearPatternFeature | CircularPatternFeature): PatternInstance[] {
  const skip = new Set(f.skip ?? []);
  const instances: PatternInstance[] = [];
  if (f.op === "linearPattern") {
    const d1 = lineDirection(ctx, f.direction, f.along, f.reverse, "along");
    const two = f.count2 !== undefined;
    const d2 = two ? lineDirection(ctx, f.direction2, f.along2, f.reverse2, "along2") : ([0, 0, 0] as Vec3);
    if (two && Math.abs(d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]) > 1 - 1e-9) {
      throw new OpError(`the second direction ${formatDirection(d2)} is parallel to the first: a grid needs two different directions`);
    }
    const n2 = f.count2 ?? 1;
    for (let j = 0; j < n2; j++) {
      for (let i = 0; i < f.count; i++) {
        const n = 1 + i + j * f.count;
        if (n === 1 || skip.has(n)) continue;
        const offset = add3(scale3(d1, i * f.spacing), scale3(d2, j * (f.spacing2 ?? 0)));
        const t = identity(oc, s);
        t.SetTranslation(vec(oc, s, offset));
        instances.push({ n, label: `instance ${n}${n2 > 1 ? ` [${i + 1}, ${j + 1}]` : ""} (offset ${fmt3(offset)})`, trsf: t });
      }
    }
    return instances;
  }
  const total = f.angle ?? 360;
  const step = (total >= 360 ? total / f.count : total / (f.count - 1)) * (f.reverse ? -1 : 1);
  const a = patternAxis(ctx, f);
  const axis = s.track(new oc.gp_Ax1(pnt(oc, s, a.origin), dir(oc, s, a.direction)));
  for (let k = 1; k < f.count; k++) {
    if (skip.has(k + 1)) continue;
    const t = identity(oc, s);
    t.SetRotation(axis, (k * step * Math.PI) / 180);
    instances.push({ n: k + 1, label: `instance ${k + 1} (${roundTo(k * step, 4)} deg)`, trsf: t });
  }
  return instances;
}

/** Copies moved by these offsets, numbered 2, 3, ... in order (a sketch-driven pattern), less the skipped. */
export function offsetInstances(oc: OC, s: Scope, offsets: { offset: Vec3; label: string }[], skip: readonly number[] = []): PatternInstance[] {
  const out: PatternInstance[] = [];
  offsets.forEach((o, i) => {
    const n = i + 2;
    if (skip.includes(n)) return;
    const t = identity(oc, s);
    t.SetTranslation(vec(oc, s, o.offset));
    out.push({ n, label: `instance ${n} ${o.label}`, trsf: t });
  });
  return out;
}

function fmt3(v: Vec3): string {
  return `[${v.map((x) => roundTo(x, 4)).join(", ")}]`;
}
