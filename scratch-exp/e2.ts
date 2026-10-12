import { loadOC } from "../src/kernel/oc";
const oc: any = await loadOC();
const P = (x: number, y: number, z: number) => new oc.gp_Pnt(x, y, z);
const D = (x: number, y: number, z: number) => new oc.gp_Dir(x, y, z);
function vol(sh: any) { const p = new oc.GProp_GProps(); oc.BRepGProp.VolumeProperties(sh, p, false, false, false); return p.Mass(); }
function valid(sh: any) { return new oc.BRepCheck_Analyzer(sh, true, false, false).IsValid(); }
function bbox(sh: any) { const b = new oc.Bnd_Box(); oc.BRepBndLib.AddOptimal(sh, b, false, false); const mn = b.CornerMin(), mx = b.CornerMax(); return [mn.X(), mn.Y(), mn.Z(), mx.X(), mx.Y(), mx.Z()].map((v) => Math.round(v * 1000) / 1000); }
function seg(a: number[], b: number[]) { return new oc.BRepBuilderAPI_MakeEdge(P(a[0], a[1], a[2]), P(b[0], b[1], b[2])).Edge(); }
function poly(pts: number[][]) { const mw = new oc.BRepBuilderAPI_MakeWire(); for (let i = 0; i < pts.length; i++) mw.Add(seg(pts[i], pts[(i + 1) % pts.length])); return mw.Wire(); }
function interp(pts: number[][]) {
  const a = new oc.NCollection_Array1_gp_Pnt(1, pts.length); pts.forEach((p, i) => a.SetValue(i + 1, P(p[0], p[1], p[2])));
  const it = new oc.GeomAPI_Interpolate(new oc.NCollection_HArray1_gp_Pnt(a), false, 1e-7); it.Perform();
  if (!it.IsDone()) throw new Error("interp");
  const e = new oc.BRepBuilderAPI_MakeEdge(it.Curve()).Edge();
  return new oc.BRepBuilderAPI_MakeWire(e).Wire();
}
function sweep(spine: any, prof: any, mode: (ps: any) => void) {
  const ps = new oc.BRepOffsetAPI_MakePipeShell(spine);
  mode(ps);
  ps.Add(prof, false, false);
  ps.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner);
  ps.Build(new oc.Message_ProgressRange());
  if (!ps.IsDone()) return { notdone: true } as any;
  const ok = ps.MakeSolid();
  const sh = ps.Shape();
  return { ok, type: sh.ShapeType(), vol: vol(sh), valid: valid(sh), bb: bbox(sh) };
}
// twist a 10x10 square along z 0..100 by 45 deg
const spine = new oc.BRepBuilderAPI_MakeWire(seg([0, 0, 0], [0, 0, 100])).Wire();
const sq = poly([[-5, -5, 0], [5, -5, 0], [5, 5, 0], [-5, 5, 0]]);
for (const eps of [0.01, 0.1, 1, 10]) {
  for (const curv of [true, false]) {
    const n = 33; const pts: number[][] = [];
    for (let i = 0; i < n; i++) { const s = i / (n - 1); const th = (45 * Math.PI / 180) * s; pts.push([eps * Math.cos(th), eps * Math.sin(th), 100 * s]); }
    const aux = interp(pts);
    const r = sweep(spine, sq, (ps) => ps.SetMode(aux, curv, oc.BRepFill_TypeOfContact.BRepFill_NoContact));
    console.log("twist eps", eps, "curv", curv, r);
  }
}
// conical helix
const R = 10, p = 5, turns = 3, ang = 10 * Math.PI / 180;
const cone = new oc.Geom_ConicalSurface(new oc.gp_Ax3(P(0, 0, 0), D(0, 0, 1), D(1, 0, 0)), ang, R);
const pv = p / Math.cos(ang);
const l2 = new oc.Geom2d_Line(new oc.gp_Pnt2d(0, 0), new oc.gp_Dir2d(2 * Math.PI, pv));
const tc = new oc.Geom2d_TrimmedCurve(l2, 0, Math.hypot(2 * Math.PI, pv) * turns, true, true);
const he = new oc.BRepBuilderAPI_MakeEdge(tc, cone).Edge(); oc.BRepLib.BuildCurves3d(he);
const ca = new oc.BRepAdaptor_Curve(he);
const f = ca.FirstParameter(), l = ca.LastParameter();
const p0 = ca.Value(f), p1 = ca.Value(l);
console.log("cone helix ends", [p0.X(), p0.Y(), p0.Z()], [p1.X(), p1.Y(), p1.Z()], "expect end r", R + p * turns * Math.tan(ang), "z", p * turns);
// loft square to square ruled
function sqw(z: number, h: number) { return poly([[-h, -h, z], [h, -h, z], [h, h, z], [-h, h, z]]); }
const lo = new oc.BRepOffsetAPI_ThruSections(true, true, 1e-6); lo.AddWire(sqw(0, 10)); lo.AddWire(sqw(30, 5)); lo.Build(new oc.Message_ProgressRange());
const A1 = 400, A2 = 100;
console.log("loft frustum", vol(lo.Shape()), valid(lo.Shape()), 30 / 3 * (A1 + A2 + Math.sqrt(A1 * A2)));
const lo2 = new oc.BRepOffsetAPI_ThruSections(true, false, 1e-6); lo2.AddWire(sqw(0, 10)); lo2.AddWire(sqw(30, 5)); lo2.Build(new oc.Message_ProgressRange());
console.log("loft smooth 2", vol(lo2.Shape()), valid(lo2.Shape()));
// pyramid
const lo3 = new oc.BRepOffsetAPI_ThruSections(true, true, 1e-6); lo3.AddWire(sqw(0, 10)); lo3.AddVertex(new oc.BRepBuilderAPI_MakeVertex(P(0, 0, 30)).Vertex()); lo3.Build(new oc.Message_ProgressRange());
console.log("pyramid", lo3.IsDone() && vol(lo3.Shape()), lo3.IsDone() && valid(lo3.Shape()), 400 * 30 / 3);
// closed loft: 4 squares around ring
