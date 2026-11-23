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

/** VR's colours: measures amber, pointing and hover cyan, the dark glass everything floats on. */
export const VR_COLORS = { measure: "#ffc53d", hover: "#4fc3f7", glass: "rgba(16,18,24,0.9)", text: "#f4f6fa", dim: "#97a1ae", accent: "#2f81f7" };

/**
 * A card facing you: a number big (`value`), a few words small under it (`caption`, optional), on dark glass with a
 * coloured bar down its left. Its size is set by its writing, not its width: `unit` is how big a pixel of the canvas is
 * in whatever holds it (mm in the model, m in the room), so every card's writing is the same size.
 */
export function cardSprite(value: string, caption: string, accent: string, unit: number): THREE.Sprite {
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  const big = 64;
  const small = 40;
  const pad = 26;
  const bar = 10;
  const vf = `700 ${big}px system-ui, sans-serif`;
  const cf = `500 ${small}px system-ui, sans-serif`;
  g.font = vf;
  const vw = g.measureText(value).width;
  g.font = cf;
  const cw = caption ? g.measureText(caption).width : 0;
  c.width = Math.ceil(bar + pad * 2 + Math.max(vw, cw));
  c.height = Math.ceil(pad * 1.5 + big + (caption ? small * 1.35 : 0));
  const r = 22;
  g.fillStyle = VR_COLORS.glass;
  g.beginPath();
  g.roundRect(0, 0, c.width, c.height, r);
  g.fill();
  g.strokeStyle = "rgba(255,255,255,0.10)";
  g.lineWidth = 2;
  g.stroke();
  // The bar: the card's colour, down its left edge.
  g.save();
  g.beginPath();
  g.roundRect(0, 0, c.width, c.height, r);
  g.clip();
  g.fillStyle = accent;
  g.fillRect(0, 0, bar, c.height);
  g.restore();
  g.textBaseline = "alphabetic";
  g.font = vf;
  g.fillStyle = VR_COLORS.text;
  g.fillText(value, bar + pad, pad * 0.75 + big * 0.86);
  if (caption) {
    g.font = cf;
    g.fillStyle = VR_COLORS.dim;
    g.fillText(caption, bar + pad, pad * 0.75 + big + small * 1.05);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(c.width * unit, c.height * unit, 1);
  s.renderOrder = 37;
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
    g.fillStyle = "rgba(16,18,24,0.95)";
    g.beginPath();
    g.roundRect(0, 0, W, H, 36);
    g.fill();
    g.strokeStyle = "rgba(255,255,255,0.10)";
    g.lineWidth = 3;
    g.stroke();
    g.fillStyle = "#f4f6fa";
    g.font = "700 38px system-ui, sans-serif";
    g.textBaseline = "middle";
    g.fillText(this.title, 36, 46);
    g.fillStyle = "rgba(255,255,255,0.08)";
    g.fillRect(36, 80, W - 72, 2);
    for (const b of this.buttons) {
      const [x, y, w, h] = [b.x * W, b.y * H, b.w * W, b.h * H];
      g.fillStyle = b.on ? (b.color ?? "#2f81f7") : this.hover === b.id ? "#303644" : "#222631";
      g.beginPath();
      g.roundRect(x, y, w, h, 18);
      g.fill();
      if (this.hover === b.id) {
        g.strokeStyle = "#4fc3f7";
        g.lineWidth = 4;
        g.stroke();
      }
      g.fillStyle = b.on ? "#fff" : "#dfe4ec";
      g.font = `${b.on ? 700 : 600} 29px system-ui, sans-serif`;
      g.textAlign = "center";
      g.fillText(b.label, x + w / 2, y + h / 2 + 1);
      g.textAlign = "start";
    }
    g.fillStyle = "#8b95a3";
    g.font = "400 23px system-ui, sans-serif";
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
