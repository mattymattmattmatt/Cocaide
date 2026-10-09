// draft, kernel side: BRepOffsetAPI_DraftAngle, one body at a time, each
// picked face added with the pull direction, the angle and the neutral plane.
// A face the kernel refuses (AddDone false) is named by the selector that
// picked it. The result must be valid and its volume changed.

import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { Vec3 } from "../../doc/types";
import { dot3, formatDirection, roundTo, scale3 } from "../../geom/vec";
import { resolveDatum } from "../../kernel/datum";
import { isValidShape, volumeOf } from "../../kernel/measure";
import { scoped } from "../../kernel/oc";
import { dir, OpError, pnt, VOLUME_EPS } from "../../kernel/ops";
import { pickFaces, type PickedFace } from "../../kernel/pickFaces";
import type { FaceInfo } from "../../kernel/topology";
import type { KernelOp } from "../kernelDefs";
import type { DraftFeature } from "./doc";

export const kernel: KernelOp<DraftFeature> = {
  op: "draft",
  run(ctx, f) {
    if (ctx.bodies.size === 0) throw new OpError("nothing to draft: there is no solid before this feature");
    const { oc } = ctx;
    const plane = resolveDatum(ctx, f.neutral, "plane", "neutral");
    const pull = pullDirection(f, plane.normal);
    const rad = (f.angle * Math.PI) / 180;
    scoped((s) => {
      const part = ctx.part(s, false);
      const picked = pickFaces(part, f.faces);
      for (const p of picked) {
        const info = part.faceInfos[p.index];
        if (info.type === "plane" && info.normal && Math.abs(dot3(info.normal, pull)) > 1 - 1e-9) {
          throw new OpError(`${p.path}: ${faceName(info)} is parallel to the neutral plane: there is nothing to taper (draft the faces that run along the pull direction)`);
        }
      }
      const byBody = new Map<string, PickedFace[]>();
      for (const p of picked) {
        const name = p.body ?? [...ctx.bodies.keys()][0];
        byBody.set(name, [...(byBody.get(name) ?? []), p]);
      }
      const neutral = s.track(new oc.gp_Pln(pnt(oc, s, plane.origin), dir(oc, s, plane.normal)));
      const pullDir = dir(oc, s, pull);
      const changed = new Map<string, TopoDS_Shape>();
      for (const [name, faces] of byBody) {
        const body = ctx.need(name);
        const where = byBody.size > 1 ? ` in body "${name}"` : "";
        const maker = s.track(new oc.BRepOffsetAPI_DraftAngle(body));
        for (const p of faces) {
          maker.Add(p.face, pullDir, rad, neutral, true);
          if (!maker.AddDone()) {
            const bad = s.track(maker.ProblematicShape());
            const culprit = faces.find((q) => q.face.IsSame(bad)) ?? p;
            throw new OpError(`${culprit.path}: ${faceName(part.faceInfos[culprit.index])}${where} cannot be drafted ${f.angle}° about the neutral plane: try a smaller angle, flip the pull direction, or leave that face out`);
          }
        }
        maker.Build(s.track(new oc.Message_ProgressRange()));
        if (!maker.IsDone()) throw new OpError(`the draft failed in the kernel${where}: try a smaller angle, or draft fewer faces at once`);
        const result = s.track(maker.Shape());
        if (!isValidShape(oc, s, result)) throw new OpError(`the draft produced an invalid solid${where}: try a smaller angle`);
        const before = volumeOf(oc, s, body);
        if (Math.abs(volumeOf(oc, s, result) - before) <= VOLUME_EPS * Math.max(1, before)) throw new OpError(`the draft changed nothing${where}: do the faces cross the neutral plane's side they lean from?`);
        changed.set(name, result);
      }
      ctx.commit(changed);
    });
  },
};

/** The pull direction: the neutral plane's normal; into the part from a face of it; reversed by flip. */
export function pullDirection(f: Pick<DraftFeature, "neutral" | "flip">, normal: Vec3): Vec3 {
  const fromFace = "face" in f.neutral;
  return scale3(normal, (fromFace ? -1 : 1) * (f.flip ? -1 : 1));
}

function faceName(info: FaceInfo): string {
  const at = `at [${info.centroid.map((x) => roundTo(x, 3)).join(", ")}]`;
  if (info.type === "plane" && info.normal) return `the flat face with normal ${formatDirection(info.normal)} ${at}`;
  return `the ${info.type === "other" ? "curved" : info.type === "cylinder" ? "cylindrical" : "conical"} face ${at}`;
}
