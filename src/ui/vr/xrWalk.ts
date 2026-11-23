// The VR walkthrough (WebXR, immersive-vr): the model at 1:1 around you, the
// floor where your feet are, standing where the document says to start
// (Settings > VR > Set the start point, else in front of the model, facing it).
//
//   Left hand:  trigger: aim the arc, let go to teleport (onto floors only, any
//               level); stick: walk (Settings > VR); X: the menu; Y: back to
//               the start.
//   Right hand: trigger: the tool in use (the menu picks it): Teleport, Measure
//               (point to point; it snaps to corners and edges unless that's
//               switched off), Pin (a note where you point: "too tight here"),
//               Move (the trigger picks pieces of furniture, green, and lets
//               them go: a group; on the ring's knobs it turns them 10° a
//               click, or sweep a knob round); stick: snap turn, or
//               turn what you carry; A: undo; B: roof off.
//   Either grip: carry what is picked (or the piece you point at), put it down where
//               you let go.
//   Menu: tools, snapping, the pin's kind, roof, back to the start, the
//   dollhouse (the model small on a table in front of you: point at a floor
//   in it and let go of the trigger to stand there), the next pin, undo,
//   leave VR.
//
// Pins and moved furniture are proposals: they are handed to the document
// when you leave VR (src/doc/vr.ts), drawn on the desktop as notes and onion
// skin, and accepted (a Move feature) or rejected there.
//
// The viewport hands over its renderer, scene and model group. While you are
// in VR the model is held by a rig that turns it Y-up and scales it to metres
// (the view itself is Z-up, in mm); everything else in the scene is put away
// and comes back as it was when you leave.

import * as THREE from "three";
import { niceName, PIN_COLORS, PIN_TAGS, PIN_WORDS, type PinTag, type VrMove, type VrPin, type VrStart } from "../../doc/vr";
import type { Vec3 } from "../../doc/types";
import type { RebuildView } from "../../worker/protocol";
import { centreOf, itemOfFace, itemOfMove, itemsOf, itemTriangles, type VrItem } from "./items";
import { disposeSprite, Panel, textSprite } from "./vrText";
import { scaledAbout, scaleText, startScale, twoHandPose, type HeldPose } from "./inspect";
import type { VrPrefs } from "./vrPrefs";
import { RayIndex } from "./rayIndex";
import { faceCard, faceName, pairCard, type FaceCard } from "./vrMeasure";
import { meshClosest } from "../evaluate/meshDistance";
import type { FaceInfo } from "../../kernel/topology";

export interface XrHost {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  model: THREE.Group;
  /** The desktop frame, drawn again when you come out. */
  render(): void;
  prefs(): VrPrefs;
  start(): VrStart | null;
  /** The view on screen (its faces and mesh) and the mesh drawing it. */
  view(): RebuildView | null;
  mesh(): THREE.Mesh | null;
  /** Hides these faces of the model's mesh (and their edges); null shows everything again. */
  hideFaces(faces: number[] | null): void;
  /** The document's pins and moves so far. */
  notes(): { pins: VrPin[]; moves: VrMove[] };
  /** Told when VR starts and ends. */
  onChange(inVr: boolean): void;
  /** What was added in VR (pins, and moves on top of the document's), when you leave. */
  onDone(pins: VrPin[], moves: VrMove[]): void;
  /** A part (the Model tab): it can be held and inspected. */
  canInspect?(): boolean;
  /** Start by holding it (a part with no start point to stand at); else walk through it. */
  startInspecting?(): boolean;
}

export type VrTool = "teleport" | "measure" | "pin" | "move";

/** A model point (mm, Z up) as the rig's child sees it (m, Y up). */
export const toXr = (p: [number, number, number]) => new THREE.Vector3(p[0] / 1000, p[2] / 1000, -p[1] / 1000);

/**
 * Where the rig goes so that `start` is under your feet (the reference space's origin) and you face its heading:
 * its turn about Y and its position.
 */
export function rigFor(start: VrStart): { rotY: number; position: THREE.Vector3 } {
  const rotY = ((90 - start.heading) * Math.PI) / 180;
  const p = toXr(start.at).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
  return { rotY, position: p.multiplyScalar(-1) };
}

/** A start in front of the model's bounding box (3 m south of it, on its lowest level), facing north. */
export function defaultStart(box: THREE.Box3): VrStart {
  if (box.isEmpty()) return { at: [0, -3000, 0], heading: 90 };
  return { at: [(box.min.x + box.max.x) / 2, box.min.y - 3000, box.min.z], heading: 90 };
}

/** A length as a dimension reads: "2,350 mm" (and metres past 1 m: "2,350 mm (2.35 m)"). */
export function lengthText(mm: number): string {
  const r = Math.round(mm);
  const s = r.toLocaleString("en-AU");
  return r >= 1000 ? `${s} mm (${(r / 1000).toFixed(2)} m)` : `${s} mm`;
}

/** The point of a triangle a measure snaps to near p: a corner within 60 mm, else the nearest point of an edge within 40 mm, else p (other reaches: a part held small or large). */
export function snapPoint(p: Vec3, tri: [Vec3, Vec3, Vec3], reach: { corner: number; edge: number } = { corner: 60, edge: 40 }): { at: Vec3; kind: "corner" | "edge" | "surface" } {
  const d = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  let best: Vec3 | null = null;
  let bd = reach.corner;
  for (const v of tri) if (d(p, v) < bd) [best, bd] = [v, d(p, v)];
  if (best) return { at: [...best] as Vec3, kind: "corner" };
  bd = reach.edge;
  for (let i = 0; i < 3; i++) {
    const a = tri[i];
    const b = tri[(i + 1) % 3];
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
    if (!l2) continue;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / l2));
    const q: Vec3 = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
    if (d(p, q) < bd) [best, bd] = [q, d(p, q)];
  }
  return best ? { at: best, kind: "edge" } : { at: p, kind: "surface" };
}

const UP = new THREE.Vector3(0, 1, 0);
const BUTTONS = { trigger: 0, squeeze: 1, stick: 3, a: 4, b: 5 } as const;
const stamp = () => new Date().toISOString().slice(0, 19);
let nextId = 0;
const newId = (p: string) => `${p}_${Date.now().toString(36)}${(nextId++).toString(36)}`;

interface Controller {
  grip: THREE.Group;
  ray: THREE.Line;
  arc: THREE.Line;
  hand: "left" | "right";
  hint?: THREE.Sprite;
}
interface Measure {
  a: Vec3;
  b: Vec3;
  objs: THREE.Object3D[];
  /** A Faces measure: its headline ("Hole Ø12", "Gap 245 mm"). */
  text?: string;
}
interface Placed {
  item: VrItem;
  /** Turned about its middle (degrees), then moved (mm): in total, and as the document had it. */
  move: Vec3;
  turn: number;
  base: { move: Vec3; turn: number };
  centre: Vec3;
  ghost: THREE.Mesh;
}
type Undo = { kind: "pin"; id: string } | { kind: "measure" } | { kind: "move"; was: Map<string, { move: Vec3; turn: number }> };
/** Each selected piece's move and turn when a drag or a turn began. */
type Starts = Map<string, { move: Vec3; turn: number }>;
const SELECTED = 0x30a46c;
/** A turn handle's step (degrees). */
const TURN_STEP = 10;

export class XrWalk {
  private session: XRSession | null = null;
  private rig = new THREE.Group();
  private zup = new THREE.Group();
  /** Pins, measures and carried furniture: in the model's own frame (mm, Z up), on the rig. */
  private notesGroup = new THREE.Group();
  private lights = new THREE.Group();
  private ground: THREE.Mesh;
  private put: { obj: THREE.Object3D; visible: boolean }[] = [];
  private background: THREE.Scene["background"] = null;
  private hemiAt = new THREE.Vector3();
  private controllers: Controller[] = [];
  private target: THREE.Mesh;
  private aiming: { hand: "left" | "right" } | null = null;
  private hit: THREE.Vector3 | null = null;
  private turned = { left: false, right: false };
  private roofOff = false;
  private pressed = new Set<string>();
  private last = 0;
  private toast: THREE.Sprite | null = null;
  private toastUntil = 0;
  private startNow: VrStart = { at: [0, 0, 0], heading: 90 };
  private culled: THREE.Object3D[] = [];
  /**
   * What VR draws of the model: its triangles sorted by look, one draw call each (the model's own mesh draws runs of
   * faces, which for a house can be hundreds of calls, each made twice, once an eye). The model's mesh stays, hidden,
   * for pointing at; `at` is each of its triangles' place in the copy.
   */
  private draw: { from: THREE.Mesh; mesh: THREE.Mesh; at: Int32Array; index: Uint32Array } | null = null;
  /** The model's triangles in a tree for rays (src/ui/vr/rayIndex), built once a view; the triangles hidden in VR skipped. */
  private rays: { view: RebuildView; index: RayIndex; skip: Uint8Array; faceOf: Int32Array } | null = null;
  // Tools.
  tool: VrTool = "teleport";
  snap = true;
  /** Measure: point to point (snapping), or faces (a face's size; two faces' gap, centres, closest points, angle). */
  measureMode: "points" | "faces" = "points";
  /** Faces: the first face picked, waiting for a second (its measure is the last one). */
  private faceFirst: { index: number; face: FaceInfo } | null = null;
  /** Faces: the face the ray is on now, lit up, with a label saying what it is (or what it is to the first). */
  private faceHover: { index: number; objs: THREE.Object3D[]; label: THREE.Sprite; text: string } | null = null;
  pinTag: PinTag = "note";
  private items: VrItem[] = [];
  private placed = new Map<string, Placed>();
  /** The pieces picked (green): moved together by a grip, turned together by the handles. */
  private selected = new Set<string>();
  /** Carrying the selection with a grip: where the ray met the floor they stand on, and each piece's place then. */
  private carry: { key: string; hand: "left" | "right"; grab: Vec3; height: number; starts: Starts } | null = null;
  /** Turning the selection by a handle: the trigger held on it. */
  private turning: { hand: "left" | "right"; dir: 1 | -1; a0: number; centre: Vec3; starts: Starts; by: number; swept: boolean } | null = null;
  /** The turn handles round the selection (in the model's frame): a ring on the floor and a knob each way. */
  private gizmo = new THREE.Group();
  /** Show / hide: what is hidden in VR (components in an assembly, bodies in a part), and the menu's page of it. */
  private hiddenGroups = new Set<string>();
  private page: "main" | "show" = "main";
  private showPage = 0;
  private greenMat = new THREE.MeshLambertMaterial({ color: SELECTED, emissive: SELECTED, emissiveIntensity: 0.35 });
  private pins: VrPin[] = [];
  private pinObjs = new Map<string, THREE.Object3D[]>();
  private measures: Measure[] = [];
  private measuring: { a: Vec3; marker: THREE.Object3D; live: THREE.Object3D[]; pressedAt: number } | null = null;
  private undo: Undo[] = [];
  private pinCursor = -1;
  private menu: Panel;
  private menuOpen = false;
  private dollhouse: { rot: number; pos: THREE.Vector3 } | null = null;
  private vignette: THREE.Mesh;
  private pointer: THREE.Mesh;
  // Inspecting a part (src/ui/vr/inspect): held in the air, turned and scaled, instead of walked through.
  private inspecting = false;
  /** What holds the model: moved, turned and scaled while inspecting; as it is (nothing) while walking. */
  private hold = new THREE.Group();
  /** The floor while inspecting: a lawn and a metre grid at your feet (the model's own floor is wherever it is held). */
  private floor = new THREE.Group();
  private needsPlace = false;
  /** Each hand holding the part: where the part is from the hand. */
  private grabs: Partial<Record<"left" | "right", THREE.Matrix4>> = {};
  /** Both hands holding: where they gripped, and the part's pose then. */
  private two: { a0: THREE.Vector3; b0: THREE.Vector3; from: HeldPose } | null = null;
  private spin = false;

  constructor(private host: XrHost) {
    this.zup.rotation.x = -Math.PI / 2;
    this.zup.scale.setScalar(0.001);
    this.zup.add(this.notesGroup);
    this.hold.add(this.zup);
    this.rig.add(this.hold);
    const lawn = new THREE.Mesh(new THREE.CircleGeometry(400, 64).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x8aa66a }));
    lawn.name = "xr-floor";
    const grid = new THREE.GridHelper(20, 20, 0x3f5a2f, 0x55703f);
    grid.position.y = 0.002;
    this.floor.add(lawn, grid);
    this.rig.name = "xr-rig";
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(30, 50, 20);
    const back = new THREE.DirectionalLight(0xffffff, 0.6);
    back.position.set(-25, 30, -40);
    this.lights.add(sun, back, new THREE.AmbientLight(0xffffff, 0.9));
    this.ground = new THREE.Mesh(new THREE.CircleGeometry(400000, 64), new THREE.MeshLambertMaterial({ color: 0x8aa66a }));
    this.ground.name = "xr-ground";
    this.target = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.24, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.9, depthTest: false }));
    this.target.visible = false;
    this.target.renderOrder = 10;
    this.menu = new Panel(0.5, 0.42);
    this.vignette = new THREE.Mesh(new THREE.RingGeometry(0.09, 0.6, 48), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthTest: false, side: THREE.DoubleSide }));
    this.vignette.renderOrder = 50;
    this.vignette.visible = false;
    // Where a tool's ray meets the model: a small dot (the snapped point when measuring).
    this.pointer = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd400, depthTest: false }));
    this.pointer.renderOrder = 35;
    this.pointer.visible = false;
  }

  get active() {
    return !!this.session;
  }

  async enter(): Promise<void> {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr || this.session) return;
    const session = await xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor", "bounded-floor"] });
    const { renderer, scene, model } = this.host;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType("local-floor");
    await renderer.xr.setSession(session);
    this.session = session;
    // The scene as VR wants it: the model on the rig, the rest put away, a sky, a lawn, daylight.
    const box = new THREE.Box3().setFromObject(model);
    this.put = scene.children.map((obj) => ({ obj, visible: obj.visible }));
    for (const { obj } of this.put) obj.visible = false;
    for (const l of this.put) if ((l.obj as THREE.Light).isLight) l.obj.visible = l.visible;
    const hemi = scene.children.find((o) => (o as THREE.HemisphereLight).isHemisphereLight);
    if (hemi) {
      this.hemiAt.copy(hemi.position);
      hemi.position.set(0, 1, 0);
    }
    this.zup.add(model);
    model.visible = true;
    this.buildDraw();
    // Standing inside the model, a mesh's bounding sphere can miss you (and the whole house be culled when you
    // look up): nothing in the model is culled while you are in it; the scene is small enough not to need it.
    this.culled = [];
    model.traverse((o) => {
      if (o.frustumCulled) {
        o.frustumCulled = false;
        this.culled.push(o);
      }
    });
    this.ground.position.set(0, 0, box.isEmpty() ? -5 : box.min.z - 5);
    scene.add(this.rig, this.lights, this.target, this.vignette, this.pointer);
    this.background = scene.background;
    scene.background = new THREE.Color(0xbfd9ef);
    this.startNow = this.host.start() ?? defaultStart(box);
    if (this.host.startInspecting?.()) this.toInspect(false);
    else this.toWalk(false);
    // What can be picked up, and what was moved and pinned before (drawn where they were proposed).
    this.items = itemsOf(this.host.view());
    const notes = this.host.notes();
    for (const p of notes.pins) this.drawPin(p);
    for (const m of notes.moves) {
      const it = itemOfMove(this.items, m);
      if (it) this.place(it, m.move, m.turn ?? 0, { move: m.move, turn: m.turn ?? 0 }, m.centre);
    }
    this.applyHidden();
    this.addControllers();
    session.addEventListener("end", () => this.leave());
    this.last = performance.now();
    renderer.setAnimationLoop((t) => this.frame(t));
    this.host.onChange(true);
    this.say(this.inspecting ? "Grip to hold it · both grips: turn it, stretch to size it · A: true size" : "Welcome: X for the menu");
  }

  exit(): void {
    void this.session?.end();
  }

  private leave(): void {
    const { renderer, scene, model } = this.host;
    renderer.setAnimationLoop(null);
    renderer.xr.enabled = false;
    renderer.clippingPlanes = [];
    this.roofOff = false;
    // What was added in VR goes to the document: new pins, and each moved piece's move on top of what it had.
    const moves: VrMove[] = [];
    for (const p of this.placed.values()) {
      const dm: Vec3 = [p.move[0] - p.base.move[0], p.move[1] - p.base.move[1], p.move[2] - p.base.move[2]];
      const dt = p.turn - p.base.turn;
      if (Math.hypot(...dm) < 1 && Math.abs(dt) < 0.01) continue;
      const it = p.item;
      moves.push({ id: newId("move"), body: it.partBody ?? it.body, ...(it.partBody !== undefined ? { component: it.body } : {}), move: dm.map((v) => Math.round(v)) as Vec3, ...(dt ? { turn: Math.round(dt * 10) / 10 } : {}), centre: p.centre.map((v) => Math.round(v)) as Vec3, made: stamp() });
    }
    const pins = this.pins;
    for (const c of this.controllers) {
      c.grip.removeFromParent();
      c.arc.removeFromParent();
      if (c.hint) disposeSprite(c.hint);
    }
    this.controllers = [];
    this.clearNotes();
    this.hide(null);
    this.dropDraw();
    this.rays = null;
    scene.add(model);
    for (const o of this.culled) o.frustumCulled = true;
    this.culled = [];
    this.zup.remove(this.ground);
    this.rig.remove(this.floor);
    this.inspecting = false;
    this.grabs = {};
    this.two = null;
    this.spin = false;
    this.hold.position.set(0, 0, 0);
    this.hold.quaternion.identity();
    this.hold.scale.setScalar(1);
    scene.remove(this.rig, this.lights, this.target, this.vignette, this.pointer, this.menu.mesh);
    this.menuOpen = false;
    this.dollhouse = null;
    this.rig.scale.setScalar(1);
    if (this.toast) scene.remove(this.toast);
    for (const { obj, visible } of this.put) obj.visible = visible;
    const hemi = scene.children.find((o) => (o as THREE.HemisphereLight).isHemisphereLight);
    if (hemi) hemi.position.copy(this.hemiAt);
    scene.background = this.background;
    this.session = null;
    this.host.onChange(false);
    if (pins.length || moves.length) this.host.onDone(pins, moves);
    this.host.render();
  }

  /** Everything drawn for notes, gone (leaving VR). */
  private clearNotes(): void {
    for (const p of this.placed.values()) {
      p.ghost.geometry.dispose();
      p.ghost.removeFromParent();
    }
    this.placed.clear();
    for (const objs of this.pinObjs.values()) for (const o of objs) o.removeFromParent();
    this.pinObjs.clear();
    for (const m of this.measures) for (const o of m.objs) o.removeFromParent();
    this.measures = [];
    if (this.measuring) for (const o of [this.measuring.marker, ...this.measuring.live]) o.removeFromParent();
    this.measuring = null;
    this.faceFirst = null;
    this.clearFaceHover();
    this.pins = [];
    this.undo = [];
    this.carry = null;
    this.turning = null;
    this.selected.clear();
    this.hiddenGroups.clear();
    this.placeGizmo();
  }

  /** The rig placed so the start is under your feet, facing its way. */
  private goStart(): void {
    this.dollhouse = null;
    this.rig.scale.setScalar(1);
    const { rotY, position } = rigFor(this.startNow);
    this.rig.rotation.set(0, rotY, 0);
    this.rig.position.copy(position);
  }

  private addControllers(): void {
    const { renderer, scene } = this.host;
    for (let i = 0; i < 2; i++) {
      const grip = renderer.xr.getController(i);
      const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
      ray.scale.z = 0.6;
      const arc = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x4fc3f7 }));
      arc.frustumCulled = false;
      arc.visible = false;
      const knob = new THREE.Mesh(new THREE.ConeGeometry(0.015, 0.06, 12).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x2a2d33 }));
      grip.add(ray, knob);
      scene.add(grip, arc);
      const c: Controller = { grip, ray, arc, hand: i === 0 ? "left" : "right" };
      grip.addEventListener("connected", (e) => {
        const h = (e as unknown as { data: XRInputSource }).data.handedness;
        if (h === "left" || h === "right") c.hand = h;
        this.hintFor(c);
      });
      this.controllers.push(c);
      this.hintFor(c);
    }
  }

  /** A word above the hand: what its trigger does now. */
  private hintFor(c: Controller): void {
    if (c.hint) {
      c.hint.removeFromParent();
      disposeSprite(c.hint);
    }
    const tool = this.tool === "pin" ? `Pin: ${PIN_WORDS[this.pinTag]}` : this.tool === "measure" ? `Measure ${this.measureMode}` : this.tool[0].toUpperCase() + this.tool.slice(1);
    const words = this.inspecting
      ? c.hand === "left"
        ? "Grip holds · X menu"
        : this.menuOpen
          ? "Point and click"
          : `${tool} · grip holds · A 1:1`
      : c.hand === "left"
        ? "Teleport · X menu"
        : this.menuOpen
          ? "Point and click"
          : `${tool} · A undo`;
    c.hint = textSprite(words, 0.11, { size: 40 });
    c.hint.position.set(0, 0.05, 0.02);
    c.grip.add(c.hint);
  }

  private controller(hand: "left" | "right"): Controller | undefined {
    return this.controllers.find((c) => c.hand === hand);
  }

  /** What else rays land on besides the model (whose triangles go through the ray tree): what was moved, the handles, the lawn unless `noGround`. */
  private targets(noGround = false): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const p of this.placed.values()) if (p.ghost.visible) out.push(p.ghost);
    return noGround ? out : [...out, this.inspecting ? this.floor.children[0] : this.ground];
  }

  /** The ray tree for the view on screen (built when the view changes). */
  private rayTree(): { index: RayIndex; skip: Uint8Array; faceOf: Int32Array } | null {
    const view = this.host.view();
    if (!view?.mesh) return null;
    if (this.rays?.view !== view) {
      const index = new RayIndex(view.mesh.positions, view.mesh.indices);
      // Each triangle's face, for the Faces measure.
      const faceOf = new Int32Array(index.triangles).fill(-1);
      view.mesh.faceRanges.forEach((r, f) => faceOf.fill(f, r.start / 3, (r.start + r.count) / 3));
      this.rays = { view, index, skip: new Uint8Array(index.triangles), faceOf };
      this.markHidden(this.hiddenNow);
    }
    return this.rays;
  }

  /** The nearest thing a ray (world, unit direction) meets within `far` (m): the model, through its tree, or anything else. */
  private rayHit(o: THREE.Vector3, d: THREE.Vector3, far: number, noGround = false, near = 0): THREE.Intersection | null {
    let best: THREE.Intersection | null = null;
    const m = this.host.mesh();
    const tree = m ? this.rayTree() : null;
    if (m && tree) {
      m.updateWorldMatrix(true, false);
      const inv = new THREE.Matrix4().copy(m.matrixWorld).invert();
      const lo = o.clone().applyMatrix4(inv);
      const le = o.clone().addScaledVector(d, far).applyMatrix4(inv);
      const ld = le.clone().sub(lo);
      const h = tree.index.cast([lo.x, lo.y, lo.z], [ld.x, ld.y, ld.z], 1, tree.skip);
      if (h && h.t * far >= near) {
        const I = this.rays!.view.mesh!.indices;
        const face = { a: I[h.tri * 3], b: I[h.tri * 3 + 1], c: I[h.tri * 3 + 2], normal: new THREE.Vector3(...h.normal), materialIndex: 0 };
        best = { distance: h.t * far, point: o.clone().addScaledVector(d, h.t * far), object: m, face, faceIndex: h.tri } as THREE.Intersection;
      }
    }
    const others = this.targets(noGround);
    if (others.length) {
      const ray = new THREE.Raycaster(o, d, near, best ? best.distance : far);
      const h = ray.intersectObjects(others, false)[0];
      if (h && (!best || h.distance < best.distance)) best = h;
    }
    return best;
  }

  /** A controller's straight ray into the model: the nearest hit. */
  private cast(c: Controller, noGround = false): THREE.Intersection | null {
    const o = new THREE.Vector3().setFromMatrixPosition(c.grip.matrixWorld);
    const d = new THREE.Vector3(0, 0, -1).transformDirection(c.grip.matrixWorld);
    return this.rayHit(o, d, 60, noGround, 0.01);
  }

  /** A world point in the model's frame (mm, Z up). */
  private toModel(p: THREE.Vector3): Vec3 {
    const q = this.zup.worldToLocal(p.clone());
    return [q.x, q.y, q.z];
  }

  /** The teleport arc from a controller: a throw under gravity, and the floor it lands on (null: not a floor). */
  private aim(c: Controller): THREE.Vector3[] {
    const o = new THREE.Vector3().setFromMatrixPosition(c.grip.matrixWorld);
    const d = new THREE.Vector3(0, 0, -1).transformDirection(c.grip.matrixWorld);
    const small = !!this.dollhouse;
    // In the dollhouse, a straight ray: the model is small and close.
    const v = d.multiplyScalar(small ? 40 : 7);
    const g = small ? 0 : 9.8;
    const pts = [o.clone()];
    this.hit = null;
    let p = o.clone();
    for (let k = 0; k < 60; k++) {
      const dt = 0.03;
      const q = p.clone().add(v.clone().multiplyScalar(dt));
      v.y -= g * dt;
      const seg = q.clone().sub(p);
      const h = this.rayHit(p, seg.clone().normalize(), seg.length(), small);
      if (h) {
        pts.push(h.point.clone());
        const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : UP;
        if (Math.abs(n.dot(UP)) > 0.7 && (small || h.point.y < o.y + 0.5)) this.hit = h.point.clone();
        break;
      }
      pts.push(q);
      p = q;
    }
    return pts;
  }

  private teleport(): void {
    const t = this.hit;
    if (!t) return;
    if (this.dollhouse) {
      // From the dollhouse: stand at the spot pointed at, full size, facing the way the model faces you now.
      const at = this.toModel(t);
      this.dollhouse = null;
      this.rig.scale.setScalar(1);
      this.rig.updateMatrixWorld(true);
      const head = this.head();
      const p = toXr(at).applyAxisAngle(UP, this.rig.rotation.y);
      this.rig.position.set(head.x - p.x, -p.y, head.z - p.z);
      this.say("Full size");
      return;
    }
    const head = this.head();
    // The world moves so the spot is under your head, its floor where your feet are.
    this.rig.position.add(new THREE.Vector3(head.x - t.x, -t.y, head.z - t.z));
  }

  /** The way the head faces, about the vertical (radians, 0 = -Z). */
  private headYaw(): number {
    const cam = this.host.renderer.xr.getCamera();
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    return Math.atan2(-f.x, -f.z);
  }

  private head(): THREE.Vector3 {
    const cam = this.host.renderer.xr.getCamera();
    return new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  }

  private pulse(hand: "left" | "right", v = 0.4, ms = 40): void {
    const src = this.session ? [...this.session.inputSources].find((s) => s.handedness === hand) : undefined;
    const act = (src?.gamepad as unknown as { hapticActuators?: { pulse(v: number, ms: number): void }[] } | undefined)?.hapticActuators?.[0];
    act?.pulse(v, ms);
  }

  /** A word in front of you for a moment ("Roof off"). */
  private say(text: string): void {
    if (this.toast) {
      this.host.scene.remove(this.toast);
      disposeSprite(this.toast);
    }
    this.toast = textSprite(text, 0.42);
    this.host.scene.add(this.toast);
    this.toastUntil = performance.now() + 1800;
  }

  private setRoof(off: boolean): void {
    this.roofOff = off;
    this.host.renderer.clippingPlanes = off ? [new THREE.Plane(new THREE.Vector3(0, -1, 0), this.host.prefs().cutAbove / 1000)] : [];
    this.say(off ? "Roof off" : "Roof on");
  }

  // ------------------------------------------------------------------ furniture

  /** An item moved (in total) and turned about its middle: its copy drawn there, the original hidden. */
  private place(item: VrItem, move: Vec3, turn: number, base?: { move: Vec3; turn: number }, centre?: Vec3): Placed {
    let p = this.placed.get(item.key);
    if (!p) {
      const view = this.host.view()!;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(itemTriangles(view, item), 3));
      g.computeVertexNormals();
      const ghost = new THREE.Mesh(g, this.materialOf(item));
      ghost.matrixAutoUpdate = false;
      ghost.frustumCulled = false;
      ghost.userData.item = item.key;
      this.notesGroup.add(ghost);
      p = { item, move: [0, 0, 0], turn: 0, base: base ?? { move: [0, 0, 0], turn: 0 }, centre: centre ?? centreOf(item), ghost };
      this.placed.set(item.key, p);
    }
    p.move = move;
    p.turn = turn;
    const c = new THREE.Vector3(...p.centre);
    p.ghost.matrix
      .makeTranslation(c.x + move[0], c.y + move[1], c.z + move[2])
      .multiply(new THREE.Matrix4().makeRotationZ((turn * Math.PI) / 180))
      .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
    p.ghost.matrixWorldNeedsUpdate = true;
    return p;
  }

  /** The material the model draws an item's first face with. */
  private materialOf(item: VrItem): THREE.Material {
    const mesh = this.host.mesh();
    const view = this.host.view();
    const mats = mesh ? [mesh.material].flat() : [];
    const r = view?.mesh?.faceRanges[item.faces[0]];
    const g = mesh && r ? mesh.geometry.groups.find((gr) => r.start >= gr.start && r.start < gr.start + gr.count) : undefined;
    return (g ? mats[g.materialIndex ?? 0] : mats[0]) ?? new THREE.MeshLambertMaterial({ color: 0x999999 });
  }

  private applyHidden(): void {
    // The model's own drawing of what was moved (its copy is drawn instead), and everything hidden from the list.
    const faces = [...this.placed.values()].flatMap((p) => p.item.faces);
    for (const it of this.items) if (this.hiddenGroups.has(it.body)) faces.push(...it.faces);
    for (const p of this.placed.values()) p.ghost.visible = !this.hiddenGroups.has(p.item.body);
    this.hide(faces.length ? faces : null);
  }

  /** What the show / hide list lists: the components of an assembly, or the bodies of a part, by name. */
  private showList(): string[] {
    return [...new Set(this.items.map((it) => it.body))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  private toggleShown(name: string): void {
    if (this.hiddenGroups.has(name)) this.hiddenGroups.delete(name);
    else this.hiddenGroups.add(name);
    // Something hidden can't stay picked.
    for (const k of [...this.selected]) if (this.hiddenGroups.has(this.placed.get(k)?.item.body ?? "")) this.selected.delete(k);
    this.applyHidden();
    this.paintSelection();
    this.placeGizmo();
  }

  /** The movable item a ray hits (the model's own mesh, or a moved copy). */
  private itemAt(h: THREE.Intersection | null): VrItem | null {
    if (!h) return null;
    if (h.object.userData.item) return this.placed.get(h.object.userData.item as string)?.item ?? null;
    if (h.object !== this.host.mesh() || h.faceIndex === undefined || h.faceIndex === null) return null;
    const view = this.host.view();
    if (!view?.mesh) return null;
    const tri = h.faceIndex * 3;
    const face = view.mesh.faceRanges.findIndex((r) => tri >= r.start && tri < r.start + r.count);
    const it = face >= 0 ? itemOfFace(this.items, face) : null;
    return it?.movable ? it : null;
  }

  // Picking: the trigger on a piece selects it (green) or, selected, lets it go; the selection is a group.
  private toggleSelect(hand: "left" | "right"): void {
    const c = this.controller(hand);
    if (!c) return;
    const h = this.cast(c, true);
    const it = this.itemAt(h);
    if (!it) return void this.say(this.selected.size ? (h ? "Only furniture moves · click a green piece to let it go" : "Point at a piece of furniture") : h ? "Only furniture moves" : "Point at a piece of furniture");
    if (this.selected.has(it.key)) this.selected.delete(it.key);
    else {
      if (!this.placed.has(it.key)) {
        this.place(it, [0, 0, 0], 0);
        this.applyHidden();
      }
      this.selected.add(it.key);
    }
    this.paintSelection();
    this.placeGizmo();
    this.pulse(hand, 0.4, 25);
    const n = this.selected.size;
    this.say(n ? `${n === 1 ? niceName([...this.selected].map((k) => this.placed.get(k)!.item).map((i) => i.partBody ?? i.body)[0]) : `${n} pieces`} selected · grip moves · handles turn ${TURN_STEP}°` : "Nothing selected");
  }

  /** The selected pieces drawn green; the others as they are. */
  private paintSelection(): void {
    for (const [key, p] of this.placed) {
      if (p.ghost.userData.own === undefined) p.ghost.userData.own = p.ghost.material;
      p.ghost.material = this.selected.has(key) ? this.greenMat : (p.ghost.userData.own as THREE.Material);
    }
  }

  private starts(): Starts {
    const out: Starts = new Map();
    for (const k of this.selected) {
      const p = this.placed.get(k);
      if (p) out.set(k, { move: [...p.move] as Vec3, turn: p.turn });
    }
    return out;
  }

  /** The selection's middle now, and the floor it stands on (the lowest of its pieces), in the model's frame. */
  private selectionFrame(): { centre: Vec3; floor: number; reach: number } | null {
    const ps = [...this.selected].map((k) => this.placed.get(k)).filter((p): p is Placed => !!p);
    if (!ps.length) return null;
    const at = ps.map((p) => [p.centre[0] + p.move[0], p.centre[1] + p.move[1]]);
    const centre: Vec3 = [at.reduce((a, q) => a + q[0], 0) / at.length, at.reduce((a, q) => a + q[1], 0) / at.length, 0];
    const floor = Math.min(...ps.map((p) => p.item.min[2] + p.move[2]));
    centre[2] = floor;
    const reach = Math.max(...ps.map((p, i) => Math.hypot(at[i][0] - centre[0], at[i][1] - centre[1]) + Math.hypot(p.item.max[0] - p.item.min[0], p.item.max[1] - p.item.min[1]) / 2));
    return { centre, floor, reach };
  }

  /** The turn handles put round the selection: a ring on its floor and a knob each way, on the sides you see. */
  private placeGizmo(): void {
    for (const o of [...this.gizmo.children]) {
      o.removeFromParent();
      if ((o as THREE.Sprite).isSprite) disposeSprite(o as THREE.Sprite);
      else (o as THREE.Mesh).geometry?.dispose();
    }
    const f = this.selectionFrame();
    if (!f) {
      this.gizmo.removeFromParent();
      return;
    }
    const r = f.reach + 150;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 10, 8, 96), new THREE.MeshBasicMaterial({ color: SELECTED, transparent: true, opacity: 0.8, depthTest: false }));
    ring.renderOrder = 30;
    this.gizmo.add(ring);
    // The knobs square to where you look from, so both are in front of you.
    const head = this.toModel(this.head());
    const look = Math.atan2(head[1] - f.centre[1], head[0] - f.centre[0]);
    for (const dir of [1, -1] as const) {
      const a = look - dir * (Math.PI / 2.6);
      const knob = new THREE.Mesh(new THREE.SphereGeometry(70, 16, 12), new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: SELECTED, emissiveIntensity: 0.6, depthTest: false }));
      knob.renderOrder = 31;
      knob.position.set(Math.cos(a) * r, Math.sin(a) * r, 0);
      knob.userData.turn = dir;
      const label = textSprite(dir > 0 ? `⟲ ${TURN_STEP}°` : `⟳ ${TURN_STEP}°`, 260);
      label.position.set(Math.cos(a) * r, Math.sin(a) * r, 190);
      this.gizmo.add(knob, label);
    }
    this.gizmo.position.set(f.centre[0], f.centre[1], f.floor + 20);
    if (!this.gizmo.parent) this.notesGroup.add(this.gizmo);
  }

  /** The turn handle a controller points at (+1 anticlockwise, −1 clockwise), if any. */
  private handleAt(c: Controller): 1 | -1 | null {
    if (!this.gizmo.parent || !this.selected.size) return null;
    const o = new THREE.Vector3().setFromMatrixPosition(c.grip.matrixWorld);
    const d = new THREE.Vector3(0, 0, -1).transformDirection(c.grip.matrixWorld);
    const knobs = this.gizmo.children.filter((k) => k.userData.turn !== undefined);
    const h = new THREE.Raycaster(o, d, 0, 60).intersectObjects(knobs, false)[0];
    return h ? (h.object.userData.turn as 1 | -1) : null;
  }

  /** Where a controller's ray meets the level `z` (model frame), or null. */
  private onLevel(c: Controller, z: number): Vec3 | null {
    const o = new THREE.Vector3().setFromMatrixPosition(c.grip.matrixWorld);
    const d = new THREE.Vector3(0, 0, -1).transformDirection(c.grip.matrixWorld);
    const lvl = this.zup.localToWorld(new THREE.Vector3(0, 0, z));
    if (Math.abs(d.y) < 1e-4) return null;
    const t = (lvl.y - o.y) / d.y;
    if (t <= 0 || t > 40) return null;
    return this.toModel(o.add(d.multiplyScalar(t)));
  }

  /** The selection turned by `deg` about `centre` from where each piece was (`starts`). */
  private turnSelection(starts: Starts, centre: Vec3, deg: number): void {
    const a = (deg * Math.PI) / 180;
    for (const [k, st] of starts) {
      const p = this.placed.get(k);
      if (!p) continue;
      const x = p.centre[0] + st.move[0] - centre[0];
      const y = p.centre[1] + st.move[1] - centre[1];
      const nx = centre[0] + x * Math.cos(a) - y * Math.sin(a);
      const ny = centre[1] + x * Math.sin(a) + y * Math.cos(a);
      this.place(p.item, [Math.round(nx - p.centre[0]), Math.round(ny - p.centre[1]), st.move[2]], st.turn + deg);
    }
  }

  private startTurn(hand: "left" | "right", dir: 1 | -1): void {
    const c = this.controller(hand);
    const f = this.selectionFrame();
    if (!c || !f) return;
    const q = this.onLevel(c, f.floor) ?? f.centre;
    this.turning = { hand, dir, a0: Math.atan2(q[1] - f.centre[1], q[0] - f.centre[0]), centre: f.centre, starts: this.starts(), by: 0, swept: false };
    this.pulse(hand, 0.4, 20);
  }

  /** Turning: the knob swept round the ring turns the selection with it, in 10° steps. */
  private dragTurn(): void {
    const tn = this.turning;
    const c = tn && this.controller(tn.hand);
    if (!tn || !c) return;
    const q = this.onLevel(c, tn.centre[2]);
    if (!q) return;
    let da = ((Math.atan2(q[1] - tn.centre[1], q[0] - tn.centre[0]) - tn.a0) * 180) / Math.PI;
    da = ((da + 540) % 360) - 180;
    const by = Math.round(da / TURN_STEP) * TURN_STEP;
    if (by !== 0) tn.swept = true;
    if (by !== tn.by) {
      tn.by = by;
      this.turnSelection(tn.starts, tn.centre, by);
      this.gizmo.rotation.z = (by * Math.PI) / 180;
      this.pulse(tn.hand, 0.25, 12);
    }
  }

  private endTurn(): void {
    const tn = this.turning;
    if (!tn) return;
    this.turning = null;
    // A click on a knob (no sweep): one step its way.
    if (!tn.swept) this.turnSelection(tn.starts, tn.centre, tn.dir * TURN_STEP);
    this.gizmo.rotation.z = 0;
    const by = tn.swept ? tn.by : tn.dir * TURN_STEP;
    if (by) {
      this.undo.push({ kind: "move", was: tn.starts });
      this.say(`Turned ${by > 0 ? `${by}° anticlockwise` : `${-by}° clockwise`}`);
    }
    this.placeGizmo();
  }

  /** A grip: carry the selection (or, with nothing selected, the piece pointed at, selected first). */
  private grab(hand: "left" | "right"): void {
    const c = this.controller(hand);
    if (!c || this.carry || this.turning) return;
    if (!this.selected.size) {
      const it = this.itemAt(this.cast(c, true));
      if (!it) return void this.say("Point at a piece of furniture, or click pieces with the trigger first");
      if (!this.placed.has(it.key)) this.place(it, [0, 0, 0], 0);
      this.applyHidden();
      this.selected.add(it.key);
      this.paintSelection();
      this.placeGizmo();
    }
    const f = this.selectionFrame()!;
    const at = this.onLevel(c, f.floor) ?? f.centre;
    this.carry = { key: [...this.selected][0], hand, grab: at, height: f.floor, starts: this.starts() };
    this.pulse(hand, 0.5, 30);
  }

  /** Carrying: the selection slides along the floor it stands on, following where the ray meets that floor (10 mm steps). */
  private drag(): void {
    if (!this.carry) return;
    const c = this.controller(this.carry.hand);
    if (!c) return;
    const q = this.onLevel(c, this.carry.height);
    if (!q) return;
    const dm = [Math.round((q[0] - this.carry.grab[0]) / 10) * 10, Math.round((q[1] - this.carry.grab[1]) / 10) * 10];
    for (const [k, st] of this.carry.starts) {
      const p = this.placed.get(k);
      if (p) this.place(p.item, [st.move[0] + dm[0], st.move[1] + dm[1], st.move[2]], p.turn);
    }
    const f = this.selectionFrame();
    if (f) this.gizmo.position.set(f.centre[0], f.centre[1], f.floor + 20);
  }

  private drop(): void {
    if (!this.carry) return;
    const first = this.carry.starts.get(this.carry.key);
    const p = this.placed.get(this.carry.key);
    if (p && first) {
      this.undo.push({ kind: "move", was: this.carry.starts });
      const moved = Math.hypot(p.move[0] - first.move[0], p.move[1] - first.move[1]);
      const turned = p.turn - first.turn;
      const what = this.carry.starts.size > 1 ? `${this.carry.starts.size} pieces` : niceName(p.item.partBody ?? p.item.body);
      if (moved > 5 || turned) this.say(`${what}: moved ${lengthText(moved)}${turned ? `, turned ${Math.round(turned)}°` : ""}`);
    }
    this.pulse(this.carry.hand, 0.3, 20);
    this.carry = null;
    this.placeGizmo();
  }

  /** The stick while carrying: the selection turned 10° about its middle. */
  private stickTurn(deg: number): void {
    const f = this.selectionFrame();
    if (!f || !this.carry) return;
    this.turnSelection(this.starts(), f.centre, deg);
    // Carrying on from here.
    const c = this.controller(this.carry.hand);
    const at = c ? this.onLevel(c, this.carry.height) : null;
    this.carry.starts = new Map([...this.carry.starts].map(([k]) => [k, { move: [...this.placed.get(k)!.move] as Vec3, turn: this.placed.get(k)!.turn }]));
    if (at) this.carry.grab = at;
  }

  // ------------------------------------------------------------------ measure and pins

  /** Where a ray meets the model for a measure: snapped to a corner or edge when snapping is on. */
  private measurePoint(c: Controller): Vec3 | null {
    const h = this.cast(c);
    if (!h) return null;
    const at = this.toModel(h.point);
    if (!this.snap || !h.face || h.object === this.ground || h.object === this.floor.children[0]) return at.map((v) => Math.round(v)) as Vec3;
    const pos = (h.object as THREE.Mesh).geometry.getAttribute("position");
    const corner = (i: number): Vec3 => {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(h.object.matrixWorld);
      return this.toModel(v);
    };
    // Held small or large, the snap reaches as far as it looks: about a centimetre and a half of what you see.
    const k = this.inspecting ? this.heldPose().scale : 1;
    const reach = this.inspecting ? { corner: 15 / k, edge: 10 / k } : undefined;
    return snapPoint(at, [corner(h.face.a), corner(h.face.b), corner(h.face.c)], reach).at;
  }

  private dot(at: Vec3, color = 0xffd400): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.SphereGeometry(18, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
    m.position.set(...at);
    m.renderOrder = 34;
    this.notesGroup.add(this.sized(m));
    return m;
  }

  /** A dimension: the line, its ends and its length. */
  private dimension(a: Vec3, b: Vec3, text?: string): THREE.Object3D[] {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]), new THREE.LineBasicMaterial({ color: 0xffd400, depthTest: false }));
    line.renderOrder = 33;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const words = text ?? lengthText(len);
    const label = textSprite(words, Math.max(160, 15 * words.length), { bg: "rgba(255,212,0,0.92)", fg: "#111" });
    label.userData.card = true;
    label.material.depthTest = false;
    label.renderOrder = 37;
    label.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 + 60 * this.noteScale());
    this.notesGroup.add(line, this.sized(label));
    return [line, label, this.dot(a), this.dot(b)];
  }

  private measureDown(c: Controller): void {
    const at = this.measurePoint(c);
    if (!at) return;
    if (!this.measuring) this.measuring = { a: at, marker: this.dot(at), live: [], pressedAt: performance.now() };
    else this.finishMeasure(at);
    this.pulse(c.hand, 0.2, 15);
  }

  /** Let go: a held trigger draws a tape from where it was pressed to here; a click waits for the second point. */
  private measureUp(c: Controller): void {
    if (!this.measuring) return;
    const at = this.measurePoint(c);
    const held = performance.now() - this.measuring.pressedAt > 350;
    if (held && at && Math.hypot(at[0] - this.measuring.a[0], at[1] - this.measuring.a[1], at[2] - this.measuring.a[2]) > 20) this.finishMeasure(at);
  }

  private finishMeasure(b: Vec3): void {
    const m = this.measuring!;
    for (const o of [m.marker, ...m.live]) o.removeFromParent();
    this.measuring = null;
    if (Math.hypot(b[0] - m.a[0], b[1] - m.a[1], b[2] - m.a[2]) < 1) return;
    this.measures.push({ a: m.a, b, objs: this.dimension(m.a, b) });
    this.undo.push({ kind: "measure" });
  }

  /** While a measure is started: the line to where you point, with its length. */
  private liveMeasure(c: Controller): void {
    if (!this.measuring) return;
    for (const o of this.measuring.live) o.removeFromParent();
    const at = this.measurePoint(c);
    this.measuring.live = at ? this.dimension(this.measuring.a, at) : [];
  }

  // Faces: point at a face to see what it is; click it, then another, for what they are to each other.

  /** The face of the model a controller points at, and where (model mm); null on nothing, the lawn or a moved piece. */
  private faceAt(c: Controller): { index: number; face: FaceInfo; at: Vec3 } | { moved: true } | null {
    const h = this.cast(c, true);
    if (!h) return null;
    if (h.object.userData.item) return { moved: true };
    const view = this.host.view();
    const tri = h.faceIndex;
    const f = this.rays && h.object === this.host.mesh() && tri !== undefined && tri !== null ? this.rays.faceOf[tri] : -1;
    if (!view || f < 0 || !view.faces[f]) return null;
    return { index: f, face: view.faces[f], at: this.toModel(h.point) };
  }

  /** A face lit up: its triangles drawn over it in a see-through colour. */
  private faceGlow(index: number, color: number, opacity: number): THREE.Mesh | null {
    const view = this.host.view();
    if (!view?.mesh) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(itemTriangles(view, { faces: [index] } as VrItem), 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
    m.renderOrder = 32;
    m.frustumCulled = false;
    this.notesGroup.add(m);
    return m;
  }

  /** A card of what was measured, above a point. */
  private faceCardSprite(card: FaceCard, at: Vec3, bg = "rgba(255,212,0,0.94)"): THREE.Sprite {
    const text = [card.title, ...card.lines];
    // As wide as its longest line needs, so a long line doesn't shrink the writing.
    const label = textSprite(text.join("\n"), Math.max(260, 13 * Math.max(...text.map((l) => l.length))), { bg, fg: "#111", size: 44 });
    label.position.set(at[0], at[1], at[2] + 160 * this.noteScale());
    label.userData.card = true;
    label.material.depthTest = false;
    label.renderOrder = 37;
    this.notesGroup.add(this.sized(label));
    return label;
  }

  private clearFaceHover(): void {
    if (!this.faceHover) return;
    for (const o of [...this.faceHover.objs, this.faceHover.label]) {
      o.removeFromParent();
      if ((o as THREE.Sprite).isSprite) disposeSprite(o as THREE.Sprite);
      else (o as THREE.Mesh).geometry?.dispose();
    }
    this.faceHover = null;
  }

  /** While measuring faces: the face pointed at lit up, labelled with what it is, or what it is to the first face picked. */
  private hoverFace(c: Controller): void {
    const f = this.faceAt(c);
    if (!f || "moved" in f) return this.clearFaceHover();
    if (this.faceHover?.index !== f.index) {
      this.clearFaceHover();
      const first = this.faceFirst;
      const view = this.host.view();
      const text = first && first.index !== f.index && view?.mesh ? `${pairCard(first, f, meshClosest(view.mesh, { kind: "face", index: first.index }, { kind: "face", index: f.index })).title} · click` : faceName(f.face);
      const glow = this.faceGlow(f.index, 0x4fc3f7, 0.3);
      const label = textSprite(text, 300, { bg: "rgba(79,195,247,0.92)", fg: "#111" });
      label.renderOrder = 38;
      label.material.depthTest = false;
      label.userData.card = true;
      this.notesGroup.add(this.sized(label));
      this.faceHover = { index: f.index, objs: glow ? [glow] : [], label, text };
    }
    this.faceHover.label.position.set(f.at[0], f.at[1], f.at[2] + 90 * this.noteScale());
  }

  /** A click on a face: the first is measured on its own (and waits for a second); the second measures the two together. */
  private pickFace(c: Controller): void {
    const f = this.faceAt(c);
    if (!f) return;
    if ("moved" in f) return void this.say("A moved piece: measure it with Points");
    const view = this.host.view()!;
    const first = this.faceFirst;
    this.pulse(c.hand, 0.25, 15);
    if (!first || first.index === f.index) {
      if (first) {
        // The same face again: done with it; the next click starts afresh.
        this.faceFirst = null;
        return void this.say("Now click a face to start again");
      }
      const card = faceCard(f.face);
      const glow = this.faceGlow(f.index, 0xffd400, 0.4);
      const sprite = this.faceCardSprite(card, f.at);
      this.measures.push({ a: f.at, b: f.at, objs: [...(glow ? [glow] : []), sprite], text: card.title });
      this.undo.push({ kind: "measure" });
      this.faceFirst = { index: f.index, face: f.face };
      this.clearFaceHover();
      return;
    }
    // The second: the first's card gives way to the two together, with the dimension drawn.
    const closest = view.mesh ? meshClosest(view.mesh, { kind: "face", index: first.index }, { kind: "face", index: f.index }) : null;
    const card = pairCard(first, { index: f.index, face: f.face }, closest);
    const m = this.measures.at(-1)!;
    const old = m.objs.find((o) => (o as THREE.Sprite).isSprite);
    if (old) {
      old.removeFromParent();
      disposeSprite(old as THREE.Sprite);
    }
    const glow = this.faceGlow(f.index, 0xffd400, 0.4);
    const objs = m.objs.filter((o) => o !== old);
    if (glow) objs.push(glow);
    let at = f.at;
    if (card.line) {
      objs.push(...this.dimension(card.line.from, card.line.to, card.line.label));
      at = card.line.from.map((v, i) => (v + card.line!.to[i]) / 2) as Vec3;
      m.a = card.line.from;
      m.b = card.line.to;
    }
    objs.push(this.faceCardSprite(card, [at[0], at[1], at[2] + 120 * this.noteScale()]));
    m.objs = objs;
    m.text = card.title;
    this.faceFirst = null;
    this.clearFaceHover();
    this.say(card.title);
  }

  private drawPin(p: VrPin): void {
    const color = PIN_COLORS[p.tag];
    // One group at the point, so a held part's pins can be sized as one (see sized).
    const g = new THREE.Group();
    g.position.set(...p.at);
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 450, 8).rotateX(Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x444444 }));
    stick.position.set(0, 0, 225);
    const head = new THREE.Mesh(new THREE.SphereGeometry(55, 16, 12), new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.35 }));
    head.position.set(0, 0, 470);
    const label = textSprite(p.text ? `${PIN_WORDS[p.tag]}\n${p.text}` : PIN_WORDS[p.tag], 380, { bg: `#${color.toString(16).padStart(6, "0")}ee` });
    label.position.set(0, 0, 640);
    g.add(stick, head, label);
    this.notesGroup.add(this.sized(g));
    this.pinObjs.set(p.id, [g]);
  }

  private dropPin(c: Controller): void {
    const h = this.cast(c);
    if (!h) return;
    const pin: VrPin = { id: newId("pin"), at: this.toModel(h.point).map((v) => Math.round(v)) as Vec3, tag: this.pinTag, made: stamp() };
    this.pins.push(pin);
    this.drawPin(pin);
    this.undo.push({ kind: "pin", id: pin.id });
    this.say(`Pinned: ${PIN_WORDS[pin.tag]}`);
    this.pulse(c.hand, 0.4, 30);
  }

  private undoLast(): void {
    const u = this.undo.pop();
    if (!u) return void this.say("Nothing to undo");
    if (u.kind === "pin") {
      this.pins = this.pins.filter((p) => p.id !== u.id);
      for (const o of this.pinObjs.get(u.id) ?? []) o.removeFromParent();
      this.pinObjs.delete(u.id);
      this.say("Pin taken back");
    } else if (u.kind === "measure") {
      const m = this.measures.pop();
      for (const o of m?.objs ?? []) o.removeFromParent();
      this.faceFirst = null;
      this.say("Measure taken back");
    } else {
      for (const [k, w] of u.was) {
        const p = this.placed.get(k);
        if (p) this.place(p.item, w.move, w.turn);
      }
      this.placeGizmo();
      this.say("Move taken back");
    }
  }

  /** Teleport to the next pin (dropped now or before), standing a metre short of it. */
  private nextPin(): void {
    const all = [...this.host.notes().pins, ...this.pins];
    if (!all.length) return void this.say("No pins yet");
    this.pinCursor = (this.pinCursor + 1) % all.length;
    const p = all[this.pinCursor];
    this.dollhouse = null;
    this.rig.scale.setScalar(1);
    const head = this.head();
    const yaw = this.rig.rotation.y;
    const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(UP, this.headYaw());
    const target = toXr(p.at).applyAxisAngle(UP, yaw).sub(fwd.multiplyScalar(1));
    this.rig.position.set(head.x - target.x, -target.y, head.z - target.z);
    this.say(`${PIN_WORDS[p.tag]}${p.text ? `: ${p.text}` : ""} (${this.pinCursor + 1} of ${all.length})`);
  }

  // ------------------------------------------------------------------ inspecting a part

  /** How big notes (dots, lengths, pins) are drawn: as made for walking about a house, or a hand's size whatever the held part's scale. */
  private noteScale(): number {
    return this.inspecting ? 0.25 / this.heldPose().scale : 1;
  }
  /** A note's own size remembered, then drawn at the note scale (again each frame: see sizeNotes). */
  private sized<T extends THREE.Object3D>(o: T): T {
    o.userData.base = o.scale.clone();
    o.scale.multiplyScalar(this.noteScale());
    return o;
  }
  /** Measure cards keep a readable size however far away they are: as big as at 1.5 m, at least. */
  private sizeCards(): void {
    const head = this.head();
    const f = this.noteScale();
    const p = new THREE.Vector3();
    for (const o of this.notesGroup.children) {
      const base = o.userData.base as THREE.Vector3 | undefined;
      if (!o.userData.card || !base) continue;
      const d = o.getWorldPosition(p).distanceTo(head) / (this.inspecting ? this.heldPose().scale : 1);
      o.scale.copy(base).multiplyScalar(f * Math.min(4, Math.max(1, d / 1.5)));
    }
  }
  private sizeNotes(): void {
    const f = this.noteScale();
    for (const o of this.notesGroup.children) {
      const base = o.userData.base as THREE.Vector3 | undefined;
      if (base) o.scale.copy(base).multiplyScalar(f);
    }
  }
  /** The part as held: where it is in the world, its turn, how big it is shown. */
  private heldPose(): HeldPose {
    this.hold.updateMatrixWorld(true);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    this.hold.matrixWorld.decompose(pos, quat, sc);
    return { pos, quat, scale: sc.x };
  }
  private setHeld(p: HeldPose): void {
    this.setHeldMatrix(new THREE.Matrix4().compose(p.pos, p.quat, new THREE.Vector3(p.scale, p.scale, p.scale)));
  }
  /** The part's place in the world (the holder's matrix there), set in the rig. */
  private setHeldMatrix(world: THREE.Matrix4): void {
    this.rig.updateMatrixWorld(true);
    new THREE.Matrix4().copy(this.rig.matrixWorld).invert().multiply(world).decompose(this.hold.position, this.hold.quaternion, this.hold.scale);
    this.hold.updateMatrixWorld(true);
  }
  /** The part's box in its own frame (mm). */
  private partBox(): THREE.Box3 {
    const mesh = this.host.mesh();
    const box = new THREE.Box3();
    if (mesh) {
      mesh.geometry.computeBoundingBox();
      box.copy(mesh.geometry.boundingBox!);
    }
    return box;
  }
  /** The part's middle, in the world. */
  private heldCentre(): THREE.Vector3 {
    this.hold.updateMatrixWorld(true);
    return this.zup.localToWorld(this.partBox().getCenter(new THREE.Vector3()));
  }
  /** The part in front of you, as it is drawn (Z up), its front to you, at its starting size (true size up to 1.2 m). */
  private bringBack(): void {
    const box = this.partBox();
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const s = startScale(Math.max(size.x, size.y, size.z));
    const span = (Math.max(size.x, size.y, size.z) / 1000) * s;
    const head = this.head();
    const yaw = this.headYaw();
    const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(UP, yaw);
    // Half a metre away (further for a big one), a little below your eyes, clear of the floor.
    const at = head.clone().addScaledVector(fwd, Math.max(0.45, span * 0.7 + 0.25));
    at.y = Math.max(head.y - 0.25, (size.z / 1000) * s * 0.5 + 0.1);
    const quat = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    const mid = toXr(box.getCenter(new THREE.Vector3()).toArray() as Vec3).multiplyScalar(s).applyQuaternion(quat);
    this.grabs = {};
    this.two = null;
    this.setHeld({ pos: at.sub(mid), quat, scale: s });
  }
  /** Back to true size, about its middle (where it is). */
  private oneToOne(): void {
    this.setHeld(scaledAbout(this.heldPose(), this.heldCentre(), 1));
    this.say("True size (1:1)");
  }
  /** Hold the part: the floor at your feet, the part in front of you. */
  private toInspect(announce = true): void {
    this.inspecting = true;
    this.zup.remove(this.ground);
    this.rig.add(this.floor);
    this.setRoof(false);
    this.dollhouse = null;
    this.rig.scale.setScalar(1);
    this.rig.position.set(0, 0, 0);
    this.rig.rotation.set(0, 0, 0);
    this.tool = "measure";
    this.needsPlace = true;
    this.sizeNotes();
    if (announce) this.say("Holding it: grip to pick it up");
  }
  /** Walk through it: at full size on its floor, at the start. */
  private toWalk(announce = true): void {
    this.inspecting = false;
    this.grabs = {};
    this.two = null;
    this.spin = false;
    this.hold.position.set(0, 0, 0);
    this.hold.quaternion.identity();
    this.hold.scale.setScalar(1);
    this.rig.remove(this.floor);
    this.zup.add(this.ground);
    if (this.tool === "measure" && announce) this.tool = "teleport";
    this.goStart();
    this.sizeNotes();
    if (announce) this.say("Walking: full size, at the start");
  }
  /** Is a hand within reach of the part (inside its box, give or take 5 cm)? */
  private handNear(c: Controller): boolean {
    const box = this.partBox();
    if (box.isEmpty()) return false;
    this.hold.updateMatrixWorld(true);
    const local = this.zup.worldToLocal(new THREE.Vector3().setFromMatrixPosition(c.grip.matrixWorld));
    return box.clone().expandByScalar(50 / this.heldPose().scale).containsPoint(local);
  }
  private handAt(hand: "left" | "right"): THREE.Vector3 {
    const c = this.controller(hand);
    return c ? new THREE.Vector3().setFromMatrixPosition(c.grip.matrixWorld) : new THREE.Vector3();
  }
  /** A grip pressed: the part taken by that hand (pointed at, or within reach), or by both. */
  private grabPart(hand: "left" | "right"): void {
    const c = this.controller(hand);
    if (!c) return;
    const other = hand === "left" ? "right" : "left";
    this.hold.updateMatrixWorld(true);
    const rel = new THREE.Matrix4().copy(c.grip.matrixWorld).invert().multiply(this.hold.matrixWorld);
    if (this.grabs[other]) {
      this.grabs[hand] = rel;
      this.two = { a0: this.handAt("left"), b0: this.handAt("right"), from: this.heldPose() };
      this.pulse(hand, 0.5, 30);
      return;
    }
    if (!this.cast(c, true) && !this.handNear(c)) return void this.say("Point at the part (or reach into it), then grip");
    this.grabs[hand] = rel;
    this.spin = false;
    this.pulse(hand, 0.5, 30);
  }
  /** A grip let go: the part stays where it is; the other hand, if it still holds, carries on alone. */
  private releasePart(hand: "left" | "right"): void {
    if (!this.grabs[hand]) return;
    delete this.grabs[hand];
    if (this.two) {
      const s = this.heldPose().scale;
      if (Math.abs(s - this.two.from.scale) > 0.01) this.say(`Shown ${scaleText(s)}: measures stay true size · A: 1:1`);
      this.two = null;
      const other = hand === "left" ? "right" : "left";
      const c = this.controller(other);
      if (c && this.grabs[other]) {
        this.hold.updateMatrixWorld(true);
        this.grabs[other] = new THREE.Matrix4().copy(c.grip.matrixWorld).invert().multiply(this.hold.matrixWorld);
      }
    }
  }
  /** Each frame while held: with the hand (as gripped), or between both. */
  private dragPart(): void {
    const { left, right } = this.grabs;
    if (this.two && left && right) return this.setHeld(twoHandPose(this.two.a0, this.two.b0, this.two.from, this.handAt("left"), this.handAt("right")));
    const hand = left ? "left" : right ? "right" : null;
    const c = hand && this.controller(hand);
    if (!hand || !c) return;
    this.setHeldMatrix(new THREE.Matrix4().copy(c.grip.matrixWorld).multiply(this.grabs[hand]!));
  }
  /** Spinning: a slow turn about the vertical through its middle (a turntable). */
  private spinPart(dt: number): void {
    const p = this.heldPose();
    const c = this.heldCentre();
    const q = new THREE.Quaternion().setFromAxisAngle(UP, dt * 0.5);
    this.setHeld({ pos: p.pos.sub(c).applyQuaternion(q).add(c), quat: q.multiply(p.quat), scale: p.scale });
  }

  // ------------------------------------------------------------------ dollhouse

  private toggleDollhouse(): void {
    if (this.dollhouse) {
      this.rig.scale.setScalar(1);
      this.rig.rotation.y = this.dollhouse.rot;
      this.rig.position.copy(this.dollhouse.pos);
      this.dollhouse = null;
      return void this.say("Full size");
    }
    this.dollhouse = { rot: this.rig.rotation.y, pos: this.rig.position.clone() };
    // The model's box in its own frame (mm): from the mesh's points (the model sits in the rig, so a world box would be in metres).
    const mesh = this.host.mesh();
    const box = new THREE.Box3();
    if (mesh) {
      mesh.geometry.computeBoundingBox();
      box.copy(mesh.geometry.boundingBox!);
    }
    if (box.isEmpty()) return void this.say("Nothing to make small");
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z, 1) / 1000;
    const k = Math.min(1, 1.2 / span);
    // The model's middle 0.9 m in front of you at table height (0.8 m), the same way round as you face it.
    const mid = toXr(box.getCenter(new THREE.Vector3()).toArray() as Vec3);
    const head = this.head();
    const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(UP, this.headYaw()).multiplyScalar(0.9);
    this.rig.scale.setScalar(k);
    const m = mid.clone().applyAxisAngle(UP, this.rig.rotation.y).multiplyScalar(k);
    const minY = (toXr([0, 0, box.min.z]).y) * k;
    this.rig.position.set(head.x + fwd.x - m.x, 0.8 - minY, head.z + fwd.z - m.z);
    this.say("Dollhouse: point at a floor and let go of the trigger to stand there");
  }

  // ------------------------------------------------------------------ menu

  private layoutMenu(): void {
    const n = this.host.notes();
    const b = (id: string, label: string, x: number, y: number, w: number, on?: boolean, color?: string) => ({ id, label, x, y, w, h: 0.1, ...(on ? { on } : {}), ...(color ? { color } : {}) });
    const row = (y: number) => y;
    if (this.inspecting) {
      const s = this.heldPose().scale;
      this.menu.title = "Cocaide VR · holding the part";
      this.menu.buttons = [
        b("tool:measure", "Measure", 0.035, row(0.14), 0.455, this.tool === "measure"),
        b("tool:pin", "Pin", 0.51, row(0.14), 0.455, this.tool === "pin"),
        ...this.measureButtons(b),
        ...PIN_TAGS.map((t, i) => b(`tag:${t}`, PIN_WORDS[t], 0.035 + i * 0.188, row(0.4), 0.178, this.pinTag === t, `#${PIN_COLORS[t].toString(16).padStart(6, "0")}`)),
        b("oneToOne", `True size (now ${scaleText(s)})`, 0.035, row(0.53), 0.3, Math.abs(s - 1) < 0.005),
        b("bringBack", "Bring it back", 0.35, row(0.53), 0.3),
        b("spin", this.spin ? "Stop spinning" : "Spin it", 0.665, row(0.53), 0.3, this.spin),
        b("walk", "Walk in it", 0.035, row(0.66), 0.3),
        b("undo", "Undo", 0.35, row(0.66), 0.3),
        b("exit", "Leave VR", 0.665, row(0.66), 0.3, false),
      ];
      this.menu.lines = [`Shown ${scaleText(s)}: measures are always true size. Let go and it stays where it is.`, "Grip holds it · both grips turn it, stretch to size it · stick pushes/pulls · A 1:1 · B bring back · Y undo"];
      this.menu.draw();
      return;
    }
    if (this.page === "show") {
      const names = this.showList();
      const per = 12;
      const pages = Math.max(1, Math.ceil(names.length / per));
      this.showPage = Math.min(this.showPage, pages - 1);
      const shown = names.slice(this.showPage * per, this.showPage * per + per);
      this.menu.title = `Show / hide (${names.length - [...this.hiddenGroups].filter((n) => names.includes(n)).length} of ${names.length} shown)`;
      this.menu.buttons = [
        ...shown.map((n, i) => ({ ...b(`show:${n}`, `${this.hiddenGroups.has(n) ? "○" : "●"} ${niceName(n)}`.slice(0, 30), 0.035 + (i % 2) * 0.475, 0.13 + Math.floor(i / 2) * 0.088, 0.455, !this.hiddenGroups.has(n)), h: 0.078 })),
        b("show:prev", "◀", 0.035, 0.68, 0.1),
        b("show:next", `▶ ${this.showPage + 1}/${pages}`, 0.145, 0.68, 0.16),
        b("show:all", "Show all", 0.32, 0.68, 0.2),
        b("roof", this.roofOff ? "Cut above: on" : "Cut above: off", 0.535, 0.68, 0.24, this.roofOff),
        b("show:back", "Back", 0.79, 0.68, 0.175),
      ];
      this.menu.lines = ["Click to hide or show · rays and teleport go through what's hidden · B cuts away everything above head height"];
      this.menu.draw();
      return;
    }
    const tools: [VrTool, string][] = [["teleport", "Teleport"], ["measure", "Measure"], ["pin", "Pin"], ["move", "Move"]];
    const tags = PIN_TAGS;
    this.menu.title = "Cocaide VR";
    this.menu.buttons = [
      ...tools.map(([t, l], i) => b(`tool:${t}`, l, 0.035 + i * 0.235, row(0.14), 0.22, this.tool === t)),
      ...this.measureButtons(b),
      ...tags.map((t, i) => b(`tag:${t}`, PIN_WORDS[t], 0.035 + i * 0.188, row(0.4), 0.178, this.pinTag === t, `#${PIN_COLORS[t].toString(16).padStart(6, "0")}`)),
      b("showhide", this.hiddenGroups.size ? `Show / hide (${this.hiddenGroups.size} hidden)` : "Show / hide", 0.035, row(0.53), 0.3, this.hiddenGroups.size > 0),
      b("start", "Back to the start", 0.35, row(0.53), 0.3),
      this.host.canInspect?.() ? b("inspect", "Hold it", 0.665, row(0.53), 0.3) : b("dollhouse", this.dollhouse ? "Full size" : "Dollhouse", 0.665, row(0.53), 0.3, !!this.dollhouse),
      b("nextPin", `Next pin (${n.pins.length + this.pins.length})`, 0.035, row(0.66), 0.3),
      b("undo", "Undo", 0.35, row(0.66), 0.3),
      b("exit", "Leave VR", 0.665, row(0.66), 0.3, false),
    ];
    const moved = [...this.placed.values()].filter((p) => Math.hypot(...p.move) > 0.5 || p.turn).length;
    this.menu.lines = [
      `This visit: ${this.pins.length} pin${this.pins.length === 1 ? "" : "s"}, ${moved} piece${moved === 1 ? "" : "s"} moved; saved to the file as proposals when you leave VR.`,
      "Move: trigger picks pieces (green), grip moves them, handles turn 10° · A undo · B cut above · Y start",
    ];
    this.menu.draw();
  }

  /** The menu's measure row: Points or Faces, snapping (points), clear. */
  private measureButtons(b: (id: string, label: string, x: number, y: number, w: number, on?: boolean) => { id: string; label: string; x: number; y: number; w: number; h: number }) {
    const on = this.tool === "measure";
    return [
      b("measure:points", "Points", 0.035, 0.27, 0.22, on && this.measureMode === "points"),
      b("measure:faces", "Faces · holes", 0.27, 0.27, 0.22, on && this.measureMode === "faces"),
      b("snap", this.snap ? "Snap: on" : "Snap: off", 0.505, 0.27, 0.22, this.snap),
      b("clearMeasures", `Clear (${this.measures.length})`, 0.74, 0.27, 0.225),
    ];
  }

  private toggleMenu(): void {
    this.menuOpen = !this.menuOpen;
    this.page = "main";
    if (this.menuOpen) {
      this.layoutMenu();
      const head = this.head();
      const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(UP, this.headYaw());
      this.menu.mesh.position.copy(head).add(fwd.multiplyScalar(0.55)).add(new THREE.Vector3(0, -0.2, 0));
      this.menu.mesh.lookAt(head.x, this.menu.mesh.position.y + 0.08, head.z);
      this.host.scene.add(this.menu.mesh);
    } else this.host.scene.remove(this.menu.mesh);
    for (const c of this.controllers) this.hintFor(c);
  }

  private menuPick(id: string): void {
    if (id.startsWith("tool:")) {
      this.tool = id.slice(5) as VrTool;
      this.say(`${this.tool[0].toUpperCase()}${this.tool.slice(1)}`);
    } else if (id.startsWith("tag:")) {
      this.pinTag = id.slice(4) as PinTag;
      this.tool = "pin";
    } else if (id === "showhide") {
      this.page = "show";
      this.showPage = 0;
    } else if (id === "show:back") this.page = "main";
    else if (id === "show:prev") this.showPage = Math.max(0, this.showPage - 1);
    else if (id === "show:next") this.showPage = (this.showPage + 1) % Math.max(1, Math.ceil(this.showList().length / 12));
    else if (id === "show:all") {
      this.hiddenGroups.clear();
      this.applyHidden();
    } else if (id.startsWith("show:")) this.toggleShown(id.slice(5));
    else if (id === "measure:points" || id === "measure:faces") {
      this.measureMode = id === "measure:faces" ? "faces" : "points";
      this.tool = "measure";
      this.faceFirst = null;
      this.say(this.measureMode === "faces" ? "Measure faces: point at one to see it, click two for the gap" : "Measure points: click two points");
    } else if (id === "snap") this.snap = !this.snap;
    else if (id === "clearMeasures") {
      for (const m of this.measures) for (const o of m.objs) o.removeFromParent();
      this.measures = [];
      this.faceFirst = null;
      this.undo = this.undo.filter((u) => u.kind !== "measure");
    } else if (id === "roof") this.setRoof(!this.roofOff);
    else if (id === "start") {
      this.goStart();
      this.say("Back to the start");
    } else if (id === "dollhouse") this.toggleDollhouse();
    else if (id === "oneToOne") this.oneToOne();
    else if (id === "bringBack") this.bringBack();
    else if (id === "spin") this.spin = !this.spin;
    else if (id === "walk") this.toWalk();
    else if (id === "inspect") this.toInspect();
    else if (id === "nextPin") this.nextPin();
    else if (id === "undo") this.undoLast();
    else if (id === "exit") return this.exit();
    this.layoutMenu();
    for (const c of this.controllers) this.hintFor(c);
  }

  /** The menu button the right ray points at. */
  private menuHover(): string | null {
    const c = this.controller("right");
    if (!c || !this.menuOpen) return null;
    const o = new THREE.Vector3().setFromMatrixPosition(c.grip.matrixWorld);
    const d = new THREE.Vector3(0, 0, -1).transformDirection(c.grip.matrixWorld);
    const h = new THREE.Raycaster(o, d, 0, 5).intersectObject(this.menu.mesh, false)[0];
    return h?.uv ? (this.menu.at(h.uv)?.id ?? null) : null;
  }

  // ------------------------------------------------------------------ the frame

  /** A button's press (true once, on the frame it goes down) or release. */
  private edge(hand: string, b: number, down: boolean): "press" | "release" | null {
    const key = `${hand}:${b}`;
    if (down && !this.pressed.has(key)) {
      this.pressed.add(key);
      return "press";
    }
    if (!down && this.pressed.has(key)) {
      this.pressed.delete(key);
      return "release";
    }
    return null;
  }

  /** The model's mesh copied with its triangles sorted by look (see `draw`); the mesh hidden while VR draws the copy. */
  private buildDraw(): void {
    this.dropDraw();
    const m = this.host.mesh();
    const src = m?.geometry.index;
    if (!m || !src || !Array.isArray(m.material) || m.material.length < 2 || !m.parent) return;
    const g = m.geometry;
    // One material for each look (colour, finish, opacity, shown or not): the first of the mesh's with it.
    const keys = new Map<string, number>();
    const looks: THREE.Material[] = [];
    const slot = m.material.map((mt) => {
      const s = mt as THREE.MeshStandardMaterial;
      const k = [s.color?.getHex(), s.metalness, s.roughness, s.opacity, s.transparent, s.visible, !!s.envMap].join("|");
      let i = keys.get(k);
      if (i === undefined) {
        i = looks.length;
        keys.set(k, i);
        looks.push(mt);
      }
      return i;
    });
    const lists: number[][] = looks.map(() => []);
    for (const gr of g.groups) for (let t = gr.start / 3; t < (gr.start + gr.count) / 3; t++) lists[slot[gr.materialIndex ?? 0]].push(t);
    const from = src.array;
    const at = new Int32Array(from.length / 3).fill(-1);
    const index = new Uint32Array(from.length);
    const copy = new THREE.BufferGeometry();
    copy.setAttribute("position", g.getAttribute("position"));
    copy.setAttribute("normal", g.getAttribute("normal"));
    let n = 0;
    lists.forEach((list, k) => {
      const first = n;
      for (const t of list) {
        at[t] = n;
        index[n * 3] = from[t * 3];
        index[n * 3 + 1] = from[t * 3 + 1];
        index[n * 3 + 2] = from[t * 3 + 2];
        n++;
      }
      if (n > first) copy.addGroup(first * 3, (n - first) * 3, k);
    });
    const built = index.slice(0, n * 3);
    copy.setIndex(new THREE.BufferAttribute(built.slice(), 1));
    const mesh = new THREE.Mesh(copy, looks);
    mesh.name = "vr-draw";
    mesh.raycast = () => {};
    mesh.frustumCulled = false;
    mesh.position.copy(m.position);
    mesh.quaternion.copy(m.quaternion);
    mesh.scale.copy(m.scale);
    m.parent.add(mesh);
    m.visible = false;
    this.draw = { from: m, mesh, at, index: built };
  }
  private dropDraw(): void {
    const d = this.draw;
    if (!d) return;
    d.mesh.removeFromParent();
    d.mesh.geometry.dispose();
    d.from.visible = true;
    this.draw = null;
  }
  /** Faces hidden (what is being carried) from the model and from what VR draws of it; null shows them all again. */
  private hiddenNow: number[] | null = null;
  /** The ray tree skips these faces' triangles (null: none). */
  private markHidden(faces: number[] | null): void {
    const r = this.rays;
    if (!r) return;
    r.skip.fill(0);
    const ranges = r.view.mesh?.faceRanges ?? [];
    for (const f of faces ?? []) {
      const g = ranges[f];
      if (g) r.skip.fill(1, g.start / 3, (g.start + g.count) / 3);
    }
  }
  private hide(faces: number[] | null): void {
    this.hiddenNow = faces;
    this.markHidden(faces);
    this.host.hideFaces(faces);
    const d = this.draw;
    if (!d) return;
    const idx = d.index.slice();
    if (faces) {
      const ranges = this.host.view()?.mesh?.faceRanges ?? [];
      for (const f of faces) {
        const r = ranges[f];
        if (!r) continue;
        for (let t = r.start / 3; t < (r.start + r.count) / 3; t++) {
          const k = d.at[t];
          if (k < 0) continue;
          idx[k * 3 + 1] = idx[k * 3];
          idx[k * 3 + 2] = idx[k * 3];
        }
      }
    }
    d.mesh.geometry.setIndex(new THREE.BufferAttribute(idx, 1));
  }

  private frame(t: number): void {
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    // The model rebuilt while in VR: draw the new one (sorted again); shown again by the desktop's display style: hide it.
    const m = this.host.mesh();
    if (this.draw && m !== this.draw.from) {
      this.buildDraw();
      this.applyHidden();
    } else if (this.draw?.from.visible) this.draw.from.visible = false;
    // Holding a part: it goes in front of you once the headset knows where you are.
    if (this.inspecting && this.needsPlace && this.head().lengthSq() > 0.01) {
      this.needsPlace = false;
      this.bringBack();
    }
    const prefs = this.host.prefs();
    const sources = this.session ? [...this.session.inputSources] : [];
    let walking = 0;
    const hover = this.menuHover();
    if (hover !== this.menu.hover && this.menuOpen) {
      this.menu.hover = hover;
      this.menu.draw();
    }
    for (const src of sources) {
      const gp = src.gamepad;
      const hand = src.handedness;
      if (!gp || (hand !== "left" && hand !== "right")) continue;
      const c = this.controller(hand);
      if (!c) continue;
      const btn = (b: number) => !!gp.buttons[b]?.pressed;
      const [sx, sy] = [gp.axes[2] ?? 0, gp.axes[3] ?? 0];
      // Grip: hold the part (inspecting), or pick up and put down furniture.
      const g = this.edge(hand, BUTTONS.squeeze, btn(BUTTONS.squeeze));
      if (g === "press") {
        if (this.inspecting) this.grabPart(hand);
        else this.grab(hand);
      } else if (g === "release") {
        if (this.inspecting) this.releasePart(hand);
        else if (this.carry?.hand === hand) this.drop();
      }
      // Trigger.
      const tr = this.edge(hand, BUTTONS.trigger, btn(BUTTONS.trigger));
      if (hand === "right" && this.menuOpen) {
        if (tr === "press" && hover) this.menuPick(hover);
      } else if (hand === "left" || this.tool === "teleport") {
        if (tr === "press") this.aiming = { hand };
        else if (tr === "release" && this.aiming?.hand === hand) {
          this.aiming = null;
          c.arc.visible = false;
          this.target.visible = false;
          this.teleport();
          this.pulse(hand);
        }
      } else if (this.tool === "measure") {
        if (this.measureMode === "faces") {
          if (tr === "press") this.pickFace(c);
        } else if (tr === "press") this.measureDown(c);
        else if (tr === "release") this.measureUp(c);
      } else if (this.tool === "pin") {
        if (tr === "press") this.dropPin(c);
      } else if (this.tool === "move") {
        // The trigger picks pieces (and lets them go), or turns the selection on a handle; the grip moves it.
        if (tr === "press") {
          const knob = this.handleAt(c);
          if (knob) this.startTurn(hand, knob);
          else this.toggleSelect(hand);
        } else if (tr === "release" && this.turning?.hand === hand) this.endTurn();
      }
      // Holding the part in one hand: that hand's stick pushes it away or pulls it in, along the hand.
      const holding = this.inspecting && !!this.grabs[hand] && !this.two;
      if (holding && Math.abs(sy) > 0.2) this.grabs[hand]!.premultiply(new THREE.Matrix4().makeTranslation(0, 0, sy * dt * 0.8));
      // Sticks: the right turns you (or what you carry), the left walks.
      if (!holding && (hand === "right" || (this.carry && this.carry.hand === hand))) {
        if (Math.abs(sx) > 0.7 && !this.turned[hand]) {
          this.turned[hand] = true;
          if (this.carry) this.stickTurn(sx > 0 ? -TURN_STEP : TURN_STEP);
          else if (hand === "right") {
            const head = this.head();
            const a = ((sx > 0 ? 1 : -1) * prefs.snapTurn * Math.PI) / 180;
            this.rig.position.sub(head).applyAxisAngle(UP, a).add(head);
            this.rig.rotation.y += a;
          }
        } else if (Math.abs(sx) < 0.3) this.turned[hand] = false;
      }
      if (hand === "left" && prefs.smooth && !this.dollhouse && Math.hypot(sx, sy) > 0.15 && !(this.carry?.hand === "left") && !holding) {
        // Walk the way you look (level), the world sliding the other way; the floor followed up a step or a stair.
        const yaw = this.headYaw();
        const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(UP, yaw);
        const right = new THREE.Vector3().crossVectors(fwd, UP);
        const move = fwd.multiplyScalar(-sy).add(right.multiplyScalar(sx)).multiplyScalar(prefs.speed * dt);
        this.rig.position.sub(move);
        if (!this.inspecting) this.followFloor();
        walking = Math.min(1, Math.hypot(sx, sy));
      }
      // Buttons: X menu, Y start (left); A undo, B roof (right). Holding a part: Y undo; A true size, B bring it back.
      if (this.edge(hand, BUTTONS.a, btn(BUTTONS.a)) === "press") {
        if (hand === "left") this.toggleMenu();
        else if (this.inspecting) this.oneToOne();
        else this.undoLast();
      }
      if (this.edge(hand, BUTTONS.b, btn(BUTTONS.b)) === "press") {
        if (hand === "left") {
          if (this.inspecting) this.undoLast();
          else {
            this.goStart();
            this.say("Back to the start");
          }
        } else if (this.inspecting) {
          this.bringBack();
          this.say("Brought back in front of you");
        } else this.setRoof(!this.roofOff);
      }
    }
    if (this.carry) this.drag();
    if (this.turning) this.dragTurn();
    if (this.inspecting) {
      this.dragPart();
      if (this.spin && !this.grabs.left && !this.grabs.right) this.spinPart(dt);
      this.sizeNotes();
    }
    if (this.measures.length || this.faceHover) this.sizeCards();
    // The arc while a trigger is held for teleporting.
    for (const c of this.controllers) if (!this.aiming || this.aiming.hand !== c.hand) c.arc.visible = false;
    if (this.aiming) {
      const c = this.controller(this.aiming.hand);
      if (c) {
        const pts = this.aim(c);
        c.arc.geometry.setFromPoints(pts);
        (c.arc.material as THREE.LineBasicMaterial).color.set(this.hit ? 0x4fc3f7 : 0xe5484d);
        c.arc.visible = true;
        this.target.visible = !!this.hit;
        if (this.hit) this.target.position.copy(this.hit).add(new THREE.Vector3(0, 0.01, 0));
      }
    }
    // The right hand's ray: long when it points at the menu or a tool needs it, with a dot where it lands.
    const r = this.controller("right");
    this.pointer.visible = false;
    if (r) {
      const tooled = !this.menuOpen && this.tool !== "teleport";
      let len = this.menuOpen ? 2 : 0.6;
      if (tooled) {
        const h = this.cast(r, this.tool === "move");
        if (h) {
          len = h.distance;
          const snapAt = this.tool === "measure" && this.measureMode === "points" ? this.measurePoint(r) : null;
          const p = snapAt ? new THREE.Vector3(...snapAt).applyMatrix4(this.zup.matrixWorld) : h.point;
          this.pointer.position.copy(p);
          this.pointer.visible = true;
          (this.pointer.material as THREE.MeshBasicMaterial).color.set(this.tool === "move" ? (this.handleAt(r) ? 0xffd400 : this.itemAt(h) ? 0x30a46c : 0xe5484d) : 0xffd400);
        }
      }
      r.ray.scale.z = len;
      if (this.tool === "measure" && !this.menuOpen && this.measureMode === "points") this.liveMeasure(r);
      if (this.tool === "measure" && !this.menuOpen && this.measureMode === "faces") this.hoverFace(r);
      else this.clearFaceHover();
    }
    // The comfort vignette while walking with the stick.
    if (prefs.vignette && walking > 0) {
      const cam = this.host.renderer.xr.getCamera();
      this.vignette.position.copy(this.head()).add(new THREE.Vector3(0, 0, -0.25).applyQuaternion(cam.quaternion));
      this.vignette.quaternion.copy(cam.quaternion);
      (this.vignette.material as THREE.MeshBasicMaterial).opacity = 0.55 * walking;
      this.vignette.visible = true;
    } else this.vignette.visible = false;
    if (this.toast) {
      if (performance.now() > this.toastUntil) {
        this.host.scene.remove(this.toast);
        disposeSprite(this.toast);
        this.toast = null;
      } else {
        const cam = this.host.renderer.xr.getCamera();
        const fwd = new THREE.Vector3(0, -0.18, -1).applyQuaternion(cam.quaternion);
        this.toast.position.copy(this.head()).add(fwd.multiplyScalar(1.1));
      }
    }
    this.host.renderer.render(this.host.scene, this.host.renderer.xr.getCamera());
  }

  /** Walking: a floor up to 400 below or above your feet becomes the floor you stand on (steps, stairs, a deck). */
  private followFloor(): void {
    const head = this.head();
    const h = this.rayHit(new THREE.Vector3(head.x, 0.45, head.z), new THREE.Vector3(0, -1, 0), 0.9);
    if (!h) return;
    const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : UP;
    if (n.dot(UP) > 0.7 && Math.abs(h.point.y) > 0.005) this.rig.position.y -= h.point.y;
  }

  // ------------------------------------------------------------------ for tests

  /** Where you stand in the model (mm, Z up) and the way you face (degrees from +X). */
  standing(): { at: [number, number, number]; heading: number } {
    const head = this.head();
    const inv = new THREE.Matrix4().copy(this.zup.matrixWorld).invert();
    const p = new THREE.Vector3(head.x, 0, head.z).applyMatrix4(inv);
    const cam = this.host.renderer.xr.getCamera();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const f = fwd.clone().add(head).applyMatrix4(inv).sub(new THREE.Vector3().copy(head).applyMatrix4(inv));
    return { at: [Math.round(p.x), Math.round(p.y), Math.round(p.z)], heading: Math.round((Math.atan2(f.y, f.x) * 180) / Math.PI) };
  }
  roof(): boolean {
    return this.roofOff;
  }
  state() {
    return {
      tool: this.tool,
      snap: this.snap,
      pinTag: this.pinTag,
      menu: this.menuOpen,
      menuButtons: this.menuOpen ? this.menu.buttons.map((b) => b.id) : [],
      hover: this.menu.hover,
      dollhouse: !!this.dollhouse,
      measures: this.measures.map((m) => Math.round(Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1], m.b[2] - m.a[2]))),
      measureMode: this.measureMode,
      cards: this.measures.filter((m) => m.text).map((m) => m.text),
      faceHover: this.faceHover?.text ?? null,
      pins: this.pins.map((p) => ({ tag: p.tag, at: p.at })),
      moved: [...this.placed.values()].map((p) => ({ key: p.item.key, move: p.move, turn: p.turn })),
      carrying: this.carry?.key ?? null,
      selected: [...this.selected],
      knobs: this.gizmo.parent ? this.gizmo.children.filter((k) => k.userData.turn !== undefined).map((k) => ({ turn: k.userData.turn as number, at: new THREE.Vector3().setFromMatrixPosition(k.matrixWorld).toArray() })) : [],
      hidden: [...this.hiddenGroups],
      showList: this.showList(),
      mode: this.inspecting ? "inspect" : "walk",
      held: (() => {
        const p = this.heldPose();
        const c = this.heldCentre();
        return { scale: Math.round(p.scale * 1000) / 1000, centre: c.toArray().map((v) => Math.round(v * 1000)), holding: (["left", "right"] as const).filter((h) => !!this.grabs[h]) };
      })(),
    };
  }
  /** For tests: stand at a point (model mm), facing a heading, full size. */
  standAt(start: VrStart): void {
    this.dollhouse = null;
    this.rig.scale.setScalar(1);
    const { rotY, position } = rigFor(start);
    this.rig.rotation.set(0, rotY, 0);
    this.rig.position.copy(position);
  }
  /** For tests: where a point of the model (mm) is in the room (m), to aim a controller at. */
  worldOf(p: Vec3): number[] {
    this.zup.updateWorldMatrix(true, false);
    return this.zup.localToWorld(new THREE.Vector3(...p)).toArray();
  }
  /** For tests: a menu button pressed, as the right trigger on it would. */
  press(id: string): void {
    if (!this.menuOpen) this.toggleMenu();
    this.menuPick(id);
  }
}
