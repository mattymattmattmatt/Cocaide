// The section view's pure maths: each plane's frame with its tilt (turned
// about its own in-plane axes, about the point the offset puts it at), which
// side is cut away (and flipped), the corner cut of two and three planes
// (what is removed is on the cut side of every plane on), bodies left whole,
// the rectangle drawn round the part, the drag arrow's scale on a tilted
// plane, adding, removing and following planes, and reading a remembered
// section (the old single plane too).

import { describe, expect, it } from "vitest";
import type { Vec3 } from "../src/doc/types";
import type { Datum } from "../src/features/datum";
import {
  activePlanes,
  addPlane,
  cutAwayBy,
  cutsBody,
  extentAlong,
  followDatums,
  isCutAway,
  offsetArrow,
  parseSectionView,
  planeAxes,
  removePlane,
  sectionFrame,
  sectionOn,
  sectionRect,
  sectionViewOf,
  setPlane,
  tiltLabels,
  type SectionState,
  type SectionView,
} from "../src/ui/evaluate/section";

const close = (a: Vec3, b: Vec3, digits = 9) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], digits));
const box = { min: [-50, -30, 0] as Vec3, max: [50, 30, 8] as Vec3 };
const top = sectionOn("Top", {}, box) as SectionState; // through Z 4, cuts away above
const front = sectionOn("Front", {}, box) as SectionState; // through Y 0, cuts away the front (−Y)
const right = sectionOn("Right", {}, box) as SectionState; // through X 0, cuts away +X

describe("a plane's frame", () => {
  it("takes the in-plane axes by the sketch rule: Top X and Y, Front X and Z, Right Y and Z", () => {
    expect(planeAxes([0, 0, 1])).toEqual({ u: [1, 0, 0], v: [0, 1, 0] });
    const f = planeAxes([0, -1, 0]);
    close(f.u, [1, 0, 0]);
    close(f.v, [0, 0, 1]);
    const r = planeAxes([1, 0, 0]);
    close(r.u, [0, 1, 0]);
    close(r.v, [0, 0, 1]);
    expect(tiltLabels(front)).toEqual(["Tilt about X", "Tilt about Z"]);
  });

  it("untilted: the point the offset puts it at, the normal into the side cut away", () => {
    const f = sectionFrame(top);
    close(f.point, [0, 0, 4]);
    close(f.normal, [0, 0, 1]);
    expect(f.constant).toBeCloseTo(4, 12);
    expect(f.cosTilt).toBeCloseTo(1, 12);
    expect(isCutAway(top, [0, 0, 6])).toBe(true);
    expect(isCutAway(top, [0, 0, 2])).toBe(false);
    expect(isCutAway({ ...top, flip: true }, [0, 0, 2])).toBe(true);
    close(sectionFrame({ ...top, flip: true }).normal, [0, 0, -1]);
  });

  it("tilted 30° about X (the Top plane's first axis): the normal leans toward −Y by sin 30°, about the offset point", () => {
    const s: SectionState = { ...top, tilt: [30, 0] };
    const f = sectionFrame(s);
    // About u = X by a: n = (0, −sin a, cos a).
    close(f.normal, [0, -0.5, Math.sqrt(3) / 2]);
    close(f.point, [0, 0, 4]);
    expect(f.cosTilt).toBeCloseTo(Math.sqrt(3) / 2, 12);
    // The in-plane axes turn with it: u stays X, v leans up.
    close(f.u, [1, 0, 0]);
    close(f.v, [0, Math.sqrt(3) / 2, 0.5]);
    // A point above the offset point toward −Y is cut, the same height toward +Y is kept.
    expect(isCutAway(s, [0, -2, 4.5])).toBe(true);
    expect(isCutAway(s, [0, 2, 4.5])).toBe(false);
  });

  it("tilted about both axes: about u by a, then v by b: n = (cos a sin b, −sin a, cos a cos b)", () => {
    const a = (20 * Math.PI) / 180;
    const b = (35 * Math.PI) / 180;
    const f = sectionFrame({ ...top, tilt: [20, 35] });
    close(f.normal, [Math.cos(a) * Math.sin(b), -Math.sin(a), Math.cos(a) * Math.cos(b)]);
    // Still a right-handed frame of unit vectors.
    const dot = (p: Vec3, q: Vec3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
    expect(dot(f.u, f.v)).toBeCloseTo(0, 12);
    expect(dot(f.u, f.normal)).toBeCloseTo(0, 12);
    expect(dot(f.v, f.normal)).toBeCloseTo(0, 12);
  });
});

describe("more than one plane", () => {
  const two: SectionView = { ...sectionViewOf(front), planes: [front, top] };

  it("cuts away only what is on the cut side of every plane on: a corner cut", () => {
    // Front-top quarter: y < 0 and z > 4.
    expect(cutAwayBy(two, [0, -10, 6])).toBe(true);
    expect(cutAwayBy(two, [0, 10, 6])).toBe(false);
    expect(cutAwayBy(two, [0, -10, 2])).toBe(false);
    // Three planes: a corner cut out of the front-right-top.
    const three: SectionView = { ...two, planes: [front, top, right] };
    expect(cutAwayBy(three, [10, -10, 6])).toBe(true);
    expect(cutAwayBy(three, [-10, -10, 6])).toBe(false);
  });

  it("a plane switched off, or the whole view off, cuts nothing", () => {
    const off: SectionView = { ...two, planes: [front, { ...top, enabled: false }] };
    expect(activePlanes(off)).toHaveLength(1);
    expect(cutAwayBy(off, [0, -10, 2])).toBe(true);
    expect(activePlanes({ ...two, on: false })).toEqual([]);
    expect(cutAwayBy({ ...two, on: false }, [0, -10, 6])).toBe(false);
  });

  it("cuts only the bodies chosen; the others stay whole", () => {
    const some: SectionView = { ...two, bodies: ["plate"] };
    expect(cutsBody(some, "plate")).toBe(true);
    expect(cutsBody(some, "rib")).toBe(false);
    expect(cutAwayBy(some, [0, -10, 6], "plate")).toBe(true);
    expect(cutAwayBy(some, [0, -10, 6], "rib")).toBe(false);
    expect(cutsBody(two, "anything")).toBe(true);
  });

  it("adds the next default plane not in use, up to three; removes one, keeping the panel on a plane that is there", () => {
    let v = sectionViewOf(front);
    v = addPlane(v, {}, box);
    expect(v.planes.map((p) => p.on)).toEqual(["Front", "Top"]);
    expect(v.active).toBe(1);
    expect(v.planes[1].offset).toBe(4);
    v = addPlane(v, {}, box);
    expect(v.planes.map((p) => p.on)).toEqual(["Front", "Top", "Right"]);
    expect(addPlane(v, {}, box)).toBe(v);
    v = removePlane({ ...v, active: 2 }, 0);
    expect(v.planes.map((p) => p.on)).toEqual(["Top", "Right"]);
    expect(v.active).toBe(1);
    expect(removePlane(sectionViewOf(front), 0).planes).toHaveLength(1);
    expect(setPlane(v, 0, { ...v.planes[0], offset: 7 }).planes[0].offset).toBe(7);
  });
});

describe("drawing and dragging a plane", () => {
  it("draws a rectangle round the part on the plane, with a margin; its middle over the part's middle", () => {
    const r = sectionRect(top, box, 0);
    // Top through Z 4: the part's 100 × 60 outline, at Z 4.
    expect(r.corners.map((c) => c.map((x) => Math.round(x * 1e9) / 1e9 + 0))).toEqual([
      [-50, -30, 4],
      [50, -30, 4],
      [50, 30, 4],
      [-50, 30, 4],
    ]);
    close(r.centre, [0, 0, 4]);
    // An 8 % margin of the larger side each way.
    expect(sectionRect(top, box).corners[0][0]).toBeCloseTo(-58, 9);
  });

  it("puts the drag arrow on the rectangle's far edge, a quarter along (clear of the origin), along the offset's way; tilted, a mm of drag moves the offset 1/cos", () => {
    const a = offsetArrow(top, box)!;
    close(a.dir, [0, 0, 1]);
    expect(a.scale).toBe(1);
    // Top: the far edge along Y, 30 + 8 % of 100 out, at the plane's height; a quarter of the way from X −58 to 58.
    close(a.tip, [-29, 38, 4]);
    // Its foot at offset 0 is where the plane would be at offset 0.
    close(a.origin, [-29, 38, 0]);
    const t = offsetArrow({ ...top, tilt: [60, 0] }, box)!;
    expect(t.scale).toBeCloseTo(2, 12);
    // The tip: origin + dir · offset / scale is on the tilted plane, at its rectangle's far edge.
    const tip: Vec3 = [0, 1, 2].map((i) => t.origin[i] + t.dir[i] * (top.offset / t.scale)) as Vec3;
    close(tip, t.tip);
    const f = sectionFrame({ ...top, tilt: [60, 0] });
    expect(f.normal.reduce((sum, n, i) => sum + n * (tip[i] - f.point[i]), 0)).toBeCloseTo(0, 9);
    // Moved by 10 mm of offset, the tilted plane moves 10 · cos 60° = 5 mm along its normal, and the tip with it.
    const moved = offsetArrow({ ...top, offset: 14, tilt: [60, 0] }, box)!;
    const shift = [0, 1, 2].map((i) => moved.tip[i] - t.tip[i]) as Vec3;
    close(shift, [0, 1, 2].map((i) => t.dir[i] * 5) as Vec3);
    // Tilted almost square to its own offset: no arrow (type the offset).
    expect(offsetArrow({ ...top, tilt: [85, 0] }, box)).toBeNull();
  });

  it("knows the part's extent along a plane's normal (the offset slider's range)", () => {
    expect(extentAlong([0, -1, 0], [0, 0, 0], box)).toEqual({ min: -30, max: 30, middle: 0 });
  });
});

describe("following plane features and remembering", () => {
  const plane: Datum = { kind: "plane", origin: [0, 0, 5], normal: [0, 0, 1], xDir: [1, 0, 0] };
  const onFeature = sectionOn("plane_1", { plane_1: plane }, box) as SectionState;

  it("moves a plane feature's section with it; drops it when the feature is gone, and the view when nothing is left", () => {
    const v: SectionView = { ...sectionViewOf(front), planes: [front, onFeature] };
    expect(followDatums(v, { plane_1: plane }).view).toBe(v);
    const moved = followDatums(v, { plane_1: { ...plane, origin: [0, 0, 7] } });
    expect(moved.view!.planes[1].origin).toEqual([0, 0, 7]);
    const gone = followDatums({ ...v, active: 1 }, {});
    expect(gone.gone).toEqual(["plane_1"]);
    expect(gone.view!.planes.map((p) => p.on)).toEqual(["Front"]);
    expect(gone.view!.active).toBe(0);
    expect(followDatums(sectionViewOf(onFeature), {}).view).toBeNull();
  });

  it("reads a stored view safely, and an old single remembered plane as a view of it", () => {
    const v: SectionView = { planes: [front, { ...top, tilt: [10, -5], enabled: false }], on: false, active: 1, showPlane: false, bodies: ["a"], capColour: "bodies", collapsed: true };
    expect(parseSectionView(JSON.parse(JSON.stringify(v)))).toEqual(v);
    expect(parseSectionView(front)).toEqual(sectionViewOf(front));
    expect(parseSectionView({ planes: [{ on: "Top" }] })).toBeNull();
    expect(parseSectionView({ planes: [front], tilt: 3, active: 9 })!.active).toBe(0);
    expect(parseSectionView({ planes: [{ ...front, tilt: [200, 0] }] })!.planes[0].tilt).toEqual([85, 0]);
    expect(parseSectionView("junk")).toBeNull();
  });
});
