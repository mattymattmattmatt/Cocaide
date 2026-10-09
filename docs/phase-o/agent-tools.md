# Cocaide AI side: map and recommendations (read-only)

## 0. Summary: what limits the agent today

1. **The right-click agent gets about 2 edit turns.** In `src/ask/agent.ts`, `MAX_TURNS = 8` (l.25) and `CORRECTIONS = 1` (l.27). The counter at l.166-167 goes up on every edit turn after the first kept edit, and l.171-172 rejects writes once it passes 1. So after the first turn with a kept edit, only one more turn can write anything; later write calls return `"no more edits in this ask: one correction pass only…"`. A whole new part (`buildOther`, `src/ask/part.ts:391-419`) has to be emitted almost blind in one turn and fixed in one more. `tests/ask.test.ts:140-147` pins this behaviour.
2. **Output and effort are capped.** `max_tokens: 8000` (`src/ask/model.ts:66`) and effort defaults to `"low"` (`model.ts:58`, `src/ui/ask/settings.ts` `loadSettings`). A large batch of tool calls hits `max_tokens`, and `agent.ts:161-164` then throws the whole turn away.
3. **Tool results are thin, so the model edits blind:**
   - `addEntity` never returns the generated entity id: `commands.ts:639` `nextEntityId`, `session.ts:273-274`, `agent.ts` `edit`.
   - `addConstraint` never returns its index, yet `setDimension` and `deleteConstraint` address constraints by index, and indices shift on delete (`commands.ts:656-661`).
   - Sketch edits in the right-click agent return no DOF or profile status. `localMeasurements` (`agent.ts:505-516`) only copies distance, diameter, depth, radius, count, spacing and center.
   - `getFeature` in the right-click agent returns raw JSON only (`agent.ts:298-303`). The MCP version adds status and resolved values (`session.ts:419-427`).
4. **No topology listing, no measuring between entities, no image after an edit in the right-click agent, no batching, no preview.**
   - `measure(selector)` returns at most 20 faces or edges, with no selector for each one (`agent.ts:321-323`, `session.ts:465-473`).
   - The right-click agent sees one picture before it starts, and only for "visual" prompts (`framedShot`, `agent.ts:602-616`; `isVisual`, `prompt.ts:23-27`).
5. **The reference is wrong for the right-click host.** `SYSTEM` embeds the whole `REFERENCE` (`prompt.ts:160-161`), including the MCP `## Tools` section (`reference.ts:169-183`). That section lists tools the right-click agent does not have: `listFeatures`, `reorderFeature`, `deleteParameter`, `rebuild`, `validate`, `screenshot`, `export*`, `newDrawing`, `drawing`, `undo`/`redo`, `saveBody`, `renameNode`.
6. **Sketch frame conventions are easy to get wrong and are not spelled out.** Sketch planes are numeric datums only (`types.ts:362-367`). A sketch on a face has to match the face's normal and offset to 1e-6 (`agent.ts:386-392`). Hole centres use a projected-origin face frame (`reference.ts:69`, `geom/frame.ts:29-33`).
7. **Planners only cover plates, discs and frames.** `KINDS = ["plate","disc","frame","other"]` (`intent/constants.ts:5`). `planPart` only plans plate and disc (`plan.ts:46-47`). "other" goes to the 2-edit-turn agent, and the critic then only checks "rebuilds" and "one solid" (`part.ts:406-409`).

---

## 1. Architecture: two separate tool hosts

| | Right-click agent (browser) | MCP server (Node, stdio) |
|---|---|---|
| Entry | `runAsk` (`src/ask/agent.ts:107`); `runPartAsk` (`src/ask/part.ts:136`) for empty space | `main` (`src/mcp/server.ts:249`), then `AgentSession.open` |
| Tool definitions | Anthropic `Tool[]` arrays in `src/ask/prompt.ts:166-282` | zod `TOOLS` record in `src/mcp/server.ts:33-179` |
| Dispatch | `Sandbox.run` (`agent.ts:292-312`) → `toCommand` (`agent.ts:459-502`) → `Sandbox.edit` (`326-370`) | `AgentSession.run` (`src/agent/session.ts:219-304`) → `edit` (`309-335`) |
| Kernel | `KernelPort` (`src/ask/kernel.ts:46`): `check`, `topology`, `select`, `screenshot`, `project`. Worker-served via the generic `port` message (`worker/kernel.worker.ts:51-54`, `worker/client.ts:57-63`) | Direct OCCT: `rebuild`, `selectOn`, `shotOf` (`session.ts:28-29`) |
| Transaction | `apply()` with writeScope → `kernel.check` → `newFailures` → keep or roll back. Result is a proposal, never applied directly | `apply()` → `rebuild` → `newFailures` → commit revision, save file, log |
| Edit result | `{ok, volume, errors?, features:[{id, …localMeasurements}]}` (`agent.ts:366-369`). Drawing edits: `{ok, annotation?, checks}` | `{ok, changed, revision, hash, volume \| solid:false, errors?}` (`session.ts:362-369`); `addFeature` adds `id` (`228`) |
| Docs to model | `SYSTEM` (`prompt.ts:140-161`) = rules + `REFERENCE` | `INSTRUCTIONS` (`reference.ts:4-12`) + resource `cocaide://reference` (`server.ts:194-199`) + `cocaide://document` |

Both hosts share `apply` (`src/doc/commands.ts:97`), `scopeProblem` (`src/doc/scope.ts:34`), validation (`src/doc/validate.ts:128`) and `src/kernel/inspect.ts` (`faceSummary` l.23, `edgeSummary` l.36, `measurementSummary` l.44, `selectOn` l.85, `topologyOf` l.102, `shotOf` l.123).

---

## 2. Exact tool lists today

### 2a. Right-click agent (`src/ask/prompt.ts`), 21 tools

Every schema has `additionalProperties:false`. `any` means `{type:"object"}`.

| Group (lines) | Tool | Input |
|---|---|---|
| READ_TOOLS (166-182) | `measure` | `{selector?: object}` |
| | `getFeature` | `{id: string}`. Outside wide or part mode, limited to target, parent, children and owned ids (`Sandbox.context`, `agent.ts:276-290`) |
| | `escalate` | `{reason: string}` |
| FEATURE_TOOLS (184-230) | `updateFeature` | `{id: string, patch: object}` |
| | `addFeature` | `{feature: object, index?: integer}` |
| | `suppressFeature` | `{id: string, suppressed: boolean}` |
| | `deleteFeature` | `{id: string}` |
| | `setParameter` | `{name: string, value: number}` |
| | `renameBody` | `{from: string, to: string}` |
| | `setNode` | `{name: string, at: (number\|string)[] \| null}` |
| | `setBodyMaterial` | `{body: string, material: object \| null}` |
| | `setWeld` | `{id: string, weld: object \| null}` |
| SKETCH_TOOLS (232-263) | `setDimension` | `{sketch: string, index: integer, value: number\|string}` |
| | `addEntity` | `{sketch: string, entity: object}` |
| | `updateEntity` | `{sketch: string, id: string, patch: object}` |
| | `deleteEntity` | `{sketch: string, id: string}` |
| | `addConstraint` | `{sketch: string, constraint: object}` |
| | `deleteConstraint` | `{sketch: string, index: integer}` |
| DRAWING_TOOLS (265-282) | `setAnnotation` | `{id: string, annotation: object \| null}` |
| | `setView` | `{id: string, view: object \| null}` |
| | `setSheet` | `{patch: object}` |

`WRITE_TOOL_NAMES` (l.284) is built from FEATURE + SKETCH + DRAWING. `toolsFor(mode, kind, wide)` (l.293-298) decides which tools are offered:
- explain → READ_TOOLS; only `[escalate]` for a drawing target that isn't wide.
- edit + wide → READ + FEATURE + SKETCH, plus DRAWING when `doc.drawing` exists.
- edit + drawing target → `[escalate]` + DRAWING.
- other edits → READ + FEATURE + SKETCH. A `target.kind === "part"` ask is not "wide" (`agent.ts:122`), so it never gets the drawing tools.

Other relevant pieces:
- `classify` (l.15-20): question vs edit.
- `scopedActions` (l.37-138): the chips under the prompt box.
- Wide mode (`reach:"part"`, which is the UI default in `settings.ts`) sets `writeScope=["*"]` and puts `partOutline` in the packet (`agent.ts:124-128`; `packet.ts:361-373`).

### 2b. MCP server (`src/mcp/server.ts:33-179`), 35 tools and 2 resources

```
listFeatures()                                   [readOnly]
getFeature({id})                                 [readOnly]
addFeature({feature: record, index?: int})       → result.id
updateFeature({id, patch: record})
deleteFeature({id})
reorderFeature({id, index: int})
suppressFeature({id, suppressed: bool})
setParameter({name, value: number})
renameBody({from, to})
setNode({name, at: (number|string)[3] | null})
renameNode({from, to})
setWeld({id, weld: record | null})
deleteParameter({name})
setDimension({sketch, index: int, value: number|string})
addEntity({sketch, entity: record})
updateEntity({sketch, id, patch: record})
deleteEntity({sketch, id})
addConstraint({sketch, constraint: record})
deleteConstraint({sketch, index: int})
rebuild()                                        [readOnly]
validate()                                       [readOnly]  schema + rebuild + selectorHealth (agent/health.ts:24)
measure({selector?: record})                     [readOnly]
exportSTEP({file?}) / exportSTL({file?})
screenshot({view?, direction?: vec3, up?: vec3, highlight?: selector, hiddenEdges?: bool, width?: int, height?: int})  [readOnly] → text + PNG
setBodyMaterial({body, material: record|null})
saveBody({body, file?})
newDrawing({date?})
setSheet({patch}) / setView({id, view|null}) / setAnnotation({id, annotation|null})
drawing()                                        [readOnly]
exportDrawing({format: "pdf"|"svg", file?})
undo() / redo()
resources: cocaide://reference (REFERENCE), cocaide://document (session.text)
```

`session.ts` keeps its own name lists: `EDIT_TOOLS` (l.60-85, which replay re-runs: `agent/replay.ts:6`) and `READ_TOOLS` (l.86). Named views come from `render/raster.ts:11-21`: iso, front, back, right, left, top, bottom, isoBack.

### 2c. Tools only one host has
- **MCP only:** `listFeatures`, `reorderFeature`, `deleteParameter`, `renameNode`, `rebuild`, `validate`, `screenshot`, `exportSTEP`/`STL`, `saveBody`, `newDrawing`, `drawing`, `exportDrawing`, `undo`/`redo`.
- **Right-click only:** `escalate`.

---

## 3. How a new feature op becomes usable by the agent

**What already works without changes.** Both `addFeature` and `updateFeature` take arbitrary JSON (`prompt.ts:191-193` `any`; `server.ts:43-50` `obj`). `apply()` validates the whole document and rejects only errors the command introduces (`commands.ts:450-468`). The transaction then rebuilds. So once `validate.ts` and `kernel/rebuild.ts` support an op, both agents can create it. An unknown op fails with `unknown op … (supported: FEATURE_OPS)` (`validate.ts:332`), which at least shows the model the list.

**The model only learns an op from `REFERENCE`** (`src/mcp/reference.ts:14-184`). For a new op that means a section with a full JSON example, defaults, which body it touches, and how it fails.

**Checklist for a new feature op** (anything skipped fails silently or partly):

| # | Where | Why |
|---|---|---|
| 1 | `doc/types.ts` `Feature` union and `FEATURE_OPS` (l.300-336); `PATTERNABLE_OPS` (l.574) | type and the "supported" list |
| 2 | `doc/validate.ts` `validateFeature` switch (l.280-336) and key list; `BodyNames.check` (~l.1446-1530) if it makes or uses bodies; `selectorBodies` (l.1544) if it holds selectors | strict schema, body bookkeeping |
| 3 | `kernel/rebuild.ts` op switch (l.272-500) | geometry. Provenance (`faceOrigins`) follows automatically |
| 4 | `doc/commands.ts` `references()` (l.746-755) if it names other features (a revolve's sketch, a sweep's path, a loft's profiles, a reference plane id) | `deleteFeature` refusal, `orderProblem`, writeScope "feature id lets you add users", packet `parentsOf` (`packet.ts:405-422`) |
| 5 | `doc/commands.ts` `renameBody` (l.496-550) and `renamedBodies` (l.557) if it holds body names or selectors under keys other than `face`/`edges` | body rename consistency |
| 6 | `doc/scope.ts` `onlyBodies` (l.185-233) | otherwise `body:<name>` asks always refuse it |
| 7 | `agent/health.ts` `selectorHealth` (l.31-37, only hole/fillet/chamfer today) | `validate` selector health |
| 8 | `ask/packet.ts` `featureKind` (l.68), `bodyFeatures` (l.126-138), `featureMeasurements` key list (l.506); `ask/agent.ts` `localMeasurements` key list (l.510; it lacks `angle`) | what the model reads back |
| 9 | `ask/agent.ts` `addRule` (l.377-420) | In "Just this" reach, a face or edge target may only add a hole, fillet, chamfer, or sketch plus extrude/cut (l.419). New ops (shell from a face, draft, offset plane from a face) are refused unless added here |
| 10 | `ask/prompt.ts` `scopedActions` (l.37-138), and SYSTEM rules for gotchas | chips and rules |
| 11 | `mcp/reference.ts` and README "The document" section | the model's knowledge |

**New sketch entity type.** Update:
- `types.ts:420` `SketchEntity`.
- `validate.ts` `ENTITY_FIELDS` and `POINT_NAMES` (l.340-355), plus the `validateEntity` switch (l.452-493).
- `doc/sketch.ts` `ENTITY_PREFIX` (l.58; the compiler enforces this one).
- The solver `FIELDS` and layout (`geom/solver.ts`), `geom/constraints.ts`, and `geom/profile.ts` `buildProfile`.
- `packet.ts` `entityMeasurements` (l.519-532), and the reference's "Entities" and point-ref lists.

**New constraint type.** Update:
- `types.ts:501` `Constraint`.
- `validate.ts` `validateConstraint` (l.495+).
- `doc/sketch.ts` `constraintEntities` (l.7-38). Write-scope checks depend on it.
- Solver equations, constraint check and measure, the UI's `describeConstraint` (`ui/sketcher/draft.ts:379`), and the reference.

**New Command or tool.**
- `commands.ts` `Command` union and the `apply` switch. The default case returns `unknown command` (l.446-447).
- `scope.ts` `scopeProblem`. Its default returns `"writeScope: unknown command"` (l.153-154), so a new command is rejected under any scope other than `*`.
- `agent.ts` `toCommand` (l.459-502), or a special case in `Sandbox.run` (l.294-306) for tools that are not commands.
- `session.ts` `run` (l.219-304) and `EDIT_TOOLS` or `READ_TOOLS`.
- A `server.ts` `TOOLS` entry, the `prompt.ts` arrays, the reference `## Tools` section, and the README table (README l.612-628).

**Tests that pin exact tool lists:**
- `e2e/ask.spec.ts:137` (explain tools `["measure","getFeature","escalate"]`).
- `tests/drafting-ask.test.ts:56-57`.
- `tests/phase-c-acceptance.test.ts:65` uses `toContain`, so it is safe.

---

## 4. Other findings to act on

- `addFeature` id generation is duplicated: `agent.ts` `nextFree` (l.518) and `commands.ts` `nextId` (l.777).
- `AgentSession.built` is rebuilt without provenance (`session.ts:147`), so MCP never knows which feature made a face. The browser `LocalKernel.topology` does know (`ask/kernel.ts:91`, `built(doc, true)`).
- `selectorHealth` rebuilds the document prefix once per feature that holds a selector (`health.ts:39`), so `validate` slows down quadratically on long trees.
- The face selector language only has `planar` and `cylindrical` (`types.ts:745-770`). `faceSelectorFor` refuses cones and other surfaces (`synthesize.ts:38-39`). Once revolve, loft or sweep exist, the agent cannot target their faces or edges except with `near`.
- Sketch constraints cannot reference model geometry: point refs are sketch-local or `"origin"` (`validate.ts` `pointRef`, `geom/constraints.ts:170-175`). This is the user's "reference edges" gap, for the AI as well as the UI.
- `buildOther`'s prompt tells the model to "Rebuild, measure, and stop" (`part.ts:398`). The right-click host has no `rebuild` tool.
- The reference does not mention the sketch `profile` key (`validate.ts:360`), or that patterns accept `member` (`types.ts:574`; the reference says "extrude, cut or hole").

---

## 5. Recommended new agent tools

Build each one once, in a browser-safe module such as `src/ask/tools/` (pure functions over `(doc, KernelPort)`), and wrap it in both hosts. `AgentSession` can make a `LocalKernel(() => this.oc)` (`ask/kernel.ts:60`; it already runs in Node in the tests). A new `KernelPort` method needs three things: the interface (`ask/kernel.ts:46`), `LocalKernel`, and `worker/client.ts` `port` (l.57-63). The worker dispatch picks it up by itself (`kernel.worker.ts:52`).

### 5.1 Inspection (read-only; offer to explain mode too, then update the pinned tests)

1. **`listFaces({body?, madeBy?, type?: "plane"|"cylinder"|"cone"|"other", normal?: vec3, limit?: int=40})`** returns `[{selector, type, area, centroid, normal?, offset?, radius?, axis?, concave?, body?, madeBy}]`.
   - Built from `topologyOf` (`inspect.ts:102`), `faceOrigins` (a provenance rebuild) and `faceSelectorFor` (`synthesize.ts:15`).
   - Every row comes with a selector that is guaranteed to pick only that face, so the model never writes one by hand.
2. **`listEdges({body?, madeBy?, kind?, onFace?: selector, limit?})`** returns `[{selector, kind, length, start, end, radius?, center?, between:[{type, madeBy}]}]` via `edgeSelectorFor` (`synthesize.ts:49`).
   - Also add an `edgesSelector({edges:[selector…]})` wrapper over `edgesSelectorFor` (l.91), so "every edge like it" turns into one robust selector.
   - Optional: compute a `convex: bool` dihedral flag in `topology.ts` `describeEdges`, so the model can "fillet outside edges".
3. **`measureBetween({a, b})`**. Each of `a` and `b` is a face or edge selector, a world point `[x,y,z]`, or `{sketch, point:"l1.end"}`. Returns `{distance, pointA, pointB, angleDeg?, parallel?, axisDistance?}`.
   - Use analytic shortcuts from `FaceInfo` and `EdgeInfo` where possible: plane to plane offset difference, axis to axis.
   - Otherwise use `BRepExtrema_DistShapeShape`, which is present in `replicad_single.d.ts` (`new oc.BRepExtrema_DistShapeShape(s1, s2, …)`).
   - New `KernelPort.distance(doc, a, b)`.
4. **`getSketch({id})`**, pure with no kernel. Returns:
   - the entities with expressions resolved;
   - constraints as `{index, …k, label: describeConstraint(k), actual, expected, ok}` via `measureConstraint` (`geom/constraints.ts:182`);
   - `dof`, `fullyDefined`, `free` and `freePoints` from `sketchStatus` (`geom/solver.ts:470`);
   - `profile: {closed, regions, area} | {closed:false, problem}` from `buildProfile` (`geom/profile.ts:33`);
   - `frame: {origin, x, y, z}` from `planeFrame` (`geom/frame.ts:20`).
   This replaces counting constraint indices by hand. `describeConstraint` lives in `src/ui/sketcher/draft.ts`; move the pure helpers to `src/geom` or `src/doc` so the browser agent and Node can share them.
5. **`facePlane({face: selector, offset?: number})`** returns `{plane: {type:"datum", normal, origin, xDir}, holeFrame: {origin, x, y}}`, using `kernel.select` with `planeFrame` and `facePlaneFrame` (`geom/frame.ts:20,29`). It makes sketch-on-face pass `addRule`'s 1e-6 check every time, and removes the hole-centre frame confusion.
6. **`screenshot({view?|direction?, highlight?: selector, hiddenEdges?})` for the right-click agent.**
   - `KernelPort.screenshot` already exists (`ask/kernel.ts`); handle it in `Sandbox.run` next to `measure`.
   - Return a `tool_result` whose content array holds an `image` block, instead of `JSON.stringify(out)` (`agent.ts:176`).
7. **`projectEdges({sketch, selector?, inPlaneOnly?})`.** Model edges as 2D lines and circles in the sketch frame (`to2D`, `geom/frame.ts:39`), each with its edge selector. This is what the model needs to place, relate and dimension against "reference edges" once the modelling worker adds reference or converted entities.
   - Companion: **`sectionAt({plane})`**, the solid's 2D loops cut by a plane, via `BRepAlgoAPI_Section` (available).
8. **`reference({section?})`** as an MCP tool. Not every MCP client reads resources (the INSTRUCTIONS tell it to read `cocaide://reference`, `reference.ts:11`). It would also let the right-click SYSTEM stay short and load op sections on demand.

### 5.2 Authoring helpers

9. **`batch({commands: Command[]})`.** All-or-nothing: apply each command in order, rebuild once, check `newFailures` once. Returns per-command `{ok, id?, entity?, index?}`.
   - It counts as one edit turn in the right-click loop, cuts MCP latency (each edit rebuilds the whole part, `session.ts:321`), and gets rid of half-built states such as a sketch without its extrude.
   - Implement in `AgentSession.edit` and `Sandbox.edit`, add it to `EDIT_TOOLS` so it replays, and in `scopeProblem` check each inner command.
10. **`sketchProfile({sketch, segments, closed?: true, construction?: false, relations?: "auto"|"none", dimensions?: "none"|"lengths"|"full", anchor?: "origin"|PointRef})`**, where each segment is `{to:[x,y]}`, `{arcTo:[x,y], tangent:true}` or `{arcTo, center}`, starting from a `start:[x,y]`.
    - Expands into lines and arcs with predictable ids, a `coincident` at every joint, `horizontal`/`vertical` within a tolerance (reuse `inferOrientation`, `draft.ts:369`, after moving it to `geom`), and `tangent` where flagged. With dimensions it adds lengths and anchors the start point to the origin.
    - Solve once, then return `{entities, constraints:[indices], dof, freePoints, profile}`.
    - Apply as one `updateFeature` with new `entities`/`constraints`; the `<sketch>/*` scope allows that via `onlyContentsChanged`, `scope.ts:169`. Or add a `setSketchContents` command.
    - The UI's polyline tool can reuse the same function.
11. **`fullyDefine({sketch, anchor?: "origin", scheme?: "baseline"|"chain"})`**, SOLIDWORKS-style "Fully Define Sketch".
    - Greedy over `sketchStatus.freePoints`: try orientation relations, then `distanceX`/`distanceY` from the anchor at their current values, keep each one that `wouldOverDefine` (`solver.ts:449`) does not refuse, and stop at dof 0.
    - Pure; shared with a UI button. Today the "Fully define this sketch" chip (`prompt.ts:41`) leaves it all to the model.
12. **`sketchOnFace({face: selector, offset?, entities?})`** creates a sketch whose plane is computed by `facePlane`. If the modelling worker adds `plane: {type:"face", face: selector}` or `{type:"ref", plane:"<id>"}` to `DatumPlane`, switch to that (parametric), and make `addRule` (`agent.ts:383-393`) compare selectors instead of numbers.
13. **Reference planes** (once the op exists): `addPlane({type:"offset"|"angle"|"midplane"|"threePoints"|"normalToEdge", …})` as a thin wrapper over `addFeature`, plus a `listPlanes()` that returns ids and frames. Without an op, `facePlane` covers most of the need.
14. **`preview({commands})`.** The same as `batch`, but it never commits. Returns `{ok, errors, volume, bbox, newFaces, png?}`. In MCP it is `edit()` without `commit`; in the browser it is the Sandbox on a cloned document. It lets the model check selectors and geometry without spending a correction turn.
15. **Fix return values on the existing tools:**
    - `addEntity` should return `{entity: id, solved: entity}`.
    - `addConstraint` should return `{index}`.
    - Every sketch command should return `getSketch`'s `{dof, fullyDefined, freePoints, profile}`. For the right-click host, export `sketchMeasurements` (`packet.ts:488`) and call it from `localMeasurements` (`agent.ts:505`) when `f.op === "sketch"`.
    - `measure(selector)` should include a `selector` per match.
    - Longer term, give constraints an optional stable `id` (validate keys, `setDimension` and `deleteConstraint` accept id or index).
16. **Right-click sandbox `undo`.** Keep a stack of sandbox documents and pop the last kept command, so the model can back out without spending its correction.

### 5.3 Loop budget (`src/ask/agent.ts`)

- Add a budget per mode:

  ```ts
  budgetFor({reach, target, emptyDoc}) => { maxTurns, editTurns, maxTokens, effort }
  ```

  - **"surgical"** (reach `target`): keep 8 turns and 1 correction, so `tests/ask.test.ts:140` stays green.
  - **"build"** (`target.kind === "part"`, `buildOther`, or wide mode with a create intent): about 30 turns, edit turns not counted, max_tokens 16k-32k, effort "medium" or "high".
- `ModelRequest` (`model.ts`) needs `maxTokens` and `effort` fields to carry this.

---

## 6. Prompt and reference changes

- **Split `REFERENCE`** into `DOC_REFERENCE` (ops, entities, selectors) and a `toolsSection(host)`. The right-click `SYSTEM` should list only the tools `toolsFor` actually offers.
- **Add a plane-frame table**, computed from `planeFrame`. With `x` = global X projected onto the plane, else global Y, and `y = n × x`:

  | normal | sketch x | sketch y |
  |---|---|---|
  | +Z | +X | +Y |
  | −Z | +X | −Y |
  | −Y (front) | +X | +Z |
  | +Y | +X | −Z |
  | +X | +Y | +Z |
  | −X | +Y | −Z |

  Also state that an extrude goes along the plane normal by default.
- **Add a "Modelling strategy" section for build mode.** Put driving sizes in parameters. Fully define sketches from the origin. Prefer symmetry about the origin. Use real features for holes, fillets and patterns rather than sketch geometry. Build in order: base, bosses, cuts, holes, patterns and mirrors, then fillets and chamfers. Take selectors from `listFaces`/`listEdges`; never `near`. Verify with `measure` and `screenshot`.
- **Add 3-4 complete worked documents as examples:** an L-bracket with slots and fillets, a flange with a counterbored bolt circle, and, once those ops exist, a revolved shaft and a shelled box.
- **Add an error-recovery table** mapping common errors to fixes: a selector picks 0 or several, "repeats or contradicts" (over-defined), profile not closed, a cut misses the body, a body name that doesn't exist.
- **Soften the opening rule.** `SYSTEM` starts with "Pick the smallest response" (`prompt.ts:142`). Keep that for surgical asks; build mode should say "plan the feature list, then execute it in batches, verify each".
- **Update `INSTRUCTIONS`** (`reference.ts:4-12`) to point to `listFaces`/`listEdges`, `batch` and `preview`.

## 7. Planner and intent changes

- **"other" parts.** Option (a): a structured-output schema `"document"` in `readIntent` (`model.ts:78-94`, `SCHEMAS` l.~52), where the model emits the whole `RawDocument`, which is then validated, rebuilt, criticised and corrected. Option (b): route "other" to the build-mode `runAsk` budget instead of the 2-edit-turn one (`part.ts:394`).
- **Add deterministic planners** next to `planPart` (`plan.ts:45`) for common families: angle bracket, flange/hub, box/enclosure (needs shell), turned shaft (needs revolve), standoff. Extend `KINDS` (`constants.ts:5`) and the `Intent` schema (`schema.ts:81-105`).
- **Generalise the critic's `Expectation`** (`plan.ts:19-22`, `critic.ts:177`) with a volume range, symmetry, and a feature or hole set, so the "other" path is checked for more than "one solid".

## 8. Suggested order
1. **P0:** fix tool return values (§5.15); split the reference and add the frame table; build-mode budget (§5.3); right-click `screenshot`; `getSketch`; `facePlane`; `batch`.
2. **P1:** `listFaces`/`listEdges` with `madeBy`; `measureBetween`; `sketchProfile`; `fullyDefine`; `preview`.
3. **P2:** a shared tool registry (one zod spec per tool feeding both MCP and Anthropic schemas via `z.toJSONSchema`); `madeBy` and surface-type selectors in the selector language (`types.ts:745-796`, `kernel/selectors.ts`, `synthesize.ts`); `projectEdges`/`sectionAt` together with reference-edge entities; stable constraint ids; document-plan output for "other" parts.