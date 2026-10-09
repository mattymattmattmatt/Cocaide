# Cocaide feature-op pipeline: how an op flows through the code (map for the SOLIDWORKS-class patch)

This was read-only; no files were edited. Line numbers are against HEAD `4de1139`.

## 0. Key facts and gotchas

- **Expressions are resolved before validation.**
  - `validateDocument` resolves the whole raw feature at `src/doc/validate.ts:224-226`, using `resolveExpressions` (`src/doc/parameters.ts:91-107`).
  - So validators, the kernel and the typed `Feature` only ever see numbers. The raw document and the UI keep the `"=expr"` strings.
  - Any numeric field of a new op, nested or not, supports expressions for free.
  - A string field whose value starts with `"="` would be parsed as an expression. Enum strings such as `"through"` are fine.
- **`apply()` is op-agnostic.**
  - It rejects a command only if it adds validation errors that were not there before (`src/doc/commands.ts:450-469`). Kernel failures do not block it.
  - The agent paths (`src/ask/agent.ts:335-336`, and the session) also reject an edit that makes a feature newly fail to rebuild.
- **The rebuild switch has no `default:`** (`src/kernel/rebuild.ts:271-491`). An op that validates but has no `case` falls through to `features.push({ok:true})` at line 492 and silently does nothing. TypeScript will not warn you.
- **Several op lists are typed `Record<string,…>` or `string[]`, so nothing forces them to be complete:**
  - `FEATURE_OPS` (`types.ts:318`)
  - `OP_LABEL` (`PropertyPanel.tsx:18`)
  - `OP_ICON` (`FeatureTree.tsx:12`)
- **A test asserts the exact `FEATURE_OPS` list.** `tests/document.test.ts:56` expects the message `unknown op "loft" (supported: sketch, extrude, …, deleteBody)`. It uses **"loft"** as its example of an unknown op, so adding a `loft` op means changing this test.
- **Open sketches fail.** `buildSketch` (`rebuild.ts:587-594`) throws when the profile is open or has a T-junction (`src/geom/profile.ts:140,144`). The sketch feature itself is then marked failed. Sweep paths, rib lines and revolve axis lines therefore need this relaxed (see §5.6).
- **Bug: mirror and split planes lose `xDir`.** `validatePlane` (`validate.ts:1267-1277`) accepts `xDir` only when `xDirAllowed` is set, and no caller sets it. Even when allowed, line 1276 returns `{type, normal, origin}` and drops `xDir`. Only `validateSketch` (`validate.ts:371-388`) keeps it.
- **No reference geometry exists.** Datum planes are written inline in each feature. There is no named reference plane, axis or point that other features can point to. Sketch-plane origins come from `PLANES` (`App.tsx:74-78`) or `sketchOnFace` (`App.tsx:379-386`, which never sets `xDir`).
- **The sketcher only shows model edges.** `projectEdges` (`App.tsx:1688-1702`, used at 1088) projects every model edge onto the sketch plane as a Float32Array backdrop. You cannot reference or dimension to these edges. This is where "reference edges / convert entities" would plug in.
- **Face picking is single-select.** `onPick` at `App.tsx:854-862` keeps only one face (`faces: [target.index]`), while edges are additive. Shell, draft and face-fillet need multi-face picking. There is also no `facesSelectorFor` in `synthesize.ts`.
- **Only planes and cylinders can be selected.** `faceInfo` (`src/kernel/topology.ts:68-122`) classifies faces as `plane | cylinder | cone | other`. `FaceSelector` has only `planar | cylindrical` (`types.ts:745-770`). `faceSelectorFor` refuses other face types (`synthesize.ts:38-39`). Faces made by revolve, sweep or loft cannot be selected until this is extended.
- **Seed lists are hardcoded.** "Patternable" ops are written as `["extrude","cut","hole","member"]` in four places instead of using `PATTERNABLE_OPS` (`types.ts:574`):
  - `App.tsx:664`
  - `App.tsx:703`
  - `PropertyPanel.tsx:138`
  - `PropertyPanel.tsx:544`
- **Many useful kernel primitives in `src/kernel/ops.ts` are private.** New ops will want them exported:

| Primitive | Line |
|---|---|
| `pnt` / `dir` / `vec` | 49-51 |
| `prism` | 104 |
| `compoundOf` | 119 |
| `boolean` | 131 |
| `unify` | 138 |
| `reachAlong` | 145 |
| `holeTool` | 289 |
| `cutHalfSpace` | 428 |
| `identity` | 604 |

---

## 1. One op, end to end (hole, fillet, linearPattern, mirror)

| Stage | hole | fillet / chamfer | linearPattern / circularPattern | mirror |
|---|---|---|---|---|
| Type, `types.ts` | `HoleFeature` 543-553 | `FilletFeature` 558-562, `ChamferFeature` 565-569 | `LinearPatternFeature` 580-589, `CircularPatternFeature` 596-602; `PATTERNABLE_OPS` 574 | `MirrorFeature` 689-697; `DERIVED_SUFFIX` 726 |
| Union and op list | `Feature` union 300-316, `FeatureOp` 317, `FEATURE_OPS` 318-336 | same | same | same |
| Validate dispatch | `validateFeature` 280-339 → `validateHole` 751-810 | → `validateEdgeTreatment` 814-830 (+ `validateEdgeSelector` 832-881) | → `validatePattern` 883-944 (+ `instanceCount` 946) | → `validateMirror` 1283-1309 (+ `validatePlane` 1267) |
| Body ledger | `BodyNames.check` 1448: `case "hole"` checks `bodies` exist (1457-1460) | via `selectorBodies` 1544-1560 (body names inside the edge selectors) | 1514-1520: copies of a `newBody` seed are named `seed_2…` | 1476-1482 `makes`, 1500-1503 `fresh`, 1507 `made.set` |
| `references()` | none | none | `feature` (`commands.ts:749`) | `feature` (749) |
| renameBody | `f.bodies` (537), `f.face` selector (545) | `f.edges` selectors (546) | copies renamed through `renamedBodies` 557-566 | 540 `newBody`; 571 `_mirror`; `implicitMaker` 583-597 |
| Scope `onlyBodies` | `scope.ts:194-196` | 197-201 | 215-219 (recurses into the seed) | 220-224 |
| Rebuild case | `rebuild.ts:302-326` | 327-341 | 342-351 (`repeat` 531-561) | 405-435 |
| Kernel ops | `drillTool` `ops.ts:260-283`, `holeTool` 289-316, `removeFrom` 215-242 | `selectTreatedEdges` 321-332, `treatEdges` 335-354 | `patternInstances` 359-386, `transformed` 388 | `mirrorTrsf` 538, `mergeMirror` 575, `transformed` |
| Side records | `drilled` / `holeBodies` (178-189); `HoleRecord` 83-97 | none | `h.copies +=` (349) | `copyHoles` (424), `h.copies += 1` (432), `copyMember` (419) |
| Selector health | `health.ts:32` | `health.ts:33-37` | none | none |
| UI create | `App.tsx:621-632` `hole()` | `App.tsx:644-651` `edgeFeature()` | `App.tsx:702-712` `patternFeature()` | `App.tsx:661-671` `mirrorTool()` |
| TOOLS map | `App.tsx:892` | 893-894 | 895-896 | 897 |
| Toolbar JSX | `App.tsx:1269` | 1270-1271 | 1272-1299 (`ToolMenu`) | 1301 |
| Context menu | face menu 987-995 ("Hole here") | edge menu 997-998 | none | none |
| Keybinding entry | `src/ui/input.ts:68` | 69-70 | 71-72 | 73 |
| Property editor | `HoleProps` `PropertyPanel.tsx:384-492` (wired at 124-125) | `EdgeTreatmentProps` 494-541 (127-129) | `PatternProps` 543-608 (130) | `MirrorProps` `BodyToolProps.tsx:63+` (131-141) |
| Label / icon | `OP_LABEL` 18-36 / `OP_ICON` `FeatureTree.tsx:12-30` | same | same | same + tree summary chip `FeatureTree.tsx:131` |
| Agent doc | `reference.ts:67-70` | 72-74 | 76-80 | 121-127 |
| Ask packet | `parentsOf` hole special case `packet.ts:413-417`; `featureMeasurements` 503-517 | generic | `bodyFeatures` 135 | none |
| Ask "add from face/edge" rule | `agent.ts:399-406` | 407-416 | refused | refused |
| Drawing | `drawingTargets` `drawing.ts:189` (`holes: ids("hole")`); `drafting/plan.ts:43-46` | none | none | none |

What happens when a field is edited in the UI:

1. The editor calls `update(patch)`.
2. That dispatches `{type:"updateFeature"}` (`PropertyPanel.tsx:72`).
3. `apply` merges the patch shallowly, and a `null` value deletes the field (`commands.ts:124-149`).
4. `validateDocument` runs before and after the change, and the command is rejected if it introduced errors.
5. The worker rebuilds and returns `RebuildView.features` (`FeatureStatus[]`).
6. `FeatureTree` and `PropertyPanel` show the status and any error.

---

## 2. Checklist: every place to touch for a brand-new op (the current architecture, without a registry)

Running example: an op `"x"` with interface `XFeature`.

**Document layer**

1. **`src/doc/types.ts`**
   - Add `export interface XFeature extends FeatureBase { op: "x"; … }`.
   - Add it to the `Feature` union (300-316) and to `FEATURE_OPS` (318-336).
   - If it can be patterned or mirrored, add it to `PATTERNABLE_OPS` (574).
   - If it derives body names, add a suffix to `DERIVED_SUFFIX` (726).
2. **`src/doc/validate.ts`**
   - (a) Import the type (8-56).
   - (b) Add `case "x": feature = validateX(raw, c, earlier, ctx)` in `validateFeature` (284-337).
   - (c) Write `validateX`:
     - Start with `c.keys(raw, "", [...allowed])`, which rejects unknown fields.
     - Use `c.num(raw, k, path, {positive|nonNegative})` (1619), `c.vec2`/`c.vec3` (1642/1646) and `c.unitVec` (1651).
     - Use `validateFaceSelector` (955) / `validateEdgeSelector` (832), `validatePlane` (1267), `bodyName` / `bodyList` / `optionalNewBody` (1399/1405/1279).
     - Check references to earlier features through `earlier: Map<id, op>`, following the pattern at 714-721 and 897-903.
     - Return `null` if `c.errors.length`.
   - (d) In `BodyNames.check` (1448-1528):
     - Bodies the op needs go in the first switch (1452-1472) or the second (1475-1499).
     - Names it makes go in `makes`, which is checked by `fresh` at 1500.
     - What it adds, consumes or deletes goes in 1509-1527. `this.made.set` (1513/1526) is needed if patterns or mirrors of it should derive `seed_2` / `seed_mirror`.
   - (e) Add its selectors to `selectorBodies` (1544-1560), so `body:` names inside selectors are checked.
   - (f) Use `FeatureContext` (97-105) if it needs profiles, nodes or members.
3. **`src/doc/commands.ts`**
   - (a) `references()` (746-755): every id the op points to (sketch, seed feature, reference plane or axis, and so on). This drives `dependants` (742), delete refusal (150-162), rename refusal (133-140), `orderProblem` on reorder (764-774), `scope.ts:43` and `parentsOf` (`packet.ts:411`).
   - (b) `renameBody` (496-550):
     - Fields called `bodies`, `face` and `edges` are already renamed for every op (537, 545-546). `body` is renamed only for extrude (532) and split (539).
     - Other body fields need a line, such as `target`, `tools`, a `faces` array of selectors, or `newBody` (see 536 and 540).
     - A seed that starts a body must be added to `seeds` at 507 **and** 559, and to `implicitMaker` (583-597) if the body name is derived.
   - (c) If the op names its body after its own id, update the `byId` check (146-147).
   - (d) `nodeUsers` (758-762) and `renameNode` (254-262) if it names nodes.
4. **`src/doc/scope.ts`**: `onlyBodies` (185-234), the `case` that says when a `body:<name>` scope covers the op. The default (231-232) returns `false`, which means the op can only be added under `"+"` or a referenced-feature token.
5. **`src/doc/parameters.ts`**: no change.
6. **`src/doc/drawing.ts`**: `drawingTargets` (181-192), only if it is a hole-like op that should get a drawing callout. Add it to `holes:` at 189 and record `HoleRecord`s in the rebuild.

**Kernel**

7. **`src/kernel/ops.ts`**
   - Write `xTool(oc, s, f, …)` or `applyX(...)`. It should throw `OpError` with a message an agent can act on.
   - Check the result with `isValidShape` / `volumeOf` (imported from `./measure`, line 29) and `countSubShapes`.
   - Use `fuseInto` (195) / `removeFrom` (215) for add and remove semantics. These already check that material really changed.
   - Export any private helpers it needs (listed in §0).
8. **`src/kernel/rebuild.ts`**:
   - (a) Import it (22-45).
   - (b) Add `case "x":` in the switch (271-491). The pattern:
     - `if (bodies.size === 0) throw new OpError(...)`.
     - `scoped((s) => { …; commit(changedMap, removedNames?); tools.set(raw.id, {tool: copyOut(tool), kind, into|newBody|bodies}) })`. Set `tools` only if the op can be a pattern or mirror seed.
   - (c) If it consumes a sketch: `const profile = profiles.get(raw.sketch); if (!profile) throw new OpError(\`${missing(raw.sketch,"sketch")}, …\`)`, as at 279-280.
   - (d) If it moves or copies bodies, keep the side ledgers in step: `memberBodies`, `copyMember`, `holeBodies`, `copyHoles` (171-189).
9. **`src/kernel/selectors.ts` / `synthesize.ts` / `topology.ts`**: only if it needs new selector kinds. Then also touch `validateFaceSelector` (`validate.ts:955-999`), `FaceSelector` (`types.ts:770`), `matchesFace` (`selectors.ts:41-53`), `describeWanted` (56-68), `faceSelectorFor` (`synthesize.ts:15-47`), and `selectOn` in `kernel/inspect.ts:85-99`.
10. **`src/agent/health.ts:31-37`**: add its selectors so `validate` reports how fragile they are.

**UI**

11. **`src/ui/PropertyPanel.tsx`**:
    - Add a label to `OP_LABEL` (18-36).
    - Add a line in the editor block (115-145), such as `{op === "x" && <XProps …/>}`.
    - Write `XProps` (see §5 for its props).
    - Editors receive raw `f` (it may hold expressions) for display and `resolved` / `before` for any arithmetic.
12. **`src/ui/FeatureTree.tsx`**: add the icon to `OP_ICON` (12-30). Optionally add a summary chip next to 123-139.
13. **`src/ui/icons.tsx`**: a new SVG entry in `ICONS`. `IconName = keyof typeof ICONS` (222), so this file must change for any new icon.
14. **`src/ui/App.tsx`**:
    - (a) A creation function next to 595-712. It uses `create(feature)` (305-311), `nextId(doc, prefix)` (`commands.ts:777`), `selection`, `view.faces` / `view.edges`, `faceSelectorFor` / `edgesSelectorFor`, `sketchFor()` (595-596), `pickedBody()` (656) and `setNotice`.
    - (b) Add it to the `TOOLS` map (884-903).
    - (c) Add toolbar JSX (1267-1322).
    - (d) Add context-menu entries: face 987-995, edge 997-998, and `featureItems` 945-970 (the "Edit sketch" entry is computed for extrude and cut only, at 951).
    - (e) Optionally a help line (1643).
    - (f) Update the hardcoded seed lists (664, 703) if it can be patterned.
15. **`src/ui/input.ts:65-78`**: add a `{ id: "tool.x", label, group: "Model tools", key: null }` entry so it can be key-bound and appears in the shortcut bar (`App.tsx:1575`).

**Agent**

16. **`src/mcp/reference.ts`**: add a section to `REFERENCE` (14-184). `ask/prompt.ts:160-161` builds it into `SYSTEM`, so both the MCP server and the in-app ask get it.
17. **`src/ask/packet.ts`**:
    - `bodyFeatures` (126-138), if the op belongs to one body.
    - The numeric keys list in `featureMeasurements` (506).
    - `parentsOf` (405-422), only for a face-based parent such as the hole's.
    - `featureKind` (68-70), only for a dedicated packet kind.
18. **`src/ask/agent.ts`**: the `addRule` branch (377-417), so a face or edge ask can add the op (otherwise line 416 refuses it). Also the `localMeasurements` keys (510).
19. **`src/ask/prompt.ts`**: optional chips in `chipsFor` for the face, edge or default branches (64-71, 72-78, 125-133).
20. **`src/agent/session.ts`**: no change. `addFeature` (222-231) is generic and makes an id from the op.

**Docs and tests**

21. The `README.md` "### Operations" table (675-693).
22. `tests/document.test.ts:56`, the exact op list.
23. Add tests next to `tests/phase-b-ops.test.ts` and `tests/multibody.test.ts`.

---

## 3. What is in scope inside a rebuild `switch` case (`src/kernel/rebuild.ts`)

Signature: `rebuild(input: unknown, oc: OC = getOC(), opts: RebuildOptions = {})` (104). All of these are closure variables of `rebuild()`:

| Name | Type | Line | Meaning |
|---|---|---|---|
| `oc` | `OC` (`OpenCascadeInstance`) | 104 | The OCCT WASM instance |
| `opts.provenance` | `boolean?` | 99-102 | Whether `faceOrigins` attribution is on |
| `v` | `ValidationResult` | 105 | `v.profiles`, `v.nodes`, `v.material`, `v.bodyMaterials`, `v.features[]` (`ValidatedFeature{index,id,op,feature,errors}`), `v.bodies`, `v.madeBodies` |
| `errors` | `string[]` | 106 | Accumulated `"<id>: msg"` strings |
| `features` | `FeatureStatus[]` | 107 | `{id, op, ok, suppressed?, error?}` (47-55) |
| `sketches` | `SketchOverlay[]` | 108 | Sketch polylines in world space, for display |
| **`bodies`** | `Map<string, TopoDS_Shape>` | 110 | Named solids, in insertion order (which is body order). Never mutate it directly; go through `commit` |
| `origins` | `Map<faceSignature, featureId>` | 113 | Provenance |
| `frame` | `Map<id, FrameMember>` | 165 | Placed members (filled by the pre-pass at 193-199) |
| `memberBodies` | `Map<body, MemberLine>` | 171 | Cut-list lines |
| `copyMember(s, from, to, steps, id?)` | fn | 173-176 | Carries a member line through transforms |
| `drilled` | `HoleRecord[]` | 178 | Hole callouts (`HoleRecord` 83-97) |
| `holeBodies` / `holesIn(names)` / `copyHoles(map)` | | 180-189 | Which body each hole is in |
| `joints`, `shapes` (`frameEnds` result: `.ends`, `.errors`, `.shaped`), `checks` | | 200-203 | Weldment joints |
| **`profiles`** | `Map<sketchId, SketchProfile \| null>` | 205 | `SketchProfile = {frame: Frame, regions: Region[], area}` (`ops.ts:38-43`); null means failed or suppressed |
| **`tools`** | `Map<featureId, Seed>` | 207 | Seeds for patterns and mirrors: `{tool, kind:"fuse"\|"cut", into?, newBody?, bodies?, member?}` (565-576). Store with `copyOut`; disposed at 506 or in the catch at 497-501 |
| `suppressed` | `Set<id>` | 208 | |
| `missing(id, what)` | fn | 209-210 | Builds `"sketch "s1" is suppressed/failed"` |
| **`need(name)`** | fn → shape | 211-215 | Gets a body or throws `OpError` |
| **`targets(listed?)`** | fn → `[name, shape][]` | 217 | The listed bodies, or all of them |
| **`commit(changed: Map<name,shape>, removed?: string[])`** | fn | 223-251 | All-or-nothing. Checks every changed body has a solid and volume > 1e-9 (226-231), copies the shapes out of the scope (232), replaces or adds bodies (233-236), deletes `removed` (237-240), then when `opts.provenance` is on, attributes new face signatures to `current` (241-250) |
| `current` | `string` | 252, set at 270 | The feature being built, for provenance |
| `raw` | narrowed `Feature` | 255 | Typed, with expressions resolved |
| `op`, `vf` | `string`, `ValidatedFeature` | 256 | |
| `repeat(s, instances, seed, nameOf, what?)` | hoisted fn | 531-561 | Applies a seed under transforms, with fuse/cut/new-body semantics, and returns `[changedMap]` for `commit(...)` |
| `scoped`, `Scope` | `kernel/oc.ts:63-91` | | `scoped((s)=>…)`. Every OCCT object goes through `s.track()` and is deleted at scope end. Keep a shape beyond the scope only via `copyOut` (`ops.ts:616`) |

Other rules inside a case:

- **Errors.** Throw `OpError` (`ops.ts:35`). A message can span several lines, and each line gets the `id:` prefix (494-495). Any other exception becomes `"kernel error: …"` through `kernelMessage` (611-619). A failed op leaves the bodies untouched, because only `commit` writes to them.
- **Selecting topology.**
  - Faces only: `describePart(oc, s, bodies, false)`.
  - Faces and edges: `describePart(oc, s, bodies)` (`kernel/bodies.ts:153-160`). It returns `DescribedPart {shape, faces, faceInfos, edges, edgeInfos, ranges}`.
  - Indices are global across bodies, and `ranges[i].faces/edges` are `[start,end)` per body. Fillet maps chosen edge indices back to bodies at 334-337.
  - Then call `selectFaces(part.faceInfos, sel)` + `selectionError(sel, r, wanted)`, or `selectEdges(part.edgeInfos, part.faceInfos, sel, path)` + `edgeSelectionError` (`selectors.ts:27, 71, 87, 153`).
- **Provenance.** Faces are attributed only through `commit` → `faceSignature` (`topology.ts:234-246`). Planes and cylinders get exact signatures. Cones and "other" faces (torus, sphere, B-spline) are keyed by centroid rounded to 1e-2, so revolve, sweep and loft faces get weaker attribution. `RebuildResult.faceOrigins` is computed in `result()` (118-119); `LocalKernel.topology` exposes it (`ask/kernel.ts:93`).
- **Result plumbing.** `RebuildResult` (64-80) goes to the worker's `RebuildView` (`worker/kernel.worker.ts:67-78`, type in `worker/protocol.ts:14-27`). Any new output, such as reference geometry for display, has to be added in all three places.

---

## 4. Datum planes and sketch frames

**Type.** `DatumPlane { type: "datum"; normal: Vec3; origin: Vec3; xDir?: Vec3 }` (`src/doc/types.ts:362-367`).

Where it is used:
- `SketchFeature.plane` (371)
- `MirrorFeature.plane` (691)
- `SplitFeature.plane` (703)

Axes elsewhere are written ad hoc as `{origin, direction}`: `CircularPatternFeature.axis` (599) and `MoveFeature.rotate.axis` (712).

**Validation.**
- Sketch: `validateSketch` (`validate.ts:371-388`). It keeps `xDir` and rejects an `xDir` parallel to the normal.
- Mirror and split: `validatePlane` (1267-1277), which drops `xDir` (the bug in §0).

**Frame math: `src/geom/frame.ts`**

- `interface Frame { origin; x; y; z }` (7-13)
- `planeFrame(normal, origin, xDir?)` (20-26):
  - `z = normalize(normal)`
  - `ref = xDir ?? (|z.x| < 1-1e-9 ? [1,0,0] : [0,1,0])`
  - `x = normalize(ref − z·(ref·z))`
  - `y = z × x` (right-handed)
- `facePlaneFrame(normal, pointOnPlane)` (29-33): the origin is the global origin projected onto the plane. Hole `center` uses this frame (`ops.ts:267-268`, `App.tsx:628-629`).
- `to3D(frame, p2)` (35-37) and `to2D(frame, p3)` (39-42).

**Consumers.**
- `rebuild.ts` `buildSketch` (587-594) and `overlay` (596-605).
- `ops.ts` `loopWire` / `profileFaces` (53-102): they use `gp_Ax3(origin, z, x)`.
- `App.tsx`: `projectEdges` (1688-1702) and the cut-direction heuristic (610).
- `mirrorTrsf` (`ops.ts:538`): uses only normal and origin.
- `splitBody` (585): uses only normal and origin.

**Plane sources in the UI.**
- `PLANES` (`App.tsx:74-78`):
  - Top `[0,0,1]`
  - Front `[0,-1,0]`
  - Right `[1,0,0]`
  - All at the origin, with no `xDir`.
- `sketchOnFace` (379-386): `origin = n·offset` and rounded with `round9`.
- `PlaneFields` editor (`BodyToolProps.tsx:18-30`).
- `planeName` (`PropertyPanel.tsx:322-329`).

**Recommendation for reference geometry** (needed for the user's "reference edges and dimension to them").
- Add ops `plane`, `axis`, `point` (and a `coordinateSystem` later) that make no body.
- Give rebuild a new `datums: Map<id, {kind, origin, normal?, xDir?, direction?}>`.
- Let `SketchFeature.plane` (and mirror, split, pattern axis) take `{ type: "ref", ref: "plane_1" }` in addition to the inline `DatumPlane`.
- Resolve references in rebuild before `planeFrame`, and list them in `references()`.
- Send `datums` to the UI through `RebuildResult` → `RebuildView`, for drawing and picking.
- Plane definitions worth supporting:
  - offset from a plane or face selector
  - through three points
  - at an angle about an axis
  - normal to an edge at a point
  - mid-plane of two faces
- Validation of a `ref` must check that the reference is an earlier `plane` op, using `earlier` the way 714-721 does.

---

## 5. Recommended registry design: new ops in their own files, existing ops untouched

### 5.1 Layout (three layers, matching the bundle and thread boundaries)

```
src/features/
  defs.ts            // FeatureDef interface + DEF registry (doc layer; no OCCT values, no React)
  kernelDefs.ts      // KernelOp interface + KERNEL_OPS (imported only by kernel/rebuild.ts)
  uiDefs.tsx         // UiOp interface + UI_OPS (imported only by ui/*)
  revolve/doc.ts  revolve/kernel.ts  revolve/ui.tsx
  shell/doc.ts    shell/kernel.ts    shell/ui.tsx   ...
```

- `defs.ts` collects `import { def as revolve } from "./revolve/doc"` and exports `DEF: Record<string, FeatureDef>`. The kernel and UI layers do the same.
- The doc-layer files may import `Checker`, `validateFaceSelector`, `bodyList` and the rest from `doc/validate.ts`, but must use them only inside function bodies. The import cycle is safe at runtime because nothing calls them at module top level. The repo already relies on this: `doc/drawing.ts` ↔ `validate.ts`.
- Optionally, move `Checker`, `isObject`, `describe`, `bodyName`, `bodyList`, `optionalNewBody` and `validatePlane` into a new `src/doc/check.ts` and re-export them from `validate.ts`. That removes the cycle outright. Fix `validatePlane`'s `xDir` handling while doing it.

### 5.2 `FeatureDef` (doc layer)

```ts
export interface FeatureDef<F extends { id: string; op: string } = any> {
  op: string;
  validate(raw: Record<string, unknown>, c: Checker, x: { earlier: Map<string,string>; ctx: FeatureContext }): F | null;
  references?(raw: Record<string, unknown>): string[];               // commands.references
  bodies?: {                                                         // BodyNames.check
    needs?(f: F): [path: string, name: string][];
    makes?(f: F, made: ReadonlyMap<string,string>): { names: string[]; path: string };
    consumes?(f: F, existing: string[]): string[];                   // deleted/merged away
    seedBody?(f: F): string | undefined;                             // sets this.made (pattern/mirror copies)
  };
  selectors?(f: F): { path: string; face?: FaceSelector; edge?: EdgeSelector }[]; // selectorBodies + health
  renameBodies?(raw: Record<string,unknown>, rename: (n: unknown) => unknown): Record<string,unknown>; // non-standard fields
  onlyBodies?(raw: Record<string,unknown>, inScope: (n: unknown)=>boolean, doc: RawDocument): boolean;
  patternable?: boolean;
  measurementKeys?: string[];                                        // packet + agent localMeasurements
  askFrom?(f: Record<string,unknown>, t: {kind:"face"|"edge"; index:number}, k: {select(sel:unknown):Promise<SelectResult>; topo():Promise<PartTopology|null>}): Promise<string|null>;
  reference: string;                                                 // markdown section for REFERENCE
}
```

### 5.3 Hooks to add to the shared files (each a few lines; existing `case`s stay as they are)

| File:line | Hook |
|---|---|
| `types.ts:300-316, 318-336` | `export type Feature = …existing… \| PluginFeature`, where `PluginFeature` is a union re-exported from `src/features/types.ts` (type-only imports from each `<op>/doc.ts`). `FEATURE_OPS = [...existing, ...PLUGIN_OPS]`. Literal narrowing on existing ops keeps working because the new `op` strings are disjoint. |
| `validate.ts:333-335` `default:` | `const d = DEF[raw.op as string]; if (d) { feature = d.validate(raw, c, {earlier, ctx}); break; }` and only then the unknown-op failure. |
| `validate.ts:1500` (before the `fresh` block) | `const d = DEF[f.op]; if (d?.bodies) { d.bodies.needs?.(f).forEach(([p,n]) => need(n,p)); const m = d.bodies.makes?.(f, this.made); if (m) { makes = m.names; /* fresh() path = m.path */ } }`. After 1527: apply `consumes` (delete names), `seedBody` (`this.made.set`), and add `makes`. |
| `validate.ts:1558` | In `selectorBodies`: `DEF[f.op]?.selectors?.(f).forEach(s => s.face ? face(s.face, s.path) : edge(s.edge!, s.path))`. |
| `validate.ts:903, 1293` | Patternable check becomes `PATTERNABLE_OPS.includes(op) \|\| DEF[op]?.patternable`. |
| `commands.ts:754` | `refs.push(...(DEF[String(f.op)]?.references?.(f) ?? []))`. |
| `commands.ts:546` (end of the loop body) | `const d = DEF[String(f.op)]; if (d?.renameBodies) Object.assign(f, d.renameBodies(f, rename));`. Extend `seeds` at 507 and 559 with `DEF[op]?.bodies?.seedBody`. |
| `scope.ts:231` `default:` | `return DEF[String(f.op)]?.onlyBodies?.(f, inScope, doc) ?? false;` |
| `packet.ts:135` | `else if (DEF[String(f.op)]?.onlyBodies?.(f, (n)=>n===name, doc)) ids.add(id);`. At 506, key list = base keys ∪ `DEF[op]?.measurementKeys`. |
| `agent.ts:416` | `const d = DEF[String(f.op)]; if (d?.askFrom) return d.askFrom(rf, t, {select:…, topo:…});` before the refusal. At 510, add `measurementKeys`. |
| `health.ts:37` | `else if (DEF[f.op]?.selectors) selectors = DEF[f.op].selectors(f);` |
| `reference.ts:156` (before "## Face selectors") | `${Object.values(DEF).map(d => d.reference).join("\n")}`. `REFERENCE` is a template literal; the import adds no OCCT dependency. |
| `rebuild.ts:490` | `default: { const k = KERNEL_OPS[raw.op]; if (!k) throw new OpError(\`no kernel for op "${raw.op}"\`); k.run(ctx, raw); }` This also closes the silent no-op gap. |
| `PropertyPanel.tsx:36, 144` | `OP_LABEL` spreads `...Object.fromEntries(Object.values(UI_OPS).map(u => [u.op, u.label]))`. In the body: `{UI_OPS[op] && createElement(UI_OPS[op].Editor, editorProps)}`. |
| `FeatureTree.tsx:30, 139` | Spread icons into `OP_ICON`. `{UI_OPS[op]?.summary && <span className="feature-body">{UI_OPS[op].summary!(f)}</span>}`. |
| `App.tsx:902` | `...Object.fromEntries(Object.values(UI_OPS).flatMap(u => u.tools ?? []).map(t => [t.id, { icon: t.icon, label: t.label, run: () => t.run(toolCtx), disabled: t.disabled?.(toolCtx) }]))`. Toolbar at 1321: render `UI_OPS` tools grouped by `t.group` with `ToolButton` / `ToolMenu` (`ui/tools.tsx:19,30`). Context menu 990/998: append the tools whose `contextOn` is `"face"` / `"edge"`. At 951: `sketchId` also from `UI_OPS[op]?.sketchOf?.(f)`. |
| `input.ts:78` | Spread `{id, label, group: "Model tools", key: null}` from registry tools. |
| `icons.tsx` | Either add the icons here in one batch, or widen `Icon` to accept `IconName \| ReactNode` so op files carry their own SVG. |

### 5.4 `KernelOp` and the context object built in `rebuild()` (add it after line 252)

```ts
export interface RebuildCtx {
  oc: OC; v: ValidationResult; opts: RebuildOptions;
  bodies: ReadonlyMap<string, TopoDS_Shape>;
  need(name: string): TopoDS_Shape; targets(listed?: string[] | null): [string, TopoDS_Shape][];
  commit(changed: Map<string, TopoDS_Shape>, removed?: string[]): void;
  profiles: ReadonlyMap<string, SketchProfile | null>; missing(id: string, what: string): string;
  setSeed(id: string, seed: Seed): void;          // tools.set(id, {...seed, tool: copyOut(seed.tool)})
  repeat: typeof repeat;                           // for pattern-like ops (e.g. curve-driven, fill, sketch-driven patterns)
  holes: { record(h: HoleRecord, bodies: Iterable<string>): void; inBodies(names: string[]): HoleRecord[]; copied(map: Map<string,string>): void };
  members: { copy: typeof copyMember; drop(name: string): void };
  datums: Map<string, Datum>;                      // new: reference geometry
  sketch(id: string): SketchFeature | undefined;   // raw entities for open paths (sweep path, rib)
}
export interface KernelOp<F = any> { op: string; run(ctx: RebuildCtx, f: F): void }
```

`Seed`, `MemberLine` and `HoleRecord` are currently internal to `rebuild.ts` (565-585) and need to be exported. A handler should call `scoped((s) => …)` itself and finish through `ctx.commit`, so provenance, validity checks and all-or-nothing behaviour come for free.

### 5.5 `UiOp` (UI layer)

```ts
export interface EditorProps {
  f: Raw; resolved: Raw; before: Raw[]; bodies: string[]; doc: RawDocument;
  view: RebuildView | null; selection: Selection;
  update(p: Raw): string | null | void; rename(from: string, to: string): unknown; setError(e: string | null): void;
}
export interface ToolCtx {
  doc: RawDocument; view: RebuildView | null; selection: Selection; selected?: Raw; resolved: Raw[];
  create(feature: Raw): void; notice(text: string, kind?: "info"|"error"): void;
  nextId(prefix: string): string; bodies(): string[]; pickedBody(): string | undefined; sketchFor(): Raw | undefined;
}
export interface UiOp {
  op: string; label: string; icon: IconName;
  Editor: (p: EditorProps) => JSX.Element;
  summary?(f: Raw): string;
  sketchOf?(f: Raw): string | null;
  tools?: { id: `tool.${string}`; label: string; icon: IconName; group?: string; contextOn?: "face"|"edge"; run(c: ToolCtx): void; disabled?(c: ToolCtx): string|undefined }[];
}
```

All of the `EditorProps` values already exist in `PropertyPanel` at 60-87. `ToolCtx` is built in `App` from existing values: `create` (305), `sketchFor` (595), `pickedBody` (656), `selection` and `view`. Reuse the shared field widgets from `fields.tsx` (`Field`, `NumberInput`, which takes expressions, `Vec3Input`, `DirectionInput`, `Select`, `TextInput`) and the `BodyChecks` / `NewBodyName` / `PlaneFields` helpers from `BodyToolProps.tsx` (18-61, currently not exported).

### 5.6 Shared prerequisites worth doing once, early in the patch

1. **Open and mixed sketches.** In the `case "sketch"` (`rebuild.ts:272-277`), stop failing the sketch when `buildProfile` reports an open chain. Store `{frame, regions: [], area: 0, open: msg}`, keep the raw entities for path consumers, and let `extrudeTool`'s existing "has no closed profile" error (`ops.ts:164`) report it.
   - Separately, add an open-path builder in `geom/profile.ts` for sweep paths and ribs. `chain()` currently throws at lines 140 and 144.
2. **Multi-face selection.** Make face picks additive in `App.tsx:854-862`, and add `facesSelectorFor` to `synthesize.ts` (a sibling of `edgesSelectorFor` at 91-136).
3. **More face types in selectors.** Add `cone`, `sphere`, `torus` and `bspline` to `FaceInfo` (`topology.ts:23-39, 120`), and `conical` / `spherical` / `toroidal` / `any` (with `near`) to `FaceSelector` across validate, selectors and synthesize.
4. **Export the private kernel primitives** in `ops.ts` (listed in §0).
5. **Shared validator helpers** to export from `validate.ts`:
   - `earlierOfOp(raw, key, c, earlier, ops[])`, generalising 714-721.
   - `validateAxis`, for `{origin, direction}`, used at 927-935 and 1333-1340.
   - Fix `validatePlane` to accept and return `xDir`, and to accept `{type:"ref"}`.
6. **Datums.** Reference planes, axes and points as no-body ops (§4) give the sketcher real reference edges and points to dimension to. Through `RebuildView` they also become something the sketcher can pick, in place of today's display-only `projectEdges` backdrop.

With these hooks in place, a new op touches **zero existing `case` bodies**. Each op adds three files plus one line in each of the three index files, plus its icon, a README table row and tests. The edits to shared files happen once: the hooks listed in §5.3.