# Cocaide: after v1

Phases A–G (the original build spec) are done: see the README. This file
continues the spec in the same form. Each phase ends with an acceptance
check, and the next phase does not start until it passes.

The goal of the next three phases is fabrication: weldments, the way a
structural detailer works, with the agent working alongside the human. A
weldment is many bodies in one part, so multibody parts come first.

## Phase H — multibody parts

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

## Phase I — weldments

Structural members swept along a frame of nodes, one body per member.

- **A frame is points and members, not a 3D sketch.**
  - Nodes: `{ "A": [0, 0, 0], "B": ["=frame_w", 0, 0] }`, where coordinates can be expressions.
  - Members join two nodes, with a profile and a rotation.
  - Every member is a body named by its id, so it has a stable name to ask about.
- **Profiles are parametric sketches.**
  - Standard sections come from published tables, never typed from memory.
  - A part keeps a copy of every profile it uses, so it opens anywhere.
- **Joints.** At each node: which member runs through, butt or mitre, and the
  gap. End caps and gussets come later in the phase.
- **Cut list.** Profile, length, end angles, quantity and kg per item, read
  from the trimmed bodies, not computed separately. Exported as CSV.
- **Welds are notes.** Size, type and length go in a weld table. They are
  stored, not modelled, like the material note.

Acceptance: a 1200 × 600 table frame, 900 high, in 40 × 40 × 3 SHS with
mitred top corners, builds with no interference between members. The cut
list's lengths and angles match the measured bodies. Switching every member
to 50 × 50 × 3 rebuilds the frame and updates the cut list.

Open: which section standards first (UK/EN: SHS, RHS, CHS, angles, PFC,
UB/UC?), and the published source for their dimensions.

## Phase J — profile library and the agent on frames

- **Custom profiles.** Draw one in the sketcher, mark its size parameters and
  the point that sits on the frame line, and save it.
- **The library.**
  - Tags, favourites and search.
  - Properties are computed and used as tags: hollow or open, the envelope, area, kg/m.
  - The agent suggests a name and tags, and says when a custom sketch is really a standard section.
  - Most-used profiles come first.
- **Copies, not links.** A part keeps a copy of each profile with its library
  id and version. "Update from library" is a command you choose, shows what
  changes, and can be undone.
- **The agent on frames.**
  - "A 1200 × 600 table frame, 900 high, 40×40×3 SHS" goes through the confirmation card, and the profile size is asked for, never guessed.
  - Right-click a joint to mitre it, or a member to swap its profile.
  - The critic checks fabrication: every member connected, no clashes after trimming, no member longer than stock bar, and identical members grouped.

Acceptance: a custom profile saved from one part is found by tag search in
another part and used there. The second part still opens and rebuilds after
the library is cleared. The table frame prompt builds after the card.

Open: whether the library lives in one browser (with export and import) or
is shared across a team. A shared library needs storage and accounts, which
v1 avoids.
