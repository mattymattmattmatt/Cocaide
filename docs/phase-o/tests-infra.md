# Cocaide test infrastructure and build health

## 0. Summary
- **Unit tests:** Vitest 5.0.3, Node environment (no jsdom). 37 `*.test.ts` files with 384 `it(` sites. 14 of those are live-model tests that skip without `ANTHROPIC_API_KEY`, which leaves 370 that run. README says 349, so that number is out of date.
- **E2E tests:** Playwright 1.56.1, Chromium only, against the **production build**, with SwiftShader WebGL. 17 specs with 61 `test(` sites; README says 53, also out of date. The Chromium revision 1194 is installed at `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` and matches what Playwright expects.
- **Measured:** `npx vitest run tests/kernel.test.ts` passed 20/20 in 2.60 s as Vitest reports it (about 68% test time), 3.5 s wall with `npx` startup.
- **Git:** the working tree is clean at `4de1139`.
- **CI:** `.github/workflows/pages.yml` only deploys. It runs `npm ci` and then `npm run build` (`tsc --noEmit && vite build`). **No CI job runs any tests.** `tsconfig.json` includes `src`, `tests`, `scripts` and `e2e`, so **a type error in a test or spec breaks the Pages deploy**. Vitest does not typecheck (esbuild strips types), so run `npm run typecheck` yourself.

## 1. Configuration

| Item | Where | Value |
|---|---|---|
| Vitest | `vite.config.ts:36-41` | `environment: "node"`, `include: ["tests/**/*.test.ts"]`, `testTimeout: 60_000`, `hookTimeout: 60_000`. Pool, isolation and threads are defaults (per-file isolation; 4 cores here). |
| Playwright | `playwright.config.ts` | `testDir: "e2e"`, `timeout: 120_000`, `expect.timeout: 20_000`, `fullyParallel: false`, `workers: 1`, viewport 1500×900, `trace: "retain-on-failure"`, `outputDir: "out/e2e"`, launch args `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` |
| E2E server | `playwright.config.ts:29-34` | `npx vite build && npx vite preview --port 4173 --strictPort`, **`reuseExistingServer: true`**, 180 s startup timeout |
| Scripts | `package.json` | `test` = `vitest run`, `test:e2e` = `playwright test`, `typecheck` = `tsc --noEmit`, `build` = `tsc --noEmit && vite build`, `cocaide` = `tsx scripts/cocaide.ts` (headless rebuild, prints JSON) |
| OCCT in Node | `src/kernel/oc.ts:26-39` | `loadOC()` is a per-process singleton. `getOC()` throws until it has loaded. `printErr` goes to `console.warn`. |
| E2E automation hook | `src/ui/Viewport.tsx:549-570` | Only with `?e2e` in the URL: `window.__cocaideViewport.{project(p), camera(), photoPoint(px)}` |

## 2. Writing tests

### (a) Unit test: rebuild a document with a new op, check volume and topology
The kernel API is `src/kernel/index.ts`:
- `rebuild(input: unknown, oc?, {provenance?})` returns a `RebuildResult` (`src/kernel/rebuild.ts:64-80`) with `ok`, `solid`, `bodies`, `measurements`, `errors: string[]`, `features: FeatureStatus[]`, `sketches`, `holes: HoleRecord[]`, `dispose()`.
- `measurements` is a `Measurements` (`src/kernel/measure.ts:24-45`): `volume`, `surfaceArea`, `boundingBox{min,max,size}`, `holeCount`, `holeDiameters`, `holes[]`, `mass{kg,densityKgPerM3,material}`, `solids`, `faces`, `bodies[]`, `interference[]`, `members[]`.
- Topology comes from `describeFaces(oc, s, shape)` → `{faces, infos: FaceInfo[]}`, where `FaceInfo.type` is `"plane" | "cylinder" | "cone" | "other"` (`src/kernel/topology.ts:23`). `describeEdges(oc, s, shape, faces)` returns `EdgeInfo[]` with `kind` `"line" | "circle" | "other"` and a `seam` flag (`topology.ts:124-146`). Both must be called inside `scoped(s => …)`.
- `tessellate(oc, solid)` returns `faceRanges` and `edgeRanges`. The bracket has 7 face ranges.

Copy the house pattern from `tests/kernel.test.ts:7-26`, `tests/phase-b-ops.test.ts:19-28` and `tests/multibody.test.ts:35-68`:

```ts
// tests/<feature>.test.ts — header comment says what the phase/feature is.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { RawDocument } from "../src/doc/commands";
import { allErrors, validateDocument } from "../src/doc/validate";
import { loadOC, rebuild, scoped, type OC } from "../src/kernel";
import { describeEdges, describeFaces } from "../src/kernel/topology";

const example = (n: string): RawDocument => JSON.parse(readFileSync(new URL(`../examples/${n}.cocaide.json`, import.meta.url), "utf8"));
const bracket = example("bracket");                 // 80×40×6 plate + Ø6.6 through hole at [30,0]
const PLATE = 80 * 40 * 6, HOLE = Math.PI * 3.3 ** 2 * 6;
const add = (doc: RawDocument, ...f: Record<string, unknown>[]): RawDocument => ({ ...doc, features: [...doc.features, ...f] });
const errorsOf = (doc: unknown) => allErrors(validateDocument(doc));

let oc: OC;
beforeAll(async () => { oc = await loadOC(); });

function built(doc: unknown) {
  const r = rebuild(doc, oc);
  try {
    const topo = r.solid && scoped((s) => {
      const { faces, infos } = describeFaces(oc, s, r.solid!);
      return { faces: infos, edges: describeEdges(oc, s, r.solid!, faces).infos.filter((e) => !e.seam) };
    });
    return { ok: r.ok, errors: r.errors, features: r.features, volume: r.measurements?.volume ?? 0, m: r.measurements, topo };
  } finally { r.dispose(); }   // ALWAYS dispose: the WASM heap never shrinks (oc.ts:11-20)
}

describe("shell", () => {
  it("hollows the bracket from its top face, 1 mm walls", () => {
    const b = built(add(bracket, { id: "shell_1", op: "shell", faces: [{ type: "planar", normal: [0, 0, 1], pick: "largest" }], thickness: 1 }));
    expect(b.errors).toEqual([]);
    expect(b.volume).toBeCloseTo(/* analytic formula written out */ 0, 6);
    expect(b.topo!.faces.filter((f) => f.type === "plane")).toHaveLength(/* n */ 0);
    expect(b.features.map((f) => f.ok)).toEqual([true, true, true, true]);
  });
});
```

Conventions:
- **Expected values come from a written-out formula**, with a comment such as `// 3 x (1 - pi/4) x 25 x 6`, not from pasted kernel output. Use `toBeCloseTo(x, 6)` for analytic geometry (planes, cylinders, cones, tori; see the Pappus fillet at `phase-b-ops.test.ts:75-89`). For splines, sweeps or lofts, lower the precision or compare relatively, because OCCT's volume integration is not exact for them. `multibody.test.ts:35` rounds to 3 dp (`r3`) and uses `toBe`.
- **Error strings are asserted exactly with `toEqual`.** They follow the form `"<featureId>: <path>: <message>"`; the `Checker` messages are at `src/doc/validate.ts:1603-1669`. A failed feature still lets the rebuild continue, so check `r.features[i]` with `{id, op, ok:false, error}`, as in `kernel.test.ts:213,333`.
- **Typing a new op:** `Feature` (`src/doc/types.ts:300-316`) must include it, or build docs as `RawDocument` / `Record<string, unknown>` (multibody style). Otherwise `npm run typecheck` fails, even though Vitest passes.
- **Getting numbers while developing:** `npm run cocaide -- rebuild some.cocaide.json` prints `{ok, errors, features, measurements}`. Then derive the formula independently.

### (b) Validation test
Validation is pure, with no OCCT and runs in milliseconds. Use the patterns in `tests/document.test.ts:41-121`, `tests/multibody.test.ts:196-219` and `tests/relations.test.ts:190-238`:

```ts
it("validates them strictly", () => {
  const bad = (f: Record<string, unknown>) => errorsOf(add(bracket, f));
  expect(bad({ id: "s", op: "shell", thickness: -1, faces: [] })).toEqual(["s: thickness: must be greater than 0 (got -1)", /* … */]);
  expect(bad({ id: "s", op: "shell", thikness: 1 })).toEqual(['s: unknown field "thikness" (allowed: id, op, …)']);
});
it("apply refuses it and says why", () => {
  expect(apply(bracket, { type: "addFeature", feature: { id: "s", op: "shell", thickness: 0 } }))
    .toEqual({ ok: false, error: "addFeature rejected: s: thickness: must be greater than 0 (got 0)" });
});
```

Related checks:
- **Command layer** (`src/doc/commands.ts`): `apply(doc, cmd, {writeScope?, user?})` returns `{ok, doc} | {ok:false, error}` and never mutates its input (`commands.test.ts:24-29`). The rejection prefixes are `addFeature rejected:` and `updateFeature rejected:`.
- **New op that references other features:** add it to `references()` (`commands.ts:746-755`). Without that, `deleteFeature` protection (`"X is used by Y"`) and the `reorderFeature` order check have nothing to enforce. Test it like `commands.test.ts:55-70`.
- **Sketch-level commands:** `addEntity`, `updateEntity`, `deleteEntity`, `addConstraint`, `deleteConstraint` and `setDimension` all re-solve the sketch (`tests/sketch-commands.test.ts`).
- **Pure solver tests:** `solveSketch(entities, constraints)` returns `{ok, entities, dof}`, followed by `checkConstraints(...)` → `[]`. `sketchStatus` gives `{free, freePoints, dof}` and `wouldOverDefine` covers redundancy (`relations.test.ts:16-21,153-188`).
- **Do not import `describe` from `src/doc/validate`.** It exports a `describe()` that would shadow Vitest's.

### (c) E2E test: toolbar tool and property panel
Helpers live in `e2e/helpers.ts`:

| Helper | Line | What it does |
|---|---|---|
| `openApp(page)` | :6 | Goes to `/?e2e`, clears localStorage, reloads and waits. Returns an array that collects `pageerror` and `console.error`. A fresh profile opens the **bracket** (`App.tsx:115`). |
| `waitForRebuild` | :19 | Waits for status matching `^(Rebuilt\|\d+ errors?\|No solid yet)`, 60 s timeout |
| `expectVolume(page, "18,994.728")` | :23 | **Prefix** regex on the `volume` test id. The display is en-US with ≤3 dp (`MeasurementsPanel.tsx:4`). |
| `sketchClick(page, x, y)` | :28 | Sketch-plane mm converted to screen through the CTM of `[data-testid=sketch-canvas] > g` |
| `viewportClick(page, [x,y,z], {shift})` | :41 | World point to pixels through `__cocaideViewport.project` |
| `commit(page, testId, value)` | :50 | fill + Enter. `NumberInput` commits on Enter or blur, one command and one undo step each (`src/ui/fields.tsx`). |
| `dropFile` | :57 | Drops a file on the viewport |
| `savedDocument(page)` | :74 | The document from localStorage `cocaide.document.v1`, written immediately on change (`App.tsx:282-284`) |
| `scriptModel`, `useKey`, `text`, `tool` | :91, :114 | Mock the Anthropic API |

`e2e/sections.ts` has `addParameter`, `drawSHS` and `saveSHS`.

```ts
// e2e/<feature>.spec.ts — header comment block describing the suite.
import { expect, test } from "@playwright/test";
import { commit, expectVolume, openApp, savedDocument, viewportClick } from "./helpers";

test.beforeEach(async ({ page }) => {
  (page as unknown as { problems: string[] }).problems = await openApp(page);
  await expectVolume(page, "18,994.728");                         // bracket is the fresh-profile default
});
test.afterEach(async ({ page }) => {
  expect((page as unknown as { problems: string[] }).problems).toEqual([]);   // 15 of 17 specs assert this
});

test("shells the bracket from its clicked top face", async ({ page }) => {
  await viewportClick(page, [-10, 5, 6]);
  await expect(page.getByTestId("selection")).toContainText("normal +Z");
  await page.getByTestId("tool-shell").click();                   // ToolButton testId (App.tsx toolbar)
  await expect(page.getByTestId("properties")).toBeVisible();     // PropertyPanel.tsx:90
  await commit(page, "prop-thickness", "2");
  await expectVolume(page, "1,234.567");                           // a value that CHANGED (see flakiness #1)
  await expect(page.getByTestId("status")).toHaveText(/^Rebuilt/);
  expect((await savedDocument(page) as { features: unknown[] }).features.at(-1)).toMatchObject({ op: "shell", thickness: 2 });
});
```

**Test ids to reuse:**
- **Model toolbar:** `tool-sketch` (menu with `plane-top`, `plane-front`, `plane-right`, and the item "On selected face"), `tool-extrude`, `tool-cut`, `tool-hole`, `tool-fillet`, `tool-chamfer`, `tool-pattern` (menu with `tool-linear-pattern`, `tool-circular-pattern`), `tool-mirror`, `tool-combine`, `tool-split`, `tool-move`, `tool-delete-body`, `tool-member`, `undo`, `redo`, `new-part`, `doc-name`.
- **Property panel:** `prop-id`, `prop-sketch`, `prop-extent`, `prop-distance`, `prop-direction-mode`, `prop-center-x`/`-y`, `prop-diameter`, `prop-through`, `prop-depth`, `prop-hole-type`, `prop-radius`, `prop-chamfer-distance`, `prop-pattern-direction`, `prop-spacing`, `prop-count`, `prop-suppressed`, `prop-feature-error`, `command-error`.
- **Field suffixes:** `Vec3Input` appends `-x`, `-y`, `-z`; plane fields use `<id>-origin` and `<id>-normal` (`fields.tsx:50`, `BodyToolProps.tsx:23-26`).
- **Readouts:** `volume`, `mass`, `holes`, `status`, `notice`, `selection`, `feature-<id>` (the row is `.feature-row`), `feature-error-<id>`, `tab-document`, `doc-editor`.
- **Sketcher:** `tool-<t>` (`SketchMode.tsx:55-63,403`), `ctx-tool-<t>`, `finish-sketch`, `cancel-sketch`, `profile-status`, `sketch-dof` ("Fully defined"), `sketch-status` ("Under defined"), `constraint-list`, `constraint-value-<i>`, `c-<relation>` plus `c-<x>-value` (from `draft.ts` suggestions), `relation-buttons`, `modify-box`, `modify-value`, `modify-ok`, `modify-c-distance-x`/`-y`, `dim-<i>`, `glyph-<i>` (with `data-relation`), `[data-entity=<id>]` with class `defined`/`free`, `context-menu`, `ctx-*`.

**Wiring a new model tool, which the tests depend on:**
1. Add it to the `TOOLS` map in `App.tsx:884-903`.
2. Add a `<ToolButton … testId="tool-x">` in the toolbar at `App.tsx:1233-1323`.
3. Add a `COMMANDS` entry `{id:"tool.x", group:"Model tools", key:null}` in `src/ui/input.ts:65-78`. `input.test.ts:20-28` checks for key clashes.
4. Add the props component and `OP_LABEL` entry in `PropertyPanel.tsx`.
5. Add an icon in `icons.tsx`.

**Wiring a new sketch tool:**
1. `Tool` is `"select" | "dimension" | SketchEntity["type"]` (`SketchCanvas.tsx:12`), so it follows the entity union.
2. Add a row to `TOOLS` in `SketchMode.tsx:55`.
3. Update `CLICKS` (`draft.ts:458`; a `Record` over the entity type, so TypeScript enforces it) and `entityFromClicks` (`draft.ts:422`).
4. Add a `sketch.x` key in `input.ts`.
5. If you add a new constraint type, add `RELATION` in `annotate.ts:12` (a `Record<ConstraintType,…>`).

**UI logic:** there is no React Testing Library or jsdom. Put tool logic in pure modules (`draft.ts`, `annotate.ts`, `input.ts`) and test it in Node, as `sketch-draft.test.ts` and `input.test.ts` do. Click flows go in Playwright.

**Other e2e patterns:**
- Use `expect.poll(() => …)` for lists (`multibody.spec.ts:46`).
- Use `Promise.all([page.waitForEvent("download"), click])` for downloads.
- E2E specs may import the kernel in Node to verify an exported STEP (`phase-b-acceptance.spec.ts:7-9`).

## 3. Runtimes
Per-file durations come from Vitest's cache (`node_modules/.vite/vitest/da39…/results.json`, from the last full run). All of these files load OCCT except where noted.

| Slow (> 3 s) | ms | Why |
|---|---|---|
| `recycle.test.ts` | 11 246 | 31 mounting-plate rebuilds plus a second OCCT load |
| `drawing.test.ts` | 10 097 | PDF and PNG rasterisation (pdfjs) |
| `frames.test.ts` | 6 932 | weldment joints |
| `phase-c-acceptance.test.ts` | 6 786 | spawns the MCP server as a subprocess |
| `frame-ask.test.ts` | 5 932 | |
| `agent-session.test.ts` | 5 675 | |
| `bugcheck.test.ts` | 4 384 | |
| `drafting-ask.test.ts` | 4 225 | |
| `drafting.test.ts` | 4 202 | |
| `multibody.test.ts` | 3 673 | |
| `phase-b-ops.test.ts` | 3 586 | |

- **1–3 s:** ask 2946, bodies 2266, synthesize 2251, photo 2159, intent 1844, part-ask 1838, kernel 1654, bracket.acceptance 1425, weldment 1014.
- **Under 1 s:** commands 979 and parameters 787. Pure tests take 10–50 ms: document, profile, solver, sketch-draft, scope, sketch-commands, relations, input.
- **Totals:** the per-file times sum to about 86 s. On 4 cores the full `npm test` should take about 25–35 s wall; that is an estimate, I did not run it. The cache also lists stale `zz-print.test.ts` and `zz-errs.test.ts`, scratch files someone deleted.
- **Live tests:** phase-d, e, f, g, k and l acceptance show 0 ms because they are `describe.skipIf(!key)` (for example `phase-d-acceptance.test.ts:18`).
- **Example rebuilds in Node** (measured): bracket 169 ms (first call, warm-up), flange 450, mounting-plate 320, table-frame 308, frame-members 60, stand 41.
- **E2E: not measured.** Every run starts with a `vite build`, and each test loads the 23 MB kernel in a worker before running clicks on SwiftShader. Runs are serial (`workers: 1`) over 61 tests. Expect minutes, roughly 5–10, not seconds.
- **Iteration commands:**
  - `npx vitest run tests/<file>` takes 3–5 s.
  - `npx playwright test e2e/<file> -g "<name>"` runs one e2e test.

## 4. Example documents (`examples/*.cocaide.json`)
All six load in the app through `EXAMPLES` (`App.tsx:62-69`, imported with `?raw`). **A new example must be added to that map to appear in the UI.** `scripts/verify-freecad.ts:18` picks up every file automatically.

| File (UI label) | Contents | Volume mm³ / faces / solids / holes / bbox |
|---|---|---|
| `bracket` ("bracket") | `sketch_1` rect r1 80×40 (+`distanceX`), `ext_1` 6 mm (`direction [0,0,1]`), `hole_1` Ø6.6 through at [30,0] on the +Z largest face | 18 994.728 / 7 / 1 / 1 / 80×40×6 |
| `mounting-plate` ("mounting plate") | Lines and arcs outline with R6 corners, Ø20 bore, construction `axis` line, 13 constraints; 8 mm plate; slot through-all cut; 16×24×3 pocket; 2 counterbores (Ø6.6/Ø11×4); 2 countersinks (Ø13, 90°); side tap Ø4.2×10 on the +X face. Material 6082-T6, 2700 kg/m³. Expected volume is derived by formula at `kernel.test.ts:30-41`. | 40 148.534 / 32 / 1 / 6 / 100×60×8 |
| `flange` ("flange") | Ø80/Ø24 disc 10 mm, hub Ø40 8 mm on a z=10 datum sketch, counterbored bolt hole, 6× circular pattern, rim chamfer 1, hub fillet R2. S355 steel. **No test uses it.** | 48 648.808 / 26 / 1 / 7 / 80×80×18 |
| `stand` ("stand (two bodies)") | Parameters `base_t`, `upright_z`, `upright_t`, `upright_h`; `ext_1` with newBody `base` (120×80×8); `ext_2` with newBody `upright` on a datum with normal −Y (expressions); `hole_1` Ø10 body-scoped; `pattern_1` linear ×2 | 133 143.363 / 14 / 2 / 2 / 120×80×68 |
| `frame-members` ("members (weldment)") | `profiles.SHS` (parametric b, t, two sizes); members `leg` (SHS 40, 900 long) and `rail` (SHS 50, 600 long) | 738 000 / 20 / 2 / 0 |
| `table-frame` ("table frame (weldment)") | Parameters `frame_w` 1200, `frame_d` 600, `frame_h` 900; nodes A–H as expressions; 4 rails and 4 legs (SHS 40×40×3, `align`); 4 mitre joints | 3 054 720 / 80 / 8 / 0 |

Also present: `examples/drawings/` (`bracket.pdf`, `.svg`, `-scan.png`, `-blurry.png`, used by `tests/drawings.ts`) and `examples/photos/` (`bracket-photo.jpg`, `freeform-photo.jpg`).

**Do not edit the existing examples.** Their volumes are hard-coded in many unit and e2e tests: bracket 18,994.728 appears in modelling, phase-b and others; stand 133,143.363; table 3,054,720. `document.test.ts:20-25` also checks that bracket and mounting-plate re-save byte for byte through `formatDocument`. Add new example files instead, and write them with `formatDocument` (`src/doc/format.ts`).

## 5. Naming and structure conventions
- **File header:** each file starts with a comment block naming the phase or feature (e.g. `multibody.test.ts:1-3`, `sketch-relations.spec.ts:1-4`). Helper modules have no `.test` or `.spec` suffix (`tests/drawings.ts`, `e2e/sections.ts`, `e2e/helpers.ts`), so they are not collected.
- **`describe` names** are topics in lowercase prose: `"operations"`, `"errors the agent can read"`, `"fillet and chamfer"`, `"the tools' rules"`, `"defined state, as SOLIDWORKS colours it"`.
- **`it` and `test` names** are full behavioural sentences, often citing SOLIDWORKS: `"reports a tie instead of guessing"`, `"Smart Dimension: a line's length, a circle's diameter, …"`. Acceptance items are numbered to match the roadmap: `"1. mirrors hole_1 about the XZ plane: …"`.
- **Per-file local helpers** (duplicated, not shared):
  - `load` / `example(name)`
  - `build` / `built(doc)`, which rebuilds, maps and disposes in `finally`
  - `plate(extra, t)` (`kernel.test.ts:22`)
  - `withFeatures(...)` (`phase-b-ops.test.ts:19`, uses `structuredClone`)
  - `add(doc, ...features)`, `run(doc, ...cmds)` (applies or throws), `errorsOf(doc)`
  - `ok(r)` (`commands.test.ts:11`)

  The shared constants are `PLATE = 80*40*6`, `HOLE = π·3.3²·6` and `TOP` face selector.
- **E2E:** `beforeEach` calls `openApp` and optionally picks an example. `afterEach` asserts `problems` is `[]` (15 of 17 specs; `sketch-relations` and `context-menu` skip it). Expected volumes carry a derivation comment.

## 6. Flaky and brittle areas
1. **250 ms rebuild debounce** (`App.tsx:71`, `:234-256`). `busy`, and so "Rebuilding…", is set only when the timer fires. For 250 ms after an edit the status still shows the **old** "Rebuilt", so `waitForRebuild` or `toHaveText(/^Rebuilt/)` right after an edit passes without checking anything:
   - `modelling.spec.ts:77`
   - `multibody.spec.ts:41`, which asserts an unchanged volume right after a move

   Always assert a value that changed first, or `expect.poll` on `savedDocument`.
2. **`expectVolume` matches a prefix** (`helpers.ts:23-25`). "19,200" also matches "19,200.5", and "57,600" matches "57,600,000". Use the full figure.
3. **`page.locator("select").first().selectOption(...)`** picks examples by DOM order (`modelling.spec.ts:9`, `multibody.spec.ts:28,89`). Adding a `<select>` earlier in the header breaks these. `getByLabel("Open an example")` is the robust form (`App.tsx:1155`).
4. **`reuseExistingServer: true`.** A stale `vite preview` on :4173, or one built with `COCAIDE_BASE=/Cocaide/`, gets reused, and the tests then run against old code.
5. **E2E writes into `docs/*.png`** on every run (`context-menu.spec.ts:51`, `drafting.spec.ts:62,114`, `interface.spec.ts:61`, `multibody.spec.ts:65`, `sketch-relations.spec.ts:215`), which leaves the working tree dirty.
6. **3D picking under SwiftShader** (`viewportClick`). The fillet edge test (`modelling.spec.ts:102-115`) shift-clicks silhouette edges across view switches and is sensitive to pick tolerance and camera fit. View changes are not animated, which helps.
7. **Sketch clicks rely on grid snap and inference at the default zoom.** Comments at `modelling.spec.ts:53` and `e2e/sections.ts:37` ("the grid snaps to 2 mm") say so. Off-grid points such as `(10, 0.4)` and `(-15, 27.5)` in `sketch-relations.spec.ts:36-49` rely on inference tolerances. Changing snap, inference or default sketch zoom ripples through many specs.
8. **Exact-string lists that break when you add ops, fields or constraints:**
   - `document.test.ts:56` lists every op, and uses `"loft"` as its *unknown* op. If you add loft, pick another example op.
   - `document.test.ts:48` and `commands.test.ts:51` list the extrude allowed fields.
   - `kernel.test.ts:373` lists the hole allowed fields.
   - `relations.test.ts:228` uses the regex `/supported: coincident, .*symmetric, fix/`. Append new constraint types after `"fix"` in `CONSTRAINT_TYPES` (`validate.ts:684`) or update the regex.
   - `photo.test.ts:270`.
9. **No typecheck in `vitest run`.** Only `npm run typecheck` / `build` catches type errors, and `build` is the deploy gate.
10. **`recycle.test.ts` is the slowest file** (about 11 s) and depends on heap growth from 30 rebuilds. Undisposed `RebuildResult`s leak WASM heap for the rest of the file.
11. **Console errors fail most specs.** Any new `console.error` or uncaught page error in the app fails 15 specs through the `problems` check. OCCT `printErr` goes to `console.warn`, so it is not caught.

Files I added (scratch only; nothing in the repo was edited):
- /tmp/claude-0/-home-user-Cocaide/e5e32f9c-9616-5fee-876d-a1f9e07d0fcd/scratchpad/ex.mts (rebuilds all examples and prints measurements)
- /tmp/claude-0/-home-user-Cocaide/e5e32f9c-9616-5fee-876d-a1f9e07d0fcd/scratchpad/kernel-run.txt (kernel test timing)