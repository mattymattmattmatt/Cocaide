// What the agent is told about Cocaide: short server instructions, and the
// full document reference as a resource.

export const INSTRUCTIONS = `Cocaide is parametric CAD. The part is one JSON feature document (.cocaide.json); every tool reads or edits it.

How edits work:
- Each edit is a transaction: it is applied, the part is rebuilt, and it is kept only if no feature newly fails. Otherwise the result has ok:false and an error string, and the document is unchanged.
- Each kept edit makes a new revision. undo and redo step through them.
- writeScope (set by the host, shown by listFeatures) limits what you may change: a feature id lets you edit that feature, "+" lets you add features, "param:<name>" lets you set that parameter, "*" is everything. Features you add are yours to edit. A call outside the scope is rejected.

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
rebuild, validate (schema + rebuild + selector health), measure(selector?) - whole part, or what a selector picks.
exportSTEP(file?), exportSTL(file?) - written to the output folder. screenshot(view | direction, highlight?) - one PNG.
undo, redo.
`;
