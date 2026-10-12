// What the agent is told about Cocaide: short server instructions, and the
// full document reference as a resource. Each registry op (src/features)
// documents itself: its def's `reference` text is part of REFERENCE.

import { DOC_DEFS } from "../features/docIndex";
import { examplesText, STRATEGY } from "./examples";

export const INSTRUCTIONS = `Cocaide is parametric CAD. The part is one JSON feature document (.cocaide.json); every tool reads or edits it.

How edits work:
- Each edit is a transaction: it is applied, the part is rebuilt, and it is kept only if no feature newly fails. Otherwise the result has ok:false and an error string, and the document is unchanged.
- Each kept edit makes a new revision. undo and redo step through them.
- writeScope (set by the host, shown by listFeatures) limits what you may change: a feature id lets you edit that feature, "<sketch>/*" that sketch's entities and constraints, "<sketch>/<entity>" one entity and its constraints, "+" lets you add features, "param:<name>" lets you set that parameter, "*" is everything. Features you add are yours to edit. A call outside the scope is rejected.

Start with partSummary (or listFeatures). The reference tool gives one section of the document reference at a time (reference() lists them; the resource cocaide://reference is all of it): read an op's section before you first use it. Faces and edges are chosen by selector queries (e.g. the largest planar face with normal +Z), never by index: take them from listFaces and listEdges, which give a selector for each one; facePlane gives a flat face's frame for sketches and holes.
Build with batch: a sketch (sketchProfile makes it fully defined), the feature made from it, its holes and patterns in one transaction, kept only if everything rebuilds; dryRun tries without keeping. For a whole part: plan first, build in batches, then verify with partSummary, measureBetween and screenshot.
Units are millimetres. Numeric fields may be expressions over document parameters and sketch dimensions: "=plate_t * 2", "=sketch_1.width / 2 + 1in".`;

export const REFERENCE = `# Cocaide document reference

A document:
{
  "version": 1, "units": "mm", "name": "bracket",
  "parameters": { "plate_t": 6, "lip": "=sketch_1.width / 4" },   // optional named numbers or "=expressions"
  "material": { "name": "steel", "densityKgPerM3": 7850 },   // optional
  "features": [ ...in build order... ]
}
Every feature has "id" (letters, digits, _; unique) and "op", and may have "suppressed": true.
Unknown fields are errors. Any numeric field may be "=expression".

### Expressions
"=<expression>" in any numeric field, a parameter's value, or a sketch dimension's value. They read:
  parameter names ("plate_t"), and sketch dimensions as <sketch id>.<dimension name> ("sketch_1.width", "sketch_1.d3").
  numbers, + - * / ( ), unary -, comparisons < <= > >= == != (1 or 0), && ||.
  functions: sqrt, abs, min, max, round, floor, ceil, pow, hypot, sin, cos, tan (degrees), asin, acos, atan, atan2
    (degrees), if(condition, then, else) (only the branch taken is worked out); constant pi.
  units on literals, converted to mm and degrees: mm cm m in ft, deg (or °) rad ("=1in + 3mm" is 28.4).
A name that goes round (a parameter reading a dimension that reads it) is refused, saying which names go round.

### Dimension names, driven dimensions
Every sketch dimension (a constraint with "value") has a name: its "name" field if set, else d<n>, n its place among
the sketch's dimensions (d1, d2 …, constraints without a value not counted). Expressions read it as "sketch_1.d2".
Once an expression reads a default name, the name is written into the dimension ("name": "d2") so deleting an earlier
dimension can't move it onto another. renameDimension renames one and every expression that read it; renaming a
sketch (its id) renames <old id>.<name> everywhere too.
"driven": true makes a dimension a reference (driven) one: never solved, never over-defining,
its value kept equal to what the geometry measures (so expressions can read it). Add a dimension that would
over-define the sketch as driven; setDriven turns one driving again only if the sketch stays solvable.

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
Constraints are the standard CAD sketch relations and dimensions. They are checked on rebuild (the stored geometry must satisfy them); addConstraint and setDimension re-solve the sketch so they hold. Point refs are "<entity>.<point>" (line start/end, arc start/end/center, circle and rect center, slot center1/center2, point at) or "origin".
Dimensions (mm; angles in degrees). Each may carry "name" and "driven": true (see Dimension names, driven dimensions).
  { "type": "distanceX" | "distanceY" | "distance", "entity": "r1", "value": 80 }   (or "points": ["l1.start","l1.end"])
  { "type": "distance", "point": "c1.center", "line": "l1", "value": 12 }   (square to the line, extended; "X"/"Y" are the sketch axes)
  { "type": "distance", "lines": ["l1", "l2"], "value": 12 }     (two parallel lines: l2's middle from l1, extended)
  { "type": "distance", "point": "l3.end", "line": "cl", "doubled": true, "value": 40 }   (a linear diameter: twice the
                                                                 distance to a centreline, shown Ø: a revolve profile's diameter)
  "condition": "min" | "max" on a distance, distanceX or distanceY whose point is a circle's or arc's "center": measured
    to its nearest (min) or farthest (max) side instead ("center", the default). In the sketcher: Shift-click the circle.
  { "type": "radius" | "diameter", "entity": "c1", "value": 5 }
  { "type": "arcLength", "entity": "a1", "value": 25 }          (along the arc)
  { "type": "angle", "entities": ["l1", "l2"], "value": 30 }     (between their directions, start to end; over 0, under 180;
                                                                 "supplement": true measures the other quadrant, 180 − that;
                                                                 "X" or "Y" as the second entity: the angle to a sketch axis)
Relations:
  { "type": "horizontal" | "vertical", "entity": "l1" }          (or "points": ["l1.end", "c1.center"]: level / above each other)
  { "type": "coincident", "points": ["l1.end", "l2.start"] }     ("origin" is the sketch origin)
  { "type": "pointOn", "point": "l2.end", "entity": "c1" }       (on a line extended, a circle or an arc)
  { "type": "midpoint", "point": "c1.center", "entity": "l1" }
  { "type": "parallel" | "perpendicular" | "collinear", "entities": ["l1", "l2"] }
  { "type": "tangent", "entities": ["l1", "a1"] }               (a line and a circle or arc, or two circles or arcs)
  { "type": "concentric", "entities": ["c1", "a1"] }
  { "type": "coradial", "entities": ["c1", "a1"] }               (concentric and the same radius, as one relation)
  { "type": "intersection", "point": "p1.at", "entities": ["l1", "l2"] }   (the point where two lines, extended, cross)
  { "type": "equal", "entities": ["c1", "c2"] }                  (two lines' lengths, or two radii)
  { "type": "symmetric", "points": ["l1.start", "l2.start"], "line": "l3" }
  { "type": "symmetric", "entities": ["l1", "l4"], "line": "l3" }   (two lines, two arcs or two circles that are each
                                                                 other's mirror images about l3 (or "X", "Y"): ends paired
                                                                 as they lie, centres and radii mirrored; Mirror makes these)
  { "type": "fix", "entity": "l1" }                              (or "point": "l1.end", or a point entity: held where it is)
  { "type": "offset", "entities": ["l1", "a1", "l2"], "offsets": ["l5", "a3", "l6"], "value": 3 }
      Offset Entities' one driving distance: each offsets[i] lies "value" mm from entities[i], on the side it is on now
      (a line parallel to its base; an arc or circle concentric, its radius "value" more or less). A base may be a point
      ref ("l1.end"): its offset is an arc centred there, of radius "value" (a round corner, an arc cap). Change the value
      (setDimension) and the whole offset moves; the offset pieces are joined to each other by coincident (and tangent,
      where an arc runs on smoothly) relations. Deleting an offset piece drops only its pair.
A relation that repeats or contradicts what the sketch already fixes is refused (a dimension: add it with "driven": true).
validate and the sketch status report an over-defined sketch with the smallest set of constraints that conflict.

### Sketch edits the app makes (do the same with addEntity / updateEntity / deleteEntity / addConstraint)
The sketcher's edit tools (Trim, Extend, Split, Fillet, Chamfer, Offset, Mirror, Linear and Circular pattern, Move,
Copy, Rotate, Scale, Explode, Check sketch) only ever write plain entities and the relations above:
  trim / split: a line or arc shortened (its end's relations dropped), a piece cut out of the middle leaves two, the
    second collinear with the first (an arc: coincident centres and equal); a trimmed circle becomes an arc; each new
    end coincident with the end it landed on, or pointOn the entity it landed on. A split line's length dimension
    becomes a "distance" between the outer ends of its two pieces.
  fillet: both lines (or arcs) shortened, an arc between them with coincident ends and tangent to both; one "radius"
    dimension, the other fillets made with it "equal" to the first. "Keep constrained corners" leaves a construction
    point at the old corner, pointOn both entities, carrying what was related or dimensioned to the corner.
  chamfer: a line across the corner, coincident with both shortened lines, two "distance" dimensions (or a distance and
    an "angle") from a construction point left at the old corner.
  linear pattern: copies "equal" to the seed (lines also parallel), on a chain of construction lines, collinear and
    "equal" to the first, whose "distance" is the spacing (and "horizontal"/"vertical" or an "angle" to "X").
  circular pattern: copies "equal" to the seed; construction spokes from the centre, "equal"; equal construction chords
    between neighbouring places; one "angle" dimension between the first two spokes (as the relation reads it, 0-180°;
    "collinear" spokes for two places half a turn apart).
  explode: a rect becomes 4 lines (corner rectangle relations); a slot 2 lines, 2 arcs and a construction centreline.
A profile must be clean to extrude: no open ends, no ends that nearly meet, no crossings or overlaps, no zero-length or
doubled entities (the sketcher's Check sketch lists these and fixes the simple ones).

### The sketch axes, and references to the model (dimension to model edges; they follow the model)
Every sketch has two axis lines, "X" and "Y" (through its origin along its x and y), usable wherever a line id is, as
"origin" is a point: { "type": "distance", "point": "c1.center", "line": "Y", "value": 20 }, { "type": "angle",
"entities": ["l1", "X"], "value": 30 }, parallel, perpendicular, collinear, tangent, pointOn, symmetric "line". Not as an
entity with a length or ends of its own (no "X.start", no length, equal or fix); no entity may be called X or Y.
A line, circle, arc or point entity may carry "ref": a reference to the model. Such an entity is reference geometry:
the model's edge, axis or point projected into the sketch plane as the part stands at the sketch's place in history,
projected again on every rebuild. Its numbers are the projection's (write any; the rebuild replaces them) and the
solver holds them, so every relation and dimension to it follows the model: dimension a circle 12 mm from a model edge,
change the plate's width, and the circle (and the hole cut from it) moves with the edge. A reference is construction
(never profile) unless it says "construction": false (Convert Entities: the model's outline copied in as profile).
  line:   "ref": { "edge": <edge selector> }  - a straight edge (or a circular one seen edge-on, as the line it looks like)
          "ref": { "datum": "Z" }  (or "X", "Y", an axis feature's id) - an axis, drawn long enough to cross the part
  circle: "ref": { "edge": <selector of a whole circular edge> }  - its plane must face the sketch
  arc:    "ref": { "edge": <selector of a part-circle edge> }
  point:  "ref": { "edge": <selector>, "at": "start" | "end" | "mid" | "center" }, { "datum": "Origin" }, a point feature
A tilted circle (an ellipse in the sketch) or a freeform edge can't be referenced; the rebuild says so. A reference that
no longer finds its edge fails the sketch, naming the entity: re-pick its selector, or delete it. A reference can't be
fixed or dragged. Edge selectors are the ones fillet uses; pick them with the measure tool first. The sketch's frame is
the face's: for a sketch on the top face of a part on Top, sketch x and y are world x and y.
Worked example: a hole 12 mm in from the right-hand edge of a plate's top face, on the plate's centre line, Ø6 through:
{ "id": "sk_hole", "op": "sketch", "plane": { "type": "ref", "ref": { "face": { "type": "planar", "normal": [0,0,1], "pick": "largest" } } },
  "entities": [
    { "id": "e1", "type": "line", "start": [40,-20], "end": [40,20], "ref": { "edge": { "type": "edge", "between": [
        { "type": "planar", "normal": [0,0,1], "pick": "largest" }, { "type": "planar", "normal": [1,0,0], "pick": "largest" } ], "pick": "all" } } },
    { "id": "c1", "type": "circle", "center": [28,0], "radius": 3 } ],
  "constraints": [
    { "type": "distance", "point": "c1.center", "line": "e1", "value": 12 },
    { "type": "distance", "point": "c1.center", "line": "X", "value": 0 },
    { "type": "diameter", "entity": "c1", "value": 6 } ] }
{ "id": "cut_1", "op": "cut", "sketch": "sk_hole", "extent": "throughAll", "direction": [0,0,-1] }
The sketch is fully defined: the reference counts no degrees of freedom. The context packet lists a sketch's reference
entities with what each references ("reference": ...).

## extrude / cut
{ "id": "ext_1", "op": "extrude", "sketch": "sketch_1", "distance": 6, "direction": [0,0,1] }
"cut" removes material with the same fields. direction defaults to the sketch normal (reverse: its negative).
In DESIGN's operation terms: extrude = "add" (or "new" with newBody), extrude with "intersect": true = "intersect",
cut = "remove" (from "bodies", default every body it reaches).
End condition, "extent" (what else each needs; anything it does not need is an error):
  "blind" (default, "distance") | "midplane" ("distance" in all, half each way) | "throughAll" | "throughAllBoth" |
  "upToNext" (a boss stops at the material it meets; a cut where the material ends) |
  "upToFace" ("upTo": { "face": <selector> } a flat or curved face, or { "datum": "Top" | "<plane feature>" }) |
  "upToVertex" ("upTo": a point: { "edge": <selector>, "at": "end" }, { "datum": "<point feature>" }, { "point": [x,y,z] };
               it ends on the plane through it parallel to the sketch) |
  "offsetFromFace" ("upTo" a flat face or plane, "offset" mm short of it toward the sketch; negative: past it).
  A flat face counts as its whole plane, so a slanted face gives a slanted end. A curved face must cover the profile.
{ "id": "boss", "op": "extrude", "sketch": "sk", "extent": "upToFace", "upTo": { "face": { "type": "planar", "normal": [0,0,-1], "pick": "largest", "body": "lid" } } }
{ "id": "pocket", "op": "cut", "sketch": "sk2", "extent": "offsetFromFace", "upTo": { "datum": "floor" }, "offset": 2 }
Second direction: "direction2": { "extent": "blind" | "throughAll" | "upToNext" | "upToFace" | "upToVertex" | "offsetFromFace",
  "distance"?, "upTo"?, "offset"?, "draft"? } goes the other way from the start with its own end (not with midplane or
  throughAllBoth): { ..., "distance": 5, "direction2": { "extent": "blind", "distance": 3 } } spans 3 below to 5 above.
Start: "startOffset": 4 (mm along the sketch normal; negative: behind) or "from": a plane, flat face or point
  ({ "datum": "<plane>" }, { "face": <selector> }, { "point": [0,0,12] }); not both.
Draft: "draft": { "angle": 5, "outward"?: true } tapers the sides (degrees, under 90; inward unless outward; midplane:
  both halves from the middle). Per direction: "direction2": { ..., "draft": { "angle": 3 } }. A 20x20 blind 10 with
  5° inward draft is a frustum: top side 20 - 2*10*tan5° = 18.25.
Thin: "thin": { "thickness": 2, "side"?: "outside" (default) | "inside" | "mid" } thickens the sketch's lines into a wall
  first. An open sketch (a chain of lines and arcs) may be used: an open L makes an L-shaped wall (outside = its convex
  side); a closed loop makes a tube (outside: the wall is outside the loop). No draft with thin.
Regions: "regions": [[x, y], ...] (points in sketch coordinates) uses only the closed regions those points lie in (the
  innermost loop around each, less the loops in it), so one sketch drives several features: a plate sketch with a
  circle in it extrudes the ring with [[x in the ring]] and the disc with [[the circle centre]]. Default: every region.
extrude "intersect": true keeps only where the extrusion and the body ("body", default main) overlap.
cut "flipSide": true removes what lies outside the profile instead (keeps what is inside it).
Measurements in the packet: extent, distance, offset, startOffset, draftAngle, thickness and direction2.

## hole (the Hole Wizard)
{ "id": "hole_1", "op": "hole", "face": <face selector>, "center": [30,0], "size": "M6", "kind": "counterbore", "depth": "through" }
Drilled into a planar face against its outward normal. center is in that face's plane frame: origin = the global origin projected onto the plane, axes by the sketch rule above (for a +Z face: x = global X, y = global Y).
Where (exactly one): "center": [x, y] (one hole); "centers": [[x, y], ...] (several holes, one feature, one callout);
  "points": "<sketch id>" (a hole at every point entity of that sketch, as the rebuild solves it: move the points and
  the holes follow). With "face" the points are dropped onto the face along its normal (the sketch must be parallel
  to it: sketch them on the face); without "face" the holes start on the sketch's own plane, drilled against its normal.
What: "size": "M3" | "M4" | "M5" | "M6" | "M8" | "M10" | "M12" | "M14" | "M16" | "M20" | "M24" (ISO metric screws) with
  "kind": "simple" | "counterbore" | "countersink" | "tapped" (default: what its fields say, else simple) and
  "fit": "close" | "normal" | "loose" (ISO 273 clearance, default normal; not for tapped). The size gives the numbers:
    clearance Ø (M6: close 6.4, normal 6.6, loose 7), counterbore for an ISO 4762 socket head cap screw (M6: Ø11 x 6.5
    deep), countersink for an ISO 10642 countersunk screw at 90° (M6: Ø13.7; none for M24), tap drill (M6: 5, M8: 6.8,
    M10: 8.5, M12: 10.2) and coarse pitch (M6: 1, M8: 1.25).
  Any number the hole gives itself wins over the table: "diameter", "counterbore": { "diameter"?, "depth"? },
  "countersink": { "diameter"?, "angle"? }, "thread": { "pitch"?, "depth"? } (tapped: a fine pitch, the thread depth).
  Without a size the hole gives "diameter" (and a whole counterbore or countersink) itself, as older documents do.
Tapped: { ..., "size": "M8", "kind": "tapped", "depth": 15 } bores the tap drill (Ø6.8) 15 deep; the thread is cosmetic,
  recorded for drawings: major diameter, pitch, class 6H, depth (default: the drill depth less 3 pitches, 11.25 here;
  through when the hole is). A drawing calls it out "M8×1.25 - 6H ⌴11.25" with "Ø6.8 ⌴15" under it.
depth: a number (blind, mm), "through" (through all) or "upToNext" (through the first wall it meets, stopping in
  the gap behind it). "bodies": ["base"] drills only those bodies.
Validated, a hole always holds the numbers it is cut with (diameter, counterbore, countersink, thread).
{ "id": "hole_2", "op": "hole", "face": <face selector>, "points": "sk_pts", "size": "M8", "kind": "tapped", "depth": 15 }

## fillet / chamfer
{ "id": "fillet_1", "op": "fillet", "edges": <edge selector or list of them>, "radius": 2 }
{ "id": "chamfer_1", "op": "chamfer", "edges": <edge selector or list>, "distance": 1 }
Which edges (any mix, at least one): "edges" (selectors), "faces": [<face selector>, ...] (every edge of those faces),
"features": ["boss_1"] (every edge of the faces that feature made: its sides, its top and where it meets the part).
Tangent edges are followed (OCCT default). A failure names the edge: "edge 3 (straight, +Z, length 6, at [10, 10, 3]): radius 4 is
too large for the 3 mm face beside it".
Variable fillet: "radius2": 4 with "radius": 2 varies the radius linearly from 2 at each edge's start to 4 at its end.
Radius sets: "sets": [{ "edges" | "faces" | "features", "radius", "radius2"? }, ...] give other edges radii of their own
in the same fillet; the feature's own edges and radius may then be left out:
{ "id": "fillet_2", "op": "fillet", "faces": [{ "type": "planar", "normal": [0,0,1], "pick": "largest" }], "radius": 1,
  "sets": [{ "edges": { "type": "edge", "direction": [0,0,1], "pick": "all" }, "radius": 3 }] }
Chamfer kinds: equal ("distance" on both faces), two distances ("distance" and "distance2"), or distance-angle
("distance" on one face, "angle" degrees from it, under 90; the other leg is distance*tan(angle)). The face that takes
"distance" is the one facing most up (+Z, then +Y, then +X); "flip": true swaps the faces (only with distance2 or angle):
{ "id": "chamfer_2", "op": "chamfer", "edges": <selector>, "distance": 2, "distance2": 1, "flip": true }
{ "id": "chamfer_3", "op": "chamfer", "edges": <selector>, "distance": 2, "angle": 30 }

## linearPattern / circularPattern (repeat earlier extrudes, cuts, holes, members, revolves ...)
{ "id": "pat_1", "op": "linearPattern", "feature": "hole_1", "direction": [-1,0,0], "spacing": 60, "count": 2,
  "direction2": [0,1,0], "spacing2": 20, "count2": 2 (optional grid) }
{ "id": "pat_2", "op": "circularPattern", "feature": "hole_1", "axis": { "origin": [0,0,0], "direction": [0,0,1] }, "count": 6, "angle": 360 }
count (and count2) include the original.
Seeds: "feature": "hole_1" (one) or "features": ["boss_1", "hole_1"] (several, each repeated the same way, in order).
Instance numbers: 1 is the original. Linear: along the first direction 1 ... count, then the next row: instance i
  along direction 1 and j along direction 2 (counting from 0) is number 1 + i + j * count. Circular: 1, 2, 3 ...
  turning about the axis. "skip": [3, 5] leaves those instances out (never 1; at least one copy must be left).
  A copy of a feature that starts a body is a new body <body>_<instance number> (a skipped one is not made).
Linear direction from the model instead of written out: "along": <reference> (a straight edge or an axis: its
  direction; a flat face or a plane: its normal), so it follows the model; "reverse": true turns it round. The second
  direction likewise: "along2", "reverse2" (instead of "direction2").
  { "id": "pat_3", "op": "linearPattern", "features": ["boss_1", "hole_1"], "along": { "edge": <edge selector> }, "spacing": 25, "count": 4, "skip": [3] }
Circular axis by reference: "axis": { "ref": <reference> } (a straight or round edge, an axis feature, "X"/"Y"/"Z", a
  cylindrical face's axis). "angle": the angle the pattern spans (default 360), instances equally spaced: a full turn
  spaces them angle/count apart, a part turn angle/(count - 1) so the last lands on the end ("angle": 180, "count": 3:
  0°, 90°, 180°). They turn right-handed about the axis direction; "reverse": true turns them the other way.
  { "id": "pat_4", "op": "circularPattern", "feature": "hole_1", "axis": { "ref": { "face": { "type": "cylindrical", "radius": 20 } } }, "count": 3, "angle": 180 }
Every copy is the seed as it is: there is no instance-number variable for expressions (no per-instance sizes).

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
  "features": ["boss_1", "hole_1"] mirrors several, each the same way (each that starts a body makes <body>_mirror;
  "newBody" only when exactly one does).
  The plane by reference follows the model: "plane": { "type": "ref", "ref": { "face": <planar face selector> } } (a
  flat face of the part, e.g. the side face to mirror about), { "datum": "Right" } or a plane feature's id.
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
Faces and edges are found again on every rebuild, so what stands on them follows the model. A part's packet lists
its reference geometry (part.referenceGeometry: the defaults, and each plane, axis and point feature with its frame
now); listFeatures gives each one's "now" too.
Sketch placement by reference (prefer it to a written-out plane: the sketch then follows what it stands on):
  { "id": "plane_1", "op": "plane", "mode": "offset", "refs": [{ "datum": "Top" }], "distance": 25 }
  { "id": "sketch_2", "op": "sketch", "plane": { "type": "ref", "ref": { "datum": "plane_1" } }, "entities": [...] }
  { "id": "sketch_3", "op": "sketch", "plane": { "type": "ref", "ref": { "face": { "type": "planar", "normal": [0,0,1], "pick": "largest" } } }, "entities": [...] }
sketch_2 sits 25 mm above Top; sketch_3 on the part's top face, wherever an earlier extrude puts it. A reference of the
wrong kind is an error that says so ("Top is a plane, but an axis is needed here"). Feature ids may not be Front,
Top, Right, Origin, X, Y or Z.

## Face selectors
{ "type": "planar", "normal": [0,0,1], "pick": "largest" | "smallest" | "all", "offset": 6 (optional), "rank": 1 (optional), "near": [x,y,z] (optional) }
{ "type": "cylindrical", "radius": 3.3 (optional), "axis": [0,0,1] (optional), "pick": ..., "near": [x,y,z] (optional) }
normal is the outward normal; offset is the plane's signed distance from the origin along it. rank (not with offset)
is the face's level along the normal among the planes the matching faces lie in: 1 the furthest out (the top face for
+Z), 2 the next in, -1 the furthest in; unlike offset it still finds the face when the face moves (a taller block), so
prefer it. near keeps the match whose centre is closest; it is fragile, prefer normal/rank/radius.
A feature needing one face fails if the selector picks 0 or several.

## Edge selectors
{ "type": "edge", "pick": "all" | "longest" | "shortest",
  "kind": "line" | "circle" (optional), "direction": [0,0,1] (lines parallel to it), "radius": 3, "length": 40,
  "onFace": <face selector>, "between": [<face selector>, <face selector>], "near": [x,y,z] }
Every given filter must hold.

${examplesText()}

${STRATEGY}

## Tools
Inspect (read only): partSummary - the part at a glance (features with status, bodies, volume, size, mass, holes).
listFaces(type?, normal?, madeBy?, body?, near?) / listEdges(kind?, direction?, radius?, onFace?, madeBy?, corner?, near?) -
  every face or edge with a selector that picks it alone, the feature that made it, a flat face's sketch frame, an edge's
  corner (convex / concave / smooth) and, for several edges, one allSelector for them all.
measureBetween(a, b) - distance, closest points, angle, axis distance between faces, edges, points, datums, sketch points.
getSketch(id) - entities, constraints (index, name, label, measured), status (DOF, free points, conflicts), profile, frame.
facePlane(face, offset?, points?) - a flat face's frame and the sketch plane spec that follows it. listDatums - planes, axes, points.
reference(section?) - one section of this reference. plan(features, checks?) - the build plan and its checks (whole parts).
Build: batch(commands, dryRun?) - several steps as ONE transaction (all or none, one undo step); dryRun reports without keeping.
sketchProfile(sketch, plane?, shapes, dimensions?, datum?) - a fully defined sketch from a compact description.
fullyDefine(sketch, datum?) - adds the missing relations and dimensions. holes(face, at, size?, kind?, ...) - holes on a bolt
  circle, a grid, the face's corners or points (a hole and its pattern).
listFeatures, getFeature(id) - read the document and each feature's rebuild status.
addFeature(feature, index?) - id is optional (one is made from the op). updateFeature(id, patch) - shallow merge; null removes a field.
deleteFeature(id), reorderFeature(id, index), suppressFeature(id, suppressed).
setParameter(name, value), deleteParameter(name), renameParameter(from, to) - a value is a number or "=expression".
setDimension(sketch, index | name, value) - index into the sketch's constraints, or the dimension's name ("d2", "width").
renameDimension(sketch, index | name, to), setDriven(sketch, index | name, driven) - name a dimension (expressions follow), make it driven or driving.
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
