# Phase O — finished

The user's request: make Cocaide a professional-grade parametric part modeller ("smarter and cleaner" than the usual CAD tools, "all the little
things", reference edges you can dimension to, more tools for the AI). Built in waves of two parallel engineers (git
worktrees under .claude/worktrees), each followed by an adversarial reviewer, then merged, fully tested and pushed.

Done and pushed on ccr-851589c3-2dh2fn:
- Wave 0: feature/tool/editor registries, DatumRef reference system, CommandManager tabs, scale op.
- Wave 1: plane/axis/point features, datums in the view and tree, vertex picking, sketch on any plane or face;
  sketch tool registry, point entity, rectangles/polygon/arcs/slots/centerline/midpoint line, flyouts.
- Wave 2: sketch references to model edges (dimension/relate to them, follows the model, Convert Entities, X/Y axes,
  rebuild solves sketches, history-correct edges); Revolve (cut, thin, two directions), Shell, Draft, Scale tool;
  fix for the flaky table-frame mirror test.

- Wave 3: sketch edit tools (trim, power trim, extend, split, sketch fillet/chamfer, offset, mirror, linear/circular
  sketch patterns, move/copy/rotate/scale, explode, shaded regions, Check sketch); extrude up to next/face/vertex,
  offset from face, direction 2, start offset, draft, thin, intersect, regions; variable fillets, radius sets,
  two-distance and distance-angle chamfers.
- Wave 4: sweep (sketch path, model edges, exact helix incl. taper, circle/tube profile, twist), loft (ruled/smooth,
  closed, pointed ends, holes), rib; driven and named dimensions, expressions with functions/units/conditionals,
  arc length, min/max/centre conditions, linear diameter, intersection/coradial relations, status line, relations
  panel, conflict diagnosis with one-click fixes, Fully Define, typed values while drawing.
- Wave 5: Hole Wizard (ISO sizes and fits, counterbore/countersink/tapped with thread callouts, several centres or a
  sketch's points, through all, up to next); patterns of several features with skipped instances and directions from
  edges/axes/faces; mirror of several features about a face; sketch-driven pattern; face selectors that survive the
  face moving; rollback bar, measure, mass properties, section view, display styles, drag handles, command palette.
- Wave 6: AI inspection tools (faces, edges, measure, sketches, face
  planes, datums, part summary, screenshots), all-or-nothing batch with dry run, sketchProfile / fullyDefine / hole
  layout helpers, plan + self-check with a bigger build budget, sectioned reference with worked examples, new chips;
  ellipse, partial ellipse and spline sketch entities end to end.
- Every mention of a commercial CAD product was removed from the repo; the mouse scheme is now "standard".
- Wave 7: adversarial review of the whole Phase O diff in four areas (sketch, kernel, UI, AI), with Waves 5 and 6
  reviewed in full for the first time. Every finding was fixed on two branches and merged (see the two Wave 7
  sections of api.md); README and roadmap updated; docs screenshots regenerated with the new UI, plus new README
  pictures of the Hole Wizard (docs/phase-o-hole-wizard.png) and the section view (docs/phase-o-section.png).
  tsc, the whole Vitest suite and the whole e2e suite pass.

**Phase O is finished.** The briefs (docs/phase-o/briefs/), the contract (DESIGN.md) and the API notes (api.md) stay
as the record of how it was built.

Remaining follow-ups (none blocks use; details in the "Open follow-ups" lists of api.md, summary in docs/roadmap.md):
- Sketch: trim/extend/split/offset of ellipses and splines; ellipse tangency to circles, arcs and ellipses; spline
  curvature-continuous joins and a direct end-tangent dimension; an intersection curve; dynamic mirror; shift-drag
  extend in power trim; patterned line/arc copies that cannot turn; offset side from the pointer; draggable
  dimension text; Fully Define schemes; relation glyphs crowding at joints; reference names could say left/right.
- Features: a standalone helix curve; loft guide curves and end tangency; rib end arcs; twist with sharp corners;
  draft with a slanted start or thin wall; thin revolve of splines; picking extrude regions in the view; the pattern
  instance variable and "up to reference" spacing; skipping instances by clicking them; inch holes, modelled threads.
- Robustness: face selectors synthesised from picks can depend on position ("up to surface" loses a moved face);
  dangling detection covers edge references only.
- UI: more drag handles (revolve angle, fillet radius); box select with the trackpad scheme; Enter on a toolbar
  dropdown doesn't open it; mirror validation message should mention revolve; tree chips cut short; the sketch
  toolbar is full at 1500 px (put new sketch tools in a flyout).
- AI: no live-model run yet (scripted models only); the plan checks' failing case is unit-tested only.

How it was run, for a later phase built the same way:

Resuming an interrupted wave: commit the worktrees' partial work, then `python3 mkresume.py <n> <run id prefix, e.g. wf_816890cf-bba>`
and run wave<n>r.js. Union-merged files (icons.tsx, styles.css, index files) can come out mangled when both
branches append at the same spot: run tsc after every merge and repair by hand.

To run a wave: copy the .plan files back (cp docs/phase-o/*.md .plan/), assemble with
`python3 build.py <n> "<description>"` in the briefs folder (it joins shared.js + w<n>-tasks.js) and run the
resulting wave<n>.js with the Workflow tool. Usage limits interrupted several runs: commit the worktrees' partial
work and resume with a "continue in this worktree" variant (see the resume() prefix used for waves 1 and 2).
