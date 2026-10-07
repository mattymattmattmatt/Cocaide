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

- **A frame is points and members, not a 3D sketch.**
  - Nodes: `{ "A": [0, 0, 0], "B": ["=frame_w", 0, 0] }`, where coordinates can be expressions.
  - Members join two nodes, with a profile, a size and a rotation.
  - Every member is a body named by its id.
- **Joints.** At each node: which member runs through, butt or mitre, and the
  gap. End caps and gussets come later in the phase.
- **Cut list.** Profile, length, end angles, quantity and kg per item, read
  from the trimmed bodies, not computed separately. Exported as CSV.
- **Welds are notes.** Size, type and length go in a weld table. They are
  stored, not modelled, like the material note.

Acceptance: a 1200 × 600 table frame, 900 high, in SHS 40×40×3 from the
library, with mitred top corners, builds with no interference between members.
The cut list's lengths and angles match the measured bodies. Switching every
member to SHS 50×50×3 rebuilds the frame and updates the cut list.

## Phase K — the agent on weldments

- "A 1200 × 600 table frame, 900 high, SHS 40×40×3" goes through the
  confirmation card. The profile and size come from the library, and are
  asked for, never guessed.
- Right-click a joint to mitre it, or a member to swap its size.
- In the profile card, the agent suggests a name, tags and the anchor.
- The critic checks fabrication: every member connected, no clashes after
  trimming, no member longer than stock bar, and identical members grouped.

Acceptance: the table frame prompt builds after the card, from the library's
profile.

Open: whether the library stays in one browser (with export and import) or is
shared across a team. A shared library needs storage and accounts, which v1
avoids.
