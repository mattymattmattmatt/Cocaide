// Appearances: how a part, a body, the faces a feature makes or an assembly
// component look (colour, opacity, finish). Never geometry: the rebuild, the
// mass and the drawings' line work don't read them. Pure.
//
// What a face shows, most particular first:
//   1. the appearance of the feature that made it (a hole's walls, a fillet),
//      on the body that feature built, if it builds one;
//   2. its body's own appearance;
//   3. its body's own material's appearance;
//   4. the part's appearance;
//   5. the part's material's appearance;
//   6. nothing: the viewport's default (a colour per body, or the part grey).
// In an assembly a component's own appearance is over all of its part's.

import type { Appearance, AppearanceFinish } from "../doc/types";
import { APPEARANCE_FINISHES } from "../doc/types";

export type { Appearance, AppearanceFinish };
export { APPEARANCE_FINISHES };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const HEX = /^#[0-9a-f]{6}$/i;

/** An appearance as stored, or null when it isn't one. */
export function asAppearance(v: unknown): Appearance | null {
  if (!isObject(v) || typeof v.color !== "string" || !HEX.test(v.color)) return null;
  const out: Appearance = { color: v.color.toLowerCase() };
  if (typeof v.opacity === "number" && v.opacity >= 0.1 && v.opacity < 1) out.opacity = v.opacity;
  if (APPEARANCE_FINISHES.includes(v.finish as AppearanceFinish) && v.finish !== "satin") out.finish = v.finish as AppearanceFinish;
  return out;
}

/** Two appearances alike (same colour, opacity and finish). */
export function sameAppearance(a: Appearance | null | undefined, b: Appearance | null | undefined): boolean {
  return appearanceKey(a) === appearanceKey(b);
}

/** A key for grouping alike appearances ("" for none). */
export function appearanceKey(a: Appearance | null | undefined): string {
  return a ? `${a.color.toLowerCase()}|${a.opacity ?? 1}|${a.finish ?? "satin"}` : "";
}

/** What a face needs to have its appearance found: the feature that made it and its body. */
export interface FaceOrigin {
  createdBy?: string;
  body?: string;
}

/** Where a face's appearance came from (for the picker's "inherited from"). */
export type AppearanceSource = "feature" | "body" | "bodyMaterial" | "part" | "material";

export interface ResolvedAppearance {
  appearance: Appearance;
  source: AppearanceSource;
  /** The feature, body or material it came from. */
  from?: string;
}

/** A part document's appearances, read once: resolve faces against it. */
export class PartAppearances {
  private readonly features = new Map<string, { look: Appearance; body?: string }>();
  private readonly bodies = new Map<string, Appearance>();
  private readonly bodyMaterials = new Map<string, { look: Appearance; name?: string }>();
  private readonly part: Appearance | null;
  private readonly material: { look: Appearance; name?: string } | null;

  constructor(doc: unknown) {
    const d = isObject(doc) ? doc : {};
    for (const f of Array.isArray(d.features) ? d.features : []) {
      if (!isObject(f) || typeof f.id !== "string" || f.suppressed === true) continue;
      const look = asAppearance(f.appearance);
      if (!look) continue;
      // A feature that builds a body (a member, a new body) colours that body's faces only: a member's joint cut
      // also names faces on the member it meets after it.
      const body = f.op === "member" ? (typeof f.newBody === "string" ? f.newBody : f.id) : typeof f.newBody === "string" ? f.newBody : undefined;
      this.features.set(f.id, { look, ...(body ? { body } : {}) });
    }
    if (isObject(d.bodyAppearances)) for (const [k, v] of Object.entries(d.bodyAppearances)) {
      const look = asAppearance(v);
      if (look) this.bodies.set(k, look);
    }
    if (isObject(d.bodyMaterials)) for (const [k, v] of Object.entries(d.bodyMaterials)) {
      const look = isObject(v) ? asAppearance(v.appearance) : null;
      if (look) this.bodyMaterials.set(k, { look, ...(isObject(v) && typeof v.name === "string" ? { name: v.name } : {}) });
    }
    this.part = asAppearance(d.appearance);
    const m = isObject(d.material) ? d.material : null;
    const ml = m ? asAppearance(m.appearance) : null;
    this.material = ml ? { look: ml, ...(typeof m!.name === "string" ? { name: m!.name } : {}) } : null;
  }

  /** Whether the part says anything about how it looks. */
  get any(): boolean {
    return this.features.size > 0 || this.bodies.size > 0 || this.bodyMaterials.size > 0 || !!this.part || !!this.material;
  }

  /** A face's appearance and where it came from; null: the viewport's default. */
  face(f: FaceOrigin): ResolvedAppearance | null {
    const feature = f.createdBy ? this.features.get(f.createdBy) : undefined;
    if (feature && (!feature.body || !f.body || feature.body === f.body)) return { appearance: feature.look, source: "feature", from: f.createdBy };
    return this.body(f.body);
  }

  /** A body's appearance (what its faces show unless a feature colours them); null: the default. */
  body(name: string | undefined): ResolvedAppearance | null {
    if (name !== undefined) {
      const own = this.bodies.get(name);
      if (own) return { appearance: own, source: "body", from: name };
      const mat = this.bodyMaterials.get(name);
      if (mat) return { appearance: mat.look, source: "bodyMaterial", ...(mat.name ? { from: mat.name } : {}) };
    }
    if (this.part) return { appearance: this.part, source: "part" };
    if (this.material) return { appearance: this.material.look, source: "material", ...(this.material.name ? { from: this.material.name } : {}) };
    return null;
  }

  /** What the part as a whole shows (its own, else its material's). */
  partLook(): ResolvedAppearance | null {
    if (this.part) return { appearance: this.part, source: "part" };
    if (this.material) return { appearance: this.material.look, source: "material", ...(this.material.name ? { from: this.material.name } : {}) };
    return null;
  }
}

/** Every face's appearance (null: the default), in the faces' order. */
export function faceAppearances(doc: unknown, faces: readonly FaceOrigin[]): (Appearance | null)[] {
  const p = new PartAppearances(doc);
  if (!p.any) return faces.map(() => null);
  return faces.map((f) => p.face(f)?.appearance ?? null);
}

// ------------------------------------------------------------------ the look

/** How a finish lights: three.js standard material numbers, and how much a reflected room shows in it. */
export function finishLight(finish: AppearanceFinish | undefined): { roughness: number; metalness: number; env: number } {
  switch (finish) {
    case "matte":
      return { roughness: 0.9, metalness: 0, env: 0 };
    case "gloss":
      return { roughness: 0.18, metalness: 0.05, env: 0.55 };
    case "metallic":
      return { roughness: 0.32, metalness: 0.85, env: 1 };
    default:
      return { roughness: 0.55, metalness: 0.15, env: 0 };
  }
}

/** "#rrggbb" to 0..1 sRGB channels. */
export function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** 0..1 sRGB channels to "#rrggbb". */
export function rgbToHex([r, g, b]: [number, number, number]): string {
  const c = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** An sRGB channel (0..1) in linear light, as OCCT's colours and STEP's writer take them. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Text on this colour: dark on a light one, light on a dark one. */
export function inkOn(hex: string): "#111827" | "#ffffff" {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.26 ? "#111827" : "#ffffff";
}

/** A typed colour, made "#rrggbb": "#abc", "abc", "aabbcc", "#AABBCC" all read; anything else is null. */
export function parseHex(text: string): string | null {
  const t = text.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(t)) return `#${t[0]}${t[0]}${t[1]}${t[1]}${t[2]}${t[2]}`;
  if (/^[0-9a-f]{6}$/.test(t)) return `#${t}`;
  return null;
}

// ------------------------------------------------------------------ the palette

export interface Swatch {
  name: string;
  appearance: Appearance;
}

/** The picker's swatches: neutrals, metals (with their finish), timbers and plain colours. */
export const SWATCH_GROUPS: { name: string; swatches: Swatch[] }[] = [
  {
    name: "Neutrals",
    swatches: [
      { name: "White", appearance: { color: "#f4f5f7" } },
      { name: "Light grey", appearance: { color: "#c4cad3" } },
      { name: "Mid grey", appearance: { color: "#8a919c" } },
      { name: "Graphite", appearance: { color: "#4a4f57" } },
      { name: "Black", appearance: { color: "#1d1f23" } },
    ],
  },
  {
    name: "Metals",
    swatches: [
      { name: "Steel", appearance: { color: "#8c939b", finish: "metallic" } },
      { name: "Stainless", appearance: { color: "#c9ced4", finish: "metallic" } },
      { name: "Aluminium", appearance: { color: "#d6d9dd", finish: "metallic" } },
      { name: "Galvanised", appearance: { color: "#b4bcc2", finish: "satin" } },
      { name: "Black oxide", appearance: { color: "#2b2d31", finish: "metallic" } },
      { name: "Brass", appearance: { color: "#c9a44c", finish: "metallic" } },
      { name: "Copper", appearance: { color: "#b8734a", finish: "metallic" } },
      { name: "Titanium", appearance: { color: "#9a9a92", finish: "metallic" } },
    ],
  },
  {
    name: "Timber",
    swatches: [
      { name: "Pine", appearance: { color: "#e2c18f", finish: "matte" } },
      { name: "Treated pine", appearance: { color: "#b9b27f", finish: "matte" } },
      { name: "Plywood", appearance: { color: "#d9b98a", finish: "matte" } },
      { name: "Oak", appearance: { color: "#b98a55", finish: "matte" } },
      { name: "Hardwood", appearance: { color: "#8f5a3a", finish: "matte" } },
      { name: "Walnut", appearance: { color: "#5e4130", finish: "matte" } },
      { name: "MDF", appearance: { color: "#b49a78", finish: "matte" } },
    ],
  },
  {
    name: "Colours",
    swatches: [
      { name: "Red", appearance: { color: "#d64545" } },
      { name: "Orange", appearance: { color: "#e8833a" } },
      { name: "Safety yellow", appearance: { color: "#f2c230" } },
      { name: "Green", appearance: { color: "#4f9d5d" } },
      { name: "Teal", appearance: { color: "#2f9c95" } },
      { name: "Sky blue", appearance: { color: "#5aa9e6" } },
      { name: "Blue", appearance: { color: "#2f6fd6" } },
      { name: "Navy", appearance: { color: "#26375e" } },
      { name: "Purple", appearance: { color: "#7d55c7" } },
      { name: "Pink", appearance: { color: "#d660a0" } },
    ],
  },
  {
    name: "Clear",
    swatches: [
      { name: "Clear glass", appearance: { color: "#cfe8f2", opacity: 0.35, finish: "gloss" } },
      { name: "Tinted", appearance: { color: "#6f8a96", opacity: 0.5, finish: "gloss" } },
      { name: "Frosted", appearance: { color: "#eef3f6", opacity: 0.6, finish: "matte" } },
    ],
  },
];

/** A swatch's name for an appearance it matches exactly, else null. */
export function swatchName(a: Appearance | null | undefined): string | null {
  if (!a) return null;
  for (const g of SWATCH_GROUPS) for (const s of g.swatches) if (sameAppearance(s.appearance, a)) return s.name;
  return null;
}

/** How a material looks by default, where its name says (the material picker's presets carry these). */
export const MATERIAL_APPEARANCES: Record<string, Appearance> = {
  steel: { color: "#8c939b", finish: "metallic" },
  "stainless steel": { color: "#c9ced4", finish: "metallic" },
  "aluminium 6061": { color: "#d6d9dd", finish: "metallic" },
  brass: { color: "#c9a44c", finish: "metallic" },
  copper: { color: "#b8734a", finish: "metallic" },
  titanium: { color: "#9a9a92", finish: "metallic" },
  nylon: { color: "#efece4" },
  "MGP pine (seasoned)": { color: "#e2c18f", finish: "matte" },
  "F-grade hardwood (unseasoned)": { color: "#8f5a3a", finish: "matte" },
  LVL: { color: "#d4b07c", finish: "matte" },
};
