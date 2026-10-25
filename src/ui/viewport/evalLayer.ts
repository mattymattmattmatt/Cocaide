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
import { handleText, handleTip, rulerStep, type HandleSpec } from "../evaluate/handles";

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
}

const MEASURE_COLOR = 0xc2255c;
const DIM_COLOR = 0x1c7ed6;
const HANDLE_COLOR = 0x1971c2;
const HANDLE_HOT = 0xf08c00;
const LOCKED_COLOR = 0x868e96;
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
  private dragging: { h: HandleSpec; value: number } | null = null;
  private readonly arrows = new Map<string, { shaft: THREE.Mesh; head: THREE.Mesh; mat: THREE.MeshBasicMaterial }>();

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
  setHandles(handles: HandleSpec[], dragging: { h: HandleSpec; value: number } | null) {
    this.handles = handles;
    this.dragging = dragging;
    for (const a of this.arrows.values()) {
      this.handleGroup.remove(a.shaft, a.head);
      a.shaft.geometry.dispose();
      a.head.geometry.dispose();
      a.mat.dispose();
    }
    this.arrows.clear();
    for (const t of this.handleTags) t.el.remove();
    this.handleTags = [];
    for (const h of handles) {
      const color = h.locked ? LOCKED_COLOR : h.id === this.hot || dragging?.h.id === h.id ? HANDLE_HOT : HANDLE_COLOR;
      const mat = new THREE.MeshBasicMaterial({ color, depthTest: false });
      // The shaft is a thin rod (sized in pixels each frame, as the head is), the same material as the head.
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 10), mat);
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.32, 1, 16), mat);
      shaft.renderOrder = 10;
      head.renderOrder = 10;
      this.handleGroup.add(shaft, head);
      this.arrows.set(h.id, { shaft, head, mat });
      const { h: spec, value } = dragging?.h.id === h.id ? dragging : { h, value: h.value };
      const el = this.tag(h.kind === "section" ? `${h.label}: ${handleText(h, value)}` : `${h.label} ${handleText(h, value)}`, `eval-label handle-label${h.locked ? " locked" : ""}${h.kind === "section" ? " section-handle" : ""}`, `handle-label-${h.id}`);
      // A locked label still answers a click: the app says why it cannot be typed into.
      el.title = h.locked ?? (h.kind === "section" ? "Drag the arrow to move the plane (whole millimetres; Shift for tenths), or click here to type the offset" : "Drag the arrow, or click here to type a value");
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const r = el.getBoundingClientRect();
        this.callbacks.onHandleLabel?.(h, r.left, r.bottom + 4);
      });
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      this.handleTags.push({ el, at: handleTip(spec, value), dx: 10, dy: 8 });
    }
  }

  /** Highlights the handle under the pointer (null: none). Returns whether it changed. */
  setHot(id: string | null): boolean {
    if (id === this.hot) return false;
    this.hot = id;
    for (const [hid, a] of this.arrows) {
      const h = this.handles.find((x) => x.id === hid);
      const color = h?.locked ? LOCKED_COLOR : hid === id || this.dragging?.h.id === hid ? HANDLE_HOT : HANDLE_COLOR;
      a.mat.color.setHex(color);
    }
    return true;
  }

  /** The handle as drawn: one being dragged keeps the axis it was grabbed on, at its live value. */
  private live(h: HandleSpec): { h: HandleSpec; value: number } {
    return this.dragging?.h.id === h.id ? this.dragging : { h, value: h.value };
  }

  /** Where a handle's arrow runs on screen now: from the tip to the arrow's end (client pixels). */
  private arrowOnScreen(handle: HandleSpec, project: (p: Vec3) => { x: number; y: number } | null, wpp: number) {
    const { h, value } = this.live(handle);
    const tip = handleTip(h, value);
    const end: Vec3 = [tip[0] + h.dir[0] * ARROW_PX * wpp, tip[1] + h.dir[1] * ARROW_PX * wpp, tip[2] + h.dir[2] * ARROW_PX * wpp];
    return { a: project(tip), b: project(end) };
  }

  /** The handle whose arrow is under the pointer, if any. */
  hit(x: number, y: number, project: (p: Vec3) => { x: number; y: number } | null, wpp: number): HandleSpec | null {
    let best: { h: HandleSpec; d: number } | null = null;
    for (const h of this.handles) {
      const { a, b } = this.arrowOnScreen(h, project, wpp);
      if (!a || !b) continue;
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const l2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / l2));
      const d = Math.hypot(a.x + vx * t - x, a.y + vy * t - y);
      if (d <= GRAB_PX && (!best || d < best.d)) best = { h, d };
    }
    return best?.h ?? null;
  }

  /** Where a handle's arrow is on screen, `at` of the way from its tip to its end (0.6: on the shaft, to grab it; 0.85: in its head), for tests and for typing a value there. */
  tipOnScreen(id: string, project: (p: Vec3) => { x: number; y: number } | null, wpp: number, at = 0.6): { x: number; y: number } | null {
    const h = this.handles.find((x) => x.id === id);
    if (!h) return null;
    const { a, b } = this.arrowOnScreen(h, project, wpp);
    return a && b ? { x: a.x + (b.x - a.x) * at, y: a.y + (b.y - a.y) * at } : null;
  }

  /** After each render: arrows sized to the screen, the ruler, labels where their points are. */
  update(camera: THREE.Camera, wpp: number, w: number, h: number) {
    for (const hs of this.handles) {
      const a = this.arrows.get(hs.id);
      if (!a) continue;
      const { h: spec, value } = this.live(hs);
      const tip = new THREE.Vector3(...handleTip(spec, value));
      const dir = new THREE.Vector3(...spec.dir).normalize();
      const len = ARROW_PX * wpp;
      const head = HEAD_PX * wpp;
      // The rod from the tip to the head's base (a unit cylinder along Y, centred: scaled and stood on the tip).
      a.shaft.position.copy(tip).addScaledVector(dir, (len - head) / 2);
      a.shaft.quaternion.setFromUnitVectors(ALONG_Y, dir);
      a.shaft.scale.set(SHAFT_PX * wpp, len - head, SHAFT_PX * wpp);
      a.head.position.copy(tip).addScaledVector(dir, len - head / 2);
      a.head.quaternion.setFromUnitVectors(ALONG_Y, dir);
      a.head.scale.setScalar(head);
    }
    this.drawRuler(wpp);
    const place = (t: Tag) => {
      const v = new THREE.Vector3(...t.at).project(camera);
      t.el.style.display = v.z < 1 ? "" : "none";
      t.el.style.transform = `translate(${((v.x + 1) / 2) * w + t.dx}px, ${((1 - v.y) / 2) * h + t.dy}px)`;
    };
    for (const t of [...this.tags, ...this.dimTags, ...this.handleTags]) place(t);
  }

  /** While a handle is dragged: ticks along its axis from where the value is 0 to where it is now. */
  private drawRuler(wpp: number) {
    this.clear(this.rulerGroup);
    const d = this.dragging;
    if (!d) return;
    const h = d.h;
    const step = rulerStep(1 / (wpp * h.scale));
    const dir = new THREE.Vector3(...h.dir).normalize();
    const side = new THREE.Vector3().crossVectors(dir, Math.abs(dir.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)).normalize();
    const pts: number[] = [];
    const at = (v: number) => new THREE.Vector3(...handleTip(h, v));
    const lo = Math.min(0, d.value);
    const hi = Math.max(0, d.value);
    const p0 = at(lo);
    const p1 = at(hi);
    pts.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
    const first = Math.ceil(lo / step);
    for (let k = first; k * step <= hi + 1e-9 && k - first < 400; k++) {
      const p = at(k * step);
      const big = k % 5 === 0 ? 9 : 5;
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
