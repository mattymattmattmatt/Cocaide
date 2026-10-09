# SOLIDWORKS-class part modelling for Cocaide: a prioritised feature checklist

**Scope:** sketching and parametric solid modelling only. Surfacing, assemblies and drawings are left out.
**Priorities:**
- **P0:** without it, nobody would take the tool seriously as a SOLIDWORKS-class part modeller.
- **P1:** strongly expected by daily SOLIDWORKS users.
- **P2:** nice to have.

**Format:** `- [ ]` = missing, `- [x]` = Cocaide already has it. A note after an item says how much Cocaide has today, based on reading `src/doc/types.ts`, `docs/roadmap.md` and the sketcher.

## 0. Where Cocaide is today, and what the kernel already supports

**What Cocaide has:**
- **Sketch entities:** line, circle, arc, a `rect` primitive and a `slot` primitive.
- **Relations:** coincident, horizontal and vertical (lines and point pairs), equal, parallel, perpendicular, collinear, tangent, concentric, midpoint, pointOn, symmetric (points only), fix.
- **Dimensions:** distance, distanceX/Y, point-to-line, radius, diameter, angle.
- **Sketch behaviour:** auto relations, defined-state colours, and degrees of freedom read from the Jacobian null space.
- **Sketch planes:** only fixed `DatumPlane`s. A sketch cannot sit on a model face or a reference plane, and it cannot reference model edges.
- **Features:**
  - extrude and cut with blind, midplane and throughAll;
  - hole: one centre on a planar face, with counterbore or countersink;
  - fillet (constant radius) and chamfer (equal distance);
  - linear and circular pattern of a single feature;
  - mirror, split by plane, move, deleteBody, combine;
  - weldment ops; parameters with `= + - * / ()`; suppress.
- **Missing workflow:** no revolve, sweep, loft, shell, draft or rib. No reference geometry features, no rollback bar, no interactive measure tool.

**What the kernel build supports.** I checked `node_modules/replicad-opencascadejs/dist/replicad_single.d.ts` for each OCCT class this checklist needs.

| Exposed in the build | Not in the build, and the workaround |
|---|---|
| `BRepPrimAPI_MakeRevol`, `BRepPrimAPI_MakePrism`, `BRepOffsetAPI_MakePipeShell` (twist through `SetLaw`, binormal and auxiliary-spine modes), `BRepOffsetAPI_ThruSections`, `BRepOffsetAPI_MakeThickSolid` (`MakeThickSolidByJoin`), `BRepOffsetAPI_MakeOffsetShape`, `BRepOffsetAPI_DraftAngle`, `BRepOffsetAPI_MakeOffset` (2D offset) | `BRepFeat_MakePrism`: use `BRepFeat_MakeDPrism` or prism plus half-space |
| `BRepFeat_MakeDPrism` (draft prism with `Perform(Until)`, `Perform(From, Until)`, `PerformUntilEnd`) | `BRepFilletAPI_MakeFillet2d` and `ChFi2d_*`: do 2D sketch fillets analytically in TypeScript |
| `BRepFilletAPI_MakeFillet` (constant, `R1→R2` linear, `Law_Function` and `(u, r)` arrays, so variable radius is free) | `GeomAPI_ProjectPointOnCurve`, `Extrema_ExtPS` |
| `BRepFilletAPI_MakeChamfer` (`Add(d)`, `Add(d1, d2, E, F)`, `AddDA(d, angle, E, F)`) | All font builders: use opentype.js or a bundled outline or single-stroke font |
| `BRepAlgoAPI_Section` (intersection curves), `BRepAlgoAPI_Splitter`, `BRepPrimAPI_MakeHalfSpace` | `BRepBuilderAPI_GTransform`: so no non-uniform scale |
| `HLRBRep_Algo` (silhouettes), `GeomAPI_ProjectPointOnSurf`, `BRepExtrema_DistShapeShape` (measure) | `ShapeFix_Shape` |
| `BRepGProp`, `GProp_GProps` (mass properties), `BRepCheck_Analyzer`, `ShapeUpgrade_UnifySameDomain` | |
| `gp_Elips2d`, `Geom2d_Ellipse`, `GC_MakeArcOfEllipse`, `Geom2dAPI_PointsToBSpline`, `GeomAPI_PointsToBSpline`, `GeomAPI_Interpolate`, `Geom2dAPI_InterCurveCurve`, `Law_Interpol` | |

So almost everything below can be built on the existing wasm.

---

## 1. Sketch entities and tools

### P0
- [ ] **Sketch on a face or a reference plane:** the sketch plane is a planar face selector or a `plane` feature, worked out again on every rebuild. *Design:* `plane: {ref: "<planeFeatureId>" | FaceSelector}` alongside the current `DatumPlane`. The sketch follows the face when upstream geometry moves. *(Cocaide has fixed datum planes only. This is the biggest gap.)*
- [ ] **Origin and default planes and axes as sketch references:** the origin point plus the projected X and Y axes can be selected for relations and dimensions in every sketch. *(Partial: the `origin` PointRef exists, the axes don't.)*
- [ ] **Line in chain mode:** click-click draws a polyline; double-click or Esc ends it. Moving back over the last endpoint, or pressing `A`, switches to a tangent arc. *Design:* type length and angle into floating boxes while placing; each typed value becomes a driving dimension (Fusion and Onshape do this).
- [ ] **Centerline:** a line with `construction: true`. Q, or right-click, toggles construction on any selection (as in Onshape). *(Partial: the flag exists. There's no tool and no toggle.)*
- [ ] **Midpoint line:** the first click is the midpoint and the line extends both ways symmetrically. It adds a midpoint relation to whatever the first click snapped to.
- [ ] **Rectangles:** corner, centre, 3-point corner (angled), 3-point centre and parallelogram. *Design:* the tools emit 4 `line`s plus relations (H/V or parallel/perpendicular, coincident corners). The centre variants add construction diagonals and a midpoint relation to the centre. Keep `rect` only as a legacy entity, because primitives can't be trimmed, filleted or partly dimensioned. *(Cocaide has a `rect` primitive only.)*
- [ ] **Circle (centre and radius) and perimeter circle (3-point).** *(Partial: centre only.)*
- [ ] **Arcs:** centrepoint, tangent (from an endpoint, with automatic tangent and coincident relations) and 3-point. *(Partial.)*
- [ ] **Slots:** straight, centrepoint straight, 3-point arc slot and centrepoint arc slot. Option to dimension overall length or centre-to-centre. *Design:* emit 2 lines, 2 arcs and a construction centreline, with tangent, equal and coincident relations, so slots trim and dimension normally. *(Partial: straight `slot` primitive only.)*
- [ ] **Polygon:** 3 to 40 sides, inscribed or circumscribed, with a construction circle. Equal and coincident relations; the angle stays free unless a side is set horizontal.
- [ ] **Point:** a stand-alone sketch point. It drives hole positions, sketch-driven patterns and dimension anchors.
- [ ] **Sketch fillet:** radius at corners or between two entities, with "keep constrained corners", so a virtual sharp stays and dimensions to the old corner survive. *Design:* the result is an arc plus tangent relations plus a construction `virtualSharp` point.
- [ ] **Sketch chamfer:** distance-distance (equal or unequal) and angle-distance.
- [ ] **Offset entities:** distance, reverse side, both directions, cap ends (arc or line), make the base geometry construction, select a chain. *Design:* one `offset` relation group with one driving dimension, so changing the dimension moves every offset curve. Do the line and arc offset analytically in TypeScript; `BRepOffsetAPI_MakeOffset` is a fallback.
- [ ] **Convert entities (project model edges):** project the selected model edges, face loops or other sketches' entities into the sketch, linked so they update. Options: inner loops, select chain. *Design:* `ref` entities with an edge or face selector, projected again on each rebuild (see §7, idea 3).
- [ ] **Trim:** power trim (drag across segments to delete them), trim to closest, corner (extend or trim two entities to meet), trim away inside or outside. It keeps or repairs relations on the pieces that remain.
- [ ] **Extend:** extend to the next intersection; Shift-drag in power trim extends.
- [ ] **Split entities:** insert a split point that becomes two entities joined by a coincident relation.
- [ ] **Mirror entities:** about a line or centreline, with or without copy. It adds `symmetric` relations entity to entity. *(The current symmetric relation covers points only, so it needs line, arc and circle symmetric too.)*
- [ ] **Dynamic mirror:** toggle it on a centreline and everything drawn on one side appears mirrored and related.
- [ ] **Linear and circular sketch patterns:** count, spacing or total angle, as dimensions or parameters. Instances to skip; equal relations to the seed.
- [ ] **Move, copy, rotate, scale and stretch entities:** base point and destination, or typed values. Option to keep relations.
- [ ] **Drag geometry with live solve:** drag a point, an entity or a whole chain; fixed and fully defined items resist. *(Cocaide has drag.)*
- [ ] **Shaded closed regions:** closed contours are filled lightly so the user sees what will extrude. Open chains and self-intersections show as warnings.
- [ ] **Region-based profiles:** overlapping curves split into planar regions, and features pick regions rather than "the sketch". *Design:* compute the arrangement graph of non-construction curves, then faces of the arrangement; a feature stores region ids as stable seed-point queries.

### P1
- [ ] **Ellipse and partial ellipse:** centre, major and minor axes, construction axes for dimensioning; `gp_Elips2d`. Relations to the axis endpoints.
- [ ] **Spline:** through points, with tangency and curvature handles and an optional control-polygon ("style spline") mode. Curvature comb display, and a "simplify / fit spline" tool. Equal-curvature relation at joins.
- [ ] **Intersection curve:** sketch geometry where the sketch plane cuts the selected faces or bodies (`BRepAlgoAPI_Section`), linked like converted entities.
- [ ] **Silhouette edges:** project a body's outline normal to the sketch plane (`HLRBRep_Algo`).
- [ ] **Sketch text:** font, height, spacing, bold and italic, along a curve, flip; becomes outlines that can be extruded or cut. Parametric content, for example `="PN-" + partNo`. *(No OCCT font support, so use opentype.js plus bundled fonts and convert to lines and B-splines.)*
- [ ] **Sketch picture or underlay:** a scaled image to trace over. *(Cocaide has the photo underlay; also allow it in any sketch.)*
- [ ] **Copy and paste entities** between sketches, keeping internal relations.
- [ ] **3D sketch:** lines, splines and points in 3D with Along X/Y/Z relations; used for sweep paths and frames. Ties into the weldment nodes.
- [ ] **Equation-driven curve:** explicit `y = f(x)` or parametric `x(t), y(t)`, with expressions from the variables.
- [ ] **Conic:** endpoints, apex, rho.
- [ ] **Sketch repair and "check sketch for feature":** finds gaps, overlaps, zero-length and duplicate entities, and open contours. Fixes them in one click.
- [ ] **Construction from model:** "convert as construction" and "use model edge as centreline for revolve".

### P2
- [ ] **Blocks:** reusable groups of entities with an insertion point, editable as one thing.
- [ ] **Segment:** divide an entity into N equal points or segments.
- [ ] **Derived sketch:** a copy of another sketch that is linked but can be placed independently.
- [ ] **Sketch on a non-planar face:** a projected curve.
- [ ] **Make path or chain group:** select a contour as one item.
- [ ] **DXF/DWG import into a sketch:** with layer filter and repair. This matters a lot for fabrication users and could move up to P1.

---

## 2. Relations and dimensions

### Relations
- [x] P0 Coincident, horizontal and vertical (entity and point pair), collinear, parallel, perpendicular, tangent, concentric, equal, midpoint, pointOn, fix. *(Cocaide has all of these.)*
- [ ] P0 **Symmetric for lines, arcs and circles**, not only points (SOLIDWORKS allows lines, arcs and ellipses).
- [ ] P0 **Intersection:** a point at the crossing of two lines. Inferred when you click on a crossing.
- [ ] P0 **Merge points:** two points become one shared point, a real topology merge rather than a coincident relation. *Design:* the solver keeps one variable, and the UI shows the shared vertex.
- [ ] P0 **Relations to external or model geometry:** horizontal or vertical to a model edge, parallel to a model edge or planar face, coincident to a model vertex, on-edge, collinear with a projected edge. Works through `ref` entities.
- [ ] P1 **Coradial:** same centre and same radius (concentric plus equal in one).
- [ ] P1 **Equal curvature and tangency at spline ends.**
- [ ] P1 **Pierce:** a sketch point where a 3D curve or edge passes through the sketch plane; used to locate sweep profiles.
- [ ] P1 **Fix slot, equal slots, doubled distance.** Doubled distance means a dimension measured to a centreline and shown as a diameter, used for revolve profiles.
- [ ] P1 **Along X, Y and Z** (3D sketch).
- [ ] P2 **Relation groups:** collect relations under a name, then suppress or edit them together (SOLIDWORKS 2026 SP1).
- [ ] P2 **Tangent to face, on surface** (3D sketch).

### Dimensions
- [x] P0 Point-to-point, horizontal and vertical (X and Y), point-to-line, radius, diameter, angle between lines. *(Cocaide has these.)*
- [ ] P0 **Smart Dimension infers the type from the picks and the cursor position.** Two points: aligned, horizontal or vertical depending on where you drop it. Two lines: parallel distance or angle, and which of the four angle quadrants. Line and circle: tangent distance. Circle: diameter by default, right-click to switch to radius.
- [ ] P0 **Line-to-line parallel distance** (two lines, not a point and a line).
- [ ] P0 **Arc conditions min, max and centre:** a dimension to a circle or arc measured to its centre, nearest or farthest point. Shift-click a circle to get min or max.
- [ ] P0 **Arc length:** select the arc and its two endpoints.
- [ ] P0 **Driven (reference) dimensions:** shown grey or in parentheses. A driving/driven toggle. When a new dimension would over-define, prompt "Make this dimension driven?" (SOLIDWORKS does exactly this).
- [ ] P0 **Dimension to reference edges, model edges, vertices, origin and planes:** pick any model edge or vertex while in a sketch. A hidden `ref` entity is created automatically and dimensioned. *(This is the user's explicit example.)*
- [ ] P0 **Diameter dimension across a revolve centreline:** a "linear diameter" that shows twice the distance to the centreline.
- [ ] P0 **On-screen numeric input while drawing:** typed values become dimensions.
- [ ] P0 **The Modify box takes expressions, units, parameters and functions:** `=width/2`, `1in`, `25.4mm + 3`, `30deg`, `sqrt()`, `sin()`, `min()`, `max()`, `round()`, `if(c, a, b)`. *(Partial: + - * / and parameters only.)* It also needs spin increments, Rebuild and Reverse.
- [ ] P0 **Named dimensions:** every dimension has a stable name (`sk1.width`, renameable) that any expression can reference. This replaces SOLIDWORKS' `D1@Sketch1`.
- [ ] P0 **Dimension display:** drag to place the text, flip arrows, text size fixed in screen space, and double-click to edit in place.
- [ ] P1 **Ordinate and baseline dimensions:** a chain from one base entity, all driving.
- [ ] P1 **Chamfer dimension in a sketch:** length × angle on a sketch chamfer.
- [ ] P1 **Angle to an implied horizontal or vertical:** via three points, or a line plus the sketch axis.
- [ ] P1 **Linked values:** several dimensions share one variable. *Design:* this falls out of the expressions; "link" just writes `=name`.
- [ ] P1 **Fully Define Sketch:** proposes relations and dimensions from a chosen datum (origin or selected entities), in baseline, ordinate or chain style, with a preview before it applies.
- [ ] P2 **Path length:** the total length of a chain, as a dimension that can drive it.

### Status and solver user experience
- [ ] P0 **Status colours:**
  - Under defined is blue, fully defined is black, over defined is red.
  - Dangling (lost external reference) is brown or mustard.
  - Not solved is pink, and an invalid solution is yellow.
  - *(Partial: blue and black.)*
- [ ] P0 **Degrees-of-freedom readout:** the status bar shows "Under defined, 3 DOF". Hovering an under-defined entity shows arrows for the motion it still has. *(Cocaide already computes the null space.)*
- [ ] P0 **Display/Delete Relations panel:** lists every relation and dimension, filtered by entity, status (satisfied, over-defining, dangling) or type. Delete, suppress, replace the referenced entity. Click a row to highlight it.
- [ ] P0 **Conflict diagnosis (SketchXpert):** on over-definition, find the minimal conflicting set and offer "delete X", "make driven" or "delete Y" solutions with a preview.
- [ ] P0 **Inference lines:** dotted alignment lines to endpoints, midpoints and centres, horizontal and vertical. The relation is added only if the user releases on them.
- [ ] P0 **Snaps:** endpoint, midpoint, centre, quadrant, intersection, nearest, tangent, perpendicular, parallel, horizontal or vertical, grid, angle increments. Shown as a glyph at the cursor.
- [ ] P0 **Quick snaps:** a one-shot override from the right-click menu, such as "next pick snaps to tangent only".
- [ ] P0 **Automatic relations toggle:** global, plus hold Ctrl while drawing to suppress them. *(Partial: auto relations exist.)*
- [ ] P1 **Solver stability:** least-motion solving, no flips (keeps arc orientation and side of line), and a fallback that reports "could not solve" without corrupting the geometry.

---

## 3. Reference geometry

Each reference becomes a feature in the history and can be selected by features and sketches.

- [ ] P0 **Default Front, Top and Right planes and the origin as named references** (`Front`, `Top`, `Right`, `Origin`) that features use instead of raw normals.
- [ ] P0 **Plane features:**
  - offset from a plane or face, with a distance and N instances;
  - at an angle about an edge or axis from a plane or face;
  - through 3 points;
  - through a line and a point;
  - parallel to a plane, through a point;
  - midplane between two parallel or angled faces or planes (bisector);
  - normal to a curve at a point or a distance along it;
  - tangent to a cylindrical face, at an angle or through a line;
  - with a flip-normal option.
  - *Design:* a single `plane` op with `attach` (see idea 2), so the mode is inferred from what you select.
- [ ] P0 **Axis feature:** through two points or vertices, from two planes' intersection, along a cylinder or cone axis, along a linear edge, normal to a face through a point. A temporary axis on each cylindrical face can be selected without making a feature.
- [ ] P0 **Show and hide planes, axes and points.** Planes resize to fit the model, and their labels show in the view.
- [ ] P1 **Point feature:** arc centre, face centroid, intersection of an edge with a plane or face, projection onto a face, N points along a curve or at a distance.
- [ ] P1 **Coordinate system:** origin plus axis refs; used by measure, mass properties, STEP export frame and pattern directions.
- [ ] P1 **Helix and spiral curves:** pitch and revolutions, or height and pitch, variable pitch, taper. Needed for thread and spring sweeps.
- [ ] P1 **Composite curve and projected curve** (a sketch projected onto a face, or two sketches' intersection).
- [ ] P1 **Bounding box:** best-fit or aligned to a CS, shown as reference geometry and exposed as `bbox.x` and similar variables.
- [ ] P2 **Patterns of reference planes:** pattern the plane feature itself (SOLIDWORKS 2025).
- [ ] P2 **Split line:** splits a face by a projected sketch or an intersection, for draft and face selection.
- [ ] P2 **Curve through XYZ points** from a table or CSV.
- [ ] *(Skip mate references; those are for assemblies.)*

---

## 4. Features

### Extrude (one feature for boss, cut and intersect)
- [ ] P0 **Operation types:** new body, add, remove, intersect, plus a merge scope (which bodies). Replaces separate `extrude` and `cut`. *(Cocaide has `extrude` and `cut` ops, plus newBody and bodies.)*
- [ ] P0 **End conditions:** blind, through all, through all both, midplane, up to next, up to vertex, up to face or plane (extended surface), offset from face (with reverse offset and translate surface), up to body. *(Cocaide has blind, midplane and throughAll.)* *Implementation:* `BRepFeat_MakeDPrism.Perform(Until)` or `Perform(From, Until)`. Alternatively make a long prism and boolean it with a half-space at the target face.
- [ ] P0 **Direction 2** with its own end condition and depth; on by default when the sketch plane is inside the material.
- [ ] P0 **Start ("From"):** sketch plane, offset distance, surface, face or plane, or vertex.
- [ ] P0 **Region and contour selection:** extrude chosen regions or closed contours of a sketch. The same sketch can be reused by several features.
- [ ] P0 **Flip side to cut, and reverse direction.**
- [ ] P1 **Draft while extruding:** inward or outward, an angle per direction. Uses `BRepFeat_MakeDPrism`, or `BRepOffsetAPI_DraftAngle` on the side faces.
- [ ] P1 **Thin feature:** one-direction, midplane or two-direction thickness, cap ends, auto-fillet corners. Makes walls and ribs from open sketches.
- [ ] P1 **Direction along an edge or vector** for a slanted extrude. *(Partial: `direction` exists as a raw vector; it should also take an edge, axis or face reference.)*
- [ ] P2 **Up to a vertex or face with an offset and a draft on both sides.**

### Revolve
- [ ] P0 **Axis:** sketch centreline, model edge, reference axis or sketch axis. Angle; both directions with two angles; midplane. Same new/add/remove/intersect operations and region selection. Uses `BRepPrimAPI_MakeRevol`.
- [ ] P1 **Up to vertex, face or plane**, and thin revolve (walls, cap ends).

### Sweep
- [ ] P1 **Profile along a path:** sketch, 3D sketch, edges or helix, with add or remove operations. Orientation: follow path, keep normal constant, follow path and first guide, or minimum twist. Twist by angle or turns along the path. Start and end tangency. Uses `BRepOffsetAPI_MakePipeShell` (twist through `SetLaw`, orientation through `SetMode`).
- [ ] P1 **Circular-profile sweep:** a diameter only, no profile sketch, for pipes, wires and springs (SOLIDWORKS 2018+).
- [ ] P2 **Guide curves; cut sweep with a solid tool body** (tool-path machining).

### Loft
- [ ] P1 **Ordered profiles:** sketches, faces or points, with start and end constraints (none, normal to profile, direction vector, tangent to face) and weight. Connector or alignment control, closed loft, thin, add or remove. Uses `BRepOffsetAPI_ThruSections`.
- [ ] P2 **Guide curves, centreline loft.**
- [ ] P2 **Boundary** (solid boundary feature). Borderline surfacing, so low priority.

### Holes and threads
- [ ] P0 **Hole Wizard:**
  - Standards: ISO, ANSI metric, ANSI inch, DIN.
  - Types: simple, counterbore, countersink, tapped (tap drill, thread depth, cosmetic thread), pipe tap, counterbore slot.
  - Clearance fits: close, normal, loose, driven by a size table.
  - End conditions: blind, through all, up to next, up to face. Near-side and far-side countersink.
  - Positions are **all the points in a sketch**, on planar or non-planar faces.
  - *Design:* standards live as JSON tables, and the feature stores `{standard, type, size, fit, positions: sketchId}`, so callouts come out for free. *(Partial: single centre on a planar face, custom counterbore or countersink only.)*
- [ ] P1 **Cosmetic thread:** spec plus depth stored on a cylindrical face, shown as a dashed helix-ish texture or ring, fed to drawings and mass properties as "thread".
- [ ] P1 **Thread feature:** modelled helical thread (ISO metric, UNC/UNF, trapezoidal), internal or external, with start offset and trim. Built from a helix plus `MakePipeShell`.
- [ ] P2 **Advanced Hole:** a stack of near-side and far-side elements per hole, such as counterbore plus counterbore plus tapped.

### Fillet and chamfer
- [ ] P0 **Constant-radius fillet:**
  - many edges, plus multiple radius sets in one feature;
  - tangent propagation;
  - select by face (all its edges), by feature (all edges a feature made), or by loop;
  - full preview, and a clear message when an edge fails.
  - *(Partial: one radius over the selectors' matches.)*
- [ ] P0 **Chamfer:**
  - distance-distance, equal or asymmetric, with a flip-side option;
  - angle-distance;
  - a selection helper (loop, tangency, convex, concave).
  - Uses `MakeChamfer.Add(d1, d2, E, F)` and `AddDA`.
  - *(Partial: equal distance only.)*
- [ ] P1 **Variable-radius fillet:** radii at vertices and at mid-edge parameters, linear or smooth. Uses `Add(UandR, E)` or a `Law_Function`.
- [ ] P1 **Face fillet:** between two face sets, with hold-line or chord-width options. Full-round fillet: three face sets (side, centre, side).
- [ ] P1 **Selection helpers:** select tangency, loop, all concave or convex edges, edges of feature, and "select other" for hidden edges.
- [ ] P2 **Setback fillets, conic or curvature-continuous profiles, vertex chamfer, offset-face chamfer, FilletXpert ordering.**

### Shell, draft and rib
- [ ] P0 **Shell:** remove faces, thickness inward or outward (no faces removed gives a hollow body). Uses `MakeThickSolidByJoin`.
- [ ] P1 **Multi-thickness shell:** per-face thickness overrides. A bad-thickness diagnosis points at the face whose radius is smaller than the thickness.
- [ ] P1 **Draft:** neutral plane or face, faces to draft, angle, tangent propagation. Uses `BRepOffsetAPI_DraftAngle`.
- [ ] P2 **Parting-line draft, step draft, draft analysis colouring.**
- [ ] P1 **Rib:** from an open sketch line, thickness on one or both sides, extruded parallel or normal to the sketch, extended to the next faces of the body, optional draft. *Implementation:* thicken the open curve into a region, extrude it up to the next boundary, then intersect with the body's hull.

### Body tools
- [x] P0 Combine (add, subtract, common), split by plane, move or copy bodies, delete or keep bodies. *(Cocaide has these.)*
- [ ] P1 **Split by a sketch, face or surface, with the resulting bodies named.**
- [ ] P1 **Scale:** uniform, about the centroid, origin or a CS. Non-uniform needs `GTransform`, which isn't in the build, so that part is P2.
- [ ] P2 **Wrap** (emboss or deboss a sketch onto a cylinder), **dome**, **indent**, **flex** (bend, twist, taper, stretch), **deform**.
- [ ] P2 **Insert or derive part:** pull another Cocaide part in as a body, linked.

### Mirror and patterns
- [ ] P0 **Mirror:** several features, faces or bodies at once, about a plane or a planar face. *(Partial: one feature or bodies, about a datum.)*
- [ ] P0 **Linear pattern:**
  - two directions; spacing and count, or "up to reference" spacing;
  - pattern the seed only in direction 2;
  - **instances to skip** (click them in the view);
  - **several features and bodies at once**.
  - The direction can be an edge, axis or face normal.
  - *(Partial.)*
- [ ] P0 **Circular pattern:** about an axis, edge or cylindrical face. Equal spacing or a set angle, both directions, instances to skip, several features. *(Partial.)*
- [ ] P1 **Sketch-driven pattern** (at the points of a sketch, with a reference point), **table-driven pattern** (XY coordinate table or CSV), **curve-driven pattern**.
- [ ] P1 **"Geometry pattern" option:** copies faces instead of re-running the feature, which is faster but less flexible.
- [ ] P2 **Fill pattern** (perforation layouts inside a boundary), **variable pattern** (vary dimensions per instance; see idea 9).

### Equations, configurations and properties
- [ ] P0 **Global variables and equations:** units, functions and conditionals, plus a "used by" list per variable. *(Partial: `parameters` exist.)*
- [ ] P1 **Configurations:** named sets of variable overrides, feature suppression states and material. A table view like a design table, editable in the app and importable or exportable as CSV.
- [ ] P1 **Custom properties:** part number, description, material, finish, mass. Usable in sketch text and in drawings.
- [ ] P1 **Material library with density:** sets mass properties and appearance. *(Partial: body materials and density.)*

---

## 5. Workflow and interface details

### History and rebuild
- [ ] P0 **Rollback bar:** drag it in the tree or timeline. New features are inserted at the rollback point; "roll to end" and "roll to previous" are available. Features below the bar are greyed out.
- [ ] P0 **Edit feature and edit sketch:** double-click or right-click. A live preview while editing, OK or Cancel, and the user edits within the feature's position in history.
- [ ] P0 **Reorder by drag with dependency validation:** refuse a drop above a parent and say why.
- [ ] P0 **Parent and child relations:** hovering a feature highlights its parents and children with arrows, like SOLIDWORKS' dynamic reference visualisation.
- [ ] P0 **Suppress and unsuppress with dependents.** *(Partial: suppress exists.)* **Rebuild** with Ctrl+B and a force rebuild with Ctrl+Q.
- [ ] P0 **Errors and warnings per feature, without cascading:**
  - The feature that failed shows a red marker and its children show yellow.
  - A "What's wrong" panel names the lost reference, ghosts the old geometry, and offers fixes.
  - Fixes: re-pick, nearest match, suppress.
- [ ] P0 **Rename features, with a rename that updates every reference.**
- [ ] P1 **Folders and comments in the tree, filter or search the tree, feature tags.**
- [ ] P1 **Feature freeze bar:** features above it aren't rebuilt, which speeds things up.
- [ ] P2 **Copy and paste features** with re-picked references; drag a feature onto a face to copy it.

### Selection
- [ ] P0 **Hover pre-highlight**, plus **Select Other**: Alt or right-click cycles through faces and edges hidden behind the one under the cursor.
- [ ] P0 **Selection filters:** faces, edges, vertices, sketch entities, planes and axes, bodies. A toolbar plus hotkeys.
- [ ] P0 **Box and lasso select** in 3D (window includes; crossing touches).
- [ ] P1 **Selection helper:** after picking an edge or face, offer tangency, loop, the feature's faces, convex or concave edges.

### Direct manipulation
- [ ] P0 **Instant3D drag handles:** select a feature face and drag an arrow handle to change depth or offset, with a ruler that snaps to geometry, and type the value. The change is written back to the feature parameter.
- [ ] P0 **Show feature dimensions on the model:** double-click a feature to show its dimensions (sketch plus feature) in 3D. Double-click a dimension to edit it in place and rebuild. This is one of SOLIDWORKS' most-used details.

### Inspection
- [ ] P0 **Measure tool:** pick any two entities to get min or centre distance, normal distance, dX, dY and dZ, angle, radius or diameter, edge length, face area, point XYZ. Arc conditions apply. It stays open while picking. Uses `BRepExtrema_DistShapeShape`. *(Cocaide has a measurements panel for bodies but no interactive measure.)*
- [ ] P1 **Mass properties:** mass, volume, area, centre of mass, principal axes and moments, inertia tensor at the centre of mass and in a chosen CS, a mass override. Uses `BRepGProp`. *(Partial.)*
- [ ] P1 **Check geometry** (`BRepCheck_Analyzer`), **interference** *(Cocaide has body interference)*, **thickness and curvature analysis** (P2).

### View and display
- [ ] P0 **Section view:** a plane from Front, Top or Right or a face, with offset and rotation drag handles, up to 3 planes, a coloured cap, sections per body.
- [ ] P0 **Display styles:** shaded with edges, shaded, hidden lines removed, hidden lines visible, wireframe. Perspective toggle; tangent edges visible, as phantom or hidden.
- [ ] P0 **View commands:** zoom to fit (F), zoom to selection, zoom to area, previous view, view cube or triad with standard views, Normal To *(Cocaide has this)*, and automatic Normal To on entering a sketch (an option).
- [ ] P0 **Hide and show:** bodies, sketches, planes and axes, with a global "hide all types" toggle. *(Partial: bodies.)*
- [ ] P1 **Isolate the selection; transparency; appearance and colour per face, feature or body.**
- [ ] P1 **Confirmation corner:** OK and Cancel in the top-right of the viewport while in a feature or sketch.

### Command access and units
- [ ] P1 **Mouse gestures:** right-drag radial menu.
- [ ] P1 **Command search:** a palette that runs any command by name.
- [ ] P0 **Units:** inputs accept `in`, `mm` and `deg` and are converted on the fly. P1: display units per document (mm or in).

### Import and export
- [ ] P1 **DXF export of a sketch or planar face** (laser and plasma users).
- [ ] P1 **DXF import** into a sketch.
- [ ] P2 **IGES.**

### Automated assistants
- [ ] P2 **Design Checker, FeatureXpert:** automatic fillet and draft reordering on failure.
- [ ] P2 **Breadcrumbs:** a selection shows its owner chain.

---

## 6. What other CAD packages do better, and what to take from each

- **Onshape:**
  - A single Extrude, Revolve, Sweep and Loft, each with **New / Add / Remove / Intersect** and a **merge scope**.
  - Extrude end conditions: Blind, Up to next, Up to face, Up to part, Up to vertex, Through all, Symmetric, Second end position, Starting offset, Draft.
  - The **variable feature** sits *in the history*, and **Variable Studio** shares variables across part studios.
  - **Configurations** are a first-class table.
  - **Query-based (feature-relative) selections**, which Cocaide already resembles with selectors.
  - A **Part Studio** holds many parts.
  - **Mate connectors** act as implicit frames anywhere.
  - Sketch **Use** (project, linked) and **Intersect**; **Transform** in a sketch; the **S** shortcut toolbar.
  - Feature list filter and folders; **FeatureScript**, where custom features are first-class.
- **Fusion 360:**
  - A **timeline** with dependency highlighting.
  - **Press-pull**, one context tool: a face does offset or extrude, an edge does fillet.
  - **Fillet, chamfer and rule fillet** in one dialog with per-row type; rule fillet means "all edges between features" or "all concave".
  - Tab between typed dimensions while drawing; projected geometry stays linked, with "break link".
  - A Change Parameters dialog with units and expressions; a marking menu; and a sketch palette with Look At, Slice and Show Profile.
- **Shapr3D and Plasticity:**
  - **Selection first**: select something and a context bar offers only valid operations.
  - Live drag with typed values and snapping.
  - Very fast multi-target operations, such as fillet 40 edges with one drag.
  - Shapr3D added parametric history on top of direct editing; that hybrid is the model to copy.
- **FreeCAD:**
  - **Expressions everywhere**, including cross-references (`Sketch.Constraints.width`) and spreadsheets.
  - The **Attachment engine**: any datum or sketch attaches to references with a *mode* plus an *offset placement*. It is one general system instead of 9 dialogs.
  - Sketcher **external geometry** and **carbon copy**; **block constraint**.
- **Solid Edge (synchronous):**
  - Direct face edits that keep **live rules** (coplanar, concentric, tangent, symmetric) and **3D driving dimensions** on the model, mixed with a history tree.
- **Creo:** **Flexible modelling** (move or offset or replace faces with automatic re-intersection), **intent references**, and **user-defined features (UDFs)** as reusable templates.
- **CATIA:** knowledgeware (rules, checks, reactions) and PowerCopy templates.
- **Inventor:** iLogic-style rules (*if length > 500 then add a stiffener*).
- **nTop:** a reusable block graph. The idea worth taking is to package feature subgraphs as reusable, typed custom features.
- **SOLIDWORKS pain points to *avoid*:**
  - Boss and Cut duplication, and one feature type per fillet variant.
  - `D1@Sketch1` naming and body names like "Boss-Extrude3[2]".
  - Modal dialogs, and a hidden "Edit Sketch Plane".
  - Lost references cascading into red trees.
  - Configurations buried in Excel design tables.
  - The two-tab Type/Positions workflow in Hole Wizard.
  - Virtual sharps that are hard to find.

---

## 7. Ten concrete ways to be smarter and cleaner than SOLIDWORKS

1. **One feature per shape-making method, with an operation type.**
   - `extrude`, `revolve`, `sweep` and `loft` each take `operation: "new" | "add" | "remove" | "intersect"` plus `scope: bodies[]`. Delete `cut` as a separate concept and keep it as an alias for old documents.
   - The default operation is inferred and shown, but can be overridden:
     - a profile on a face, pointing out of the material → add;
     - pointing into it → remove;
     - in free space → new body.
   - This halves the toolbar and the AI agent's tool surface.
2. **A universal attachment engine for all reference geometry.**
   - Every plane, axis, point, CS and sketch plane is `{attach: {mode, refs: Selector[], offset: {translate, rotate}}}`.
   - The interface has *one* "Reference" tool that infers the mode from what you pick:
     - one face → offset plane;
     - two faces → midplane;
     - edge plus face → angle plane;
     - three vertices → 3-point plane;
     - cylinder → axis.
   - It works like Onshape mate connectors and FreeCAD attachment, minus the dialog sprawl. Sketches attach the same way, so "sketch on face" comes free.
3. **External references as first-class sketch entities (the user's example).**
   - A `ref` entity type: `{type: "ref", source: EdgeSelector | VertexSelector | {plane|axis: id}, construction: true}`.
   - It is projected again on every rebuild and drawn in a distinct colour, purple as in SOLIDWORKS.
   - It can be used in any relation or dimension like ordinary geometry.
   - Picking a model edge or vertex with Smart Dimension or Add Relation *creates it automatically*, so the user never has to "convert entities first".
   - Each one shows a state (linked, broken) with a one-click "re-attach". Broken refs turn the dependent relations brown; they don't explode the sketch.
4. **Expressions everywhere, with units and named dimensions.**
   - Every numeric field accepts `=expr` with units, functions, conditionals and references to *any* named dimension (`sk1.width`, `hole1.size`, `bbox.z`, `mass`).
   - Variables can be declared at a point in history (the Onshape variable feature). The Variables panel shows the value, its source and "used by".
   - Configurations are just named override sets.
5. **Selection by intent, not by face ID.**
   - Extend the existing selectors with semantic queries:
     - `createdBy: featureId` (faces or edges a feature made);
     - `loop: inner|outer` of a face;
     - `convex|concave`;
     - `tangentChain`;
     - `fromRegion: sketch.region`;
     - `between: [feature A, feature B]`.
   - Render each query as readable chips ("Edges of Cut2, top loop") that the user and the AI can both edit. This is where the topological naming problem is beaten.
6. **One "Edge treatment" feature.**
   - Fillet, chamfer, variable, setback and full round become rows in one feature. Each row is an edge-set query plus a type: constant R, variable `(u, r)[]`, chamfer distance-distance, chamfer distance-angle, conic.
   - Plus rule rows: "all concave edges of body X", "all edges of feature Y".
   - Fewer features, a cleaner tree, one place to fix a failure, and a *per-row* error message.
7. **Selection-first contextual bar plus a command palette.**
   - Select a face → Extrude / Offset / Shell / Sketch / Hole / Draft.
   - Select an edge → Fillet / Chamfer.
   - Select a sketch region → Extrude / Revolve.
   - Select two sketch lines → ranked relation and dimension suggestions.
   - A palette (S or Ctrl+K) searches every command. This takes Shapr3D and Plasticity speed without losing history.
8. **Direct manipulation that stays parametric.**
   - Drag handles (Instant3D, improved) on faces and features: drag snaps to model geometry, and a value can be typed.
   - The drag *writes back* to the owning parameter (depth, offset, radius, sketch dimension).
   - If no single parameter owns the face, it offers to insert an `offsetFace` or `moveFace` feature (Fusion press-pull, Solid Edge live rules). Direct editing never breaks the parametric model.
9. **Patterns of anything, varied by expressions.**
   - A pattern copies features, bodies or faces; instances are skipped by clicking.
   - Each instance can read `i` (index) and `n` inside its seed's expressions, so `="10 + i*2"` gives growing holes.
   - This replaces SOLIDWORKS' clunky Variable Pattern, Table Pattern and Fill Pattern with one mechanism. Sketch-point patterns and CSV table patterns become just position sources.
10. **Rebuild that diagnoses first, plus a sketch solver that teaches.**
    - Every failure names the lost reference, ghosts where it *was*, and offers ranked fixes (nearest match, re-pick, suppress).
    - Children rebuild against the last good geometry wherever possible, so one error doesn't cascade into a red tree.
    - In sketches:
      - a DOF counter, with motion arrows on under-defined entities;
      - over-definition shows the *minimal conflicting set*, with "make driven" or "delete" choices;
      - "Fully define" proposes a scheme from a datum.
    - All of it is exposed to the AI agent as structured data, so it can fix models itself.

**Two more ideas:**
- **Sketch regions as the profile model.** Overlapping geometry is allowed. Regions are computed and shaded automatically, and several features can share one sketch.
- **Hole standards as data.** JSON tables drive sizes, fits, tap drills and drawing callouts. Positions are any sketch's points.

---

## 8. Suggested build order

1. **Foundations:**
   - `plane`, `axis` and `point` features through the attachment engine;
   - sketch-on-face and sketch-on-reference;
   - `ref` sketch entities, with dimensions and relations to model geometry and the origin axes;
   - rectangles and slots decomposed into lines and arcs;
   - region detection.
2. **Sketch tools:** trim, extend, split, offset, mirror, dynamic mirror, sketch fillet and chamfer, sketch patterns, move/copy/rotate/scale, polygon, 3-point arc and circle, tangent arc, midpoint line, point, centreline, construction toggle (Q).
3. **Dimensions:**
   - line-to-line, min/max/centre arc conditions, arc length;
   - driven dimensions with the over-define prompt, revolve diameter dimension;
   - named dimensions, expressions with units and functions, on-screen input;
   - Display/Delete Relations, the conflict solver and the DOF display.
4. **Features:**
   - a unified extrude (operations, all end conditions, direction 2, from-offset, thin, draft) and revolve;
   - shell; fillet and chamfer rows (distance-distance, distance-angle, variable);
   - Hole Wizard with standards and sketch-point positions;
   - multi-feature and skip-instance patterns, sketch-driven patterns; mirror by face.
5. **Workflow:**
   - rollback bar, reorder with validation, parent and child highlighting;
   - error panel with fixes;
   - measure tool, selection filters and Select Other;
   - Instant3D handles, feature dimensions on double-click;
   - display styles, hide/show all types.
6. **P1 features:**
   - sweep (including circular profile and twist), loft, draft, rib;
   - helix and thread, cosmetic thread;
   - ellipse, spline, intersection and silhouette curves, sketch text;
   - configurations, mass properties, DXF in and out.

Every new op needs the same set of pieces Cocaide already uses for each op:
- types plus `FEATURE_OPS` and validation in `src/doc/validate.ts`;
- commands and scope;
- rebuild in `src/kernel/rebuild.ts` and `ops.ts`;
- a property editor;
- an entry in the agent and MCP reference;
- a test.

That keeps every tool usable by the AI agent too.

---

Sources:
- [Javelin: SOLIDWORKS Sketch Relations Summary](https://www.javelin-tech.com/blog/2014/01/solidworks-sketch-relations-summary/)
- [GoEngineer: SOLIDWORKS Sketch Relations Guide](https://www.goengineer.com/blog/solidworks-sketch-relations-guide)
- [SOLIDWORKS Help: Description of Sketch Relations](https://help.solidworks.com/2021/english/SolidWorks/sldworks/c_description_of_sketch_relations.htm)
- [SOLIDWORKS Help: Sketch Relations Overview](https://help.solidworks.com/2018/English/SolidWorks/sldworks/c_Sketch_Relations_Overview.htm)
- [Onshape Help: Extrude](https://cad.onshape.com/help/Content/extrude.htm)
- [Onshape forum: improvements Feb 2023 (second end from starting offset, draft from offset)](https://forum.onshape.com/discussion/20115/improvements-to-onshape-february-3rd-2023)
- [Onshape forum: extrude to face second end option](https://forum.onshape.com/discussion/6695/extrude-to-face-second-end-option)
- [Onshape Help: Sketch Tools](https://cad.onshape.com/help/Content/sketch-tools.htm)
- [Onshape tech tip: Sketch tools Use / Intersection](https://onshape.com/en/resource-center/tech-tips/sketch-tools-use-intersection)
- [SolidProfessor: SOLIDWORKS 2026 enhancements for sketches, features and parts](https://solidprofessor.com/blog/solidworks-2026-enahcements-sketches-features-parts)
- [SolidProfessor: What's New in SOLIDWORKS 2026 SP1](https://solidprofessor.com/blog/whats-new-solidworks-2026-sp1/)
- [Javelin: Part Modeling, What's New in SOLIDWORKS 2026](https://www.javelin-tech.com/3d/part-modeling-whats-new-in-solidworks-2026/)
- [GoEngineer: SOLIDWORKS 2025 Parts & Features, What's New](https://www.goengineer.com/blog/solidworks-2025-parts-and-features-whats-new)
- [Engineers Rule: 20 things to look forward to in SOLIDWORKS 2025](https://www.engineersrule.com/20-things-to-look-forward-to-in-solidworks-2025/)

Local files read:
- `/home/user/Cocaide/src/doc/types.ts`
- `/home/user/Cocaide/docs/roadmap.md`
- `/home/user/Cocaide/src/doc/parameters.ts`
- `/home/user/Cocaide/node_modules/replicad-opencascadejs/dist/replicad_single.d.ts`