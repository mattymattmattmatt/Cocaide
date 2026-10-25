// The 3D view's navigation, pure parts: the standard views (a true isometric,
// dimetric, trimetric), the view cube's 26 targets and the triad's clicks; the
// rotation centre (pinned, the box's middle while the part is on screen, the
// part under the middle when zoomed in, else the nearest point), the turn
// keeping that centre on the screen, its speed, the turntable keeping Z up,
// re-seating the look-at point without moving the view, tight framing, zoom
// to an area, blending cameras for the glide; the view settings, named views
// and Select Other's names and Alt+click cycling.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { Vec3 } from "../src/doc/types";
import type { EdgeInfo, FaceInfo } from "../src/kernel/topology";
import { DEFAULT_DISPLAY, nextViewName, parseMemory, removeNamedView, renameNamedView, saveNamedView, type CameraState } from "../src/ui/evaluate/display";
import {
  areaZoom,
  blendRig,
  distanceToRay,
  ease,
  framePoints,
  nearestOnSegments,
  nearestToRay,
  onScreenShare,
  orbit,
  poseAxes,
  poseOf,
  reseat,
  rigOf,
  rotationCentre,
  turnPerPixel,
  type Pose,
} from "../src/ui/viewport/orbit";
import { nextBehind, otherLabel, underPointer, type UnderPointer } from "../src/ui/viewport/selectOther";
import { cubeCell, cubeTargets, standardViewOf, triadView, upFor, VIEWS } from "../src/ui/viewport/views";
import { DEFAULT_VIEW_PREFS, parseViewPrefs } from "../src/ui/viewport/viewPrefs";

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const close = (a: THREE.Vector3 | Vec3, b: Vec3, digits = 6) => {
  const p = Array.isArray(a) ? a : a.toArray();
  p.forEach((x, i) => expect(x).toBeCloseTo(b[i], digits));
};

/** An orthographic camera at `pose`, its frame `halfH` mm high either side, a 4:3 view. */
function orthoAt(pose: Pose, halfH: number): THREE.OrthographicCamera {
  const c = new THREE.OrthographicCamera(-halfH * (4 / 3), halfH * (4 / 3), halfH, -halfH, -1000, 1000);
  c.position.copy(pose.position);
  c.up.copy(pose.up);
  c.lookAt(pose.target);
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c;
}
/** Where a world point is on the screen, normalised (−1..1). */
const ndc = (cam: THREE.Camera, p: THREE.Vector3) => p.clone().project(cam);

/** The bracket's plate: 80 × 40 × 6, centred on the origin in X and Y, on Z 0–6. */
const plate = new THREE.Box3(v3(-40, -20, 0), v3(40, 20, 6));

describe("the standard views", () => {
  it("isometric is the true one: equal angles to X, Y and Z, from the front, right and above", () => {
    const s = 1 / Math.sqrt(3);
    close(VIEWS.iso.dir, [s, -s, s], 12);
    expect(VIEWS.iso.up).toEqual([0, 0, 1]);
    // Each axis is foreshortened the same: |d·axis| equal.
    const d = VIEWS.iso.dir.map(Math.abs);
    expect(d[0]).toBeCloseTo(d[1], 12);
    expect(d[1]).toBeCloseTo(d[2], 12);
  });

  it("dimetric shows X and Z full and Y at half; trimetric shortens all three differently", () => {
    // An axis's length on screen is √(1 − (d·axis)²).
    const shown = (d: Vec3) => d.map((x) => Math.sqrt(1 - x * x));
    const [x, y, z] = shown(VIEWS.dimetric.dir);
    expect(x).toBeCloseTo(z, 12);
    expect(y / x).toBeCloseTo(0.5, 12);
    const t = shown(VIEWS.trimetric.dir);
    expect(new Set(t.map((k) => k.toFixed(3))).size).toBe(3);
    for (const n of ["dimetric", "trimetric"] as const) {
      expect(Math.hypot(...VIEWS[n].dir)).toBeCloseTo(1, 12);
      // From the front (−Y), right (+X) and above (+Z).
      expect(VIEWS[n].dir[0]).toBeGreaterThan(0);
      expect(VIEWS[n].dir[1]).toBeLessThan(0);
      expect(VIEWS[n].dir[2]).toBeGreaterThan(0);
    }
  });

  it("knows a standard view when it sees one", () => {
    expect(standardViewOf([0, -1, 0])).toBe("front");
    expect(standardViewOf([1, -1, 1])).toBe("iso");
    expect(standardViewOf([1, -1, 0.8])).toBeNull();
  });

  it("puts +Z up the screen, but +Y looking straight down and −Y looking straight up", () => {
    expect(upFor([1, -1, 1])).toEqual([0, 0, 1]);
    expect(upFor([0, 0, 1])).toEqual([0, 1, 0]);
    expect(upFor([0, 0, -1])).toEqual([0, -1, 0]);
  });
});

describe("the view cube", () => {
  it("has 26 targets: 6 faces, 12 edges, 8 corners, each a unit direction", () => {
    const all = cubeTargets();
    expect(all).toHaveLength(26);
    expect(all.filter((t) => t.kind === "face")).toHaveLength(6);
    expect(all.filter((t) => t.kind === "edge")).toHaveLength(12);
    expect(all.filter((t) => t.kind === "corner")).toHaveLength(8);
    for (const t of all) expect(Math.hypot(...t.dir)).toBeCloseTo(1, 12);
  });

  it("maps a face's 3 × 3 grid: the middle is the face, its sides edges, its corners corners, named as the views are", () => {
    expect(cubeCell("front", 1, 1)).toMatchObject({ key: "0,-1,0", kind: "face", label: "Front", up: [0, 0, 1] });
    // The top-right cell of the front face is the front-right-top corner: the isometric view.
    const corner = cubeCell("front", 2, 0);
    expect(corner).toMatchObject({ key: "1,-1,1", kind: "corner", label: "Front Right Top" });
    close(corner.dir, VIEWS.iso.dir, 12);
    // The same corner from the top face (its bottom-right cell as it reads) and the right face (top-left).
    expect(cubeCell("top", 2, 2).key).toBe("1,-1,1");
    expect(cubeCell("right", 0, 0).key).toBe("1,-1,1");
    expect(cubeCell("top", 1, 1)).toMatchObject({ label: "Top", up: [0, 1, 0] });
    expect(cubeCell("bottom", 1, 1)).toMatchObject({ label: "Bottom", up: [0, -1, 0] });
    expect(cubeCell("back", 1, 0)).toMatchObject({ key: "0,1,1", kind: "edge", label: "Back Top" });
    expect(cubeCell("left", 0, 1)).toMatchObject({ key: "-1,1,0", label: "Back Left" });
  });
});

describe("the triad", () => {
  it("looks along an axis with it pointing at you; clicked again, from the other side", () => {
    expect(triadView("x", VIEWS.iso.dir)).toEqual({ dir: [1, 0, 0], up: [0, 0, 1] });
    expect(triadView("x", [1, 0, 0])).toEqual({ dir: [-1, 0, 0], up: [0, 0, 1] });
    expect(triadView("z", [0, -1, 0])).toEqual({ dir: [0, 0, 1], up: [0, 1, 0] });
    expect(triadView("z", [0, 0, 1])).toEqual({ dir: [0, 0, -1], up: [0, -1, 0] });
    expect(triadView("y", [0, 0, 1]).dir).toEqual([0, 1, 0]);
  });
});

describe("the rotation centre", () => {
  const iso: Pose = { position: v3(100, -100, 103), target: v3(0, 0, 3), up: v3(0, 0, 1) };
  const none = () => null;

  it("is the pinned point when one is pinned", () => {
    const cam = orthoAt(iso, 60);
    const c = rotationCentre({ camera: cam, box: plate, pinned: v3(40, 20, 6), underCentre: none, nearestToCentre: none, fallback: iso.target });
    expect(c.why).toBe("pinned");
    close(c.point, [40, 20, 6]);
  });

  it("is the middle of the part's box while the part is mostly on screen, even panned well off the look-at point", () => {
    // Panned: the camera looks 30 mm to the right of the part, which is still all on screen.
    const panned: Pose = { position: v3(130, -70, 103), target: v3(30, 30, 3), up: v3(0, 0, 1) };
    const cam = orthoAt(panned, 80);
    expect(onScreenShare(plate, cam)).toBe(1);
    const c = rotationCentre({ camera: cam, box: plate, pinned: null, underCentre: () => v3(9, 9, 9), nearestToCentre: none, fallback: panned.target });
    expect(c.why).toBe("box");
    close(c.point, [0, 0, 3]);
  });

  it("zoomed in so the part overflows the view: the part under the middle of the view, else the nearest point of it", () => {
    // Zoomed onto the plate's corner: a frame 10 mm high on a part 80 long.
    const zoomed: Pose = { position: v3(135, -115, 103), target: v3(35, -15, 3), up: v3(0, 0, 1) };
    const cam = orthoAt(zoomed, 5);
    expect(onScreenShare(plate, cam)).toBeLessThan(0.6);
    const under = rotationCentre({ camera: cam, box: plate, pinned: null, underCentre: () => v3(35, -15, 6), nearestToCentre: () => v3(0, 0, 0), fallback: zoomed.target });
    expect(under.why).toBe("under");
    close(under.point, [35, -15, 6]);
    const near = rotationCentre({ camera: cam, box: plate, pinned: null, underCentre: none, nearestToCentre: () => v3(40, -20, 6), fallback: zoomed.target });
    expect(near.why).toBe("nearest");
    close(near.point, [40, -20, 6]);
  });

  it("with nothing shown, turns about the look-at point", () => {
    const cam = orthoAt(iso, 60);
    expect(rotationCentre({ camera: cam, box: null, pinned: null, underCentre: none, nearestToCentre: none, fallback: v3(1, 2, 3) })).toMatchObject({ why: "target" });
  });

  it("counts a part with a corner behind a perspective camera as overflowing", () => {
    const cam = new THREE.PerspectiveCamera(35, 4 / 3, 0.1, 1000);
    cam.position.set(0, 0, 3); // inside the plate's box
    cam.lookAt(10, 0, 3);
    cam.updateMatrixWorld();
    expect(onScreenShare(plate, cam)).toBe(0);
  });

  it("finds the vertex nearest the middle ray, leaving out what it is told to", () => {
    const pts = [0, 0, 0, 5, 1, 0, 10, 0.2, 0, 3, 3, 3];
    close(nearestToRay(pts, v3(0, 0, -10), v3(0, 0, 1))!, [0, 0, 0]);
    close(nearestToRay(pts, v3(10, 0, -10), v3(0, 0, 1))!, [10, 0.2, 0]);
    close(nearestToRay(pts, v3(10, 0, -10), v3(0, 0, 1), { keep: (i) => i !== 2 })!, [5, 1, 0]);
    expect(nearestToRay(pts, v3(0, 0, 10), v3(0, 0, 1), { ahead: true })).toBeNull();
  });

  it("finds the point of an edge nearest the middle ray, beside the middle of a long member rather than at its far ends", () => {
    // A 6 m beam's edge along X, 5 mm to the side of a ray straight down Z at X 100: its mesh has vertices only at the ends.
    const edge = [-3000, 5, 0, 3000, 5, 0];
    const origin = v3(100, 0, 50);
    const down = v3(0, 0, -1);
    close(nearestOnSegments(edge, origin, down)!, [100, 5, 0]);
    expect(distanceToRay(nearestOnSegments(edge, origin, down)!, origin, down)).toBeCloseTo(5, 9);
    // The ends are 2900 mm off; the edge's point is 5 mm off.
    expect(distanceToRay(nearestToRay(edge, origin, down)!, origin, down)).toBeGreaterThan(2900);
    // Past a segment's end the end is nearest; a segment along the ray (parallel to it) counts by its first end.
    close(nearestOnSegments([200, 0, 0, 300, 0, 0], origin, down)!, [200, 0, 0]);
    close(nearestOnSegments([100, 3, 9, 100, 3, -9], origin, down)!, [100, 3, 9]);
    // Two segments: the nearer wins; `keep` leaves one out; `ahead` leaves out what is behind the ray's origin.
    const two = [-50, 9, 0, 50, 9, 0, -50, 2, 0, 50, 2, 0];
    close(nearestOnSegments(two, origin, down)!, [50, 2, 0]);
    close(nearestOnSegments(two, origin, down, { keep: (i) => i !== 1 })!, [50, 9, 0]);
    expect(nearestOnSegments([0, 0, 60, 10, 0, 60], origin, down, { ahead: true })).toBeNull();
  });
});

describe("the turn", () => {
  const iso: Pose = { position: v3(100, -100, 103), target: v3(0, 0, 3), up: v3(0, 0, 1) };

  it("keeps the centre where it is on the screen, and the eye as far from it", () => {
    // A centre on the part away from the look-at point (a pinned corner).
    const centre = v3(40, 20, 6);
    const before = ndc(orthoAt(iso, 60), centre);
    const turned = orbit(iso, centre, 0.7, -0.4);
    const after = ndc(orthoAt(turned, 60), centre);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(turned.position.distanceTo(centre)).toBeCloseTo(iso.position.distanceTo(centre), 9);
    expect(turned.position.distanceTo(turned.target)).toBeCloseTo(iso.position.distanceTo(iso.target), 9);
  });

  it("turns half a turn for a drag across the view's height at 100 %, scaled by the speed", () => {
    expect(turnPerPixel(800) * 800).toBeCloseTo(Math.PI, 12);
    expect(turnPerPixel(800, 2) * 800).toBeCloseTo(2 * Math.PI, 12);
    expect(turnPerPixel(800, 0.5) * 400).toBeCloseTo(Math.PI / 4, 12);
  });

  it("keeping Z up: a sideways drag turns about Z with up staying +Z; a drag down tips the view to look from higher, never over the top", () => {
    const front: Pose = { position: v3(0, -100, 3), target: v3(0, 0, 3), up: v3(0, 0, 1) };
    const c = v3(0, 0, 3);
    const yawed = orbit(front, c, 0.5, 0, true);
    close(yawed.up, [0, 0, 1], 12);
    close(poseAxes(yawed).forward, [-Math.sin(0.5), Math.cos(0.5), 0], 12);
    // Tipped down by 60°: looking from 60° above, up still in the vertical plane, upward.
    const tipped = orbit(yawed, c, 0, -Math.PI / 3, true);
    const ax = poseAxes(tipped);
    expect(ax.right.z).toBeCloseTo(0, 12);
    expect(ax.up.z).toBeGreaterThan(0);
    expect(Math.asin(-ax.forward.z)).toBeCloseTo(Math.PI / 3, 9);
    // Another 60° stops at straight down, not past it.
    const over = orbit(tipped, c, 0, -Math.PI / 3, true);
    expect(poseAxes(over).forward.z).toBeCloseTo(-1, 9);
    expect(poseAxes(over).up.z).toBeGreaterThanOrEqual(-1e-9);
    // A rolled view is levelled by the first turntable turn.
    const rolled: Pose = { position: v3(0, -100, 3), target: v3(0, 0, 3), up: v3(0.5, 0, 1).normalize() };
    close(orbit(rolled, c, 0, 0, true).up, [0, 0, 1], 12);
    // Free rotation keeps the roll and may go over the top.
    expect(orbit(rolled, c, 0, 0, false).up.x).toBeCloseTo(rolled.up.x, 12);
    expect(poseAxes(orbit(front, c, 0, -Math.PI * 0.75, false)).up.z).toBeLessThan(0);
  });

  it("re-seats the look-at point at the centre's depth without moving the view", () => {
    const panned: Pose = { position: v3(130, -70, 103), target: v3(30, 30, 3), up: v3(0, 0, 1) };
    const centre = v3(0, 0, 3);
    const camBefore = orthoAt(panned, 50);
    const probe = v3(40, 20, 6);
    // Orthographic: the eye moves along the line of sight, the distance (the zoom) stays.
    const o = reseat(panned, centre, true);
    expect(o.position.distanceTo(o.target)).toBeCloseTo(panned.position.distanceTo(panned.target), 9);
    expect(o.target.clone().sub(o.position).normalize().dot(centre.clone().sub(o.target))).toBeCloseTo(0, 9);
    const a = ndc(camBefore, probe);
    const b = ndc(orthoAt(o, 50), probe);
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(b.y).toBeCloseTo(a.y, 9);
    // Perspective: the eye stays, only the target slides along the line of sight to the centre's depth.
    const p = reseat(panned, centre, false);
    close(p.position, panned.position.toArray() as Vec3, 12);
    const f = poseAxes(panned).forward;
    expect(p.target.clone().sub(p.position).normalize().dot(f)).toBeCloseTo(1, 12);
    expect(centre.clone().sub(p.target).dot(f)).toBeCloseTo(0, 9);
  });
});

describe("framing and zooming", () => {
  const platePoints = (() => {
    const out: number[] = [];
    for (const x of [-40, 40]) for (const y of [-20, 20]) for (const z of [0, 6]) out.push(x, y, z);
    return out;
  })();

  it("frames the part tightly from a direction: from the front, 80 wide on a 4:3 view sets the frame's height", () => {
    const f = framePoints(platePoints, v3(0, -1, 0), v3(0, 0, 1), 4 / 3, 35, { margin: 1 })!;
    close(f.target, [0, 0, 3], 9);
    // Half-width 40 on a 4:3 view needs a half-height of 30: the distance whose frame is that tall.
    expect(f.dist * Math.tan(THREE.MathUtils.degToRad(17.5))).toBeCloseTo(30, 9);
    // From above, 80 × 40 on 4:3: the width still rules (40 / (4/3) = 30 > 20).
    const top = framePoints(platePoints, v3(0, 0, 1), v3(0, 1, 0), 4 / 3, 35, { margin: 1 })!;
    expect(top.dist * Math.tan(THREE.MathUtils.degToRad(17.5))).toBeCloseTo(30, 9);
    // End-on, the 40 × 6 end fills the view instead of a sphere round the whole length.
    const end = framePoints(platePoints, v3(1, 0, 0), v3(0, 0, 1), 4 / 3, 35, { margin: 1 })!;
    expect(end.dist * Math.tan(THREE.MathUtils.degToRad(17.5))).toBeCloseTo(15, 9);
  });

  it("zooms to an area: its middle, and the larger of its shares of the view's width and height", () => {
    const z = areaZoom({ x0: 100, y0: 50, x1: 300, y1: 150 }, 800, 600)!;
    expect(z.ndc[0]).toBeCloseTo(-0.5, 12);
    expect(z.ndc[1]).toBeCloseTo(1 - 200 / 600, 12);
    expect(z.factor).toBeCloseTo(0.25, 12);
    expect(areaZoom({ x0: 10, y0: 10, x1: 12, y1: 13 }, 800, 600)).toBeNull();
  });

  it("blends two cameras: the ends exact, the middle turned halfway, the distance geometric", () => {
    const front: Pose = { position: v3(0, -100, 0), target: v3(0, 0, 0), up: v3(0, 0, 1) };
    const right: Pose = { position: v3(400, 10, 0), target: v3(0, 10, 0), up: v3(0, 0, 1) };
    const a = rigOf(front);
    const b = rigOf(right);
    const start = poseOf(blendRig(a, b, 0));
    close(start.position, [0, -100, 0], 9);
    close(start.up, [0, 0, 1], 9);
    close(poseOf(blendRig(a, b, 1)).position, [400, 10, 0], 9);
    const mid = poseOf(blendRig(a, b, 0.5));
    close(poseAxes(mid).forward, [-Math.SQRT1_2, Math.SQRT1_2, 0], 9);
    expect(mid.position.distanceTo(mid.target)).toBeCloseTo(200, 9);
    close(mid.target, [0, 5, 0], 9);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.5, 12);
    expect(ease(0.1)).toBeLessThan(0.1);
  });
});

describe("view settings and memory", () => {
  it("defaults to orthographic", () => {
    expect(DEFAULT_DISPLAY.perspective).toBe(false);
    // A document that remembered perspective keeps it; one remembered before without the flag reads as perspective.
    expect(parseMemory({ display: { style: "shaded", perspective: true } }).display).toEqual({ style: "shaded", perspective: true });
    expect(parseMemory({ display: { style: "shaded" } }).display).toEqual({ style: "shaded", perspective: true });
  });

  it("reads the mouse view settings safely: speed held to 50–200 %, turntable off, animation and the cube on", () => {
    expect(parseViewPrefs(null)).toEqual(DEFAULT_VIEW_PREFS);
    expect(DEFAULT_VIEW_PREFS).toEqual({ rotateSpeed: 1, turntable: false, animate: true, viewCube: true });
    expect(parseViewPrefs({ rotateSpeed: 5, turntable: true, animate: false, viewCube: false })).toEqual({ rotateSpeed: 2, turntable: true, animate: false, viewCube: false });
    expect(parseViewPrefs({ rotateSpeed: 0.1 }).rotateSpeed).toBe(0.5);
    expect(parseViewPrefs({ rotateSpeed: "fast" }).rotateSpeed).toBe(1);
  });

  it("saves, renames and deletes named views, kept per document", () => {
    const cam: CameraState = { position: [1, 2, 3], target: [0, 0, 0], up: [0, 0, 1] };
    let views = saveNamedView([], "  Weld detail ", cam);
    expect(views).toEqual([{ name: "Weld detail", camera: cam }]);
    expect(nextViewName(views)).toBe("View 1");
    views = saveNamedView(views, "View 1", { ...cam, position: [9, 9, 9] });
    expect(nextViewName(views)).toBe("View 2");
    // The same name again replaces it in place.
    views = saveNamedView(views, "weld DETAIL", { ...cam, position: [5, 5, 5] });
    expect(views.map((v) => v.name)).toEqual(["weld DETAIL", "View 1"]);
    expect(renameNamedView(views, "View 1", "weld detail")).toMatch(/already a view called/);
    expect(renameNamedView(views, "View 1", " ")).toMatch(/needs a name/);
    const renamed = renameNamedView(views, "View 1", "End") as typeof views;
    expect(renamed.map((v) => v.name)).toEqual(["weld DETAIL", "End"]);
    expect(removeNamedView(renamed, "weld DETAIL").map((v) => v.name)).toEqual(["End"]);
    // Stored and read back; odd entries dropped.
    expect(parseMemory({ views: [...renamed, { name: "", camera: cam }, { name: "x", camera: { position: [1] } }] }).views).toEqual(renamed);
  });
});

describe("select other", () => {
  const faces = [
    { type: "plane", normal: [0, 0, 1], area: 1, centroid: [0, 0, 6] },
    { type: "plane", normal: [0, 0, -1], area: 1, centroid: [0, 0, 0] },
    { type: "cylinder", cylinder: { radius: 3.3, concave: true }, area: 1, centroid: [0, 0, 3] },
  ] as unknown as FaceInfo[];
  const edges = [{ kind: "line", length: 80 }, { kind: "circle", radius: 3.3, length: 20 }] as unknown as EdgeInfo[];
  const face = (index: number, distance: number): UnderPointer => ({ target: { kind: "face", index, point: [0, 0, 0] }, distance });

  it("names each face and edge so they can be told apart", () => {
    expect(otherLabel({ kind: "face", index: 0, point: [0, 0, 0] }, faces, edges)).toBe("Face 1 (flat, +Z)");
    expect(otherLabel({ kind: "face", index: 2, point: [0, 0, 0] }, faces, edges)).toBe("Face 3 (hole Ø6.6)");
    expect(otherLabel({ kind: "edge", index: 0, point: [0, 0, 0] }, faces, edges)).toBe("Edge 1 (straight, 80 mm)");
    expect(otherLabel({ kind: "edge", index: 1, point: [0, 0, 0] }, faces, edges)).toBe("Edge 2 (circle Ø6.6)");
  });

  it("lists what is under the pointer nearest first, each once", () => {
    expect(underPointer([face(1, 6), face(0, 0), face(1, 9), face(2, 3)]).map((h) => [h.target.index, h.distance])).toEqual([
      [0, 0],
      [2, 3],
      [1, 6],
    ]);
  });

  it("Alt+click steps to the face behind the one selected, round to the front after the last", () => {
    const list = [face(0, 0), face(2, 3), face(1, 6)];
    expect(nextBehind(list, { faces: [], edges: [] })!.target.index).toBe(2);
    expect(nextBehind(list, { faces: [2], edges: [] })!.target.index).toBe(1);
    expect(nextBehind(list, { faces: [1], edges: [] })!.target.index).toBe(0);
    expect(nextBehind([face(4, 1)], { faces: [], edges: [] })!.target.index).toBe(4);
    expect(nextBehind([], { faces: [], edges: [] })).toBeNull();
  });
});
