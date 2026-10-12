// The Hole Wizard's standard sizes: ISO metric screws, M3 to M24 (the first
// choice sizes of ISO 261, and M14). One row per size, everything a hole for
// that screw needs, so a hole names its screw ("M6") and its kind and the
// numbers come from here; a field given in the hole itself wins.
//
// - pitch: the coarse thread pitch (ISO 261 / ISO 262).
// - clearance: the through hole for the screw, ISO 273, for the three fits
//   (close = "fine", normal = "medium", loose = "coarse").
// - tapDrill: the drill for tapping the thread, the nominal diameter less one
//   pitch (ISO 2306's usual choice for 6H threads).
// - counterbore: diameter and depth for a socket head cap screw, ISO 4762
//   (its head is d high and dk across): room round the head, its top a
//   little below the face.
// - countersink: the 90° countersink for a countersunk socket head screw,
//   ISO 10642, a little wider than the head (that standard stops at M20).
//
// Pure data and arithmetic, no imports beyond types: the document layer,
// the kernel and the UI all read it.

export const HOLE_KINDS = ["simple", "counterbore", "countersink", "tapped"] as const;
export type HoleKind = (typeof HOLE_KINDS)[number];

export const HOLE_FITS = ["close", "normal", "loose"] as const;
export type HoleFit = (typeof HOLE_FITS)[number];

/** The thread class a tapped hole is called out with (ISO 965's medium tolerance for nuts and tapped holes). */
export const THREAD_CLASS = "6H";

/** The angle of a countersink for metric countersunk screws, degrees. */
export const COUNTERSINK_ANGLE = 90;

export interface ScrewSize {
  /** "M6". */
  size: string;
  /** Nominal (major) thread diameter, mm. */
  d: number;
  /** Coarse pitch, mm. */
  pitch: number;
  clearance: Record<HoleFit, number>;
  tapDrill: number;
  counterbore: { diameter: number; depth: number };
  /** None where ISO 10642 has no countersunk screw of the size. */
  countersink?: { diameter: number; angle: number };
}

const row = (
  size: string,
  d: number,
  pitch: number,
  [close, normal, loose]: [number, number, number],
  tapDrill: number,
  [cbore, cboreDepth]: [number, number],
  csink?: number,
): ScrewSize => ({
  size,
  d,
  pitch,
  clearance: { close, normal, loose },
  tapDrill,
  counterbore: { diameter: cbore, depth: cboreDepth },
  ...(csink !== undefined ? { countersink: { diameter: csink, angle: COUNTERSINK_ANGLE } } : {}),
});

/** The ISO metric sizes, smallest first. */
export const ISO_METRIC: readonly ScrewSize[] = [
  row("M3", 3, 0.5, [3.2, 3.4, 3.6], 2.5, [6.5, 3.3], 6.9),
  row("M4", 4, 0.7, [4.3, 4.5, 4.8], 3.3, [8, 4.4], 9.2),
  row("M5", 5, 0.8, [5.3, 5.5, 5.8], 4.2, [9.5, 5.4], 11.5),
  row("M6", 6, 1, [6.4, 6.6, 7], 5, [11, 6.5], 13.7),
  row("M8", 8, 1.25, [8.4, 9, 10], 6.8, [14, 8.6], 18.3),
  row("M10", 10, 1.5, [10.5, 11, 12], 8.5, [17.5, 10.8], 22.7),
  row("M12", 12, 1.75, [13, 13.5, 14.5], 10.2, [20, 13], 27.2),
  row("M14", 14, 2, [15, 15.5, 16.5], 12, [23, 15.2], 31.2),
  row("M16", 16, 2, [17, 17.5, 18.5], 14, [26, 17.5], 34),
  row("M20", 20, 2.5, [21, 22, 24], 17.5, [32, 21.5], 40.7),
  row("M24", 24, 3, [25, 26, 28], 21, [39, 25.5]),
];

/** The size names, in order: "M3", "M4", ... "M24". */
export const HOLE_SIZES: readonly string[] = ISO_METRIC.map((r) => r.size);

/** A size's row, or undefined. */
export function screwSize(size: string): ScrewSize | undefined {
  return ISO_METRIC.find((r) => r.size === size);
}

/** What a hole asks for: its size, kind and fit, and any numbers it gives itself (they win over the table). */
export interface HoleAsk {
  size?: string;
  kind?: HoleKind;
  fit?: HoleFit;
  diameter?: number;
  counterbore?: { diameter?: number; depth?: number };
  countersink?: { diameter?: number; angle?: number };
  thread?: { pitch?: number; depth?: number };
  /** The drill's depth, for a tapped hole's default thread depth: a number (blind), "through" or "upToNext". */
  depth?: number | string;
}

/** A tapped hole's thread, as drawings call it out. */
export interface ThreadSpec {
  /** The size and its pitch, "M6×1" ("M8×1" for a fine one): written out even for a coarse pitch, so the callout leaves no doubt. */
  designation: string;
  /** Major (nominal) diameter, mm. */
  major: number;
  pitch: number;
  /** "6H". */
  class: string;
  /** Thread depth, mm, or "through" (threaded as deep as the drill goes). */
  depth: number | "through";
}

/** The numbers of a hole: what the kernel cuts and the drawing calls out. */
export interface HoleSpec {
  kind: HoleKind;
  /** The bore: the clearance hole, or a tapped hole's tap drill. */
  diameter: number;
  counterbore?: { diameter: number; depth: number };
  countersink?: { diameter: number; angle: number };
  thread?: ThreadSpec;
}

/** The kind of a hole: given, or what its fields say (a counterbore makes a counterbored hole), else simple. */
export function holeKind(h: Pick<HoleAsk, "kind" | "counterbore" | "countersink" | "thread">): HoleKind {
  if (h.kind) return h.kind;
  if (h.counterbore) return "counterbore";
  if (h.countersink) return "countersink";
  if (h.thread) return "tapped";
  return "simple";
}

/**
 * The default thread depth of a tapped hole drilled `depth` deep: the drill's
 * depth less three pitches (a tap's lead does not cut a full thread), at least
 * one pitch; through all when the drill goes through.
 */
export function defaultThreadDepth(depth: number | string | undefined, pitch: number): number | "through" {
  if (typeof depth !== "number") return "through";
  return round(Math.max(pitch, depth - 3 * pitch));
}

/**
 * A hole's numbers from its size, kind and fit and the fields it gives, or
 * the reason they can't be worked out ("a tapped hole needs a size"). Every
 * number the hole gives wins over the table. Without a size, the hole gives
 * its own diameter (and counterbore or countersink in full), as before
 * sizes existed.
 */
export function holeSpec(h: HoleAsk): HoleSpec | string {
  const kind = holeKind(h);
  const std = h.size === undefined ? undefined : screwSize(h.size);
  if (h.size !== undefined && !std) return `unknown size "${h.size}" (ISO metric: ${HOLE_SIZES.join(", ")})`;
  const fit = h.fit ?? "normal";
  let diameter = h.diameter;
  if (diameter === undefined) {
    if (!std) return kind === "tapped" ? 'a tapped hole needs a size ("M6")' : 'needs a diameter, or a size ("M6") to take it from the table';
    diameter = kind === "tapped" ? std.tapDrill : std.clearance[fit];
  }
  const spec: HoleSpec = { kind, diameter };
  if (kind === "counterbore") {
    const d = h.counterbore?.diameter ?? std?.counterbore.diameter;
    const depth = h.counterbore?.depth ?? std?.counterbore.depth;
    if (d === undefined || depth === undefined) return 'a counterbore needs its diameter and depth, or a size ("M6") to take them from the table';
    spec.counterbore = { diameter: d, depth };
  }
  if (kind === "countersink") {
    const d = h.countersink?.diameter ?? std?.countersink?.diameter;
    const angle = h.countersink?.angle ?? (std ? COUNTERSINK_ANGLE : undefined);
    if (d === undefined) {
      return std ? `ISO 10642 has no countersunk screw of size ${std.size}: give the countersink's diameter` : 'a countersink needs its diameter and angle, or a size ("M6") to take them from the table';
    }
    if (angle === undefined) return "a countersink needs its angle (90 for metric screws)";
    spec.countersink = { diameter: d, angle };
  }
  if (kind === "tapped") {
    if (!std) return 'a tapped hole needs a size ("M6")';
    const pitch = h.thread?.pitch ?? std.pitch;
    spec.thread = {
      designation: `${std.size}×${fmt(pitch)}`,
      major: std.d,
      pitch,
      class: THREAD_CLASS,
      depth: h.thread?.depth ?? defaultThreadDepth(h.depth, pitch),
    };
  }
  return spec;
}

/** A tapped hole's callout: "M6×1 - 6H ⌴12", or "... THRU". */
export function threadCallout(t: ThreadSpec): string {
  return `${t.designation} - ${t.class} ${t.depth === "through" ? "THRU" : `⌴${fmt(t.depth)}`}`;
}

/** The volume of one hole (mm³) drilled `depth` deep with the given numbers, as a solid of revolution: for tests and readouts. */
export function holeVolume(spec: Pick<HoleSpec, "diameter" | "counterbore" | "countersink">, depth: number): number {
  const r = spec.diameter / 2;
  let v = Math.PI * r * r * depth;
  if (spec.counterbore) {
    const R = spec.counterbore.diameter / 2;
    v += Math.PI * (R * R - r * r) * spec.counterbore.depth;
  }
  if (spec.countersink) {
    // The cone between the countersink's rim and the bore, less the bore's own cylinder over that height.
    const R = spec.countersink.diameter / 2;
    const h = (R - r) / Math.tan(((spec.countersink.angle / 2) * Math.PI) / 180);
    v += (Math.PI * h * (R * R + R * r + r * r)) / 3 - Math.PI * r * r * h;
  }
  return v;
}

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** 6, 1.25, 0.5: as few digits as the number needs. */
function fmt(x: number): string {
  return String(round(x));
}
