// What the Evaluate tools and direct manipulation draw over the part: the
// measured line and its label, the centre of mass, a feature's dimensions
// (lines in the scene, values as HTML labels you can double-click), and the
// drag handles (arrows) with the ruler shown while one is dragged. Everything
// here draws on top of the part (no depth test). The viewport calls update()
// after every render so arrows keep their size on screen and labels follow.

import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import type { Vec3 } from "../../doc/types";
import type { Dimension3D } from "../evaluate/dimensions3d";
import { arcPoints, handleText, handleTip, rulerStep, type HandleSpec, type HandleValue } from "../evaluate/handles";

/** The measured line(s) and points, and a centre of mass. */
export interface EvalOverlay {
  lines: { from: Vec3; to: Vec3; label?: string }[];
  points: Vec3[];
  centreOfMass?: { at: Vec3; label: string } | null;
}

interface Tag {
  el: HTMLElement;
  at: Vec3;
  /** Offset in pixels from the projected point. */
  dx: number;
  dy: number;
  /** A handle's label: which handle (a flip button's label follows the button), and how readily it gives way to another label it would cover (0 never). */
  handle?: HandleSpec;
  yields?: number;
}

const MEASURE_COLOR = 0xc2255c;
const DIM_COLOR = 0x1c7ed6;
const HANDLE_COLOR = 0xf08c00;
const HANDLE_HOT = 0xd9480f;
const LOCKED_COLOR = 0x868e96;
/** A pattern's count knob, and a flip button. */
const COUNT_COLOR = 0x0ca678;
const FLIP_COLOR = 0x495057;
/** A section plane's arrow: the blue of the plane it moves. */
const SECTION_COLOR = 0x1971c2;
/** An arc's ball and a point's disc on screen, pixels. */
const BALL_PX = 13;
const POINT_PX = 18;
/** The arrow's length and head on screen, pixels. */
const ARROW_PX = 46;
const HEAD_PX = 14;
/** The shaft's width on screen, pixels: a solid stroke that reads as something to grab, not a hairline. */
const SHAFT_PX = 2.6;
const GRAB_PX = 10;
const ALONG_Y = new THREE.Vector3(0, 1, 0);

export class EvalLayer {
  readonly group = new THREE.Group();
  private readonly overlayGroup = new THREE.Group();
  private readonly dimGroup = new THREE.Group();
  private readonly handleGroup = new THREE.Group();
  private readonly rulerGroup = new THREE.Group();
  private readonly labels: HTMLDivElement;
  private tags: Tag[] = [];
  private dimTags: Tag[] = [];
  private handleTags: Tag[] = [];
  private readonly fat: LineMaterial[];
  private handles: HandleSpec[] = [];
  private hot: string | null = null;
  private dragging: { h: HandleSpec; value: HandleValue } | null = null;
  /** Each handle's pieces (an arrow's shaft and head; an arc, its spoke and ball; a disc and ring; a flip's two heads) and their materials. */
  private readonly arrows = new Map<string, { parts: THREE.Object3D[]; mat: THREE.MeshBasicMaterial; lineMat?: THREE.LineBasicMaterial }>();

  constructor(
    host: HTMLElement,
    private readonly callbacks: { onDimension?(d: Dimension3D, x: number, y: number): void; onHandleLabel?(h: HandleSpec, x: number, y: number): void },
  ) {
    this.group.add(this.overlayGroup, this.dimGroup, this.handleGroup, this.rulerGroup);
    this.labels = document.createElement("div");
    this.labels.className = "eval-labels";
    host.appendChild(this.labels);
    this.fat = [MEASURE_COLOR, DIM_COLOR].map((color) => new LineMaterial({ color, linewidth: 2.5, depthTest: false, transparent: true }));
  }

  resize(w: number, h: number) {
    for (const m of this.fat) m.resolution.set(w, h);
  }

  private tag(text: string, className: string, testId?: string): HTMLElement {
    const el = document.createElement("span");
    el.className = className;
    el.textContent = text;
    if (testId) el.dataset.testid = testId;
    this.labels.appendChild(el);
    return el;
  }

  private clear(group: THREE.Group) {
    for (const c of [...group.children]) {
      group.remove(c);
      c.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | undefined;
        if (mat && !this.fat.includes(mat as LineMaterial)) mat.dispose();
      });
    }
  }

  /** The measured lines and points, and the centre of mass. */
  setOverlay(o: EvalOverlay | null) {
    this.clear(this.overlayGroup);
    for (const t of this.tags) t.el.remove();
    this.tags = [];
    if (!o) return;
    if (o.lines.length) {
      const g = new LineSegmentsGeometry();
      g.setPositions(o.lines.flatMap((l) => [...l.from, ...l.to]));
      const line = new LineSegments2(g, this.fat[0]);
      line.renderOrder = 9;
      this.overlayGroup.add(line);
      o.lines.forEach((l, i) => {
        if (!l.label) return;
        const mid: Vec3 = [(l.from[0] + l.to[0]) / 2, (l.from[1] + l.to[1]) / 2, (l.from[2] + l.to[2]) / 2];
        this.tags.push({ el: this.tag(l.label, "eval-label measure-label", i === 0 ? "measure-label" : undefined), at: mid, dx: 8, dy: -10 });
      });
    }
    const pts = [...o.points, ...(o.centreOfMass ? [o.centreOfMass.at] : [])];
    if (pts.length) {
      const g = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(...p)));
      const dots = new THREE.Points(g, new THREE.PointsMaterial({ color: MEASURE_COLOR, size: 9, sizeAttenuation: false, depthTest: false }));
      dots.renderOrder = 9;
      this.overlayGroup.add(dots);
    }
    if (o.centreOfMass) {
      // A quartered disc, the drawing symbol for a centre of mass, as a ring of dots and a cross.
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...o.centreOfMass.at)]);
      const ring = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x212529, size: 15, sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0.6 }));
      ring.renderOrder = 8;
      this.overlayGroup.add(ring);
      this.tags.push({ el: this.tag(o.centreOfMass.label, "eval-label com-label", "com-label"), at: o.centreOfMass.at, dx: 10, dy: 6 });
    }
  }

  /** A feature's dimensions: lines in the scene, values as labels (double-click one to edit it). */
  setDims(dims: Dimension3D[]) {
    this.clear(this.dimGroup);
    for (const t of this.dimTags) t.el.remove();
    this.dimTags = [];
    const segs = dims.flatMap((d) => d.lines.flatMap(([a, b]) => [...a, ...b]));
    if (segs.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(segs, 3));
      const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: DIM_COLOR, depthTest: false, transparent: true, opacity: 0.85 }));
      lines.renderOrder = 9;
      this.dimGroup.add(lines);
    }
    for (const d of dims) {
      const el = this.tag(d.text, `eval-label dim-label${d.edit.kind === "sketch" && d.edit.driven ? " driven" : ""}`, `dim3d-${d.id}`);
      el.title = `${d.title}: double-click to change it`;
      el.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const r = el.getBoundingClientRect();
        this.callbacks.onDimension?.(d, r.left, r.bottom + 4);
      });
      // Keep the view's own clicks off the label.
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      this.dimTags.push({ el, at: d.at, dx: 0, dy: 0 });
    }
  }

  /** The drag handles to draw; `dragging` with its live value while one is dragged. */
  setHandles(handles: HandleSpec[], dragging: { h: HandleSpec; value: HandleValue } | null) {
    this.handles = handles;
    this.dragging = dragging;
    for (const a of this.arrows.values()) {
      for (const o of a.parts) {
        this.handleGroup.remove(o);
        (o as THREE.Mesh).geometry.dispose();
      }
      a.mat.dispose();
      a.lineMat?.dispose();
    }
    this.arrows.clear();
    for (const t of this.handleTags) t.el.remove();
    this.handleTags = [];
    for (const h of handles) {
      const live = dragging?.h.id === h.id ? dragging : { h, value: h.kind === "point" ? (h.at ?? [0, 0]) : h.value };
      // Transparent (fully opaque) so it is drawn after a feature session's see-through preview, not under it.
      const mat = new THREE.MeshBasicMaterial({ color: this.colorOf(h), depthTest: false, depthWrite: false, transparent: true, opacity: 1 });
      const parts: THREE.Object3D[] = [];
      let lineMat: THREE.LineBasicMaterial | undefined;
      if (h.kind === "angle") {
        // An arc from where the value is 0 to the value, and a ball to drag round it.
        lineMat = new THREE.LineBasicMaterial({ color: this.colorOf(h), depthTest: false, transparent: true, opacity: 0.9 });
        const arc = new THREE.Line(new THREE.BufferGeometry().setFromPoints(arcPoints(live.h, live.value as number).map((p) => new THREE.Vector3(...p))), lineMat);
        const spoke = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...live.h.origin), new THREE.Vector3(...handleTip(live.h, live.value))]), lineMat);
        const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), mat);
        parts.push(arc, spoke, ball);
      } else if (h.kind === "point") {
        // A disc on the face, a ring round it.
        const disc = new THREE.Mesh(new THREE.CircleGeometry(0.5, 24), mat);
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.8, 32), mat);
        parts.push(disc, ring);
      } else if (h.kind === "flip") {
        // Two small heads point both ways: a click turns the direction round.
        parts.push(new THREE.Mesh(new THREE.ConeGeometry(0.35, 1, 12), mat), new THREE.Mesh(new THREE.ConeGeometry(0.35, 1, 12), mat));
      } else {
        // The shaft is a thin rod (sized in pixels each frame, as the head is), the same material as the head; a count's knob is a ball.
        parts.push(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 10), mat), h.snap === "count" ? new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), mat) : new THREE.Mesh(new THREE.ConeGeometry(0.32, 1, 16), mat));
      }
      for (const o of parts) {
        o.renderOrder = 10;
        this.handleGroup.add(o);
      }
      this.arrows.set(h.id, { parts, mat, lineMat });
      if (h.kind === "flip") {
        const el = this.tag(`⇅ ${h.label}`, "eval-label handle-label flip-label", `handle-label-${h.id}`);
        el.title = `${h.label}: turn the direction round`;
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          const r = el.getBoundingClientRect();
          this.callbacks.onHandleLabel?.(h, r.left, r.bottom + 4);
        });
        el.addEventListener("pointerdown", (e) => e.stopPropagation());
        // Beside the button (placed each frame: it stands off the arrow's base by a few pixels); it gives way to the values.
        this.handleTags.push({ el, at: h.origin, dx: 9, dy: -9, handle: h, yields: 2 });
        continue;
      }
      const text = h.kind === "section" ? `${h.label}: ${handleText(h, live.value)}` : `${h.label} ${handleText(h, live.value)}`;
      const el = this.tag(text, `eval-label handle-label${h.locked ? " locked" : ""}${h.kind === "section" ? " section-handle" : ""}`, `handle-label-${h.id}`);
      // A locked label still answers a click: the app says why it cannot be typed into.
      el.title =
        h.locked ??
        (h.kind === "section"
          ? "Drag the arrow to move the plane (whole millimetres; Shift for tenths), or click here to type the offset"
          : `Drag the ${h.kind === "angle" ? "ball round the arc" : h.kind === "point" ? "point on the face" : "arrow"} (Shift: finer steps), or click here to type a value or an =expression`);
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const r = el.getBoundingClientRect();
        this.callbacks.onHandleLabel?.(h, r.left, r.bottom + 4);
      });
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      // A count's label sits above its knob, clear of the spacing's label (the two tips are near each other).
      this.handleTags.push({ el, at: handleTip(live.h, live.value), dx: 10, dy: h.snap === "count" ? -26 : 8, yields: h.snap === "count" ? 1 : 0 });
    }
  }

  /** A handle's colour: grey when locked, orange while under the pointer or dragged, else its kind's. */
  private colorOf(h: HandleSpec): number {
    if (h.locked) return LOCKED_COLOR;
    if (h.id === this.hot || this.dragging?.h.id === h.id) return HANDLE_HOT;
    return h.kind === "flip" ? FLIP_COLOR : h.kind === "section" ? SECTION_COLOR : h.snap === "count" ? COUNT_COLOR : HANDLE_COLOR;
  }

  /** Highlights the handle under the pointer (null: none). Returns whether it changed. */
  setHot(id: string | null): boolean {
    if (id === this.hot) return false;
    this.hot = id;
    for (const [hid, a] of this.arrows) {
      const h = this.handles.find((x) => x.id === hid);
      if (!h) continue;
      a.mat.color.setHex(this.colorOf(h));
      a.lineMat?.color.setHex(this.colorOf(h));
    }
    return true;
  }

  /** The handle as drawn: one being dragged keeps the axis it was grabbed on, at its live value. */
  private live(h: HandleSpec): { h: HandleSpec; value: HandleValue } {
    return this.dragging?.h.id === h.id ? this.dragging : { h, value: h.kind === "point" ? (h.at ?? [0, 0]) : h.value };
  }

  /** Where a handle's arrow runs on screen now: from the tip to the arrow's end (client pixels). */
  private arrowOnScreen(handle: HandleSpec, project: (p: Vec3) => { x: number; y: number } | null, wpp: number) {
    const { h, value } = this.live(handle);
    const tip = handleTip(h, value);
    const end: Vec3 = [tip[0] + h.dir[0] * ARROW_PX * wpp, tip[1] + h.dir[1] * ARROW_PX * wpp, tip[2] + h.dir[2] * ARROW_PX * wpp];
    return { a: project(tip), b: project(end) };
  }

  /** Where the flip button is: beside the arrow's base, off to the side so it doesn't sit on the arrow. */
  private flipAt(h: HandleSpec, wpp: number): Vec3 {
    const side = new THREE.Vector3(...h.dir).cross(Math.abs(h.dir[2]) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)).normalize();
    return [h.origin[0] + side.x * 22 * wpp, h.origin[1] + side.y * 22 * wpp, h.origin[2] + side.z * 22 * wpp];
  }

  /** How far (pixels) the pointer is from a handle, or null when it is not on screen. */
  private distanceTo(handle: HandleSpec, x: number, y: number, project: (p: Vec3) => { x: number; y: number } | null, wpp: number): number | null {
    const { h, value } = this.live(handle);
    if (h.kind === "flip") {
      const p = project(this.flipAt(h, wpp));
      return p ? Math.hypot(p.x - x, p.y - y) : null;
    }
    if (h.kind === "point" || h.kind === "angle") {
      const p = project(handleTip(h, value));
      if (!p) return null;
      let d = Math.hypot(p.x - x, p.y - y);
      if (h.kind === "angle") {
        // Anywhere on the arc grabs it too (a little less readily than the ball).
        const pts = arcPoints(h, value as number, 24).map(project);
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          if (!a || !b) continue;
          d = Math.min(d, segmentDistance(x, y, a, b) + 3);
        }
      }
      return d;
    }
    const { a, b } = this.arrowOnScreen(h, project, wpp);
    if (!a || !b) return null;
    return segmentDistance(x, y, a, b);
  }

  /** The handle under the pointer, if any. */
  hit(x: number, y: number, project: (p: Vec3) => { x: number; y: number } | null, wpp: number): HandleSpec | null {
    let best: { h: HandleSpec; d: number } | null = null;
    for (const h of this.handles) {
      const d = this.distanceTo(h, x, y, project, wpp);
      const grab = h.kind === "point" || h.kind === "angle" || h.kind === "flip" ? GRAB_PX + 2 : GRAB_PX;
      if (d !== null && d <= grab && (!best || d < best.d)) best = { h, d };
    }
    return best?.h ?? null;
  }

  /**
   * Where a handle is on screen (client pixels), for tests and for typing a
   * value there: an arrow `at` of the way from its tip to its end (0.6: on the
   * shaft; 0.85: in its head); an arc's ball, a point, a flip button.
   */
  tipOnScreen(id: string, project: (p: Vec3) => { x: number; y: number } | null, wpp: number, at = 0.6): { x: number; y: number } | null {
    const h = this.handles.find((x) => x.id === id);
    if (!h) return null;
    if (h.kind === "flip") return project(this.flipAt(h, wpp));
    if (h.kind === "point" || h.kind === "angle") {
      const { h: spec, value } = this.live(h);
      return project(handleTip(spec, value));
    }
    const { a, b } = this.arrowOnScreen(h, project, wpp);
    return a && b ? { x: a.x + (b.x - a.x) * at, y: a.y + (b.y - a.y) * at } : null;
  }

  /** After each render: handles sized to the screen, the ruler, labels where their points are. */
  update(camera: THREE.Camera, wpp: number, w: number, h: number) {
    for (const hs of this.handles) {
      const a = this.arrows.get(hs.id);
      if (!a) continue;
      const { h: spec, value } = this.live(hs);
      const tip = new THREE.Vector3(...handleTip(spec, value));
      const dir = new THREE.Vector3(...spec.dir).normalize();
      if (spec.kind === "angle") {
        const ball = a.parts[2];
        ball.position.copy(tip);
        ball.scale.setScalar(BALL_PX * wpp);
        continue;
      }
      if (spec.kind === "point") {
        const n = new THREE.Vector3(...(spec.frame?.z ?? spec.dir)).normalize();
        for (const o of a.parts) {
          o.position.copy(tip).addScaledVector(n, 0.02 * wpp);
          o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
          o.scale.setScalar(POINT_PX * wpp);
        }
        continue;
      }
      if (spec.kind === "flip") {
        const at = new THREE.Vector3(...this.flipAt(spec, wpp));
        const size = 9 * wpp;
        a.parts[0].position.copy(at).addScaledVector(dir, size * 0.6);
        a.parts[0].quaternion.setFromUnitVectors(ALONG_Y, dir);
        a.parts[1].position.copy(at).addScaledVector(dir, -size * 0.6);
        a.parts[1].quaternion.setFromUnitVectors(ALONG_Y, dir.clone().negate());
        for (const o of a.parts) o.scale.setScalar(size);
        continue;
      }
      const len = ARROW_PX * wpp;
      const head = HEAD_PX * wpp;
      const [shaft, knob] = a.parts;
      // The rod from the tip to the head's base (a unit cylinder along Y, centred: scaled and stood on the tip).
      shaft.position.copy(tip).addScaledVector(dir, (len - head) / 2);
      shaft.quaternion.setFromUnitVectors(ALONG_Y, dir);
      shaft.scale.set(SHAFT_PX * wpp, len - head, SHAFT_PX * wpp);
      knob.position.copy(tip).addScaledVector(dir, len - head / 2);
      knob.quaternion.setFromUnitVectors(ALONG_Y, dir);
      knob.scale.setScalar(spec.snap === "count" ? head * 0.9 : head);
    }
    this.drawRuler(wpp);
    const place = (t: Tag) => {
      const v = new THREE.Vector3(...t.at).project(camera);
      t.el.style.display = v.z < 1 ? "" : "none";
      t.el.style.transform = `translate(${((v.x + 1) / 2) * w + t.dx}px, ${((1 - v.y) / 2) * h + t.dy}px)`;
    };
    for (const t of [...this.tags, ...this.dimTags]) place(t);
    // A flip button's label stands by the button, which is drawn a few pixels off the arrow's base.
    for (const t of this.handleTags) if (t.handle?.kind === "flip") t.at = this.flipAt(t.handle, wpp);
    this.placeHandleTags(camera, w, h);
  }

  /**
   * The handles' labels, each where its handle is; one that would cover
   * another (a flip's under a short arrow's value, a count's by the spacing's)
   * steps down below it, the values first, so every label reads and takes
   * its click.
   */
  private placeHandleTags(camera: THREE.Camera, w: number, h: number) {
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const order = [...this.handleTags].sort((a, b) => (a.yields ?? 0) - (b.yields ?? 0));
    for (const t of order) {
      const v = new THREE.Vector3(...t.at).project(camera);
      t.el.style.display = v.z < 1 ? "" : "none";
      const x = ((v.x + 1) / 2) * w + t.dx;
      let y = ((1 - v.y) / 2) * h + t.dy;
      const tw = t.el.offsetWidth;
      const th = t.el.offsetHeight;
      if (tw && th) {
        for (let k = 0; k < 6; k++) {
          const hit = placed.find((r) => x < r.x + r.w && r.x < x + tw && y < r.y + r.h && r.y < y + th);
          if (!hit) break;
          y = hit.y + hit.h + 2;
        }
        placed.push({ x, y, w: tw, h: th });
      }
      t.el.style.transform = `translate(${x}px, ${y}px)`;
    }
  }

  /** While an arrow is dragged: ticks along its axis from where the value is 0 to where it is now. */
  private drawRuler(wpp: number) {
    this.clear(this.rulerGroup);
    const d = this.dragging;
    if (!d || d.h.kind || typeof d.value !== "number") return;
    const h = d.h;
    const value = d.value;
    const step = rulerStep(1 / (wpp * h.scale));
    const dir = new THREE.Vector3(...h.dir).normalize();
    const side = new THREE.Vector3().crossVectors(dir, Math.abs(dir.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)).normalize();
    const pts: number[] = [];
    const at = (v: number) => new THREE.Vector3(...handleTip(h, v));
    const zero = h.offset ?? 0;
    const lo = Math.min(zero, value);
    const hi = Math.max(zero, value);
    const p0 = at(lo);
    const p1 = at(hi);
    pts.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
    // A count's ticks are its copies; a length's every step.
    const tick = h.snap === "count" ? 1 : step;
    const first = Math.ceil(lo / tick);
    for (let k = first; k * tick <= hi + 1e-9 && k - first < 400; k++) {
      const p = at(k * tick);
      const big = h.snap === "count" || k % 5 === 0 ? 9 : 5;
      const q = p.clone().addScaledVector(side, big * wpp);
      pts.push(p.x, p.y, p.z, q.x, q.y, q.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const ruler = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: HANDLE_HOT, depthTest: false }));
    ruler.renderOrder = 10;
    this.rulerGroup.add(ruler);
  }

  dispose() {
    this.setHandles([], null);
    this.setDims([]);
    this.setOverlay(null);
    this.clear(this.rulerGroup);
    for (const m of this.fat) m.dispose();
    this.labels.remove();
  }
}

/** How far a point is from a segment on screen (pixels). */
function segmentDistance(x: number, y: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const l2 = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / l2));
  return Math.hypot(a.x + vx * t - x, a.y + vy * t - y);
}
