import { loadOC } from "../src/kernel/oc";
const oc: any = await loadOC();
const P = (x: number, y: number, z: number) => new oc.gp_Pnt(x, y, z);
const D = (x: number, y: number, z: number) => new oc.gp_Dir(x, y, z);
function vol(sh: any) { const p = new oc.GProp_GProps(); oc.BRepGProp.VolumeProperties(sh, p, false, false, false); return p.Mass(); }
function valid(sh: any) { return new oc.BRepCheck_Analyzer(sh, true, false, false).IsValid(); }
function circleWire(c: number[], n: number[], r: number) { const e = new oc.BRepBuilderAPI_MakeEdge(new oc.gp_Circ(new oc.gp_Ax2(P(c[0], c[1], c[2]), D(n[0], n[1], n[2])), r)).Edge(); return new oc.BRepBuilderAPI_MakeWire(e).Wire(); }
function seg(a: number[], b: number[]) { return new oc.BRepBuilderAPI_MakeEdge(P(a[0], a[1], a[2]), P(b[0], b[1], b[2])).Edge(); }
function sweep(spine: any, prof: any, opts: { mode?: (ps: any) => void; trans?: string } = {}) {
  const ps = new oc.BRepOffsetAPI_MakePipeShell(spine);
  if (opts.mode) opts.mode(ps); else ps.SetMode(false);
  ps.Add(prof, false, false);
  ps.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode[opts.trans ?? "BRepBuilderAPI_RoundCorner"]);
  ps.Build(new oc.Message_ProgressRange());
  if (!ps.IsDone()) return "notdone";
  const ok = ps.MakeSolid();
  const sh = ps.Shape();
  return { ok, type: sh.ShapeType(), vol: vol(sh), valid: valid(sh) };
}
const w1 = new oc.BRepBuilderAPI_MakeWire(seg([0, 0, 0], [0, 0, 100])).Wire();
console.log("line", sweep(w1, circleWire([0, 0, 0], [0, 0, 1], 5)), Math.PI * 25 * 100);
const mw = new oc.BRepBuilderAPI_MakeWire(); mw.Add(seg([0, 0, 0], [0, 0, 100])); mw.Add(seg([0, 0, 100], [60, 0, 100]));
const r = 5, a = 100, b = 60;
console.log("L round", sweep(mw.Wire(), circleWire([0, 0, 0], [0, 0, 1], 5)), Math.PI * r * r * (a + b) - 4 * r ** 3 / 3 + Math.PI * r ** 3 / 3);
console.log("L right", sweep(mw.Wire(), circleWire([0, 0, 0], [0, 0, 1], 5), { trans: "BRepBuilderAPI_RightCorner" }));
console.log("L transf", sweep(mw.Wire(), circleWire([0, 0, 0], [0, 0, 1], 5), { trans: "BRepBuilderAPI_Transformed" }));
const R = 10, p = 5, turns = 4;
const cyl = new oc.Geom_CylindricalSurface(new oc.gp_Ax3(P(0, 0, 0), D(0, 0, 1), D(1, 0, 0)), R);
const l2 = new oc.Geom2d_Line(new oc.gp_Pnt2d(0, 0), new oc.gp_Dir2d(2 * Math.PI, p));
const tc = new oc.Geom2d_TrimmedCurve(l2, 0, Math.hypot(2 * Math.PI, p) * turns, true, true);
const he = new oc.BRepBuilderAPI_MakeEdge(tc, cyl).Edge(); oc.BRepLib.BuildCurves3d(he);
const hw = new oc.BRepBuilderAPI_MakeWire(he).Wire();
const L = turns * Math.hypot(2 * Math.PI * R, p);
const t = [0, 2 * Math.PI * R, p]; const tl = Math.hypot(...t);
const prof = circleWire([R, 0, 0], [0, t[1] / tl, t[2] / tl], 1);
console.log("helix corrfrenet", sweep(hw, prof), Math.PI * L);
console.log("helix binormal", sweep(hw, prof, { mode: (ps) => ps.SetMode(D(0, 0, 1)) }), Math.PI * L);
console.log("helix frenet", sweep(hw, prof, { mode: (ps) => ps.SetMode(true) }), Math.PI * L);
