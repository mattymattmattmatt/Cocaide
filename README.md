<p align="center"><img src="public/cocaide-mark-256.png" width="96" alt="Cocaide"></p>

# Cocaide

Browser parametric CAD. One JSON feature document is the source of truth; OpenCascade (WASM, in the tab) rebuilds it into a B-rep; the mesh, the measurements and the STEP file are views of that solid. Humans and agents edit the same document, through the same commands.

**Status: Phase B (human modeller) done.** Phase A gave the document, the kernel, the viewport and STEP export. Phase B adds a sketcher with a constraint solver, a feature tree you can reorder, suppress, edit and undo, picking in the viewport, fillet, chamfer and patterns. Phase C (agent tools) has not been started.

![The flange example: circular pattern of counterbored holes, chamfered rim, filleted hub](docs/phase-b-modeller.png)

## Run it

```sh
npm install
npm run dev            # http://localhost:5173
npm test               # 120 unit and kernel tests, including the Phase A acceptance suite
npm run test:e2e       # 11 browser tests (Playwright, Chromium), including the Phase B acceptance suite
npm run build          # typecheck + production bundle in dist/
```

Headless, same document and kernel as the browser:

```sh
npm run cocaide -- rebuild examples/bracket.cocaide.json          # JSON: ok, errors, features, measurements
npm run cocaide -- export-step examples/bracket.cocaide.json out/bracket.step
FREECAD_CMD=/path/to/freecadcmd npm run verify:freecad           # export every example, open each in FreeCAD, compare
FREECAD_CMD=/path/to/freecadcmd npm run verify:freecad -- out/e2e/ui-bracket.step   # open a STEP the browser exported
```

## Acceptance

### Phase B: human modeller

| Check | Result |
|---|---|
| A human makes the bracket with no JSON editing | In the browser: New → Sketch on Top → draw a rectangle → select it, type width 80 and height 40, centre it on the origin (the sketch reads "Fully defined") → Finish → Extrude, depth 6 → click the top face → Hole, centre 30, 0, diameter 6.6. Volume 18,994.728 mm³. The document those clicks produce is the spec's bracket, the face selector included (`planar, normal +Z, pick largest`) |
| Undo returns the previous solid | Undo walks back one edit at a time (diameter, centre, the hole itself) to the 19,200 mm³ plate; redo walks forward to the bracket again |
| A bad selector shows the error, not a crash | Fillet the hole rim by clicking it, then make the hole smaller: the fillet row reads `edges: selector matched 0 edges (wanted circle edges radius 3.3 on the planar face normal +Z)`, the rest of the part still rebuilds, STEP export is refused, and undo clears it |
| The bracket built in the browser opens in FreeCAD | The STEP the **Export STEP** button downloaded opens in FreeCAD 26.3 as one valid solid named `bracket`, 18994.728336 mm³ |

These are `e2e/phase-b-acceptance.spec.ts`. `e2e/modelling.spec.ts` covers the rest: editing a sketch dimension, cancelling a sketch, line chains that close themselves, circles, arcs and slots, sketch on a face, suppress, drag-to-reorder, refused moves and deletes, fillet and chamfer by picking edges, linear and circular patterns, and the JSON tab.

![The sketcher: dimensions, degrees of freedom, suggested constraints](docs/phase-b-sketcher.png)

### Phase A: document and kernel

| Check | Result |
|---|---|
| The spec's bracket JSON rebuilds | `examples/bracket.cocaide.json` is the spec's JSON verbatim; 3/3 features rebuild, no errors |
| Volume matches hand calc within 0.1% | 80×40×6 − π·3.3²·6 = 18994.728336 mm³; kernel gives 18994.728336 (difference below 1e-10 mm³) |
| STEP reimports | Exported STEP read back by OCCT: valid, 7 faces, same volume |
| STEP opens in FreeCAD | Every example (bracket, mounting plate, flange) opens in FreeCAD 26.3 as one valid solid; volume, area, face count and bounding box match Cocaide to 1e-6 |
| Selector survives a thickness change | Plate thickness 6 → 10 (and → 3): `hole_1`'s selector still resolves to the top face, the hole is still through, volume matches the new hand calc |

That suite is `tests/bracket.acceptance.test.ts`. FreeCAD verification is `scripts/verify-freecad.ts`; it needs a FreeCAD install, which is not a project dependency.

## Modelling in the browser

- **Sketch ▾** starts a sketch on the Top, Front or Right plane, or on a flat face you clicked. Draw with Line (clicks chain; clicking the first point closes the loop), Rectangle, Circle, Arc (centre, start, end) and Slot (two centres, then the width). Points snap to existing points, which adds a coincident constraint, or else to the grid.
- Select geometry to see the constraints that fit it, valued at what the geometry measures now; type a new value and the solver moves the sketch. Drag points, corners, circle edges or whole entities, and the solver keeps every constraint. The panel shows the degrees of freedom left and whether the profile is closed. **Finish** turns the session into one undo step.
- **Extrude** and **Cut** use the selected or latest sketch. A new cut points into the material. Click a flat face, then **Hole**: the hole is placed where you clicked. Click edges (shift-click for more), then **Fillet** or **Chamfer**. Select an extrude, cut or hole in the tree, then **Linear pattern** or **Circular pattern**.
- Picks become selectors that are checked to find exactly what was clicked. The most robust form is preferred, such as "the largest face facing +Z" or "the edge between this face and that one". Four picked corners become "straight edges parallel to +Z". Position (`near`) is used only when nothing else tells two faces or edges apart.
- In the tree, select a feature to edit it in the Properties panel. Each field commits on Enter or blur as one command. You can also suppress, move up or down, drag to reorder, and delete. Moves that break a reference are refused and the notice says why.
- Ctrl+Z / Ctrl+Shift+Z undo and redo any change to the document. Inside a sketch they undo sketch edits. The Document tab is the same document as JSON.

## The document

File extension `.cocaide.json`. Units are millimetres, always. Unknown fields are errors, not ignored: `"diamter"` fails loudly.

```jsonc
{
  "version": 1,
  "units": "mm",
  "name": "bracket",
  "material": { "name": "S275", "densityKgPerM3": 7850 },   // optional; default steel 7850
  "features": [ /* run in order */ ]
}
```

### Operations

Every feature has an `id` and may be `"suppressed": true` (kept, but skipped by the rebuild).

| op | Fields |
|---|---|
| `sketch` | `plane: { type: "datum", normal, origin, xDir? }`, `entities[]`, `constraints[]?` |
| `extrude` / `cut` | `sketch` (id of an earlier sketch), `extent?: "blind" \| "midplane" \| "throughAll"` (default blind), `distance` (blind/midplane; midplane is the total), `direction?` (default the sketch normal) |
| `hole` | `face` (planar selector, must match exactly one face), `center: [x, y]`, `diameter`, `depth: number \| "through"`, optional `counterbore: { diameter, depth }` or `countersink: { diameter, angle }` |
| `fillet` / `chamfer` | `edges` (one edge selector, or a list whose matches are combined), `radius` / `distance` |
| `linearPattern` | `feature` (an earlier extrude, cut or hole), `direction`, `spacing`, `count` (including the original); optional `direction2`, `spacing2`, `count2` for a grid |
| `circularPattern` | `feature`, `axis: { origin, direction }`, `count` (including the original), `angle?` (total sweep, default 360) |

A pattern repeats the seed feature's tool body. An instance that adds or removes no material is an error that names the instance (`instance 5 (offset [-80, 0, 0]) removes no material`).

Sketch entities: `line {start, end}`, `circle {center, radius}`, `arc {center, start, end, clockwise?}` (counter-clockwise by default), `rect {center, w, h}`, `slot {center1, center2, width}`. Any entity can be `"construction": true`. Closed loops are found by chaining endpoints. A loop inside a loop is a hole, and a loop inside that is an island. Loops must not cross or touch.

Constraints: `coincident {points: ["l1.end", "a1.start"]}` (a point may be `"origin"`), `horizontal`/`vertical {entity}`, `distance`/`distanceX`/`distanceY {entity | points, value}`, `radius {entity, value}`, `equal {entities: [a, b]}`.
- **In the sketcher, constraints are solved:** typing a value drives the geometry.
- **In the rebuild, they are only checked:** the document stores solved geometry, and a constraint that doesn't hold (for example, after hand-editing the JSON) fails the sketch with the measured value.

### Plane frames

A sketch's 2D axes come from its plane normal: x is `xDir` if given, else global X projected onto the plane (global Y if the normal is parallel to X), and y = normal × x. A hole's `center` uses the same rule on the selected face's plane, with the origin at the global origin projected onto that plane. So on a +Z face, `[30, 0]` means x = 30, y = 0; on a −Z face the y axis points to −Y. The Front plane is normal −Y, so its sketch x is +X and its y is +Z.

### Selectors

Faces and edges are chosen by query, re-run on every rebuild. Topology indexes are never stored.

```jsonc
{ "type": "planar", "normal": [0, 0, 1], "pick": "largest", "offset": 6 }       // offset optional
{ "type": "cylindrical", "radius": 3.3, "axis": [0, 0, 1], "pick": "all" }      // radius, axis optional
{ "type": "edge", "kind": "line", "direction": [0, 0, 1], "pick": "all" }       // the vertical corners
{ "type": "edge", "between": [<face selector>, <face selector>], "pick": "all" } // the edge two faces share
{ "type": "edge", "kind": "circle", "radius": 3.3, "onFace": <face selector>, "pick": "all" }
```

- **Face `pick`:** `largest`, `smallest` or `all`.
- **Edge `pick`:** `all`, `longest` or `shortest`.
- **Edge filters:** `kind` (`line`, `circle`, `other`), `direction`, `radius`, `length`, `onFace`, `between`.
- **`near: [x, y, z]`:** any selector may add this. It keeps the match whose centre is closest to that point, for faces or edges that are otherwise identical.

A selector that matches the wrong number of faces fails, including a tie. It never guesses. Hole seams (where a cylinder's surface closes on itself) are never selected.

### Rebuild contract

`rebuild(doc) → { ok, solid, measurements, errors[], features[] }`. Features run in order. A failed feature adds nothing and the rebuild carries on, so one bad hole doesn't hide the rest of the part. Every error names its feature:

```
hole_1: selector matched 0 faces (wanted 1 planar face normal +Z)
hole_1: center [130, 0] is not on the selected face (it is 90 mm outside it)
fillet_1: edges: selector matched 0 edges (wanted circle edges radius 3.3 on the planar face normal +Z)
ext_1: sketch "sketch_1" is suppressed, so there is no profile to extrude
sketch_1: profile is open at [0, 0] (start of "l1")
```

Every operation is verified before it is accepted: the result must be a valid solid, and it must actually have added or removed material. `measurements` is read from the B-rep: bounding box, volume, surface area, hole count and diameters, and mass at the document's density. A hole is a run of full concave coaxial cylinders, so slot ends and fillets don't count. STEP export is refused while the rebuild has errors.

### Commands and undo

Every edit goes through `apply(doc, command)` (`src/doc/commands.ts`). The commands are `addFeature`, `updateFeature` (where `null` removes a field), `replaceFeature`, `deleteFeature`, `reorderFeature`, `suppressFeature` and `setName`. `apply` never mutates its input. It refuses an edit that would introduce a validation error, delete a feature something uses, or move a feature above one it uses, and says why. Undo is a stack of document snapshots (`src/doc/history.ts`); restoring the document restores the solid. The UI is one client of `apply`; the Phase C agent tools will be another.

## Layout

```
src/doc       document types, strict validation, formatting, commands, undo history   (no kernel)
src/geom      plane frames, 2D profiles, constraint checks, the constraint solver     (no kernel)
src/kernel    OCCT: operations, selectors, picking -> selector synthesis, measurements, mesh, STEP, rebuild()
src/worker    the kernel in a Web Worker; meshes, topology and STEP text cross the boundary, shapes never do
src/ui        React + Three.js: viewport with picking, feature tree, properties, measurements, JSON tab
src/ui/sketcher  the 2D sketcher: canvas, tools, constraint panel
scripts       headless CLI and FreeCAD verification
examples      bracket (the spec's JSON), mounting plate (every Phase A op), flange (patterns, chamfer, fillet)
tests         unit and kernel tests (Vitest, Node)
e2e           browser tests (Playwright)
```

The kernel is `replicad-opencascadejs` (OCCT 8.0 compiled to WASM), called directly. The `replicad` modelling API is not used.

## Notes

- **WASM heap growth.** The OCCT WASM build never returns the memory of deleted B-rep topology, while native OCCT does. Measured: a box created and deleted 30 000 times grows the WASM heap by about 290 MB, and FreeCAD's native OCCT doesn't grow at all. Older `replicad-opencascadejs` releases behave the same.
  - A rebuild costs about 0.3 MB (bracket) to 4 MB (mounting plate).
  - The kernel holds nothing the document doesn't, so the worker swaps in a fresh OCCT instance (about 250 ms) once the heap passes 1 GB (`RECYCLE_HEAP_BYTES`, `recycleOC()`).
  - A long-running Node host, such as the Phase C MCP server, should do the same.
- **Where documents live.** The working document is kept in `localStorage` between reloads. Open and Save use `.cocaide.json` files, and you can also drop a file on the window.
- **Test hook.** `?e2e` in the URL exposes `window.__cocaideViewport.project([x, y, z])`, which the browser tests use to click a known face or edge.
