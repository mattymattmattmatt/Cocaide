// The 3D view's mouse, the standard CAD way: the middle button rotates, with
// Ctrl it pans, with Shift it zooms and with Alt it rolls; the wheel zooms at
// the pointer; right-drag pans; a middle double-click fits the part. The
// trackpad scheme adds left-drag to rotate and Shift+left-drag to pan. A press
// and release in place is still a click: picking is the viewport's.
//
// The part spins in place: a rotation turns about a centre chosen when it
// starts (src/ui/viewport/orbit.ts: the pinned point, else the middle of the
// part while it is on screen, else the part under the middle of the view),
// never about the look-at point, which panning and zooming at the pointer
// move off into empty space. A middle-click on the part pins the centre there
// (a marker shows it) until a middle-click on empty space, Esc, Fit or a
// standard view. Dragging across the view's height turns half a turn (times
// the speed in Settings > Mouse); "Keep Z up" makes it a turntable.

import * as THREE from "three";
import { inputPrefs, wheelZoom } from "./input";
import { clonePose, orbit, poseAxes, reseat, turnPerPixel, type Pose } from "./viewport/orbit";
import { viewPrefs } from "./viewport/viewPrefs";

type Gesture = "rotate" | "pan" | "zoom" | "roll";

interface Hooks {
  /** The point of the part under the pointer, if any. */
  pick(clientX: number, clientY: number): THREE.Vector3 | null;
  /** Fit the part (a middle double-click). */
  fit(): void;
  /** Show or clear the pinned rotation centre. */
  showPivot(p: THREE.Vector3 | null): void;
  /** The centre a rotation starting now turns about (the pinned one, the part's middle, the part under the middle of the view). */
  centre(): THREE.Vector3;
  /** The user takes the view: a glide still running ends now. */
  interrupt?(): void;
  changed(): void;
}

/** Pixels before a press becomes a drag. */
const SLOP = 4;

export class CadControls {
  /** What the camera looks at: the depth panning and zooming work at; never the rotation centre on its own. */
  readonly target = new THREE.Vector3();
  /** Orthographic: the eye's distance is the zoom (the frame is what the perspective camera sees at the target). */
  orthographic = false;
  /** While set, the left button is the viewport's (zoom to area): no left-drag rotation in the trackpad scheme. */
  leftTaken = false;
  private pinnedAt: THREE.Vector3 | null = null;
  private drag: { gesture: Gesture | null; button: number; x: number; y: number; lastX: number; lastY: number; id: number; moving: boolean; centre: THREE.Vector3 | null } | null = null;
  private lastMiddleClick = 0;
  /** A turn driven from outside the view (the view cube dragged): the centre it turns about. */
  private dragCentre: THREE.Vector3 | null = null;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
    private readonly hooks: Hooks,
  ) {
    this.unlisten = this.listen(dom);
  }

  private readonly unlisten: () => void;

  /**
   * Takes the view's mouse on another element too (Phase P wave 2A: the sketch
   * canvas laid over the view): its middle and right drags and its wheel move
   * the view as they do on the view itself; the left button stays the
   * element's (see leftTaken). Returns what stops it.
   */
  listen(el: HTMLElement): () => void {
    el.addEventListener("pointerdown", this.onDown);
    el.addEventListener("pointermove", this.onMove);
    el.addEventListener("pointerup", this.onUp);
    el.addEventListener("pointercancel", this.onUp);
    el.addEventListener("wheel", this.onWheel, { passive: false });
    el.addEventListener("contextmenu", this.noDefault);
    // No autoscroll or paste from the middle button.
    el.addEventListener("mousedown", this.noMiddle);
    el.addEventListener("auxclick", this.noMiddle);
    return () => {
      el.removeEventListener("pointerdown", this.onDown);
      el.removeEventListener("pointermove", this.onMove);
      el.removeEventListener("pointerup", this.onUp);
      el.removeEventListener("pointercancel", this.onUp);
      el.removeEventListener("wheel", this.onWheel);
      el.removeEventListener("contextmenu", this.noDefault);
      el.removeEventListener("mousedown", this.noMiddle);
      el.removeEventListener("auxclick", this.noMiddle);
    };
  }

  dispose() {
    this.unlisten();
  }

  /** The pinned rotation centre, if one is pinned. */
  get pinned(): THREE.Vector3 | null {
    return this.pinnedAt;
  }

  /** Pins the rotation centre at p (null: unpinned, the centre is chosen afresh each time). */
  pin(p: THREE.Vector3 | null) {
    if (!p && !this.pinnedAt) return;
    this.pinnedAt = p ? p.clone() : null;
    this.hooks.showPivot(this.pinnedAt);
  }

  /** Is a drag moving the view now? */
  get busy(): boolean {
    return !!this.drag?.moving;
  }

  /** The camera as it is: where it is, what it looks at, which way is up. */
  pose(): Pose {
    return { position: this.camera.position.clone(), target: this.target.clone(), up: this.camera.up.clone() };
  }

  /** Puts the camera at a pose. */
  setPose(p: Pose) {
    this.camera.position.copy(p.position);
    this.target.copy(p.target);
    this.camera.up.copy(p.up).normalize();
    this.camera.lookAt(this.target);
    this.settle();
  }

  /** Points the camera from `dir` (unit, toward the camera) at `center`, `dist` away, with this up. */
  place(center: THREE.Vector3, dir: THREE.Vector3, dist: number, up: THREE.Vector3) {
    this.setPose({ position: center.clone().addScaledVector(dir, dist), target: center.clone(), up: up.clone() });
  }

  /** The pose turned about `centre` (radians: yaw about the screen's up, or Z keeping Z up; pitch about its right), with the look-at point re-seated at the centre's depth. */
  turned(yaw: number, pitch: number, centre: THREE.Vector3, from: Pose = this.pose()): Pose {
    return orbit(reseat(from, centre, this.orthographic), centre, yaw, pitch, viewPrefs().turntable);
  }

  /** Turns the view about `about` (default: the rotation centre the view chooses), radians. */
  turn(yaw: number, pitch: number, about?: THREE.Vector3) {
    this.setPose(this.turned(yaw, pitch, about ?? this.hooks.centre()));
  }

  /**
   * A drag elsewhere (the view cube) turns the view as a middle-drag on the
   * part does: begin (the centre is chosen then), the pixels moved, end.
   */
  beginDragTurn() {
    this.hooks.interrupt?.();
    this.dragCentre = this.hooks.centre();
    this.setPose(reseat(this.pose(), this.dragCentre, this.orthographic));
  }

  dragTurn(dx: number, dy: number) {
    if (!this.dragCentre) return;
    const rate = turnPerPixel(this.dom.clientHeight, viewPrefs().rotateSpeed);
    this.setPose(orbit(this.pose(), this.dragCentre, -dx * rate, -dy * rate, viewPrefs().turntable));
  }

  endDragTurn() {
    this.dragCentre = null;
  }

  /** Turns the view in the plane of the screen, radians, clockwise positive. */
  roll(angle: number) {
    this.setPose(this.rolled(angle));
  }

  /** The pose rolled in the plane of the screen (about the line of sight through the look-at point). */
  rolled(angle: number, from: Pose = this.pose()): Pose {
    const { forward } = poseAxes(from);
    const p = clonePose(from);
    p.up.applyAxisAngle(forward, angle);
    return p;
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

  /** World units per screen pixel at the target's depth (and everywhere, orthographic). */
  worldPerPixel(): number {
    const h = this.dom.clientHeight || 1;
    return (2 * this.camera.position.distanceTo(this.target) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / h;
  }

  /** The camera's forward, true up and right, unit. */
  axes() {
    return poseAxes(this.pose());
  }

  private settle() {
    const dist = this.camera.position.distanceTo(this.target);
    this.camera.near = Math.max(dist / 500, 1e-4);
    this.camera.far = dist * 500;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.hooks.changed();
  }

  /** The part under the pointer, or where the pointer's ray meets the plane through the target facing the camera. */
  private pointUnder(clientX: number, clientY: number): THREE.Vector3 {
    const hit = this.hooks.pick(clientX, clientY);
    if (hit) return hit;
    const rect = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.axes().forward, this.target);
    if (this.orthographic) {
      // Parallel rays: straight in from where the pointer is on the frame.
      const { up, right, forward } = this.axes();
      const halfH = this.worldPerPixel() * ((rect.height || 1) / 2);
      const halfW = halfH * ((rect.width || 1) / (rect.height || 1));
      const origin = this.target.clone().addScaledVector(right, ndc.x * halfW).addScaledVector(up, ndc.y * halfH);
      return new THREE.Ray(origin.addScaledVector(forward, -1), forward).intersectPlane(plane, new THREE.Vector3()) ?? this.target.clone();
    }
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    return ray.ray.intersectPlane(plane, new THREE.Vector3()) ?? this.target.clone();
  }

  private gestureFor(e: PointerEvent): Gesture | null {
    if (e.button === 1) return e.ctrlKey || e.metaKey ? "pan" : e.shiftKey ? "zoom" : e.altKey ? "roll" : "rotate";
    if (e.button === 2) return "pan";
    if (e.button === 0 && !this.leftTaken && (inputPrefs().mouse === "trackpad" || e.pointerType === "touch")) return e.shiftKey ? "pan" : "rotate";
    return null;
  }

  private onDown = (e: PointerEvent) => {
    if (e.button === 1) e.preventDefault();
    const gesture = this.gestureFor(e);
    if (!gesture && e.button !== 1) return;
    this.hooks.interrupt?.();
    this.drag = { gesture, button: e.button, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, id: e.pointerId, moving: false, centre: null };
  };

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.moving) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < SLOP) return;
      d.moving = true;
      // On the element the press was on (the view, or what lies over it).
      (e.currentTarget as Element | null)?.setPointerCapture?.(e.pointerId);
    }
    const dx = e.clientX - d.lastX;
    const dy = e.clientY - d.lastY;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    switch (d.gesture) {
      case "rotate": {
        // The centre is chosen once, as the rotation starts; the look-at point moves to its depth (the view does not change).
        if (!d.centre) {
          d.centre = this.hooks.centre();
          this.setPose(reseat(this.pose(), d.centre, this.orthographic));
        }
        const rate = turnPerPixel(this.dom.clientHeight, viewPrefs().rotateSpeed);
        this.setPose(orbit(this.pose(), d.centre, -dx * rate, -dy * rate, viewPrefs().turntable));
        break;
      }
      case "pan":
        this.pan(dx, dy);
        break;
      case "zoom":
        this.zoom(Math.exp(-dy * 0.01));
        break;
      case "roll":
        this.roll(-dx * turnPerPixel(this.dom.clientHeight, viewPrefs().rotateSpeed));
        break;
    }
  };

  private onUp = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    const el = e.currentTarget as Element | null;
    if (el?.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (d.moving || d.button !== 1) return;
    // A middle click: twice quickly fits the part; once on the part pins the rotation centre there, on empty space unpins it.
    const now = performance.now();
    if (now - this.lastMiddleClick < 350) {
      this.lastMiddleClick = 0;
      this.pin(null);
      this.hooks.fit();
      return;
    }
    this.lastMiddleClick = now;
    this.pin(this.hooks.pick(e.clientX, e.clientY));
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.hooks.interrupt?.();
    this.zoom(wheelZoom(e, inputPrefs()), e.clientX, e.clientY);
  };

  private noDefault = (e: Event) => e.preventDefault();
  private noMiddle = (e: MouseEvent) => {
    if (e.button === 1) e.preventDefault();
  };
}
