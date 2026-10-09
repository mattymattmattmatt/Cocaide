// The reference geometry in the 3D view, drawn as SOLIDWORKS draws it:
// planes as translucent rectangles with a crisp border (and a label, placed
// by the viewport as HTML), axes as dash-dot lines, points as small markers,
// the origin as a red-green-blue triad. A selected one is orange, the one
// under the pointer blue.
//
// Picking happens on the screen, in pixels: a plane's border, an axis, a
// point or the origin is a firm hit (it beats the part behind it, never the
// part in front of it); a plane's inside is a soft hit, taken only when
// nothing of the part is under the pointer. So planes never get in the way
// of picking the part.

import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import type { Vec3 } from "../../doc/types";
import type { DatumShape } from "../model/datumDisplay";

export interface DatumColors {
  /** A plane's fill and border, an axis, a point marker. */
  plane: number;
  border: number;
  axis: number;
  point: number;
  select: number;
  hover: number;
}

/** What the pointer is over: a datum, where, how far along the pick ray, and whether it is firm (a border, an axis, a point). */
export interface DatumHit {
  id: string;
  point: Vec3;
  distance: number;
  firm: boolean;
}

/** A world point on the screen: client pixels, or null behind the camera. */
export type Projector = (p: Vec3) => { x: number; y: number } | null;

/** One label to place over the view. */
export interface DatumLabel {
  key: string;
  at: Vec3;
  text: string;
  className: string;
}

const AXIS_COLORS = { x: 0xe5484d, y: 0x30a46c, z: 0x3e63dd };

/** Squared distance from p to the segment ab (2D), and where along it (0..1). */
function toSegment(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): { d: number; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2));
  const qx = a.x + t * dx - px;
  const qy = a.y + t * dy - py;
  return { d: Math.sqrt(qx * qx + qy * qy), t };
}

const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** A small round marker with a cross, for reference points (a canvas texture; null outside a browser). */
function markerTexture(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  if (!g) return null;
  g.strokeStyle = "#fff";
  g.lineWidth = 3;
  g.beginPath();
  g.arc(16, 16, 9, 0, Math.PI * 2);
  g.moveTo(16, 3);
  g.lineTo(16, 29);
  g.moveTo(3, 16);
  g.lineTo(29, 16);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class DatumLayer {
  readonly group = new THREE.Group();
  private shapes: DatumShape[] = [];
  /** The origin triad's arm length, or null when the origin is hidden. */
  private originSize: number | null = null;
  private selected = new Set<string>();
  private hovered: string | null = null;
  private readonly resolution = new THREE.Vector2(1, 1);
  private materials: LineMaterial[] = [];
  private readonly marker = markerTexture();

  constructor(private readonly colors: DatumColors) {
    this.group.name = "datums";
  }

  /** What to draw: the shapes (already filtered to the shown ones) and the origin triad's size (null: hidden). */
  set(shapes: DatumShape[], originSize: number | null): void {
    this.shapes = shapes;
    this.originSize = originSize;
    this.redraw();
  }

  /** The selected and hovered ones, highlighted. */
  mark(selected: readonly string[], hovered: string | null): void {
    const same = selected.length === this.selected.size && selected.every((id) => this.selected.has(id)) && hovered === this.hovered;
    if (same) return;
    this.selected = new Set(selected);
    this.hovered = hovered;
    this.redraw();
  }

  /** Fat lines need the canvas size, in pixels. */
  resize(w: number, h: number): void {
    this.resolution.set(w, h);
    for (const m of this.materials) m.resolution.copy(this.resolution);
  }

  /** Ids drawn now, in order (the origin as "Origin"). */
  ids(): string[] {
    return [...this.shapes.map((s) => s.id), ...(this.originSize !== null ? ["Origin"] : [])];
  }

  /** The labels to place over the view: each plane's, axis's and point's name, and the triad's X, Y, Z. */
  labels(): DatumLabel[] {
    const out: DatumLabel[] = this.shapes.map((s) => ({
      key: s.id,
      at: s.label,
      text: s.id,
      className: `datum-label ${s.kind}${this.selected.has(s.id) ? " selected" : this.hovered === s.id ? " hovered" : ""}`,
    }));
    if (this.originSize !== null) {
      const k = this.originSize * 1.18;
      out.push(
        { key: "triad-x", at: [k, 0, 0], text: "X", className: "datum-label triad x" },
        { key: "triad-y", at: [0, k, 0], text: "Y", className: "datum-label triad y" },
        { key: "triad-z", at: [0, 0, k], text: "Z", className: "datum-label triad z" },
      );
    }
    return out;
  }

  /**
   * What datum is under the pointer at client pixels (px, py): borders, axes,
   * points and the origin within `pixels` are firm hits; a plane's inside
   * (where the ray meets it) is soft. The nearest firm hit wins, else the
   * nearest soft one.
   */
  pick(px: number, py: number, project: Projector, ray: THREE.Ray, pixels: number): DatumHit | null {
    const along = (p: Vec3) => new THREE.Vector3(...p).sub(ray.origin).dot(ray.direction);
    let firm: DatumHit | null = null;
    let soft: DatumHit | null = null;
    const take = (hit: DatumHit) => {
      if (hit.firm) {
        if (!firm || hit.distance < firm.distance) firm = hit;
      } else if (!soft || hit.distance < soft.distance) soft = hit;
    };
    const nearPoint = (id: string, at: Vec3, slack: number) => {
      const s = project(at);
      if (s && Math.hypot(s.x - px, s.y - py) <= pixels + slack) take({ id, point: at, distance: along(at), firm: true });
    };
    const nearSegment = (id: string, a: Vec3, b: Vec3) => {
      const sa = project(a);
      const sb = project(b);
      if (!sa || !sb) return;
      const { d, t } = toSegment(px, py, sa, sb);
      if (d <= pixels) {
        const p = lerp(a, b, t);
        take({ id, point: p, distance: along(p), firm: true });
      }
    };
    for (const s of this.shapes) {
      if (s.kind === "point") nearPoint(s.id, s.at, 3);
      else if (s.kind === "axis") nearSegment(s.id, s.ends[0], s.ends[1]);
      else {
        const c = s.corners;
        for (let i = 0; i < 4; i++) nearSegment(s.id, c[i], c[(i + 1) % 4]);
        // Inside: where the ray meets the plane, within the rectangle.
        const n = new THREE.Vector3(...s.normal);
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(...c[0]));
        const hit = ray.intersectPlane(plane, new THREE.Vector3());
        if (hit) {
          const o = new THREE.Vector3(...c[0]);
          const u = new THREE.Vector3(...c[1]).sub(o);
          const v = new THREE.Vector3(...c[3]).sub(o);
          const h = hit.clone().sub(o);
          const a = h.dot(u) / u.lengthSq();
          const b = h.dot(v) / v.lengthSq();
          if (a >= 0 && a <= 1 && b >= 0 && b <= 1) take({ id: s.id, point: hit.toArray() as Vec3, distance: hit.clone().sub(ray.origin).dot(ray.direction), firm: false });
        }
      }
    }
    if (this.originSize !== null) {
      nearPoint("Origin", [0, 0, 0], 4);
      const k = this.originSize;
      for (const tip of [[k, 0, 0], [0, k, 0], [0, 0, k]] as Vec3[]) nearSegment("Origin", [0, 0, 0], tip);
    }
    return firm ?? soft;
  }

  dispose(): void {
    this.clear();
    this.marker?.dispose();
  }

  private clear(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      child.traverse((o) => {
        const obj = o as THREE.Mesh;
        obj.geometry?.dispose();
        const mat = obj.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
    }
    this.materials = [];
  }

  private line(points: Vec3[], color: number, width: number, opts: { depthTest?: boolean; opacity?: number; order?: number } = {}): LineSegments2 {
    const g = new LineSegmentsGeometry();
    g.setPositions(points.flat());
    const m = new LineMaterial({ color, linewidth: width, transparent: true, opacity: opts.opacity ?? 1, depthTest: opts.depthTest ?? true });
    m.resolution.copy(this.resolution);
    this.materials.push(m);
    const l = new LineSegments2(g, m);
    l.renderOrder = opts.order ?? 2;
    return l;
  }

  private state(id: string): "selected" | "hovered" | "plain" {
    return this.selected.has(id) ? "selected" : this.hovered === id ? "hovered" : "plain";
  }

  private redraw(): void {
    this.clear();
    const c = this.colors;
    for (const s of this.shapes) {
      const st = this.state(s.id);
      const tint = st === "selected" ? c.select : st === "hovered" ? c.hover : null;
      if (s.kind === "plane") {
        const [a, b, cc, d] = s.corners;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute([...a, ...b, ...cc, ...a, ...cc, ...d], 3));
        const fill = new THREE.Mesh(
          geo,
          new THREE.MeshBasicMaterial({
            color: tint ?? c.plane,
            transparent: true,
            opacity: tint ? 0.2 : 0.1,
            side: THREE.DoubleSide,
            depthWrite: false,
            // Behind a face it lies on (Top under the part's bottom): the face wins.
            polygonOffset: true,
            polygonOffsetFactor: 2,
            polygonOffsetUnits: 2,
          }),
        );
        fill.renderOrder = 1;
        this.group.add(fill, this.line([a, b, b, cc, cc, d, d, a], tint ?? c.border, tint ? 2.4 : 1.4, { opacity: tint ? 1 : 0.85 }));
      } else if (s.kind === "axis") {
        // Dash-dot: a long dash, a gap, a dot, a gap, along the axis.
        const [a, b] = s.ends;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        const period = Math.max(len / 16, 1e-6);
        const pts: Vec3[] = [];
        for (let t = 0; t < len; t += period) {
          const at = (x: number) => lerp(a, b, Math.min(1, x / len));
          pts.push(at(t), at(t + period * 0.62), at(t + period * 0.76), at(t + period * 0.82));
        }
        this.group.add(this.line(pts, tint ?? c.axis, tint ? 2.4 : 1.6));
      } else {
        const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...s.at)]);
        const dot = new THREE.Points(g, new THREE.PointsMaterial({ color: tint ?? c.point, size: tint ? 15 : 12, sizeAttenuation: false, depthTest: false, transparent: true, map: this.marker ?? undefined }));
        dot.renderOrder = 6;
        this.group.add(dot);
      }
    }
    if (this.originSize !== null) {
      const k = this.originSize;
      const st = this.state("Origin");
      const width = st === "plain" ? 2 : 3;
      for (const [axis, tip] of [["x", [k, 0, 0]], ["y", [0, k, 0]], ["z", [0, 0, k]]] as [keyof typeof AXIS_COLORS, Vec3][]) {
        const color = st === "selected" ? c.select : st === "hovered" ? c.hover : AXIS_COLORS[axis];
        this.group.add(this.line([[0, 0, 0], tip], color, width, { depthTest: false, order: 5 }));
        // An arrowhead at the tip.
        const head = new THREE.Mesh(new THREE.ConeGeometry(k * 0.07, k * 0.22, 12), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }));
        head.position.set(...tip);
        head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...tip).normalize());
        head.renderOrder = 5;
        this.group.add(head);
      }
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]);
      const dot = new THREE.Points(g, new THREE.PointsMaterial({ color: st === "plain" ? 0x1f2937 : st === "selected" ? c.select : c.hover, size: 7, sizeAttenuation: false, depthTest: false }));
      dot.renderOrder = 6;
      this.group.add(dot);
    }
  }
}
