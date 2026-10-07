// Where a member's section sits (Phases I and J): the frame along its line,
// and the point of the section that runs on the line. Pure: the kernel builds
// from this, and the joints trim with it.

import type { MemberFeature, ProfileDef, Vec2, Vec3 } from "../doc/types";
import type { Frame } from "./frame";
import { sectionAt, sectionOutline, type SectionProps } from "./section";
import { add3, cross3, dot3, len3, normalize3, scale3, sub3 } from "./vec";

/**
 * The frame a member's profile is placed in: z along the line, y up (world +Z
 * as far as the line allows, +Y for a vertical member), turned `rotation`
 * degrees about the line. Right-handed, so the profile reads as drawn from the
 * `to` end.
 */
export function memberFrame(from: Vec3, to: Vec3, rotation = 0): Frame {
  const z = normalize3(sub3(to, from));
  const up: Vec3 = Math.abs(z[2]) < 1 - 1e-9 ? [0, 0, 1] : [0, 1, 0];
  const y0 = normalize3(sub3(up, scale3(z, dot3(up, z))));
  const x0 = cross3(y0, z);
  const a = (rotation * Math.PI) / 180;
  const x = add3(scale3(x0, Math.cos(a)), scale3(y0, Math.sin(a)));
  const y = add3(scale3(x0, -Math.sin(a)), scale3(y0, Math.cos(a)));
  return { origin: from, x, y, z };
}

export interface PlacedSection {
  /** Along the line from `from`; x and y are the profile's axes. */
  frame: Frame;
  props: SectionProps;
  /** The profile point on the line: the anchor, or the `align` point of the envelope. */
  on: Vec2;
  /** The section's outline, as offsets from the line in world space (perpendicular to it). */
  outline: Vec3[];
  /** How far the section reaches from the line. */
  radius: number;
  /** Unit direction from `from` to `to`, and the length between them. */
  dir: Vec3;
  length: number;
}

/** A member's section at its size, placed on its line. */
export function placeSection(f: MemberFeature, def: ProfileDef): { ok: true; placed: PlacedSection } | { ok: false; error: string } {
  const r = sectionAt(def, f.size);
  if (!r.ok) return { ok: false, error: `profile ${def.name} at ${f.size}: ${r.error}` };
  const props = r.props;
  const frame = memberFrame(f.from, f.to, f.rotation ?? 0);
  const on: Vec2 = f.align
    ? [props.min[0] + ((f.align[0] + 1) / 2) * props.envelope[0], props.min[1] + ((f.align[1] + 1) / 2) * props.envelope[1]]
    : def.anchor === "centroid"
      ? props.centroid
      : [0, 0];
  const outline = sectionOutline(props).map((p) => add3(scale3(frame.x, p[0] - on[0]), scale3(frame.y, p[1] - on[1])));
  const radius = Math.max(...outline.map(len3));
  const d = sub3(f.to, f.from);
  return { ok: true, placed: { frame, props, on, outline, radius, dir: normalize3(d), length: len3(d) } };
}

/** How far the section reaches from its line in a direction (a support function); the direction need not be unit. */
export function reach(p: PlacedSection, dir: Vec3): number {
  let best = -Infinity;
  for (const o of p.outline) best = Math.max(best, dot3(o, dir));
  return best;
}
