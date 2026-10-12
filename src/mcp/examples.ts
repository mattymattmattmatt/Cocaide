// Worked examples for the agent: whole parts built with the tools as a model
// would call them (each example is a list of batch steps on an empty part),
// plus the modelling strategy. tests/agent-examples.test.ts builds every one
// and checks the volume, so the reference never teaches something that fails.

const PI = Math.PI;

export interface WorkedExample {
  key: string;
  title: string;
  /** What it shows, and why it is built this way. */
  notes: string;
  /** Parameters set first (setParameter steps). */
  parameters?: Record<string, number | string>;
  /** Batch steps, in order. */
  steps: Record<string, unknown>[];
  /** The volume it must come to, mm³ (worked out by hand), or a range when there is no closed form. */
  volume: number | [number, number];
  holes?: number;
}

const flange = { d: 100, t: 12, od: 50, bore: 36, length: 80, pcd: 76, bolts: 6, hole: 9 };
const spring = { radius: 10, pitch: 5, turns: 6, wire: 1.6 };

export const WORKED_EXAMPLES: WorkedExample[] = [
  {
    key: "flanged-fitting",
    title: "A flanged pipe fitting: revolve + a bolt circle of holes",
    notes: `Turned parts are revolved from a half section drawn on a plane through the axis: on Front, sketch x is world X and
sketch y is world Z, so the section sits at x >= 0 and turns about the Z axis. The bolt holes go on the flange's top
face (the second level facing +Z: rank 2, the pipe end being rank 1) as one M8 hole and a circular pattern of it about Z, so changing "bolts" re-spaces them.
Volume = pi x [(50² - 18²) x 12 + (25² - 18²) x 68] - 6 x pi x 4.5² x 12.`,
    parameters: { bolts: flange.bolts },
    steps: [
      {
        tool: "sketchProfile",
        sketch: "sk_section",
        plane: { type: "ref", ref: { datum: "Front" } },
        shapes: [
          {
            polyline: [
              [flange.bore / 2, 0],
              [flange.d / 2, 0],
              [flange.d / 2, flange.t],
              [flange.od / 2, flange.t],
              [flange.od / 2, flange.length],
              [flange.bore / 2, flange.length],
            ],
          },
        ],
      },
      { tool: "addFeature", feature: { id: "body", op: "revolve", sketch: "sk_section", axis: { datum: "Z" } } },
      {
        tool: "holes",
        id: "bolt_hole",
        face: { type: "planar", normal: [0, 0, 1], rank: 2, pick: "largest" },
        size: "M8",
        at: { circle: { center: [0, 0], diameter: flange.pcd, count: flange.bolts, startAngle: 30 } },
      },
      { tool: "updateFeature", id: "circularPattern_1", patch: { count: "=bolts" } },
    ],
    volume: PI * ((50 ** 2 - 18 ** 2) * 12 + (25 ** 2 - 18 ** 2) * 68) - 6 * PI * 4.5 ** 2 * 12,
    holes: 6,
  },
  {
    key: "spring",
    title: "A compression spring: a round wire swept along a helix",
    notes: `No sketch at all: a "circle" profile swept along an exact helix about Z (it starts at the origin and climbs +Z).
Two of pitch, turns and height fix the helix. Volume = pi/4 x d² x turns x sqrt((2 pi R)² + pitch²).`,
    steps: [
      {
        tool: "addFeature",
        feature: { id: "spring", op: "sweep", circle: { diameter: spring.wire }, path: { helix: { axis: { datum: "Z" }, radius: spring.radius, pitch: spring.pitch, turns: spring.turns } } },
      },
    ],
    volume: (PI / 4) * spring.wire ** 2 * spring.turns * Math.hypot(2 * PI * spring.radius, spring.pitch),
  },
  {
    key: "ribbed-bracket",
    title: "An angle bracket with a gusset rib and two counterbored holes",
    notes: `The L section is drawn on Front and extruded "midplane", so Front is the bracket's middle plane: the rib's sketch
goes on Front too, as one open line across the inside corner; the rib fills from that line out to the walls (a
triangle) and is 5 thick, centred on Front. The holes go on the base's top face (the largest facing +Z), whose frame
is world x and y.
Volume = (60 x 6 + 6 x 44) x 40 + the rib's triangle x 5 - the two counterbored holes.`,
    steps: [
      {
        tool: "sketchProfile",
        sketch: "sk_l",
        plane: { type: "ref", ref: { datum: "Front" } },
        shapes: [{ polyline: [[0, 0], [60, 0], [60, 6], [6, 6], [6, 50], [0, 50]] }],
      },
      { tool: "addFeature", feature: { id: "angle", op: "extrude", sketch: "sk_l", extent: "midplane", distance: 40 } },
      { tool: "sketchProfile", sketch: "sk_rib", plane: { type: "ref", ref: { datum: "Front" } }, shapes: [{ line: { from: [6, 40], to: [50, 6] } }] },
      { tool: "addFeature", feature: { id: "gusset", op: "rib", sketch: "sk_rib", thickness: 5 } },
      { tool: "holes", id: "mount", face: { type: "planar", normal: [0, 0, 1], pick: "largest" }, size: "M5", kind: "counterbore", at: { points: [[40, -12], [40, 12]] } },
    ],
    volume: [(60 * 6 + 6 * 44) * 40, (60 * 6 + 6 * 44) * 40 + 0.5 * 44 * 34 * 5],
    holes: 2,
  },
  {
    key: "drafted-tray",
    title: "A moulded tray: draft, shell and a stiffening rib",
    notes: `Mould order: the block, then draft its four sides (neutral plane Top, the faces narrow upward), then shell it 2 mm
leaving the top open, then a rib across the inside. The rib's line is drawn on a plane at the rim (a plane feature 30
above Top) with "normal": true, so it stands down from the rim to the floor and runs out to the walls.`,
    steps: [
      { tool: "sketchProfile", sketch: "sk_block", shapes: [{ rect: { center: [0, 0], width: 80, height: 60 } }] },
      { tool: "addFeature", feature: { id: "block", op: "extrude", sketch: "sk_block", distance: 30 } },
      {
        tool: "addFeature",
        feature: {
          id: "taper",
          op: "draft",
          faces: [
            { type: "planar", normal: [1, 0, 0], pick: "all" },
            { type: "planar", normal: [-1, 0, 0], pick: "all" },
            { type: "planar", normal: [0, 1, 0], pick: "all" },
            { type: "planar", normal: [0, -1, 0], pick: "all" },
          ],
          neutral: { datum: "Top" },
          angle: 3,
        },
      },
      { tool: "addFeature", feature: { id: "hollow", op: "shell", faces: [{ type: "planar", normal: [0, 0, 1], pick: "largest" }], thickness: 2 } },
      { tool: "addFeature", feature: { id: "rim", op: "plane", mode: "offset", refs: [{ datum: "Top" }], distance: 30 } },
      { tool: "sketchProfile", sketch: "sk_web", plane: { type: "ref", ref: { datum: "rim" } }, shapes: [{ line: { from: [-30, 0], to: [30, 0] } }] },
      { tool: "addFeature", feature: { id: "web", op: "rib", sketch: "sk_web", thickness: 2, normal: true } },
    ],
    volume: [5000, 30000],
  },
  {
    key: "edge-dimensioned",
    title: "A hole dimensioned to the model's edges (it follows them)",
    notes: `The sketch stands on the plate's top face and holds two reference lines (the right-hand and the back edge of
that face, projected); the circle is dimensioned 15 and 12 from them and named "hole_d". Make the plate longer
(setParameter plate_w 140) and the hole moves with the right-hand edge. "edge_gap" is a driven (reference) dimension:
it measures the circle's centre from the sketch's Y axis and never over-defines the sketch.`,
    parameters: { plate_w: 100 },
    steps: [
      { tool: "sketchProfile", sketch: "sk_plate", shapes: [{ rect: { center: [0, 0], width: "=plate_w", height: 60 } }] },
      { tool: "addFeature", feature: { id: "plate", op: "extrude", sketch: "sk_plate", distance: 8 } },
      {
        tool: "addFeature",
        feature: {
          id: "sk_hole",
          op: "sketch",
          plane: { type: "ref", ref: { face: { type: "planar", normal: [0, 0, 1], pick: "largest" } } },
          entities: [
            { id: "right", type: "line", start: [50, -30], end: [50, 30], ref: { edge: { type: "edge", between: [{ type: "planar", normal: [0, 0, 1], pick: "largest" }, { type: "planar", normal: [1, 0, 0], pick: "largest" }], pick: "all" } } },
            { id: "back", type: "line", start: [-50, 30], end: [50, 30], ref: { edge: { type: "edge", between: [{ type: "planar", normal: [0, 0, 1], pick: "largest" }, { type: "planar", normal: [0, 1, 0], pick: "largest" }], pick: "all" } } },
            { id: "c1", type: "circle", center: [35, 18], radius: 4 },
          ],
          constraints: [
            { type: "distance", point: "c1.center", line: "right", value: 15 },
            { type: "distance", point: "c1.center", line: "back", value: 12 },
            { type: "diameter", entity: "c1", value: 8, name: "hole_d" },
            { type: "distance", point: "c1.center", line: "Y", value: 35, driven: true, name: "edge_gap" },
          ],
        },
      },
      { tool: "addFeature", feature: { id: "hole_cut", op: "cut", sketch: "sk_hole", extent: "throughAll", direction: [0, 0, -1] } },
    ],
    volume: 100 * 60 * 8 - PI * 16 * 8,
    holes: 1,
  },
];

/** The examples as reference text: each one's notes and the batch call that builds it. */
export function examplesText(): string {
  const step = (s: Record<string, unknown>) => `    ${JSON.stringify(s)}`;
  return [
    "## examples",
    "Whole parts built with the tools, each from an empty part. Each is one batch call (parameters set first).",
    ...WORKED_EXAMPLES.map((e) =>
      [
        `### ${e.title}`,
        e.notes,
        ...(e.parameters ? Object.entries(e.parameters).map(([k, v]) => `setParameter ${JSON.stringify({ name: k, value: v })}`) : []),
        "batch { \"commands\": [",
        e.steps.map(step).join(",\n"),
        "] }",
      ].join("\n"),
    ),
    `### Expressions with functions, named and driven dimensions
{ "parameters": { "teeth": 12, "pitch_d": 60, "tooth_angle": "=360 / teeth", "wall": "=max(2, pitch_d * 0.05)",
  "slot_w": "=if(teeth > 10, 4, 6)", "lip": "=sketch_1.width / 4 + 1in" } }
A dimension gets a name with "name": "width" (expressions read it as "sketch_1.width"), or renameDimension. A
dimension that would over-define is added with "driven": true: it only measures (expressions may read it).`,
  ].join("\n\n");
}

export const STRATEGY = `## strategy
How to build a whole part well (the way a careful CAD user does):
1. Plan first: call plan with the feature tree (one line per feature, in build order) and the checks the request
   gives (overall size, a volume you can work out, the hole count). Put driving sizes in parameters.
2. Build in this order: base feature (extrude or revolve of a fully defined sketch), bosses and cuts, holes (the holes
   tool or hole features, not sketched circles), patterns and mirrors, ribs, drafts and shells, fillets and chamfers
   last. Prefer symmetry about the origin and the default planes.
3. Use batch: a sketch, the feature made from it and what goes with it in one call, so nothing is left half built. Use
   sketchProfile for sketches (it adds the relations and dimensions, fully defined); getSketch shows what holds one.
4. Never write a selector or a coordinate by guesswork: listFaces / listEdges give a selector for every face and edge
   (with the feature that made it, and which edges are convex), and facePlane gives a face's frame for sketches and holes.
5. Verify: partSummary (volume, size, bodies, any failing feature), measureBetween for the distances that matter, and a
   screenshot. Compare with the request and the plan's checks; fix what disagrees, then say what you built.

Sketch planes (sketch x and y in world terms; an extrude goes along the normal unless told otherwise):
  Top (normal +Z): x = +X, y = +Y          Front (normal -Y): x = +X, y = +Z         Right (normal +X): x = +Y, y = +Z
  a face facing -Z: x = +X, y = -Y         a face facing +Y: x = +X, y = -Z         a face facing -X: x = +Y, y = -Z
A sketch on a face: origin = the world origin projected onto the face (facePlane gives it).
Turned parts: draw the half section on Front (x >= 0) and revolve about { "datum": "Z" }.

When something fails (the error names the feature and says why):
  "selector matched 0 faces" / "several": take the selector from listFaces or listEdges instead.
  "repeats or contradicts": the sketch already fixes it; leave it out, or add it with "driven": true.
  "profile is open at [x, y]": the ends there don't meet; getSketch shows the gap (sketchProfile closes outlines).
  "removes no material" / "misses the body": the cut is on the wrong side or plane; check facePlane and the direction.
  "body ... does not exist": partSummary lists the bodies.
  a fillet "too large": a smaller radius, or fillet before the feature that narrowed the face.`;
