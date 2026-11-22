// Words in VR: a label that always faces you (a dimension's length, a pin's
// note), and the menu panel, both drawn on a canvas. Browser only.

import * as THREE from "three";

/** A label facing you: `w` wide in the units of whatever holds it (its height follows the text). */
export function textSprite(text: string, w: number, opts: { bg?: string; fg?: string; size?: number } = {}): THREE.Sprite {
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  const size = opts.size ?? 56;
  g.font = `600 ${size}px system-ui, sans-serif`;
  const lines = text.split("\n");
  const tw = Math.max(...lines.map((l) => g.measureText(l).width));
  c.width = Math.ceil(tw + size * 1.2);
  c.height = Math.ceil(lines.length * size * 1.25 + size * 0.6);
  g.fillStyle = opts.bg ?? "rgba(20,22,26,0.85)";
  g.beginPath();
  g.roundRect(0, 0, c.width, c.height, size * 0.5);
  g.fill();
  g.font = `600 ${size}px system-ui, sans-serif`;
  g.fillStyle = opts.fg ?? "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  lines.forEach((l, i) => g.fillText(l, c.width / 2, size * 0.3 + size * 1.25 * (i + 0.5)));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(w, (w * c.height) / c.width, 1);
  s.renderOrder = 30;
  return s;
}

export function disposeSprite(s: THREE.Sprite): void {
  s.material.map?.dispose();
  s.material.dispose();
}

export interface PanelButton {
  id: string;
  label: string;
  /** Pressed (a tool in use, a switch that is on). */
  on?: boolean;
  /** Its box on the panel, 0–1 across and down. */
  x: number;
  y: number;
  w: number;
  h: number;
  color?: string;
}

/** A flat panel of buttons you point at: drawn on a canvas, hit by its uv. */
export class Panel {
  readonly mesh: THREE.Mesh;
  private canvas = document.createElement("canvas");
  private tex: THREE.CanvasTexture;
  buttons: PanelButton[] = [];
  hover: string | null = null;
  title = "";
  lines: string[] = [];

  constructor(widthM: number, heightM: number) {
    this.canvas.width = 1024;
    this.canvas.height = Math.round((1024 * heightM) / widthM);
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthM, heightM), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false }));
    this.mesh.renderOrder = 40;
    this.mesh.name = "vr-menu";
  }

  draw(): void {
    const g = this.canvas.getContext("2d")!;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = "rgba(24,26,31,0.94)";
    g.beginPath();
    g.roundRect(0, 0, W, H, 36);
    g.fill();
    g.fillStyle = "#fff";
    g.font = "700 40px system-ui, sans-serif";
    g.textBaseline = "middle";
    g.fillText(this.title, 36, 44);
    for (const b of this.buttons) {
      const [x, y, w, h] = [b.x * W, b.y * H, b.w * W, b.h * H];
      g.fillStyle = b.on ? (b.color ?? "#1f6feb") : this.hover === b.id ? "#3a3f48" : "#2b2f36";
      g.beginPath();
      g.roundRect(x, y, w, h, 18);
      g.fill();
      if (this.hover === b.id) {
        g.strokeStyle = "#8fb8ff";
        g.lineWidth = 4;
        g.stroke();
      }
      g.fillStyle = "#fff";
      g.font = "600 30px system-ui, sans-serif";
      g.textAlign = "center";
      g.fillText(b.label, x + w / 2, y + h / 2 + 1);
      g.textAlign = "start";
    }
    g.fillStyle = "#b8bec8";
    g.font = "400 24px system-ui, sans-serif";
    this.lines.forEach((l, i) => g.fillText(l, 36, H - 28 - (this.lines.length - 1 - i) * 32));
    this.tex.needsUpdate = true;
  }

  /** The button at a point of the panel (its uv). */
  at(uv: THREE.Vector2): PanelButton | null {
    const x = uv.x;
    const y = 1 - uv.y;
    return this.buttons.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) ?? null;
  }
}
