# Phase O — where it stands (on hold)

The user's request: make Cocaide a SOLIDWORKS-class part modeller ("smarter and cleaner than SOLIDWORKS, all the little
things", reference edges you can dimension to, more tools for the AI). Built in waves of two parallel engineers (git
worktrees under .claude/worktrees), each followed by an adversarial reviewer, then merged, fully tested and pushed.

Done and pushed on ccr-851589c3-2dh2fn:
- Wave 0: feature/tool/editor registries, DatumRef reference system, CommandManager tabs, scale op.
- Wave 1: plane/axis/point features, datums in the view and tree, vertex picking, sketch on any plane or face;
  sketch tool registry, point entity, rectangles/polygon/arcs/slots/centerline/midpoint line, flyouts.
- Wave 2: sketch references to model edges (dimension/relate to them, follows the model, Convert Entities, X/Y axes,
  rebuild solves sketches, history-correct edges); Revolve (cut, thin, two directions), Shell, Draft, Scale tool;
  fix for the flaky table-frame mirror test.

Next (briefs in docs/phase-o/briefs/, contract in DESIGN.md, APIs in api.md, wave list in waves.md):
- Wave 3: sketch edit tools (trim/extend/split/fillet/chamfer/offset/mirror/patterns/move…, regions) ∥
  extrude end conditions/direction 2/draft/thin/intersect + fillet/chamfer variants. Note: the sketch toolbar is
  nearly full at 1500 px — edit tools must use flyouts.
- Wave 4: sweep/helix/loft/rib ∥ driven/named dimensions, expressions with functions and units, status, Fully Define.
- Wave 5: Hole Wizard + pattern/mirror upgrades ∥ rollback, measure, mass props, section view, display styles, Instant3D.
- Wave 6: AI tools ∥ ellipse and spline.
- Wave 7: whole-diff review, README/roadmap, regenerate docs screenshots, final verification.

To run a wave: copy the .plan files back (cp docs/phase-o/*.md .plan/), assemble with
`python3 build.py <n> "<description>"` in the briefs folder (it joins shared.js + w<n>-tasks.js) and run the
resulting wave<n>.js with the Workflow tool. Usage limits interrupted several runs: commit the worktrees' partial
work and resume with a "continue in this worktree" variant (see the resume() prefix used for waves 1 and 2).
Open follow-ups: intersection curve; reference names could say left/right; mirror validation message should mention
revolve; Enter on a toolbar dropdown doesn't open it; thin revolve doesn't cover splines.
