# Cocaide: after v1

Phases A–G (the original build spec) are done: see the README. So are H–N below. This file
continues the spec in the same form. Each phase ends with an acceptance
check, and the next phase does not start until it passes.

The goal of Phases H–L is fabrication: weldments, the way a
structural detailer works, with the agent working alongside the human. A
weldment is many bodies in one part, so multibody parts come first.

## Phase H — multibody parts

**Done.** See the README's Phase H acceptance.

One part, many solids. SolidWorks has this, but its bodies are the weak
spot: they are named by the feature that happened to make them
("Boss-Extrude3[2]"), they merge silently, and nothing tells you when two
bodies overlap. Cocaide's rules:

- **Bodies are named in the document.** A feature that adds material says
  where it goes: `"newBody": "upright"` starts a body, `"body": "upright"`
  adds to one, and neither means the default body, `main`. A name that
  doesn't exist is an error, never a new body. Renaming a body is one
  command, and every reference to it follows.
- **A feature that removes material says from which bodies.** A cut or a hole
  takes `"bodies": ["base"]`. With no list it cuts every body it reaches, as
  a cut does today. Every body in the list must lose material, or the
  feature fails.
- **Selectors can name a body.** `{ "type": "planar", "normal": [0,0,1], "pick": "largest", "body": "base" }`.
  A failed selector says which body it looked in.
- **`combine`** adds, subtracts or intersects bodies into one target:
  `{ "op": "combine", "operation": "add", "target": "base", "tools": ["upright"] }`.
  The tool bodies are consumed.
- **Patterns follow their seed.** A pattern of a cut cuts the same bodies. A
  pattern of an extrude into a body adds to that body. A pattern of a new
  body makes new bodies, named `leg`, `leg_2`, `leg_3`, and so on.
- **Every rebuild measures every body.** The measurements give each body's
  name, volume, mass and size, plus every pair of bodies that overlap, with
  the overlap volume. The agent and the critic read this; the human sees it.
  Interference is not a tool you have to remember to run.
- **STEP keeps the names.** Each body is exported as its own named solid
  (XCAF), so FreeCAD and the next CAD tool show `base` and `upright`, not
  `Solid1` and `Solid2`. A one-body part exports exactly as before.
- **Scoped to a body.** Right-click a body to ask about it. The write scope
  is the features that make that body, plus new features that touch only it.
  The API enforces this: an edit to another body is rejected.
- **Old documents don't change.** A document that never names a body is one
  body, `main`, and rebuilds, measures and exports exactly as before.

Acceptance: a part of two bodies, a base plate and an upright plate standing
on it, rebuilds as two named solids. Its measurements give each body's
volume and mass and report no interference. Pushed 2 mm into the base, the
upright's overlap is reported in mm³. A hole scoped to the base leaves the
upright whole. STEP exports two solids named `base` and `upright`, and
FreeCAD opens it with both names. Combine merges them into one body whose
volume is the sum. In the browser, each body has its own colour and can be
hidden. A right-click on one asks about that body only, and the API rejects
an edit to the other.

## Phase I — weldment profiles and the section library

**Done.** See the README's Phase I acceptance.

Sections are not typed in from tables: they are drawn, in the same sketcher as
everything else, and the library grows as parts are made. In SolidWorks a
profile is a separate file in a folder tree, set up in options, edited by
opening another document. In Cocaide it is one tick box away from any sketch.

- **Any sketch can be a weldment profile.** The sketcher has a "Weldment
  profile" tick box. Ticked, finishing the sketch opens the profile card:
  - **Name** of the family ("SHS").
  - **Sizes.** The parameters the sketch's dimensions use (`=b`, `=b - 2 * t`)
    are its size parameters. The current values are the first size, and more
    rows can be added with a designation each ("SHS 50×50×3"). One sketch is a
    whole family.
  - **Anchor.** What sits on the member line: the centroid, or the sketch origin.
  - **Tags.** Suggested from the geometry (hollow, open or solid; square,
    rectangular, round; the envelope), plus free tags, a material note, and a
    favourite star.
  - **Computed per size:** area, kg/m (at the part's density), and the
    envelope, shown with a drawing of the section.
  The profile must be closed loops, or the card says why.
- **The section library** is a panel in the app, not a folder: search by name,
  designation or tag, favourites first, then the most used. Each entry shows
  its drawing, sizes, area and kg/m. Profiles are kept in this browser, and
  can be exported and imported as a file.
- **Copies, not links.** A part keeps a copy of every profile it uses, with
  the library id and version, so it opens anywhere and never changes under
  you. "Update from library" is a command you choose, and it can be undone.
- **Straight members.** `{ "op": "member", "profile": "SHS", "size": "SHS
  40×40×3", "from": [...], "to": [...], "rotation": 0 }` sweeps the profile
  along a line. A horizontal member's profile is upright. Each member is its
  own body, named by its id. Its length, designation and mass are measured.

Acceptance: draw a 40 × 40 × 3 square hollow section as a normal sketch, with
its sizes as parameters `b` and `t`. Tick "Weldment profile" and finish. The
card finds `b` and `t`, shows 444 mm² and 3.49 kg/m, and suggests "hollow" and
"square". Add the size 50 × 50 × 3 and save, and the profile is in the section
library. In another part, add a 900 mm member of SHS 40×40×3 and a 600 mm member
of SHS 50×50×3. Each is its own body with the right volume, and the members are
listed with their lengths. Clear the library: the part still opens and
rebuilds from its own copy.

## Phase J — frames, joints and the cut list

**Done.** See the README's Phase J acceptance.

A frame is points and members, not a 3D sketch. A detailer thinks in nodes
(the corners of the frame), the members between them, and what happens where
members meet. The cut list is what the workshop needs: it is read from the
trimmed bodies, so it can never disagree with the model.

- **Nodes.** `"nodes": { "A": [0, 0, "=frame_h"], "B": ["=frame_w", 0, "=frame_h"] }`
  at the top of the document. Coordinates can be expressions. A member's
  `from` and `to` can name a node (`"from": "A"`), and moving the node moves
  every member that names it. Renaming a node is one command; members, joints
  and gussets follow it.
- **Where the line runs through the section.** A member's `align: [ax, ay]` puts the line
  on the section's envelope: `[0, 0]` is the middle, `[-1, 1]` the top left edge as
  seen from the member's end. Without it, the profile's anchor is on the line. A
  frame whose nodes are its outside corners keeps its outside size when the
  section changes.
- **Joints are features**, at a node: `{ "op": "joint", "node": "A", "type": "mitre", "members": ["front", "side"], "gap": 0 }`
  or `{ "op": "joint", "node": "A", "type": "butt", "through": "leg_a" }`.
  - A mitre cuts both members on the plane that halves the angle between them.
  - A butt runs one member through, extended to cover the others if it ends there. The others stop at its face.
  - Every other member that ends at the node butts against the joint's members. So a leg under a mitred corner stops under the rails.
  - The gap is left between the cut faces.
  - The joint checks its own work: if its members still overlap, it fails and says by how much.
- **End caps and gussets** are bodies of their own.
  - `endCap` closes a member's square end with a plate of its outline.
  - `gusset` is a triangular plate in the inside corner between two members at a node, with a chamfer for the weld.
- **Cut list.** Each member's length (end to end, long point to long point)
  and end angles (0° square, 45° mitre) are measured on its body. Alike members
  are one line: profile, size, length, angles, quantity, kg each and in total.
  Exported as CSV.
- **Welds are notes.** `"welds": [{ "id": "w1", "between": ["leg_a", "front"], "type": "fillet", "size": 3, "length": 160 }]`
  is a weld table: stored and listed, never modelled, like the material note. A
  weld added at a joint starts with the length of the butting member's end.

Acceptance: a 1200 × 600 table frame, 900 high, in SHS 40×40×3 from the
library, with mitred top corners, builds with no interference between members.
The cut list's lengths and angles match the measured bodies. Switching every
member to SHS 50×50×3 rebuilds the frame and updates the cut list.

## Phase K — the agent on weldments

**Done.** See the README's Phase K acceptance.

The agent works on weldments the way it works on plates. It reads the request into intent. Code checks every number and every section against what the user typed and what the library holds. The user confirms on the card, and a deterministic planner builds the part.

- **Frames from a sentence.** "A 1200 × 600 table frame, 900 high, SHS 40×40×3" is read as a frame: the type (a table: a rectangle on four legs; or a flat rectangle), the outside length, width and height, the section as the user wrote it, and how the corners are joined.
  - The section is never the model's choice. Code finds the words in the request, then matches them against the section library. One match fills the card. None, or more than one, leaves a blank with the library's sizes to choose from. An empty library stops the request and says how to fill it.
  - A frame always goes through the confirmation card, because it commits stock and cuts. Building it from the card is the user's confirmation.
  - The planner builds the frame the way a person would in Phase J: parameters for the size, nodes at the outside corners, members along paths with the nodes on the outside, and the corners mitred or butted. The part gets its own copy of the library profile.
- **The critic checks fabrication**, on any part with members, and on every planned frame:
  - every member is connected to the rest;
  - no two bodies clash after trimming;
  - no member is longer than stock bar (6 m unless the part's `stock_length` parameter says otherwise);
  - identical members are grouped: alike members are cut alike, and a planned frame's cut list is the one the plan expects.
  - A failed check gets the one correction pass, then it is the human's.
- **Right-click a joint** to mitre it, butt it, or leave a gap. **Right-click a member** to swap its size or turn it. The packet holds what the agent needs and nothing more: the sizes the part's copy has, the member's measured cut, and the members at the joint's node.
- **In the profile card, the agent suggests** a name, a designation for each size, tags and the anchor, from the section's measured properties. It suggests and never decides: every field stays editable, and nothing about the geometry changes.

Acceptance: the table frame prompt builds after the card, from the library's
profile. A section the library doesn't have is asked for, not guessed. The
critic's checks pass on the built frame, and fail on a frame with a loose
member or a clash. Right-clicking a butt joint and asking for a mitre gives a
proposal that, accepted, cuts 45° ends. In the profile card, Suggest fills the
name, designations and tags.

Open: whether the library stays in one browser (with export and import) or is
shared across a team. A shared library needs storage and accounts, which v1
avoids.

## Phase L — fabrication drawings

**Done.** See the README's Phase L acceptance.

The spec's "later" list says it: drawing generation projects the solid, not
the other way around. A drawing is views of the rebuilt part, and every
number on it is measured from that part. Nothing on a sheet is typed except
notes and the title block, so a drawing can't disagree with the model it was
made from. In SolidWorks a drawing is a second file that goes stale and whose
dimensions dangle when a feature changes. In Cocaide it is part of the
document, it rebuilds with the part, and a change it can no longer show is
listed as a problem, not drawn wrong.

DWG/DXF round-trip stays a non-goal: a drawing goes out as PDF or SVG, one way.

- **The drawing is in the document**, under `"drawing"`: a sheet, views and
  annotations. A part has at most one drawing, of one sheet.
  - **Sheet:** size (A4, A3, A2, A1, A0, landscape), scale (`"1:10"`, or none
    for the largest standard scale that fits), projection (third-angle or
    first-angle, with its symbol), and the title block's fields: title, drawing
    number, revision, drawn by, date. The part's name, material, mass and
    scale fill the rest of the title block.
  - **Views:** `{ "id": "front", "look": "front" }`. A view looks from the
    front, back, top, bottom, left, right or iso. A view without `at` is
    placed automatically: top and right line up with the front, as the
    projection puts them, and the iso goes where there is room. Dragging a view
    fixes its `at`. A view can have its own scale (an iso is often smaller). Hidden
    edges are dashed when the view's `hidden` is on.
  - **Annotations** sit in a view, and what they say is measured on the rebuild:
    - A **dimension** between two points: a node (`"A"`), a member's end
      (`"leg_a.start"`), a hole's centre (`"hole_1"`), or a side of the
      view's outline (`"@left"`, `"@right"`, `"@top"`, `"@bottom"`). It is
      horizontal, vertical or aligned, with an offset from the part.
      `{ "member": "leg_a" }` dimensions a member's cut length along it, long
      point to long point: the cut list's number.
    - A **hole callout** (`"Ø8 THRU"`, `"4× Ø8 THRU"` when patterned) on a
      view that sees the hole as a circle.
    - A **balloon** on a member. Its number is the member's cut list item,
      worked out on every rebuild, never typed.
    - A **weld symbol** from the weld table: an arrow to where its bodies meet,
      with the fillet or butt symbol, size and length, and the all-round circle.
    - A **table**: the cut list or the weld table.
    - A **note**: free text on the sheet.
- **A drawing follows the model; it never blocks it.** Renaming a node or a
  member renames it on the sheet. Deleting a member that a balloon points at
  is allowed, and the balloon is listed as a problem until it is moved or
  deleted.
- **New drawing** is one command, and code plans it, not the model:
  - the sheet size and scale that fit;
  - front, top and right views, plus an iso;
  - the overall length, width and height dimensioned;
  - every hole called out;
  - a balloon for every cut list item, the cut list and weld tables, and the title block.
- **The drawing checks** run on every change, in the app and in the critic:
  - every view shows the part;
  - every annotation is attached to something that exists;
  - every cut list item has a balloon;
  - the overall size is dimensioned in all three directions;
  - every weld has a symbol;
  - nothing overlaps (views, tables and the title block) or runs off the sheet.
- **The agent on drawings.** Right-click a view or an annotation on the sheet
  to ask about it. The write scope is that view and its annotations, or that
  one annotation; the API rejects any edit to the part's features from a
  drawing ask. The packet has the view's direction and scale, the nodes,
  members and holes it shows with their positions on the sheet, the
  annotations already there with their values, and the drawing checks. A
  proposal is judged by the same checks, and it gets one correction pass when a check fails.
- **Export** writes a vector PDF (with real text) or an SVG of the sheet
  as shown. The PDF needs no fonts or libraries: Helvetica is built into
  every PDF reader.

Acceptance: New drawing on the table frame gives one A3 sheet, third-angle,
with front, top and right views and an iso. It is dimensioned 1200, 600 and
900, its balloons 1–3 sit on members of cut list items 1–3, and the cut list
and title block (name, material, mass, scale) are on it. The drawing checks
pass. Deleting a balloon fails "every cut list item has a balloon", and moving
a view onto the title block fails the overlap check. Switching every member to
SHS 50×50×3 updates the sheet: a leg's length dimension reads 850 instead of
860, and the balloons still match the cut list. Right-clicking the front
view and asking for the leg height gives a proposal that, accepted, adds a
dimension reading 860. An edit to a feature from that ask is rejected. The
PDF opens in a PDF reader (poppler), and its text has the title, the
dimensions and the cut list rows. The SVG is the sheet the app shows.

## Phase M — multibody tools

**Done.** See the README's Phase M acceptance.

Phase H made bodies. This phase gives them the tools a multibody modeller is
expected to have, on Phase H's rules: every body is named in the document,
nothing merges or disappears silently, and every result is measured. Each tool
is a feature, so it rebuilds, undoes, and is open to agents like any other.

- **Mirror.** `{ "op": "mirror", "plane": { "type": "datum", "normal": [1, 0, 0], "origin": ["=frame_w / 2", 0, 0] }, "feature": "hole_1" }`
  mirrors one earlier feature the way a pattern repeats it.
  - A mirrored cut or hole cuts the same bodies, and a mirrored extrude adds to the same body.
  - A mirrored member, or an extrude that starts a body, makes a new body, `<body>_mirror` (or `newBody`).
  - `"bodies": ["leg_a", "leg_d"]` instead mirrors whole bodies as they are at that point, each into a new body `<name>_mirror`.
  - With `"merge": true`, each mirror image is fused into its own body, so a symmetric part can be modelled as one half. A mirror image that doesn't touch its body can't be merged, and the error says so.
- **Split.** `{ "op": "split", "body": "base", "plane": { ... }, "newBody": "base_left" }`
  cuts a body in two with a plane. The piece on the side the normal points to becomes `newBody` (default `<body>_split`); the other keeps the name. It is an error, saying which, when the plane misses the body or leaves more than one piece on a side.
- **Move/Copy.** `{ "op": "move", "bodies": ["upright"], "rotate": { "axis": { "origin": [0, 0, 0], "direction": [0, 0, 1] }, "angle": 90 }, "translate": [0, 50, 0], "copy": true }`
  turns bodies (first) and moves them. With `copy` the originals stay, and the copies are new bodies, `<name>_copy` (or `newBody` for one).
- **Delete/Keep.** `{ "op": "deleteBody", "bodies": ["scrap"] }` or `{ "op": "deleteBody", "keep": ["base"] }`.
  A later feature that names a deleted body is an error at validation, as after a combine. Deleting every body is refused.
- **Members stay members.** A member that is mirrored, patterned, moved or copied, and each piece of a split one, goes into the cut list as a member, measured along its own line, under its body's name. A member combined into another body is no longer a member.
- **Material per body.** `"bodyMaterials": { "upright": { "name": "aluminium 6061", "densityKgPerM3": 2700 } }` overrides the part's material for that body.
  - Each body's mass uses its own material, and the part's mass is their sum.
  - The cut list's kg and the drawing's title block follow.
  - A body that is renamed keeps its material, and one that is deleted takes its material with it.
- **Save a body as a part.** One body becomes a document of its own. It is a copy of the part, ending in a `deleteBody` that keeps that body, named after it, with that body's material.
  - It is a copy, not a link. Linking files would need a shared store, which v1 avoids.
  - In the Bodies panel there is one per body, and over MCP it is `saveBody`.

Acceptance:
1. **Mirror a feature.** On the stand, mirror `hole_1` about the XZ plane: the base has three holes, and loses one hole's volume (π × 5² × 8 mm³).
2. **Move and mirror a body.** Move the upright 30 mm along Y, then mirror it about the XZ plane: three bodies, the volume up by 57,600 mm³, and no interference.
3. **Split.** Split the base at x = 0. The two halves are equal, and add up to the base.
4. **Keep.** Keeping `base` alone leaves one body.
5. **Material per body.** In aluminium (2700 kg/m³), the upright's mass is 0.15552 kg, and the part's mass is the sum of its bodies.
6. **Save a body as a part.** The upright saved as a part rebuilds alone to 57,600 mm³, in aluminium, and exports a STEP of one solid named `upright`.
7. **Mirror half a frame.** Take the table frame without `leg_b` and `leg_c`, and mirror `leg_a` and `leg_d` about x = 600. It rebuilds to the same 3,054,720 mm³, and its cut list is again 2 × 1200, 4 × 860, 2 × 600.
8. **Patterns.** A pattern of a member is in the cut list too.
9. **In the app.** Each tool is in the toolbar, with its properties in the panel. The Bodies panel sets a body's material, deletes it, and saves it as a part.

## Phase N — sketch relations, right-click menus, a freer assistant

**Done.** From using the app: the sketcher needs SOLIDWORKS's relations, every
right-click needs a menu, and the assistant needs room to work.

- **Relations.** Besides coincident, horizontal, vertical and equal:
  `parallel`, `perpendicular`, `collinear` (two lines); `tangent` (a line and a
  circle or arc, or two circles or arcs, outside or inside, as they are);
  `concentric`; `midpoint` and `pointOn` (a point on a line extended, a circle
  or an arc); `symmetric` (two points about a line); `fix` (an entity or a
  point held where it is); `horizontal`/`vertical` of two points.
- **Dimensions.** Besides distances and radius: `diameter`, `angle` (between
  two lines' directions, in degrees, over 0 and under 180), and a point's
  distance from a line (`{ "point", "line", "value" }`).
- Each is one or two equations in the solver, a check on rebuild with the
  measured value in its error, a shape that validation explains, and a line in
  the agent's reference.
- **The sketcher** infers relations while drawing (an end, centre, midpoint or
  curve under the pointer; a line near level or plumb), offers the relations
  and dimensions that fit the selection, shows each relation as a glyph and
  each dimension as a dimension, and has Smart Dimension (D) with its Modify
  box. Geometry is blue while it can move and black when fully defined; which
  numbers can still move is read from the null space of the solver's Jacobian.
- **Right-click menus** on every target: the actions SOLIDWORKS puts there,
  and **Ask AI…** last, which opens the ask panel.
- **Reach.** An ask may change the whole part by default: the right-clicked
  thing is the focus, the packet carries the part's outline, every feature is
  readable, every tool is offered and the one-feature rule is off. **Just
  this** restores Phase D's scopes. Either way the result is a proposal.

Acceptance:
1. Every relation and dimension solves and passes the rebuild check (`tests/relations.test.ts`).
2. A plate sketched in the browser with inferred relations, Smart Dimensions, equal holes and its corner on the origin reads Fully defined, all black (`e2e/sketch-relations.spec.ts`).
3. Every right-click opens a menu whose actions work and whose last entry opens the ask (`e2e/context-menu.spec.ts`).
4. From a sketch entity, "pattern the part" is refused with Just this and proposed with the whole part (`tests/ask.test.ts`, `e2e/ask.spec.ts`, `e2e/context-menu.spec.ts`).
