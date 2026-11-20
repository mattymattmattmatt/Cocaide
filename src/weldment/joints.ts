// Joints (Phase J): where members meet at a node, how each is cut. Pure: from
// the members' lines and placed sections, every member end gets an extension
// along its line and the planes that trim it. The kernel builds the member
// long enough and cuts it on those planes.
//
// - A mitre cuts its two members on the plane that halves the angle between
//   them, through the node, half the gap either side.
// - A butt runs one member through. If it ends at the node it is extended,
//   square, far enough to cover the others.
// - Every other member that ends at the node stops at the face of the joint's
//   own members: on the plane, perpendicular to the way it comes in, that the
//   whole of their section is behind.

import type { JointFeature, MemberFeature, Vec3 } from "../doc/types";
import { reach, type PlacedSection } from "../geom/member";
import { add3, cross3, dot3, len3, normalize3, scale3, sub3 } from "../geom/vec";

/** A plane that trims a member: the side its normal points to is cut away. */
export interface CutPlane {
  point: Vec3;
  normal: Vec3;
}

export interface MemberEnd {
  /** mm the member is built past this end before it is cut. */
  extend: number;
  planes: CutPlane[];
  /** The joint that shapes this end. */
  joint?: string;
}

export interface MemberEnds {
  /** At `from`. */
  start: MemberEnd;
  /** At `to`. */
  end: MemberEnd;
}

export interface FrameMember {
  f: MemberFeature;
  placed: PlacedSection;
}

export interface FrameEnds {
  /** Members a joint shapes, by id. Members no joint touches are not listed. */
  ends: Map<string, MemberEnds>;
  /** Why a joint can't be made, by joint id. Such a joint shapes nothing. */
  errors: Map<string, string>;
  /** Every member each joint shapes: its own and the ones that butt against them. */
  shaped: Map<string, string[]>;
}

/** The smallest angle two members can be mitred at, in degrees. */
export const MIN_MITRE_ANGLE = 5;

export function frameEnds(members: FrameMember[], joints: JointFeature[], nodes: Record<string, Vec3>): FrameEnds {
  const byId = new Map(members.map((m) => [m.f.id, m]));
  const ends = new Map<string, MemberEnds>();
  const errors = new Map<string, string>();
  const shaped = new Map<string, string[]>();
  const endOf = (id: string, side: "start" | "end"): MemberEnd => {
    let e = ends.get(id);
    if (!e) ends.set(id, (e = { start: { extend: 0, planes: [] }, end: { extend: 0, planes: [] } }));
    return e[side];
  };

  for (const j of joints) {
    const at = nodes[j.node];
    const ending = members.filter((m) => m.f.fromNode === j.node || m.f.toNode === j.node);
    const side = (m: FrameMember): "start" | "end" => (m.f.fromNode === j.node ? "start" : "end");
    /** The way along the member from the node into it. */
    const away = (m: FrameMember): Vec3 => (side(m) === "start" ? m.placed.dir : scale3(m.placed.dir, -1));
    const gap = j.gap ?? 0;
    const missing = [...(j.members ?? []), ...(j.through ? [j.through] : [])].filter((id) => !byId.has(id));
    if (missing.length) {
      errors.set(j.id, `${missing.join(" and ")} did not build, so there is nothing to join`);
      continue;
    }

    // The joint's own members, and how each is cut.
    const plan = new Map<string, MemberEnd>();
    let targets: FrameMember[];
    if (j.type === "mitre") {
      const [a, b] = (j.members ?? ending.map((m) => m.f.id)).map((id) => byId.get(id)!);
      const da = away(a);
      const db = away(b);
      const angle = (Math.acos(Math.max(-1, Math.min(1, dot3(da, db)))) * 180) / Math.PI;
      if (angle < MIN_MITRE_ANGLE) {
        errors.set(j.id, `${a.f.id} and ${b.f.id} meet at ${round(angle)}°: too sharp to mitre`);
        continue;
      }
      const n = normalize3(sub3(da, db));
      const half = (angle * Math.PI) / 360;
      const past = (m: FrameMember) => m.placed.radius / Math.tan(half) + gap / 2 + 1;
      plan.set(a.f.id, { extend: past(a), planes: [{ point: add3(at, scale3(n, gap / 2)), normal: scale3(n, -1) }], joint: j.id });
      plan.set(b.f.id, { extend: past(b), planes: [{ point: sub3(at, scale3(n, gap / 2)), normal: n }], joint: j.id });
      targets = [a, b];
    } else {
      const p = byId.get(j.through!)!;
      targets = [p];
      if (ending.includes(p)) {
        // Square, and long enough to cover every member that butts against it.
        const beyond = scale3(away(p), -1);
        const others = ending.filter((m) => m !== p);
        plan.set(p.f.id, { extend: Math.max(0, ...others.map((q) => reach(q.placed, beyond))), planes: [], joint: j.id });
      }
    }

    // Everything else that ends here stops at the targets' faces.
    let failed: string | null = null;
    for (const q of ending) {
      if (targets.includes(q)) continue;
      const dq = away(q);
      const cut: MemberEnd = { extend: 0, planes: [], joint: j.id };
      for (const t of targets) {
        const u = sub3(dq, scale3(t.placed.dir, dot3(dq, t.placed.dir)));
        const across = len3(u);
        if (across < 0.05) {
          failed = `${q.f.id} runs along ${t.f.id} at ${j.node}: it can't butt against it`;
          break;
        }
        const v = scale3(u, 1 / across);
        // On the face of the target it comes up to (a raked plate meeting a level one is cut plumb on its face),
        // else square to the way it comes in.
        const face = faceToward(t.placed, v);
        const n = face?.normal ?? v;
        const h = (face ? face.reach : reach(t.placed, v)) + gap;
        const c = dot3(dq, n);
        // The point on the target's line nearest the node.
        const foot = add3(t.f.from, scale3(t.placed.dir, dot3(sub3(at, t.f.from), t.placed.dir)));
        cut.planes.push({ point: add3(foot, scale3(n, h)), normal: scale3(n, -1) });
        // Long enough to reach back to the plane from wherever the section is.
        cut.extend = Math.max(cut.extend, (q.placed.radius + dot3(sub3(at, foot), n) - h) / c + 1, 0);
      }
      if (failed) break;
      plan.set(q.f.id, cut);
    }
    if (failed) {
      errors.set(j.id, failed);
      continue;
    }
    for (const [id, cut] of plan) {
      const m = byId.get(id)!;
      const e = endOf(id, side(m));
      e.extend = cut.extend;
      e.planes = cut.planes;
      e.joint = cut.joint;
    }
    shaped.set(j.id, [...new Set([...targets.map((t) => t.f.id), ...plan.keys()])]);
  }
  return { ends, errors, shaped };
}

/**
 * The flat face of a placed section that faces `v` (its outward normal within
 * 45° of it, the nearest such): its normal and how far it is from the line.
 * None when no face is that near (a round section: square to `v` instead).
 */
export function faceToward(p: PlacedSection, v: Vec3): { normal: Vec3; reach: number } | null {
  const o = p.outline;
  if (o.length < 3) return null;
  const mid = scale3(o.reduce((a, b) => add3(a, b), [0, 0, 0] as Vec3), 1 / o.length);
  let best: { normal: Vec3; reach: number; fit: number } | null = null;
  for (let i = 0; i < o.length; i++) {
    const a = o[i];
    const b = o[(i + 1) % o.length];
    const e = sub3(b, a);
    if (len3(e) < 1) continue;
    let n = normalize3(cross3(e, p.dir));
    if (dot3(n, sub3(scale3(add3(a, b), 0.5), mid)) < 0) n = scale3(n, -1);
    const fit = dot3(n, v);
    const r = dot3(a, n);
    // The outermost face that way: a section's inner faces (a hollow's) are behind it.
    if (fit > Math.SQRT1_2 && (!best || fit > best.fit + 1e-9 || (Math.abs(fit - best.fit) < 1e-9 && r > best.reach))) best = { normal: n, reach: r, fit };
  }
  // Only a face the whole section is behind (an outer face, not a hollow's inside).
  if (!best || best.reach < reach(p, best.normal) - 1e-6) return null;
  return { normal: best.normal, reach: best.reach };
}

function round(x: number): number {
  return Math.round(x * 10) / 10;
}
