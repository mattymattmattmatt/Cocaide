// plane, kernel side: resolve the references on the part as it stands, work
// out the plane (src/features/datum.ts has the geometry), and keep it in
// ctx.datums for what comes after. No body changes. A plane that cannot be
// made says which reference to change and to what.

import { sketchEntityPlace } from "../../geom/sketchEdge";
import { formatDirection } from "../../geom/vec";
import { dot3, normalize3, sub3 } from "../../geom/vec";
import { edgePlace, findFace, nameOf, resolveDatum, sketchSource } from "../../kernel/datum";
import { boundingBoxOf } from "../../kernel/measure";
import { scoped } from "../../kernel/oc";
import { OpError } from "../../kernel/ops";
import {
  anglePlane,
  bestFitPlane,
  betweenPointsPlane,
  cleanDatum,
  flipPlane,
  lineAndPointPlane,
  midPlane,
  offsetPlane,
  perpendicularPlane,
  planeDatum,
  tangentPlane,
  threePointPlane,
  throughPointPlane,
  twoLinesPlane,
  type PlaneDatum,
} from "../datum";
import type { KernelOp } from "../kernelDefs";
import type { PlaneFeature } from "./doc";

export const kernel: KernelOp<PlaneFeature> = {
  op: "plane",
  run(ctx, f) {
    const plane = (i: number) => resolveDatum(ctx, f.refs[i], "plane", `refs[${i}]`);
    const point = (i: number) => resolveDatum(ctx, f.refs[i], "point", `refs[${i}]`).at;
    let p: PlaneDatum;
    switch (f.mode) {
      case "offset":
        p = offsetPlane(plane(0), f.distance ?? 0);
        break;
      case "angle": {
        const base = plane(0);
        const axis = resolveDatum(ctx, f.refs[1], "axis", "refs[1]");
        const turned = anglePlane(base, axis, f.angle ?? 0);
        if (!turned) {
          throw new OpError(
            `refs[1]: ${nameOf(f.refs[1])} runs ${formatDirection(axis.direction)}, out of ${nameOf(f.refs[0])} (normal ${formatDirection(base.normal)}): ` +
              "pick an edge or axis that lies in the plane or runs parallel to it, or use mode \"normalToEdge\" for a plane square to it",
          );
        }
        p = turned;
        break;
      }
      case "threePoints": {
        const made = threePointPlane(point(0), point(1), point(2));
        if (!made) throw new OpError("refs: the three points lie on one line (or two are the same point), so no one plane goes through them: pick a third point off the line through the other two");
        p = made;
        break;
      }
      case "midplane":
        p = midPlane(plane(0), plane(1));
        break;
      case "normalToEdge": {
        const ref = f.refs[0];
        if ("edge" in ref) {
          const place = f.refs[1] ? edgePlace(ctx, ref.edge, "refs[0].edge", { near: point(1) }) : edgePlace(ctx, ref.edge, "refs[0].edge", { t: f.t ?? 0 });
          // Through the point given, else the point of the edge at t; square to the edge there.
          p = planeDatum(f.refs[1] ? point(1) : place.at, place.tangent);
        } else if ("sketch" in ref) {
          // Another sketch's line, arc or circle, as it was solved: square to it at t (or where it passes nearest the point), as an edge.
          const { entity, frame } = sketchSource(ctx, ref, "refs[0]");
          const place = sketchEntityPlace(entity, frame, f.refs[1] ? { near: point(1) } : { t: f.t ?? 0 });
          if (typeof place === "string") throw new OpError(`refs[0]: ${place}`);
          p = planeDatum(f.refs[1] ? point(1) : place.at, place.tangent);
        } else {
          const axis = resolveDatum(ctx, ref, "axis", "refs[0]");
          p = planeDatum(f.refs[1] ? point(1) : axis.origin, axis.direction);
        }
        break;
      }
      case "parallelThroughPoint":
        p = throughPointPlane(plane(0), point(1));
        break;
      case "lineAndPoint": {
        const made = lineAndPointPlane(resolveDatum(ctx, f.refs[0], "axis", "refs[0]"), point(1));
        if (!made) throw new OpError(`refs[1]: ${nameOf(f.refs[1])} is on the line ${nameOf(f.refs[0])}, so any plane through the line goes through it: pick a point off the line`);
        p = made;
        break;
      }
      case "twoLines": {
        const made = twoLinesPlane(resolveDatum(ctx, f.refs[0], "axis", "refs[0]"), resolveDatum(ctx, f.refs[1], "axis", "refs[1]"));
        if (!made) throw new OpError("refs: the two lines are the same line, so no one plane holds them: pick a second line beside the first");
        p = made;
        break;
      }
      case "perpendicular": {
        const made = perpendicularPlane(resolveDatum(ctx, f.refs[0], "axis", "refs[0]"), plane(1));
        if (!made) throw new OpError(`refs[0]: ${nameOf(f.refs[0])} is square to ${nameOf(f.refs[1])}, so every plane through it is square to it too: use mode "angle" about the line, or pick a line that lies in (or along) the plane`);
        p = made;
        break;
      }
      case "tangent": {
        const ref = f.refs[0];
        if (!("face" in ref)) throw new OpError("refs[0]: pick a cylindrical face");
        const face = findFace(ctx, ref.face, "refs[0].face");
        if (face.type !== "cylinder" || !face.cylinder) throw new OpError(`refs[0].face: the face is ${face.type === "cone" ? "a cone" : face.type === "plane" ? "flat" : "curved but not a cylinder"}: a tangent plane needs a cylindrical face (use "offset" or "parallelThroughPoint" for a flat one)`);
        const axis = { kind: "axis" as const, origin: face.cylinder.origin, direction: normalize3(face.cylinder.axis) };
        const other = resolveDatum(ctx, f.refs[1], "any", "refs[1]");
        let towards: [number, number, number];
        if (other.kind === "plane") {
          if (Math.abs(dot3(normalize3(other.normal), axis.direction)) > 1e-6) {
            throw new OpError(`refs[1]: ${nameOf(f.refs[1])} (normal ${formatDirection(other.normal)}) is not parallel to the cylinder's axis (${formatDirection(axis.direction)}), so no tangent plane is parallel to it: pick a plane the axis runs along, or a point`);
          }
          towards = normalize3(other.normal);
        } else if (other.kind === "point") {
          towards = sub3(other.at, axis.origin);
        } else throw new OpError(`refs[1]: ${nameOf(f.refs[1])} is an axis: pick a plane parallel to the cylinder's axis, or a point`);
        const made = tangentPlane(axis, face.cylinder.radius, f.back ? [-towards[0], -towards[1], -towards[2]] : towards);
        if (!made) throw new OpError(`refs[1]: ${nameOf(f.refs[1])} is on the cylinder's axis, so it doesn't say which side to touch: pick a point off the axis`);
        p = made;
        break;
      }
      case "betweenPoints": {
        const made = betweenPointsPlane(point(0), point(1));
        if (!made) throw new OpError("refs: the two points are the same point: pick two different points (two hole centres, two vertices)");
        p = made;
        break;
      }
      case "bestFit": {
        const pts = f.refs.map((_, i) => point(i));
        const fit = bestFitPlane(pts);
        if (!fit) throw new OpError("refs: the points lie on one line, so no one plane fits them best: add a point off that line");
        p = fit.plane;
        break;
      }
      case "centre": {
        const base = plane(0);
        const shapes = f.body ? [ctx.bodies.get(f.body)] : [...ctx.bodies.values()];
        if (f.body && !shapes[0]) throw new OpError(`body: there is no body "${f.body}" before this feature (there are ${[...ctx.bodies.keys()].join(", ") || "none"})`);
        if (!shapes.length) throw new OpError("there is no solid before this feature to find the middle of");
        const box = scoped((s) => {
          let lo: number[] | null = null;
          let hi: number[] | null = null;
          for (const shape of shapes) {
            const b = boundingBoxOf(ctx.oc, s, shape!);
            if (!b) continue;
            lo = lo ? lo.map((v, i) => Math.min(v, b.min[i])) : [...b.min];
            hi = hi ? hi.map((v, i) => Math.max(v, b.max[i])) : [...b.max];
          }
          return lo && hi ? { lo, hi } : null;
        });
        if (!box) throw new OpError("the part has no extent to find the middle of");
        // The middle along the plane's normal: half way between the part's extremes that way (the box's, for a box-aligned normal).
        const n = normalize3(base.normal);
        const corners: number[][] = [];
        for (const x of [box.lo[0], box.hi[0]]) for (const y of [box.lo[1], box.hi[1]]) for (const z of [box.lo[2], box.hi[2]]) corners.push([x, y, z]);
        const along = corners.map((c) => dot3(sub3(c as [number, number, number], base.origin), n));
        p = offsetPlane(base, (Math.min(...along) + Math.max(...along)) / 2);
        break;
      }
    }
    ctx.datums.set(f.id, cleanDatum(f.flip ? flipPlane(p) : p));
  },
};
