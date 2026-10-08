// The 3D view's mouse, as SOLIDWORKS has it: the middle button rotates, with
// Ctrl it pans, with Shift it zooms and with Alt it rolls; a middle click on
// the part makes the next rotation turn about that point, and a middle
// double-click fits the part. The wheel zooms at the pointer. Rotation is
// free (no fixed up), so the part turns any way you drag it. Right-drag pans.
// The trackpad scheme adds left-drag to rotate and Shift+left-drag to pan.
// A press and release in place is still a click: picking is the viewport's.

import * as THREE from "three";
import { inputPrefs, wheelZoom } from "./input";

type Gesture = "rotate" | "pan" | "zoom" | "roll";

interface Hooks {
  /** The point of the part under the pointer, if any. */
  pick(clientX: number, clientY: number): THREE.Vector3 | null;
  /** Fit the part (a middle double-click). */
  fit(): void;
  /** Show or clear the point the next rotation turns about. */
  showPivot(p: THREE.Vector3 | null): void;
  changed(): void;
}

/** Radians a pixel of drag turns the view. */
const TURN = 0.0075;
/** Pixels before a press becomes a drag. */
const SLOP = 4;

export class CadControls {
  /** What the camera looks at: the point rotations and zooms are about when nothing else is. */
  readonly target = new THREE.Vector3();
  private pivot: THREE.Vector3 | null = null;
  private drag: { gesture: Gesture | null; button: number; x: number; y: number; lastX: number; lastY: number; id: number; moving: boolean; usedPivot: boolean } | null = null;
  private lastMiddleClick = 0;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
    private readonly hooks: Hooks,
  ) {
    dom.addEventListener("pointerdown", this.onDown);
    dom.addEventListener("pointermove", this.onMove);
    dom.addEventListener("pointerup", this.onUp);
    dom.addEventListener("pointercancel", this.onUp);
    dom.addEventListener("wheel", this.onWheel, { passive: false });
    dom.addEventListener("contextmenu", this.noDefault);
    // No autoscroll or paste from the middle button.
    dom.addEventListener("mousedown", this.noMiddle);
    dom.addEventListener("auxclick", this.noMiddle);
  }

  dispose() {
    this.dom.removeEventListener("pointerdown", this.onDown);
    this.dom.removeEventListener("pointermove", this.onMove);
    this.dom.removeEventListener("pointerup", this.onUp);
    this.dom.removeEventListener("pointercancel", this.onUp);
    this.dom.removeEventListener("wheel", this.onWheel);
    this.dom.removeEventListener("contextmenu", this.noDefault);
    this.dom.removeEventListener("mousedown", this.noMiddle);
    this.dom.removeEventListener("auxclick", this.noMiddle);
  }

  /** Points the camera from `dir` (unit, toward the camera) at `center`, `dist` away, with this up. */
  place(center: THREE.Vector3, dir: THREE.Vector3, dist: number, up: THREE.Vector3) {
    this.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.up.copy(up);
    this.camera.lookAt(this.target);
    this.settle();
  }

  /** Turns the view about the screen's up (yaw) and right (pitch) axes, radians. */
  turn(yaw: number, pitch: number, about: THREE.Vector3 = this.target) {
    const { up, right } = this.axes();
    const q = new THREE.Quaternion().setFromAxisAngle(up, yaw).multiply(new THREE.Quaternion().setFromAxisAngle(right, pitch));
    // A copy: `about` may be the target itself, which moves below.
    const c = about.clone();
    this.camera.position.sub(c).applyQuaternion(q).add(c);
    this.target.sub(c).applyQuaternion(q).add(c);
    this.camera.up.copy(up).applyQuaternion(q);
    this.camera.lookAt(this.target);
    this.settle();
  }

  /** Turns the view in the plane of the screen, radians, clockwise positive. */
  roll(angle: number) {
    const { forward } = this.axes();
    this.camera.up.applyAxisAngle(forward, angle);
    this.camera.lookAt(this.target);
    this.settle();
  }

  /** Moves the view by screen pixels: the part follows the pointer. */
  pan(dx: number, dy: number) {
    const { up, right } = this.axes();
    const wpp = this.worldPerPixel();
    const move = right.multiplyScalar(-dx * wpp).add(up.multiplyScalar(dy * wpp));
    this.camera.position.add(move);
    this.target.add(move);
    this.settle();
  }

  /** Zooms by `factor` (above 1: in) toward a point on the screen, or the view's centre. */
  zoom(factor: number, clientX?: number, clientY?: number) {
    const at = clientX === undefined || clientY === undefined ? this.target.clone() : this.pointUnder(clientX, clientY);
    const dist = this.camera.position.distanceTo(this.target);
    const f = Math.min(Math.max(factor, 0.02), 50);
    // Not closer than a micron, nor further than a kilometre.
    if ((f > 1 && dist / f < 1e-3) || (f < 1 && dist / f > 1e6)) return;
    this.camera.position.sub(at).divideScalar(f).add(at);
    this.target.sub(at).divideScalar(f).add(at);
    this.settle();
  }

  /** World units per screen pixel at the target's depth. */
  worldPerPixel(): number {
    const h = this.dom.clientHeight || 1;
    return (2 * this.camera.position.distanceTo(this.target) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / h;
  }

  /** The camera's forward, true up and right, unit. */
  axes() {
    const forward = this.target.clone().sub(this.camera.position).normalize();
    const right = forward.clone().cross(this.camera.up).normalize();
    if (right.lengthSq() < 1e-12) right.set(1, 0, 0);
    const up = right.clone().cross(forward).normalize();
    return { forward, up, right };
  }

  private settle() {
    const dist = this.camera.position.distanceTo(this.target);
    this.camera.near = Math.max(dist / 500, 1e-4);
    this.camera.far = dist * 500;
    this.camera.updateProjectionMatrix();
    this.hooks.changed();
  }

  /** The part under the pointer, or where the pointer's ray meets the plane through the target facing the camera. */
  private pointUnder(clientX: number, clientY: number): THREE.Vector3 {
    const hit = this.hooks.pick(clientX, clientY);
    if (hit) return hit;
    const rect = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.axes().forward, this.target);
    return ray.ray.intersectPlane(plane, new THREE.Vector3()) ?? this.target.clone();
  }

  private gestureFor(e: PointerEvent): Gesture | null {
    if (e.button === 1) return e.ctrlKey || e.metaKey ? "pan" : e.shiftKey ? "zoom" : e.altKey ? "roll" : "rotate";
    if (e.button === 2) return "pan";
    if (e.button === 0 && (inputPrefs().mouse === "trackpad" || e.pointerType === "touch")) return e.shiftKey ? "pan" : "rotate";
    return null;
  }

  private onDown = (e: PointerEvent) => {
    if (e.button === 1) e.preventDefault();
    const gesture = this.gestureFor(e);
    if (!gesture && e.button !== 1) return;
    this.drag = { gesture, button: e.button, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, id: e.pointerId, moving: false, usedPivot: false };
  };

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.moving) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < SLOP) return;
      d.moving = true;
      this.dom.setPointerCapture?.(e.pointerId);
    }
    const dx = e.clientX - d.lastX;
    const dy = e.clientY - d.lastY;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    switch (d.gesture) {
      case "rotate":
        d.usedPivot = d.usedPivot || !!this.pivot;
        this.turn(-dx * TURN, -dy * TURN, this.pivot ?? this.target);
        break;
      case "pan":
        this.pan(dx, dy);
        break;
      case "zoom":
        this.zoom(Math.exp(-dy * 0.01));
        break;
      case "roll":
        this.roll(-dx * TURN);
        break;
    }
  };

  private onUp = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    if (this.dom.hasPointerCapture?.(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
    if (d.moving) {
      // The point a middle click picked is for one rotation, as in SOLIDWORKS.
      if (d.usedPivot) this.setPivot(null);
      return;
    }
    if (d.button !== 1) return;
    // A middle click: twice quickly fits the part; once on the part turns the next rotation about that point.
    const now = performance.now();
    if (now - this.lastMiddleClick < 350) {
      this.lastMiddleClick = 0;
      this.setPivot(null);
      this.hooks.fit();
      return;
    }
    this.lastMiddleClick = now;
    this.setPivot(this.hooks.pick(e.clientX, e.clientY));
  };

  private setPivot(p: THREE.Vector3 | null) {
    this.pivot = p;
    this.hooks.showPivot(p);
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.zoom(wheelZoom(e, inputPrefs()), e.clientX, e.clientY);
  };

  private noDefault = (e: Event) => e.preventDefault();
  private noMiddle = (e: MouseEvent) => {
    if (e.button === 1) e.preventDefault();
  };
}
