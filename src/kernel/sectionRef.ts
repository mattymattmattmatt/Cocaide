// An intersection curve at rebuild time: a sketch entity whose ref is
// { face, section: [x, y] } is the piece of the curve where that face cuts
// the sketch plane nearest the point, cut again on the part as it stands
// (BRepAlgoAPI_Section of the face with the plane) and made the entity's
// kind: a line, a circle or arc where the cut is one, else (a spline) points
// spread along the cut. So it follows the model like any reference.

import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { FaceSelector, SketchEntity, Vec2, Vec3 } from "../doc/types";
import { to2D, type Frame } from "../geom/frame";
import { describePart } from "./bodies";
import type { DatumContext } from "./datum";
import { scoped } from "./oc";
import { dir, OpError, pnt } from "./ops";
import { selectFaces, selectionError } from "./selectors";

/** One edge of the cut, in the sketch: its kind, its points along it, and a circle's centre and radius. */
interface CutPiece {
  kind: "line" | "circle" | "other";
  poly: Vec2[];
  closed: boolean;
  center?: Vec2;
  radius?: number;
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The edges where the face meets the sketch plane. */
function cutPieces(ctx: DatumContext, face: FaceSelector, frame: Frame, path: string): CutPiece[] {
  const { oc } = ctx;
  if (ctx.bodies.size === 0) throw new OpError(`${path}.face: there is no solid before this sketch to cut a face of`);
  return scoped((s) => {
    const part = describePart(oc, s, ctx.bodies as Map<string, TopoDS_Shape>, false);
    const found = selectFaces(part.faceInfos, face);
    const problem = selectionError(face, found, 1);
    if (problem) throw new OpError(`${path}.face: ${problem}`);
    const f = part.faces[found.matches[0].index];
    const plane = s.track(new oc.gp_Pln(pnt(oc, s, frame.origin), dir(oc, s, frame.z)));
    const sec = s.track(new oc.BRepAlgoAPI_Section(f, plane, true));
    if (!sec.IsDone()) throw new OpError(`${path}: the face could not be cut by the sketch plane`);
    const shape = s.track(sec.Shape());
    const out: CutPiece[] = [];
    const ex = s.track(new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
    for (; ex.More(); ex.Next()) {
      const edge = s.track(oc.TopoDS.Edge(s.track(ex.Current())));
      const curve = s.track(new oc.BRepAdaptor_Curve(edge));
      const u0 = curve.FirstParameter();
      const u1 = curve.LastParameter();
      const at = (u: number): Vec2 => {
        const p = curve.EvalD0(u);
        const v: Vec3 = [p.X(), p.Y(), p.Z()];
        p.delete();
        return to2D(frame, v);
      };
      const type = curve.GetType();
      const n = type === oc.GeomAbs_CurveType.GeomAbs_Line ? 1 : 96;
      const poly = Array.from({ length: n + 1 }, (_, k) => at(u0 + ((u1 - u0) * k) / n));
      const closed = dist(poly[0], poly[poly.length - 1]) < 1e-7;
      if (type === oc.GeomAbs_CurveType.GeomAbs_Line) out.push({ kind: "line", poly, closed: false });
      else if (type === oc.GeomAbs_CurveType.GeomAbs_Circle) {
        const c = s.track(curve.Circle());
        const loc = s.track(c.Location());
        out.push({ kind: "circle", poly, closed, center: to2D(frame, [loc.X(), loc.Y(), loc.Z()]), radius: c.Radius() });
      } else out.push({ kind: "other", poly, closed });
    }
    return out;
  });
}

/** How far a point is from a polyline. */
function toPoly(p: Vec2, poly: Vec2[]): number {
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]));
  }
  return poly.length === 1 ? dist(p, poly[0]) : best;
}

/** n points spread evenly along a polyline (a closed one round, its start not repeated). */
function spread(poly: Vec2[], n: number, closed: boolean): Vec2[] {
  const cum = [0];
  for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + dist(poly[i], poly[i - 1]));
  const total = cum[cum.length - 1];
  return Array.from({ length: n }, (_, k) => {
    const want = (total * k) / (closed ? n : n - 1);
    const i = Math.max(1, cum.findIndex((c) => c >= want - 1e-12));
    const d = cum[i] - cum[i - 1];
    const t = d > 0 ? (want - cum[i - 1]) / d : 0;
    return [poly[i - 1][0] + t * (poly[i][0] - poly[i - 1][0]), poly[i - 1][1] + t * (poly[i][1] - poly[i - 1][1])] as Vec2;
  });
}

/**
 * The entity with the numbers of the piece of the face's cut nearest its
 * section point, or why not (the cut is no longer that kind of curve).
 */
export function sectionEntity(ctx: DatumContext, e: SketchEntity, ref: { face: FaceSelector; section: Vec2 }, frame: Frame, path: string, name: string): SketchEntity | string {
  const pieces = cutPieces(ctx, ref.face, frame, path);
  if (!pieces.length) return `${path}: the face no longer crosses the sketch plane, so there is no intersection curve`;
  const piece = pieces.reduce((best, p) => (toPoly(ref.section, p.poly) < toPoly(ref.section, best.poly) ? p : best));
  const a = piece.poly[0];
  const b = piece.poly[piece.poly.length - 1];
  const kindWord = piece.kind === "line" ? "a line" : piece.kind === "circle" ? (piece.closed ? "a circle" : "an arc") : "a curve";
  switch (e.type) {
    case "line":
      if (piece.kind !== "line") return `${name} is a line, but where the face cuts the sketch plane is ${kindWord} now; pick the curve again`;
      return { ...e, start: a, end: b };
    case "circle":
      if (piece.kind !== "circle" || !piece.closed) return `${name} is a circle, but where the face cuts the sketch plane is ${kindWord} now; pick the curve again`;
      return { ...e, center: piece.center!, radius: piece.radius! };
    case "arc": {
      if (piece.kind !== "circle" || piece.closed) return `${name} is an arc, but where the face cuts the sketch plane is ${kindWord} now; pick the curve again`;
      const c = piece.center!;
      const m = piece.poly[Math.floor(piece.poly.length / 2)];
      const turn = (a[0] - c[0]) * (m[1] - c[1]) - (a[1] - c[1]) * (m[0] - c[0]);
      const out = { ...e, center: c, start: a, end: b } as Extract<SketchEntity, { type: "arc" }>;
      if (turn < 0) out.clockwise = true;
      else delete out.clockwise;
      return out;
    }
    case "spline": {
      const n = e.points.length;
      const pts = spread(piece.poly, n, piece.closed);
      // Kept the way it ran before (a spline's points are in order): reversed when its first point is nearer the cut's end.
      const keep = dist(pts[0], e.points[0]) <= dist(pts[pts.length - 1], e.points[0]) || piece.closed;
      return { ...e, points: keep ? pts : [...pts].reverse() };
    }
    default:
      return `${name} is ${e.type === "ellipse" ? "an" : "a"} ${e.type}; an intersection curve is a line, circle, arc or spline`;
  }
}
