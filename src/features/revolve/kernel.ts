// revolve, kernel side: the profile faces (or the thin wall's band) turned
// about the axis with BRepPrimAPI_MakeRevol, then put in the part by the
// operation (new body, add, cut, intersect). Before anything is built the
// axis is checked: in the sketch's plane, and not through the profile.

import type { Vec3 } from "../../doc/types";
import { to2D, to3D, type Frame } from "../../geom/frame";
import { buildProfile, type Region } from "../../geom/profile";
import { dot3, len3, normalize3, roundTo, scale3, sub3 } from "../../geom/vec";
import { nameOf, resolveDatum } from "../../kernel/datum";
import { scoped } from "../../kernel/oc";
import { applyOperation } from "../../kernel/operation";
import { compoundOf, dir, noClosedProfile, OpError, pnt, profileFaces, type SketchProfile } from "../../kernel/ops";
import type { KernelOp, RebuildCtx } from "../kernelDefs";
import { awayFromAxis, axisCrossing, BandError, closedBands, openBand, openChain, regionSegs, regionsArea, wallOffsets, type Line2 } from "./band";
import { isLineAxis, type RevolveFeature } from "./doc";

export const kernel: KernelOp<RevolveFeature> = {
  op: "revolve",
  run(ctx, f) {
    const { oc } = ctx;
    const base = ctx.profiles.get(f.sketch);
    const sketch = ctx.sketch(f.sketch);
    if (!base || !sketch) throw new OpError(`${ctx.missing(f.sketch, "sketch")}, so there is no profile to revolve`);
    const frame = base.frame;
    const axis = revolveAxis(ctx, f, frame);
    const regions = band(() => profileRegions(f, base, sketch.entities, axis));
    const crossing = axisCrossing(regionSegs(regions), axis.in2D);
    if (crossing) throw new OpError(crossing);
    const profile: SketchProfile = { frame, regions, area: regionsArea(regions) };

    // Where it starts and how far it turns: from the sketch plane, back by angle2 (or half of it all, midplane).
    const angle = f.angle ?? 360;
    const total = f.midplane ? angle : angle + (f.angle2 ?? 0);
    const start = f.midplane ? -angle / 2 : -(f.angle2 ?? 0);
    const direction = f.reverse ? scale3(axis.direction, -1) : axis.direction;
    scoped((s) => {
      const ax1 = s.track(new oc.gp_Ax1(pnt(oc, s, axis.origin), dir(oc, s, direction)));
      const solids = profileFaces(oc, s, profile).map((face) => {
        let from = face;
        if (Math.abs(start) > 1e-12) {
          const t = s.track(new oc.gp_Trsf());
          t.SetRotation(ax1, (start * Math.PI) / 180);
          from = s.track(oc.TopoDS.Face(s.track(s.track(new oc.BRepBuilderAPI_Transform(face, t, true, false)).Shape())));
        }
        const full = total >= 360 - 1e-9;
        const r = s.track(full ? new oc.BRepPrimAPI_MakeRevol(from, ax1, false) : new oc.BRepPrimAPI_MakeRevol(from, ax1, (total * Math.PI) / 180, false));
        if (!r.IsDone()) throw new OpError("the revolve failed in the kernel");
        return s.track(r.Shape());
      });
      applyOperation(ctx, s, f, compoundOf(oc, s, solids), "revolve");
    });
  },
};

/** The axis in the model and in the sketch's own coordinates; `line` when it is a non-construction line of the sketch (left out of the profile). */
interface Axis {
  origin: Vec3;
  direction: Vec3;
  in2D: Line2;
  line?: string;
}

function revolveAxis(ctx: RebuildCtx, f: RevolveFeature, frame: Frame): Axis {
  if (isLineAxis(f.axis)) {
    const id = f.axis.line;
    const entities = ctx.sketch(f.sketch)?.entities ?? [];
    const e = entities.find((x) => x.id === id);
    if (!e || e.type !== "line") {
      const lines = entities.filter((x) => x.type === "line").map((x) => `"${x.id}"${x.construction ? " (construction)" : ""}`);
      const what = e ? `"${id}" is a ${e.type}, not a line` : `sketch "${f.sketch}" has no line "${id}"`;
      throw new OpError(`axis.line: ${what}; ${lines.length ? `its lines: ${lines.join(", ")}` : "it has no lines: draw a centreline to turn about"}`);
    }
    const a = to3D(frame, e.start);
    const b = to3D(frame, e.end);
    const length = len3(sub3(b, a));
    if (length < 1e-9) throw new OpError(`axis.line: line "${id}" has zero length, so it has no direction to turn about`);
    const u2 = [(e.end[0] - e.start[0]) / length, (e.end[1] - e.start[1]) / length] as [number, number];
    return { origin: a, direction: scale3(sub3(b, a), 1 / length), in2D: { p: e.start, u: u2 }, ...(e.construction ? {} : { line: id }) };
  }
  const d = resolveDatum(ctx, f.axis, "axis", "axis");
  const direction = normalize3(d.direction);
  const off = Math.abs(dot3(direction, frame.z));
  if (off > 1e-6) {
    const deg = roundTo((Math.asin(Math.min(1, off)) * 180) / Math.PI, 3);
    throw new OpError(`axis: ${nameOf(f.axis)} is not in the sketch's plane (it is at ${deg}° to it): a revolve axis must lie in the plane of the profile`);
  }
  const gap = dot3(sub3(d.origin, frame.origin), frame.z);
  if (Math.abs(gap) > 1e-6) throw new OpError(`axis: ${nameOf(f.axis)} is parallel to the sketch's plane but ${roundTo(Math.abs(gap), 4)} mm off it: a revolve axis must lie in the plane of the profile`);
  const u = [dot3(direction, frame.x), dot3(direction, frame.y)] as [number, number];
  const l = Math.hypot(u[0], u[1]);
  return { origin: d.origin, direction, in2D: { p: to2D(frame, d.origin), u: [u[0] / l, u[1] / l] } };
}

/** The regions that turn: the profile's, or the thin wall's band. */
function profileRegions(f: RevolveFeature, base: SketchProfile, entities: Parameters<typeof buildProfile>[0], axis: Axis): Region[] {
  if (f.thin) {
    const side = f.thin.side ?? "outside";
    if (base.regions.length > 0) return closedBands(base.regions, f.thin.thickness, side);
    const chain = openChain(entities, axis.line);
    const [d1, d2] = wallOffsets(f.thin.thickness, side, awayFromAxis(chain, axis.in2D));
    return [openBand(chain, d1, d2)];
  }
  if (base.regions.length > 0) return base.regions;
  // A line of the sketch drawn as the axis (not construction) is no part of the profile: without it, the rest may close.
  if (axis.line) {
    const without = buildProfile(entities.filter((e) => e.id !== axis.line));
    if (without.ok && without.regions.length > 0) return without.regions;
  }
  throw new OpError(`${noClosedProfile(f.sketch, base, "revolve")}; for an open profile, make it a thin revolve ("thin": { "thickness": 2 })`);
}

/** Runs band geometry, its errors as OpErrors. */
function band<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof BandError) throw new OpError(`thin: ${e.message}`);
    throw e;
  }
}
