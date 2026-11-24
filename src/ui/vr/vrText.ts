// Words in VR: a label that always faces you (a dimension's length, a pin's
// note), and the menu panel, both drawn on a canvas. Browser only.

import * as THREE from "three";
import { noteWidth, wrapText } from "./wrap";

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

/**
 * A pin's label: its kind (Note, Too tight...) on the pin's colour, and under it what was written, wrapped to a tidy
 * block and sized to it (a word or two on one line; a longer note a few lines; at most eight, then "…"). `unit` is how
 * big a pixel of the canvas is in whatever holds it, so every label's writing is the same size.
 */
export function pinSprite(kind: string, text: string, color: string, unit: number): THREE.Sprite {
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  const head = 46;
  const body = 52;
  const pad = 26;
  const lineH = body * 1.22;
  const hf = `700 ${head}px system-ui, sans-serif`;
  const bf = `500 ${body}px system-ui, sans-serif`;
  g.font = bf;
  const measure = (t: string) => g.measureText(t).width;
  const note = text.trim();
  const lines = note ? wrapText(note, noteWidth(note, measure, lineH, 860, 300), measure, 8) : [];
  const bodyW = lines.length ? Math.max(...lines.map(measure)) : 0;
  g.font = hf;
  const headW = g.measureText(kind).width;
  c.width = Math.ceil(pad * 2 + Math.max(headW, bodyW));
  c.height = Math.ceil(pad * 2 + head * 1.1 + (lines.length ? pad * 0.4 + lines.length * lineH : 0));
  g.fillStyle = color;
  g.beginPath();
  g.roundRect(0, 0, c.width, c.height, 24);
  g.fill();
  g.textBaseline = "alphabetic";
  g.font = hf;
  g.fillStyle = "#ffffff";
  g.fillText(kind, pad, pad + head * 0.85);
  if (lines.length) {
    // What was written: on a darker band, so a long note reads as its own block under the kind.
    const top = pad + head * 1.1 + pad * 0.2;
    g.fillStyle = "rgba(0,0,0,0.28)";
    g.beginPath();
    g.roundRect(pad * 0.5, top, c.width - pad, c.height - top - pad * 0.5, 16);
    g.fill();
    g.font = bf;
    g.fillStyle = "#ffffff";
    lines.forEach((l, i) => g.fillText(l, pad, top + pad * 0.2 + lineH * (i + 0.8)));
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(c.width * unit, c.height * unit, 1);
  s.renderOrder = 30;
  s.userData.lines = lines.length;
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
  /** A text box under the title (typing a note), with a caret at its end; null: none. */
  field: string | null = null;

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
    if (this.field !== null) {
      // The box, and the end of what is typed in it (the start runs off to the left, after "…").
      const [x, y, w, h] = [36, 96, W - 72, 64];
      g.fillStyle = "#0b0d12";
      g.beginPath();
      g.roundRect(x, y, w, h, 14);
      g.fill();
      g.strokeStyle = "#2f81f7";
      g.lineWidth = 3;
      g.stroke();
      g.font = "500 32px system-ui, sans-serif";
      g.fillStyle = this.field ? "#f4f6fa" : "#6b7480";
      let t = this.field || "Type your note…";
      const room = w - 40;
      if (this.field && g.measureText(t).width > room) {
        while (t.length > 1 && g.measureText(`…${t}`).width > room) t = t.slice(1);
        t = `…${t}`;
      }
      g.fillText(t, x + 18, y + h / 2 + 1);
      const cx = x + 18 + (this.field ? g.measureText(t).width + 4 : 0);
      g.fillStyle = "#4fc3f7";
      g.fillRect(cx, y + 14, 3, h - 28);
    }
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
