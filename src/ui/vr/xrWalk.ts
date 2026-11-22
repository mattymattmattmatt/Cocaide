// The VR walkthrough (WebXR, immersive-vr): the model at 1:1 around you, the
// floor where your feet are, standing where the document says to start
// (Settings > VR > Set the start point, else in front of the model, facing it).
//
//   Either trigger: aim the arc at a floor and let go to teleport there (a
//     floor on another storey works the same; walls and ceilings don't take you).
//   Left stick: walk (Settings > VR); right stick left/right: snap turn.
//   B or Y: roof off (hides what is more than 2.3 m above the floor you are on).
//   A or X: back to the start point.
//
// The viewport hands over its renderer, scene and model group. While you are
// in VR the model is held by a rig that turns it Y-up and scales it to metres
// (the view itself is Z-up, in mm); everything else in the scene is put away
// and comes back as it was when you leave.

import * as THREE from "three";
import type { VrStart } from "../../doc/vr";
import type { VrPrefs } from "./vrPrefs";

export interface XrHost {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  model: THREE.Group;
  /** The desktop frame, drawn again when you come out. */
  render(): void;
  prefs(): VrPrefs;
  start(): VrStart | null;
  /** Told when VR starts and ends (the button shows "Exit VR" meanwhile). */
  onChange(inVr: boolean): void;
}

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

const UP = new THREE.Vector3(0, 1, 0);

export class XrWalk {
  private session: XRSession | null = null;
  private rig = new THREE.Group();
  private zup = new THREE.Group();
  private lights = new THREE.Group();
  private ground: THREE.Mesh;
  private put: { obj: THREE.Object3D; visible: boolean }[] = [];
  private background: THREE.Scene["background"] = null;
  private hemiAt = new THREE.Vector3();
  private controllers: { grip: THREE.Group; ray: THREE.Line; arc: THREE.Line; hand: string }[] = [];
  private target: THREE.Mesh;
  private aiming: { index: number } | null = null;
  private hit: THREE.Vector3 | null = null;
  private turned = false;
  private roofOff = false;
  private pressed = new Set<string>();
  private last = 0;
  private toast: THREE.Sprite | null = null;
  private toastUntil = 0;
  private startNow: VrStart = { at: [0, 0, 0], heading: 90 };
  private culled: THREE.Object3D[] = [];

  constructor(private host: XrHost) {
    this.zup.rotation.x = -Math.PI / 2;
    this.zup.scale.setScalar(0.001);
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
    scene.add(this.rig, this.lights, this.target);
    this.background = scene.background;
    scene.background = new THREE.Color(0xbfd9ef);
    this.startNow = this.host.start() ?? defaultStart(box);
    this.goStart();
    this.addControllers();
    session.addEventListener("end", () => this.leave());
    this.last = performance.now();
    renderer.setAnimationLoop((t) => this.frame(t));
    this.host.onChange(true);
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
    for (const c of this.controllers) c.grip.removeFromParent();
    this.controllers = [];
    scene.add(model);
    for (const o of this.culled) o.frustumCulled = true;
    this.culled = [];
    this.zup.remove(this.ground);
    scene.remove(this.rig, this.lights, this.target);
    if (this.toast) scene.remove(this.toast);
    for (const { obj, visible } of this.put) obj.visible = visible;
    const hemi = scene.children.find((o) => (o as THREE.HemisphereLight).isHemisphereLight);
    if (hemi) hemi.position.copy(this.hemiAt);
    scene.background = this.background;
    this.session = null;
    this.host.onChange(false);
    this.host.render();
  }

  /** The rig placed so the start is under your feet, facing its way. */
  private goStart(): void {
    const { rotY, position } = rigFor(this.startNow);
    this.rig.rotation.set(0, rotY, 0);
    this.rig.position.copy(position);
  }

  private addControllers(): void {
    const { renderer, scene } = this.host;
    for (let i = 0; i < 2; i++) {
      const grip = renderer.xr.getController(i);
      const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -0.6)]), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }));
      const arc = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x4fc3f7 }));
      arc.frustumCulled = false;
      arc.visible = false;
      const knob = new THREE.Mesh(new THREE.ConeGeometry(0.015, 0.06, 12).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x2a2d33 }));
      grip.add(ray, knob);
      scene.add(grip, arc);
      const c = { grip, ray, arc, hand: i === 0 ? "left" : "right" };
      grip.addEventListener("connected", (e) => (c.hand = (e as unknown as { data: XRInputSource }).data.handedness || c.hand));
      grip.addEventListener("selectstart", () => (this.aiming = { index: i }));
      grip.addEventListener("selectend", () => this.teleport(i));
      this.controllers.push(c);
    }
  }

  /** The model's surfaces in VR space, for the arc to land on. */
  private meshes(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    this.host.model.traverseVisible((o) => {
      if ((o as THREE.Mesh).isMesh) out.push(o);
    });
    return [...out, this.ground];
  }

  /** The teleport arc from a controller: a throw under gravity, and the floor it lands on (null: not a floor). */
  private aim(i: number): THREE.Vector3[] {
    const c = this.controllers[i];
    const o = new THREE.Vector3().setFromMatrixPosition(c.grip.matrixWorld);
    const d = new THREE.Vector3(0, 0, -1).transformDirection(c.grip.matrixWorld);
    const v = d.multiplyScalar(7);
    const pts = [o.clone()];
    const ray = new THREE.Raycaster();
    const targets = this.meshes();
    this.hit = null;
    let p = o.clone();
    for (let k = 0; k < 60; k++) {
      const dt = 0.03;
      const q = p.clone().add(v.clone().multiplyScalar(dt));
      v.y -= 9.8 * dt;
      const seg = q.clone().sub(p);
      ray.set(p, seg.clone().normalize());
      ray.far = seg.length();
      const h = ray.intersectObjects(targets, false)[0];
      if (h) {
        pts.push(h.point.clone());
        const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : UP;
        if (Math.abs(n.dot(UP)) > 0.7 && h.point.y < o.y + 0.5) this.hit = h.point.clone();
        break;
      }
      pts.push(q);
      p = q;
    }
    return pts;
  }

  private teleport(i: number): void {
    if (this.aiming?.index !== i) return;
    this.aiming = null;
    this.controllers[i].arc.visible = false;
    this.target.visible = false;
    const t = this.hit;
    if (!t) return;
    const head = this.head();
    // The world moves so the spot is under your head, its floor where your feet are.
    this.rig.position.add(new THREE.Vector3(head.x - t.x, -t.y, head.z - t.z));
    this.pulse(i);
  }

  private head(): THREE.Vector3 {
    const cam = this.host.renderer.xr.getCamera();
    return new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  }

  private pulse(i: number): void {
    const src = this.session ? [...this.session.inputSources][i] : undefined;
    const act = (src?.gamepad as unknown as { hapticActuators?: { pulse(v: number, ms: number): void }[] } | undefined)?.hapticActuators?.[0];
    act?.pulse(0.4, 40);
  }

  /** A word in front of you for a moment ("Roof off"). */
  private say(text: string): void {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 128;
    const g = c.getContext("2d");
    if (!g) return;
    g.fillStyle = "rgba(20,22,26,0.82)";
    g.beginPath();
    g.roundRect(0, 0, 512, 128, 40);
    g.fill();
    g.fillStyle = "#fff";
    g.font = "56px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, 256, 66);
    if (this.toast) this.host.scene.remove(this.toast);
    this.toast = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
    this.toast.scale.set(0.5, 0.125, 1);
    this.toast.renderOrder = 20;
    this.host.scene.add(this.toast);
    this.toastUntil = performance.now() + 1600;
  }

  private setRoof(off: boolean): void {
    this.roofOff = off;
    this.host.renderer.clippingPlanes = off ? [new THREE.Plane(new THREE.Vector3(0, -1, 0), this.host.prefs().cutAbove / 1000)] : [];
    this.say(off ? "Roof off" : "Roof on");
  }

  private frame(t: number): void {
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    const prefs = this.host.prefs();
    const sources = this.session ? [...this.session.inputSources] : [];
    for (const src of sources) {
      const gp = src.gamepad;
      if (!gp) continue;
      const hand = src.handedness;
      const [sx, sy] = [gp.axes[2] ?? 0, gp.axes[3] ?? 0];
      if (hand === "right") {
        // Snap turn about where you stand, once per flick.
        if (Math.abs(sx) > 0.7 && !this.turned) {
          this.turned = true;
          const head = this.head();
          const a = ((sx > 0 ? 1 : -1) * prefs.snapTurn * Math.PI) / 180;
          this.rig.position.sub(head).applyAxisAngle(UP, a).add(head);
          this.rig.rotation.y += a;
        } else if (Math.abs(sx) < 0.3) this.turned = false;
      } else if (hand === "left" && prefs.smooth && Math.hypot(sx, sy) > 0.15) {
        // Walk the way you look (level), the world sliding the other way.
        const cam = this.host.renderer.xr.getCamera();
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
        fwd.y = 0;
        fwd.normalize();
        const right = new THREE.Vector3().crossVectors(fwd, UP);
        const move = fwd.multiplyScalar(-sy).add(right.multiplyScalar(sx)).multiplyScalar(prefs.speed * dt);
        this.rig.position.sub(move);
      }
      // Buttons: A/X (4) back to the start, B/Y (5) roof off; each on its press.
      for (const [b, act] of [[4, "start"], [5, "roof"]] as const) {
        const key = `${hand}:${b}`;
        const down = !!gp.buttons[b]?.pressed;
        if (down && !this.pressed.has(key)) {
          this.pressed.add(key);
          if (act === "start") {
            this.goStart();
            this.say("Back to the start");
          } else this.setRoof(!this.roofOff);
        } else if (!down) this.pressed.delete(key);
      }
    }
    // The arc while a trigger is held.
    if (this.aiming) {
      const c = this.controllers[this.aiming.index];
      const pts = this.aim(this.aiming.index);
      c.arc.geometry.setFromPoints(pts);
      (c.arc.material as THREE.LineBasicMaterial).color.set(this.hit ? 0x4fc3f7 : 0xe5484d);
      c.arc.visible = true;
      this.target.visible = !!this.hit;
      if (this.hit) this.target.position.copy(this.hit).add(new THREE.Vector3(0, 0.01, 0));
    }
    if (this.toast) {
      if (performance.now() > this.toastUntil) {
        this.host.scene.remove(this.toast);
        this.toast = null;
      } else {
        const cam = this.host.renderer.xr.getCamera();
        const fwd = new THREE.Vector3(0, -0.15, -1).applyQuaternion(cam.quaternion);
        this.toast.position.copy(this.head()).add(fwd.multiplyScalar(1.2));
      }
    }
    this.host.renderer.render(this.host.scene, this.host.renderer.xr.getCamera());
  }

  /** For tests: where you stand in the model (mm, Z up) and the way you face (degrees from +X). */
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
}
