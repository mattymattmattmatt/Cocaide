// The photo underlay's rules (spec 5.3, Phase G). A photo has no scale: every
// size measured on it is an estimate, in pixels, scaled by the one dimension
// the user gives. Export waits for the user to confirm that dimension, and to
// set every size the photo doesn't show.

import type { PhotoUnderlay, Vec2 } from "./types";
import { isObject } from "./validate";

/** The document's photo, when it has a well-formed one. */
export function photoOf(doc: unknown): PhotoUnderlay | null {
  if (!isObject(doc) || !isObject(doc.photo)) return null;
  const p = doc.photo as unknown as PhotoUnderlay;
  return isObject(p.scale) && isObject(p.estimated) ? p : null;
}

/** Millimetres per photo pixel. */
export function mmPerPixel(scale: { from: Vec2; to: Vec2; length: number }): number {
  return scale.length / Math.hypot(scale.to[0] - scale.from[0], scale.to[1] - scale.from[1]);
}

/** A size measured on a photo: to 0.1 mm, which is already more than a photo can tell. */
export function estimate(pixels: number, k: number): number {
  return Math.round(pixels * k * 10) / 10;
}

/** The value of every estimated parameter at scale k (guesses keep theirs). */
export function rescaled(photo: PhotoUnderlay, k: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, px] of Object.entries(photo.estimated)) if (px !== null) out[name] = estimate(px, k);
  return out;
}

/** The parameters that are guesses: sizes the photo doesn't show. */
export function photoGuesses(photo: PhotoUnderlay): string[] {
  return Object.entries(photo.estimated)
    .filter(([, px]) => px === null)
    .map(([name]) => name);
}

/** Why the part must not be exported yet, or null. Every export path asks this. */
export function exportRefusal(doc: unknown): string | null {
  const photo = photoOf(doc);
  if (!photo) return null;
  const reasons: string[] = [];
  if (!photo.scale.confirmed) {
    reasons.push(`its scale is not confirmed: check that ${photo.scale.what || "the scale line"} is ${photo.scale.length} mm on the photo, then confirm it`);
  }
  const guesses = photoGuesses(photo);
  if (guesses.length) {
    const one = guesses.length === 1;
    reasons.push(`${guesses.join(", ")} ${one ? "is a guess" : "are guesses"}: the photo doesn't show ${one ? "it" : "them"}. Set ${one ? "it" : "them"} in Parameters`);
  }
  if (!reasons.length) return null;
  return `Not exported. This part was estimated from a photo (${photo.image}), and ${reasons.join("; and ")}.`;
}

/** What an export of a photo-derived part says about itself. Never "ready to make". */
export function photoNote(doc: unknown): string | null {
  const photo = photoOf(doc);
  if (!photo) return null;
  const left = Object.values(photo.estimated).length;
  return (
    `Estimated from a photo (${photo.image}), scaled from one dimension the user confirmed: ${photo.scale.what || "the scale line"} = ${photo.scale.length} mm. ` +
    (left ? `${left} size${left === 1 ? " is" : "s are"} still estimated from the photo. ` : "") +
    "Check every size against the part before making it."
  );
}
