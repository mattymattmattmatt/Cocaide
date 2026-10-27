// thread, kernel side: the cylindrical face found on the part as it stands,
// which end the thread starts at and which way it runs, the size it fits;
// recorded for drawings (a callout like a tapped hole's); modelled, the ISO
// groove swept along the exact helix, trimmed to the length, cut from the
// face's body (with a run-out chamfer at the start when asked).

import type { TopoDS_Shape, TopoDS_Wire } from "replicad-opencascadejs";
import type { Vec3 } from "../../doc/types";
import { add3, dot3, normalize3, roundTo, scale3 } from "../../geom/vec";
import { findFace } from "../../kernel/datum";
import { isValidShape, volumeOf } from "../../kernel/measure";
import { scoped, type Scope } from "../../kernel/oc";
import { dir, OpError, pnt, unify } from "../../kernel/ops";
import { helixEdge } from "../../kernel/paths";
import type { HoleRecord } from "../../kernel/rebuild";
import type { OC } from "../../kernel/oc";
import { screwSize, THREAD_CLASS, type ThreadSpec } from "../hole/standards";
import type { KernelOp } from "../kernelDefs";
import { axisFrame, type AxisFrame } from "../sweep/helix";
import type { ThreadFeature } from "./doc";
import { basicMinor, EXTERNAL_CLASS, FIT, grooveOutline, grooveVolume, MAX_TURNS, sizeFor } from "./profile";

/** "up" for picking the start end: the axis turned to point +Z, else +Y, else +X. */
function upward(axis: Vec3): Vec3 {
  const k = Math.abs(axis[2]) > 1e-9 ? 2 : Math.abs(axis[1]) > 1e-9 ? 1 : 0;
  return axis[k] < 0 ? scale3(axis, -1) : axis;
}

/** A closed polygon in the plane of x and z about `origin`, from (radius, along) points. */
function polygonWire(oc: OC, s: Scope, frame: AxisFrame, pts: [number, number][]): TopoDS_Wire {
  const at = (p: [number, number]) => pnt(oc, s, add3(frame.origin, add3(scale3(frame.x, p[0]), scale3(frame.z, p[1]))));
  const mw = s.track(new oc.BRepBuilderAPI_MakeWire());
  pts.forEach((p, i) => mw.Add(s.track(s.track(new oc.BRepBuilderAPI_MakeEdge(at(p), at(pts[(i + 1) % pts.length]))).Edge())));
  if (!mw.IsDone()) throw new OpError("could not build the thread's profile");
  return s.track(mw.Wire());
}

/** The solid of revolution of a polygon (radius, along) about the frame's axis. */
function revolved(oc: OC, s: Scope, frame: AxisFrame, pts: [number, number][]): TopoDS_Shape {
  const face = s.track(s.track(new oc.BRepBuilderAPI_MakeFace(polygonWire(oc, s, frame, pts), true)).Face());
  const axis = s.track(new oc.gp_Ax1(pnt(oc, s, frame.origin), dir(oc, s, frame.z)));
  const mk = s.track(new oc.BRepPrimAPI_MakeRevol(face, axis, 2 * Math.PI, false));
  if (!mk.IsDone()) throw new OpError("could not build the thread's chamfer");
  return s.track(mk.Shape());
}

export const kernel: KernelOp<ThreadFeature> = {
  op: "thread",
  run(ctx, f) {
    const { oc } = ctx;
    const face = findFace(ctx, f.face, "face");
    const cyl = face.cylinder;
    if (face.type !== "cylinder" || !cyl) throw new OpError("face: a thread goes on a cylindrical face (a shaft, or a hole's wall); that face is not round");
    const internal = cyl.concave;
    const surfaceD = 2 * cyl.radius;
    const std = f.size ? screwSize(f.size)! : sizeFor(surfaceD, internal);
    if (!std) {
      throw new OpError(`size: the ${internal ? "hole" : "shaft"} is Ø${roundTo(surfaceD, 4)}, which fits no ISO metric size (${internal ? "a hole is its size's tap drill" : "a shaft is its size's major diameter"}, within ${FIT} mm): give "size"`);
    }
    const pitch = f.pitch ?? std.pitch;
    const minor = basicMinor(std.d, pitch);
    if (internal && surfaceD >= std.d) throw new OpError(`size: the hole is Ø${roundTo(surfaceD, 4)}, as wide as an ${std.size} thread's major diameter ${std.d}: there is nothing to thread; drill it ${std.tapDrill} (the tap drill)`);
    if (!internal && surfaceD <= minor) throw new OpError(`size: the shaft is Ø${roundTo(surfaceD, 4)}, no wider than an ${std.size}×${pitch} thread's minor diameter ${roundTo(minor, 4)}: make it ${std.d}, or pick a smaller size`);
    // Its ends along the axis; the start is the end furthest "up" (or the other with reverse).
    const a = normalize3(cyl.axis);
    const ends: [Vec3, Vec3] = [add3(cyl.origin, scale3(a, cyl.axial[0])), add3(cyl.origin, scale3(a, cyl.axial[1]))];
    const up = upward(a);
    let [start, end] = dot3(ends[1], up) >= dot3(ends[0], up) ? [ends[1], ends[0]] : [ends[0], ends[1]];
    if (f.reverse) [start, end] = [end, start];
    const faceLength = cyl.axial[1] - cyl.axial[0];
    const into = normalize3(add3(end, scale3(start, -1)));
    const length = f.length ?? faceLength;
    if (length > faceLength + 1e-6) throw new OpError(`length: ${length} mm is longer than the face (${roundTo(faceLength, 4)} mm)`);
    const body = face.body ?? [...ctx.bodies.keys()][0];
    const thread: ThreadSpec = {
      designation: `${std.size}×${roundTo(pitch, 6)}${f.leftHanded ? " LH" : ""}`,
      major: std.d,
      pitch,
      class: internal ? THREAD_CLASS : EXTERNAL_CLASS,
      depth: roundTo(length, 6),
      ...(internal ? {} : { external: true }),
      ...(f.modelled ? { modelled: true } : {}),
    };
    const record: HoleRecord = {
      feature: f.id,
      entry: start.map((x) => roundTo(x, 6)) as Vec3,
      axis: into.map((x) => roundTo(x, 9)) as Vec3,
      diameter: internal ? roundTo(surfaceD, 6) : std.d,
      depth: roundTo(length, 6),
      // A shaft's thread is called out by its thread alone (no drill under it).
      through: !internal,
      size: std.size,
      thread,
      copies: 0,
    };
    if (!f.modelled) {
      ctx.holes.record(record, [body]);
      return;
    }
    const turns = length / pitch + 2;
    if (turns > MAX_TURNS) throw new OpError(`a modelled thread of ${Math.round(turns)} turns is more than ${MAX_TURNS}: keep it cosmetic (modelled: false), or model a shorter length`);
    scoped((s) => {
      const spec: ThreadTool = { start, into, major: std.d, pitch, length, surface: cyl.radius, internal, leftHanded: !!f.leftHanded, chamfer: !!f.chamfer, toEnd: length > faceLength - 1e-6 };
      const before = ctx.need(body);
      const was = volumeOf(oc, s, before);
      const expected = grooveVolume(!internal, std.d, pitch, cyl.radius, length);
      const cut = (tools: TopoDS_Shape[], on: TopoDS_Shape): TopoDS_Shape | null => {
        const op = s.track(new oc.BRepAlgoAPI_Cut());
        op.SetArguments(s.track(new oc.NCollection_List_TopoDS_Shape([on])));
        op.SetTools(s.track(new oc.NCollection_List_TopoDS_Shape(tools)));
        op.Build(s.track(new oc.Message_ProgressRange()));
        if (!op.IsDone() || op.HasErrors()) return null;
        const out = unify(oc, s, s.track(op.Shape()));
        return isValidShape(oc, s, out) ? out : null;
      };
      // The groove swept whole is quick, but where a plane of the body meets it the boolean can misjudge it: what it
      // takes is checked against the groove's volume, turned a little and tried again, and else cut a turn at a time.
      let after: TopoDS_Shape | null = null;
      for (const angle of [0, 37, 101]) {
        const got = cut(threadTool(oc, s, spec, { whole: true, angle }), before);
        if (got && Math.abs(was - volumeOf(oc, s, got) - expected) <= 0.02 * expected) {
          after = got;
          break;
        }
      }
      after ??= cut(threadTool(oc, s, spec), before);
      if (!after) throw new OpError(`cutting the thread left body "${body}" invalid; try another length, or keep the thread cosmetic`);
      if (f.chamfer) after = cut([chamferTool(oc, s, spec)], after);
      if (!after) throw new OpError("the run-out chamfer could not be cut; leave it out, or keep the thread cosmetic");
      if (was - volumeOf(oc, s, after) <= 1e-9) throw new OpError("the thread cuts nothing: check the face");
      ctx.commit(new Map([[body, after]]));
    });
    ctx.holes.record(record, [body]);
  },
};

export interface ThreadTool {
  start: Vec3;
  /** Unit: from the start along the thread. */
  into: Vec3;
  major: number;
  pitch: number;
  length: number;
  /** The face's radius: the shaft's (external) or the bore's (internal). */
  surface: number;
  internal: boolean;
  leftHanded: boolean;
  chamfer: boolean;
  /** The thread runs to the face's far end. */
  toEnd?: boolean;
}

/**
 * What a modelled thread cuts: the groove swept along the helix (whole, or
 * a turn a piece), trimmed to the length. Each piece is a tool of its own.
 */
export function threadTool(oc: OC, s: Scope, t: ThreadTool, opts: { whole?: boolean; angle?: number } = {}): TopoDS_Shape[] {
  const external = !t.internal;
  const P = t.pitch;
  const minorR = basicMinor(t.major, P) / 2;
  const outline = grooveOutline(external, t.major, P, 0.05 * P);
  // The helix starts a pitch before the thread does, so the groove is whole at the start; trimmed back after.
  const turns = t.length / P + 2;
  const sweep = (k: number, n: number): TopoDS_Shape => {
    const frame = axisFrame(add3(t.start, scale3(t.into, (k - 1) * P)), t.into, opts.angle ?? 0);
    const helix = helixEdge(oc, s, frame, minorR, P, n, { leftHanded: t.leftHanded });
    const spine = s.track(s.track(new oc.BRepBuilderAPI_MakeWire(helix)).Wire());
    const ps = s.track(new oc.BRepOffsetAPI_MakePipeShell(spine));
    // The tooth keeps its place across the axis as it winds (binormal along the axis).
    ps.SetMode(dir(oc, s, t.into));
    ps.Add(polygonWire(oc, s, frame, outline), false, false);
    ps.Build(s.track(new oc.Message_ProgressRange()));
    if (!ps.IsDone() || !ps.MakeSolid()) throw new OpError("could not sweep the thread's profile along its helix");
    const piece = s.track(ps.Shape());
    return volumeOf(oc, s, piece) < 0 ? s.track(piece.Reversed()) : piece;
  };
  // Trimmed to the length: what lies between the start and `length` along the axis, a hair past the face's ends
  // (the start is one; the far end when the thread runs the whole face).
  const e = 0.01;
  const lo = -e;
  const hi = t.length + (t.toEnd ? e : 0);
  const slab = s.track(
    s.track(new oc.BRepPrimAPI_MakeCylinder(s.track(new oc.gp_Ax2(pnt(oc, s, add3(t.start, scale3(t.into, lo))), dir(oc, s, t.into))), t.major / 2 + 2 * P, hi - lo)).Shape(),
  );
  const pieces: TopoDS_Shape[] = [];
  const half = P / 2;
  // Whole: one sweep of every turn (quick); else a turn a piece.
  const step = opts.whole ? turns : 1;
  for (let k = 0; k < turns; k += step) {
    const n = Math.min(step, turns - k);
    let piece = sweep(k, n);
    // A piece reaches half a pitch either side of its turn: only those across an end need trimming.
    const from = (k - 1) * P - half;
    const to = (k - 1 + n) * P + half;
    if (to <= lo || from >= hi) continue;
    if (from < lo || to > hi) {
      const common = s.track(new oc.BRepAlgoAPI_Common(piece, slab, s.track(new oc.Message_ProgressRange())));
      if (!common.IsDone()) throw new OpError("could not trim the thread to its length");
      piece = s.track(common.Shape());
      if (volumeOf(oc, s, piece) <= 1e-9) continue;
    }
    pieces.push(piece);
  }
  return pieces;
}

/** A modelled thread's 45° run-out chamfer at its start: down to the minor diameter on a shaft, out to the major in a hole. */
export function chamferTool(oc: OC, s: Scope, t: ThreadTool): TopoDS_Shape {
  const minorR = basicMinor(t.major, t.pitch) / 2;
  const d = 0.05 * t.pitch;
  const R = t.surface;
  const pts: [number, number][] = t.internal
    ? [
        [t.major / 2 + d, -d],
        [R - d, -d],
        [R - d, t.major / 2 - R + 2 * d],
      ]
    : [
        [minorR - d, -d],
        [R + d, -d],
        [R + d, R + d - minorR],
      ];
  return revolved(oc, s, axisFrame(t.start, t.into), pts);
}
