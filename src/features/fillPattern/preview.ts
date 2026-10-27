// A fill pattern's places as the editor sees them, pure: the region from the
// last rebuild (a face's edges, exact for lines and circles, the mesh's
// polyline for other curves; or a sketch's drawn loops), the seed's place
// and footprint from its feature (a hole's centre and widest circle, an
// extrude's or cut's sketch outline box), and the layout (layout.ts) the
// kernel uses too. The editor counts the copies with it and skips the one
// nearest a click.

import type { FaceSelector, Vec2, Vec3 } from "../../doc/types";
import { facePlaneFrame, to2D, type Frame } from "../../geom/frame";
import { selectFaces } from "../../kernel/selectors";
import type { RebuildView } from "../../worker/protocol";
import { centresOf, wizardSpec } from "../hole/wizard";
import { boxFootprint, edgePolyline, fillPlaces, roundFootprint, type FillLayout } from "./layout";

type Raw = Record<string, unknown>;

export interface FillPreview {
  frame: Frame;
  /** Where the seed is, in the frame. */
  at: Vec2;
  /** The copies' places, in instance order (instance k + 2 at places[k]). */
  places: Vec2[];
}

type View = Pick<RebuildView, "faces" | "edges" | "mesh" | "sketches">;

/** The region: its plane frame and its edges (polylines in that frame), or why there is none. */
export function regionOf(f: Raw, view: View): { frame: Frame; boundary: Vec2[][] } | string {
  if (f.face) {
    const face = selectFaces(view.faces, f.face as FaceSelector).matches[0];
    if (!face) return "the face to fill is not there";
    if (face.type !== "plane" || !face.normal || !face.point) return "the face to fill is curved: pick a flat face";
    const frame = facePlaneFrame(face.normal, face.point);
    const boundary = view.edges
      .filter((e) => e.faces.includes(face.index) && !e.seam)
      .map((e) => {
        const r = view.mesh?.edgeRanges[e.index];
        const seg = view.mesh?.edges;
        const poly: Vec3[] | null =
          r && seg
            ? Array.from({ length: r.count + 1 }, (_, k) => {
                const i = (r.start + Math.min(k, r.count - 1)) * 6 + (k === r.count ? 3 : 0);
                return [seg[i], seg[i + 1], seg[i + 2]] as Vec3;
              })
            : null;
        return edgePolyline(e, poly).map((p) => to2D(frame, p));
      });
    return { frame, boundary };
  }
  const sk = view.sketches.find((s) => s.id === f.sketch);
  if (!sk) return "the sketch to fill has not built";
  const boundary = sk.polylines.filter((p) => !p.construction).map((p) => p.points.map((q) => to2D(sk.frame, q)));
  return { frame: sk.frame, boundary };
}

/** Where the seed is and what it covers, in the frame; null when it can't be told here. */
export function seedOf(f: Raw, before: Raw[], view: View, frame: Frame): { at: Vec2; footprint: Vec2[] } | null {
  const ids = Array.isArray(f.features) ? (f.features as string[]) : typeof f.feature === "string" ? [f.feature] : [];
  const seed = before.find((g) => g.id === ids[0]);
  if (!seed) return null;
  if (seed.op === "hole" && ids.length === 1) {
    const spec = wizardSpec(seed);
    const c = centresOf(seed);
    const face = seed.face ? selectFaces(view.faces, seed.face as FaceSelector).matches[0] : undefined;
    if (typeof spec === "string" || c.length !== 1 || !face?.normal || !face.point) return null;
    const hf = facePlaneFrame(face.normal, face.point);
    const p = c[0] as number[];
    const world: Vec3 = [hf.origin[0] + hf.x[0] * p[0] + hf.y[0] * p[1], hf.origin[1] + hf.x[1] * p[0] + hf.y[1] * p[1], hf.origin[2] + hf.x[2] * p[0] + hf.y[2] * p[1]];
    const r = Math.max(spec.diameter, spec.counterbore?.diameter ?? 0, spec.countersink?.diameter ?? 0) / 2;
    return { at: to2D(frame, world), footprint: roundFootprint(r) };
  }
  if ((seed.op === "extrude" || seed.op === "cut") && typeof seed.sketch === "string") {
    const sk = view.sketches.find((s) => s.id === seed.sketch);
    const pts = sk ? sk.polylines.filter((p) => !p.construction && !p.reference).flatMap((p) => p.points.map((q) => to2D(frame, q))) : [];
    if (!pts.length) return null;
    const lo: Vec2 = [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1]))];
    const hi: Vec2 = [Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))];
    const at: Vec2 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
    return { at, footprint: boxFootprint([lo[0] - at[0], lo[1] - at[1]], [hi[0] - at[0], hi[1] - at[1]]) };
  }
  return null;
}

/** The fill pattern's places on the part shown, or why they can't be worked out here. */
export function fillPreview(f: Raw, before: Raw[], view: View | null): FillPreview | string {
  if (!view) return "the part has not rebuilt yet";
  const region = regionOf(f, view);
  if (typeof region === "string") return region;
  const seed = seedOf(f, before, view, region.frame);
  if (!seed) return "the seed's place can't be told here";
  const from = Array.isArray(f.from) && f.from.length === 2 ? (f.from as Vec2) : seed.at;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const places = fillPlaces(
    { layout: (f.layout as FillLayout) ?? "square", spacing: num(f.spacing) ?? 0, spacing2: num(f.spacing2), angle: num(f.angle), margin: num(f.margin) },
    from,
    seed.footprint,
    region.boundary,
  );
  if (typeof places === "string") return places;
  return { frame: region.frame, at: from, places };
}

/** The instance (2 ...) nearest a point of the region's plane, within `tol` mm; null when none is that near. */
export function instanceNear(preview: FillPreview, p: Vec3, tol: number): number | null {
  const q = to2D(preview.frame, p);
  let best: number | null = null;
  let d = tol;
  preview.places.forEach((c, k) => {
    const dk = Math.hypot(c[0] - q[0], c[1] - q[1]);
    if (dk <= d) {
      d = dk;
      best = k + 2;
    }
  });
  return best;
}
