# Phase Q — Drawings overhaul

The user's words: "Can we overhaul the drawing aspect of this, the automaticness is good but i also
need to be able to add a lot more details, similar to [professional CAD], and it would be nice to
add more items to the cutlist but yeah just an overhaul and polish, the ai integration needs to be
able to fully detail it for me too with all tolerances and whatnot. Just have a think and make it
good, impress me."

Goal: production-grade 2D manufacturing drawings of parts and weldments, made three ways that all
end up in the same document data: (1) automatically (the existing auto layout, kept and made
smarter), (2) by hand with a full detailing toolset on the sheet, (3) by the AI, which can fully
detail a drawing — views, dimensions, tolerances, GD&T, notes, weld symbols, tables — and check it.
Never name commercial CAD products in the repo (DESIGN §3).

Today (Phase L, ~2.4k lines): one sheet; views front/back/top/bottom/left/right/iso; dimensions only
between nodes, member ends, holes and outline sides; hole callouts, balloons, weld symbols, tables
(cut list / welds), notes; title block; SVG/PDF export; drawing checks; an AI packet. Code:
src/doc/drawing.ts + types (Drawing…), src/drafting/** (views, compose, svg, pdf, checks, plan,
sheet, text), src/ui/drawing/** (SheetView, DrawingPanels), src/weldment/cutlist.ts,
src/ui/CutListPanel.tsx, src/ask/drawingPacket.ts, e2e/drawing.spec.ts.

## Q.1 Contract (exact names — every wave keeps to these)

Old documents must load and render as before (migrate on load: one sheet, Phase L fields mapped).

```ts
interface Drawing {
  sheets: DrawingSheet[];            // ≥1; old { sheet, views, annotations } migrates to sheets[0]
  standard?: "ISO" | "ASME";         // drafting standard (default ISO): arrowheads, text, symbols, GD&T glyphs, projection default
  units?: "mm" | "in";               // display units for the drawing (model is mm)
  generalTolerance?: string;         // e.g. "ISO 2768-mK", or an ASME title-block tolerance spec "X.X ±0.5, X.XX ±0.1, ANG ±0.5°"
  properties?: Record<string,string>;// custom drawing properties for title block links and notes ($PRP:"name")
  revisions?: Revision[];            // revision history → revision table
}
interface DrawingSheet { id; name?; format: SheetFormat /* size + template + title-block fields */; scale?; projection;
  views: DrawingView[]; annotations: Annotation[]; tables?: DrawingTable[] }
```

View kinds (`DrawingView.kind`, default "model" = today's look views): "model" (a look or a named
orientation, iso included), "projected" (from a parent view: parent + direction), "section"
(parent, a cutting line on the parent: 2+ points for offset/aligned sections, label "A", half
section flag, hatch from body material, optional section depth, "show behind"), "detail"
(parent, circle centre+radius or closed profile, scale, label "B", style), "auxiliary"
(parent + a reference edge to look normal to), "brokenOut" (closed profile on the view + depth),
plus per-view: breaks (shortened views: axis, gaps), crop profile, display ("visible" |
"hidden" | "removed" | "shaded" | "shadedEdges"), tangent edges (visible/hidden/removed),
cosmetic threads, label + scale shown, bodies shown (multibody/weldment: show only some bodies).

**Geometry references** — the one thing annotations attach to (`GeoRef`, a string, stable across
rebuilds where provenance allows): `"<view>:e<edgeKey>"` an edge seen in a view,
`"<view>:v<vertexKey>"` a vertex, `"<view>:c<edgeKey>"` the centre of a circular/arc edge,
`"<view>:m<edgeKey>"` an edge's midpoint, `"<view>:q<edgeKey>.<0-3>"` a circle quadrant, plus the
Phase L point forms (nodes, member ends, holes, @sides) which keep working. edgeKey comes from the
model edge provenance (createdBy feature + hint, wave P3A selectors) so that a dimension survives
an unrelated rebuild; when it can't be re-found the annotation is "dangling" (drawn in the warning
colour at its last place, listed by the checks, never deleted silently). Wave Q1A defines the
resolver `resolveGeoRef(drawingModel, ref) → { kind: "edge"|"point"|"circle", ... sheet geometry } | null`
in src/drafting/georef.ts; every later wave uses it.

Annotation kinds (wave Q2A owns their shapes; names fixed here): "dimension" (linear horizontal /
vertical / aligned, angular, radius, diameter, ordinate set, baseline set, chain set, arc length,
chamfer, path length) with `tolerance?: Tolerance`; "hole" (callout with cbore/csk/tapped/depth
symbols, from the hole feature); "gdt" (feature control frame: one or more rows of characteristic
+ tolerance zone (Ø, value, material modifiers M/L, projected P, free state F, tangent plane T,
statistical, unequally disposed U) + up to 3 datum refs with modifiers; composite frames; attached
to a feature (leader) or a dimension); "datum" (datum feature symbol A, B…); "datumTarget";
"surface" (surface texture symbol: process, Ra/Rz, lay, machining allowance); "weld" (full weld
symbol: arrow/other side, both sides, types incl. fillet/butt variants/plug/spot/seam/edge,
size, length-pitch, contour, finish, all-around, field weld, tail with process/ref, staggered);
"note" (rich text, leader(s), linked properties `$PRP:"x"`, `$PRPMODEL:"mass"`, numbered
general notes block); "balloon" (item number from the BOM/cut list, stacked, styles); "centerMark"
and "centerline"; "cosmeticThread" callout; "revisionCloud"; "leader"/"text"/"line"/"sketch"
(free 2D drawing on the sheet). Tolerance = { kind: "symmetric"|"bilateral"|"limit"|"fit"|
"fitWithTol"|"basic"|"reference"|"min"|"max", plus?, minus?, fit?: "H7/g6" | "H7" | "g6",
precision? } — fit values from an ISO 286 table (src/drafting/fits.ts, holes and shafts, all
common grades) — and general tolerances from ISO 2768 (f/m/c/v linear+angular, H/K/L geometric).

Tables (`DrawingTable.kind`): "cutList" (weldment; wave Q1B), "bom", "holes" (hole table with
origin + tags), "welds", "revisions", "general" (free table), "bendless"… Each table: columns
(chosen from a catalogue + custom property columns), sort, grouping, anchor, style; balloons link
to its item numbers.

## Q.2 Waves (two engineers in parallel per wave, then a review)

- **Q1A drawing core**: data model v2 + migration + validation; view kinds (section with
  hatching per material, detail, projected, auxiliary, broken-out, breaks, crop, display modes,
  tangent edges, cosmetic threads, centre marks/lines auto); per-edge identity in projected views
  and the GeoRef resolver; multi-sheet; sheet formats & templates (ISO A0–A4, ANSI A–E, title block
  with property links, revision block, zones/grid refs, first/third-angle symbol); export: vector
  PDF multi-page, SVG, DXF (layers), PNG; performance (cache projections per view, worker).
- **Q1B cut list, BOM, tables**: cut list v2 (item no., qty, description, profile/designation,
  material, length, angle1/angle2 + orientation (same plane/twisted), mass each/total, finish,
  stock length & nesting/optimisation with kerf → stock buy list and offcuts, weld prep, custom
  properties per member/group, notes); cut-list properties editable in the app (panel) and stored
  in the document; plate/gusset/end-cap items (flat bar sizes, thickness, area); BOM for multibody
  parts; hole table; weld table with sizes, lengths, process; revision table; the table engine
  (columns, sort, group, split, style) used by the sheet; CSV/XLSX export of the cut list.
- **Q2A annotations & tolerancing**: every annotation kind above (data, validation, layout,
  render for sheet/SVG/PDF/DXF), ISO 286 fits, ISO 2768, standards ISO/ASME glyphs, the
  auto-dimension engine v2 (from model features: hole positions from datums, outline, member
  lengths, chain/baseline/ordinate schemes, no overlaps, no dimensioning to hidden lines, no
  duplicates across views, readable placement) and auto centre marks/lines.
- **Q2B sheet editor UI**: a full drawing workspace: drawing toolbar (view layout / annotation /
  sketch / tables tabs), sheet tree (sheets, views, tables, annotations), creating each view kind
  by picking on the sheet (section: draw the cutting line; detail: draw the circle), drag views
  with alignment (projected views stay aligned), view property panel, hover/pick of view
  geometry (edges, vertices, circle centres → GeoRefs) with the same feel as the 3D view, a
  plug-in point for annotation tools (registry) so Q3A drops in, right-click menus + Ask AI,
  undo, zoom/pan on the sheet, sheet tabs, print preview.
- **Q3A annotation tools UI**: Smart Dimension on the sheet (all kinds, inferred from picks,
  dragging to place, tolerance/precision/fit editor in a property panel), hole callout, GD&T
  frame builder, datum symbol, surface finish, weld symbol builder, notes with leaders and
  property links, balloons & auto-balloon, centre marks/lines, model items import (bring the
  model's sketch dimensions into a view), align/arrange tools, format painter.
- **Q3B AI full detailing**: the drawing packet v2 (views, every GeoRef with what it is, model
  features and their design intent, existing annotations, checks), tools to add/edit every
  annotation/view/table kind, a "Fully detail this drawing" flow: plan (views needed, datum
  scheme from the part's function, which features get fits — e.g. bearing bores H7, dowel holes
  H7/m6, threads from the hole wizard — GD&T where it matters, general tolerance block, surface
  finish, welds from the weldment, notes: deburr, finish, material), execute, then a critic pass
  (completeness: every feature located and sized once; no double dimensioning; tolerance stack on
  critical chains; readable; standards conformance) rendering the sheet to an image and looking at
  it; MCP tools for the same; e2e with a scripted model.
- **Q4 review**: whole-diff review, polish, screenshots of real drawings (bracket, flange, frame),
  docs, final verification.
