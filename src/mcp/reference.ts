// What the agent is told about Cocaide: short server instructions, and the
// full document reference as a resource.

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
Entities (2D, in the sketch frame; "construction": true keeps one out of the profile):
  { "id": "r1", "type": "rect", "center": [0,0], "w": 80, "h": 40 }
  { "id": "c1", "type": "circle", "center": [0,0], "radius": 5 }
  { "id": "l1", "type": "line", "start": [0,0], "end": [10,0] }
  { "id": "a1", "type": "arc", "center": [0,0], "start": [5,0], "end": [0,5], "clockwise": false }
  { "id": "s1", "type": "slot", "center1": [0,0], "center2": [20,0], "width": 6 }
Closed loops become the profile; a loop inside another is a hole in it.
Constraints are checked on rebuild (the stored geometry must satisfy them). setDimension changes one and re-solves the sketch.
  { "type": "distanceX" | "distanceY" | "distance", "entity": "r1", "value": 80 }   (or "points": ["l1.start","l1.end"])
  { "type": "radius", "entity": "c1", "value": 5 }
  { "type": "horizontal" | "vertical", "entity": "l1" }
  { "type": "coincident", "points": ["l1.end", "l2.start"] }     ("origin" is the sketch origin)
  { "type": "equal", "entities": ["c1", "c2"] }

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
newDrawing(date?) - code plans the sheet: front, top, right and iso views, the overall size, every hole, a balloon per cut list item, the tables.
setSheet(patch), setView(id, view | null), setAnnotation(id, annotation | null) - edit the drawing; a view takes its annotations with it.
drawing - the composed sheet: each view's scale and place, what each annotation reads (or why it can't be drawn), and the drawing checks.
exportDrawing(format: "pdf" | "svg", file?) - the sheet, written to the output folder.
undo, redo.
`;
