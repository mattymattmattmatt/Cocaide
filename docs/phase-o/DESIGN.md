# Cocaide "Phase O": a SOLIDWORKS-class part modeller — design contract

This is the contract every implementation agent works to. Read it fully before you start.
Background maps of the codebase (read the ones your task names; they have line numbers):

- `/home/user/Cocaide/.plan/feature-op-path.md` — how a feature op flows end to end; the registry design (§5).
- `/home/user/Cocaide/.plan/sketch-entity-path.md` — sketch entities, reference edges, solver constants, profiles.
- `/home/user/Cocaide/.plan/kernel-capabilities.md` — what the OpenCascade WASM build exposes, exact signatures, idioms, pitfalls.
- `/home/user/Cocaide/.plan/ui-structure.md` — App, PropertyPanel, Viewport, sketcher, styles, icons, input, e2e conventions.
- `/home/user/Cocaide/.plan/agent-tools.md` — the AI side (right-click agent, MCP server, reference doc).
- `/home/user/Cocaide/.plan/tests-infra.md` — how to write unit and e2e tests here.
- `/home/user/Cocaide/.plan/cad-research.md` — the SOLIDWORKS/Onshape/Fusion checklist this patch works from.

The user asked for: "make this a great 3D modeller like SOLIDWORKS … implement them in a smarter, cleaner way than
SOLIDWORKS but try to get all the little things in there. One example is reference edges and being able to dimension
to them … mainly sketching and parametric modelling. The AI was limited by the amount of tools and features."

## 1. Principles

1. **One document, one command path.** Every feature is JSON in the document, validated strictly (unknown keys are
   errors), rebuilt by the kernel, editable by humans in the UI and by agents through the same commands. Numbers accept
   `"=expr"` (resolved before validation, so validators and the kernel only see numbers).
2. **Smarter than SOLIDWORKS:** one feature per shape-making method with an `operation` (new/add/remove/intersect);
   one reference-geometry system (`DatumRef`) shared by planes, axes, points, sketch placement, mirror, patterns,
   revolve axes and extrude end conditions; references to model geometry are selectors (queries), never indices;
   sketches can reference model edges directly; every failure message names what to fix.
3. **Registries, not giant switches.** New feature ops live in `src/features/<op>/{doc.ts,kernel.ts,ui.tsx}` and are
   listed in `src/features/{docIndex,kernelIndex,uiIndex}.ts`. New model tools are `ToolDef`s listed in
   `src/ui/model/tools/index.ts`. New sketch tools are `SketchToolDef`s in `src/ui/sketcher/tools/index.ts`.
   Index files and `icons.tsx`, `styles.css` use a git union merge (see `.gitattributes`): only ever APPEND whole,
   self-contained entries/lines to them, never reorder or rewrite existing lines.
4. **Pure modules for logic.** Geometry, sketch tool maths, tool argument building and measuring live in pure modules
   that Vitest (node environment, no DOM) can test. React components stay thin.
5. **Keep everything that works working.** Existing documents, examples, tests and e2e specs must keep passing.
   If a UI change genuinely requires an e2e spec update (e.g. a tool moved into a toolbar tab), update the spec in the
   smallest way and say so in your report. Never delete or skip a test to make it pass.
6. **Agents get every feature.** Each new op documents itself (registry `reference` text → `src/mcp/reference.ts`),
   so the right-click AI and the MCP server can use it with `addFeature`/`updateFeature`.

## 2. Shared types (exact shapes — keep to these names)

### 2.1 DatumRef — anything that can serve as a plane, an axis or a point

```ts
type DatumRef =
  | { datum: "Front" | "Top" | "Right" }          // default planes (Z-up world): Top = XY (+Z), Front = XZ (−Y), Right = YZ (+X)
  | { datum: "Origin" }                           // default point
  | { datum: "X" | "Y" | "Z" }                    // default axes through the origin
  | { datum: string }                             // id of an earlier plane / axis / point feature
  | { face: FaceSelector }                        // planar face → plane; cylindrical/conical face → its axis
  | { edge: EdgeSelector; at?: "start" | "end" | "mid" | "center" }  // linear edge → axis; circular edge → axis (or its
                                                  // centre as a point); with `at` → that point
  | { point: Vec3 }                               // a fixed point
```
Feature ids `Front`, `Top`, `Right`, `Origin`, `X`, `Y`, `Z` are reserved (validation refuses them as ids).
Resolution happens in the kernel at rebuild time into plain frames:
`{ kind: "plane", origin, normal, xDir } | { kind: "axis", origin, direction } | { kind: "point", at }`.
A ref used where a plane is needed must resolve to a plane (or an axis needed → axis, etc.), else a clear error
("Top is a plane, but an axis is needed here").

### 2.2 Reference-geometry ops (no bodies)

- `plane`: `{ id, op: "plane", mode, refs: DatumRef[], distance?, angle?, flip?, t? }`
  - `offset`: refs[0] plane-like; `distance` mm along its normal (signed). Default mode when one plane ref is given.
  - `angle`: refs[0] plane-like, refs[1] axis-like lying in/parallel to it; `angle` degrees about that axis.
  - `threePoints`: refs[0..2] point-like.
  - `midplane`: refs[0], refs[1] plane-like (parallel → halfway; else the bisector).
  - `normalToEdge`: refs[0] an edge; `t` 0..1 along it (default 0 = start) or refs[1] a point on it.
  - `parallelThroughPoint`: refs[0] plane-like, refs[1] point-like.
  - `flip` reverses the normal.
- `axis`: `{ id, op: "axis", mode: "twoPoints" | "edge" | "cylinder" | "twoPlanes" | "pointNormal", refs: DatumRef[] }`
  (`edge`: a linear edge or a circular edge's axis; `cylinder`: a cylindrical/conical face's axis; `pointNormal`:
  refs[0] point-like + refs[1] plane-like → through the point along the plane normal).
- `point`: `{ id, op: "point", mode: "coords" | "center" | "intersection" | "onEdge", refs?: DatumRef[], at?: Vec3, t? }`
  (`center`: circular edge centre or face centroid; `intersection`: axis-like refs[0] with plane-like refs[1];
  `onEdge`: refs[0] edge at `t`).

### 2.3 Sketch placement

`SketchFeature.plane` accepts the existing `DatumPlane` **or**
`{ type: "ref", ref: DatumRef /*plane-like*/, offset?: number, flip?: boolean, xDir?: Vec3 }`.
A sketch on a face is `{ type: "ref", ref: { face: <selector> } }`: it follows the face when upstream features change.
The sketch frame for a face: origin = global origin projected onto the plane (same as `facePlaneFrame`), x = `xDir` if
given else the existing `planeFrame` rule. For a default plane/plane feature: its stored origin and xDir.

### 2.4 Sketch references to model geometry ("reference edges")

Any line / circle / arc / point entity may carry `ref?: DatumRef` (normally `{ edge: <EdgeSelector> }`, or
`{ datum: "<axis or point feature>" }`). Such an entity is **reference geometry**: the rebuild re-projects it into the
sketch plane from the model as it stands at the sketch's place in history, and the solver treats its numbers as
constants (not unknowns). It can take part in every relation and dimension. It is drawn purple in the sketcher, it is
construction by default (never profile) unless `construction: false` is set explicitly (SOLIDWORKS "convert entities"
makes profile geometry: the Convert Entities tool sets `construction: false`; dimensioning to a model edge creates a
construction reference automatically).
The sketch's own axes are always available to constraints as virtual reference lines with ids `"X"` and `"Y"`
(e.g. `{ type: "distance", point: "c1.center", line: "Y", value: 20 }`), as `origin` already is a point.
**The rebuild now solves sketches** that contain reference entities (start from stored geometry, references held
constant), so a sketch dimensioned to a model edge follows that edge when the model changes.

### 2.5 Operations for shape-making features

New ops (revolve, sweep, loft, rib, …) use:
```ts
operation?: "new" | "add" | "remove" | "intersect"   // default: "add" if a body exists else "new"
body?: string          // add / intersect: the body to change (default: the only body, or error if ambiguous)
bodies?: string[]      // remove: bodies to cut (default: all)
newBody?: string       // new: its name (default: the feature id)
```
Existing `extrude`/`cut` keep their fields; `extrude` gains `intersect?: true`.

### 2.6 New feature ops and the fields they add (owner agent decides details; keep to these names)

| op | fields |
|---|---|
| `revolve` | `sketch`, `axis: { line: "<sketch entity id>" } \| DatumRef`, `angle?` (default 360), `angle2?` (second direction), `midplane?`, `thin?: { thickness, side?: "inside"\|"outside"\|"mid" }`, operation fields |
| `sweep` | `profile?: "<sketch id>"` or `circle?: { diameter, inner? }` (a tube along the path, no profile sketch), `path: { sketch: "<id>" } \| { edges: EdgeSelector[] } \| { helix: { axis: DatumRef, radius, pitch, turns?, height?, leftHanded?, taper? } }`, `twist?` (degrees), `orientation?: "follow" \| "fixed"`, operation fields |
| `loft` | `profiles: string[]` (sketch ids, 2+, in order), `ruled?`, `closed?`, operation fields |
| `shell` | `faces: FaceSelector[]` (removed; may be empty → hollow), `thickness`, `outward?`, `body?` |
| `draft` | `faces: FaceSelector[]`, `neutral: DatumRef` (plane-like), `angle` (degrees), `flip?` |
| `rib` | `sketch` (an open chain), `thickness`, `side?: "both"\|"left"\|"right"`, `normal?` (extrude normal to the sketch instead of in-plane), `flip?` |
| `scale` | `bodies?`, `factor`, `about?: "origin" \| "centroid"` |
| `plane`, `axis`, `point` | §2.2 |
| `sketchPattern` | `feature?`/`features?`, `sketch` (its point entities are the instance positions), `from?: Vec2` (the seed's position in that sketch; default: first point) |

Upgrades to existing ops (owner agent keeps old documents valid):
- `extrude`/`cut`: `extent` adds `"upToNext" | "upToFace" | "upToVertex" | "offsetFromFace"` with `upTo?: DatumRef` and
  `offset?`; `direction2?: { extent, distance?, upTo? }`; `startOffset?`; `draft?: { angle, outward? }`;
  `thin?: { thickness, side? }` (allows an open sketch); extrude `intersect?: true`.
- `chamfer`: `distance2?` (two distances; `flip?` swaps which face gets the first), `angle?` (distance–angle).
- `fillet`: `radius2?` (radius varies linearly from `radius` to `radius2` along each edge).
- `hole`: `size?: "M6"…`, `kind?: "simple" | "counterbore" | "countersink" | "tapped"`, `fit?: "close" | "normal" | "loose"`,
  `centers?: Vec2[]` (several holes), `points?: "<sketch id>"` (every point entity of that sketch), thread callouts
  recorded for drawings; sizes from ISO tables in `src/features/hole/standards.ts` (fields given explicitly win).
- `linearPattern`: `features?: string[]`, `skip?: number[]` (instance numbers, seed = 1), `direction2?`, `spacing2?`,
  `count2?`, `along?: DatumRef` (direction from an edge/axis). `circularPattern`: `features?`, `skip?`,
  `axis` may also be `{ ref: DatumRef }`, `total?` (angle spanned, equal spacing). `mirror`: `features?`, `plane` may
  be `{ type: "ref", ref }`.

### 2.7 Sketch additions

- Entity `point`: `{ id, type: "point", at: Vec2 }` (point refs `id.at`).
- Entities `ellipse` `{ center, major: Vec2 /* end of the major semi-axis */, minor: number }` and
  `spline` `{ points: Vec2[], closed? }` (late wave).
- Constraint additions: `driven?: true` (reference dimension: measured, never solved, shown in parentheses);
  `name?` on dimensions; `arcLength`; circle `condition?: "center" | "min" | "max"` on distances to circles/arcs;
  symmetric for lines/arcs/circles.
- Sketch tools are `SketchToolDef`s (pure `build`/`apply` functions) — draw tools may emit several entities + relations
  (rectangles as four lines, polygons, slots as lines + arcs, centerline, midpoint line, 3-point arc, tangent arc,
  3-point circle, point); edit tools (trim, extend, split, fillet, chamfer, offset, mirror, linear/circular pattern,
  move/rotate/scale/copy, convert entities, construction toggle).

### 2.8 UI

- **CommandManager**: the model toolbar becomes tabs — `Features`, `Sketch`, `Reference`, `Evaluate`, `Bodies`,
  `Weldments` — rendered from the model `ToolDef` registry (`tab` field). Existing `data-testid`s of existing tools stay
  the same (`tool-extrude`, `tool-fillet`, …).
- **Generic property editor** `FeatureForm` driven by a field spec (number with expressions, select, bool, vec3,
  direction, plane, datumRef, faces, edges, face, feature(s), sketch, sketch-line, bodies, custom) so a new op's editor
  is mostly declarative. "Use selected" buttons turn the viewport selection into selectors / DatumRefs.
- Default planes, origin, axes and reference features are drawn in the viewport, pickable, listed at the top of the
  tree, and offer "Sketch on this plane" / hide / show.
- Multi-face selection with Ctrl/Shift.

## 3. Rules for every implementation agent

1. **Working copy.** You work in your own git worktree (your current directory). First run:
   `test -e node_modules || ln -s /home/user/Cocaide/node_modules node_modules`.
   Use a private e2e port: `PW_PORT=<your port> npx playwright test …` (your task gives the port). Never use 4173.
2. **Read before you write.** Read the maps your task names and the code you change.
3. **Scope.** Change only what your task covers. Shared files: keep edits minimal and local; append to registries,
   icons, styles, input COMMANDS. Do not reformat files. Do not touch README.md, docs/roadmap.md or the `.plan` folder
   (the coordinator writes docs from your report).
4. **Conventions.** Match the surrounding code: comment density, naming (plain words, no abbreviations in UI text),
   error messages that say what to do. Units mm and degrees. Strict TS: `noUnusedLocals`, `noUnusedParameters`.
   OCCT: track every object in the `Scope`, check `IsDone()`, results only leave a scope via `copyOut`, every new
   feature result checked with `isValidShape`/volume. No `_1` overload suffixes (see kernel map).
5. **Tests are part of the work.** Unit tests (Vitest) for every validator, kernel op and pure module you add,
   with expected values from written-out formulas. An e2e spec for user-facing UI you add (keep it focused, using
   `e2e/helpers.ts`). Before you finish, ALL of these must pass in your worktree:
   `npx tsc --noEmit -p .` · `npx vitest run` (whole suite) · the e2e specs you added or touched, plus
   `PW_PORT=<port> npx playwright test e2e/modelling.spec.ts e2e/phase-b-acceptance.spec.ts e2e/interface.spec.ts`
   (smoke). If an existing test fails because of your change, fix your change (or the test if the test pinned
   something your task legitimately changes — say so).
6. **Commit.** Commit all your work in your worktree branch (`git add -A && git commit -m "<what>"`; end the
   message with the two trailer lines below). Do not push. Do not create PRs.
   ```
   Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_01ChhJU5NmYXBo7cA4eKhPqx
   ```
7. **Report** (your final structured answer): branch name (`git branch --show-current`), commit SHA, files added/changed,
   what works (with how you verified it), test results (counts), known gaps or follow-ups, and a short user-facing
   description of each new capability (the coordinator turns these into README text).
