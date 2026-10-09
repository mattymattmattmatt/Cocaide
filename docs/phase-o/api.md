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
