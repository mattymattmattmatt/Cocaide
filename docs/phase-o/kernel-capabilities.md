# OpenCascade WASM in Cocaide: what the build exposes and how the codebase calls it

## 0. What this build is

- **Package.** `replicad-opencascadejs@1.1.0`. Single-threaded glue `dist/replicad_single.js` with `.wasm` and `.d.ts` beside it (33,882 lines; the multi-threaded `.d.ts` is identical). The README (line 852) calls it OCCT 8.0. It is built from the taucad `opencascade.js` canary. The package has no `src/`.
- **What is bound.** The runtime type is `OpenCascadeInstance` at `replicad_single.d.ts:33532-33875`. It has 326 members: 302 classes, plus enums, `FS`, `wasmMemory` and the exception helpers.
  - I loaded the module in Node and listed its keys. The only names it adds beyond the `.d.ts` are internal NCollection iterator classes and malloc symbols. **So the `.d.ts` instance list is the complete list of what can be called.**
  - A class that is only mentioned as a parameter type, or typed `unknown`, is **not bound**.
- **No `_1`/`_2` suffixes.** Overloads are real. Embind picks the overload by argument count and argument type.
  - Checked at runtime: `new oc.BRepBuilderAPI_MakeEdge(gp_Elips)`, `(gp_Circ, p1, p2)`, `(Geom2d_Curve, Geom_Surface)`, and `new oc.BRepOffsetAPI_MakeOffset(TopoDS_Wire | TopoDS_Face, …)` all resolve correctly.
  - Snippets on the web written as `BRepPrimAPI_MakeRevol_1(...)` (older opencascade.js and replicad builds) **must not be copied**. Write `new oc.BRepPrimAPI_MakeRevol(...)`.
- **Load time and speed.** Loading OC in Node takes about 2.5 s. 20 box-minus-cylinder cuts took 124 ms, about 6 ms each. `tests/kernel.test.ts` plus `tests/phase-b-ops.test.ts` (41 tests) finish in 5.5 s.

## 1. Capability table

Legend: ✅ bound, ⚠️ bound but some overloads or returns are unusable (their parameter or return type is `unknown`, meaning not bound), ❌ not bound. Line numbers refer to `node_modules/replicad-opencascadejs/dist/replicad_single.d.ts`. Every ✅ row marked "verified" was run in Node during this investigation.

| API | Status | Exact declarations (line) |
|---|---|---|
| **BRepPrimAPI_MakeRevol** | ✅ verified | `constructor(S: TopoDS_Shape, A: gp_Ax1, Copy?: boolean)` (13394, full 2π); `constructor(S: TopoDS_Shape, A: gp_Ax1, D: number, Copy?: boolean)` (13398). Also `FirstShape()`, `FirstShape(theShape)`, `LastShape()`, `LastShape(theShape)`, `Generated(S)`, `IsDeleted`, `HasDegenerated`, `Degenerated`. A face revolved 90° gave the exact volume. A wire gives a `TopAbs_SHELL` (thin feature). |
| **BRepPrimAPI_MakePrism** | ✅ | `constructor(S: TopoDS_Shape, V: gp_Vec, Copy?: boolean, Canonize?: boolean)` (13322); `constructor(S: TopoDS_Shape, D: gp_Dir, Inf?: boolean, Copy?: boolean, Canonize?: boolean)` (13326). `FirstShape`/`LastShape` (with and without a shape argument), `Generated`. |
| **BRepOffsetAPI_MakePipe** | ⚠️ | `constructor(Spine: TopoDS_Wire, Profile: TopoDS_Shape)` (12760) works (verified). `constructor(Spine, Profile, aMode: unknown, ForceApproxC1?)` (12764) cannot be called because `GeomFill_Trihedron` is not bound. `Generated(SSpine, SProfile)`, `ErrorOnSurface()`. |
| **BRepOffsetAPI_MakePipeShell** | ✅ verified | `constructor(Spine: TopoDS_Wire)` (12806). `SetMode(IsFrenet: boolean)` (12810), `SetMode(Axe: gp_Ax2)` (12814), `SetMode(BiNormal: gp_Dir)` (12818), `SetMode(SpineSupport: TopoDS_Shape): boolean` (12822), `SetMode(AuxiliarySpine: TopoDS_Wire, CurvilinearEquivalence: boolean, KeepContact: BRepFill_TypeOfContact)` (12834). `Add(Profile, WithContact, WithCorrection)` (12842), `Add(Profile, Location: TopoDS_Vertex, WithContact, WithCorrection)` (12846). `SetLaw(Profile, L: Law_Function, WithContact, WithCorrection)` (12850, verified with `Law_Linear` scaling), `SetLaw(…, Location, …)` (12854). `SetTransitionMode(Mode?: BRepBuilderAPI_TransitionMode)` (12895), `Build` (12904), `MakeSolid(): boolean` (12908), `IsReady`, `SetTolerance`, `Simulate`. |
| **BRepOffsetAPI_ThruSections** | ✅ verified | `constructor(isSolid?: boolean, ruled?: boolean, pres3d?: number)` (12997). `AddWire(wire)` (13009), `AddVertex(v)` (13013), `CheckCompatibility(check?)` (13017), `SetSmoothing`, `SetContinuity(GeomAbs_Shape)`, `SetMaxDegree`, `Build` (13067), `FirstShape`/`LastShape`, `GeneratedFace(Edge)` (13079). `SetParType(unknown)` cannot be called. |
| **BRepOffsetAPI_MakeThickSolid** | ✅ verified | `constructor()` (12955). `MakeThickSolidByJoin(S: TopoDS_Shape, ClosingFaces: NCollection_List_TopoDS_Shape, Offset: number, Tol: number, Mode?: BRepOffset_Mode, Intersection?: boolean, SelfInter?: boolean, Join?: GeomAbs_JoinType, RemoveIntEdges?: boolean, theRange?: Message_ProgressRange): void` (12972). A 20 mm box with offset −2 and its top face removed gave exactly 3392 and a valid solid. `MakeThickSolidBySimple(theS, theOffsetValue)` (12959) was NotDone on a box. |
| **BRepOffsetAPI_DraftAngle** | ✅ verified | `constructor()` (12433), `constructor(S)` (12437). `Add(F: TopoDS_Face, Direction: gp_Dir, Angle: number, NeutralPlane: gp_Pln, Flag?: boolean)` (12456), `AddDone()` (12463), `Remove(F)`, `ProblematicShape()` (12474), `ConnectedFaces(F)`, `ModifiedFaces()`, `Build`, `ModifiedShape(S)`. `Status()` returns `unknown` and cannot be called. |
| **BRepOffsetAPI_MakeOffset** (2D wire offset) | ✅ verified | `constructor()` (12640); `constructor(Spine: TopoDS_Face, Join?: GeomAbs_JoinType, IsOpenResult?: boolean)` (12644); `constructor(Spine: TopoDS_Wire, Join?, IsOpenResult?)` (12645). `Init(...)` (12649, 12653), `AddWire`, `SetApprox`, `Perform(Offset: number, Alt?: number)` (12665). Works on closed wires, faces, and open wires with `IsOpenResult = true`. |
| **BRepOffsetAPI_MakeOffsetShape** | ✅ verified | `constructor()` (12694). `PerformBySimple(theS, theOffsetValue)` (12699). `PerformByJoin(S, Offset, Tol, Mode?: BRepOffset_Mode, Intersection?, SelfInter?, Join?: GeomAbs_JoinType, RemoveIntEdges?, theRange?)` (12723). `Generated`, `Modified`, `IsDeleted`. |
| **BRepFilletAPI_MakeFillet** | ✅ verified | `constructor(S: TopoDS_Shape, FShape?: ChFi3d_FilletShape)` (10850). `Add(E)` (10859), `Add(Radius: number, E)` (10866), `Add(L: Law_Function, E)` (10873), `Add(UandR: NCollection_Array1_gp_Pnt2d, E)` (10882, variable radius by (u, r) pairs, verified), `Add(R1: number, R2: number, E)` (10889, linear taper, verified). `SetRadius(...)` overloads (10893-10913), `IsConstant`, `Radius`, `GetLaw`/`SetLaw`. Diagnostics: `NbFaultyContours()` (11050), `FaultyContour`, `NbFaultyVertices`, `HasResult()` (11074), `BadShape()` (11078). Also `NewFaces(I)`, `Generated`/`Modified`/`IsDeleted`. `StripeStatus` and `Builder` return `unknown`. |
| **BRepFilletAPI_MakeChamfer** | ✅ verified | `constructor(S)` (10680). `Add(E)` (10684), `Add(Dis: number, E)` (10688), `Add(Dis1: number, Dis2: number, E: TopoDS_Edge, F: TopoDS_Face)` (10693, two distances, verified exact). `AddDA(Dis: number, Angle: number, E, F)` (10713, distance plus angle in radians, verified). `SetDist`, `SetDists` (10702), `SetDistAngle` (10717), `GetDistAngle`, `Dists`, `SetMode(ChFiDS_ChamfMode)` (10728), `IsSymetric`, `IsTwoDistances`, `IsDistanceAngle`. |
| **BRepFilletAPI_MakeFillet2d** | ❌ | Not bound. Do sketch fillets and chamfers in 2D JS geometry. |
| **GC_MakeArcOfCircle** | ✅ | `constructor(theP1: gp_Pnt, theP2: gp_Pnt, theP3: gp_Pnt)` (22662); `(theP1, theV: gp_Vec, theP2)` (22673); `(theCirc: gp_Circ, theAlpha1, theAlpha2, theSense: boolean)` (22681); `(theCirc, theP: gp_Pnt, theAlpha, theSense)` (22689); `(theCirc, theP1, theP2, theSense)` (22697). `Value(): Geom_TrimmedCurve` (22702). `GC_Root.IsDone()` (23046). `Status()` returns `unknown`. |
| **GC_MakeCircle** | ❌ | Only `GC_MakeCircle2d` (22863) is bound. In 3D use `new oc.gp_Circ(gp_Ax2, r)` (5758) and `MakeEdge(gp_Circ)`. |
| **GC_MakeEllipse / Geom_Ellipse** | ❌ / ❌ | Only `GC_MakeEllipse2d` (22943) and `Geom2d_Ellipse` (18379). **`gp_Elips` is bound**: `constructor(theA2: gp_Ax2, theMajorRadius: number, theMinorRadius: number)` (6544). |
| **GC_MakeArcOfEllipse** | ✅ verified | `constructor(theElips: gp_Elips, theAlpha1, theAlpha2, theSense)` (22780); `(theElips, theP: gp_Pnt, theAlpha, theSense)` (22788); `(theElips, theP1, theP2, theSense)` (22799). `Value(): Geom_TrimmedCurve`. |
| **GeomAPI_PointsToBSpline** | ✅ verified | `constructor(Points: NCollection_Array1_gp_Pnt, DegMin?, DegMax?, Continuity?: GeomAbs_Shape, Tol3D?)` (11477); `(Points, Parameters: NCollection_Array1_double, …)` (11485); `(Points, Weight1, Weight2, Weight3, DegMax?, Continuity?, Tol3D?)` (11489). The `ParType: unknown` overload (11481) cannot be called. `Curve(): Geom_BSplineCurve`, `IsDone()`. |
| **GeomAPI_Interpolate** | ✅ verified | `constructor(Points: NCollection_HArray1_gp_Pnt, PeriodicFlag: boolean, Tolerance: number)` (11423); `(Points, Parameters: NCollection_HArray1_double, PeriodicFlag, Tolerance)` (11437). `Load(InitialTangent: gp_Vec, FinalTangent: gp_Vec, Scale: boolean)` (11441); `Load(Tangents: NCollection_Array1_gp_Vec, TangentFlags: NCollection_HArray1_bool, Scale)` (11445). `Perform()`, `Curve()`, `IsDone()`. |
| **Geom_BSplineCurve** | ✅ | `constructor(theOther)` (19443); `(Poles: NCollection_Array1_gp_Pnt, Knots: NCollection_Array1_double, Multiplicities: NCollection_Array1_int, Degree: number, Periodic?)` (19447); `(Poles, Weights, Knots, Multiplicities, Degree, Periodic?, CheckRational?)` (19471). `SetPole`, `InsertKnot`, `IncreaseDegree`, `NbPoles`, `Pole`, `Degree`. Also bound: `Geom_BezierCurve(CurvePoles[, PoleWeights])` (20642/20651) and `Geom_TrimmedCurve(C, U1, U2, Sense?, theAdjustPeriodic?)` (22064). `Geom_Curve` (21137, abstract) has `Value(U)`, `EvalD0..D3`, `D0..D3`, `FirstParameter`/`LastParameter`. |
| **Geom2d_\*** | ✅ verified (subset) | `Geom2d_Line(A: gp_Ax2d)` (18577) and `(P: gp_Pnt2d, V: gp_Dir2d)` (18585). `Geom2d_Circle(C: gp_Circ2d)`, `(A: gp_Ax22d, Radius)`, `(A: gp_Ax2d, Radius, Sense?)` (18077-18088). `Geom2d_Ellipse` (18383-18401). `Geom2d_TrimmedCurve(C, U1, U2, Sense?, AdjustPeriodic?)` (18869). `Geom2d_BSplineCurve` (17360/17382). `Geom2d_BezierCurve` (17822). `Geom2d_OffsetCurve(C, Offset, isNotCheckC0?)` (18714, verified). `Geom2dAPI_InterCurveCurve(C1, C2, Tol?)` (11205, verified: line ∩ circle gives 2 points; `NbPoints`/`Point`/`NbSegments`). `Geom2dAPI_ExtremaCurveCurve(C1, C2, U1min, U1max, U2min, U2max)` (11139). `Geom2dAPI_ProjectPointOnCurve(P, Curve[, Umin, Usup])` (11340/11346, verified). `Geom2dAPI_PointsToBSpline` (11260). `Geom2dAdaptor_Curve` (19000). `GC_MakeSegment2d`, `GC_MakeArcOfCircle2d`, `GC_MakeArcOfEllipse2d` are also bound. |
| **BRepBuilderAPI_MakeEdge** | ⚠️ | Overloads at 14505-14564. Usable: `()`, `(L: gp_Circ)` 14508, `(L: gp_Elips)` 14509, `(L: Geom_Curve)` 14512, `(V1: TopoDS_Vertex, V2)` 14513, `(P1: gp_Pnt, P2: gp_Pnt)` 14514, `(L: Geom2d_Curve, S: Geom_Surface)` 14515, `(L: gp_Circ, p1: number, p2: number)` 14519, `(gp_Circ, P1: gp_Pnt, P2: gp_Pnt)` 14520, `(gp_Circ, V1, V2)` 14521, `(L: gp_Elips, p1, p2)` 14522, `(gp_Elips, P1, P2)` 14523, `(L: Geom_Curve, p1, p2)` 14531, `(Geom_Curve, P1, P2)` 14532, `(Geom2d_Curve, Geom_Surface, p1, p2)` 14534, …, `(Geom_Curve, P1, P2, p1, p2)` 14537. The `L: unknown` overloads (gp_Lin, gp_Hypr, gp_Parab) cannot be called. `Init(...)` overloads (14565-14579). `Edge()`, `Vertex1()`, `Vertex2()`. **`Error()` (14590) throws "unbound types".** |
| **BRepBuilderAPI_MakeWire** | ✅ | `constructor()` (14951), `(E)` (14955), `(W)`, `(E1, E2)`, `(W, E)`, `(E1, E2, E3)`, `(E1, E2, E3, E4)` (14983). `Add(E: TopoDS_Edge)` (14989), `Add(W: TopoDS_Wire)` (14993), `Add(L: NCollection_List_TopoDS_Shape)` (14997). `Error(): BRepBuilderAPI_WireError` (15011) works and returns a string such as `"BRepBuilderAPI_DisconnectedWire"`. `Wire()`, `Edge()`, `Vertex()`. |
| **BRepBuilderAPI_MakeFace** | ⚠️ | `(F)`, `(P: gp_Pln)` 14641, `(C: gp_Cylinder)`, `(S: gp_Sphere)`, `(S: Geom_Surface, TolDegen)` 14661, `(W: TopoDS_Wire, OnlyPlane?: boolean)` 14665, `(F, W)` 14683, `(P: gp_Pln, W, Inside?)` 14687, `(S: Geom_Surface, W, Inside?)` 14707, `(P: gp_Pln, UMin, UMax, VMin, VMax)` 14711, `(S: Geom_Surface, UMin, UMax, VMin, VMax, TolDegen)` 14731. `Add(W)` (14749) adds a hole wire. `Face()`. The `C: unknown` overloads (gp_Cone, gp_Torus) cannot be called, and **`Error()` (14759) cannot be called**. |
| **BRepAlgoAPI_Common/Fuse/Cut** | ✅ verified | `constructor()` and `constructor(S1, S2, theRange?: Message_ProgressRange)` (Common 10266/10270, Cut 10285/10289, Fuse 10304/10308). From `BRepAlgoAPI_BooleanOperation`: `SetTools(list)` (10198). From `BRepAlgoAPI_BuilderAlgo` (10229): `SetArguments(list)` (10233), `SetNonDestructive`, `SetGlue`, `SimplifyResult(UnifyEdges?, UnifyFaces?, AngularTol?)` (10242), `Modified`/`Generated`/`IsDeleted`, `HasModified`/`HasGenerated`/`HasDeleted` (10246-10248), `SetToFillHistory`, `SectionEdges()`. From `BRepAlgoAPI_Algo` (10146): `SetFuzzyValue`, `HasErrors`, `HasWarnings`, `SetRunParallel`, `SetUseOBB`. A multi-tool fuse via `SetArguments` + `SetTools` + `Build` was verified. `SetOperation(unknown)` cannot be called. |
| **BRepAlgoAPI_Section** | ✅ verified | `(S1, S2, PerformNow?)` (10332), `(S1, Pl: gp_Pln, PerformNow?)` (10336), `(S1, Sf: Geom_Surface, …)` (10340), `(Sf, S2, …)`, `(Sf1, Sf2, …)` (10348). `Init1`/`Init2` overloads, `Approximation`, `ComputePCurveOn1`/`ComputePCurveOn2`, `HasAncestorFaceOn1`/`On2`. |
| **BRepAlgoAPI_Splitter** | ✅ verified | `constructor()` (10421), `SetTools(list)` (10423), plus `SetArguments` and `Build` from BuilderAlgo. A box split by a plane face gave 2 solids. |
| **BRepExtrema_DistShapeShape** | ⚠️ verified | `constructor()` (15390). `constructor(Shape1, Shape2, F?: unknown, A?: Extrema_ExtAlgo, theRange?)` (15399): **only the 2-argument form works**; passing a 3rd argument throws because `Extrema_ExtFlag` is not bound. The `theDeflection` overload (15409) is likewise only usable without `F`. `Value()` (15437), `NbSolution`, `InnerSolution`, `PointOnShape1(N)`/`PointOnShape2(N)` (15445/15449), `SupportOnShape1(N)`/`SupportOnShape2(N)` (15461/15465), `ParOnEdgeS1(N)` → `{t}` (15471), `ParOnFaceS1(N)` → `{u, v}` (15484). `SupportTypeShape1`/`SupportTypeShape2` throw "unbound types". |
| **BRepGProp** (+ `GProp_GProps`) | ✅ | Static methods: `LinearProperties(S, LProps, SkipShared, UseTriangulation)` (15533); `SurfaceProperties(S, SProps, SkipShared, UseTriangulation)` (15541) and `(S, SProps, Eps, SkipShared): number` (15547); `VolumeProperties(S, VProps, OnlyClosed, SkipShared, UseTriangulation)` (15557) and an Eps overload (15564); `VolumePropertiesGK` (15571/15572). `GProp_GProps` (23224): `Mass()`, `CentreOfMass()`, `MomentOfInertia(gp_Ax1)`, `RadiusOfGyration`, `StaticMoments`. `MatrixOfInertia()` and `PrincipalProperties()` return `unknown`. `BRepGProp_Face` is bound too (`Normal(u, v, P, V)` verified). |
| **BRepBndLib** | ✅ | Static methods: `Add(S, B: Bnd_Box, useTriangulation)` (14442), `AddClose` (14447), `AddOptimal(S, B, useTriangulation, useShapeTolerance)` (14452), `AddOBB(theS, theOBB: Bnd_OBB, …)` (14458). `Bnd_Box` (3761), `Bnd_OBB` (4201). |
| **ShapeUpgrade_UnifySameDomain** | ⚠️ | `constructor()` (14374); `constructor(aShape, UnifyEdges?, UnifyFaces?, ConcatBSplines?)` (14378). `Initialize`, `AllowInternalEdges`, `KeepShape(theShape)` (14390), `SetSafeInputMode`, `SetLinearTolerance`, `SetAngularTolerance`, `Build()`, `Shape()`. **`History()` (14418) returns `unknown`**, so face history is lost through the unify step. `KeepShapes(NCollection_Map…)` cannot be called because the map cannot be constructed. |
| **BRepProj_Projection** | ❌ | See the workarounds in section 4. |
| **BRepFeat_MakePrism** | ❌ | Not bound. |
| **BRepFeat_MakeDPrism** (prism with draft, up-to) | ✅ verified | `constructor()` (10532); `constructor(Sbase: TopoDS_Shape, Pbase: TopoDS_Face, Skface: TopoDS_Face, Angle: number, Fuse: number, Modify: boolean)` (10539); `Init(...)` (10546). `Add(E, OnFace)`. `Perform(Height: number)` (10551), `Perform(Until: TopoDS_Shape)` (10552), `Perform(From, Until)` (10560). `PerformUntilEnd()` (10564), `PerformFromEnd(FUntil)`, `PerformThruAll()` (10572), `PerformUntilHeight(Until, Height)` (10576). `TopEdges`, `LatEdges`. With `Angle = 0` and `Fuse = 1`, extruding up to a face at z = 30 gave exactly 18000 and a valid solid. A 5° draft with height 10 was also valid. From `BRepFeat_Form` (10459): `FirstShape`/`LastShape` return lists, `NewEdges`, `TgtEdges`. `CurrentStatusError()` returns `unknown`. `Fuse`: 0 removes material, 1 adds. |
| **LocOpe_\*** | ❌ | Not bound. |
| **BRepTools_WireExplorer** | ❌ | Use `TopExp_Explorer` on the wire and order the edges by their vertices with `BRep_Tool.Pnt`. |
| **TopExp** (MapShapes, MapShapesAndAncestors, Vertices) | ❌ | Only `TopExp_Explorer` (16740): `constructor(S, ToFind: TopAbs_ShapeEnum, ToAvoid?: TopAbs_ShapeEnum)` (16752), `Init`, `More`, `Next`, `Current`, `Value`, `Depth`. `NCollection_IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher` cannot be constructed ("unbound types: NCollection_BaseMap", verified), so `BRepTools.Map3DEdges` (16618) is unusable as well. |
| **gp_Ax1 / gp_Ax2 / gp_Ax3 / gp_Pln / gp_Trsf** | ✅ | `gp_Ax1(theP: gp_Pnt, theV: gp_Dir)` (5033). `gp_Ax2(P, V)` (5182), `gp_Ax2(P: gp_Pnt, N: gp_Dir, Vx: gp_Dir)` (5193). `gp_Ax3(theP, theN, theVx)` (5613), `gp_Ax3(theA: gp_Ax2)` (5597). `gp_Pln(theA3: gp_Ax3)` (7105), `(theP, theV: gp_Dir)` (7109), `(A, B, C, D)` (7119), with `Distance`, `SignedDistance(gp_Pnt)` and `Contains`. `gp_Trsf()` (7686): `SetMirror(gp_Pnt \| gp_Ax1 \| gp_Ax2)` (7695-7703), `SetRotation(theA1: gp_Ax1, theAng)` (7707), `SetScale(theP, theS)` (7719), `SetDisplacement(Ax3, Ax3)` (7728), `SetTransformation(Ax3[, Ax3])` (7738/7746), `SetTranslation(gp_Vec)` (7754), `SetTranslation(P1, P2)` (7758), `SetValues(a11..a34)` (7777), `Multiply`, `PreMultiply`, `Invert`, `Inverted`. Constant directions: `gp_Dir_D` = {X, Y, Z, NX, NY, NZ}. **`gp_Lin` is not bound.** |
| **Geom_Plane** | ❌ | Get a planar `Geom_Surface` with `oc.BRep_Tool.Surface(new oc.BRepBuilderAPI_MakeFace(gp_Pln).Face())` (verified). Bound surfaces: `Geom_CylindricalSurface(A3: gp_Ax3, Radius)` (21328), `Geom_SphericalSurface(A3, Radius)` (21651), `Geom_ConicalSurface(A3, Ang, Radius)` (20940), `Geom_BSplineSurface`. |
| **BRep_Tool** | ✅ | Static methods: `Surface(F)` (15932) and `(F, L)` (15928); `Curve(E, First?, Last?)` → `{returnValue: Geom_Curve, First, Last, [Symbol.dispose]}` (15990) and `(E, L, …)` (15981); `CurveOnSurface(E, F, First, Last, theIsStored)` → envelope (~16015); `Pnt(V)` (16179); `Parameter(V, E)` (16183); `Range(E)` → `{First, Last}` (16117); `Tolerance(F\|E\|V)` (15951-15959); `IsClosed`; `Degenerated(E)`; `Continuity(E, F1, F2)` (16167); `MaxContinuity`; `Parameters(V, F)`. |
| **BRepAdaptor_Curve / BRepAdaptor_Surface** | ⚠️ | `BRepAdaptor_Curve(E)` (16336), `(E, F)` (16340). Base class `GeomAdaptor_TransformedCurve` (22199): `GetType()` (22323), `Circle()` (22325), `Ellipse()` (22326), `BSpline()`, `Bezier()`, `EvalD0/D1/D2`, `FirstParameter`, `LastParameter`, `Value`. **`Line()` (22324) throws "unbound types: gp_Lin"** (verified); Hyperbola, Parabola and OffsetCurve are `unknown`. `BRepAdaptor_Surface(F, R?)` (16434). Base `GeomAdaptor_TransformedSurface` (22350): `GetType()` (22511), `Plane()`, `Cylinder()`, `Sphere()`, `BSpline()`, `AxeOfRevolution()`, `Direction()`, `EvalD1(u, v)` → `{Point, D1U, D1V}`, U/V parameter bounds. **`Cone()` and `Torus()` are `unknown`.** |
| **GeomAbs enums** | ✅ | `GeomAbs_CurveType` (4375), `GeomAbs_JoinType` {Arc, Tangent, Intersection} (4391), `GeomAbs_Shape` {C0, G1, C1, G2, C2, C3, CN} (4401), `GeomAbs_SurfaceType` (4429). Also `TopAbs_Orientation` (22539), `TopAbs_ShapeEnum` (22553), `BRepOffset_Mode` {Skin, Pipe, RectoVerso}, `ChFi3d_FilletShape`, `ChFiDS_ChamfMode`, `BRepBuilderAPI_TransitionMode` {Transformed, RightCorner, RoundCorner}, `BRepFill_TypeOfContact`, `Extrema_ExtAlgo`. **Every enum value is a string**, for example `"TopAbs_FACE"`. |
| **BRepMesh_IncrementalMesh** | ✅ | `constructor(theShape, theLinDeflection: number, isRelative?, theAngDeflection?, isInParallel?)` (12387). The codebase meshes with `ReplicadMeshExtractor.extract` and `ReplicadEdgeMeshExtractor.extract` instead (mesh.ts:29, 44). |
| **STEP reader/writer** | ✅ | `STEPControl_Reader()` (1086) with `ReadFile(filename)` (1100) and the inherited `TransferRoots`/`OneShape`. `STEPControl_Writer()` (1157) with `Transfer(sh, mode, compgraph, theProgress)` (1194) and `Write(file)` (1198). `STEPCAFControl_Writer` and XCAF are bound. `StlAPI_Writer.Write(shape, file, progress)` (1394). Files go through the in-memory `oc.FS`. |
| **Font / Font_BRepTextBuilder** | ❌ | Not bound. Build text from JS font outlines as Bezier or B-spline edges. |
| **Other bound classes useful for new features** | ✅ | `BRepPrimAPI_MakeBox`, `MakeCylinder`, `MakeSphere`, `MakeTorus`, `MakeHalfSpace` (13118-13694). `BRepOffsetAPI_MakeFilling` (12531). `Law_Linear`, `Law_S`, `Law_Interpol`, `Law_Composite`. `ShapeFix_Solid`, `ShapeFix_Face`, `ShapeFix_Wire`. `BRepBuilderAPI_Sewing`, `MakeSolid`, `MakeShell`, `MakeVertex`. `GeomAPI_ProjectPointOnSurf` (11606, verified). `GCPnts_TangentialDeflection` (23082). `HLRBRep_Algo` (12099). `BRepLib.BuildCurves3d(S)` (15744), `BuildPCurveForEdgeOnPlane`, `ExtendFace` (15874). `BRepTools.OuterWire(F)` (16613), `UVBounds`. `BRepToolsWrapper.Write(shape): string` / `Read(string): TopoDS_Shape` (32679; BRep text serialization that could cache tools across rebuilds). `ReplicadShapeHasher.HashCode(shape, bound)` (32752). `TopoDS.Edge/Wire/Face/Vertex/Shell/Solid/Compound` downcasts (32778). |
| **Not bound (beyond those asked about)** | ❌ | `BRepBuilderAPI_MakePolygon`, `GC_MakeSegment` (3D), `Geom_Line`, `Geom_Circle`, `GeomAPI_ProjectPointOnCurve` (3D), `GeomAPI_IntCS`, `BRepPrimAPI_MakeCone`, `MakeWedge`, `BRepBuilderAPI_Copy`, `BRepBuilderAPI_GTransform` (no non-uniform scale), `BRepAlgoAPI_Defeaturing`, `BRepClass3d_SolidClassifier`, `BRepOffsetAPI_MakeEvolved`, `ShapeAnalysis_*`, `gce_*`, `GCE2d_*`. |

## 2. Verified recipes for the new features

Each snippet below ran in Node against this build, without the scope wrapper; production code should wrap every `new` and every returned object in `s.track`.

```ts
// Revolve (partial angle): face from a sketch profile, axis in world space
const rev = new oc.BRepPrimAPI_MakeRevol(face, new oc.gp_Ax1(pnt, dir), angleRad, false);
// rev.FirstShape() / rev.LastShape() are the start/end cap faces; rev.Generated(profileEdge) is the swept face.

// Sweep with profile scaling (twist and scale use Law_* functions)
const ps = new oc.BRepOffsetAPI_MakePipeShell(spineWire);
ps.SetMode(false);                                           // or SetMode(binormalDir) / SetMode(ax2) / SetMode(auxWire, true, oc.BRepFill_TypeOfContact.BRepFill_NoContact)
const law = new oc.Law_Linear(); law.Set(0, 1, 1, 0.5);      // scale 1 -> 0.5
ps.SetLaw(profileWire, law, false, false);                   // or ps.Add(profileWire, false, false)
ps.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner);
ps.Build(new oc.Message_ProgressRange()); ps.MakeSolid();

// Loft: leave CheckCompatibility at its default (true)
const loft = new oc.BRepOffsetAPI_ThruSections(true /*solid*/, false /*ruled*/, 1e-6);
loft.AddWire(w1); loft.AddWire(w2); loft.Build(new oc.Message_ProgressRange());

// Shell: remove faces and keep a wall thickness (negative offset = inward)
const removed = new oc.NCollection_List_TopoDS_Shape(); removed.Append(topFace);
const sh = new oc.BRepOffsetAPI_MakeThickSolid();
sh.MakeThickSolidByJoin(body, removed, -2, 1e-3, oc.BRepOffset_Mode.BRepOffset_Skin, false, false,
  oc.GeomAbs_JoinType.GeomAbs_Arc, false, new oc.Message_ProgressRange());

// Draft
const dr = new oc.BRepOffsetAPI_DraftAngle(body);
dr.Add(face, pullDir, angleRad, neutralPln, true); if (!dr.AddDone()) { /* dr.ProblematicShape() */ }
dr.Build(new oc.Message_ProgressRange());

// Extrude "up to face/surface" (and drafted extrude): Fuse 1 = boss, 0 = cut
const dp = new oc.BRepFeat_MakeDPrism(body, profileFace, sketchSupportFace, draftRad /*0 = straight*/, 1, true);
dp.Perform(untilFace);   // or dp.Perform(height) / dp.PerformThruAll() / dp.PerformUntilEnd()

// Split a body by a face (surface/plane split, the multi-body split feature)
const sp = new oc.BRepAlgoAPI_Splitter();
sp.SetArguments(new oc.NCollection_List_TopoDS_Shape([body])); sp.SetTools(new oc.NCollection_List_TopoDS_Shape([toolFace]));
sp.Build(new oc.Message_ProgressRange());

// Exact helix (threads, springs): a 2D line on a cylindrical surface
const cyl = new oc.Geom_CylindricalSurface(new oc.gp_Ax3(origin, axis, xDir), radius);
const l2 = new oc.Geom2d_Line(new oc.gp_Pnt2d(0, 0), new oc.gp_Dir2d(2 * Math.PI, pitch));
const e = new oc.BRepBuilderAPI_MakeEdge(new oc.Geom2d_TrimmedCurve(l2, 0, Math.hypot(2*Math.PI, pitch) * turns, true, true), cyl).Edge();
oc.BRepLib.BuildCurves3d(e);   // required: otherwise the edge has no 3D curve

// Sketch spline through points (1-based arrays; wrap a filled Array1 in an HArray1)
const a = new oc.NCollection_Array1_gp_Pnt(1, n); pts.forEach((p, i) => a.SetValue(i + 1, p));
const it = new oc.GeomAPI_Interpolate(new oc.NCollection_HArray1_gp_Pnt(a), false, 1e-7); it.Perform();
const splineEdge = new oc.BRepBuilderAPI_MakeEdge(it.Curve()).Edge();

// Ellipse and elliptical arc edges
const el = new oc.gp_Elips(new oc.gp_Ax2(c, n, majorDir), R, r);
new oc.BRepBuilderAPI_MakeEdge(el, u0, u1);  // or new oc.GC_MakeArcOfEllipse(el, p1, p2, true).Value()

// 2D sketch offset of a closed or open chain
const off = new oc.BRepOffsetAPI_MakeOffset(wire, oc.GeomAbs_JoinType.GeomAbs_Arc, /*IsOpenResult*/ false);
off.Perform(dist, 0);

// Variable-radius fillet, two-distance chamfer, distance-angle chamfer
fil.Add(r1, r2, edge);   fil.Add(uAndRArray /* NCollection_Array1_gp_Pnt2d of (u, r) */, edge);
ch.Add(d1, d2, edge, faceForD1);   ch.AddDA(d, angleRad, edge, refFace);

// Reference geometry: distance and closest points between any two shapes (edge to edge, vertex to face)
const d = new oc.BRepExtrema_DistShapeShape(a, b);  // two arguments only
d.Value(); d.PointOnShape1(1); d.SupportOnShape1(1); d.ParOnEdgeS1(1).t;
```

## 3. Codebase wrapper: loading, Scope, ops, errors, tests

**Loading (`src/kernel/oc.ts`).**
- `loadOC(options)` (26-39) loads the instance once and shares one promise between callers. It passes `print: () => {}` to silence OCCT's stdout, and `locateFile = () => wasmUrl` in the browser.
- `getOC()` (57-60) throws if OC is not loaded yet.
- `heapBytes()` (42) reads `wasmMemory.buffer.byteLength`.
- `RECYCLE_HEAP_BYTES = 1 GiB` (20). `recycleOC()` (51-55) drops the instance and loads a fresh one, because the WASM heap never shrinks (README 856-859).
- The browser worker imports `replicad-opencascadejs/wasm?url` (`src/worker/kernel.worker.ts:4`) and recycles at line 115. `vite.config.ts` excludes the package from `optimizeDeps`.
- `src/kernel/index.ts` re-exports `loadOC, getOC, recycleOC, heapBytes, RECYCLE_HEAP_BYTES, scoped, Scope, type OC` and the kernel functions.

**Scope (`oc.ts:63-91`).**
- `class Scope { track<T extends {delete():void}>(obj: T): T; dispose() }`. `dispose` deletes in reverse order and swallows "already deleted" errors.
- `scoped(fn)` always disposes in a `finally`. Every kernel function takes `(oc: OC, s: Scope, …)` and tracks **every** object, including intermediates and returned value objects such as `Shape()`, `ex.Current()`, `CentreOfMass()` and `Location()`.

**Results that outlive a scope.**
- `copyOut(shape)` (ops.ts:612-618) returns `shape.clone()`, a second embind handle to the same C++ shape.
- `rebuild.ts` `commit` (218-252) copies the new body out at line 228, deletes the old one, and stores it in the `bodies` map. `RebuildResult.dispose()` deletes the bodies.
- Pattern seed tools are kept the same way (`tools.set(…, {tool: copyOut(tool)})`, rebuild.ts:269/280/301) and deleted at line 505.

**Errors.**
- `export class OpError extends Error {}` (ops.ts:35). Operations throw it with messages written for the agent to act on.
- `rebuild.ts:492-503` catches per feature. An `OpError` keeps its message; anything else becomes `kernel error: ${kernelMessage(oc, e)}`.
- `kernelMessage` (rebuild.ts:611-619) returns `e.message` for a JS `Error` (embind BindingErrors). Otherwise it calls `oc.getExceptionMessage(e)` and returns `[type, message]`, for example `["Standard_ConstructionError", "gp_Dir() - input vector has zero norm"]`. Each feature is all-or-nothing, and errors are prefixed `"<id>: "`.
- Each operation checks its result. `fuseInto` (195-208) and `removeFrom` (215-242) check `IsDone()`, `isValidShape` (`BRepCheck_Analyzer(shape, true, false, false).IsValid()`, measure.ts:101-103) and the volume change against `VOLUME_EPS = 1e-9`. `treatEdges` (335-354) checks the volume changed.

**Tests.**
- `tests/kernel.test.ts:10-13` and `tests/phase-b-ops.test.ts:14-16` both use `let oc: OC; beforeAll(async () => { oc = await loadOC(); });`. Node finds the `.wasm` beside the glue, so no options are needed.
- A helper `build(doc)` calls `rebuild(doc, oc)`, copies out the fields it needs, then calls `r.dispose()` (kernel.test.ts:15-20). Tests that inspect topology use `try { scoped((s) => describeFaces(oc, s, r.solid!)…) } finally { r.dispose() }` (kernel.test.ts:112-124, phase-b-ops:263-290).
- Config (`vite.config.ts` `test`): `environment: "node"`, `include: tests/**/*.test.ts`, `testTimeout: 60_000`, `hookTimeout: 60_000`.
- Volume asserts use `toBeCloseTo(expected, 6)` against hand-calculated closed forms. `tests/recycle.test.ts` checks the heap shrinks after `recycleOC()`.

## 4. Seven idioms copied from the codebase

**1. gp primitives and axes, tracked (ops.ts:49-51, 61, 85-86, 312)**
```ts
const pnt = (oc: OC, s: Scope, v: Vec3) => s.track(new oc.gp_Pnt(v[0], v[1], v[2]));
const dir = (oc: OC, s: Scope, v: Vec3) => s.track(new oc.gp_Dir(v[0], v[1], v[2]));
const vec = (oc: OC, s: Scope, v: Vec3) => s.track(new oc.gp_Vec(v[0], v[1], v[2]));
const ax2 = s.track(new oc.gp_Ax2(pnt(oc, s, to3D(frame, seg.c)), dir(oc, s, axis), dir(oc, s, frame.x)));
const ax3 = s.track(new oc.gp_Ax3(pnt(oc, s, frame.origin), dir(oc, s, frame.z), dir(oc, s, frame.x)));
const plane = s.track(new oc.gp_Pln(ax3));
const axis = s.track(new oc.gp_Ax1(pnt(oc, s, entry), dir(oc, s, into)));
```

**2. Edge, wire and face from points and arcs (ops.ts:53-80, 88-91, 306-311)**
```ts
edge = s.track(new oc.BRepBuilderAPI_MakeEdge(pnt(oc, s, to3D(frame, seg.a)), pnt(oc, s, to3D(frame, seg.b))));
const arc = s.track(new oc.GC_MakeArcOfCircle(pnt(oc,s,a), pnt(oc,s,mid), pnt(oc,s,b)));
edge = s.track(new oc.BRepBuilderAPI_MakeEdge(arc.Value()));   // Value() belongs to the builder
if (!edge.IsDone()) throw new OpError(`could not build an edge for "${seg.entity}"`);
wire.Add(s.track(edge.Edge()));
// face on a plane, with hole wires:
const mf = s.track(new oc.BRepBuilderAPI_MakeFace(plane, loopWire(oc, s, frame, region.outer), true));
for (const hole of region.holes) mf.Add(loopWire(oc, s, frame, hole));
if (!mf.IsDone()) throw new OpError(`could not build a face …`);
const face = s.track(mf.Face());
```

**3. Boolean, then unify (ops.ts:131-142); multi-body version in `combineBodies` (502-531)**
```ts
const progress = s.track(new oc.Message_ProgressRange());
const op = s.track(kind === "fuse" ? new oc.BRepAlgoAPI_Fuse(a, b, progress) : new oc.BRepAlgoAPI_Cut(a, b, progress));
if (!op.IsDone()) throw new OpError(`the ${kind} boolean failed in the kernel`);
const u = s.track(new oc.ShapeUpgrade_UnifySameDomain(s.track(op.Shape()), true, true, false));
u.Build();
return s.track(u.Shape());
```

**4. Exploring faces and edges, and classifying them (topology.ts:41-49, 154-170, 75-86, 190-216)**
```ts
const ex = s.track(new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
for (; ex.More(); ex.Next()) faces.push(s.track(oc.TopoDS.Face(s.track(ex.Current()))));
// unique edges (no TopExp.MapShapes): hash bucket + IsSame
const find = (e) => (buckets.get(oc.ReplicadShapeHasher.HashCode(e, HASH_BOUND)) ?? []).find((i) => edges[i].IsSame(e)) ?? -1;
// classify
const adaptor = s.track(new oc.BRepAdaptor_Surface(face, true));
if (adaptor.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane) { const plane = s.track(adaptor.Plane()); … }
const curve = s.track(new oc.BRepAdaptor_Curve(edge));
const p = curve.EvalD0(t); const v = [p.X(), p.Y(), p.Z()]; p.delete();
```

**5. Transforms (ops.ts:388-390, 538-542, 545-558, 561-569)**
```ts
const t = s.track(new oc.gp_Trsf());
t.SetRotation(s.track(new oc.gp_Ax1(pnt(oc, s, origin), dir(oc, s, normalize3(d)))), (angle * Math.PI) / 180);
// or t.SetTranslation(vec(oc, s, offset)); or t.SetMirror(s.track(new oc.gp_Ax2(pnt(…), dir(…))));
return s.track(s.track(new oc.BRepBuilderAPI_Transform(shape, t, true, false)).Shape());
// points and dirs: p.Transform(t); q.Transform(t);
```

**6. Scope lifetime and keeping a result (rebuild.ts:256-263, 228; ops.ts:616)**
```ts
scoped((s) => {
  const tool = extrudeTool(oc, s, raw, profile, partShape(oc, s, bodies));
  commit(new Map([[name, fuseInto(oc, s, into, tool, "extrusion")]]));  // commit() copyOut()s before s is disposed
  tools.set(raw.id, { tool: copyOut(tool), kind: "fuse", … });         // outlives the scope; deleted later
});
```

**7. Properties and bounds (measure.ts:80-99) and point-on-face check (ops.ts:269-276)**
```ts
const props = s.track(new oc.GProp_GProps()); oc.BRepGProp.VolumeProperties(shape, props, false, false, false); props.Mass();
const box = s.track(new oc.Bnd_Box()); oc.BRepBndLib.AddOptimal(shape, box, false, false); if (box.IsVoid()) return null;
const vertex = s.track(s.track(new oc.BRepBuilderAPI_MakeVertex(pnt(oc, s, entry))).Vertex());
const dist = s.track(new oc.BRepExtrema_DistShapeShape(vertex, face)); if (!dist.IsDone()) …; dist.Value();
```

The scattered quirks are also in the codebase. HLR: `HLRBRep_Algo` is not tracked and is deleted in a `finally` (project.ts:36-54). STEP: the `TDocStd_Document` is deliberately **not** deleted because OCCT owns it (step.ts:110-111), and files go through `oc.FS.writeFile`, `readFile` and `unlink`. Mesh: views on `oc.wasmMemory.buffer` are taken **after** extraction because the heap may have grown, then `.slice()`d (mesh.ts:31-37).

## 5. Pitfalls

1. **Overloads are resolved by type, without suffixes.** Passing the wrong JS type throws a JS `BindingError` with a minified class name, for example `V: Cannot pass "5" as a gp_Pnt`. `kernelMessage` surfaces it as `e.message`.
2. **`unknown` in the `.d.ts` means the C++ type is not bound.**
   - An overload with an `unknown` parameter cannot be called.
   - A method returning `unknown` throws `Cannot call X due to unbound types: …`. Verified on `BRepAdaptor_Curve.Line()`, `MakeEdge.Error()`, `MakeFace.Error()`, `DistShapeShape.SupportTypeShape1()`, and on `DistShapeShape` with a 3rd constructor argument.
   - `// dropped:` comments mark overloads removed from the build.
   - There is no `gp_Lin`: take a line's direction from its endpoints, as topology.ts:213-215 does. Reference axes have to be bounded edges or plain JS data.
3. **Enums are strings.** `oc.TopAbs_ShapeEnum.TopAbs_FACE === "TopAbs_FACE"` and `shape.ShapeType()` returns `"TopAbs_SOLID"`. Compare with `===` against `oc.Enum.Member`. Never compare with a numeric value.
4. **OCCT exceptions are `WebAssembly.Exception`, not `Error`.** Decode them with `oc.getExceptionMessage(e)`.
   - `Shape()`, `Edge()` or `Face()` on a builder that did not finish throws `StdFail_NotDone`. Always call `IsDone()` first; for example `MakeThickSolidBySimple` on a box was NotDone.
   - `gp_Dir(0,0,0)` throws `Standard_ConstructionError`. Guard zero-length vectors in JS before constructing.
5. **`GC_*.Value()` returns `null` when `!IsDone()`.** Collinear 3-point arcs do this. Check `IsDone()` before passing the value to `MakeEdge`.
6. **Fillet failure may not throw.** `Build()` returns normally, and you must check `IsDone()`, `NbFaultyContours()` and `HasResult()`. A radius of 30 on a 20 mm box gave done = false and 1 faulty contour. `treatEdges` relies on `IsDone()` (ops.ts:342).
7. **Memory.**
   - Every returned object is a new handle: `Shape()` twice gives two JS objects that are `IsSame`. Track them all.
   - Methods with output parameters return plain envelopes, `{returnValue, First, Last, [Symbol.dispose]}` (for example `BRep_Tool.Curve`, `CurveOnSurface`, `Range`). These have **no `delete()`**, so `s.track` won't accept them. Call `env[Symbol.dispose]()` or delete the fields. `tsconfig` lib is ES2023, so `using` is not available.
   - `EvalD1` returns `{Point, D1U, D1V}`; delete each field (topology.ts:100-104).
   - The heap only grows, so keep interactive sketch work (trim, extend, offset previews, inference) in JS. Only the rebuild should touch OCCT.
8. **Collections.**
   - There is no list iterator. To walk a result list, drain a copy: `const l = new oc.NCollection_List_TopoDS_Shape(list); while (!l.IsEmpty()) { const x = l.First(); l.RemoveFirst(); }` (verified on `Splitter.Modified`).
   - Lists can be built from a JS array: `new NCollection_List_TopoDS_Shape([a, b])`.
   - Arrays are **1-based**.
   - `HArray1.ChangeArray1()` returns a **copy**, so writing into it is lost. `GeomAPI_Interpolate` then threw `Standard_ConstructionError`. Fill an `Array1` and wrap it in `new NCollection_HArray1_gp_Pnt(array1)`.
   - `NCollection_IndexedMap` and `NCollection_Map` cannot be constructed. This rules out `Map3DEdges` and `UnifySameDomain.KeepShapes`; use the hash plus `IsSame` pattern from topology.ts:154-170 instead.
9. **History and HasGenerated.**
   - `BRepAlgoAPI_*` has working `HasModified`, `HasGenerated` and `HasDeleted`, plus `Modified(S)`, `Generated(S)` and `IsDeleted(S)` (verified on Fuse).
   - Sweeps expose `Generated(S)`, `FirstShape()` and `LastShape()`. `BRepFeat` has `TopEdges` and `LatEdges`.
   - `ShapeUpgrade_UnifySameDomain.History()` is `unknown`. The codebase unifies after every boolean (ops.ts:135), so any face naming taken from history must be read **before** the unify step, or recovered geometrically with `faceSignature` (topology.ts:234-247).
10. **Loft.** `CheckCompatibility(false)` with wires of different edge counts gave a BRepCheck-invalid solid: a rectangle-to-circle loft had volume 631 and failed the check. The default gives a valid 1481.9. You can also split the circle into 4 arcs. Run `isValidShape` on every new feature's result.
11. **MakePipe's mode overload cannot be called.** Use `MakePipeShell.SetMode(...)` for Frenet, fixed, binormal or guide-curve sweeps, followed by `Build()` and then `MakeSolid()`.
12. **Workarounds for missing APIs.**

| Missing | Use instead |
|---|---|
| `Geom_Plane` | `BRep_Tool.Surface(MakeFace(gp_Pln).Face())` |
| `BRepFeat_MakePrism` | `BRepFeat_MakeDPrism` with angle 0, or `reachAlong` plus prism and boolean as the codebase does now |
| `BRepProj_Projection` (convert/project entities) | Project lines, arcs and circles analytically in JS onto the sketch plane (an off-plane circle projects to an ellipse via `gp_Elips`). For curves, use `BRepAlgoAPI_Section` with the plane, `HLRBRep_Algo`, or `GeomAPI_ProjectPointOnSurf` samples fed to `GeomAPI_Interpolate`. |
| `BRepFilletAPI_MakeFillet2d` | Sketch fillets and chamfers in 2D JS, with `Geom2dAPI_InterCurveCurve` and `Geom2d_OffsetCurve` if needed |
| `BRepTools_WireExplorer` | Order edges by vertex points |
| `MakeCone` | Revolve a triangle |
| Text | JS font outlines to `Geom_BezierCurve` or B-spline edges |

13. **Lifetime of builder outputs.** Track the builder and its outputs in the same scope; the `GC_MakeArcOfCircle.Value()` result belongs to its builder (comment at ops.ts:72). `copyOut` is the only way to move a shape out of a scope.
14. **Units and angles.** OCCT angles are radians. The document uses degrees and converts at the call site (ops.ts:381, 549). Lengths are mm. STEP export sets `write.step.unit=MM` **after** constructing the writer, because the constructor resets the statics (step.ts:86-89).