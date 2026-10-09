// What the agent is told about Cocaide: short server instructions, and the
// full document reference as a resource. Each registry op (src/features)
// documents itself: its def's `reference` text is part of REFERENCE.

import { DOC_DEFS } from "../features/docIndex";

export const INSTRUCTIONS = `Cocaide is parametric CAD. The part is one JSON feature document (.cocaide.json); every tool reads or edits it.

How edits work:
- Each edit is a transaction: it is applied, the part is rebuilt, and it is kept only if no feature newly fails. Otherwise the result has ok:false and an error string, and the document is unchanged.
- Each kept edit makes a new revision. undo and redo step through them.
- writeScope (set by the host, shown by listFeatures) limits what you may change: a feature id lets you edit that feature, "<sketch>/*" that sketch's entities and constraints, "<sketch>/<entity>" one entity and its constraints, "+" lets you add features, "param:<name>" lets you set that parameter, "*" is everything. Features you add are yours to edit. A call outside the scope is rejected.

Start with listFeatures. Read the resource cocaide://reference for every op, field and selector. Faces and edges are chosen by selector queries (e.g. the largest planar face with normal +Z), never by index; use measure with a selector, or screenshot with highlight, to check what a selector picks before you use it.
Units are millimetres. Numeric fields may be expressions over document parameters: "=plate_t * 2".`;

export const REFERENCE = `# Cocaide document reference

A document:
{
  "version": 1, "units": "mm", "name": "bracket",
  "parameters": { "plate_t": 6 },              // optional named numbers
  "material": { "name": "steel", "densityKgPerM3": 7850 },   // optional
  "features": [ ...in build order... ]
}
Every feature has "id" (letters, digits, _; unique) and "op", and may have "suppressed": true.
Unknown fields are errors. Any numeric field may be "=expression" using + - * / ( ) and parameter names.

A part estimated from a photo also has "photo": the image it was read from, its "scale" (two points on the photo
and the real length between them, "confirmed" only when the user has checked it in the app) and "estimated" (the
parameters measured on the photo; null marks a guess the photo doesn't show). Those sizes are estimates, never
exact. exportSTEP and exportSTL refuse until the user confirms the scale and sets every guess; an agent cannot.

## sketch
{ "id": "sketch_1", "op": "sketch",
  "plane": { "type": "datum", "normal": [0,0,1], "origin": [0,0,0], "xDir": [1,0,0] (optional) },
  "entities": [ ... ], "constraints": [ ... ] (optional) }
Sketch x axis: xDir if given, else global X projected onto the plane (global Y when the normal is along X); y = normal x xDir.
Or place it by reference, so it follows the model: "plane": { "type": "ref", "ref": <reference>, "offset": 5 (optional,
mm along the plane's normal), "flip": true (optional: turned over), "xDir": [1,0,0] (optional) }.
  On a face: { "type": "ref", "ref": { "face": { "type": "planar", "normal": [0,0,1], "pick": "largest" } } } - the
  plane of the face as it is when the sketch rebuilds (change an earlier extrude and the sketch moves with the face);
  its origin is the global origin projected onto the face, its x by the rule above, its normal the face's outward one.
  On a default plane: { "type": "ref", "ref": { "datum": "Top" } } (or "Front", "Right"), or a plane feature's id.
A sketch whose curves make no closed profile (an open chain, a path) still builds; a feature that needs a closed
profile (extrude, cut) then fails with the reason ("profile is open at [0, 0] (start of "l1")").
Entities (2D, in the sketch frame; "construction": true keeps one out of the profile):
  { "id": "r1", "type": "rect", "center": [0,0], "w": 80, "h": 40 }
  { "id": "c1", "type": "circle", "center": [0,0], "radius": 5 }
  { "id": "l1", "type": "line", "start": [0,0], "end": [10,0] }
  { "id": "a1", "type": "arc", "center": [0,0], "start": [5,0], "end": [0,5], "clockwise": false }
  { "id": "s1", "type": "slot", "center1": [0,0], "center2": [20,0], "width": 6 }
  { "id": "p1", "type": "point", "at": [10,5] }     (a sketch point: a hole centre, a pattern place, an anchor; never profile)
Closed loops become the profile; a loop inside another is a hole in it.
rect and slot are single entities kept for older documents: they can't be trimmed or partly dimensioned. Build new
outlines from lines and arcs with relations, as the app's tools do:
  corner rectangle: 4 lines, each corner "coincident" (l1.end with l2.start ...), l1 and l3 "horizontal", l2 and l4 "vertical";
  centre rectangle: that, plus 2 construction diagonals with their ends coincident with the corners and a point
    { "type": "midpoint", "point": "p1.at", "entity": "<diagonal>" } at the centre (put it on the origin with coincident);
  polygon: N equal lines (coincident ends, "equal" to the first) with their corners "pointOn" a construction circle;
  slot: 2 lines and 2 arcs joined by coincident ends, each line "tangent" to both arcs, the arcs "equal", their centres
    coincident with the ends of a construction centreline.
Constraints are SOLIDWORKS's sketch relations and dimensions. They are checked on rebuild (the stored geometry must satisfy them); addConstraint and setDimension re-solve the sketch so they hold. Point refs are "<entity>.<point>" (line start/end, arc start/end/center, circle and rect center, slot center1/center2, point at) or "origin".
Dimensions (mm; angles in degrees):
  { "type": "distanceX" | "distanceY" | "distance", "entity": "r1", "value": 80 }   (or "points": ["l1.start","l1.end"])
  { "type": "distance", "point": "c1.center", "line": "l1", "value": 12 }   (square to the line, extended)
  { "type": "radius" | "diameter", "entity": "c1", "value": 5 }
  { "type": "angle", "entities": ["l1", "l2"], "value": 30 }     (between their directions, start to end; over 0, under 180)
Relations:
  { "type": "horizontal" | "vertical", "entity": "l1" }          (or "points": ["l1.end", "c1.center"]: level / above each other)
  { "type": "coincident", "points": ["l1.end", "l2.start"] }     ("origin" is the sketch origin)
  { "type": "pointOn", "point": "l2.end", "entity": "c1" }       (on a line extended, a circle or an arc)
  { "type": "midpoint", "point": "c1.center", "entity": "l1" }
  { "type": "parallel" | "perpendicular" | "collinear", "entities": ["l1", "l2"] }
  { "type": "tangent", "entities": ["l1", "a1"] }               (a line and a circle or arc, or two circles or arcs)
  { "type": "concentric", "entities": ["c1", "a1"] }
  { "type": "equal", "entities": ["c1", "c2"] }                  (two lines' lengths, or two radii)
  { "type": "symmetric", "points": ["l1.start", "l2.start"], "line": "l3" }
  { "type": "fix", "entity": "l1" }                              (or "point": "l1.end", or a point entity: held where it is)
A relation that repeats or contradicts what the sketch already fixes is refused.

## extrude / cut
{ "id": "ext_1", "op": "extrude", "sketch": "sketch_1", "distance": 6, "direction": [0,0,1] }
"cut" removes material with the same fields. "extent": "blind" (default) | "midplane" | "throughAll" (no distance).
direction defaults to the sketch normal.

## hole
{ "id": "hole_1", "op": "hole", "face": <face selector>, "center": [30,0], "diameter": 6.6, "depth": "through" }
Drilled into a planar face against its outward normal. center is in that face's plane frame: origin = the global origin projected onto the plane, axes by the sketch rule above (for a +Z face: x = global X, y = global Y).
depth: a number or "through". Optional "counterbore": { "diameter", "depth" } or "countersink": { "diameter", "angle" }.

## fillet / chamfer
{ "id": "fillet_1", "op": "fillet", "edges": <edge selector or list of them>, "radius": 2 }
{ "id": "chamfer_1", "op": "chamfer", "edges": <edge selector or list>, "distance": 1 }

## linearPattern / circularPattern (repeat one earlier extrude, cut or hole)
{ "id": "pat_1", "op": "linearPattern", "feature": "hole_1", "direction": [-1,0,0], "spacing": 60, "count": 2,
  "direction2": [0,1,0], "spacing2": 20, "count2": 2 (optional grid) }
{ "id": "pat_2", "op": "circularPattern", "feature": "hole_1", "axis": { "origin": [0,0,0], "direction": [0,0,1] }, "count": 6, "angle": 360 }
count includes the original.

## bodies (one part, many named solids)
An extrude adds to the body "main" unless it says otherwise: "newBody": "upright" starts a body, "body": "upright" adds to one.
A name that doesn't exist is an error. A cut or hole takes "bodies": ["base"] to cut only those (each must lose material);
without it, it cuts every body it reaches. Face and edge selectors take "body": "base" to look in one body only.
A pattern of a feature that starts a body makes new bodies: upright_2, upright_3, ...
{ "id": "combine_1", "op": "combine", "operation": "add" | "subtract" | "common", "target": "base", "tools": ["upright"] }
joins the tool bodies into the target (they are used up).
Measurements list each body (name, volume, size) and every pair that overlaps ("interference", in mm³).
STEP exports each body as a solid of its name.

## member (a straight weldment member)
{ "id": "rail", "op": "member", "profile": "SHS", "size": "SHS 40x40x3", "from": [0,0,0], "to": [1000,0,0], "rotation": 0 (optional, degrees about the line) }
sweeps one size of a profile in the part's "profiles" along the line. Each member is its own body, named by its id
(or "newBody"). A horizontal member is upright: the profile's y is up (+Z); a vertical one has its y along +Y.
The profile's anchor ("centroid" or the sketch "origin") sits on the line. Measurements list each member's
designation, length and mass. A part's "profiles" are copies of section-library entries:
"profiles": { "SHS": { "name": "SHS", "entities": [...], "constraints": [...], "parameters": { "b": 40, "t": 3 },
  "sizes": [{ "designation": "SHS 40x40x3", "values": { "b": 40, "t": 3 } }], "anchor": "centroid", "tags": ["hollow"],
  "library": { "id": "...", "version": 1 } } }
Use the part's profiles and sizes as they are; never invent one.

## frames: nodes, joints, end caps, gussets, welds
"nodes": { "A": [0, 0, "=frame_h"], "B": ["=frame_w", 0, "=frame_h"] } at the top of the document: named points,
coordinates numbers or "=expressions". A member's "from"/"to" can name a node ("from": "A"); it moves with it.
"align": [ax, ay] on a member puts its line on the section's envelope ([-1..1, -1..1], seen from the "to" end,
x across, y up): a frame whose nodes are its outside corners has its members aligned to the outside.
{ "id": "corner_A", "op": "joint", "node": "A", "type": "mitre", "members": ["DA", "AB"], "gap": 0 }
{ "id": "foot_A", "op": "joint", "node": "E", "type": "butt", "through": "EA" }
  mitre: cuts the two members on the plane halving their angle. butt: "through" runs through (extended, square,
  to cover the others if it ends there). Every other member that ends at the node stops at the joint's members'
  faces. One joint a node; it comes after its members. It fails if its members still overlap.
{ "id": "cap_1", "op": "endCap", "member": "EA", "end": "start" | "end", "thickness": 3 }  a plate on a square end
{ "id": "gusset_1", "op": "gusset", "node": "A", "members": ["EA", "AB"], "size": 100, "thickness": 6, "chamfer": 10 }
  a triangular plate in the inside corner, centred on the members. End caps and gussets are bodies of their own.
"welds": [{ "id": "w1", "between": ["EA", "AB"], "type": "fillet" | "butt" | "plug", "size": 3, "length": 160,
  "allRound": true, "note": "" }]: the weld table, notes only (setWeld). Measurements list each member's length
(long point to long point) and end angles (0 square, 45 mitre), read from its trimmed body, and the cut list
groups alike members.

## multibody tools
{ "id": "mirror_1", "op": "mirror", "plane": { "type": "datum", "normal": [1,0,0], "origin": ["=frame_w / 2",0,0] }, "feature": "hole_1" }
  mirrors one earlier extrude, cut, hole or member like a pattern does: a cut cuts the same bodies, an extrude adds
  to the same body, one that starts a body (or a member) makes a new body "<body>_mirror" (or "newBody").
{ "id": "mirror_2", "op": "mirror", "plane": {...}, "bodies": ["leg_a", "leg_d"], "merge": false }
  mirrors whole bodies as they are here, each into a new body "<name>_mirror"; "merge": true fuses each mirror
  image into its own body (it must touch it).
{ "id": "split_1", "op": "split", "body": "base", "plane": {...}, "newBody": "base_left" }
  cuts a body in two: the piece the normal points to is newBody (default "<body>_split"); one piece each side.
{ "id": "move_1", "op": "move", "bodies": ["upright"], "rotate": { "axis": { "origin": [0,0,0], "direction": [0,0,1] }, "angle": 90 },
  "translate": [0, 50, 0], "copy": true, "newBody": "upright_2" }  turns, then moves; with copy the copies are new
  bodies "<name>_copy" (or newBody for one).
{ "id": "keep_1", "op": "deleteBody", "bodies": ["scrap"] } or { ..., "keep": ["base"] }  deletes bodies, or all but these.
A member mirrored, patterned, moved, copied or split stays a member: the cut list measures it along its own line,
under its body's name.
"bodyMaterials": { "upright": { "name": "aluminium 6061", "densityKgPerM3": 2700 } } at the top of the document
gives a body its own material (setBodyMaterial); its mass and the part's follow.

## drawing (one sheet of views, measured on the rebuild)
"drawing": { "sheet": { "size": "A3", "projection": "third", "scale": "1:10" (optional: else what fits), "title": "",
  "number": "", "revision": "", "drawnBy": "", "date": "" },
  "views": [{ "id": "front", "look": "front" | "back" | "top" | "bottom" | "left" | "right" | "iso",
    "at": [x, y] (optional: sheet mm from the lower left, else placed with the others), "scale": "1:20" (optional), "hidden": true (optional) }],
  "annotations": [
    { "id": "d1", "type": "dimension", "view": "front", "from": "@left", "to": "@right", "direction": "horizontal" | "vertical" | "aligned" (optional), "offset": 10 (optional, sheet mm; the sign picks the side) },
    { "id": "d2", "type": "dimension", "view": "front", "member": "leg_a" }   its cut length, where it lies flat in the view
    { "id": "h1", "type": "hole", "view": "top", "hole": "hole_1" }          "4× Ø6.6 THRU", where the hole shows as a circle
    { "id": "b1", "type": "balloon", "view": "iso", "member": "rail_front" } its cut list item number
    { "id": "w1s", "type": "weld", "view": "front", "weld": "w1" }           the weld table's weld, as a symbol
    { "id": "cut_list", "type": "table", "table": "cutList" | "welds" }
    { "id": "n1", "type": "note", "text": "Deburr all edges", "at": [30, 30] } ] }
A dimension point is a node ("A"), a member end ("leg_a.start" / ".end"), a hole feature ("hole_1"), or a side of the
view ("@left", "@right" for horizontal dimensions; "@bottom", "@top" for vertical). Dimensions are never in an iso
view. What every annotation reads is measured; none takes a value. The drawing never blocks the part: an annotation
whose member, node, hole or weld is gone is a drawing problem (see the drawing tool's checks), not an error.

${DOC_DEFS.map((d) => d.reference.trim()).join("\n\n")}

## References (reference geometry: planes, axes, points)
Wherever a plane, an axis or a point is needed by reference (a sketch's or a mirror's or split's "plane": { "type":
"ref", "ref": ... }, and newer features' fields), a reference is one of:
  { "datum": "Top" | "Front" | "Right" }   default planes through the origin (Z up): Top = XY (normal +Z), Front = XZ
                                           (normal -Y), Right = YZ (normal +X)
  { "datum": "Origin" }                    the origin, a point;  { "datum": "X" | "Y" | "Z" }  the axes through it
  { "datum": "<id>" }                      an earlier plane, axis or point feature
  { "face": <face selector> }              a planar face is a plane (outward normal); a cylindrical face is its axis
  { "edge": <edge selector>, "at": "start" | "end" | "mid" | "center" (optional) }
                                           a straight edge is an axis (start to end), a circular edge its axis (or its
                                           centre where a point is needed); with "at", that point of it
  { "point": [x, y, z] }                   a fixed point
Faces and edges are found again on every rebuild, so what stands on them follows the model. A reference of the
wrong kind is an error that says so ("Top is a plane, but an axis is needed here"). Feature ids may not be Front,
Top, Right, Origin, X, Y or Z.

## Face selectors
{ "type": "planar", "normal": [0,0,1], "pick": "largest" | "smallest" | "all", "offset": 6 (optional), "near": [x,y,z] (optional) }
{ "type": "cylindrical", "radius": 3.3 (optional), "axis": [0,0,1] (optional), "pick": ..., "near": [x,y,z] (optional) }
normal is the outward normal; offset is the plane's signed distance from the origin along it. near keeps the match whose centre is closest; it is fragile, prefer normal/offset/radius.
A feature needing one face fails if the selector picks 0 or several.

## Edge selectors
{ "type": "edge", "pick": "all" | "longest" | "shortest",
  "kind": "line" | "circle" (optional), "direction": [0,0,1] (lines parallel to it), "radius": 3, "length": 40,
  "onFace": <face selector>, "between": [<face selector>, <face selector>], "near": [x,y,z] }
Every given filter must hold.

## Tools
listFeatures, getFeature(id) - read the document and each feature's rebuild status.
addFeature(feature, index?) - id is optional (one is made from the op). updateFeature(id, patch) - shallow merge; null removes a field.
deleteFeature(id), reorderFeature(id, index), suppressFeature(id, suppressed).
setParameter(name, value), deleteParameter(name), setDimension(sketch, index, value) - index into the sketch's constraints.
renameBody(from, to) - every feature and selector that names the body follows.
addEntity(sketch, entity), updateEntity(sketch, id, patch), deleteEntity(sketch, id), addConstraint(sketch, constraint), deleteConstraint(sketch, index) - edit inside a sketch; it re-solves after each.
rebuild, validate (schema + rebuild + selector health), measure(selector?) - whole part, or what a selector picks.
exportSTEP(file?), exportSTL(file?) - written to the output folder (refused for a photo part until the user confirms its scale). screenshot(view | direction, highlight?) - one PNG.
setBodyMaterial(body, material | null) - a body's own material. saveBody(body, file?) - one body as a part of its own, written to the output folder.
newDrawing(date?) - code plans the sheet: front, top, right and iso views, the overall size, every hole, a balloon per cut list item, the tables.
setSheet(patch), setView(id, view | null), setAnnotation(id, annotation | null) - edit the drawing; a view takes its annotations with it.
drawing - the composed sheet: each view's scale and place, what each annotation reads (or why it can't be drawn), and the drawing checks.
exportDrawing(format: "pdf" | "svg", file?) - the sheet, written to the output folder.
undo, redo.
`;
