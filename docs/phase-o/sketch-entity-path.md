# Sketch entities end to end, model reference edges, solver fixed entities, profile topology (Cocaide @ 4de1139)

Everything below was read, not run, and all line numbers are from the current tree. One thing affects all four sections: **the document stores solved geometry, and the rebuild only checks it.** The rebuild never solves a sketch (`src/geom/solver.ts:9-10`, `src/geom/constraints.ts:1-4`, `src/kernel/rebuild.ts:587-594 buildSketch`: `checkConstraints` then `buildProfile`). Sketch re-solving happens only on the document side: `src/doc/commands.ts:700 resolveSketch`, `:600 resolveSketchesUsing`, and `:628 editSketch` behind `addEntity`, `updateEntity`, `deleteEntity`, `addConstraint` and `deleteConstraint`. It also happens in the UI draft (`SketchMode`).

---

## 1. Where an entity type flows, and a checklist for adding one

### 1.1 Current types (`src/doc/types.ts`)
- `EntityBase` (378-382): `{ id; construction? }`.
- `LineEntity` (384) `start, end`; `CircleEntity` (390) `center, radius`; `ArcEntity` (397) `center, start, end, clockwise?` (counter-clockwise by default); `RectEntity` (405) `center, w, h`, axis-aligned only; `SlotEntity` (413) `center1, center2, width`.
- `SketchEntity` union (420), `SketchEntityType` (421), `PointRef = "id.point" | "origin"` (424).
- `ProfileDef.entities: SketchEntity[]` (210): weldment profiles reuse the same entities.
- **Limitations:**
  - A rect has only the point `center`. Its corners are drag-only handles (`draft.ts:36`, `constraint:false`), so nothing can be made coincident with or dimensioned to a rect corner, and a sketch fillet can't use one.
  - A slot has only `center1` and `center2`.
  - There is no sketch-point entity and no polyline entity.

### 1.2 Every switch on entity type

There are two kinds of site. **[TS]** means the TypeScript compiler will flag a missing case: a `Record<SketchEntity["type"], …>` map, or a function that must return a value. **[SILENT]** means a missing case compiles and misbehaves quietly.

| # | File:line | Symbol | What it does per type | Kind |
|---|---|---|---|---|
| 1 | `src/doc/types.ts:384-421` | interfaces and union | Add the interface and extend the union. | — |
| 2 | `src/doc/validate.ts:343-349` | `ENTITY_FIELDS` | Allowed keys per type, used by `c.keys` at 448. A new top-level key such as `ref` must also go into the list at 448 (`["id","type","construction",...]`). | TS |
| 3 | `src/doc/validate.ts:351-357` | `POINT_NAMES` | Legal `PointRef` suffixes, checked in `pointRef` at 519-536. | TS |
| 4 | `src/doc/validate.ts:423-493` | `validateEntity` switch 451-491 | Builds the typed entity. **A missing case leaves `entity = null` with no error, so the entity is silently dropped from the sketch** (492, 397). | SILENT |
| 5 | `src/doc/validate.ts:495-682` | `validateConstraint` allowed-type lists | horiz/vert 577 `["line"]`; point-line 596 `["line"]`; distance 601 `["line","slot"]` or `["line","rect","slot"]`; radius/diameter 610 `["circle","arc"]`; equal 616/619 (kind line or round); pair 632; tangent 642; midpoint/pointOn 654; symmetric 661; fix 675. | SILENT (new type is just refused) |
| 6 | `src/doc/sketch.ts:58` | `ENTITY_PREFIX` | Id prefixes (l, c, a, r, s). Used by `nextEntityId` (61), `commands.ts:639` (`?? "e"` fallback) and `SketchCanvas.tsx:148`. | TS |
| 7 | `src/doc/sketch.ts:7-38` | `constraintEntities` | Switches on constraint type only. No change unless a constraint shape changes. | — |
| 8 | `src/geom/solver.ts:48-54` | `FIELDS` | Unknowns per type, `[field, width 1\|2]`. `layout` (56), `unpack` (70), `sketchStatus` (477), fix (287/291), body drag (332) and `opts.fixed` (402) all iterate it. Only top-level number or `Vec2` fields are possible. | TS |
| 9 | `src/geom/solver.ts:82-87` | `pointOf` | Reads `l.at.get(ref)` as a width-2 slot, so every point name must be a width-2 FIELD. | — |
| 10 | `src/geom/solver.ts:96-99` | `span` | Slot uses center1/center2; everything else uses start/end. | SILENT |
| 11 | `src/geom/solver.ts:101-110` | `radiusOf` | Circle reads `radius`; anything else uses \|center−start\|. | SILENT |
| 12 | `src/geom/solver.ts:123-132` | built-in equations | Arc: \|c−s\| = \|c−e\|. A new type with internal coupling adds it here. | SILENT |
| 13 | `src/geom/solver.ts:160-165`, `321-357`, `364-387` | rect `distanceX/Y`; drag handles (`body`, `circle.edge`, `rect.cornerN`) and anchors | Per-type drag behaviour. | SILENT |
| 14 | `src/geom/solver.ts:488-496` | `invalidGeometry` | Degenerate-geometry rejection. | SILENT |
| 15 | `src/geom/constraints.ts:148-150` | `centre` | Uses `"center" in e`. **Any new type with a field called `center` is treated as round.** | SILENT |
| 16 | `src/geom/constraints.ts:153-162,164-168,170-175` | `entitySpan`, `radius`, `point` | `point()` returns `e[name]`, so point refs must be top-level `Vec2` fields. | SILENT |
| 17 | `src/geom/profile.ts:38-57` | `buildProfile` switch | circle, rect and slot become their own `Loop`. Line and arc become open `Seg`s for `chain`. A missing case means the entity is simply ignored. | SILENT |
| 18 | `src/geom/profile.ts:73-117` | `fullCircle`, `rectSegs`, `slotSegs`, `arcSeg` | Entity to `Seg[]`. | — |
| 19 | `src/geom/profile.ts:367-391` | `entityPolylines` | Display polylines. `let segs` would be "used before assigned" with no case. Used by `SketchCanvas` (`EntityShape` 476, `fitView` 624, `boxPick` 649), `rebuild.ts:602` overlay and `ProfileDrawing.tsx:7`. | TS |
| 20 | `src/geom/profile.ts:13-16` | `Seg` (`line` and `arc` only) | Only needed if the new type cannot be expressed as lines and arcs. Then also update `segArea` (179), `reverseSeg` (169), `intersect` (216), `windingNumber` (326), `sampleSeg` (352) and `arcMid` (347). | — |
| 21 | `src/kernel/ops.ts:53-80` | `loopWire` | Switches on `Seg.kind`, not on entity type. Line uses `BRepBuilderAPI_MakeEdge(p,q)`. A full arc uses `gp_Ax2` (axis = ±`frame.z` by sweep sign) and `gp_Circ`. A partial arc uses `GC_MakeArcOfCircle(a, arcMid, b)`. | per Seg kind |
| 22 | `src/kernel/ops.ts:83-102` | `profileFaces` | **Checks the OCCT face area against the exact 2D area to 1e-6 relative (94-99).** A polyline-approximated area for a spline or ellipse would fail here, so `segArea` must be exact or this tolerance has to change. | — |
| 23 | `src/kernel/rebuild.ts:587-605` | `buildSketch`, `overlay` | Generic, through `buildProfile` and `entityPolylines`. | — |
| 24 | `src/ui/sketcher/draft.ts:19-41` | `handlesOf` | Grab and snap points. | TS |
| 25 | `src/ui/sketcher/draft.ts:44-73` | `distanceTo` | Hit testing, used by `hitEntity` (100) and `inferPoint` (349). | TS |
| 26 | `src/ui/sketcher/draft.ts:158-287` | `suggestions` | Add Relations and dimension offers by type. `smartDimension` (296-314) filters these. | SILENT |
| 27 | `src/ui/sketcher/draft.ts:330-366` | `inferPoint` | Midpoint snap is lines only (337). On-entity snap is line or round only (348). | SILENT |
| 28 | `src/ui/sketcher/draft.ts:422-455` | `entityFromClicks` | Clicks to one entity. **Returns a single entity**, so multi-entity tools need a new API. | TS |
| 29 | `src/ui/sketcher/draft.ts:458` | `CLICKS` | Clicks per tool. | TS |
| 30 | `src/ui/sketcher/SketchCanvas.tsx:12` | `type Tool = "select" \| "dimension" \| SketchEntity["type"]` | Tools are tied one-to-one to entity types. `ID_PREFIX[tool]` (148), `CLICKS[tool]` (298, 359) and `entityFromClicks(tool…)` (149, 366) depend on that. | TS |
| 31 | `src/ui/sketcher/SketchCanvas.tsx:152-158` | `finishPlacement` names map | Maps click index to point name, which drives the inferred coincident/pointOn relations (160-170). | TS |
| 32 | `src/ui/sketcher/SketchCanvas.tsx:356-368` | preview | Has an arc/slot special case (360-363). | SILENT |
| 33 | `src/ui/sketcher/SketchCanvas.tsx:475-480` | `EntityShape` | Generic, through `entityPolylines`. | — |
| 34 | `src/ui/sketcher/SketchMode.tsx:55-63` | `TOOLS` `[Tool, label, commandId]` | Toolbar (402), shortcut bar (429), context menu (307), `useCommands` (246). | — |
| 35 | `src/ui/sketcher/SketchMode.tsx:786` | `toolIcon` | Returns `t` itself, so **an icon with the tool's exact name must exist** in `src/ui/icons.tsx` `ICONS` (101-117: select, line, rect, circle, arc, slot). `TOOL_TITLE` at 781. | TS |
| 36 | `src/ui/sketcher/SketchMode.tsx:789` | `RELATION_NOUN` | Menu titles. | TS |
| 37 | `src/ui/input.ts:80-88` | `COMMANDS` | Sketch-group keys. `tests/input.test.ts:25` fails on a clash. Taken keys that can't be reused: V D L R C A O Q Ctrl+B in Sketch; S F Z Shift+Z Enter Delete F9 Space in General/View. | — |
| 38 | `src/ui/sketcher/annotate.ts:58-219` | `dimensionShapes` | Rect (141-145), line/slot (149-150) and circle/arc (162-189) special cases. **Line 60 treats every array value of an entity as a `Vec2`**, which breaks for a `points: Vec2[]` field. | SILENT |
| 39 | `src/ui/sketcher/annotate.ts:286-306` | `anchorOf` | Glyph anchor. | TS |
| 40 | `src/ask/packet.ts:519-532` | `entityMeasurements` | Per-type measurements for the AI packet. | TS |
| 41 | `src/doc/commands.ts:725-731` | `resolveSketch` write-back | Writes solved values back per field. Numbers and flat arrays only; **a nested `Vec2[]` field breaks here** (`clean(solved[field][k])` on a `Vec2`). | SILENT |
| 42 | `src/mcp/reference.ts:36-43`, `src/mcp/server.ts:92` | AI/MCP docs | Entity list and point-ref names. These feed the AI prompt through `src/ask/prompt.ts:5,160` `REFERENCE`. | docs |
| 43 | `src/intent/plan.ts:76-103` | planner | Emits only `circle` (80) and `rect` (97). Change only if the planner should use the new type. | — |
| 44 | `src/geom/section.ts:56,106,146` | weldment section properties | `sectionOf`, through `buildProfile` and `sampleSeg`. `round` = all segments are arcs (106). | via Seg |
| 45 | `src/ui/ProfileCard.tsx:103`, `src/ui/ProfileDrawing.tsx:7` | weldment UI | Generic counts and drawing. | — |
| 46 | tests | `tests/{profile,solver,relations,sketch-draft,sketch-commands}.test.ts`, `e2e/sketch-relations.spec.ts` | — | — |

### 1.3 How each candidate type fits
- **Polygon:** no new entity type. Emit N `line` entities, a construction circle, coincident links between consecutive lines, `pointOn` of each vertex on the circle, and `equal` on all lines. That leaves 4 degrees of freedom (centre, radius, rotation). Profile and kernel need no changes. Corner, centre and 3-point rectangles, centerline (`construction:true` line) and parallelogram work the same way.
  - What has to change is the tool layer: `entityFromClicks` and `onCreate(entity, relations)` handle exactly one entity (`SketchCanvas.tsx:40,179`; `SketchMode.tsx:165-181`).
  - `Tool` has to stop being `SketchEntity["type"]`. Recommended: a tool registry `{ id, clicks, build(pts, ids) → { entities[], relations[] } }`.
- **3-point arc and tangent arc:** tool-only. Both emit an `arc`, plus a `tangent` relation for the tangent arc.
- **Point:** `{type:"point", at: Vec2}`.
  - FIELDS `[["at",2]]`, POINT_NAMES `["at"]`, `handlesOf`, `distanceTo`, `entityPolylines` returning `[]` or a dot, and `buildProfile` skipping it.
  - Do not call the field `center`, because `constraints.ts:149` would then treat a point as round.
- **Ellipse:** needs a new `Seg` kind.
  - Changes: `segArea` (closed-form Green's integral), `intersect` (line-ellipse is a quadratic, ellipse-ellipse needs a numeric solve), `windingNumber`, `sampleSeg`, `reverseSeg`, and `loopWire` with `gp_Elips` / `GC_MakeArcOfEllipse`. Both classes exist in `replicad_single.d.ts`.
  - Solver unknowns: centre (2), major-axis point (2), minor radius (1).
- **Spline:** needs variable-length fields.
  - Turn `FIELDS` into a `fieldsOf(e)` function, generalise `point()` (`constraints.ts:170`), `POINT_NAMES` and the `resolveSketch` write-back (#41), and fix `annotate.ts:60`.
  - Kernel: `GeomAPI_Interpolate` or `GeomAPI_PointsToBSpline` with `TColgp_HArray1OfPnt`; `Geom_BSplineCurve` is also present.
  - The exact-area check in #22 needs special handling.

---

## 2. Model-edge data available for Convert Entities and for dimensioning to model edges

### 2.1 What the sketcher gets today
- **Source.** `src/ui/App.tsx:1088` builds `reference = projectEdges(view, sketch.plane)` (1688-1702).
  - It walks `view.mesh.edgeRanges[i]`, skips `view.edges[i].seam`, and projects each tessellated segment of `view.mesh.edges` (x0 y0 z0 x1 y1 z1 …) with `to2D(planeFrame(...))` (`src/geom/frame.ts:39`).
  - The output is a flat `Float32Array [x0,y0,x1,y1,…]`.
  - **The edge index, kind, depth and in-plane flag are all thrown away.** Every edge is projected orthographically, including edges far behind the plane.
- **Into the canvas.** `SketchMode` passes it through (`Props.reference` 39, 459). `SketchCanvas` (`Props.reference` 33) draws it as one `<path class="reference">` in `ReferenceLines` (482-489) and includes it in `fitView` (625).
  - It is **not** hit-tested (`itemAt` 139-144 uses entities only).
  - It is **not** snapped to (`inferPoint` takes only `entities`, 129).
  - It is **not** selectable (`SketchItem` is `entity | point`, `draft.ts:9`).
- **`view` is the full-document rebuild** (`App.tsx:116`, set at 243).
  - Editing an existing sketch (`editSketch` 388-405) shows edges from **every feature, including the ones after the sketch and the extrude made from this sketch**. There is no rollback.
  - For a new sketch (`startSketch` 373, appended at the end) the view is already the "before" state.

### 2.2 `RebuildView` (`src/worker/protocol.ts:14-27`)
`{ ok, name, errors, features, sketches: SketchOverlay[], measurements, mesh: MeshData|null, faces: FaceInfo[], edges: EdgeInfo[], bodies: BodyRange[] }`
- `MeshData` (`src/kernel/mesh.ts:9-19`): `edges: Float32Array` holds segment pairs, and `edgeRanges[i] = {start, count}` in segment units, in **the same order as `EdgeInfo.index`** (17). Built in `tessellate` 44-66.
- The worker fills `faces` and `edges` with `describeFaces` / `describeEdges` (`src/worker/kernel.worker.ts:59-64`). It calls `labelBodies` **only when there is more than one body** (66), so `EdgeInfo.body` is undefined for a single-body part.

### 2.3 `EdgeInfo` (`src/kernel/topology.ts:124-149`, filled by `edgeInfo` 186-227)

| field | content |
|---|---|
| `index` | Unique-edge explorer order (`listEdges` 154-170, de-duplicated with `IsSame`). Valid for this rebuild only. |
| `kind` | `"line"` (GeomAbs_Line and non-zero length), `"circle"` (GeomAbs_Circle, arcs too), or `"other"` (ellipse, B-spline and so on). |
| `length` | `BRepGProp.LinearProperties`. |
| `start`, `end` | `curve.EvalD0(FirstParameter / LastParameter)`. This is curve-parameter order; edge orientation is ignored. A full circle has `start == end`. |
| `mid` | The point at the parameter midpoint. Good as the third point of an arc. |
| `centroid` | Centre of mass. For a full circle this is its centre. |
| `direction` | Lines only: unit start→end. |
| `radius`, `center`, `axis` | Circles only. `axis` is the OCCT circle axis, sign as stored. |
| `faces` | `FaceInfo.index` of adjacent faces (`describeEdges` 172-184). |
| `seam` | `faces.length === 1`, the self-seam of a closed surface. Skipped everywhere. |
| `body?` | Body name, only when labelled. |

**Missing:** sweep and parameter range, edge orientation, vertex ids, and any geometry for `"other"` edges beyond start/mid/end/length. For those, the polyline at `mesh.edges[edgeRanges[i]]` is the only usable shape.

**Projecting into a sketch frame** (`frame = planeFrame(plane.normal, plane.origin, plane.xDir)`, `to2D`):
- **Line:** `a = to2D(start)`, `b = to2D(end)`. Skip if `|direction·z| ≈ 1`, because the edge projects to a point.
- **Circle or arc:** only exact when `|axis·z| ≈ 1`; otherwise it projects to an ellipse.
  - `c = to2D(center)`, `r = radius`.
  - A full circle is `dist3(start, end) < tol` and becomes a `circle`.
  - Otherwise it becomes an `arc` with `start = to2D(start)`, `end = to2D(end)` and `clockwise = dot(axis, z) < 0`. This works because OCCT circles run counter-clockwise about their axis. Sweep = `length / r`, cross-checked with `mid`.
- **In-plane test:** `|dot(p − frame.origin, z)| < tol` for both ends. Use it to highlight or default-filter "on plane" edges.
- **Not available:** silhouettes (they are not B-rep edges). `BRepAlgoAPI_Section` exists in the bindings if intersection curves are wanted.

### 2.4 Can a selector re-find the edge? Yes, with caveats
- `src/kernel/synthesize.ts:49-84 edgeSelectorFor(edges, faces, index): Synthesis<EdgeSelector>` is pure. It runs on `view.edges` and `view.faces` in the UI thread and is already used at `App.tsx:648` and `PropertyPanel.tsx:524` (multi-edge version `edgesSelectorFor` 91-136).
- **Candidate order:**
  1. Circle: `{kind:"circle", radius, onFace: <planar face>}`, then `{kind:"circle", radius}`.
  2. `between: [faceSel, faceSel]`, with and without `kind`.
  3. Line: `{kind:"line", direction, onFace, length}`, then `{kind:"line", direction, length}`.
  4. `onFace` with `longest` / `shortest`.
  5. `near: centroid` variants (fragile when the part changes).
- A candidate is accepted only if `selectEdges` (`src/kernel/selectors.ts:87-132`) returns exactly that one edge with no tie (79-82). Each candidate gets `body` when `e.body` is set.
- It refuses seams (52). `"other"` edges only get the `between`, `onFace` and `near` candidates.
- **Re-finding on rebuild uses the same mechanism as fillet and chamfer:**
  - `rebuild.ts:328-338`: `describePart(oc, s, bodies)` (`src/kernel/bodies.ts:62-69`, which labels bodies) then `selectTreatedEdges` (`ops.ts:321-332`), with `selectEdges` and `edgeSelectionError` (`selectors.ts:153-160`).
  - In the sketch case (`rebuild.ts:272-277`) the `bodies` map is in scope. `buildSketch(f)` (587) currently takes only `f`, so its signature must grow to `buildSketch(f, part?: DescribedPart)`, built only when the sketch has references.
- **Caveat 1: synthesize against the right history state.** The selector must be built against the topology at the sketch's position in the feature list, not the final part, or it may name an edge that doesn't exist yet or name a different one.
  - Option A: rebuild `features.slice(0, indexOf(sketch))`.
  - Option B: filter by face provenance. `RebuildResult.faceOrigins` exists with `{provenance:true}` (`rebuild.ts:77-78, 118-119`), but the worker's rebuild request does not ask for it. `LocalKernel.topology` (`src/ask/kernel.ts:90-94`) does.
  - `LocalKernel` caches a **single** result (`last`, 61, 75-83), so alternating a truncated doc with the full doc rebuilds every time. A second cache slot or a `KernelPort.topologyBefore(doc, featureId)` method is needed (`ask/kernel.ts:46-53`, `worker/client.ts:57-63`).
- **Caveat 2: body names and renames.** Body names inside a reference selector must join the body checks and renames:
  - `validate.ts:1544 selectorBodies` (consumed at 1504).
  - `commands.ts:496-552 renameBody` selector walker, which handles `f.face` and `f.edges` at 547-548 but not sketch entities.
  - Validation should reuse `validate.ts:832 validateEdgeSelector`.
- **Caveat 3: the rebuild will have to solve.** If an upstream parameter moves a referenced edge, sketch constraints tied to it no longer hold, and today `checkConstraints` would fail the sketch. `buildSketch` must:
  1. Re-project the reference entities.
  2. Run `solveSketch` using the stored geometry as the starting point.
  3. Build the profile from the solved entities.
  - Recommended: also return the solved entities in `SketchOverlay` (`rebuild.ts:58-62`), so the sketcher opens on current geometry.
  - An unresolved selector should fail the feature with the selector error, which matches the "never a guess" rule at `selectors.ts:1-2`. `FeatureStatus` has no warning channel for a "dangling" state.

### 2.5 Recommended data model
- Converted entities stay ordinary entities, so every existing constraint, dimension and profile path works unchanged.
- Add `ref?: { edge: EdgeSelector }` on `EntityBase`. It is orthogonal to `construction`: SOLIDWORKS converted edges are profile geometry unless made construction.
- **Dimension to a model edge without converting it:** Smart Dimension on a reference edge auto-creates a `construction:true` reference entity and dimensions to that. Existing forms then just work: the point-to-line form needs `line` to be a `"line"` (`validate.ts:596`), and concentric already accepts circle and arc (632).
- **UI changes:**
  - `projectEdges` returns structured records `{ edge: index, kind, a, b, center?, radius?, clockwise?, inPlane, poly: Vec2[] }`.
  - Add `SketchItem` `{kind:"edge", index}`.
  - Extend `itemAt` and `inferPoint` to snap to model vertices (`EdgeInfo` start/end) and edges.
  - Add a Convert Entities command in `SketchMode` that creates entities with `ref` set and inferred coincident relations.

---

## 3. Treating reference or fixed entities in the solver

**How it works now:** every number of every entity is an unknown (`layout` 56-68). The existing ways of "holding" geometry all add pin equations:
- `fix` constraint (285-298)
- `opts.fixed` for expression fields (397-408)
- drag pins (321-357)

**Recommendation: hold reference entities as constants in the layout, not as pinned unknowns.**
1. **Layout.** Add `Layout.consts: Map<string, Float64Array>`. `layout()` allocates no unknowns for entities with `ref`.
2. **One accessor.** Add `comp(l, "id.field", k): Fn` that returns `x => x[i+k]` or `() => const`. Replace the direct `l.at.get(...)` reads with it:
   - `pointOf` 82-87
   - `radiusOf` 104
   - rect distance 162
   - fix 287-296 (a reference entity is skipped; validation should refuse `fix` on one)
   - `dragEquations` 332-350: throw "this entity follows the model"
   - `anchorEquations` 370, 379-381
   - `opts.fixed` 399
   - `unpack` 74: copy the reference entity unchanged
   - `sketchStatus` 477-483: reference entities are never in `free`, so they draw black like SOLIDWORKS
3. **Effects:**
   - `freedom()` and the degree-of-freedom count are correct automatically.
   - `wouldOverDefine` (449) correctly refuses a relation between two reference entities, because the Jacobian row is zero and the rank is unchanged.
   - Newton keeps its minimum-norm "move the least" behaviour on the real unknowns.
   - `constraints.ts` needs no change, since it reads stored values.
4. **Why not pinned unknowns:** they work, but each reference scalar adds an unknown and an equation. The Jacobian is finite-difference (`jacobian` 510-524, 2n evaluations of all m functions), `gaussSolve` is O(m³), and `freeUnknowns` / `freedom` are O(m·n²). Converting a face outline of 50 edges adds about 200 of each.
5. **Optional smarter behaviour:** a `driven: true` dimension flag (excluded from `equations`, shown greyed with its measured value). `SketchMode.addConstraint` (136-142) could then offer "make driven" where it now refuses with "would over-define".

---

## 4. How profiles handle overlapping or trimmed geometry

`src/geom/profile.ts` has **no region detection**. Only closed loops of connected entities are accepted:
- **Construction entities are dropped** (35).
- **Closed primitives are standalone loops.** `circle`, `rect` and `slot` each become their own `Loop` and never join chains (40-48). A line ending on a rect corner is therefore a "touch" error.
- **Lines and arcs chain by endpoint.** `chain` (121-167) merges endpoints within `TOL = 1e-6` (11, 124-129).
  - Every node must have degree exactly 2. A dangling end throws "profile is open at …" (137-140). Three or more entities meeting (a T-junction) throws "each profile vertex must join exactly two entities" (142-144).
- **No crossing or touching is allowed anywhere.** `checkIntersections` (191-214) is O(N²) over all segments of all loops.
  - Any overlap throws (198-200).
  - Any intersection throws "profiles must not cross or touch" (207-211). The only exemption is the shared vertex between consecutive segments of the same loop (202-206).
- **Nesting is by winding number.** `nest` (302-323): even depth is an outer loop (made counter-clockwise), odd depth is a hole of its parent (made clockwise).
- **Every region is used.** `extrudeTool` / `profileFaces` (`ops.ts:83-102,163-186`) make one face per region and extrude all of them. There is no selected-contour or region pick.
- **Live feedback:** `SketchMode.tsx:286, 513-519` shows the profile error as you draw.

**What trim, extend, offset and fillet tools need:**
- **Intersections.** The primitives exist but are private: `intersect(Seg, Seg)` (216), `lineLine` (223, which also reports collinear overlap), `lineCircle` (250), `arcArc` (272) and `onArc` (292). Export them, plus an entity-level wrapper that uses `entityPolylines`-style `Seg`s with `seg.entity` back-links.
- **Trim and extend.** Split an entity at intersection parameters into new ids, write the points exactly, add coincident relations, and move or drop constraints with `removeEntities` (`sketch.ts:41`).
  - A rect or slot must first be exploded into lines and arcs. A "rect → 4 lines + relations" command is the clean route.
- **Sketch fillet.** Shorten two lines that meet, insert an `arc`, and add `tangent` ×2, coincident ×2 and a radius dimension. This fits the current chain model.
- **Offset.** Needs ordered chains, including open ones. `chain` is private and throws on open ends, so export a non-throwing `chains(segs) → {closed, open}`.
  - Offsetting a line or arc is analytic. Corners need extending or trimming, or new arcs.
  - `BRepOffsetAPI_MakeOffset` is in the bindings, but results would have to be converted back into entities.
- **Optional SOLIDWORKS-style "selected contours".** Build a planar arrangement: split all segments at all intersections, build a half-edge graph, take minimal faces.
  - Then `extrude`/`cut` gain `regions?: Vec2[]` (seed points), checked against `windingNumber` (326).
  - This would allow crossing sketches without trimming. Today they are rejected outright.