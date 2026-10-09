# Wave plan (coordinator notes)

Concurrency is 2 agents (4 CPUs). Each wave = two worktree agents on mostly disjoint files; the coordinator merges,
runs tsc + vitest + full e2e, fixes, commits, pushes.

- W0  A1a doc/kernel registry + DatumRef + open sketches + scale op  ∥  A1b UI registries + FeatureForm + CommandManager + multi-face + icons/commands
- W1  datums (plane/axis/point ops, viewport datums, Reference tab, sketch on plane/face refs, vertex picking)  ∥  sketch tool registry + point entity + draw tools (centre rect, 3-pt rect, parallelogram, polygon, centerline, midpoint line, 3-pt arc, tangent arc, 3-pt circle, centrepoint slot)
- W2  sketch references (ref entities, solver constants, X/Y axes, rebuild solve, convert entities, dimension to model edges, history-correct reference edges)  ∥  features batch 1 (revolve, shell, draft, scale UI)
- W3  sketch edit tools (trim/extend/split/fillet/chamfer/offset/mirror/patterns/move/rotate/scale/copy/explode)  ∥  extrude upgrades (end conditions, dir 2, from offset, draft, thin, intersect) + fillet/chamfer upgrades
- W4  sweep (+ helix, circle profile, twist) + loft + rib  ∥  dimensions & expressions (driven, named, arc length, min/max/centre, symmetric entities, functions+units, fully define, make-driven prompt)
- W5  hole wizard + pattern/mirror upgrades + sketch-driven pattern  ∥  evaluate & view (rollback bar, measure, mass props, section view, display styles, zoom to selection, camera persistence, Instant3D depth drag)
- W6  AI tools (listFaces/listEdges, measureBetween, getSketch, facePlane, batch, sketchProfile, fullyDefine, screenshot, build budget, reference split + strategy + examples)  ∥  spline + ellipse entities
- W7  adversarial whole-diff review + fixes; README/roadmap; final verification
