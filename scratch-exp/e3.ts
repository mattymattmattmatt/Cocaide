import { loadOC } from "../src/kernel/oc";
const oc: any = await loadOC();
const P = (x: number, y: number, z: number) => new oc.gp_Pnt(x, y, z);
const D = (x: number, y: number, z: number) => new oc.gp_Dir(x, y, z);
function vol(sh: any) { const p = new oc.GProp_GProps(); oc.BRepGProp.VolumeProperties(sh, p, false, false, false); return p.Mass(); }
function valid(sh: any) { return new oc.BRepCheck_Analyzer(sh, true, false, false).IsValid(); }
function seg(a: number[], b: number[]) { return new oc.BRepBuilderAPI_MakeEdge(P(a[0], a[1], a[2]), P(b[0], b[1], b[2])).Edge(); }
function poly(pts: number[][]) { const mw = new oc.BRepBuilderAPI_MakeWire(); for (let i = 0; i < pts.length; i++) mw.Add(seg(pts[i], pts[(i + 1) % pts.length])); return mw.Wire(); }
function interp(pts: number[][]) {
  const a = new oc.NCollection_Array1_gp_Pnt(1, pts.length); pts.forEach((p, i) => a.SetValue(i + 1, P(p[0], p[1], p[2])));
  const it = new oc.GeomAPI_Interpolate(new oc.NCollection_HArray1_gp_Pnt(a), false, 1e-7); it.Perform();
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
  return { ok, vol: vol(sh), valid: valid(sh) };
}
// arc path: quarter circle R=50 in XZ plane centre (50,0,0) from (0,0,0) to (50,0,50), square 10x10 profile at origin in XY plane
const arc = new oc.GC_MakeArcOfCircle(P(0, 0, 0), P(50 - 50 * Math.cos(Math.PI / 4), 0, 50 * Math.sin(Math.PI / 4)), P(50, 0, 50));
const arcW = new oc.BRepBuilderAPI_MakeWire(new oc.BRepBuilderAPI_MakeEdge(arc.Value()).Edge()).Wire();
const sq = poly([[-5, -5, 0], [5, -5, 0], [5, 5, 0], [-5, 5, 0]]);
console.log("arc no twist", sweep(arcW, sq, (ps) => ps.SetMode(false)), "pappus", 100 * 50 * Math.PI / 2);
// aux for arc: P(s) = c + R(-cos φ, 0, sin φ), φ in [0, π/2]; T = (sin φ,0,cos φ); N = toward centre (cos φ,0,-sin φ); B = (0,1,0)? choose N1 = B=(0,±1,0), N2 = radial
for (const twist of [90, 360]) {
  const n = 65; const pts: number[][] = []; const eps = 0.5;
  for (let i = 0; i < n; i++) {
    const s = i / (n - 1); const phi = s * Math.PI / 2; const th = twist * Math.PI / 180 * s;
    const p = [50 - 50 * Math.cos(phi), 0, 50 * Math.sin(phi)]; const N1 = [Math.cos(phi), 0, -Math.sin(phi)]; const N2 = [0, 1, 0];
    pts.push([0, 1, 2].map((k) => p[k] + eps * (Math.cos(th) * N1[k] + Math.sin(th) * N2[k])));
  }
  console.log("arc twist", twist, sweep(arcW, sq, (ps) => ps.SetMode(interp(pts), false, oc.BRepFill_TypeOfContact.BRepFill_NoContact)));
}
// helix with twist
const R = 10, p = 5, turns = 4;
const cyl = new oc.Geom_CylindricalSurface(new oc.gp_Ax3(P(0, 0, 0), D(0, 0, 1), D(1, 0, 0)), R);
const l2 = new oc.Geom2d_Line(new oc.gp_Pnt2d(0, 0), new oc.gp_Dir2d(2 * Math.PI, p));
const tc = new oc.Geom2d_TrimmedCurve(l2, 0, Math.hypot(2 * Math.PI, p) * turns, true, true);
const he = new oc.BRepBuilderAPI_MakeEdge(tc, cyl).Edge(); oc.BRepLib.BuildCurves3d(he);
const hw = new oc.BRepBuilderAPI_MakeWire(he).Wire();
const sq2 = poly([[R - 1, 0, -1], [R + 1, 0, -1], [R + 1, 0, 1], [R - 1, 0, 1]]);
console.log("helix square binormal", sweep(hw, sq2, (ps) => ps.SetMode(D(0, 0, 1))), "approx", 4 * turns * Math.hypot(2 * Math.PI * R, p) * Math.cos(Math.atan2(p, 2 * Math.PI * R)));
// thread-like triangle profile at (R..R+1.5) on XZ plane
const tri = poly([[R, 0, -1.2], [R + 1.5, 0, 0], [R, 0, 1.2]]);
console.log("helix tri", sweep(hw, tri, (ps) => ps.SetMode(D(0, 0, 1))), 0.5 * 2.4 * 1.5 * 2 * Math.PI * (R + 0.5) * turns);
const ex = new oc.TopExp_Explorer(he, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
const lp = new oc.GProp_GProps(); oc.BRepGProp.LinearProperties(he, lp, false, false); console.log("helix length", lp.Mass(), turns * Math.hypot(2 * Math.PI * R, p));
