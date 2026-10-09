# Cocaide UI map: where new tools, property editors and viewport features go

Line numbers are for commit `4de1139`. All paths are under `/home/user/Cocaide/src/ui` unless shown otherwise.

---

## 0. Key facts

- **Every edit is a document command.** `d.dispatch(cmd)` (`useDocument.ts:77-91`) runs `apply(doc, cmd, {user:true})`, records one undo step, re-renders and returns the error text or `null`. `App.run()` (`App.tsx:295-302`) wraps it and shows a notice. `batch(cmds)` (`App.tsx:502-512`) applies several commands as one undo step through `d.replaceDoc`.
- **Rebuilds are automatic.** `shown = ask.previewDoc ?? parsed.value` (`App.tsx:149`). An effect on `shown` (`App.tsx:235-257`) waits 250 ms (`REBUILD_DELAY_MS`), then calls `kernel.rebuild(shown)`. Only the newest ticket is used. **It calls `setSelection(EMPTY_SELECTION)` after every rebuild (line 245)**, because face and edge indices only mean something for one rebuild.
- **New tools create the feature at once.** A tool calls `create(feature)` (`App.tsx:305-312`): `addFeature`, select it, open the Properties tab, clear the selection. The PropertyPanel then edits it with `updateFeature` patches. There is no OK/Cancel step and no transient preview.
- **The kernel has no "rebuild up to" option.** `RebuildOptions` only has `provenance` (`src/kernel/rebuild.ts:99-102`), and the worker protocol only has `rebuild`, `exportStep` and `port` (`src/worker/protocol.ts:8-12`). A rollback bar is best done in the UI by slicing `features` (§6).
- **The viewport is unmounted while sketching.** `App.tsx:1443-1564` renders `<SketchMode>` *instead of* `<Viewport>`. When it mounts again, the renderer is rebuilt and the camera goes back to iso (`Viewport.tsx:663` and the `fitToken` effect at `683-685`). The camera is lost after every sketch and every switch from Drawing back to Model.
- **Unit tests run in node only** (`vite.config.ts`: `environment: "node"`, `tests/**/*.test.ts`). Put UI logic in pure modules, as `sketcher/draft.ts` and `sketcher/annotate.ts` do, so Vitest can cover it.
- **Strict TypeScript:** `noUnusedLocals` and `noUnusedParameters` are on. The document validator whitelists top-level keys (`src/doc/validate.ts:136`), so any new top-level document key, such as a saved rollback position, must be added there.

---

## 1. `App.tsx` (1707 lines)

### 1.1 State

| State | Line | Notes |
|---|---|---|
| `kernel = new KernelClient()` | 112 | `kernel.rebuild`, `kernel.exportStep`, `kernel.port.{check,topology,select,screenshot,project}` |
| `d = useDocument(...)` | 115 | `d.doc`, `d.parsed`, `d.dispatch`, `d.replaceDoc`, `d.undo/redo`, `d.canUndo` |
| `view: RebuildView \| null` | 116 | mesh, faces, edges, bodies, sketches, measurements, features status |
| `notice: {kind:"info"\|"error", text}` | 81, 119 | shown at `1326-1333` (`data-testid="notice"`) |
| `selection: Selection` | 122 | face/edge indices into the current `view` |
| `selectedFeature: string\|null` | 123 | tree selection; cleared when the feature disappears (`291-293`) |
| `rightTab: "properties"\|"sections"\|"cutlist"\|"document"` | 124 | tabs at `1500-1513` |
| `sketch: SketchSession\|null` | 125 | non-null means sketch mode |
| `hiddenBodies` | 126 | |
| `mode: "model"\|"drawing"` | 134 | |
| `menu: ContextMenuState\|null` | 915 | rendered at 1570 |
| `shortcutBar` | 1049 | |
| `leftHidden` (F9) | 1057 | |
| `modelling = !sketch && mode==="model"` | 1058 | turns on model commands |
| `params`, `resolved` | 144, 370 | `resolved` is the features with `=expr` evaluated; use it for computing, and raw `features` (368) for editing |
| `selected` | 371 | the resolved selected feature |

### 1.2 Tool functions: the pattern to copy

All live in `App()` and close over `doc`, `view`, `selection`, `selected` and `resolved`. Each checks what it needs, otherwise calls `setNotice({kind:"error", text:"Click X first, then Y."})`, then calls `create({...})`.

- `startSketch(plane)` 373, `sketchOnFace()` 379 (needs one planar face; uses `f.normal` and `f.offset`), `editSketch(id)` 388, `finishSketch` 408.
- `sketchFor()` 595: the selected sketch, else the latest.
- `extrude(op)` 598-619: picks the body, and for a cut flips direction toward the material using `view.measurements.boundingBox`.
- `hole()` 621-632: `faceSelectorFor(view.faces, i)`, then `facePlaneFrame` and `to2D(selection.point)` for the centre.
- `combine()` 634, `edgeFeature(op)` 644-651 (`edgesSelectorFor(view.edges, view.faces, selection.edges)`).
- Multibody: `pickedBody()` 656, `bodyBox()` 657, `yz(x)` 658 (a datum plane builder), `mirrorTool` 661, `splitTool` 673, `moveTool` 680, `deleteBodyTool` 687, `saveBody` 693.
- `patternFeature(op)` 702-712: seed must be extrude, cut, hole or member.
- Weldment: `memberTool` 473, `addMember` 459, `addPath` 528. Drawing: `newDrawing` 717 and following.

### 1.3 `TOOLS` registry and running a tool

- `TOOLS: Record<string, {icon, label, run, disabled?}>` at `884-903`. Keys are command ids `"tool.<name>"`.
- `runTool(id)` 906-912 shows `t.disabled` as an info notice and records `lastTool` (Enter repeats it, 1077).
- Keyboard: `useCommands({... ...Object.fromEntries(Object.keys(TOOLS).map(id => [id, () => runTool(id)]))}, !sketch)` at 1059-1083. **A key only works if the id is also in `COMMANDS` in `input.ts`**, because `useCommands` loops over `COMMANDS` (`input.ts:220`).
- The shortcut bar (`S`, 1571-1597) lists every entry in `TOOLS` automatically (`data-testid="bar-tool.<x>"`).
- Context menus reuse `TOOLS` through the `tool(id, label?)` helper (941-944): `testId: "ctx-tool.<x>"`, with shortcut and disabled hint.

### 1.4 Toolbar JSX

- The model toolbar is at `1232-1323`. Groups are separated by `<span className="sep" />`: undo/redo | Sketch (ToolMenu) | Extrude Cut Hole Fillet Chamfer | Pattern (ToolMenu) Mirror | Combine Split Move Delete-body | Member.
- Button pattern: `<ToolButton icon=".." label=".." onClick={() => runTool("tool.x")} title={`...${keyHint("tool.x", prefs)}`} testId="tool-x" />`.
- Dropdown pattern: `<ToolMenu icon label title testId>{(close) => <MenuItem ... onClick={() => { close(); runTool(..) }} testId=".." />}</ToolMenu>` (Pattern menu at 1273-1300).
- The drawing toolbar is at 1213-1231.

### 1.5 Context menu builder

`contextMenu(target: AskTarget, x, y)` at `938-1045`. `contextMenuRef` (1046) keeps the newest closure for stale callbacks.

- Helpers: `ask = askEntry(...)` 940, `tool(id)` 941, `viewCmd(id,label,icon)` 945 (runs `viewCommands.current?.(id)`, the Viewport's command table), and `featureItems(id)` 946-975 (Edit feature, Edit sketch, Suppress, Rename…, Delete).
- `switch (target.kind)` covers `feature|failed` 980, `face` 985 (flat face: Sketch, Hole here, Normal to, Zoom to fit, Hide body), `edge` 997 (Fillet, Chamfer, Zoom to fit), `part` 1000, `parameter` 1016, `body` 1019, `view` / `annotation` / `drawing` 1030-1042.
- `setMenu({x, y, title, items:[...items, "sep", ask]})` at 1044. Every menu ends with Ask AI.
- **Limit:** the target type is `AskTarget` (`src/ask/packet.ts:24-43`). A new right-clickable thing (a datum plane, a reference axis, a sketch in 3D) needs either an `AskTarget` member plus packet support, or a separate `MenuTarget = AskTarget | {kind:"datum", id}` type that leaves out the ask entry for kinds the assistant doesn't handle.
- Viewport right-click goes through `onContext` (846-852). It selects the target first, then opens the menu. Empty space opens `{kind:"part"}`.

### 1.6 Other wiring

- Escape clears the selection and Ctrl+Shift+Z redoes (865-878). Both are off while sketching.
- The PropertyPanel is mounted at 1544-1555 **without `key={selectedFeature}`**, so local state such as `DirectionInput`'s `custom` (`fields.tsx:151`) carries over between features.
- `projectEdges(view, plane)` at 1688-1702 builds the sketch's reference geometry (§7.3).

---

## 2. Checklist: adding one model feature

| # | Where | What |
|---|---|---|
| 1 | `src/doc/types.ts:300-336` | Add to the `Feature` union and `FEATURE_OPS` |
| 2 | `src/doc/validate.ts` (per-op `case`, e.g. `deleteBody` at 330, 1367, 1491) | Validation and the bodies it makes |
| 3 | `src/doc/scope.ts` (~228), `src/doc/commands.ts` (rename refs ~538) | Scope tokens; rename follow-through |
| 4 | `src/kernel/rebuild.ts` switch (starts ~271), `src/kernel/ops.ts` | Geometry |
| 5 | `src/mcp/reference.ts` (~133) | Docs for the agent |
| 6 | `icons.tsx` `ICONS` | Icon (§8.2) |
| 7 | `PropertyPanel.tsx:18-36` `OP_LABEL`, `FeatureTree.tsx:12-30` `OP_ICON` | Label and tree icon |
| 8 | `PropertyPanel.tsx:115-145` | `{op==="x" && <XProps .../>}` |
| 9 | `FeatureTree.tsx:117-139` | Optional summary `<span className="feature-body">` |
| 10 | `input.ts:65-78` `COMMANDS` | `{id:"tool.x", label, group:"Model tools", key:null}` |
| 11 | `App.tsx` | Tool function, `TOOLS` entry, toolbar button or menu item, context-menu entries |
| 12 | `src/ask/packet.ts:68` `featureKind` | Only if it needs its own packet kind |
| 13 | Tests | `tests/*.test.ts` (kernel, validation); `e2e/*.spec.ts` (UI) |

---

## 3. Viewport selection

- Types (`Viewport.tsx:18-28`):
  ```ts
  export type PickTarget = { kind: "face" | "edge"; index: number; point: Vec3 };
  export interface Selection { faces: number[]; edges: number[]; point?: Vec3 }
  export const EMPTY_SELECTION: Selection = { faces: [], edges: [] };
  ```
- Picking is `pickAt(clientX, clientY)` at 480-504. It raycasts the mesh, skipping hidden bodies, then the edge `LineSegments` with a 6 px threshold (`PICK_PIXELS` 76). An edge wins if it is within about 2×threshold of the face hit. `segmentEdge` (185, 391) maps a segment back to its B-rep edge index, and `faceRanges.findIndex` maps a triangle to its face (485-489).
- Click versus drag: `onDown`/`onUp` at 525-542. Under 4 px of movement is a click. Left calls `onPick(target, shift||ctrl||meta)`, right calls `onContext`.
- Selection rules (`App.onPick`, 854-862): **a face click always replaces the selection with that one face, even with Shift.** Edges add or toggle with Shift/Ctrl, and picking an edge drops any faces. Multi-face selection only comes from BodiesPanel → "Select its faces" (`App.tsx:1024`, `1430`).
- Highlighting: `redrawMarks()` 337-348 draws selected faces with `faceMesh(indices, SELECT_COLOR 0xf28c28, 0.45)` (299-319, polygon offset -2, renderOrder 4) and edges with `edgeMarks(indices, selectEdgeMat)`, fat `LineSegments2` lines (322-335, renderOrder 5). Hover uses `HOVER_COLOR 0x2f7bff`.
- The HTML readouts are `PickTip` (834) and `SelectionChip` (845, `data-testid="selection"`). Their text comes from `describeFace` / `describeEdge` (818-832).
- Turning a pick into a stored reference: `faceSelectorFor(faces, i)`, `edgeSelectorFor`, `edgesSelectorFor(edges, faces, indices)` (`src/kernel/synthesize.ts:15,49,91`). Readable text: `describeWanted(sel, n)` and `describeEdgeSelector(sel)` (`src/kernel/selectors.ts:56,135`). Data: `FaceInfo` (`src/kernel/topology.ts:23-39`: type, area, centroid, normal, point, offset, cylinder, body) and `EdgeInfo` (124-149: kind, length, start, end, mid, direction, radius, center, axis, faces[], seam, body).
- **Gaps for SOLIDWORKS-style tools:**
  1. No additive face selection. Shell, draft, face fillet and delete-face need `{faces:[...]}` with Shift/Ctrl.
  2. No vertices, sketches, datum planes or axes in `PickTarget`.
  3. A face selection cannot be mixed with an edge selection.
  4. Each rebuild clears the selection, so live-editing a feature while picking loses picks (see the preview design in §5.4).

  Suggested extension, with the change kept to `onPick` (854) and `pickAt`:
  ```ts
  PickTarget = {kind:"face"|"edge"|"vertex", index, point} | {kind:"datum"|"sketch", id, point};
  Selection  = {faces, edges, vertices?, refs?: string[], point?};
  ```

---

## 4. `PropertyPanel.tsx` and `fields.tsx`

### 4.1 How editing works

- `PropertyPanel` (60-172) finds the raw feature `f`, builds `resolved = resolveExpressions(f, params)`, `before` (the features ahead of it, resolved) and `bodiesBefore` (80, from validating the truncated document). It defines `update(patch) = dispatch({type:"updateFeature", id, patch})` (72).
- **Patch semantics** (`src/doc/commands.ts:124-148`): a *shallow* merge, and `null` deletes a top-level key. Nested objects are replaced whole, e.g. `HoleProps` sends `{counterbore: {...f.counterbore, diameter: v}}` (463). Rename goes through `patch:{id}` and is refused while other features depend on it.
- Layout: `.prop-header` (h3 label plus the `prop-id` TextInput), the feature error box (`prop-feature-error`), `.prop-body` with the op sections, `.prop-actions` (Suppressed checkbox `prop-suppressed`, Delete), then `command-error`.
- Per-op sections:
  - `ExtrudeProps` 331-382: Sketch select, End (blind/midplane/throughAll), Depth, Direction mode, custom vector.
  - `HoleProps` 384-492: face readout plus a "Use selected face" button, centre X/Y, Ø, Through or depth, type, counterbore/countersink.
  - `EdgeTreatmentProps` 494-541: edge selector lines plus "Use selected edges", radius or distance.
  - `PatternProps` 543-608, `CombineProps` 231, `BodyProps` 185, `BodiesScope` 210, `SketchProps` 276-315 (DOF readout from `sketchDof`, Edit sketch button).
  - `BodyToolProps.tsx` holds `PlaneFields` (18-30, a datum plane as origin `Vec3Input` plus `DirectionInput` normal; reuse it for any plane-driven feature), `BodyChecks` (32), `NewBodyName` (55), and Mirror, Split, Move and Delete props. `FrameProps.tsx` holds the member, joint, endCap and gusset props.

### 4.2 Field components (`fields.tsx`)

- `ParametersContext` (9), provided at `App.tsx:1107`.
- `Field({label, unit?, hint?})` 15: a label and input grid (`.field`, 110px label column).
- `NumberInput({value, onCommit, min?, step?, testId?, ariaLabel?})` 32-98:
  - Commits on Enter or blur; Escape reverts.
  - Accepts `=expr`: evaluates against the parameters, shows `= value`, refuses a bad expression with `.expr-error`, and commits the expression *string*.
  - Plain numbers below `min` silently revert. **`step` is accepted but unused.** `min` is not checked for expressions.
- `TextInput` 100, `Vec3Input` 121 (three NumberInputs, testIds `${testId}-x|y|z`), `DirectionInput` 147 (±X/±Y/±Z or custom), `Select<T>` 175 (`options: [value, label][]`).

### 4.3 Would a field-spec editor fit?

Yes. About 80% of every Props component is the same five primitives plus "Use selected X" buttons and conditional rows. A pure spec module (unit-testable in node) keeps per-op code small:

```ts
type FieldSpec =
 | { kind:"number"; key:string; label:string; unit?:"mm"|"°"; min?:number; testId?:string; when?(f:Raw):boolean; path?: string[] } // path for nested objects
 | { kind:"select"; key; label; options:[string,string][] | ((ctx)=>[string,string][]); onSet?(v, f, ctx): Raw }
 | { kind:"bool"; key; label } | { kind:"vec3"|"direction"; key; label }
 | { kind:"plane"; key }                         // reuses PlaneFields
 | { kind:"faces"|"edges"|"face"; key; label; }   // readout + "Use selected" via faceSelectorFor/edgesSelectorFor
 | { kind:"feature"; key; label; ops:string[] }  // like PatternProps seeds
 | { kind:"bodies"; key; label } | { kind:"custom"; render(ctx): ReactNode };
export const FEATURE_FIELDS: Record<string, FieldSpec[]>;
```

- Put a `<FeatureForm spec f resolved before view selection update setError/>` in a new `src/ui/props/FeatureForm.tsx`, and keep the existing hand-written Props components as `custom` entries.
- `path` specs must build the whole nested object, because patches are shallow.
- Add `key={featureId}` to the panel mount (`App.tsx:1544`).

---

## 5. `Viewport.tsx` (868 lines) and `cadControls.ts`

### 5.1 Structure

- One `useEffect([])` at 149-665 builds an imperative world and exposes `api.current: ViewportApi` (111-131): `setModel`, `setHiddenBodies`, `setSelection`, `setSketchesVisible`, `setNodes`, `setUnderlay`, `setGhost`, `fitPhoto`, `fit(dir?, up?)`, `normalTo`, `turn`, `pan`, `zoom`, `roll`, `dispose`. React props drive it through small effects at 667-693 and 741-744. **New viewport features follow this pattern: a method on `ViewportApi` plus a prop and an effect.**
- Renderer: `WebGLRenderer({antialias, alpha, preserveDrawingBuffer:true})` (151); a perspective camera with fov 35, Z up (156-157). Lights are a hemisphere light plus camera-space key and fill lights (159-169).
- Scene groups (171-177): `helpers` (grid, axes), `photoGroup`, `model` (the mesh plus `edgeLines`), `overlays` (sketch polylines), `marks` (selection and hover), `nodeGroup`, plus `pivotGroup` (221).
- Render on demand only: `render()` (216) is called from controls `changed`, resize and every setter. There is no animation loop, so anything animated must call `render()` itself or add a loop.
- `setModel(v)` 350-414:
  - Builds a `BufferGeometry` from `v.mesh.positions/normals/indices`.
  - `surface(color, visible)` makes a `MeshStandardMaterial({metalness .15, roughness .55, polygonOffset 1/1, visible})`.
  - With several bodies it uses one material per body through `g.addGroup` (369-376, `BODY_COLORS` at 73, also used by `BodiesPanel.tsx:64`). With one body it reads the CSS `--part` colour.
  - Edges are one `THREE.LineSegments` with `LineBasicMaterial(--edge)`, skipping seams and hidden bodies (382-395).
  - Sketch overlays use hard-coded colours (orange 0xf28c28, construction dashed grey, red if failed), `depthTest:false`, opacity 0.55 (399-411).
  - **Every call throws away and rebuilds everything** (`setHiddenBodies` → `setModel` at 621-624).
- `fatMaterials` (267-270): shared `LineMaterial` objects for select, hover and scale lines. Their resolution is updated in `resize` (248), and `disposeGroup` skips them (254-265).
- Commands: `viewCommands` (709-736) is registered with `useCommands` (737) and exported through `commandsRef` for context menus (738). Buttons at 749-778: quick views, a Views popup, Fit, and the Sketches toggle (`showSketches` 145).
- **e2e hook** (550-570, only with `?e2e`): `window.__cocaideViewport = { project(p), camera(), photoPoint(px) }`. Extend this for new tests (for example `clip()` or `displayMode()` readouts).
- `CadControls` (`cadControls.ts`) is attached to the canvas *before* the Viewport's own pointer listeners (constructor 223 versus listeners 544-547). Gestures (`gestureFor` 150-155): middle drags rotate / Ctrl pan / Shift zoom / Alt roll; right drags pan; left only rotates in the trackpad scheme or on touch. A middle click sets the pivot; a double middle click fits. Public API: `place`, `turn`, `roll`, `pan`, `zoom`, `worldPerPixel`, `axes`, `target`.

### 5.2 Where each new viewport feature goes

| Feature | Where and how |
|---|---|
| **Display modes** (shaded+edges, shaded, wireframe, hidden lines removed, hidden lines visible) | Keep refs to the surface materials and `edgeLines` from `setModel`, and add `setDisplayMode(m)`. Wireframe: `material.visible=false`; the raycast still hits it, since `Mesh.raycast` ignores visibility, which is acceptable. Hidden lines removed: mesh with `colorWrite=false` (depth only) plus edges with depth test. Hidden lines visible: a second dashed edge pass with `depthFunc=THREE.GreaterDepth`. Add a `.view-buttons` popup like the Views menu (779-811) and `view.display.*` commands in `COMMANDS` (group "View"). |
| **Section view** | `renderer.localClippingEnabled = true`; set `clippingPlanes=[plane]` on the surface, edge, `faceMesh` and overlay materials. `LineMaterial` and `LineSegments2` accept `clippingPlanes` too. Use `side: DoubleSide` or stencil caps, otherwise the cut is see-through. **`pickAt` (480) must skip hits on the clipped side** (`plane.distanceToPoint(hit.point) < 0`). Add `setSection({normal, offset} \| null)`, a draggable offset (see Drag handles below), and a toolbar or view-button toggle. |
| **Measure tool** | Pure maths from `view.faces` / `view.edges` / `selection` (parallel planes: offset difference; edge length and radius; point to point; angles between `normal`/`direction`). Put it in `src/ui/measure.ts` (node-testable). Draw it in a new `measureGroup` (fat lines with `depthTest:false`) plus an HTML label, as `node-labels` does (199-215, moved on every `render`), or as a chip like `SelectionChip`. |
| **Feature preview while editing** | Today an edit *is* a commit, followed by a rebuild. For transient previews (drag handles, a PropertyManager with OK/Cancel), add `preview: {id, patch} \| null` in App and fold it into `shown` (149): `shown = previewDoc ?? applyPreview(parsed.value, preview)`. Dispatch once on release or OK. The rebuild debounce and ticketing (235-257) already drop stale results, but **the worker queue is serial with no cancellation** (`kernel.worker.ts:108-131`), so throttle. SOLIDWORKS-style picking during an edit needs the model *before* the feature (§6) with a ghost of the result. |
| **Drag handles (Instant3D arrows)** | A `handles` group of arrow meshes with `depthTest:false`. Hit-test them *before* `pickAt` in `onDown` (525). Dragging means projecting the pointer ray onto the handle's axis line. Report `onHandle(id, value, phase)`. **CadControls sees `pointerdown` first** and rotates on a left drag in the trackpad scheme, so add a hook such as `hooks.claim(x,y): boolean` checked in `CadControls.onDown` (157). Use `setPointerCapture`, as CadControls does at 170. |
| **Zoom to selection** | `fit(dir?, on={center,radius}, up?)` (288-296) already accepts any sphere. Add `fitTo(sel)`: a bounding sphere of the selected faces' vertices (`faceRanges` into `mesh.geometry` positions) or of `EdgeInfo.start/end`. Add a `view.zoomSelection` command and context-menu `viewCmd` entries next to "Zoom to fit" (`App.tsx:992, 998`). |
| **Datum planes, axes, origin triad** | A new group like `nodeGroup`. It needs to be pickable (extend `PickTarget`), shown with Sketches or its own toggle, and wired into context menus (§1.5). |
| **Appearances or face colours** | `surface()` at 366 and the per-body group split at 370-377. Colours are hard-coded (73-80, 402); only `--part`, `--edge` and `--grid-*` come from CSS, through `cssColor` (106), and are read when the model is built. |
| **Keep the camera when the viewport mounts again** | Lift `{position, target, up}` into an App ref (`commandsRef`-style), or keep `<Viewport>` mounted and hidden during sketch mode. This is also needed for "sketch in the 3D context" later. |

`Viewport.tsx` is already 868 lines. Put new viewport parts in `src/ui/viewport/*.ts`, as factories that take `{scene, camera, render, controls}`, so the main effect only wires them together.

---

## 6. `FeatureTree.tsx` and a rollback bar

- The tree (`FeatureTree.tsx`, 206 lines) supports drag reorder: `draggable` `<li>` with a `dragging` id and `dropAt` index (68-93); drop dispatches `reorderFeature`. It has row actions (suppress, up, down, delete, 141-175), errors under each row (177-192), double-click to edit a sketch (98), and right-click to `onAsk(target)` (99-103). Status comes from `view.features` (`FeatureStatus {id, op, ok, suppressed?, error?}`, `rebuild.ts:47-55`).
- **Kernel and worker:** no `upTo`. `rebuild(input, oc, opts)` (`rebuild.ts:104`) runs every feature, `LocalKernel.built(doc)` (`src/ask/kernel.ts:75-83`) caches **one** rebuild keyed by `geometryKey(doc)` (`src/doc/drawing.ts:277`), and the worker's `rebuild` reuses that cache (`kernel.worker.ts:45-47`).
- **Recommended rollback design (UI only):**
  1. App state `rollback: number | null`, or the id of the first rolled-back feature; ids survive reorders.
  2. `shownForRebuild = rollback == null ? shown : {...shown, features: shown.features.slice(0, rollback)}`. Keep `shown` itself, the drawing, export (`parsed.value`) and ask (`doc`) on the full document.
  3. Tree: a draggable `<li className="rollback-bar" data-testid="rollback-bar">` at that index. Give its `dataTransfer` its own MIME type so the reorder `onDrop` (87-92) can tell the two drags apart. Grey out the rows below it; they have no status entry, so today they would render as "ok" (64-66). Add context-menu items "Roll back to here" and "Roll to end".
  4. New features while rolled back: `create()` must pass `{type:"addFeature", feature, index: rollback}` (the `index?` field already exists, `commands.ts:39`) and then increment `rollback`. `sketchFor()` (595), `extrude()`'s body logic (604) and `patternFeature` must look only at `features.slice(0, rollback)`.
  5. Cache cost: switching between the rolled-back document (view) and the full document (export, ask, drawing projection) rebuilds every time. Turn `LocalKernel.last` into a 2–3 entry LRU (`src/ask/kernel.ts:61, 75-83`), disposing results that are evicted.
  6. Saving the rollback position in the file would need the `validate.ts:136` whitelist plus format/schema changes. Keep it UI state first.
- The same slice gives the "model before this feature" for picking while a feature's PropertyManager is open.

---

## 7. Sketcher

### 7.1 `SketchMode.tsx` (807 lines)

- `TOOLS: [Tool, label, commandId][]` at 55-63: select, dimension, line, rect, circle, arc, slot.
- The `Tool` type is `"select"|"dimension"|SketchEntity["type"]` (`SketchCanvas.tsx:12`). Drawing tools are tied to entity types through `CLICKS` (`draft.ts:458`), `entityFromClicks` (`draft.ts:422-455`) and the point-name map in `finishPlacement` (`SketchCanvas.tsx:146-181`).
- Draft state: `draft {entities, constraints}`, `past`/`future` (200-step undo inside the sketch), `live` (drag preview).
  - `commit()` 87.
  - `setConstraints()` 125 (`solveSketch`, refused if unsolvable).
  - `addConstraint()` 136 (checks `wouldOverDefine`).
  - `setDimension(i, v)` 145 (an `=expr` is kept as `expr` beside the value and written back by `finish` at 229).
  - `onCreate(entity, inferred)` 165 (tries all inferred relations, then coincident only, then none).
  - `onDrag` 183 (re-solves with `drag` from `dragBase`).
  - `deleteSelection` 204, `toggleConstruction` 213, `finish` 226 → `onFinish(feature, weldment)` → `App.finishSketch` (408): `addFeature`, or `replaceFeature` through `restoreExpressions`.
- Keys: `useCommands({undo, redo, delete, shortcutBar, "sketch.construction", "sketch.finish", ...TOOLS})` at 239-247. Escape and Backspace are handled at 248-269.
- Status: `sketchStatus` and `measureConstraint` (272-284) produce the free/defined/conflict sets. `buildProfile` shows the profile status (286).
- Offers: `suggestions(entities, selection)` (288-293, `draft.ts:158`) feed the "Add relations" buttons (`relation-buttons`, testIds `c-*`) and the valued `Offer` rows (620-672). Smart Dimension: `onDimension` → `smartDimension()` (`draft.ts:296`) → `ModifyBox` (679-778; `modify-box`, `modify-value`, `modify-ok`, options `modify-c-distance…`).
- Context menu `openMenu(target, x, y)` (305-396), with targets `null`, `constraint`, `entity` or `point`. Tool entries use `testId: ctx-tool-${t}`; others are `ctx-edit-dimension`, `ctx-delete-constraint`, `ctx-construction`, `ctx-delete`, `ctx-dimension`, `ctx-c-*`, `ctx-finish`, `ctx-relations`.
- Toolbar JSX: 401-455, with the sketch shortcut bar at 425-454 (`bar-${t}`). Right panel: 501-615 (`sketch-dof`, `sketch-weldment`, `profile-status`, `sketch-message`, `constraint-list` / `constraint-row-i` / `constraint-value-i`, `finish-sketch`, `cancel-sketch`).

### 7.2 `SketchCanvas.tsx`

- An SVG in sketch-plane millimetres. The world `<g transform="scale(1,-1)">` (399) holds the grid, axes, `ReferenceLines`, entities (`data-entity`, classes `free|defined|conflict|construction|selected|hover|related`), handles and snaps. `Annotations` (dimensions `dim-i`, glyphs `glyph-i` with `data-relation`) sit outside the flip.
- Gestures (`gesture` ref at 80-87; handlers 183-313):
  - Middle button: pan; Shift+middle: zoom; double middle: fit; right button: pan, or a right-click if it doesn't move.
  - Select tool: drag a handle or entity (`onDrag`), click to select (additive with Shift/Ctrl/Meta), or drag empty space into a box (window or crossing, `boxPick` 642) in the SOLIDWORKS scheme.
  - Drawing tools: one click per point (`CLICKS`); a line chain carries on from its end and closes when it reaches its start (`chainStart` 315).
  - Dimension tool: two picks, or one pick and a click in space, then `onDimension`.
- Snapping and inference: `snap()` 128 (`inferPoint`, then `inferOrientation`, then the grid). The inference icon shows as `infer-<icon>`.
- View keys (`view.fit`, zoom, pan) are registered at 334-342.

### 7.3 Reference edges: the gap the user asked about

- `App.projectEdges(view, plane)` (1688-1702) flattens **every** non-seam model edge, whether it lies on the plane or not, into a bare `Float32Array` of 2D segment pairs. **Edge identity is lost.**
- `SketchCanvas` draws it as one non-interactive `<path className="reference">` (`ReferenceLines` 482-489). `itemAt` (139), `hitEntity` and `smartDimension` only know `entities`, so nothing can snap to, relate to or dimension a model edge.
- Least invasive route:
  1. Pass structured references, e.g. `RefEdge {edge:number; kind:"line"|"circle"|"other"; pts:Vec2[]; line?:[Vec2,Vec2]; circle?:{c:Vec2,r:number}}`, built from `view.edges[i]` and the segments in `view.mesh.edgeRanges`.
  2. Add a `SketchItem` kind `{kind:"ref"; edge:number}` (`draft.ts:9`) and hit-testing in `itemAt` and `inferPoint`.
  3. When a reference is used in a relation or dimension, *materialise* it as a construction entity with `fix` plus a document field such as `ref: EdgeSelector` (built with `edgeSelectorFor`) that the kernel re-projects on rebuild. The solver, `smartDimension`, `annotate` and the validator then see an ordinary fixed entity. The same mechanism gives Convert Entities and Offset Entities from model edges.
  4. Only project edges that lie on, or are silhouettes against, the sketch plane, or draw others dimmer.
- **Recommended sketch tool registry** before adding trim, extend, offset, fillet, chamfer, mirror, pattern, polygon, spline, points, centreline and so on:
  ```ts
  interface SketchToolDef {
    id: string; label: string; icon: IconName; command: string;
    kind: "draw" | "pick" | "select";
    clicks?: number; build?(pts: Vec2[]): SketchEntity | null;
    apply?(draft: DraftState, picks: SketchItem[], at: Vec2): DraftState | string;
  }
  ```
  Put it in `src/ui/sketcher/tools.ts`, a pure and testable module. Have `SketchMode`'s toolbar, shortcut bar, context menu and `useCommands` loop over it instead of the tuple list at 55-63.

---

## 8. Styles, icons, primitives and commands

### 8.1 `styles.css` (1010 lines, appended phase by phase)

- Tokens:
  - `:root` at 1-26 (dark mode at 28-49): `--bg --panel --panel-2 --border --text --muted --accent --accent-2 --ok --bad --bad-bg --info-bg --viewport-top --viewport-bottom --part --edge --grid-major --grid-minor --mono`.
  - Phase B tokens at 198-212: `--sketch --sketch-construction --sketch-selected --sketch-hover --reference --selected-row`.
  - Relations tokens at 924-939: `--sketch-defined --sketch-dim --glyph-bg --glyph-border --glyph`.
  - Always give a dark-mode value in the `@media (prefers-color-scheme: dark)` block that follows.
- Section banners (`/* ===== Phase X */`) mark eras. **Add a new banner block at the end for the new work.**
- Layout and classes:
  - Grid `.workspace` is 290px / 1fr / 420px (98), with `.no-left` at ~905 and breakpoints at 1100 and 1360px.
  - Toolbars: `.toolbar` / `.sketch-toolbar .tool` (689-700). They wrap rather than scroll, because scrolling would clip menus. **Many new tools will wrap onto two rows; group them into ToolMenus or command-manager tabs** (Features | Sketch | Evaluate, a tablist like `.tabs` at 250-255).
  - Properties: `.properties .prop-header .prop-body .prop-actions .field .field-label .field-input .field-hint .vec .direction .inline .check .readout .command-error` (259-292).
  - Popups and menus: `.popup .popup-bar .menu-items .menu-key` (865-883), `.context-menu .context-title .context-heading .menu-sep` (998-1002).
  - While sketching, the tree is dimmed: `.app.sketching .side.left .features` (352).

### 8.2 `icons.tsx`

`const ICONS = { name: <path d="..."/> | <>...</> , ... } satisfies Record<string, ReactNode>` (13-~205). `IconName = keyof typeof ICONS`, and `<Icon name size? className? x? y?/>` (209-226) draws on a 24-unit grid, stroke `currentColor`, width 1.75.

- To add one, add a key with an SVG fragment (the helpers `dash` and `face` and the constant `CUBE` are at 8-11). The type updates on its own.
- Existing names: undo redo new open save export examples settings ask model drawing sketch extrude cut hole fillet chamfer pattern linearPattern circularPattern mirror combine split move deleteBody trash joint endCap gusset member iso top front right fit select line rect circle arc slot construction grid dimension balloon note view plus x up down chevron more eye eyeOff suppress check alert info ruler smartDimension horizontal vertical coincident pointOn midpoint parallel perpendicular collinear tangent concentric equal symmetric fix angle diameter radius.
- Icons are decorative (`aria-hidden`); always pair them with a label or an aria-label.

### 8.3 `tools.tsx` and `ContextMenu.tsx`

- `ToolButton({icon, label, title?, onClick?, disabled?, pressed?, testId?})` (19). `onMouseDown preventDefault` keeps keyboard focus away, so Space and Enter stay global.
- `ToolMenu({icon, label, title, testId, disabled, children:(close)=>…})` (30): closes on a click outside or Escape.
- `MenuItem({icon?, label, hint?, shortcut?, onClick, disabled?, testId?})` (67).
- `Popup({x, y, above?, bar?, onClose, label, testId, children:(close)=>…})` (82): positioned in a layout effect and clamped to the window. Use it for any floating panel at the pointer, such as a Modify box, an Instant3D value box or the measure result.
- `ContextMenu.tsx`: `MenuEntry = {label, icon?, shortcut?, hint?, onClick, disabled?, testId?} | {heading} | "sep"`, `ContextMenuState {x, y, title?, items}`, `askEntry(onClick)` (testId `ctx-ask`). It removes leading, trailing and doubled separators (28).

### 8.4 `input.ts`

- `COMMAND_GROUPS = ["General","View","Model tools","Sketch"]` (11). The Settings keyboard table (`ask/AskSettingsDialog.tsx:253-290`, `key-<id>`) renders groups in this order, so a new group (e.g. "Display", "Evaluate") must be added here.
- `COMMANDS` (26-89). Taken keys: Ctrl+S/O/Z/Y, Delete, Enter, S, F9; Ctrl+1..8, Space, F, Shift+Z, Z, the arrows with and without Shift/Ctrl/Alt; sketch V D L R C A O Q Ctrl+B. Model tools have no keys by default.
- `clashes(a, b)` (161): **only "Model tools" and "Sketch" may share a key.** `tests/input.test.ts` ("puts no two live commands on one key") fails on any other duplicate.
- `useCommands(handlers, enabled)` (210-234): skips repeats except arrows and Z, skips typing in fields except save and open, and skips when `.modal-backdrop` exists. `keyFor`, `keyHint` (" (Ctrl+7)") and the `pointer` position (237) are what popups at the cursor use.

---

## 9. e2e conventions

- Config (`playwright.config.ts`): runs the production build (`vite build && vite preview :4173`), Chromium with SwiftShader WebGL, a 1500×900 viewport, one worker, 120 s test timeout, 20 s expect timeout.
- Helpers in `e2e/helpers.ts`:
  - `openApp(page)` loads `/?e2e`, clears localStorage, reloads and waits for a rebuild. It returns a `problems[]` list of page errors and console errors; specs assert it is empty in `afterEach` (`modelling.spec.ts:16-18`).
  - `waitForRebuild` waits for `status` to match `/^(Rebuilt|\d+ errors?|No solid yet)/`.
  - `expectVolume(page, "18,994.728")` checks the `volume` text prefix.
  - `sketchClick(page, x, y)` maps sketch millimetres to pixels through the `[data-testid=sketch-canvas] > g` screen CTM. Use multiples of 10 so grid snap keeps points exact.
  - `viewportClick(page, [x,y,z], {shift?})` uses `__cocaideViewport.project`.
  - `commit(page, testId, value)` fills a field and presses Enter.
  - Also `dropFile`, `savedDocument(page)` (reads `cocaide.document.v1`), and `scriptModel` / `useKey` / `text` / `tool` to mock the Anthropic API.
- Typical setup: `page.locator("select").first().selectOption("bracket")` then `expectVolume(page, "18,994.728")`. For an empty part: `new-part` then `status` "No solid yet". Sketch on Top: `tool-sketch`, then `plane-top`.
- **testId naming:**

  | Thing | Pattern |
  |---|---|
  | Model toolbar | `tool-<kebab>` (`tool-linear-pattern`, `tool-delete-body`) |
  | Sketch toolbar | `tool-<Tool>` (`tool-line`, `tool-dimension`, `tool-select`, `tool-relations`); never shown with the model toolbar |
  | Shortcut bar | `bar-tool.<id>` (model), `bar-<tool>` (sketch) |
  | Context menus | `context-menu`; `ctx-tool.<id>` (model, dot), `ctx-tool-<t>` (sketch, hyphen), `ctx-view.<id>`, `ctx-<action>` |
  | Properties | `prop-<field>`, nested `prop-<feature>-<field>`, `Vec3Input` adds `-x/-y/-z` |
  | Tree | `feature-<id>` (click `.feature-row`), `feature-error-<id>` |
  | Viewport | `viewport`, `selection`, `view-menu-open`, `view-<name>`, `view-normal` |
  | Sketch | `sketch-canvas`, `dim-<i>`, `glyph-<i>`, `c-<relation>`, `c-<dim>-value`, `modify-*`, `constraint-row-<i>`, `constraint-value-<i>` |
  | Panels | `measurements`, `volume`, `mass`, `holes`, `bodies`, `body-<name>`, `notice`, `status`, `command-error` |
- Shared CAD actions belong in `helpers.ts`; spec-local helpers (like `screenAt` and `ctrlClick` in `sketch-relations.spec.ts:19-33`) are fine for one-offs. Domain helpers can get their own file (`e2e/sections.ts`).

---

## 10. Risks and how to split `App.tsx`

1. **`App.tsx` is a 1707-line god component.** Every tool closes over local state, and `TOOLS` is rebuilt on each render. Adding ~30 tools inline will make it unreadable and conflict-prone. Suggested split, with the behaviour kept the same:
   - `src/ui/model/ToolContext.ts`: `interface ToolCtx { doc; view; selection; selected; resolved; features; run; create; notice(kind, text); setSelection; startSketch; rollback? }`, built once per render in App.
   - `src/ui/model/tools/*.ts`: pure `ToolDef { id; icon; label; group; menu?; title; disabled?(ctx); run(ctx) }` modules (`features.ts`: extrude, cut, revolve, sweep, loft, shell, draft, rib…; `bodies.ts`; `reference.ts`: planes, axes; `evaluate.ts`: measure, section). Most functions that build a feature (`extrude` 598, `hole` 621, `edgeFeature` 644, …) only read context, so they move across almost unchanged and become unit-testable in node.
   - `src/ui/model/ModelToolbar.tsx`: render groups, tabs and `ToolMenu`s from the registry instead of the hand-written JSX at 1232-1323. Shortcut bar, context menus and `useCommands` all read the same registry. Have a unit test check that every `ToolDef.id` is in `COMMANDS`, has a valid icon, and has a unique testId.
   - `src/ui/model/contextMenu.ts`: move the menu builder at 938-1045 here as a pure `(target, ctx) => MenuEntry[]`.
   - Hooks: `useRebuild(kernel, shown, rollback)` (235-257), `useWeldmentLibrary` (127-132, 211-224, 427-593), `useDrawing` (135-137, 259-279, 716-785), `usePhoto` (156-209). This leaves `App` as layout plus wiring.
2. **Selection is cleared on every rebuild** (`App.tsx:245`). Live preview plus pick workflows need pre-feature picking (rollback slice) or selection stored as selectors, re-resolved after the rebuild through `kernel.port.select`.
3. **Every edit is an undo step and a rebuild.** Drag handles and spinners must preview through transient state and commit once (§5.2). The worker queue is serial with no cancellation.
4. **Shallow `updateFeature` patches.** Nested fields must send the whole object. A `null` value deletes a key, so editors must never send `null` for "zero".
5. **The worker caches one rebuild** (`src/ask/kernel.ts:61`). Rollback or preview documents alternating with the full document thrash it; add a small LRU.
6. **Viewport remount** resets the camera after every sketch or drawing switch. Fix this before adding sketch-in-3D or section views, which users expect to persist.
7. **Viewport rebuilds all its geometry on `setModel`** and `setHiddenBodies`. Display-mode and section toggles should change materials in place and then call `render()` (there is no render loop).
8. **`PropertyPanel` is not keyed by feature**; add `key={featureId}`. `NumberInput` ignores `step`, and `min` doesn't check expressions.
9. **CSS growth:** add tokens, with dark-mode variants, in a new banner block at the end. Avoid more hard-coded colours in Viewport (`SELECT_COLOR` and the others at 77-80, sketch overlay colours at 402).
10. **Keys:** any default key you give a new command must pass `tests/input.test.ts`. Avoid S, F, Z, Space, Enter, Delete, V, D, L, R, C, A, O, Q and Ctrl+digits for anything outside Model tools and Sketch.