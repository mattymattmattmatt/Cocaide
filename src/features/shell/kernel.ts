// shell, kernel side. Faces removed: BRepOffsetAPI_MakeThickSolid's
// MakeThickSolidByJoin (offset -thickness inward, +thickness outward). No
// faces removed: the body offset by the thickness (MakeOffsetShape) and the
// two cut one from the other, which leaves a closed void inside (or the body
// as a void inside a bigger one, outward). OCCT does not always fail when the
// walls cannot fit (it may hand the body back unchanged), so the volume must
// have changed (gone down, inward), and the result must be valid.

import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { FaceInfo } from "../../kernel/topology";
import { isValidShape, volumeOf } from "../../kernel/measure";
import { scoped, type OC, type Scope } from "../../kernel/oc";
import { boolean, OpError, VOLUME_EPS } from "../../kernel/ops";
import { bodyOfFaces, pickFaces } from "../../kernel/pickFaces";
import type { KernelOp } from "../kernelDefs";
import type { ShellFeature } from "./doc";

export const kernel: KernelOp<ShellFeature> = {
  op: "shell",
  run(ctx, f) {
    if (ctx.bodies.size === 0) throw new OpError("nothing to shell: there is no solid before this feature");
    const { oc } = ctx;
    let name = "";
    scoped((s) => {
      const part = ctx.part(s, false);
      const picked = pickFaces(part, f.faces);
      name = bodyOfFaces(picked, f.body, [...ctx.bodies.keys()], "shell");
      const body = ctx.need(name);
      const before = volumeOf(oc, s, body);
      const offset = f.outward ? f.thickness : -f.thickness;
      let result: TopoDS_Shape | null = null;
      try {
        result = picked.length ? thickSolid(oc, s, body, picked.map((p) => p.face), offset) : hollow(oc, s, body, offset);
      } catch (e) {
        if (e instanceof OpError) throw e;
        result = null; // an OCCT exception: the walls did not work out
      }
      const after = result ? volumeOf(oc, s, result) : NaN;
      // Inward walls take material away; outward ones are all that is left (the body as it was becomes the cavity).
      const eps = VOLUME_EPS * Math.max(1, before);
      const changed = after > eps && (f.outward ? Math.abs(after - before) > eps : before - after > eps);
      if (!result || !changed || !isValidShape(oc, s, result)) {
        const removed = new Set(picked.map((p) => p.index));
        const own = part.faceInfos.filter((i) => i.body === undefined || i.body === name);
        throw new OpError(wallsMessage(f, own, removed));
      }
      ctx.commit(new Map([[name, result]]));
    });
    // A hollowed member is no longer a length of stock.
    ctx.members.drop(name);
  },
};

/** The body with the faces removed and walls `offset` thick (negative: inward). */
function thickSolid(oc: OC, s: Scope, body: TopoDS_Shape, faces: TopoDS_Shape[], offset: number): TopoDS_Shape | null {
  const list = s.track(new oc.NCollection_List_TopoDS_Shape());
  for (const face of faces) list.Append(face);
  // Outward walls keep the body's corners sharp outside, as the inward ones are inside; arcs where intersections fail.
  for (const join of offset > 0 ? [oc.GeomAbs_JoinType.GeomAbs_Intersection, oc.GeomAbs_JoinType.GeomAbs_Arc] : [oc.GeomAbs_JoinType.GeomAbs_Arc]) {
    const maker = s.track(new oc.BRepOffsetAPI_MakeThickSolid());
    try {
      maker.MakeThickSolidByJoin(body, list, offset, 1e-3, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, join, false, s.track(new oc.Message_ProgressRange()));
    } catch {
      continue;
    }
    if (maker.IsDone()) return s.track(maker.Shape());
  }
  return null;
}

/** A closed hollow: the body less its inward offset, or its outward offset less the body. */
function hollow(oc: OC, s: Scope, body: TopoDS_Shape, offset: number): TopoDS_Shape | null {
  const maker = s.track(new oc.BRepOffsetAPI_MakeOffsetShape());
  maker.PerformByJoin(body, offset, 1e-3, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Intersection, false, s.track(new oc.Message_ProgressRange()));
  if (!maker.IsDone()) return null;
  const other = s.track(maker.Shape());
  try {
    return offset < 0 ? boolean(oc, s, "cut", body, other) : boolean(oc, s, "cut", other, body);
  } catch {
    return null; // an offset that turned itself inside out: the walls do not fit
  }
}

/**
 * Why the shell failed, as precisely as the faces tell: the thinnest part of
 * the body between two opposite flat faces, and how thin walls must be there
 * (half of it where both faces keep a wall, all of it where one is removed).
 */
export function wallsMessage(f: Pick<ShellFeature, "thickness" | "outward">, faces: readonly FaceInfo[], removed: ReadonlySet<number>): string {
  const t = f.thickness;
  if (!f.outward) {
    let limit = Infinity;
    let across = Infinity;
    const flat = faces.filter((x) => x.type === "plane" && x.normal && x.offset !== undefined);
    for (let i = 0; i < flat.length; i++) {
      for (let j = i + 1; j < flat.length; j++) {
        const a = flat[i];
        const b = flat[j];
        const dot = a.normal![0] * b.normal![0] + a.normal![1] * b.normal![1] + a.normal![2] * b.normal![2];
        if (dot > -1 + 1e-9) continue;
        const d = a.offset! + b.offset!;
        if (d <= 1e-9) continue;
        const open = removed.has(a.index) || removed.has(b.index);
        if (removed.has(a.index) && removed.has(b.index)) continue;
        const max = open ? d : d / 2;
        if (max < limit) {
          limit = max;
          across = d;
        }
      }
    }
    if (Number.isFinite(limit) && t >= limit - 1e-9) {
      return `${fmt(t)} mm walls do not fit: the thinnest part is ${fmt(across)} mm across, so the walls must be thinner than ${fmt(limit)} mm`;
    }
  }
  return "shell failed: try a thinner wall or fewer faces";
}

function fmt(x: number): string {
  return String(Math.round(x * 1e4) / 1e4);
}
