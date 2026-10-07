# Cocaide: after v1

Phases A–G (the original build spec) are done: see the README. This file
continues the spec in the same form. Each phase ends with an acceptance
check, and the next phase does not start until it passes.

The goal of the next three phases is fabrication: weldments, the way a
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
