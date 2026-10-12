# Phase O — API notes (what exists now; read the files named, they are well commented)

Updated by the coordinator after each wave. Read this after DESIGN.md.

## Wave 0 (merged)

### Feature-op registry (document + kernel + UI)
A new op `foo` is three files plus index lines. The example to copy is `scale`:
`src/features/scale/doc.ts` and `src/features/scale/kernel.ts`.

- `src/features/foo/doc.ts` exports `def: FeatureDef<FooFeature>` (interface in `src/features/defs.ts`).
  `validate(raw, c, x)` starts with `c.keys(raw, "", [...allowed])`; `c` is the Checker (`c.num`, `c.fail`, `c.errors`,
  ...), `x` the ValidateKit (`x.datumRef(v, path, want)`, `x.plane`, `x.faceSelectors`, `x.edgeSelectors`, `x.sketch`,
  `x.feature(v, path, ops, what)`, `x.bodyList`, `x.oneOf`, `x.bool`, `x.direction`, `x.earlier` …). Other hooks:
  `references`, `datumRefs` (use `datumRefsAt(raw, "axis", ...)` from `src/features/datum.ts`), `bodies` (needs/makes/
  problems/consumes/seedBody), `selectors`, `renameBodies`, `onlyBodies`, `patternable`, `measurementKeys`,
  `bodyFromId`, `askFrom`, and `reference` (markdown "## foo" section the agent reads; appended to REFERENCE).
  The doc layer may only `import type` from src/doc, src/kernel, src/ui, src/ask (tests/registry.test.ts enforces it).
  The typed feature union picks the new type up automatically (`src/features/types.ts` derives PluginFeature).
- `src/features/foo/kernel.ts` exports `kernel: KernelOp<FooFeature>` with `run(ctx: RebuildCtx, f)`
  (interface in `src/features/kernelDefs.ts`): build inside `scoped((s) => ...)`, finish with `ctx.commit(changed, removed?)`
  (once, last), or for shape-making ops with the operation fields use `applyOperation(ctx, s, f, tool, "revolve")`
  from `src/kernel/operation.ts` (it commits and sets the seed). Throw `OpError("what to fix")` to fail.
  `ctx.profile(sketchId, "revolve")` gives a closed SketchProfile (with `.frame`), `ctx.profiles.get(id)` any (open ones
  have `open` set), `ctx.sketch(id)` the typed SketchFeature (entities), `ctx.datums` (Map id → Datum frames; plane/axis/
  point ops put theirs here), `ctx.part(s, withEdges)` for selectFaces/selectEdges, `ctx.shapeOf`, `ctx.need`,
  `ctx.targets`, `ctx.seed`/`ctx.setSeed`/`ctx.repeat` (patterns), `ctx.holes`, `ctx.members`.
  Kernel primitives are exported from `src/kernel/ops.ts` (pnt, dir, vec, identity, transformed, prism, fuseInto,
  removeFrom, commonWith, compoundOf, VOLUME_EPS …) and `src/kernel/measure.ts` (volumeOf, centroidOf, isValidShape).
- Operation fields (DESIGN §2.5): `src/features/operation.ts` (`OperationFields`, `OPERATION_KEYS`,
  `validateOperation(raw, c, x)`, body hooks helper) and `src/kernel/operation.ts` (`applyOperation`).
- DatumRef: type in `src/doc/types.ts` (`DatumRef`, `RefPlane`, `PlaneSpec = DatumPlane | RefPlane`, `EdgePoint`);
  pure helpers in `src/features/datum.ts` (`DEFAULT_DATUMS`, `DATUM_OPS = {plane, axis, point}`, `possibleKinds`,
  `datumRefsAt`, `featureDatumRefs` — which already lists the fields DESIGN §2.4/§2.6 will add: sketch entity `ref`,
  extrude `upTo`/`direction2.upTo`, linearPattern `along`, circularPattern `axis.ref` — `refPlaneFrame`, `facePlane`,
  `frameAsDatumPlane`, `xDirProblem`). Kernel resolver `src/kernel/datum.ts`: `resolveDatum(ctx, ref, "plane"|"axis"|
  "point"|"any", path)` → `{kind:"plane",origin,normal,xDir} | {kind:"axis",origin,direction} | {kind:"point",at}`;
  `planeSpecFrame(ctx, spec, path)` → Frame. Reserved ids: Front, Top, Right, Origin, X, Y, Z.
- Sketch placement: `SketchFeature.plane` is `PlaneSpec`; the rebuild resolves it; `RebuildResult.sketches[i].frame`
  is the resolved frame; `RebuildResult.datums` lists the reference geometry by feature id. Open sketches build
  (overlay `open` says why), and ops that need a closed profile say so.
- UI op: `src/features/foo/ui.tsx` exports `ui: UiOp` (`src/features/uiDefs.tsx`): `label`, `icon`, `fields: FieldSpec[]`
  (declarative editor rendered by `src/ui/props/FeatureForm.tsx`; kinds in `src/ui/props/spec.ts`: number, select,
  bool, vec3, direction, plane (with `refs`), datumRef (`accepts`), faces, edges, face, feature, features, sketch,
  sketchLine, bodies, custom) or an `Editor` component; `summary(f)` (tree chip); `sketchOf(f)` ("Edit sketch").
  Examples: `src/features/linearPattern/ui.tsx`, `src/features/fillet/ui.tsx`.
- Index files (append whole lines only — union merge): `src/features/docIndex.ts`, `kernelIndex.ts`, `uiIndex.ts`.

### Model tools (CommandManager)
- `ToolDef` and `ToolCtx` in `src/ui/model/ToolContext.ts`; tools in `src/ui/model/tools/<group>.ts` exporting
  `tools: ToolDef[]`, listed in `src/ui/model/tools/index.ts` (append an import line and a LISTS line).
  Tabs in `src/ui/model/tabs.ts`: features (groups shape, dress, pattern), reference (datum), bodies, weldments,
  evaluate (measure, view); "pinned" sits left. A ToolDef: `id: "tool.x"` (must exist in COMMANDS, src/ui/input.ts —
  W0 already added tool.revolve/sweep/loft/shell/draft/rib/scale/plane/axis/point/measure/section/sketchPattern and
  the sketch.* commands for later waves), `label`, `icon`, `tab`, `group`, `menu?` (shared dropdown), `items?(ctx)`,
  `title`, `testId` (`tool-<kebab>`), `disabled?(ctx)`, `run(ctx)`, `contextOn?` ("face" | "edge" | "part"),
  `contextLabel`, `contextWhen`. `ctx.create(feature)` adds + selects + opens properties.
- Selection: `src/ui/model/selection.ts` (`Selection {faces, edges, point?}`, `pickInto` with Ctrl/Shift additive).
  Selectors from a selection: `faceSelectorFor`, `facesSelectorFor`, `edgeSelectorFor`, `edgesSelectorFor` in
  `src/kernel/synthesize.ts`; DatumRefs from a selection: `src/ui/props/datumRef.ts` (it re-declares DatumRef and the
  default list locally — W1 dedupes it onto src/doc/types.ts + src/features/datum.ts).
- Icons: `src/ui/icons.tsx` already has (W0) revolve, sweep, loft, shell, draft, rib, scaleBody, plane, axis,
  datumPoint, measure, section, sketchPattern, centerline, point, rectCenter, rect3, parallelogram, polygon, arc3,
  tangentArc, circle3, slotCenter, ellipse, spline, trim, extend, splitEntity, sketchFillet, sketchChamfer, offset,
  mirrorEntities, linearSketchPattern, circularSketchPattern, moveEntities, rotateEntities, scaleEntities,
  copyEntities, convertEntities, fullyDefine, displayStyle, wireframe, hiddenLines, shadedEdges, zoomSelection.
  Check `grep -n "name:" src/ui/icons.tsx` style before adding; append new icons only.
- e2e: tools now sit on tabs: click `tab-<name>` (e.g. `tab-bodies`) before a tool there; see
  e2e/command-manager.spec.ts.

## Wave 1 (merged): reference geometry + sketch tool registry

Ops (DESIGN §2.2):
- `plane`: { mode: offset|angle|threePoints|midplane|normalToEdge|parallelThroughPoint, refs, distance?, angle?, t?, flip? }
- `axis`: { mode: twoPoints|edge|cylinder|twoPlanes|pointNormal, refs }
- `point`: { mode: coords|center|intersection|onEdge, refs?, at?, t? }
- Mode specs: PLANE_MODE_SPECS / AXIS_* / POINT_* in src/features/<op>/doc.ts, checked with checkModeRefs.
- Pure constructions in src/features/datum.ts: offsetPlane, anglePlane (right-handed about the axis), threePointPlane, midPlane, planesLine, axisPlanePoint, twoPointAxis, flipPlane, throughPointPlane, planeDatum.
- Kernel: edgePlace(ctx, sel, path, {t}|{near}), findFace and findEdge in src/kernel/datum.ts. RebuildResult.datums, RebuildView.datums and CheckResult.datums hold the plane/axis/point features by id.

UI:
- Selection (src/ui/model/selection.ts) gains `vertices?: {edge, at: "start"|"end"}[]` and `datums?: string[]`. PickTarget adds {kind: "vertex"} and {kind: "datum", id}. Helpers: only, isSelected, selectionSize, datumKindOf, describeDatum, DEFAULT_DATUM_LABEL.
- ToolDef gains contextItems(ctx, target) (own right-click entries) and direct(ctx) (run instead of opening the dropdown). ContextTarget adds vertex and datum. Registry: contextEntries(ctx, target).
- ToolCtx.startSketch now takes a PlaneSpec.
- src/ui/model/sketchPlane.ts: planeOfRef, planeSpecFrameIn(spec, view), sketchFrameIn(sketch, view), sketchNormal, planeChoices. Use these instead of reading sketch.plane.normal.
- src/ui/model/tools/sketch.ts: PLANES (now ref specs), onPlane(id), facePlaneSpec, sketchTarget.
- src/ui/model/datumDisplay.ts: planeRect, axisEnds, datumShapes, DatumView {shown, planes}, datumVisible, eyeOpen, toggleEye, setShown, parseDatumView, useDatumView (localStorage key cocaide.datumView.v1).
- src/ui/props/datumRef.ts exports DEFAULT_CHOICES (replaces its old DEFAULT_DATUMS list).
- Command view.planes (no key). tool.plane, tool.axis and tool.point are no longer planned.
- e2e hook window.__cocaideViewport gains datums() and datumPoint(id).

Test ids:
- Tree: datum-Front, datum-Top, datum-Right, datum-Origin; eyes datum-eye-<id>.
- View toggle: view-planes. Properties: prop-datum-where, prop-sketch-plane, prop-sketch-where.
- Sketch menu: plane-<featureId>, plane-selected-face.
- Right-click: ctx-sketch-plane, ctx-plane-face, ctx-plane-edge, ctx-plane-offset, ctx-axis-cylinder, ctx-axis-edge, ctx-point-vertex, ctx-point-center, ctx-datum-toggle.

AI: the part packet has part.referenceGeometry {defaults, features: [{id, op, mode, kind, origin/normal/xDir | origin/direction | at} or {built: false, ...}]}.

- `switchMode(f, mode, modes, before, defaults?, picked?: { selection, view })` in src/ui/props/datumModes.ts may now throw an Error whose message is meant for the user.
- A FieldSpec's `set` may throw the same way; FeatureForm shows the message as the panel error (testid `command-error`).
- Reference-tool contextItems act on the right-click target only, not on the selection.

Sketch tool registry (DESIGN §1.3, §2.7). All paths are under src/ui/sketcher/tools/.

**types.ts**
- `SketchToolDef { id: "sketch.x" (its COMMANDS id), name (test ids tool-<name>, flyout-<name>, bar-<name>, ctx-tool-<name>), label, icon: IconName, title, flyout?: FlyoutDef{id,label}, clicks, prompts[], chain?, options?: ToolOption[], accept?(click, i, ctx), alignTo?(pts), snap?(pts, p, tol, options), preview?(clicks, options, ids, ctx), build(clicks, options, ids, ctx): Built | null }`
- `Click { p: Vec2; ref: string | null; on?: {type: "midpoint" | "pointOn"; entity}; orient?: "horizontal" | "vertical" }`
- `Built { entities, relations (always kept), roles: ClickRole[], inferred?, next? }`
- `ClickRole = {point} | {on} | {middle} | null`
- `ToolContext { entities, trail?, px? }`
- `IdMaker = (prefix) => id`

**index.ts**
- `SKETCH_TOOLS`. Append-only: add one import line and one LISTS line per module.

**run.ts** (pure)
- `toolByName(name)`
- `toolbarEntries()` → `{kind:"tool"} | {kind:"flyout", flyout, tools}`
- `optionValues(def, stored)`
- `idMaker(entities)`, `previewIds()`
- `snapClick(def, pts, p, {entities, tol, grid, options}): Click`
- `clickRelations(roles, clicks)`
- `place(def, clicks, options, ctx, construction?): Placement {entities, relations, inferred, next?, first} | null`
- `previewOf(def, clicks, options, ctx, construction?)`

**memory.ts**
- `loadMemory`, `saveMemory` (localStorage key `cocaide.sketchTools.v1`), `flyoutChoice(memory, flyoutId, tools)`, `remember(memory, tool)`.

**Other exports**
- shapes.ts: `line`, `closedLoop`, `circumcircle`, `orientOf`, `oriented`, `turning`, `asConstruction`, `EPS`.
- arcs.ts: `tangentStart(click, entities)`.
- polygon.ts: `polygonCorners(c, q, options)`, `MIN_SIDES` (3), `MAX_SIDES` (40).

**Tool names and their COMMANDS ids/keys**
- line (sketch.line, L)
- centerline (sketch.centerline, Shift+L)
- midpoint-line (sketch.midpointLine)
- rect (sketch.rect, R)
- rect-center (sketch.rectCenter, Shift+R)
- rect3 (sketch.rect3)
- parallelogram (sketch.parallelogram)
- circle (sketch.circle, C)
- circle3 (sketch.circle3, Shift+C)
- arc (sketch.arc, A)
- tangent-arc (sketch.tangentArc)
- arc3 (sketch.arc3, Shift+A)
- slot (sketch.slot, O)
- slot-center (sketch.slotCenter, Shift+O)
- polygon (sketch.polygon, G)
- point (sketch.point, P)

Tool options: polygon `{sides: 3–40, mode: "inscribed" | "circumscribed"}`; slots `{length: "centres" | "overall"}`.

**UI pieces and test ids**
- DrawTools.tsx exports `Flyout`, `IconTool`, `ToolStrip`.
- Test ids:
  - toolbar: `tool-<name>` (the button showing a flyout's last-used tool), `tool-<flyoutId>-flyout` (its arrow), `flyout-<name>` (an item in the list);
  - options strip: `tool-strip`, `tool-prompt`, `tool-option-<key>` with `-up`/`-down`, `tool-option-<key>-<value>`.
- SketchCanvas `Tool` is now a string: "select", "dimension" or a registry tool name.
- `onCreate(made: Placement)`.
- In a line chain, A switches the next piece to a tangent arc and back.

**Point entity**
- Shape: `PointEntity { id, type: "point", at: Vec2 }`; its point ref is `<id>.at`; `ENTITY_PREFIX` "p"; solver `FIELDS [["at",2]]`; `POINT_NAMES ["at"]`.
- `fix` accepts a point entity.
- `buildProfile` skips it; `entityPolylines` returns [].
- draft.ts adds `asPoints(items, byId)` and `itemEntities(items, entities)`: a point picked as an entity is related as its point.

solveSketch with drag now falls back to slide(): when the pins cannot be met exactly, the handle goes to the nearest place the constraints allow, as long as that brings it closer than it was. Callers see ok:true with the moved geometry. 'the constraints do not let that move' now means the handle cannot get any closer at all. The Point tool's build returns null for a click on an existing sketch point's '.at'.

Known follow-ups: sketch points are not drawn in the 3D overlay after finishing; the polygon's relation glyphs crowd the view; an empty sketch reads 'Fully defined'; plane drag/Ctrl-drag copy not done.

## Wave 2 (merged): sketch references + revolve/shell/draft/scale

Ops:
- revolve: {sketch, axis: {line: entityId} | DatumRef, angle?, angle2?, midplane?, reverse?, thin?: {thickness, side?: "outside"|"inside"|"mid"}, ...OperationFields}. `isLineAxis(a)` is exported from src/features/revolve/doc.ts.
- shell: {faces: FaceSelector[] (may be empty), thickness, outward?, body?}.
- draft: {faces, neutral: DatumRef (plane-like), angle, flip?}.

Helpers:
- src/kernel/pickFaces.ts (new shared kernel helper): `pickFaces(part, selectors)` returns PickedFace[] ({face, index, body, path}); `bodyOfFaces(picked, body, bodies, opName)`.
- src/ui/model/carrySelection.ts: carries a whole-body selection through a rebuild.
- src/features/revolve/band.ts: axisCrossing, regionSegs, openBand, closedBands, wallOffsets, BandError.

Tool exports:
- src/ui/model/tools/revolve.ts: `sketchAxisLine(entities)`, `revolveFeature(ctx, cut)`.
- src/ui/model/tools/dress.ts: `shellFeature`, `draftFeature`, `draftNeutral(faces, all, datums)`.
- src/ui/model/tools/scale.ts: `scaleFeature`.

Tool and test IDs:
- Revolve: tool.revolve (tool-revolve) and tool.revolveCut (tool-revolve-cut), both in the tool-revolve-menu menu.
- Shell: tool.shell (tool-shell), right-click ctx-shell.
- Draft: tool.draft (tool-draft), right-click ctx-draft.
- Scale: tool.scale (tool-scale, Bodies tab).

Icons: revolve, revolveCut, shell, draft, scaleBody.

New exports: openProfile(entities, axis) in src/ui/model/tools/revolve.ts; defaultAxisIn(frame) in src/features/revolve/ui.tsx. PATTERNABLE in src/ui/model/tools/pattern.ts now includes registry ops with patternable: true.

Document:
- `SketchEntity.ref?: DatumRef` (line, circle, arc, point only) and `SKETCH_AXES = ["X", "Y"]` with `type SketchAxis`, in `src/doc/types.ts`.

`src/doc/sketch.ts`:
- `isSketchAxis(id)`
- `isReference(e)`
- `isConstruction(e)`: returns `e.construction ?? !!e.ref`.
- `constraintEntities(k)`: leaves the axes out.
- `constraintTargets(k)`: keeps the axes (re-exported from `src/geom/axes.ts`).
- `expressionFields(rawEntities): string[]`

`src/geom/axes.ts`:
- `AXIS_IDS`, `AXIS_LINES`
- `isAxisId`
- `withAxes(entities)`
- `isConstant(e)`: true for a reference entity or an axis.
- `constraintTargets`

`src/geom/projection.ts`:
- `EdgeGeometry`, `ProjectedShape`
- `projectEdge(edge, frame)`
- `projectAxis(origin, dir, frame, half)`
- `projectPoint(p, frame)`
- `edgePointOf(edge, at)`
- `withProjection(e, shape, name)`, `withPoint(e, at, name)`
- `isFullCircle(edge)`
- `REFERENCEABLE`

Solver (`src/geom/solver.ts`):
- `solveSketch(entities, constraints, opts)`: reference entities and the axes are frozen automatically.
- `sketchDof`, `sketchStatus` and `wouldOverDefine` do not count constants.

Kernel:
- `src/kernel/sketchRefs.ts`: `solvedSketch(ctx, f, frame, hold?)` and `projectReferences(ctx, f, frame)`.
- `SketchOverlay` (`src/kernel/rebuild.ts`) gains:
  - `polylines[].reference?`
  - `points: { at, reference? }[]`
  - `entities: SketchEntity[]`, which holds the solved entities.

Worker:
- New request `{ type: "before", doc, feature }` returning `{ type: "before", view }`.
- `KernelClient.rebuildBefore(doc, featureId): Promise<RebuildView>`
- `src/worker/before.ts`: `documentBefore`, `beforeKey`, `Recent<T>`.

Sketcher UI:
- `src/ui/sketcher/model.ts`:
  - `modelView(view, frame): ModelView` and `EMPTY_MODEL`
  - model edge stand-in ids are `"@e<index>"`: `modelId`, `isModelId`, `modelIndex`
  - `modelEntities`, `modelEdge`, `faceAt`
  - `materialize(ids, model, entities, { convert? })`
  - `renamed(k, ids)`, `modelIdsOf(k)`
  - `convertEdges(edgeIds, faceIndices, model, entities, constraints, construction?)`
- `src/ui/sketcher/names.ts`: `namer(entities, model)`, `referenceName(e)`, `shapeWords(e)`, `directionWord(d)`.
- `src/ui/sketcher/draft.ts`:
  - `SketchItem` gains `{ kind: "face"; index }`.
  - `describeConstraint(k, names?)`
  - `constraintSentence(k, label, names?)`
  - `axesAllowed(k)`
- `src/ui/sketcher/annotate.ts`: `relationGroups(constraints)`; `Glyph.indices?`.
- `SketchMode` and `SketchCanvas` take the prop `model: ModelView`, which replaces `reference: Float32Array`.
- New tool name `"convert"` (command `sketch.convert`, icon `convertEntities`).
- `SnapContext.model?: SketchEntity[]`.

CSS:
- Tokens `--sketch-reference`, `--model-edge`, `--model-edge-plane` and `--model-face`, appended to `styles.css`.

- `CheckResult.solvedSketches?: Record<string, SketchEntity[]>` (`src/ask/kernel.ts`): the rebuild-solved entities of sketches that reference the model. It is only present when such a sketch built.
- Sketch packets (`measurements.now`): when the solved geometry differs from the document, they carry `{ note, entities }`.
- `entityMeasurements` for a circle or an arc now includes `center`.

Note: the sketch toolbar is nearly full at 1500 px: new sketch tools must go in flyouts.

## Wave 3 (merged): sketch edit tools + extrude/fillet/chamfer upgrades

Document fields (src/doc/types.ts):
- ExtrudeFeature gains: extent ("blind" | "midplane" | "throughAll" | "throughAllBoth" | "upToNext" | "upToFace" | "upToVertex" | "offsetFromFace"), upTo?: DatumRef, offset?, direction2?: { extent, distance?, upTo?, offset?, draft? }, startOffset?, from?: DatumRef, draft?: { angle, outward? }, thin?: { thickness, side?: "outside" | "inside" | "mid" }, regions?: Vec2[], intersect? (extrude only), flipSide? (cut only).
- Constants EXTRUDE_EXTENTS and DIRECTION2_EXTENTS. THIN_SIDES is exported from validate.ts.
- FilletFeature and ChamferFeature extend EdgeChoice { edges?, faces?: FaceSelector[], features?: string[] }.
- Fillet: radius?, radius2?, sets?: FilletSet[], where FilletSet = EdgeChoice & { radius, radius2? }.
- Chamfer: distance, distance2?, angle? (degrees), flip?.

Kernel:
- src/kernel/extrude.ts: extrudeTool(ctx, s, f, profile, entities, reach), toolRegions, cutMissed, extrudeBody.
- src/kernel/edgeTreat.ts: treatments, byBody, treatBody.

Pure 2D (src/features/extrude/regions.ts):
- pickRegions, complementRegions, thinRegions, openOutside, areaOf, regionPoints, nestedLoops.
- New: contours(regions): Contour[] where Contour = { seed, area, outer, holes, inDefault }; contourAt(regions, p); interiorPoint(region).

UI rules (src/ui/props/extrude.ts):
- END_LABELS, endOptions(1|2), needsUpTo, needsDepth, refKind.
- upToFromSelection, endPatch(f, which, extent, ctx), startKind, startPatch, thinPatch, direction2Patch, isReversed.
- sketchContours, pickedContours, contoursPatch(list, picked, i, on) (returns Raw | null), defaultContours, contourLabel.

Field lists: src/ui/props/ExtrudeForm.tsx exports extrudeFields(op), EXTRUDE_FIELDS and CUT_FIELDS. PropertyPanel renders them through FeatureForm; extrude is still not a registry op.

src/ui/props/edgeTreat.tsx exports SHAPE_OPS, chamferType, chamferTypePatch, variablePatch, addSetPatch, removeSetPatch, describeSet, edgeChoiceFields(prefix) and RadiusSets.

src/ask/packet.ts exports extrudeMeasurements(rf).

Test ids:
- Extrude/cut panel: prop-from, prop-start-offset, prop-from-ref, prop-section-from, prop-section-dir1, prop-extent, prop-distance, prop-up-to(-use/-ref), prop-offset, prop-direction-mode, prop-direction, prop-draft, prop-draft-angle, prop-draft-outward, prop-direction2, prop-direction2-extent, prop-direction2-distance, prop-direction2-up-to, prop-direction2-offset, prop-direction2-draft, prop-direction2-draft-angle, prop-direction2-draft-outward, prop-thin, prop-thin-thickness, prop-thin-side, prop-regions, prop-regions-<i>, prop-regions-all, prop-intersect, prop-flip-side.
- Fillet: prop-fillet-faces, prop-fillet-features, prop-radius, prop-radius2, prop-fillet-variable, prop-fillet-sets, prop-fillet-sets-add, prop-fillet-sets-remove-<i>.
- Chamfer: prop-chamfer-faces, prop-chamfer-features, prop-chamfer-type, prop-chamfer-distance, prop-chamfer-distance2, prop-chamfer-angle, prop-chamfer-flip.

CSS: one appended class, .prop-section.

Edit tool registry, all under `src/ui/sketcher/edit/`:
- `types.ts`
  - `EditToolDef { id, name, label, icon, title, flyout?, options?: ToolOption[], kind: "click" | "collect", start?(selection, state): EditPicks, prompt(picks, options), places?(picks, options): boolean, click(state, picks, input: EditInput, options): EditStep, drag?(state, path, options), preview?(state, picks, options, hover): EditPreview, apply?(state, picks, options): Edit | string | null }`
  - `EditPicks { entities, points, about?, places: Place[], skip?, picking? }`
  - `NO_PICKS`
  - `EditInput { p, item: SketchItem | null, ref, tol, additive? }`
  - `EditStep = { picks } | { edit } | { message }`
  - `EditPreview { add?, remove?, marks? }`
- `index.ts`: `EDIT_TOOLS` (append one import line and one LISTS line per module) and `editByName(name)`.
- Tool names, their commands and keys:
  - trim (`sketch.trim`, T)
  - extend (`sketch.extend`, E)
  - split (`sketch.split`)
  - fillet (`sketch.fillet`)
  - chamfer (`sketch.chamfer`)
  - offset (`sketch.offset`)
  - mirror (`sketch.mirror`, M)
  - linear-pattern (`sketch.linearPattern`)
  - circular-pattern (`sketch.circularPattern`)
  - move (`sketch.move`)
  - copy (`sketch.copy`)
  - rotate (`sketch.rotate`)
  - scale (`sketch.scale`)
- New commands appended to COMMANDS: `sketch.explode` and `sketch.check`. The 13 tool commands above are no longer planned.
- `offset.ts` exports `offsetOptions(state, picks, options)`.

Pure geometry, under `src/geom/sketchEdit/`:
- `relations.ts`: `SketchState`, `Edit { entities, constraints, soft?, made?, note? }`, `settle`, `mapRefs`, `relationKey`, `freshIds`, `pointAtRef`, `PREFIX`.
- `trim.ts`: `trimAt`, `powerTrim`, `extendAt`, `extended`, `splitAt`, `cutsOf`, `crossings`, `editableAt`, `trimPreview`.
- `explode.ts`: `explode`, `explodeAll`, `explodable`.
- `fillet.ts`: `cornersOf`, `filletCorners(state, corners, r, {keepCorners})`, `chamferCorners(state, corners, ChamferMode)`.
- `offset.ts`: `chainOf`, `chainsOf`, `insideOf`, `sideOf`, `offsetEntities(state, ids, OffsetOptions)`.
- `mirror.ts`: `mirrorEntities(state, ids, about, {copy})`, `reflectPoint`.
- `pattern.ts`: `linearPattern`, `circularPattern`, `patternPlaces`.
- `transform.ts`: `transformEntities(state, ids, Transform, {copy, keepRelations, count})`, `angleBetween`.
- `check.ts`: `checkSketch(entities) -> { problems: SketchProblem[], loops }`, `fixProblem`, `fixAll`, `problemSummary`, `gapTolerance`.

Document and solver:
- New relation `OffsetConstraint { type: "offset", entities: string[] /* bases, or point refs for a round corner or arc cap */, offsets: string[], value }`. This is how the offset stays driven: one distance relation the solver understands, rather than a separate dimension per pair.
- `SymmetricConstraint` now takes exactly one of `points` or `entities` (two lines, two arcs or two circles about `line`).
- Both are validated in `src/doc/validate.ts`, solved in `src/geom/solver.ts` and checked in `src/geom/constraints.ts`.
- `removeEntities` (`src/doc/sketch.ts`) drops only the offset pairs that name a deleted entity.

Shared UI pieces:
- `DrawTools.tsx`:
  - `Flyout` is generic over `ToolLike` and takes `small`.
  - `IconTool` takes `small`.
  - New `ToolStack` (small tools stacked two high).
  - New `OptionControls`.
- `ToolOption` gains `step?` and `unit?` on numbers, and a `{ kind: "toggle", default: "on" | "off" }` option.
- `toolbarEntries<T>(tools)` and `optionValues(def: {options?})` are generic; `flyoutChoice` and `remember` accept edit tools.
- `SketchCanvas` props gain `edit?: CanvasEdit`, `regions?: Vec2[][]` and `problems?: {at, text}[]`. Relation glyphs and dimensions take clicks only with Select and Smart Dimension.

Test ids:
- Options strip: `tool-apply`, `tool-clear`, `tool-problem`, `tool-mirror-about`.
- Toolbar: `tool-check`, plus `tool-<name>`, `tool-trim-flyout`, `tool-fillet-flyout`, `tool-pattern-flyout`, `tool-move-flyout`, and `flyout-<name>` items.
- Canvas: `sketch-regions` (`data-count`), `sketch-warning`, `edit-mark` (`data-off`), `trim-stroke`.
- Status line: `sketch-problems`.
- Check panel: `sketch-check`, `check-problem-<i>`, `check-fix-<i>`, `check-fix-all`, `check-clean`.
- Right-click menu: `ctx-check`, `ctx-fillet`, `ctx-chamfer`, `ctx-explode`, `ctx-offset`, `ctx-mirror`, `ctx-linear-pattern`, `ctx-circular-pattern`, `ctx-move`, `ctx-rotate`.

New icons: `explodeEntity`, `checkSketch`. New CSS tokens: `--sketch-region`, `--sketch-warning`, `--sketch-goes`.

The datumRef FieldSpec gains an optional pick?: (f, c) => DatumRef. It replaces the default Use selected and throws an Error that says what to select. The 'edges' FieldSpec gains optional?: boolean, which shows x (test id <tid>-remove-<i>). upToFromSelection(extent, c, then?) has a new third argument, the words after 'click it in the view first, then'. src/ui/props/edgeTreat.tsx exports setRadiusPatch(f, i, "radius" | "radius2", value). New test id prop-fillet-sets-radius-<i>. edgeFeature now returns edges and faces together when both are selected. Appended CSS: .selector-line .set-text and .selector-line .set-radius.

- FieldSpec kind "datumRef" gains `pick?: (f, ctx) => DatumRef`. When set, FeatureForm's Use selected calls it; it throws an Error that says what to select.
- FieldSpec kind "edges" gains `optional?: boolean`. An optional edge list shows a remove button per selector (`<testId>-remove-<i>`) and can be emptied to null.
- upToFromSelection(extent, ctx, then?) takes an optional wording for the end of its error message.
- src/ui/props/edgeTreat.tsx exports setRadiusPatch(f, i, "radius" | "radius2", value).
- New test ids: prop-fillet-sets-radius-<i>, and prop-edges-remove-<i> (the generic edges field's remove buttons).
- CSS appended: .selector-line .set-text and .set-radius.

New export from src/ui/sketcher/edit/picks.ts:
- livePicks(picks: EditPicks, state: SketchState): EditPicks. It returns the same object when nothing is gone. SketchMode calls it in an effect on draft.

fixProblem in src/geom/sketchEdit/check.ts:
- For a 'duplicate' problem it now returns `soft` relations (the doubled entity's relations, moved onto the kept one).
- fixAll returns the gathered `soft` as well.
- The sketcher's applyEdit keeps these only where they don't over-define.

splitAt (line):
- Rewrites `{type: "distance", entity: id}` to `{type: "distance", points: [id.start, <second piece>.end]}`.

circularPattern:
- May now write 'collinear' between the first two spokes (half-turn step).
- Angle values are always between 0° and 180°.

Open follow-ups from Wave 3:
- Up to surface on a face picked in the view can stop following that face after other edits. The face selector made from a pick (faceSelectorFor) records the face's offset, so when the face moves (for example, a taller block) the extrude fails with 'selector matched 0 faces'. Synthesis owned outside this task could prefer a selector that does not depend on position.
- 'Use regions clicked in the view' is offered as a tick list of the sketch's regions in Properties, not as clicks in the 3D view.
- Not done (optional in the brief): a right-click 'Extrude up to this face' entry, and icons for the end conditions in the select.
- Draft only works with a start parallel to the sketch plane; a slanted 'from' with a draft gives a clear error. A thin feature cannot have a draft.
- An intersecting extrude leaves no tool for a pattern to repeat; patterning one says so.
- Dynamic mirror (draw on one side of a centreline, mirrored live) is not done; it was optional.
- Shift-drag in power trim to extend, and SOLIDWORKS's trim modes 'corner' and 'trim away inside/outside', are not done.
- Patterns: only the seed's key point is placed, so a patterned line or arc can still turn (each copy is equal to and, for a line, parallel to its seed, but the circular pattern does not fix copy orientation). There is no second direction for linear patterns.
- Offset uses one side for all picked chains: closed chains drawn in opposite directions picked together could go opposite ways.
- Relation glyphs crowd the sketch after fillets, offsets and patterns. This is the existing Wave 1 follow-up, made more visible by these tools; grouping coincident and tangent glyphs per joint would help.
- Edit tool icons in the stacked toolbar group have no text labels (they have tooltips and aria-labels); the sketch toolbar has no room for labels at 1500 px.
- Check sketch reports problems but does not try to repair crossings or overlaps automatically (trimming them is left to the user).
- Up to surface on a face picked in the view uses faceSelectorFor, which may record the face's offset when it needs to tell faces apart. If that face later moves, the extrude can fail. faceSelectorFor (src/kernel/synthesize.ts) is outside this task and is shared by holes and sketches on faces; this follow-up is the engineer's.
- Selected contours stores a seed point for each region. If a later sketch edit moves a region away from its seed, that feature fails with 'outside every closed loop'. This is how the seed-point design in the brief works. Picking regions by clicking in the 3D view is still not done (the editor offers a tick list).
- Optional items still not done: a right-click 'Extrude up to this face' entry, and icons for the end conditions.
- Draft needs a start parallel to the sketch plane, and a thin feature cannot have a draft. Both give clear errors.
- The fillet summary chip in the tree is cut off when the row is selected (existing tree layout).
- Up to surface on a face picked in the view uses a position-dependent face selector (faceSelectorFor), so if that face moves later the extrude fails with 'selector matched 0 faces'. Selector synthesis is outside this task's scope.
- Selected contours are a tick list of the sketch's regions in Properties, not clicks in the 3D view (the brief said 'if feasible').
- Not done (optional in the brief): a right-click 'Extrude up to this face' entry, and icons for the end conditions.
- Draft needs a start parallel to the sketch plane, and a thin feature cannot have a draft. Both give clear errors.
- An intersecting extrude leaves no tool for a pattern to repeat. Patterning one says so.
- Patterns: a patterned line or arc copy can still turn about its key point, so it is not fully defined. This is the engineer's follow-up; it needs extra construction geometry per copy and is a design change.
- Offset: the side is not taken from the pointer (outward for closed chains, left for open ones, Reverse flips). With several chains picked, one side is used for all. Engineer follow-up.
- When editing an offset value on an under-defined base, the solver may move the base as well as the offset (seen: a rectangle's undimensioned height shrank). This comes from the existing least-movement solver; it is fine once the base is dimensioned.
- Visual clutter: relation glyphs crowd joints after fillets, offsets and patterns. An offset's dimension label can sit on top of a nearby dimension. A warning triangle can overlap a relation glyph. This is the existing Wave 1 glyph-layout follow-up.
- Check sketch lists two crossings of the same pair at two places with identical text, and reports tangent-touching circles as 'cross'. Wording only, not changed.
- Splitting a line leaves 'pointOn' relations to it on the first piece, even when the point lies on the second piece. These still hold because pointOn uses the line's infinite carrier.
- Dynamic mirror, shift-drag extend in power trim, and two-direction linear patterns are not done (the engineer listed them as optional or follow-ups).
