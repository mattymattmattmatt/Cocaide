import { loadOC } from "../src/kernel/oc";
const oc: any = await loadOC();
const P = (x: number, y: number, z: number) => new oc.gp_Pnt(x, y, z);
const D = (x: number, y: number, z: number) => new oc.gp_Dir(x, y, z);
function vol(sh: any) { const p = new oc.GProp_GProps(); oc.BRepGProp.VolumeProperties(sh, p, false, false, false); return p.Mass(); }
function valid(sh: any) { return new oc.BRepCheck_Analyzer(sh, true, false, false).IsValid(); }
function bbox(sh: any) { const b = new oc.Bnd_Box(); oc.BRepBndLib.AddOptimal(sh, b, false, false); const mn = b.CornerMin(), mx = b.CornerMax(); return [mn.X(), mn.Y(), mn.Z(), mx.X(), mx.Y(), mx.Z()].map((v) => Math.round(v * 1000) / 1000); }
function seg(a: number[], b: number[]) { return new oc.BRepBuilderAPI_MakeEdge(P(a[0], a[1], a[2]), P(b[0], b[1], b[2])).Edge(); }
function poly(pts: number[][]) { const mw = new oc.BRepBuilderAPI_MakeWire(); for (let i = 0; i < pts.length; i++) mw.Add(seg(pts[i], pts[(i + 1) % pts.length])); return mw.Wire(); }
function sweep(spine: any, prof: any, mode: (ps: any) => void) {
  const ps = new oc.BRepOffsetAPI_MakePipeShell(spine);
  mode(ps);
  ps.Add(prof, false, false);
  ps.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner);
  ps.Build(new oc.Message_ProgressRange());
  if (!ps.IsDone()) return { notdone: true } as any;
  const ok = ps.MakeSolid();
  const sh = ps.Shape();
  return { ok, vol: vol(sh), valid: valid(sh), bb: bbox(sh) };
}
const arc = new oc.GC_MakeArcOfCircle(P(0, 0, 0), P(50 - 50 * Math.cos(Math.PI / 4), 0, 50 * Math.sin(Math.PI / 4)), P(50, 0, 50));
const arcW = new oc.BRepBuilderAPI_MakeWire(new oc.BRepBuilderAPI_MakeEdge(arc.Value()).Edge()).Wire();
const sq = poly([[-5, -5, 0], [5, -5, 0], [5, 5, 0], [-5, 5, 0]]);
console.log("follow", sweep(arcW, sq, (ps) => ps.SetMode(false)));
console.log("fixed ax2 start tangent", sweep(arcW, sq, (ps) => ps.SetMode(new oc.gp_Ax2(P(0, 0, 0), D(0, 0, 1), D(1, 0, 0)))));
console.log("fixed ax2 other", sweep(arcW, sq, (ps) => ps.SetMode(new oc.gp_Ax2(P(10, 10, 10), D(1, 0, 0), D(0, 1, 0)))));
// closed loft: square ring around Z, 4 sections at angle 0,90,180,270 radius 30, plus first again
function sqAt(angle: number) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const pts = [[-5, -5], [5, -5], [5, 5], [-5, 5]].map(([u, v]) => [(30 + u) * c, (30 + u) * s, v]);
  return poly(pts);
}
for (const n of [4, 8]) {
  const lo = new oc.BRepOffsetAPI_ThruSections(true, false, 1e-6);
  for (let i = 0; i < n; i++) lo.AddWire(sqAt(2 * Math.PI * i / n));
  lo.AddWire(sqAt(0));
  lo.Build(new oc.Message_ProgressRange());
  console.log("closed loft", n, lo.IsDone() && vol(lo.Shape()), lo.IsDone() && valid(lo.Shape()), lo.IsDone() && lo.Shape().ShapeType(), "torus-ish", 100 * 2 * Math.PI * 30);
}
// square to circle
const circ = new oc.BRepBuilderAPI_MakeWire(new oc.BRepBuilderAPI_MakeEdge(new oc.gp_Circ(new oc.gp_Ax2(P(0, 0, 30), D(0, 0, 1)), 8)).Edge()).Wire();
const lo = new oc.BRepOffsetAPI_ThruSections(true, false, 1e-6); lo.AddWire(poly([[-10, -10, 0], [10, -10, 0], [10, 10, 0], [-10, 10, 0]])); lo.AddWire(circ); lo.Build(new oc.Message_ProgressRange());
console.log("sq->circle", vol(lo.Shape()), valid(lo.Shape()), "bounds", Math.PI * 64 * 30, 400 * 30);
const lr = new oc.BRepOffsetAPI_ThruSections(true, true, 1e-6); lr.AddWire(poly([[-10, -10, 0], [10, -10, 0], [10, 10, 0], [-10, 10, 0]])); lr.AddWire(circ); lr.Build(new oc.Message_ProgressRange());
console.log("sq->circle ruled", lr.IsDone() && vol(lr.Shape()), lr.IsDone() && valid(lr.Shape()));
