// A whole part as STEP, the way the app and the MCP server export it: the
// product named by the part number (else the part's name), its description
// and author from the part's properties, and the photo note when the part was
// estimated from a photo (that note wins the file description: it matters more).
//
// Export bodies (the Bodies panel): only the bodies asked for, and, given a
// frame, moved so that frame becomes the file's axes: its origin the file's
// origin, its x, y and z the file's X, Y and Z (a new origin point, and which
// way is up and which way the front faces).

import type { TopoDS_Shape } from "replicad-opencascadejs";
import { photoNote } from "../doc/photo";
import { partProperties, stepProduct } from "../doc/properties";
import type { Vec3 } from "../doc/types";
import type { ExportFrame } from "../geom/exportFrame";
import { compound } from "./bodies";
import { scoped, type OC } from "./oc";
import type { RebuildResult } from "./rebuild";
import { exportSTEP } from "./step";

export type { ExportFrame };

export interface StepExportOptions {
  /** Only these bodies (default: all). */
  bodies?: string[];
  /** Re-placed so this frame is the file's axes (default: as modelled). */
  frame?: ExportFrame;
  /** The product's name in the file (default: the part's). */
  name?: string;
}

/** Whether a frame is a right-handed set of unit axes at right angles (what a placement can be). */
export function frameProblem(f: ExportFrame): string | null {
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a: Vec3) => Math.hypot(...a);
  if (![...f.origin, ...f.x, ...f.y, ...f.z].every(Number.isFinite)) return "the frame has a number that isn't one";
  if ([f.x, f.y, f.z].some((v) => Math.abs(len(v) - 1) > 1e-6)) return "the frame's axes must be unit length";
  if (Math.abs(dot(f.x, f.y)) > 1e-6 || Math.abs(dot(f.y, f.z)) > 1e-6 || Math.abs(dot(f.z, f.x)) > 1e-6) return "the frame's axes must be at right angles";
  const cx: Vec3 = [f.x[1] * f.y[2] - f.x[2] * f.y[1], f.x[2] * f.y[0] - f.x[0] * f.y[2], f.x[0] * f.y[1] - f.x[1] * f.y[0]];
  if (dot(cx, f.z) < 0.999999) return "the frame must be right-handed (z = x × y)";
  return null;
}

export function exportPartSTEP(oc: OC, built: RebuildResult, doc: unknown, opts: StepExportOptions = {}): string {
  if (!built.solid) throw new Error("there is no solid to export");
  const product = stepProduct(doc, built.name);
  const p = partProperties(doc);
  const name = opts.name?.trim() || product.name;
  const description = photoNote(doc) ?? product.description;
  const extra = { author: p.author, productDescription: product.description };
  if (!opts.bodies && !opts.frame) return exportSTEP(oc, built.solid, name, description, built.bodies, extra);

  const chosen = opts.bodies ? built.bodies.filter((b) => opts.bodies!.includes(b.name)) : built.bodies;
  if (opts.bodies) {
    const missing = opts.bodies.filter((n) => !built.bodies.some((b) => b.name === n));
    if (missing.length) throw new Error(`no body ${missing.map((n) => `"${n}"`).join(", ")} in the part (bodies: ${built.bodies.map((b) => b.name).join(", ")})`);
  }
  if (!chosen.length) throw new Error("no bodies chosen to export");
  if (opts.frame) {
    const problem = frameProblem(opts.frame);
    if (problem) throw new Error(problem);
  }
  return scoped((s) => {
    const place = (shape: TopoDS_Shape): TopoDS_Shape => {
      const f = opts.frame;
      if (!f) return shape;
      // Model point p goes to (x·(p - o), y·(p - o), z·(p - o)): the rows are the frame's axes.
      const t = s.track(new oc.gp_Trsf());
      const o = f.origin;
      const tr = (a: Vec3) => -(a[0] * o[0] + a[1] * o[1] + a[2] * o[2]);
      t.SetValues(f.x[0], f.x[1], f.x[2], tr(f.x), f.y[0], f.y[1], f.y[2], tr(f.y), f.z[0], f.z[1], f.z[2], tr(f.z));
      return s.track(s.track(new oc.BRepBuilderAPI_Transform(shape, t, true, false)).Shape());
    };
    const bodies = chosen.map((b) => ({ name: b.name, shape: place(b.shape) }));
    if (bodies.length === 1) return exportSTEP(oc, bodies[0].shape, name, description, undefined, extra);
    return exportSTEP(oc, compound(oc, s, bodies.map((b) => b.shape)), name, description, bodies, extra);
  });
}
