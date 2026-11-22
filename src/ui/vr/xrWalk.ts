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
//               Move (drag furniture along the floor); stick: snap turn, or
//               turn what you carry; A: undo; B: roof off.
//   Either grip: pick up a piece of furniture you point at, put it down where
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
import type { VrPrefs } from "./vrPrefs";

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

/** The point of a triangle a measure snaps to near p: a corner within 60 mm, else the nearest point of an edge within 40 mm, else p. */
export function snapPoint(p: Vec3, tri: [Vec3, Vec3, Vec3]): { at: Vec3; kind: "corner" | "edge" | "surface" } {
  const d = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  let best: Vec3 | null = null;
  let bd = 60;
  for (const v of tri) if (d(p, v) < bd) [best, bd] = [v, d(p, v)];
  if (best) return { at: [...best] as Vec3, kind: "corner" };
  bd = 40;
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
type Undo = { kind: "pin"; id: string } | { kind: "measure" } | { kind: "move"; key: string; move: Vec3; turn: number };

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
  // Tools.
  tool: VrTool = "teleport";
  snap = true;
  pinTag: PinTag = "note";
  private items: VrItem[] = [];
  private placed = new Map<string, Placed>();
  private carry: { key: string; hand: "left" | "right"; grab: Vec3; height: number; startMove: Vec3; startTurn: number } | null = null;
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

  constructor(private host: XrHost) {
    this.zup.rotation.x = -Math.PI / 2;
    this.zup.scale.setScalar(0.001);
    this.zup.add(this.notesGroup);
    this.rig.add(this.zup);
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
    this.zup.add(this.ground);
    scene.add(this.rig, this.lights, this.target, this.vignette, this.pointer);
    this.background = scene.background;
    scene.background = new THREE.Color(0xbfd9ef);
    this.startNow = this.host.start() ?? defaultStart(box);
    this.goStart();
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
    this.say("Welcome: X for the menu");
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
    scene.add(model);
    for (const o of this.culled) o.frustumCulled = true;
    this.culled = [];
    this.zup.remove(this.ground);
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
    this.pins = [];
    this.undo = [];
    this.carry = null;
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
    const words = c.hand === "left" ? "Teleport · X menu" : this.menuOpen ? "Point and click" : `${this.tool === "pin" ? `Pin: ${PIN_WORDS[this.pinTag]}` : this.tool[0].toUpperCase() + this.tool.slice(1)} · A undo`;
    c.hint = textSprite(words, 0.11, { size: 40 });
    c.hint.position.set(0, 0.05, 0.02);
    c.grip.add(c.hint);
  }

  private controller(hand: "left" | "right"): Controller | undefined {
    return this.controllers.find((c) => c.hand === hand);
  }

  /** The model's surfaces (and what was moved), for rays to land on; the lawn too unless `noGround`. */
  private targets(noGround = false): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    const m = this.host.mesh();
    if (m) out.push(m);
    for (const p of this.placed.values()) out.push(p.ghost);
    return noGround ? out : [...out, this.ground];
  }

  /** A controller's straight ray into the model: the nearest hit. */
  private cast(c: Controller, noGround = false): THREE.Intersection | null {
    const o = new THREE.Vector3().setFromMatrixPosition(c.grip.matrixWorld);
    const d = new THREE.Vector3(0, 0, -1).transformDirection(c.grip.matrixWorld);
    const ray = new THREE.Raycaster(o, d, 0.01, 60);
    return ray.intersectObjects(this.targets(noGround), false)[0] ?? null;
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
    const ray = new THREE.Raycaster();
    const targets = this.targets(small);
    this.hit = null;
    let p = o.clone();
    for (let k = 0; k < 60; k++) {
      const dt = 0.03;
      const q = p.clone().add(v.clone().multiplyScalar(dt));
      v.y -= g * dt;
      const seg = q.clone().sub(p);
      ray.set(p, seg.clone().normalize());
      ray.far = seg.length();
      const h = ray.intersectObjects(targets, false)[0];
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
    const faces = [...this.placed.values()].flatMap((p) => p.item.faces);
    this.hide(faces.length ? faces : null);
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

  private grab(hand: "left" | "right"): void {
    const c = this.controller(hand);
    if (!c || this.carry) return;
    const h = this.cast(c, true);
    const it = this.itemAt(h);
    if (!h || !it) return void this.say(h ? "Only furniture moves" : "Point at a piece of furniture");
    const p = this.placed.get(it.key) ?? this.place(it, [0, 0, 0], 0);
    this.applyHidden();
    const at = this.toModel(h.point);
    this.carry = { key: it.key, hand, grab: at, height: at[2], startMove: [...p.move] as Vec3, startTurn: p.turn };
    this.pulse(hand, 0.5, 30);
  }

  /** Carrying: the piece slides along the floor under where the ray meets the level it was picked up at. */
  private drag(): void {
    if (!this.carry) return;
    const c = this.controller(this.carry.hand);
    const p = this.placed.get(this.carry.key);
    if (!c || !p) return;
    const o = new THREE.Vector3().setFromMatrixPosition(c.grip.matrixWorld);
    const d = new THREE.Vector3(0, 0, -1).transformDirection(c.grip.matrixWorld);
    // The level picked up at, in the world.
    const lvl = new THREE.Vector3(0, 0, this.carry.height);
    this.zup.localToWorld(lvl);
    const hitY = lvl.y;
    if (Math.abs(d.y) < 1e-4) return;
    const t = (hitY - o.y) / d.y;
    if (t <= 0 || t > 40) return;
    const q = this.toModel(o.clone().add(d.multiplyScalar(t)));
    const dm: Vec3 = [q[0] - this.carry.grab[0], q[1] - this.carry.grab[1], 0];
    // 10 mm steps.
    const s = this.carry.startMove;
    this.place(p.item, [Math.round((s[0] + dm[0]) / 10) * 10, Math.round((s[1] + dm[1]) / 10) * 10, s[2]], p.turn);
  }

  private drop(): void {
    if (!this.carry) return;
    const p = this.placed.get(this.carry.key);
    if (p) {
      this.undo.push({ kind: "move", key: this.carry.key, move: this.carry.startMove, turn: this.carry.startTurn });
      const moved = Math.hypot(p.move[0] - this.carry.startMove[0], p.move[1] - this.carry.startMove[1]);
      if (moved > 5 || p.turn !== this.carry.startTurn) this.say(`${niceName(p.item.partBody ?? p.item.body)}: moved ${lengthText(moved)}${p.turn !== this.carry.startTurn ? `, turned ${Math.round(p.turn - this.carry.startTurn)}°` : ""}`);
    }
    this.pulse(this.carry.hand, 0.3, 20);
    this.carry = null;
  }

  // ------------------------------------------------------------------ measure and pins

  /** Where a ray meets the model for a measure: snapped to a corner or edge when snapping is on. */
  private measurePoint(c: Controller): Vec3 | null {
    const h = this.cast(c);
    if (!h) return null;
    const at = this.toModel(h.point);
    if (!this.snap || !h.face || h.object === this.ground) return at.map((v) => Math.round(v)) as Vec3;
    const pos = (h.object as THREE.Mesh).geometry.getAttribute("position");
    const corner = (i: number): Vec3 => {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(h.object.matrixWorld);
      return this.toModel(v);
    };
    return snapPoint(at, [corner(h.face.a), corner(h.face.b), corner(h.face.c)]).at;
  }

  private dot(at: Vec3, color = 0xffd400): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.SphereGeometry(18, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
    m.position.set(...at);
    m.renderOrder = 34;
    this.notesGroup.add(m);
    return m;
  }

  /** A dimension: the line, its ends and its length. */
  private dimension(a: Vec3, b: Vec3): THREE.Object3D[] {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]), new THREE.LineBasicMaterial({ color: 0xffd400, depthTest: false }));
    line.renderOrder = 33;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const label = textSprite(lengthText(len), 260, { bg: "rgba(255,212,0,0.92)", fg: "#111" });
    label.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 + 60);
    this.notesGroup.add(line, label);
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

  private drawPin(p: VrPin): void {
    const color = PIN_COLORS[p.tag];
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 450, 8).rotateX(Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x444444 }));
    stick.position.set(p.at[0], p.at[1], p.at[2] + 225);
    const head = new THREE.Mesh(new THREE.SphereGeometry(55, 16, 12), new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.35 }));
    head.position.set(p.at[0], p.at[1], p.at[2] + 470);
    const label = textSprite(p.text ? `${PIN_WORDS[p.tag]}\n${p.text}` : PIN_WORDS[p.tag], 380, { bg: `#${color.toString(16).padStart(6, "0")}ee` });
    label.position.set(p.at[0], p.at[1], p.at[2] + 640);
    this.notesGroup.add(stick, head, label);
    this.pinObjs.set(p.id, [stick, head, label]);
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
      this.say("Measure taken back");
    } else {
      const p = this.placed.get(u.key);
      if (p) {
        this.place(p.item, u.move, u.turn);
        if (Math.hypot(...p.move) < 1 && !p.turn && !Math.hypot(...p.base.move) && !p.base.turn) {
          p.ghost.geometry.dispose();
          p.ghost.removeFromParent();
          this.placed.delete(u.key);
          this.applyHidden();
        }
      }
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
    const tools: [VrTool, string][] = [["teleport", "Teleport"], ["measure", "Measure"], ["pin", "Pin"], ["move", "Move"]];
    const tags = PIN_TAGS;
    this.menu.title = "Cocaide VR";
    this.menu.buttons = [
      ...tools.map(([t, l], i) => b(`tool:${t}`, l, 0.035 + i * 0.235, row(0.14), 0.22, this.tool === t)),
      b("snap", this.snap ? "Snap: corners, edges" : "Snap: off (free)", 0.035, row(0.27), 0.455, this.snap),
      b("clearMeasures", `Clear measures (${this.measures.length})`, 0.51, row(0.27), 0.455),
      ...tags.map((t, i) => b(`tag:${t}`, PIN_WORDS[t], 0.035 + i * 0.188, row(0.4), 0.178, this.pinTag === t, `#${PIN_COLORS[t].toString(16).padStart(6, "0")}`)),
      b("roof", this.roofOff ? "Roof on" : "Roof off", 0.035, row(0.53), 0.3, this.roofOff),
      b("start", "Back to the start", 0.35, row(0.53), 0.3),
      b("dollhouse", this.dollhouse ? "Full size" : "Dollhouse", 0.665, row(0.53), 0.3, !!this.dollhouse),
      b("nextPin", `Next pin (${n.pins.length + this.pins.length})`, 0.035, row(0.66), 0.3),
      b("undo", "Undo", 0.35, row(0.66), 0.3),
      b("exit", "Leave VR", 0.665, row(0.66), 0.3, false),
    ];
    const moved = [...this.placed.values()].filter((p) => Math.hypot(...p.move) > 0.5 || p.turn).length;
    this.menu.lines = [
      `This visit: ${this.pins.length} pin${this.pins.length === 1 ? "" : "s"}, ${moved} piece${moved === 1 ? "" : "s"} moved; saved to the file as proposals when you leave VR.`,
      "Left trigger teleports · grip picks up furniture (right stick turns it) · A undo · B roof · Y start",
    ];
    this.menu.draw();
  }

  private toggleMenu(): void {
    this.menuOpen = !this.menuOpen;
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
    } else if (id === "snap") this.snap = !this.snap;
    else if (id === "clearMeasures") {
      for (const m of this.measures) for (const o of m.objs) o.removeFromParent();
      this.measures = [];
      this.undo = this.undo.filter((u) => u.kind !== "measure");
    } else if (id === "roof") this.setRoof(!this.roofOff);
    else if (id === "start") {
      this.goStart();
      this.say("Back to the start");
    } else if (id === "dollhouse") this.toggleDollhouse();
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
  private hide(faces: number[] | null): void {
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
      // Grip: pick up and put down furniture.
      const g = this.edge(hand, BUTTONS.squeeze, btn(BUTTONS.squeeze));
      if (g === "press") this.grab(hand);
      else if (g === "release" && this.carry?.hand === hand) this.drop();
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
        if (tr === "press") this.measureDown(c);
        else if (tr === "release") this.measureUp(c);
      } else if (this.tool === "pin") {
        if (tr === "press") this.dropPin(c);
      } else if (this.tool === "move") {
        if (tr === "press") this.grab(hand);
        else if (tr === "release" && this.carry?.hand === hand) this.drop();
      }
      // Sticks: the right turns you (or what you carry), the left walks.
      if (hand === "right" || (this.carry && this.carry.hand === hand)) {
        if (Math.abs(sx) > 0.7 && !this.turned[hand]) {
          this.turned[hand] = true;
          if (this.carry) {
            const p = this.placed.get(this.carry.key);
            if (p) this.place(p.item, p.move, p.turn + (sx > 0 ? -15 : 15));
          } else if (hand === "right") {
            const head = this.head();
            const a = ((sx > 0 ? 1 : -1) * prefs.snapTurn * Math.PI) / 180;
            this.rig.position.sub(head).applyAxisAngle(UP, a).add(head);
            this.rig.rotation.y += a;
          }
        } else if (Math.abs(sx) < 0.3) this.turned[hand] = false;
      }
      if (hand === "left" && prefs.smooth && !this.dollhouse && Math.hypot(sx, sy) > 0.15 && !(this.carry?.hand === "left")) {
        // Walk the way you look (level), the world sliding the other way; the floor followed up a step or a stair.
        const yaw = this.headYaw();
        const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(UP, yaw);
        const right = new THREE.Vector3().crossVectors(fwd, UP);
        const move = fwd.multiplyScalar(-sy).add(right.multiplyScalar(sx)).multiplyScalar(prefs.speed * dt);
        this.rig.position.sub(move);
        this.followFloor();
        walking = Math.min(1, Math.hypot(sx, sy));
      }
      // Buttons: X menu, Y start (left); A undo, B roof (right).
      if (this.edge(hand, BUTTONS.a, btn(BUTTONS.a)) === "press") {
        if (hand === "left") this.toggleMenu();
        else this.undoLast();
      }
      if (this.edge(hand, BUTTONS.b, btn(BUTTONS.b)) === "press") {
        if (hand === "left") {
          this.goStart();
          this.say("Back to the start");
        } else this.setRoof(!this.roofOff);
      }
    }
    if (this.carry) this.drag();
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
          const snapAt = this.tool === "measure" ? this.measurePoint(r) : null;
          const p = snapAt ? new THREE.Vector3(...snapAt).applyMatrix4(this.zup.matrixWorld) : h.point;
          this.pointer.position.copy(p);
          this.pointer.visible = true;
          (this.pointer.material as THREE.MeshBasicMaterial).color.set(this.tool === "move" ? (this.itemAt(h) ? 0x30a46c : 0xe5484d) : 0xffd400);
        }
      }
      r.ray.scale.z = len;
      if (this.tool === "measure" && !this.menuOpen) this.liveMeasure(r);
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
    const ray = new THREE.Raycaster(new THREE.Vector3(head.x, 0.45, head.z), new THREE.Vector3(0, -1, 0), 0, 0.9);
    const h = ray.intersectObjects(this.targets(), false)[0];
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
      pins: this.pins.map((p) => ({ tag: p.tag, at: p.at })),
      moved: [...this.placed.values()].map((p) => ({ key: p.item.key, move: p.move, turn: p.turn })),
      carrying: this.carry?.key ?? null,
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
  /** For tests: a menu button pressed, as the right trigger on it would. */
  press(id: string): void {
    if (!this.menuOpen) this.toggleMenu();
    this.menuPick(id);
  }
}
