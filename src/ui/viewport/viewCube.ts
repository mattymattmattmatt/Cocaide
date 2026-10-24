// The view cube in the view's top right corner, and the orientation triad in
// its bottom left: both turn with the camera. The cube is CSS 3D (crisp text
// at any size, no second renderer): each face is a 3 × 3 grid whose middle
// is that face's view, whose sides are its edges and whose corners are its
// corners, so all 26 orientations are a click away (an edge or corner lights
// up on every face it is on). Round it, on hover: arrows that turn the view
// 90° (left, right, up, down), two that roll it 90°, and Home (isometric,
// fitted). The triad is SVG: red X, green Y, blue Z; click an axis to look
// along it, again for the other side.

import * as THREE from "three";
import { CUBE_FACE_AXES, CUBE_FACES, cubeCell, type Axis, type CubeFace, type CubeTarget } from "./views";

/** A face's side, pixels. */
const FACE = 62;
/** Corner and edge cells' share of a face's side (each); the middle gets the rest. */
const RIM = 0.24;

const FACE_LABEL: Record<CubeFace, string> = { front: "Front", back: "Back", left: "Left", right: "Right", top: "Top", bottom: "Bottom" };

export type CubeTurn = "left" | "right" | "up" | "down" | "cw" | "ccw";

export interface ViewCubeHandlers {
  pick(t: CubeTarget): void;
  turn(kind: CubeTurn): void;
  home(): void;
}

const svg = (paths: string, size = 14) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const TURNS: { kind: CubeTurn; title: string; icon: string }[] = [
  { kind: "up", title: "Turn the view 90° up (Shift+↑)", icon: svg('<path d="M6 15l6-6 6 6" fill="currentColor" stroke-width="1.5"/>') },
  { kind: "down", title: "Turn the view 90° down (Shift+↓)", icon: svg('<path d="M6 9l6 6 6-6" fill="currentColor" stroke-width="1.5"/>') },
  { kind: "left", title: "Turn the view 90° left (Shift+←)", icon: svg('<path d="M15 6l-6 6 6 6" fill="currentColor" stroke-width="1.5"/>') },
  { kind: "right", title: "Turn the view 90° right (Shift+→)", icon: svg('<path d="M9 6l6 6-6 6" fill="currentColor" stroke-width="1.5"/>') },
  { kind: "ccw", title: "Roll the view 90° anticlockwise", icon: svg('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 3v4h4"/>') },
  { kind: "cw", title: "Roll the view 90° clockwise", icon: svg('<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 3v4h-4"/>') },
];

const fmt = (x: number) => (Math.abs(x) < 1e-9 ? 0 : x).toFixed(6);

export class ViewCube {
  readonly el: HTMLDivElement;
  private readonly cube: HTMLDivElement;
  private readonly faces = new Map<CubeFace, HTMLDivElement>();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly back = new THREE.Vector3();
  private last = "";

  constructor(host: HTMLElement, private readonly handlers: ViewCubeHandlers) {
    this.el = document.createElement("div");
    this.el.className = "view-cube";
    this.el.dataset.testid = "view-cube";
    this.el.setAttribute("role", "group");
    this.el.setAttribute("aria-label", "View cube: click a face, an edge or a corner to look from there");
    // The view's own pointer handling (orbit, pick, box) stays off the cube.
    for (const type of ["pointerdown", "pointerup", "dblclick", "wheel", "contextmenu"]) this.el.addEventListener(type, (e) => e.stopPropagation());
    this.el.addEventListener("contextmenu", (e) => e.preventDefault());

    const stage = document.createElement("div");
    stage.className = "cube-stage";
    this.cube = document.createElement("div");
    this.cube.className = "cube";
    stage.appendChild(this.cube);
    this.el.appendChild(stage);

    const edge = FACE * RIM;
    const sizes = [edge, FACE - 2 * edge, edge];
    const offsets = [0, edge, FACE - edge];
    for (const face of CUBE_FACES) {
      const { n, x, y } = CUBE_FACE_AXES[face];
      const h = FACE / 2;
      const t = [0, 1, 2].map((i) => n[i] * h - x[i] * h - y[i] * h);
      const f = document.createElement("div");
      f.className = `cube-face ${face}`;
      f.style.width = f.style.height = `${FACE}px`;
      f.style.transform = `matrix3d(${[x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, n[0], n[1], n[2], 0, t[0], t[1], t[2], 1].map(fmt).join(",")})`;
      const label = document.createElement("span");
      label.className = "cube-label";
      label.textContent = FACE_LABEL[face];
      f.appendChild(label);
      for (let row = 0; row < 3; row++)
        for (let col = 0; col < 3; col++) {
          const target = cubeCell(face, col, row);
          const cell = document.createElement("div");
          cell.className = `cube-cell ${target.kind}`;
          cell.dataset.key = target.key;
          cell.dataset.testid = target.kind === "face" ? `cube-face-${face}` : `cube-${face}-${col}${row}`;
          cell.title = `${target.label}${target.kind === "face" ? " view" : ""}`;
          Object.assign(cell.style, { left: `${offsets[col]}px`, top: `${offsets[row]}px`, width: `${sizes[col]}px`, height: `${sizes[row]}px` });
          cell.addEventListener("pointerenter", () => this.light(target.key, true));
          cell.addEventListener("pointerleave", () => this.light(target.key, false));
          cell.addEventListener("click", (e) => {
            e.stopPropagation();
            this.handlers.pick(target);
          });
          f.appendChild(cell);
        }
      this.cube.appendChild(f);
      this.faces.set(face, f);
    }

    for (const t of TURNS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `cube-turn ${t.kind}`;
      b.title = t.title;
      b.setAttribute("aria-label", t.title);
      b.dataset.testid = `cube-turn-${t.kind}`;
      b.innerHTML = t.icon;
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.handlers.turn(t.kind);
      });
      this.el.appendChild(b);
    }
    const home = document.createElement("button");
    home.type = "button";
    home.className = "cube-turn home";
    home.title = "Home: the isometric view, fitted (Ctrl+7)";
    home.setAttribute("aria-label", "Home view");
    home.dataset.testid = "cube-home";
    home.innerHTML = svg('<path d="M4 11l8-7 8 7"/><path d="M6 10v9h12v-9"/>');
    home.addEventListener("mousedown", (e) => e.preventDefault());
    home.addEventListener("click", (e) => {
      e.stopPropagation();
      this.handlers.home();
    });
    this.el.appendChild(home);
    host.appendChild(this.el);
  }

  /** Lights up a target on every face it is on (an edge on two, a corner on three). */
  private light(key: string, on: boolean) {
    for (const c of this.el.querySelectorAll<HTMLElement>(`.cube-cell[data-key="${key}"]`)) c.classList.toggle("hot", on);
  }

  setVisible(v: boolean) {
    this.el.hidden = !v;
  }

  /** Turns the cube with the camera (its world matrix current). */
  update(camera: THREE.Camera) {
    if (this.el.hidden) return;
    camera.matrixWorld.extractBasis(this.right, this.up, this.back);
    const r = this.right;
    const u = this.up;
    const b = this.back;
    const m = `matrix3d(${[r.x, -u.x, b.x, 0, r.y, -u.y, b.y, 0, r.z, -u.z, b.z, 0, 0, 0, 0, 1].map(fmt).join(",")})`;
    if (m === this.last) return;
    this.last = m;
    this.cube.style.transform = m;
    // Only the faces turned toward you take clicks and show; the more square to you, the lighter.
    for (const [face, el] of this.faces) {
      const n = CUBE_FACE_AXES[face].n;
      const facing = n[0] * b.x + n[1] * b.y + n[2] * b.z;
      const shown = facing > 0.04;
      el.style.visibility = shown ? "visible" : "hidden";
      el.style.setProperty("--facing", facing.toFixed(3));
      el.classList.toggle("square", facing > 0.9999);
    }
  }

  dispose() {
    this.el.remove();
  }
}

const AXES: { axis: Axis; color: string; v: THREE.Vector3 }[] = [
  { axis: "x", color: "#e5484d", v: new THREE.Vector3(1, 0, 0) },
  { axis: "y", color: "#30a46c", v: new THREE.Vector3(0, 1, 0) },
  { axis: "z", color: "#3e63dd", v: new THREE.Vector3(0, 0, 1) },
];
const NS = "http://www.w3.org/2000/svg";
/** The triad's box and arm, pixels. */
const TRIAD = 104;
const ARM = 36;

/** The orientation triad: X, Y and Z arrows turning with the camera; click one to look along it. */
export class Triad {
  readonly el: SVGSVGElement;
  private readonly arms = new Map<Axis, { g: SVGGElement; hit: SVGLineElement; line: SVGLineElement; head: SVGPolygonElement; dot: SVGCircleElement; text: SVGTextElement }>();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly back = new THREE.Vector3();
  private last = "";

  constructor(host: HTMLElement, onAxis: (axis: Axis) => void) {
    this.el = document.createElementNS(NS, "svg");
    this.el.setAttribute("class", "view-triad");
    this.el.setAttribute("width", String(TRIAD));
    this.el.setAttribute("height", String(TRIAD));
    this.el.setAttribute("viewBox", `${-TRIAD / 2} ${-TRIAD / 2} ${TRIAD} ${TRIAD}`);
    this.el.setAttribute("role", "group");
    this.el.setAttribute("aria-label", "Orientation: click an axis to look along it, again for the other side");
    this.el.dataset.testid = "triad";
    for (const type of ["pointerdown", "pointerup", "dblclick", "wheel", "contextmenu"]) this.el.addEventListener(type, (e) => e.stopPropagation());
    const origin = document.createElementNS(NS, "circle");
    origin.setAttribute("r", "2.6");
    origin.setAttribute("class", "triad-origin");
    for (const { axis, color } of AXES) {
      const g = document.createElementNS(NS, "g");
      g.setAttribute("class", `triad-axis ${axis}`);
      g.dataset.testid = `triad-${axis}`;
      g.style.color = color;
      const title = document.createElementNS(NS, "title");
      title.textContent = `Look along ${axis.toUpperCase()} (again: from the other side)`;
      const hit = document.createElementNS(NS, "line");
      hit.setAttribute("class", "triad-hit");
      const line = document.createElementNS(NS, "line");
      line.setAttribute("class", "triad-line");
      const head = document.createElementNS(NS, "polygon");
      head.setAttribute("class", "triad-head");
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("r", "7.5");
      dot.setAttribute("class", "triad-dot");
      const text = document.createElementNS(NS, "text");
      text.setAttribute("class", "triad-text");
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dominant-baseline", "central");
      text.textContent = axis.toUpperCase();
      g.append(title, hit, line, head, dot, text);
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        onAxis(axis);
      });
      this.el.appendChild(g);
      this.arms.set(axis, { g, hit, line, head, dot, text });
    }
    this.el.appendChild(origin);
    host.appendChild(this.el);
  }

  /** Turns the triad with the camera (its world matrix current). */
  update(camera: THREE.Camera) {
    camera.matrixWorld.extractBasis(this.right, this.up, this.back);
    const key = [this.right, this.up].map((v) => v.toArray().map((x) => x.toFixed(4)).join(",")).join(";");
    if (key === this.last) return;
    this.last = key;
    const order = AXES.map(({ axis, v }) => ({ axis, x: v.dot(this.right), y: -v.dot(this.up), z: v.dot(this.back) })).sort((a, b) => a.z - b.z);
    for (const { axis, x, y, z } of order) {
      const a = this.arms.get(axis)!;
      const len = Math.hypot(x, y);
      const ex = x * ARM;
      const ey = y * ARM;
      // The arrow stops short of its label; pointing at you, it is just the label (and dims a little pointing away).
      const ux = len > 1e-6 ? x / len : 0;
      const uy = len > 1e-6 ? y / len : 0;
      const tipX = ex - ux * 9;
      const tipY = ey - uy * 9;
      const shaft = Math.max(0, len * ARM - 9);
      a.line.setAttribute("x1", "0");
      a.line.setAttribute("y1", "0");
      a.line.setAttribute("x2", String(tipX - ux * 5));
      a.line.setAttribute("y2", String(tipY - uy * 5));
      a.hit.setAttribute("x1", "0");
      a.hit.setAttribute("y1", "0");
      a.hit.setAttribute("x2", String(ex));
      a.hit.setAttribute("y2", String(ey));
      const px = -uy * 3.4;
      const py = ux * 3.4;
      a.head.setAttribute("points", shaft > 4 ? `${tipX},${tipY} ${tipX - ux * 6 + px},${tipY - uy * 6 + py} ${tipX - ux * 6 - px},${tipY - uy * 6 - py}` : "");
      a.dot.setAttribute("cx", String(ex));
      a.dot.setAttribute("cy", String(ey));
      a.text.setAttribute("x", String(ex));
      a.text.setAttribute("y", String(ey + 0.5));
      a.g.style.opacity = z < -0.2 ? "0.6" : "1";
      // Painted far to near.
      this.el.insertBefore(a.g, this.el.lastChild);
    }
  }

  dispose() {
    this.el.remove();
  }
}
